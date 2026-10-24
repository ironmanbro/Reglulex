"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit, requireAdmin } from "@/lib/admin";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { hostAllowed } from "@/lib/http/fetcher";
import { verifyPassword } from "@/lib/password";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { enqueue, retryDead } from "@/jobs/queue";
import { CONNECTORS } from "@/ingest/connectors";
import { linkIndexConfigSchema, rbiIdScanConfigSchema, rssConfigSchema, sebiListingConfigSchema } from "@/ingest/connectors/types";
import { normalizeDocNumber } from "@/ingest/normalize";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const back = (path: string, msg: string, error = false): never => redirect(`${path}${path.includes("?") ? "&" : "?"}${error ? "error" : "msg"}=${encodeURIComponent(msg)}`);

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export async function loginAction(form: FormData) {
  const ip = clientIp(await headers());
  if (!rateLimit(`login:${ip}`, 5, 15 * 60_000).ok) redirect("/admin/login?error=rate");
  const username = str(form, "username");
  const password = String(form.get("password") ?? "");
  const e = env();
  const userOk = username === e.ADMIN_USERNAME;
  const passOk = await verifyPassword(password, e.ADMIN_PASSWORD_HASH); // always evaluated: uniform timing
  if (!userOk || !passOk) {
    await db()`INSERT INTO audit_log (actor, action, entity_type, entity_id) VALUES (${username.slice(0, 100) || "?"}, 'login_failed', 'session', ${ip})`;
    redirect("/admin/login?error=1");
  }
  const token = await signSession(username);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  await audit(db(), username, "login", "session", ip);
  redirect("/admin");
}

export async function logoutAction() {
  const actor = await requireAdmin();
  (await cookies()).delete(SESSION_COOKIE);
  await audit(db(), actor, "logout", "session", null);
  redirect("/admin/login");
}

// ---------------------------------------------------------------------------
// Sources and crawling
// ---------------------------------------------------------------------------

const CONFIG_SCHEMAS: Record<string, z.ZodTypeAny> = {
  rss: rssConfigSchema,
  link_index: linkIndexConfigSchema,
  sebi_listing: sebiListingConfigSchema,
  rbi_id_scan: rbiIdScanConfigSchema,
};

function urlsIn(value: unknown): string[] {
  if (typeof value === "string") return /^https?:\/\//i.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(urlsIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(urlsIn);
  return [];
}

export async function triggerCrawlAction(form: FormData) {
  const actor = await requireAdmin();
  const sourceId = Number(str(form, "sourceId"));
  const mode = z.enum(["incremental", "backfill", "recheck"]).parse(str(form, "mode"));
  const ret = str(form, "return") || "/admin";
  const id = await enqueue(db(), "crawl", { sourceId, mode, trigger: "admin" }, { dedupeKey: `crawl:${sourceId}:${mode}`, priority: 40, maxAttempts: 3 });
  await audit(db(), actor, `trigger_${mode}`, "source", sourceId, undefined, { jobId: id });
  back(ret, id ? `Queued ${mode} crawl — the worker will pick it up shortly.` : `A ${mode} crawl for this source is already queued or running.`);
}

