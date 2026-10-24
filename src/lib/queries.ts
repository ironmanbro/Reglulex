import { z } from "zod";
import { db, type Sql } from "./db";
import { normalizeDocNumber } from "@/ingest/normalize";
import { expandQuery, looksLikeDocNumber } from "./search";

export const PAGE_SIZE = 25;

export const LEGAL_STATUS = {
  current_verified: { label: "Current — verified", tone: "good", help: "A reviewer has verified this document is currently in force." },
  historical: { label: "Historical version", tone: "muted", help: "Kept for reference; a later version applies." },
  amended: { label: "Amended", tone: "warn", help: "Amended by a later document (see amendment history)." },
  superseded: { label: "Superseded", tone: "bad", help: "Replaced by a later document (see amendment history)." },
  withdrawn: { label: "Withdrawn / rescinded", tone: "bad", help: "Withdrawn or rescinded by a later document." },
  pending_verification: { label: "Status not yet verified", tone: "neutral", help: "Collected from the official source; its current legal status has not been reviewed." },
  unknown: { label: "Status unknown", tone: "neutral", help: "The legal status could not be established from available sources." },
} as const;
export type LegalStatus = keyof typeof LEGAL_STATUS;

export const searchParamsSchema = z.object({
  q: z.string().trim().max(200).optional().catch(undefined),
  authority: z.union([z.string(), z.array(z.string())]).optional().transform((v) => (v ? (Array.isArray(v) ? v : [v]) : [])).catch([]),
  route: z.union([z.string(), z.array(z.string())]).optional().transform((v) => (v ? (Array.isArray(v) ? v : [v]) : [])).catch([]),
  topic: z.union([z.string(), z.array(z.string())]).optional().transform((v) => (v ? (Array.isArray(v) ? v : [v]) : [])).catch([]),
  type: z.union([z.string(), z.array(z.string())]).optional().transform((v) => (v ? (Array.isArray(v) ? v : [v]) : [])).catch([]),
  status: z.union([z.string(), z.array(z.string())]).optional().transform((v) => (v ? (Array.isArray(v) ? v : [v]) : [])).catch([]),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined),
  sort: z.enum(["relevance", "newest", "oldest", "title", "added"]).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(10_000).optional().catch(undefined),
});
export type SearchParams = z.infer<typeof searchParamsSchema>;

export interface DocumentListRow {
  id: string;
  title: string;
  authority_code: string;
  authority_short: string;
  document_type: string;
  document_number: string | null;
  publication_date: string | null;
  legal_status: LegalStatus;
  relevance: string;
  routes: string[];
  snippet: string | null;
  collected_at: Date;
}

function slugList(v: string[], allowed?: RegExp) {
  return v.filter((s) => (allowed ?? /^[a-z0-9_]{1,40}$/i).test(s)).slice(0, 20);
}

