import { createHash } from "node:crypto";
import type { Sql, TxSql } from "@/lib/db";
import { env } from "@/lib/env";
import { Fetcher, FetchError, type FetchResult } from "@/lib/http/fetcher";
import { newDocumentId } from "@/lib/ids";
import { errorMessage, log } from "@/lib/log";
import { storageKeyFor, type ObjectStorage } from "@/lib/storage";
import { classify, prescreen } from "./classify";
import { getConnector } from "./connectors";
import { resolveEntry } from "./connectors/resolvers";
import { baseConfigSchema, type CrawlMode, type DiscoveredEntry, type PageReport, type SourceConfig } from "./connectors/types";
import { extract, type Extraction } from "./extract";
import { cleanTitle, fileFormatFrom, inferDocumentType, normalizeDocNumber, parseIndianDate, type DocumentType } from "./normalize";
import { deriveIdentifiers, findReferences } from "./references";

export interface IngestDeps {
  sql: Sql;
  fetcher: Fetcher;
  storage: ObjectStorage;
  /** Called for each entry that needs processing. Defaults to enqueueing a job; tests process inline. */
  onEntry?: (entryId: number) => Promise<void>;
  enqueue?: (kind: string, payload: Record<string, unknown>, opts?: { dedupeKey?: string; priority?: number }) => Promise<void>;
}

export interface SourceRow {
  id: number;
  code: string;
  authority_id: number;
  connector: string;
  config: Record<string, unknown>;
  enabled: boolean;
  recheck_days: number;
  consecutive_failures: number;
}

export type RunStatus = "success_new" | "success_no_new" | "failed" | "parser_attention" | "partial";

const ALLOWED_FORMATS = new Set(["pdf", "html", "docx", "doc", "xlsx", "txt"]);

/** Hosts the crawler may contact: union of authority domains plus explicit extras. */
export async function loadAllowedHosts(sql: Sql): Promise<string[]> {
  const rows = await sql<{ d: string }[]>`SELECT unnest(allowed_domains) AS d FROM authorities`;
  const extra = env().CRAWLER_EXTRA_ALLOWED_HOSTS.split(",").map((s) => s.trim()).filter(Boolean);
  return [...new Set([...rows.map((r) => r.d), ...extra])];
}

export function sourceConfig(raw: Record<string, unknown>): SourceConfig {
  return { ...raw, ...baseConfigSchema.parse(raw) } as SourceConfig;
}

export function decideRunStatus(pages: PageReport[], newEntries: number): RunStatus {
  if (pages.length === 0) return "parser_attention";
  const expected = pages.filter((p) => p.expectsItems);
  const failed = pages.filter((p) => !p.ok);
  if (expected.length && expected.every((p) => !p.ok)) return "failed";
  // Fetched fine but found nothing where entries must exist → the page layout probably changed.
  if (expected.some((p) => p.ok && (p.itemsFound === 0 || p.error))) return "parser_attention";
  if (failed.length) return "partial";
  return newEntries > 0 ? "success_new" : "success_no_new";
}

// ---------------------------------------------------------------------------
// Crawl: discovery for one source
// ---------------------------------------------------------------------------

