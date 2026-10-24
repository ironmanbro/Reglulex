import { hostname } from "node:os";
import type { Sql } from "@/lib/db";
import { env } from "@/lib/env";
import { Fetcher } from "@/lib/http/fetcher";
import { errorMessage, log } from "@/lib/log";
import { storage as defaultStorage, type ObjectStorage } from "@/lib/storage";
import { loadAllowedHosts, processEntry, runCrawl, type IngestDeps } from "@/ingest/pipeline";
import { sendAlert } from "./alerts";
import { claim, complete, enqueue, fail, reclaimStale, type Job } from "./queue";

export interface RuntimeOptions {
  sql: Sql;
  fetcher?: Fetcher;
  storage?: ObjectStorage;
}

export function buildDeps(opts: RuntimeOptions): IngestDeps {
  const sql = opts.sql;
  let hostsCache: { at: number; hosts: string[] } | null = null;
  const fetcher =
    opts.fetcher ??
    new Fetcher({
      allowedHosts: async () => {
        if (!hostsCache || Date.now() - hostsCache.at > 60_000) hostsCache = { at: Date.now(), hosts: await loadAllowedHosts(sql) };
        return hostsCache.hosts;
      },
    });
  return {
    sql,
    fetcher,
    storage: opts.storage ?? defaultStorage(),
    enqueue: async (kind, payload, o) => {
      await enqueue(sql, kind, payload, o);
    },
  };
}

// ---------------------------------------------------------------------------
// Scheduler: decides what is due. Safe to run from several workers at once —
// it takes a transaction-scoped advisory lock and every enqueue is deduplicated.
// ---------------------------------------------------------------------------