export async function updateSourceAction(form: FormData) {
  const actor = await requireAdmin();
  const sql = db();
  const id = Number(str(form, "id"));
  const path = `/admin/sources/${id}`;
  const [before] = await sql`SELECT * FROM sources WHERE id = ${id}`;
  if (!before) back("/admin", "Source not found", true);

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(str(form, "config"));
  } catch {
    return back(path, "Configuration is not valid JSON", true);
  }
  const schema = CONFIG_SCHEMAS[before!.connector as string];
  const parsed = schema?.safeParse(config);
  if (!parsed?.success) return back(path, `Invalid configuration: ${parsed?.error.issues.map((i: z.ZodIssue) => `${i.path.join(".")} ${i.message}`).join("; ")}`, true);
  for (const p of ["linkPattern", "titleInclude", "titleExclude", "detailFilePattern"]) {
    if (typeof config[p] === "string") {
      try { new RegExp(config[p] as string); } catch { return back(path, `${p} is not a valid regular expression`, true); }
    }
  }
  // SSRF guard: every configured URL must be on an approved authority domain.
  const domains = (await sql<{ d: string }[]>`SELECT unnest(allowed_domains) d FROM authorities`).map((r) => r.d);
  const bad = urlsIn(config).filter((u) => { try { return !hostAllowed(new URL(u).hostname, domains); } catch { return true; } });
  if (bad.length) return back(path, `URL not on an approved authority domain: ${bad[0]}`, true);

  const schedule = Math.max(15, Number(str(form, "schedule_minutes")) || 360);
  const recheck = Math.max(1, Number(str(form, "recheck_days")) || 7);
  const [after] = await sql`
    UPDATE sources SET name = ${str(form, "name") || before!.name}, enabled = ${form.get("enabled") === "on"},
      schedule_minutes = ${schedule}, recheck_days = ${recheck}, config = ${sql.json(config as never)},
      coverage_note = ${str(form, "coverage_note") || null}, updated_at = now(),
      next_run_at = CASE WHEN ${form.get("enabled") === "on"} AND NOT enabled THEN now() ELSE next_run_at END
    WHERE id = ${id} RETURNING *`;
  await audit(sql, actor, "update_source", "source", id, before, after);
  revalidatePath("/sources");
  back(path, "Source saved");
}

export async function createSourceAction(form: FormData) {
  const actor = await requireAdmin();
  const sql = db();
  const code = str(form, "code").toLowerCase();
  const connector = str(form, "connector");
  if (!/^[a-z0-9_.-]{3,60}$/.test(code)) return back("/admin", "Code must be 3–60 chars of a-z, 0-9, . _ -", true);
  if (!CONNECTORS[connector]) return back("/admin", "Unknown connector", true);
  const [row] = await sql`
    INSERT INTO sources (code, authority_id, name, connector, config, enabled)
    VALUES (${code}, (SELECT id FROM authorities WHERE code = ${str(form, "authority")}), ${str(form, "name") || code}, ${connector}, '{}', false)
    ON CONFLICT (code) DO NOTHING RETURNING id`;
  if (!row) return back("/admin", "A source with that code already exists", true);
  await audit(sql, actor, "create_source", "source", row.id as number, undefined, { code, connector });
  back(`/admin/sources/${row.id}`, "Source created (disabled). Add its configuration, then enable it.");
}

// ---------------------------------------------------------------------------
// Failures and retries
// ---------------------------------------------------------------------------

export async function retryEntryAction(form: FormData) {
  const actor = await requireAdmin();
  const entryId = Number(str(form, "entryId"));
  const force = form.get("force") === "1";
  const sql = db();
  if (force) await sql`UPDATE source_entries SET state = 'discovered' WHERE id = ${entryId} AND state IN ('skipped_out_of_scope','excluded')`;
  const job = await enqueue(sql, "process_entry", { entryId, force }, { dedupeKey: `entry:${entryId}`, priority: 30 });
  await audit(sql, actor, force ? "include_entry" : "retry_entry", "source_entry", entryId, undefined, { jobId: job });
  back(str(form, "return") || "/admin/errors", job ? "Queued for processing" : "Already queued");
}

export async function excludeEntryAction(form: FormData) {
  const actor = await requireAdmin();
  const entryId = Number(str(form, "entryId"));
  await db()`UPDATE source_entries SET state = 'excluded' WHERE id = ${entryId} AND document_id IS NULL`;
  await audit(db(), actor, "exclude_entry", "source_entry", entryId);
  back(str(form, "return") || "/admin/errors", "Entry excluded");
}

export async function retryJobAction(form: FormData) {
  const actor = await requireAdmin();
  const id = Number(str(form, "jobId"));
  const ok = await retryDead(db(), id);
  await audit(db(), actor, "retry_job", "job", id);
  back("/admin/errors", ok ? "Job requeued" : "Job could not be requeued (not dead, or an equivalent job is already queued)", !ok);
}