export async function searchDocuments(p: SearchParams, opts: { includeOutOfScope?: boolean; sql?: Sql } = {}) {
  const sql = opts.sql ?? db();
  const page = p.page ?? 1;
  const q = p.q?.trim() || "";
  const authorities = slugList(p.authority).map((s) => s.toUpperCase());
  const routes = slugList(p.route);
  const topics = slugList(p.topic);
  const types = slugList(p.type);
  const statuses = slugList(p.status);
  const numNorm = q && looksLikeDocNumber(q) ? normalizeDocNumber(q) : null;
  const variants = q ? expandQuery(q) : [];
  const sort = p.sort ?? (q ? "relevance" : "newest");

  const tsq = variants.length
    ? variants.map((v, i) => (i === 0 ? sql`websearch_to_tsquery('english', immutable_unaccent(${v}))` : sql` || websearch_to_tsquery('english', immutable_unaccent(${v}))`))
        .reduce((a, b) => sql`${a}${b}`)
    : null;

  const where = sql`
    WHERE TRUE
    ${opts.includeOutOfScope ? sql`` : sql`AND d.relevance <> 'out_of_scope'`}
    ${authorities.length ? sql`AND a.code = ANY(${authorities})` : sql``}
    ${types.length ? sql`AND d.document_type = ANY(${types})` : sql``}
    ${statuses.length ? sql`AND d.legal_status = ANY(${statuses})` : sql``}
    ${p.from ? sql`AND d.publication_date >= ${p.from}` : sql``}
    ${p.to ? sql`AND d.publication_date <= ${p.to}` : sql``}
    ${routes.length ? sql`AND EXISTS (SELECT 1 FROM document_tags t WHERE t.document_id = d.id AND t.tag_code = ANY(${routes}))` : sql``}
    ${topics.length ? sql`AND EXISTS (SELECT 1 FROM document_tags t WHERE t.document_id = d.id AND t.tag_code = ANY(${topics}))` : sql``}
    ${q ? sql`AND (
        d.search_vector @@ (${tsq!})
        OR word_similarity(lower(${q}), lower(d.title)) > 0.55
        ${numNorm ? sql`OR d.document_number_norm LIKE ${"%" + numNorm.replace(/[%_]/g, "") + "%"}
                       OR EXISTS (SELECT 1 FROM document_identifiers i WHERE i.document_id = d.id AND i.ident_norm = ${numNorm})` : sql``}
      )` : sql``}`;

  const rank = q
    ? sql`(ts_rank_cd(d.search_vector, (${tsq!}), 32) + word_similarity(lower(${q}), lower(d.title))
          ${numNorm ? sql`+ CASE WHEN d.document_number_norm = ${numNorm} THEN 10 ELSE 0 END` : sql``})`
    : sql`0`;

  const order =
    sort === "relevance" && q ? sql`ORDER BY rank DESC, d.publication_date DESC NULLS LAST`
    : sort === "oldest" ? sql`ORDER BY d.publication_date ASC NULLS LAST, d.title`
    : sort === "title" ? sql`ORDER BY lower(d.title)`
    : sort === "added" ? sql`ORDER BY d.created_at DESC`
    : sql`ORDER BY d.publication_date DESC NULLS LAST, d.created_at DESC`;

  const [rows, [count]] = await Promise.all([
    sql<(DocumentListRow & { rank: number })[]>`
      SELECT d.id, d.title, a.code AS authority_code, a.short_name AS authority_short, d.document_type, d.document_number,
        d.publication_date, d.legal_status, d.relevance, d.collected_at, ${rank} AS rank,
        coalesce((SELECT array_agg(t.tag_code ORDER BY tg.display_order) FROM document_tags t JOIN tags tg ON tg.code = t.tag_code
                  WHERE t.document_id = d.id AND tg.kind = 'route'), '{}') AS routes,
        ${q ? sql`(SELECT ts_headline('english', left(et.text_content, 60000), (${tsq!}),
                   'StartSel=⟦, StopSel=⟧, MaxWords=28, MinWords=12, ShortWord=2, MaxFragments=2, FragmentDelimiter=" … "')
                   FROM extracted_texts et WHERE et.version_id = d.current_version_id)` : sql`NULL`} AS snippet
      FROM documents d JOIN authorities a ON a.id = d.authority_id
      ${where}
      ${order}
      LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
    sql<{ n: number }[]>`SELECT count(*)::int AS n FROM documents d JOIN authorities a ON a.id = d.authority_id ${where}`,
  ]);
  return { rows, total: count?.n ?? 0, page, pageSize: PAGE_SIZE, sort };
}

export async function filterOptions(sql: Sql = db()) {
  const [authorities, tags, types] = await Promise.all([
    sql<{ code: string; short_name: string; name: string; n: number }[]>`
      SELECT a.code, a.short_name, a.name, count(d.id)::int AS n FROM authorities a
      LEFT JOIN documents d ON d.authority_id = a.id AND d.relevance <> 'out_of_scope'
      GROUP BY a.id ORDER BY a.display_order`,
    sql<{ code: string; kind: "route" | "topic"; label: string; n: number }[]>`
      SELECT t.code, t.kind, t.label, count(d.id)::int AS n FROM tags t
      LEFT JOIN document_tags dt ON dt.tag_code = t.code
      LEFT JOIN documents d ON d.id = dt.document_id AND d.relevance <> 'out_of_scope'
      GROUP BY t.code ORDER BY t.display_order`,
    sql<{ document_type: string; n: number }[]>`
      SELECT document_type, count(*)::int AS n FROM documents WHERE relevance <> 'out_of_scope' GROUP BY 1 ORDER BY 2 DESC`,
  ]);
  return { authorities, routes: tags.filter((t) => t.kind === "route"), topics: tags.filter((t) => t.kind === "topic"), types };
}

export async function homeData(sql: Sql = db()) {
  const [stats, recentAdded, recentUpdated, foundational, coverage] = await Promise.all([
    sql<{ documents: number; last_success: Date | null; sources_enabled: number; sources_verified: number; sources_failing: number }[]>`
      SELECT (SELECT count(*)::int FROM documents WHERE relevance <> 'out_of_scope') AS documents,
             (SELECT max(last_success_at) FROM sources) AS last_success,
             (SELECT count(*)::int FROM sources WHERE enabled) AS sources_enabled,
             (SELECT count(*)::int FROM sources WHERE enabled AND verification_status = 'verified') AS sources_verified,
             (SELECT count(*)::int FROM sources WHERE enabled AND verification_status IN ('failing','parser_attention','blocked')) AS sources_failing`,
    sql<DocumentListRow[]>`
      SELECT d.id, d.title, a.code AS authority_code, a.short_name AS authority_short, d.document_type, d.document_number,
        d.publication_date, d.legal_status, d.relevance, d.collected_at, '{}'::text[] AS routes, NULL AS snippet
      FROM documents d JOIN authorities a ON a.id = d.authority_id
      WHERE d.relevance <> 'out_of_scope' ORDER BY d.created_at DESC LIMIT 6`,
    sql<{ id: string; title: string; authority_short: string; version_no: number; detected_at: Date; change_kind: string }[]>`
      SELECT d.id, d.title, a.short_name AS authority_short, v.version_no, v.detected_at, v.change_kind
      FROM document_versions v JOIN documents d ON d.id = v.document_id JOIN authorities a ON a.id = d.authority_id
      WHERE v.version_no > 1 AND d.relevance <> 'out_of_scope' ORDER BY v.detected_at DESC LIMIT 6`,
    sql<DocumentListRow[]>`
      SELECT d.id, d.title, a.code AS authority_code, a.short_name AS authority_short, d.document_type, d.document_number,
        d.publication_date, d.legal_status, d.relevance, d.collected_at, '{}'::text[] AS routes, NULL AS snippet
      FROM documents d JOIN authorities a ON a.id = d.authority_id
      WHERE d.is_foundational AND d.relevance <> 'out_of_scope'
      ORDER BY a.display_order, d.publication_date DESC NULLS LAST LIMIT 12`,
    sql<{ total: number; collected: number }[]>`SELECT count(*)::int AS total, count(document_id)::int AS collected FROM coverage_targets`,
  ]);
  return { stats: stats[0]!, recentAdded, recentUpdated, foundational, coverage: coverage[0]! };
}

export async function getDocument(id: string, sql: Sql = db()) {
  if (!/^d_[0-9a-z]{12}$/.test(id)) return null;
  const [doc] = await sql<{
    id: string; title: string; authority_code: string; authority_name: string; authority_short: string; authority_website: string;
    issuing_department: string | null; document_number: string | null; document_type: string; publication_date: string | null;
    effective_date: string | null; amendment_date: string | null; landing_url: string | null; original_url: string | null;
    language: string | null; legal_status: LegalStatus; legal_status_note: string | null; relevance: string; review_status: string;
    review_reasons: string[]; extraction_status: string; notes: string | null; current_version_id: number | null;
    collected_at: Date; last_verified_at: Date | null; updated_at: Date; is_foundational: boolean;
  }[]>`
    SELECT d.*, a.code AS authority_code, a.name AS authority_name, a.short_name AS authority_short, a.website AS authority_website
    FROM documents d JOIN authorities a ON a.id = d.authority_id WHERE d.id = ${id}`;
  if (!doc) return null;
  const [versions, tags, outgoing, incoming, unresolved, sources, authorities, text] = await Promise.all([
    sql<{ id: number; version_no: number; detected_at: Date; change_kind: string; change_note: string | null; source_url: string;
          sha256: string; size_bytes: number; file_format: string; content_type: string; extraction_status: string | null; page_count: number | null; ocr_confidence: number | null }[]>`
      SELECT v.id, v.version_no, v.detected_at, v.change_kind, v.change_note, v.source_url, f.sha256, f.size_bytes, f.file_format, f.content_type,
             e.status AS extraction_status, e.page_count, e.ocr_confidence
      FROM document_versions v JOIN stored_files f ON f.id = v.file_id LEFT JOIN extracted_texts e ON e.version_id = v.id
      WHERE v.document_id = ${id} ORDER BY v.version_no DESC`,
    sql<{ code: string; kind: string; label: string; origin: string; matched_terms: string[] }[]>`
      SELECT t.code, t.kind, t.label, dt.origin, dt.matched_terms FROM document_tags dt JOIN tags t ON t.code = dt.tag_code
      WHERE dt.document_id = ${id} ORDER BY t.display_order`,
    sql<RelRow[]>`
      SELECT r.id, r.rel_type, r.status, r.evidence_kind, r.evidence_text, r.matched_reference, r.created_at, r.reviewed_at,
             o.id AS other_id, o.title AS other_title, o.publication_date AS other_date, o.document_number AS other_number
      FROM document_relationships r JOIN documents o ON o.id = r.to_document_id
      WHERE r.from_document_id = ${id} AND r.status <> 'rejected' ORDER BY o.publication_date NULLS LAST`,
    sql<RelRow[]>`
      SELECT r.id, r.rel_type, r.status, r.evidence_kind, r.evidence_text, r.matched_reference, r.created_at, r.reviewed_at,
             o.id AS other_id, o.title AS other_title, o.publication_date AS other_date, o.document_number AS other_number
      FROM document_relationships r JOIN documents o ON o.id = r.from_document_id
      WHERE r.to_document_id = ${id} AND r.status <> 'rejected' ORDER BY o.publication_date NULLS LAST`,
    sql<{ reference_text: string; rel_type: string; context: string | null }[]>`
      SELECT reference_text, rel_type, context FROM document_references
      WHERE document_id = ${id} AND resolved_document_id IS NULL ORDER BY id LIMIT 50`,
    sql<{ source_name: string; source_code: string; landing_url: string | null; entry_key: string; first_seen_at: Date; last_checked_at: Date | null; source_last_success: Date | null }[]>`
      SELECT s.name AS source_name, s.code AS source_code, e.landing_url, e.entry_key, e.first_seen_at, e.last_checked_at, s.last_success_at AS source_last_success
      FROM source_entries e JOIN sources s ON s.id = e.source_id WHERE e.document_id = ${id} ORDER BY e.first_seen_at`,
    sql<{ code: string; short_name: string; role: string }[]>`
      SELECT a.code, a.short_name, da.role FROM document_authorities da JOIN authorities a ON a.id = da.authority_id
      WHERE da.document_id = ${id} ORDER BY a.display_order`,
    doc.current_version_id
      ? sql<{ text_content: string; pages: string[] | null; method: string; status: string; char_count: number; error: string | null }[]>`
          SELECT left(text_content, 400000) AS text_content, pages, method, status, char_count, error FROM extracted_texts WHERE version_id = ${doc.current_version_id}`
      : Promise.resolve([]),
  ]);
  return { doc, versions, tags, outgoing, incoming, unresolved, sources, authorities, text: text[0] ?? null };
}

export interface RelRow {
  id: number;
  rel_type: string;
  status: "proposed" | "confirmed" | "rejected";
  evidence_kind: string;
  evidence_text: string | null;
  matched_reference: string | null;
  created_at: Date;
  reviewed_at: Date | null;
  other_id: string;
  other_title: string;
  other_date: string | null;
  other_number: string | null;
}

export const REL_LABELS: Record<string, { out: string; in: string }> = {
  amends: { out: "Amends", in: "Amended by" },
  supersedes: { out: "Supersedes", in: "Superseded by" },
  withdraws: { out: "Withdraws / rescinds", in: "Withdrawn by" },
  corrects: { out: "Corrects", in: "Corrected by" },
  consolidates: { out: "Consolidates", in: "Consolidated into" },
  related_to: { out: "Refers to", in: "Referred to by" },
  derives_authority_from: { out: "Issued under", in: "Authority for" },
};

export async function sourcesOverview(sql: Sql = db()) {
  const [sources, targets] = await Promise.all([
    sql<{ id: number; code: string; name: string; authority_short: string; authority_code: string; connector: string; enabled: boolean;
          verification_status: string; verification_note: string | null; coverage_note: string | null; last_run_at: Date | null;
          last_success_at: Date | null; last_status: string | null; consecutive_failures: number; schedule_minutes: number;
          documents: number; entries: number; skipped: number; failed: number }[]>`
      SELECT s.id, s.code, s.name, a.short_name AS authority_short, a.code AS authority_code, s.connector, s.enabled, s.verification_status,
        s.verification_note, s.coverage_note, s.last_run_at, s.last_success_at, s.last_status, s.consecutive_failures, s.schedule_minutes,
        (SELECT count(DISTINCT e.document_id)::int FROM source_entries e WHERE e.source_id = s.id) AS documents,
        (SELECT count(*)::int FROM source_entries e WHERE e.source_id = s.id) AS entries,
        (SELECT count(*)::int FROM source_entries e WHERE e.source_id = s.id AND e.state = 'skipped_out_of_scope') AS skipped,
        (SELECT count(*)::int FROM source_entries e WHERE e.source_id = s.id AND e.state IN ('download_failed','failed')) AS failed
      FROM sources s JOIN authorities a ON a.id = s.authority_id ORDER BY a.display_order, s.code`,
    sql<{ id: number; authority_code: string; title: string; document_type: string; document_id: string | null; matched_at: Date | null }[]>`
      SELECT id, authority_code, title, document_type, document_id, matched_at FROM coverage_targets t
      ORDER BY (SELECT display_order FROM authorities a WHERE a.code = t.authority_code), id`,
  ]);
  return { sources, targets };
}

export async function authorityPage(code: string, sql: Sql = db()) {
  const [a] = await sql<{ id: number; code: string; name: string; short_name: string; website: string; description: string | null }[]>`
    SELECT id, code, name, short_name, website, description FROM authorities WHERE code = ${code.toUpperCase()}`;
  if (!a) return null;
  const types = await sql<{ document_type: string; n: number }[]>`
    SELECT document_type, count(*)::int n FROM documents WHERE authority_id = ${a.id} AND relevance <> 'out_of_scope' GROUP BY 1 ORDER BY 2 DESC`;
  return { authority: a, types };
}