export async function runCrawl(
  deps: IngestDeps,
  sourceId: number,
  mode: CrawlMode | "recheck",
  trigger: "schedule" | "admin" | "cli" | "test" = "schedule",
): Promise<{ runId: number; status: RunStatus; newEntries: number }> {
  const { sql } = deps;
  const [source] = await sql<SourceRow[]>`SELECT * FROM sources WHERE id = ${sourceId}`;
  if (!source) throw new Error(`Source ${sourceId} not found`);
  const [run] = await sql<{ id: number }[]>`
    INSERT INTO crawl_runs (source_id, mode, trigger) VALUES (${sourceId}, ${mode}, ${trigger}) RETURNING id`;
  const runId = run!.id;
  log.info("crawl start", { source: source.code, mode, runId });

  if (mode === "recheck") return runRecheck(deps, source, runId);

  let status: RunStatus;
  let newEntries = 0;
  let seen = 0;
  let skipped = 0;
  let pages: PageReport[] = [];
  let notes: string[] = [];
  try {
    const cfg = sourceConfig(source.config);
    const connector = getConnector(source.connector);
    const result = await connector.discover({
      fetcher: deps.fetcher,
      mode,
      config: cfg,
      isKnown: async (key) => {
        const [r] = await sql`SELECT 1 FROM source_entries WHERE source_id = ${sourceId} AND entry_key = ${key} AND state <> 'discovered'`;
        return !!r;
      },
    });
    pages = result.pages;
    notes = result.notes;
    if (result.state) {
      await sql`UPDATE sources SET config = jsonb_set(config, '{state}', ${sql.json(result.state as never)}), updated_at = now() WHERE id = ${sourceId}`;
    }
    for (const e of result.entries) {
      seen++;
      const { id, inserted, state } = await upsertEntry(sql, sourceId, e);
      if (inserted) newEntries++;
      if (e.hints?.prescreen === "out_of_scope" && inserted) {
        await sql`UPDATE source_entries SET state = 'skipped_out_of_scope' WHERE id = ${id}`;
        skipped++;
        continue;
      }
      if (inserted || state === "discovered") await dispatchEntry(deps, id);
    }
    for (const p of pages) {
      const emptyExpected = p.ok && p.expectsItems && p.itemsFound === 0;
      if (p.ok && !p.error && !emptyExpected) continue;
      await recordError(sql, {
        sourceId,
        runId,
        stage: p.ok ? "parse_index" : "fetch_index",
        url: p.url,
        code: p.ok ? "parse_failed" : "fetch_failed",
        message: p.error ?? (emptyExpected ? "Page loaded but no document links matched the configured pattern" : "Unknown error"),
      });
    }
    status = decideRunStatus(pages, newEntries);
  } catch (err) {
    status = "failed";
    notes.push(errorMessage(err));
    await recordError(sql, { sourceId, runId, stage: "fetch_index", code: "connector_error", message: errorMessage(err) });
    log.error("crawl failed", { source: source.code, error: errorMessage(err) });
  }

  const message = [
    status === "parser_attention" ? "Index fetched but no entries could be parsed — parser needs attention" : null,
    ...notes,
  ].filter(Boolean).join("; ") || null;
  await sql`
    UPDATE crawl_runs SET status = ${status}, finished_at = now(),
      pages_fetched = ${pages.filter((p) => p.ok).length}, pages_failed = ${pages.filter((p) => !p.ok).length},
      entries_seen = ${seen}, entries_new = ${newEntries}, entries_skipped = ${skipped},
      errors_count = ${pages.filter((p) => !p.ok || p.error || (p.expectsItems && p.itemsFound === 0)).length}, message = ${message},
      stats = ${sql.json({ fetcher: deps.fetcher.stats } as never)}
    WHERE id = ${runId}`;
  await updateSourceHealth(sql, source, status, message);
  log.info("crawl finished", { source: source.code, mode, runId, status, newEntries, seen });
  return { runId, status, newEntries };
}

async function updateSourceHealth(sql: Sql, source: SourceRow, status: RunStatus, message: string | null) {
  const success = status === "success_new" || status === "success_no_new" || status === "partial";
  const verification = success ? "verified" : status === "parser_attention" ? "parser_attention" : "failing";
  await sql`
    UPDATE sources SET
      last_run_at = now(),
      last_status = ${status},
      last_success_at = CASE WHEN ${success} THEN now() ELSE last_success_at END,
      consecutive_failures = CASE WHEN ${success} THEN 0 ELSE consecutive_failures + 1 END,
      verification_status = ${verification},
      verification_note = ${success ? `Last successful check ${new Date().toISOString()}` : message},
      updated_at = now()
    WHERE id = ${source.id}`;
}