export async function resolveErrorAction(form: FormData) {
  const actor = await requireAdmin();
  const id = Number(str(form, "errorId"));
  const all = form.get("all") === "1";
  const sql = db();
  if (all) await sql`UPDATE collection_errors SET resolved_at = now(), resolved_by = ${actor} WHERE resolved_at IS NULL AND source_id = ${Number(str(form, "sourceId"))}`;
  else await sql`UPDATE collection_errors SET resolved_at = now(), resolved_by = ${actor} WHERE id = ${id}`;
  await audit(sql, actor, all ? "resolve_errors_for_source" : "resolve_error", "collection_error", all ? str(form, "sourceId") : id);
  back("/admin/errors", "Marked resolved");
}

// ---------------------------------------------------------------------------
// Document metadata, legal status, tags, review
// ---------------------------------------------------------------------------

const docSchema = z.object({
  title: z.string().min(3).max(1000),
  document_number: z.string().max(300).optional().transform((v) => v || null),
  document_type: z.string().regex(/^[a-z_]+$/),
  issuing_department: z.string().max(300).optional().transform((v) => v || null),
  publication_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")).transform((v) => v || null),
  effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")).transform((v) => v || null),
  amendment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")).transform((v) => v || null),
  legal_status: z.enum(["current_verified", "historical", "amended", "superseded", "withdrawn", "pending_verification", "unknown"]),
  legal_status_note: z.string().max(2000).optional().transform((v) => v || null),
  relevance: z.enum(["in_scope", "uncertain", "out_of_scope"]),
  notes: z.string().max(5000).optional().transform((v) => v || null),
});

export async function updateDocumentAction(form: FormData) {
  const actor = await requireAdmin();
  const sql = db();
  const id = str(form, "id");
  const path = `/admin/documents/${id}`;
  const parsed = docSchema.safeParse(Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v).trim()])));
  if (!parsed.success) return back(path, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), true);
  const d = parsed.data;
  if (d.legal_status === "current_verified" && !d.legal_status_note) {
    return back(path, "Marking a document as current requires a note recording how the status was verified.", true);
  }
  await sql.begin(async (tx) => {
    const [before] = await tx`SELECT * FROM documents WHERE id = ${id} FOR UPDATE`;
    if (!before) throw new Error("not found");
    const [after] = await tx`
      UPDATE documents SET title = ${d.title}, document_number = ${d.document_number}, document_number_norm = ${normalizeDocNumber(d.document_number)},
        document_type = ${d.document_type}, issuing_department = ${d.issuing_department}, publication_date = ${d.publication_date},
        effective_date = ${d.effective_date}, amendment_date = ${d.amendment_date}, legal_status = ${d.legal_status},
        legal_status_note = ${d.legal_status_note}, relevance = ${d.relevance}, relevance_locked = ${d.relevance !== before.relevance || before.relevance_locked},
        is_foundational = ${form.get("is_foundational") === "on"}, notes = ${d.notes}, metadata_locked = true, updated_at = now()
      WHERE id = ${id} RETURNING *`;
    if (d.document_number && normalizeDocNumber(d.document_number)) {
      await tx`INSERT INTO document_identifiers (document_id, ident_norm, kind, origin) VALUES (${id}, ${normalizeDocNumber(d.document_number)!}, 'document_number', 'admin') ON CONFLICT DO NOTHING`;
    }
    await tx`SELECT refresh_document_search(${id})`;
    const strip = (r: Record<string, unknown>) => { const { search_vector: _s, ...rest } = r; return rest; };
    await audit(tx, actor, "update_document", "document", id, strip(before), strip(after!));
  });
  revalidatePath(`/documents/${id}`);
  back(path, "Saved");
}

export async function markReviewedAction(form: FormData) {
  const actor = await requireAdmin();
  const id = str(form, "id");
  await db()`UPDATE documents SET review_status = 'reviewed', review_reasons = '{}', updated_at = now() WHERE id = ${id}`;
  await audit(db(), actor, "mark_reviewed", "document", id);
  back(str(form, "return") || `/admin/documents/${id}`, "Marked as reviewed");
}