export async function schedulerTick(sql: Sql): Promise<{ crawls: number; rechecks: number; reconcile: boolean; reclaimed: number }> {
  return sql.begin(async (tx) => {
    const [lock] = await tx<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(4419001) AS locked`;
    if (!lock?.locked) return { crawls: 0, rechecks: 0, reconcile: false, reclaimed: 0 };
    const t = tx as unknown as Sql;
    const reclaimed = await reclaimStale(t);

    const due = await tx<{ id: number; code: string }[]>`
      UPDATE sources SET next_run_at = now() + make_interval(mins => schedule_minutes)
      WHERE enabled AND (next_run_at IS NULL OR next_run_at <= now()) RETURNING id, code`;
    for (const s of due) await enqueue(t, "crawl", { sourceId: s.id, mode: "incremental", trigger: "schedule" }, { dedupeKey: `crawl:${s.id}:incremental`, priority: 50, maxAttempts: 3 });

    const recheck = await tx<{ id: number }[]>`
      UPDATE sources SET next_recheck_at = now() + make_interval(days => recheck_days)
      WHERE enabled AND (next_recheck_at IS NULL OR next_recheck_at <= now())
        AND EXISTS (SELECT 1 FROM source_entries e WHERE e.source_id = sources.id AND e.state = 'processed')
      RETURNING id`;
    for (const s of recheck) await enqueue(t, "crawl", { sourceId: s.id, mode: "recheck", trigger: "schedule" }, { dedupeKey: `crawl:${s.id}:recheck`, priority: 150, maxAttempts: 3 });

    const [recent] = await tx`SELECT 1 FROM jobs WHERE kind = 'reconcile' AND created_at > now() - interval '23 hours' LIMIT 1`;
    let reconcile = false;
    if (!recent) reconcile = (await enqueue(t, "reconcile", {}, { dedupeKey: "reconcile", priority: 180, maxAttempts: 2 })) !== null;
    return { crawls: due.length, rechecks: recheck.length, reconcile, reclaimed };
  });
}

// ---------------------------------------------------------------------------
// Job handlers
// ---------------------------------------------------------------------------

export async function handleJob(deps: IngestDeps, job: Job): Promise<void> {
  const { sql } = deps;
  switch (job.kind) {
    case "crawl": {
      const p = job.payload as { sourceId: number; mode: "incremental" | "backfill" | "recheck"; trigger?: "schedule" | "admin" | "cli" };
      const res = await runCrawl(deps, p.sourceId, p.mode, p.trigger ?? "schedule");
      if (res.status === "failed" || res.status === "parser_attention") {
        const [s] = await sql<{ code: string; consecutive_failures: number; verification_note: string | null }[]>`
          SELECT code, consecutive_failures, verification_note FROM sources WHERE id = ${p.sourceId}`;
        // Alert when the threshold is first crossed (not on every subsequent failure), and on parser breakage.
        if (s && (s.consecutive_failures === env().ALERT_FAILURE_THRESHOLD || (res.status === "parser_attention" && s.consecutive_failures === 1))) {
          await sendAlert(sql, res.status, `Source ${s.code}: ${res.status} (${s.consecutive_failures} consecutive) — ${s.verification_note ?? ""}`, { source: s.code, runId: res.runId });
        }
      }
      return;
    }
    case "process_entry": {
      const p = job.payload as { entryId: number; force?: boolean };
      await processEntry(deps, p.entryId, { force: p.force, finalAttempt: job.attempts >= job.max_attempts });
      return;
    }
    case "reconcile":
      await reconcile(deps);
      return;
    default:
      throw new Error(`Unknown job kind: ${job.kind}`);
  }
}

/**
 * Daily reconciliation: retries failed downloads, retries unresolved references against
 * the current library, and records a summary event.
 */
export async function reconcile(deps: IngestDeps) {
  const { sql } = deps;
  const failed = await sql<{ id: number }[]>`
    SELECT id FROM source_entries WHERE state IN ('download_failed','discovered') AND first_seen_at < now() - interval '1 hour'
    ORDER BY last_checked_at NULLS FIRST LIMIT 200`;
  for (const e of failed) await enqueue(sql, "process_entry", { entryId: e.id }, { dedupeKey: `entry:${e.id}`, priority: 160 });
  const linked = await sql<{ n: number }[]>`
    WITH m AS (
      SELECT r.id, r.document_id, r.rel_type, r.context, r.reference_text, min(i.document_id) AS target
      FROM document_references r JOIN document_identifiers i ON i.ident_norm = r.reference_norm AND i.document_id <> r.document_id
      WHERE r.resolved_document_id IS NULL
      GROUP BY r.id HAVING count(DISTINCT i.document_id) = 1
    ), u AS (
      UPDATE document_references r SET resolved_document_id = m.target FROM m WHERE r.id = m.id RETURNING m.*
    )
    INSERT INTO document_relationships (from_document_id, to_document_id, rel_type, status, evidence_kind, evidence_text, matched_reference)
    SELECT document_id, target, rel_type, 'proposed', 'explicit_reference', context, reference_text FROM u
    ON CONFLICT DO NOTHING RETURNING 1 AS n`;
  await sql`INSERT INTO app_events (kind, detail) VALUES ('reconcile', ${sql.json({ retriedEntries: failed.length, newLinks: linked.length } as never)})`;
}

// ---------------------------------------------------------------------------
// Worker loop
// ---------------------------------------------------------------------------

export interface WorkerOptions {
  concurrency?: number;
  once?: boolean;
  /** For --once: stop claiming new jobs after this many ms. */
  budgetMs?: number;
  signal?: AbortSignal;
}

export async function runWorker(rt: RuntimeOptions, opts: WorkerOptions = {}) {
  const deps = buildDeps(rt);
  const { sql } = deps;
  const workerId = `${hostname()}:${process.pid}`;
  const started = Date.now();
  const concurrency = opts.concurrency ?? 2;
  let lastTick = 0;
  log.info("worker started", { workerId, concurrency, once: !!opts.once, storage: deps.storage.describe() });

  const tickIfDue = async () => {
    if (Date.now() - lastTick < 60_000) return;
    lastTick = Date.now();
    try {
      const t = await schedulerTick(sql);
      if (t.crawls || t.rechecks || t.reconcile || t.reclaimed) log.info("scheduler tick", t);
    } catch (err) {
      log.error("scheduler tick failed", { error: errorMessage(err) });
    }
  };

  const loop = async (slot: number) => {
    for (;;) {
      if (opts.signal?.aborted) return;
      if (slot === 0) await tickIfDue();
      if (opts.once && opts.budgetMs && Date.now() - started > opts.budgetMs) return;
      const job = await claim(sql, `${workerId}#${slot}`);
      if (!job) {
        if (opts.once) return;
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      const t0 = Date.now();
      try {
        await handleJob(deps, job);
        await complete(sql, job.id);
        log.info("job done", { id: job.id, kind: job.kind, ms: Date.now() - t0 });
      } catch (err) {
        const dead = await fail(sql, job, errorMessage(err));
        log.warn("job failed", { id: job.id, kind: job.kind, attempt: job.attempts, dead, error: errorMessage(err) });
        if (dead) await sendAlert(sql, "job_dead", `Job ${job.kind}#${job.id} failed permanently: ${errorMessage(err)}`, { jobId: job.id });
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, (_, i) => loop(i)));
  log.info("worker stopped", { workerId });
}