async function upsertEntry(sql: Sql, sourceId: number, e: DiscoveredEntry) {
  const [row] = await sql<{ id: number; inserted: boolean; state: string }[]>`
    INSERT INTO source_entries (source_id, entry_key, landing_url, document_url, title_raw, date_raw, hints)
    VALUES (${sourceId}, ${e.entryKey}, ${e.landingUrl}, ${e.documentUrl}, ${cleanTitle(e.title)}, ${e.dateRaw ?? null}, ${sql.json((e.hints ?? {}) as never)})
    ON CONFLICT (source_id, entry_key) DO UPDATE SET
      last_seen_at = now(),
      landing_url = coalesce(EXCLUDED.landing_url, source_entries.landing_url),
      document_url = coalesce(EXCLUDED.document_url, source_entries.document_url),
      title_raw = coalesce(nullif(EXCLUDED.title_raw, ''), source_entries.title_raw),
      date_raw = coalesce(EXCLUDED.date_raw, source_entries.date_raw)
    RETURNING id, (xmax = 0) AS inserted, state`;
  return row!;
}

async function dispatchEntry(deps: IngestDeps, entryId: number, recheck = false) {
  if (deps.onEntry) return deps.onEntry(entryId);
  if (deps.enqueue) return deps.enqueue("process_entry", { entryId, recheck }, { dedupeKey: `entry:${entryId}`, priority: recheck ? 200 : 100 });
  throw new Error("IngestDeps needs onEntry or enqueue");
}

async function runRecheck(deps: IngestDeps, source: SourceRow, runId: number) {
  const { sql } = deps;
  const due = await sql<{ id: number }[]>`
    SELECT id FROM source_entries
    WHERE source_id = ${source.id} AND state = 'processed'
      AND (last_checked_at IS NULL OR last_checked_at < now() - make_interval(days => ${source.recheck_days}))
    ORDER BY last_checked_at NULLS FIRST LIMIT 500`;
  for (const e of due) await dispatchEntry(deps, e.id, true);
  const status: RunStatus = "success_no_new";
  await sql`UPDATE crawl_runs SET status = ${status}, finished_at = now(), entries_seen = ${due.length},
            message = ${`Queued ${due.length} known entries for change detection`} WHERE id = ${runId}`;
  await sql`UPDATE sources SET next_recheck_at = now() + make_interval(days => recheck_days), updated_at = now() WHERE id = ${source.id}`;
  return { runId, status, newEntries: 0 };
}

export async function recordError(
  sql: Sql | TxSql,
  e: { sourceId?: number | null; runId?: number | null; entryId?: number | null; documentId?: string | null; stage: string; url?: string | null; code?: string | null; message: string },
) {
  await sql`
    INSERT INTO collection_errors (source_id, crawl_run_id, entry_id, document_id, stage, url, error_code, message)
    VALUES (${e.sourceId ?? null}, ${e.runId ?? null}, ${e.entryId ?? null}, ${e.documentId ?? null}, ${e.stage}, ${e.url ?? null}, ${e.code ?? null}, ${e.message.slice(0, 2000)})`;
}

// ---------------------------------------------------------------------------
// Entry processing: resolve → download → store → extract → classify → link
// ---------------------------------------------------------------------------

interface EntryRow {
  id: number;
  source_id: number;
  entry_key: string;
  landing_url: string | null;
  document_url: string | null;
  title_raw: string | null;
  date_raw: string | null;
  hints: DiscoveredEntry["hints"];
  document_id: string | null;
  state: string;
  http_etag: string | null;
  http_last_modified: string | null;
  last_sha256: string | null;
}

export type EntryOutcome =
  | "skipped_out_of_scope" | "excluded" | "unchanged" | "new_document" | "linked_existing" | "new_version" | "download_failed";

/**
 * Processes one entry. Throws only for retryable failures (so the job queue retries with
 * backoff); permanent failures are recorded and returned as "download_failed".
 */