export async function setTagsAction(form: FormData) {
  const actor = await requireAdmin();
  const sql = db();
  const id = str(form, "id");
  const selected = form.getAll("tag").map(String).filter((t) => /^[a-z0-9_]+$/.test(t));
  await sql.begin(async (tx) => {
    const before = await tx`SELECT tag_code, origin FROM document_tags WHERE document_id = ${id}`;
    await tx`DELETE FROM document_tags WHERE document_id = ${id}`;
    for (const t of selected) {
      const prior = before.find((b) => b.tag_code === t);
      await tx`INSERT INTO document_tags (document_id, tag_code, origin) VALUES (${id}, ${t}, ${prior?.origin === "rule" ? "rule" : "admin"}) ON CONFLICT DO NOTHING`;
    }
    await tx`UPDATE documents SET relevance_locked = true WHERE id = ${id}`;
    await tx`SELECT refresh_document_search(${id})`;
    await audit(tx, actor, "set_tags", "document", id, before.map((b) => b.tag_code), selected);
  });
  back(`/admin/documents/${id}`, "Tags saved");
}

const STATUS_FROM_REL: Record<string, string> = { supersedes: "superseded", withdraws: "withdrawn", amends: "amended" };

/** Confirming applies the evidence-backed status to the target unless the reviewer opts out. */
export async function reviewRelationshipAction(form: FormData) {
  const actor = await requireAdmin();
  const sql = db();
  const id = Number(str(form, "relId"));
  const decision = z.enum(["confirmed", "rejected"]).parse(str(form, "decision"));
  const applyStatus = form.get("applyStatus") === "on";
  await sql.begin(async (tx) => {
    const [rel] = await tx`UPDATE document_relationships SET status = ${decision}, reviewed_at = now(), reviewed_by = ${actor}
                           WHERE id = ${id} RETURNING *`;
    if (!rel) return;
    await audit(tx, actor, `relationship_${decision}`, "relationship", id, undefined, rel);
    const newStatus = STATUS_FROM_REL[rel.rel_type as string];
    if (decision === "confirmed" && applyStatus && newStatus) {
      const [from] = await tx`SELECT title, publication_date FROM documents WHERE id = ${rel.from_document_id}`;
      const [target] = await tx`SELECT legal_status FROM documents WHERE id = ${rel.to_document_id}`;
      // Never downgrade a stronger status (e.g. withdrawn) to a weaker one (amended).
      const strength: Record<string, number> = { amended: 1, superseded: 2, withdrawn: 3 };
      if ((strength[target!.legal_status as string] ?? 0) < strength[newStatus]!) {
        await tx`UPDATE documents SET legal_status = ${newStatus},
                 legal_status_note = ${`${newStatus[0]!.toUpperCase()}${newStatus.slice(1)} per confirmed relationship with "${from!.title}"${from!.publication_date ? ` (${from!.publication_date})` : ""}.`},
                 updated_at = now() WHERE id = ${rel.to_document_id}`;
        await audit(tx, actor, "status_from_relationship", "document", rel.to_document_id as string, target, { legal_status: newStatus });
      }
    }
  });
  back(str(form, "return") || "/admin/review", decision === "confirmed" ? "Relationship confirmed" : "Relationship rejected");
}