export async function processEntry(deps: IngestDeps, entryId: number, opts: { force?: boolean; finalAttempt?: boolean } = {}): Promise<EntryOutcome> {
  const { sql } = deps;
  const [entry] = await sql<EntryRow[]>`SELECT * FROM source_entries WHERE id = ${entryId}`;
  if (!entry) throw new Error(`Entry ${entryId} not found`);
  if (entry.state === "excluded" && !opts.force) return "excluded";
  const [source] = await sql<SourceRow[]>`SELECT * FROM sources WHERE id = ${entry.source_id}`;
  const cfg = sourceConfig(source!.config);
  const title = cleanTitle(entry.title_raw);

  if (!entry.document_id && !opts.force && cfg.downloadPolicy === "relevant_only" && prescreen(title, cfg.assumeInScope) === "out_of_scope") {
    await sql`UPDATE source_entries SET state = 'skipped_out_of_scope', last_checked_at = now() WHERE id = ${entryId}`;
    return "skipped_out_of_scope";
  }

  let file: FetchResult;
  let resolvedMeta: Awaited<ReturnType<typeof resolveEntry>>;
  try {
    resolvedMeta = await resolveEntry(
      deps.fetcher,
      { entryKey: entry.entry_key, landingUrl: entry.landing_url, documentUrl: entry.document_url, title, dateRaw: entry.date_raw, hints: entry.hints },
      cfg,
    );
    file =
      resolvedMeta.prefetched ??
      (await deps.fetcher.fetch(resolvedMeta.fileUrl, {
        etag: entry.document_id ? entry.http_etag : null,
        lastModified: entry.document_id ? entry.http_last_modified : null,
      }));
  } catch (err) {
    const retryable = !(err instanceof FetchError) || err.retryable;
    if (retryable && !opts.finalAttempt) throw err;
    await sql`UPDATE source_entries SET state = CASE WHEN document_id IS NULL THEN 'download_failed' ELSE state END,
              last_error = ${errorMessage(err)}, last_checked_at = now() WHERE id = ${entryId}`;
    await recordError(sql, {
      sourceId: entry.source_id, entryId, documentId: entry.document_id, stage: "download",
      url: entry.document_url ?? entry.landing_url, code: err instanceof FetchError ? err.code : "error", message: errorMessage(err),
    });
    if (entry.document_id && err instanceof FetchError && err.status === 404) {
      await flagReview(sql, entry.document_id, "source_unavailable");
    }
    return "download_failed";
  }

  if (file.notModified) {
    await sql`UPDATE source_entries SET last_checked_at = now(), last_error = NULL WHERE id = ${entryId}`;
    if (entry.document_id) await sql`UPDATE documents SET last_verified_at = now() WHERE id = ${entry.document_id}`;
    return "unchanged";
  }

  const sha256 = createHash("sha256").update(file.body).digest("hex");
  const format = fileFormatFrom(file.body, file.contentType, file.url);
  if (!ALLOWED_FORMATS.has(format) || file.body.length === 0) {
    await recordError(sql, { sourceId: entry.source_id, entryId, stage: "download", url: file.url, code: "unsupported_format", message: `Unsupported or empty file (${format}, ${file.body.length} bytes, ${file.contentType})` });
    await sql`UPDATE source_entries SET state = CASE WHEN document_id IS NULL THEN 'download_failed' ELSE state END, last_checked_at = now(), last_error = 'unsupported format' WHERE id = ${entryId}`;
    return "download_failed";
  }

  const httpMeta = { etag: file.headers["etag"] ?? null, lastModified: file.headers["last-modified"] ?? null };

  // HTML pages carry volatile markup (session tokens, view state, "last updated" widgets), so
  // change detection for HTML compares the extracted text; other formats compare raw bytes.
  let extraction: Extraction | null = null;
  let contentHash = sha256;
  if (format === "html") {
    extraction = await extract(file.body, format, file.contentType, { contentSelector: cfg.contentSelector });
    contentHash = "text:" + createHash("sha256").update(extraction.text).digest("hex");
  }

  // Unchanged content on recheck: just record the verification.
  if (entry.document_id && entry.last_sha256 === contentHash) {
    await sql`UPDATE source_entries SET last_checked_at = now(), last_error = NULL, http_etag = ${httpMeta.etag}, http_last_modified = ${httpMeta.lastModified} WHERE id = ${entryId}`;
    await sql`UPDATE documents SET last_verified_at = now() WHERE id = ${entry.document_id}`;
    return "unchanged";
  }

  // Store the original before touching the database; content-addressed and write-once.
  const ext = format === "other" ? "" : format;
  const key = storageKeyFor(sha256, ext);
  await deps.storage.put(key, file.body, file.contentType || "application/octet-stream");

  // Extraction can be slow (OCR) so it happens outside the transaction.
  extraction ??= await extract(file.body, format, file.contentType, { contentSelector: cfg.contentSelector });
  if (!["ok", "ocr_ok", "not_applicable"].includes(extraction.status)) {
    log.warn("extraction incomplete", { entryId, url: file.url, status: extraction.status, error: extraction.error });
  }
  const finalExtraction = extraction;

  return sql.begin(async (tx) => {
    // Serialise concurrent ingestion of identical bytes.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${"file:" + sha256}))`;
    const fileId = await upsertStoredFile(tx, { sha256, key, contentType: file.contentType, format, size: file.body.length, url: file.url });

    if (entry.document_id) {
      const outcome = await addVersion(tx, entry.document_id, fileId, file.url, finalExtraction, cfg);
      await tx`UPDATE source_entries SET last_sha256 = ${contentHash}, last_checked_at = now(), last_error = NULL, state = 'processed',
               http_etag = ${httpMeta.etag}, http_last_modified = ${httpMeta.lastModified} WHERE id = ${entryId}`;
      return outcome;
    }

    // Same bytes already collected (e.g. listed on two official pages) → add a source reference only.
    const [existing] = await tx<{ document_id: string }[]>`SELECT document_id FROM document_versions WHERE file_id = ${fileId} ORDER BY id LIMIT 1`;
    if (existing) {
      await tx`UPDATE source_entries SET document_id = ${existing.document_id}, state = 'processed', last_sha256 = ${contentHash}, last_checked_at = now(),
               http_etag = ${httpMeta.etag}, http_last_modified = ${httpMeta.lastModified}, last_error = NULL WHERE id = ${entryId}`;
      return "linked_existing";
    }

    const docId = await createDocument(tx, {
      source: source!,
      cfg,
      entry,
      title: title || cleanTitle(resolvedMeta.title) || "Untitled document",
      dateRaw: entry.date_raw ?? resolvedMeta.dateRaw ?? null,
      documentNumber: resolvedMeta.documentNumber ?? null,
      department: resolvedMeta.department ?? entry.hints?.department ?? null,
      fileUrl: file.url,
      fileId,
      extraction: finalExtraction,
    });
    await tx`UPDATE source_entries SET document_id = ${docId}, state = 'processed', last_sha256 = ${contentHash}, last_checked_at = now(),
             http_etag = ${httpMeta.etag}, http_last_modified = ${httpMeta.lastModified}, last_error = NULL WHERE id = ${entryId}`;
    return "new_document";
  });
}

async function upsertStoredFile(tx: TxSql, f: { sha256: string; key: string; contentType: string; format: string; size: number; url: string }): Promise<number> {
  const filename = decodeURIComponent(new URL(f.url).pathname.split("/").pop() || "") || null;
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO stored_files (sha256, storage_key, content_type, file_format, size_bytes, original_filename, first_source_url)
    VALUES (${f.sha256}, ${f.key}, ${f.contentType || "application/octet-stream"}, ${f.format}, ${f.size}, ${filename}, ${f.url})
    ON CONFLICT (sha256) DO UPDATE SET sha256 = EXCLUDED.sha256
    RETURNING id`;
  return row!.id;
}

async function insertExtraction(tx: TxSql, versionId: number, x: Extraction, language: string | null) {
  await tx`
    INSERT INTO extracted_texts (version_id, method, status, text_content, pages, page_count, char_count, ocr_confidence, language, error)
    VALUES (${versionId}, ${x.method}, ${x.status}, ${x.text.replaceAll("\u0000", "")}, ${x.pages ? x.pages.map((p) => p.replaceAll("\u0000", "")) : null},
            ${x.pageCount}, ${x.text.length}, ${x.ocrConfidence}, ${language}, ${x.error})
    ON CONFLICT (version_id) DO NOTHING`;
}

export function detectLanguage(text: string): string | null {
  const sample = text.slice(0, 20000);
  const deva = (sample.match(/[ऀ-ॿ]/g) ?? []).length;
  const latin = (sample.match(/[A-Za-z]/g) ?? []).length;
  if (deva + latin < 50) return null;
  if (deva > latin * 2) return "hi";
  if (deva > latin * 0.2) return "hi+en";
  return "en";
}

/** Header numbers (the document's own citation) appear in the first lines of SEBI/RBI issuances. */
function headerNumber(text: string): string | null {
  const head = text.slice(0, 1200);
  return (
    /SEBI\/HO\/[A-Z0-9&().\-\/ ]{2,90}?\/(?:19|20)\d{2}\/\d{1,4}/i.exec(head)?.[0].replace(/\s+/g, "") ??
    /RBI\/(?:19|20)\d{2}-\d{2,4}\/\d{1,4}/.exec(head)?.[0] ??
    /\bIFSCA[\/\-][A-Z0-9\/\-]{4,60}\/(?:19|20)\d{2}(?:-\d{2})?(?:\/\d{1,4})?/i.exec(head)?.[0] ??
    null
  );
}

async function createDocument(
  tx: TxSql,
  p: {
    source: SourceRow;
    cfg: SourceConfig;
    entry: EntryRow;
    title: string;
    dateRaw: string | null;
    documentNumber: string | null;
    department: string | null;
    fileUrl: string;
    fileId: number;
    extraction: Extraction;
  },
): Promise<string> {
  const id = newDocumentId();
  const text = p.extraction.text;
  const pubDate = parseIndianDate(p.dateRaw) ?? parseIndianDate(text.slice(0, 1500).match(/(?:dated?|date)\s*:?\s*([^\n]{6,30})/i)?.[1]);
  const docNumber = p.documentNumber ?? headerNumber(text);
  const docType: DocumentType = inferDocumentType(p.title, (p.entry.hints?.documentType ?? p.cfg.documentType ?? null) as DocumentType | null);
  const language = detectLanguage(text);
  const cls = classify({ title: p.title, text, assumeInScope: p.cfg.assumeInScope, defaultRoutes: p.cfg.defaultRoutes });
  const reviewReasons = reviewReasonsFor(p.extraction.status, cls.relevance, !pubDate);
  const foundational = ["act", "rules", "regulations"].includes(docType) && cls.relevance === "in_scope";

  await tx`
    INSERT INTO documents (id, title, authority_id, issuing_department, document_number, document_number_norm, document_type,
      publication_date, landing_url, original_url, language, relevance, review_status, review_reasons, extraction_status,
      is_foundational, collected_at, last_verified_at)
    VALUES (${id}, ${p.title}, ${p.source.authority_id}, ${p.department}, ${docNumber}, ${normalizeDocNumber(docNumber)}, ${docType},
      ${pubDate}, ${p.entry.landing_url}, ${p.fileUrl}, ${language}, ${cls.relevance},
      ${reviewReasons.length ? "needs_review" : "unreviewed"}, ${reviewReasons}, ${p.extraction.status},
      ${foundational}, now(), now())`;
  const [v] = await tx<{ id: number }[]>`
    INSERT INTO document_versions (document_id, version_no, file_id, source_url, change_kind, change_note)
    VALUES (${id}, 1, ${p.fileId}, ${p.fileUrl}, 'initial', 'First capture from official source') RETURNING id`;
  await tx`UPDATE documents SET current_version_id = ${v!.id} WHERE id = ${id}`;
  await insertExtraction(tx, v!.id, p.extraction, language);
  await tx`INSERT INTO document_authorities (document_id, authority_id, role, evidence)
           VALUES (${id}, ${p.source.authority_id}, 'issuer', ${`Published on ${p.source.code}`}) ON CONFLICT DO NOTHING`;
  await writeTags(tx, id, cls.tags);
  await writeIdentifiers(tx, id, p.title, docNumber, pubDate, text.slice(0, 700));
  await linkReferences(tx, id, text);
  await detectDuplicates(tx, id);
  await matchCoverageTargets(tx, id);
  await tx`SELECT refresh_document_search(${id})`;
  return id;
}

function reviewReasonsFor(extractionStatus: string, relevance: string, missingDate: boolean): string[] {
  const reasons: string[] = [];
  if (!["ok", "ocr_ok", "not_applicable"].includes(extractionStatus)) reasons.push(`extraction_${extractionStatus}`);
  if (relevance === "uncertain") reasons.push("relevance_uncertain");
  if (missingDate) reasons.push("publication_date_missing");
  return reasons;
}

async function flagReview(sql: Sql | TxSql, documentId: string, reason: string) {
  await sql`UPDATE documents SET review_status = 'needs_review',
            review_reasons = (SELECT array_agg(DISTINCT r) FROM unnest(review_reasons || ${[reason]}::text[]) r), updated_at = now()
            WHERE id = ${documentId}`;
}

/**
 * Records a new version when the file behind a known entry changed. The prior file and
 * version stay intact. A changed hash is *not* treated as a legal amendment: the document
 * is flagged for review and its legal status is left unchanged.
 */
async function addVersion(tx: TxSql, documentId: string, fileId: number, url: string, x: Extraction, cfg: SourceConfig): Promise<EntryOutcome> {
  const [already] = await tx`SELECT 1 FROM document_versions WHERE document_id = ${documentId} AND file_id = ${fileId}`;
  if (already) {
    await tx`UPDATE documents SET last_verified_at = now() WHERE id = ${documentId}`;
    return "unchanged";
  }
  const [prev] = await tx<{ version_no: number; sha256: string; source_url: string }[]>`
    SELECT v.version_no, f.sha256, v.source_url FROM document_versions v JOIN stored_files f ON f.id = v.file_id
    WHERE v.document_id = ${documentId} ORDER BY v.version_no DESC LIMIT 1`;
  const versionNo = (prev?.version_no ?? 0) + 1;
  const urlChanged = !!prev && prev.source_url !== url;
  const [v] = await tx<{ id: number }[]>`
    INSERT INTO document_versions (document_id, version_no, file_id, source_url, change_kind, change_note, previous_sha256)
    VALUES (${documentId}, ${versionNo}, ${fileId}, ${url}, ${urlChanged ? "new_source_file" : "file_replaced"},
      ${urlChanged ? "The official page now links to a different file" : "The file at the official URL changed (different SHA-256)"},
      ${prev?.sha256 ?? null})
    RETURNING id`;
  const [doc] = await tx<{ title: string; metadata_locked: boolean; relevance_locked: boolean; document_number: string | null; publication_date: string | null }[]>`
    SELECT title, metadata_locked, relevance_locked, document_number, publication_date FROM documents WHERE id = ${documentId}`;
  const language = detectLanguage(x.text);
  await insertExtraction(tx, v!.id, x, language);
  await tx`UPDATE documents SET current_version_id = ${v!.id}, extraction_status = ${x.status}, updated_at = now(), last_verified_at = now() WHERE id = ${documentId}`;
  await flagReview(tx, documentId, "file_changed");
  if (!doc!.relevance_locked) {
    const cls = classify({ title: doc!.title, text: x.text, assumeInScope: cfg.assumeInScope, defaultRoutes: cfg.defaultRoutes });
    await tx`DELETE FROM document_tags WHERE document_id = ${documentId} AND origin = 'rule'`;
    await writeTags(tx, documentId, cls.tags);
    await tx`UPDATE documents SET relevance = ${cls.relevance} WHERE id = ${documentId}`;
  }
  await linkReferences(tx, documentId, x.text);
  await tx`SELECT refresh_document_search(${documentId})`;
  return "new_version";
}

async function writeTags(tx: TxSql, documentId: string, tags: { code: string; score: number; terms: string[] }[]) {
  for (const t of tags) {
    await tx`INSERT INTO document_tags (document_id, tag_code, origin, score, matched_terms)
             VALUES (${documentId}, ${t.code}, 'rule', ${t.score}, ${t.terms})
             ON CONFLICT (document_id, tag_code) DO NOTHING`;
  }
}

async function writeIdentifiers(tx: TxSql, documentId: string, title: string, docNumber: string | null, pubDate: string | null, headerText: string) {
  const ids = deriveIdentifiers({ title, documentNumber: docNumber, headerText, publicationYear: pubDate ? Number(pubDate.slice(0, 4)) : null });
  for (const i of ids) {
    await tx`INSERT INTO document_identifiers (document_id, ident_norm, kind) VALUES (${documentId}, ${i.norm}, ${i.kind}) ON CONFLICT DO NOTHING`;
  }
  // Earlier documents that cited one of these identifiers can now be linked.
  if (ids.length) await resolvePendingReferences(tx, ids.map((i) => i.norm));
}

/**
 * Re-derives references found in a document's text and links those that resolve to
 * exactly one collected document. Ambiguous references stay unresolved.
 */
export async function linkReferences(tx: TxSql, documentId: string, text: string) {
  const self = (await tx<{ ident_norm: string }[]>`SELECT ident_norm FROM document_identifiers WHERE document_id = ${documentId}`).map((r) => r.ident_norm);
  const refs = findReferences(text, self);
  // Only system proposals are recomputed; confirmed/rejected decisions by reviewers are kept.
  await tx`DELETE FROM document_relationships WHERE from_document_id = ${documentId} AND status = 'proposed' AND created_by = 'system'`;
  await tx`DELETE FROM document_references WHERE document_id = ${documentId}`;
  for (const r of refs.slice(0, 300)) {
    await tx`INSERT INTO document_references (document_id, reference_norm, reference_text, reference_kind, rel_type, context)
             VALUES (${documentId}, ${r.norm}, ${r.text}, ${r.kind}, ${r.relType}, ${r.context}) ON CONFLICT DO NOTHING`;
  }
  if (refs.length) await resolvePendingReferences(tx, [...new Set(refs.map((r) => r.norm))], documentId);
}

async function resolvePendingReferences(tx: TxSql, norms: string[], fromDocumentId?: string) {
  const pending = await tx<{ id: number; document_id: string; reference_norm: string; rel_type: string; context: string | null; reference_text: string }[]>`
    SELECT id, document_id, reference_norm, rel_type, context, reference_text FROM document_references
    WHERE resolved_document_id IS NULL AND reference_norm = ANY(${norms})
      ${fromDocumentId ? tx`AND document_id = ${fromDocumentId}` : tx``}`;
  for (const ref of pending) {
    const matches = await tx<{ document_id: string }[]>`
      SELECT DISTINCT document_id FROM document_identifiers WHERE ident_norm = ${ref.reference_norm} AND document_id <> ${ref.document_id}`;
    if (matches.length !== 1) continue; // none, or ambiguous: never guess
    const target = matches[0]!.document_id;
    await tx`UPDATE document_references SET resolved_document_id = ${target} WHERE id = ${ref.id}`;
    await tx`
      INSERT INTO document_relationships (from_document_id, to_document_id, rel_type, status, evidence_kind, evidence_text, matched_reference)
      VALUES (${ref.document_id}, ${target}, ${ref.rel_type}, 'proposed', 'explicit_reference', ${ref.context}, ${ref.reference_text})
      ON CONFLICT (from_document_id, to_document_id, rel_type) DO NOTHING`;
  }
}

async function detectDuplicates(tx: TxSql, documentId: string) {
  const candidates = await tx<{ id: string; reason: string }[]>`
    SELECT o.id,
      CASE WHEN o.document_number_norm = d.document_number_norm THEN 'same authority and document number'
           ELSE 'same authority, title and publication date' END AS reason
    FROM documents d JOIN documents o ON o.authority_id = d.authority_id AND o.id <> d.id
    WHERE d.id = ${documentId} AND (
      (d.document_number_norm IS NOT NULL AND o.document_number_norm = d.document_number_norm)
      OR (lower(o.title) = lower(d.title) AND o.publication_date IS NOT DISTINCT FROM d.publication_date)
    )`;
  for (const c of candidates) {
    const [a, b] = [documentId, c.id].sort() as [string, string];
    await tx`INSERT INTO possible_duplicates (document_a, document_b, reason) VALUES (${a}, ${b}, ${c.reason}) ON CONFLICT DO NOTHING`;
  }
  if (candidates.length) await flagReview(tx, documentId, "possible_duplicate");
}

async function matchCoverageTargets(tx: TxSql, documentId: string) {
  const hits = await tx<{ id: number }[]>`
    UPDATE coverage_targets t SET document_id = d.id, matched_at = now()
    FROM documents d JOIN authorities a ON a.id = d.authority_id
    WHERE d.id = ${documentId} AND t.document_id IS NULL AND t.authority_code = a.code
      AND d.document_type NOT IN ('corrigendum','amendment','consultation_paper','press_release')
      AND d.title ~* t.title_pattern
    RETURNING t.id`;
  if (hits.length) await tx`UPDATE documents SET is_foundational = true WHERE id = ${documentId}`;
}