export async function addRelationshipAction(form: FormData) {
  const actor = await requireAdmin();
  const sql = db();
  const from = str(form, "from");
  const to = str(form, "to").replace(/^.*\/documents\//, "").replace(/[?#].*$/, "");
  const rel = z.enum(["amends", "supersedes", "withdraws", "corrects", "consolidates", "related_to", "derives_authority_from"]).parse(str(form, "rel_type"));
  const evidence = str(form, "evidence");
  if (!evidence) return back(`/admin/documents/${from}`, "Record the evidence for the relationship (e.g. the paragraph that states it).", true);
  const [t] = await sql`SELECT id FROM documents WHERE id = ${to}`;
  if (!t || to === from) return back(`/admin/documents/${from}`, "Target document ID not found", true);
  await sql`INSERT INTO document_relationships (from_document_id, to_document_id, rel_type, status, evidence_kind, evidence_text, created_by, reviewed_at, reviewed_by)
            VALUES (${from}, ${to}, ${rel}, 'confirmed', 'admin', ${evidence}, ${actor}, now(), ${actor})
            ON CONFLICT (from_document_id, to_document_id, rel_type) DO UPDATE SET status = 'confirmed', evidence_text = EXCLUDED.evidence_text, reviewed_at = now(), reviewed_by = ${actor}`;
  await audit(sql, actor, "add_relationship", "document", from, undefined, { to, rel, evidence });
  back(`/admin/documents/${from}`, "Relationship recorded");
}

export async function resolveDuplicateAction(form: FormData) {
  const actor = await requireAdmin();
  const sql = db();
  const id = Number(str(form, "dupId"));
  const decision = z.enum(["distinct", "merge_into_a", "merge_into_b"]).parse(str(form, "decision"));
  await sql.begin(async (tx) => {
    const [dup] = await tx`SELECT * FROM possible_duplicates WHERE id = ${id} AND status = 'open' FOR UPDATE`;
    if (!dup) return;
    if (decision === "distinct") {
      await tx`UPDATE possible_duplicates SET status = 'distinct', resolved_at = now(), resolved_by = ${actor} WHERE id = ${id}`;
      await audit(tx, actor, "duplicate_distinct", "duplicate", id);
      return;
    }
    const keep = (decision === "merge_into_a" ? dup.document_a : dup.document_b) as string;
    const drop = (decision === "merge_into_a" ? dup.document_b : dup.document_a) as string;
    // Carry the dropped record's files over as versions so no original is lost from the history.
    const [{ max }] = (await tx`SELECT coalesce(max(version_no), 0)::int AS max FROM document_versions WHERE document_id = ${keep}`) as unknown as [{ max: number }];
    let n = max;
    for (const v of await tx`SELECT * FROM document_versions WHERE document_id = ${drop} ORDER BY version_no`) {
      const [exists] = await tx`SELECT 1 FROM document_versions WHERE document_id = ${keep} AND file_id = ${v.file_id}`;
      if (exists) continue;
      const [nv] = await tx`INSERT INTO document_versions (document_id, version_no, file_id, source_url, detected_at, change_kind, change_note)
               VALUES (${keep}, ${++n}, ${v.file_id}, ${v.source_url}, ${v.detected_at}, 'new_source_file', ${`Merged from duplicate record ${drop}`}) RETURNING id`;
      await tx`INSERT INTO extracted_texts (version_id, method, status, text_content, pages, page_count, char_count, ocr_confidence, language, error)
               SELECT ${nv!.id}, method, status, text_content, pages, page_count, char_count, ocr_confidence, language, error FROM extracted_texts WHERE version_id = ${v.id}`;
    }
    await tx`UPDATE source_entries SET document_id = ${keep} WHERE document_id = ${drop}`;
    await tx`UPDATE document_relationships SET from_document_id = ${keep} WHERE from_document_id = ${drop} AND to_document_id <> ${keep}
             AND NOT EXISTS (SELECT 1 FROM document_relationships r2 WHERE r2.from_document_id = ${keep} AND r2.to_document_id = document_relationships.to_document_id AND r2.rel_type = document_relationships.rel_type)`;
    await tx`UPDATE document_relationships SET to_document_id = ${keep} WHERE to_document_id = ${drop} AND from_document_id <> ${keep}
             AND NOT EXISTS (SELECT 1 FROM document_relationships r2 WHERE r2.to_document_id = ${keep} AND r2.from_document_id = document_relationships.from_document_id AND r2.rel_type = document_relationships.rel_type)`;
    await tx`INSERT INTO document_identifiers (document_id, ident_norm, kind, origin) SELECT ${keep}, ident_norm, kind, origin FROM document_identifiers WHERE document_id = ${drop} ON CONFLICT DO NOTHING`;
    await tx`UPDATE coverage_targets SET document_id = ${keep} WHERE document_id = ${drop}`;
    const [snapshot] = await tx`SELECT id, title, document_number, publication_date FROM documents WHERE id = ${drop}`;
    await tx`UPDATE possible_duplicates SET status = 'merged', resolved_at = now(), resolved_by = ${actor} WHERE id = ${id}`;
    await tx`DELETE FROM documents WHERE id = ${drop}`;
    await audit(tx, actor, "duplicate_merged", "document", keep, snapshot, { mergedInto: keep });
  });
  back("/admin/review?tab=duplicates", decision === "distinct" ? "Marked as distinct documents" : "Records merged; all files kept as versions");
}
