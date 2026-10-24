import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import { db } from "@/lib/db";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import { createSourceAction, triggerCrawlAction } from "./actions";
import { AdminNav, Flash } from "./AdminNav";
import { CONNECTORS } from "@/ingest/connectors";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Admin", robots: { index: false } };

export default async function AdminHome({ searchParams }: { searchParams: Promise<{ msg?: string; error?: string }> }) {
  const user = await requireAdmin();
  const sp = await searchParams;
  const sql = db();
  const [[counts], sources, authorities] = await Promise.all([
    sql<Record<string, number>[]>`SELECT
      (SELECT count(*)::int FROM documents) AS documents,
      (SELECT count(*)::int FROM documents WHERE review_status = 'needs_review') AS needs_review,
      (SELECT count(*)::int FROM documents WHERE relevance = 'uncertain') AS uncertain,
      (SELECT count(*)::int FROM document_relationships WHERE status = 'proposed') AS proposed_rels,
      (SELECT count(*)::int FROM possible_duplicates WHERE status = 'open') AS duplicates,
      (SELECT count(*)::int FROM collection_errors WHERE resolved_at IS NULL) AS open_errors,
      (SELECT count(*)::int FROM jobs WHERE status = 'queued') AS queued,
      (SELECT count(*)::int FROM jobs WHERE status = 'running') AS running,
      (SELECT count(*)::int FROM jobs WHERE status = 'dead') AS dead,
      (SELECT max(finished_at) FROM jobs)::text AS last_job`,
    sql<{ id: number; code: string; name: string; authority: string; connector: string; enabled: boolean; verification_status: string;
          last_status: string | null; last_run_at: Date | null; last_success_at: Date | null; consecutive_failures: number; next_run_at: Date | null; entries: number; docs: number }[]>`
      SELECT s.id, s.code, s.name, a.short_name AS authority, s.connector, s.enabled, s.verification_status, s.last_status, s.last_run_at,
             s.last_success_at, s.consecutive_failures, s.next_run_at,
             (SELECT count(*)::int FROM source_entries e WHERE e.source_id = s.id) AS entries,
             (SELECT count(DISTINCT document_id)::int FROM source_entries e WHERE e.source_id = s.id) AS docs
      FROM sources s JOIN authorities a ON a.id = s.authority_id ORDER BY a.display_order, s.code`,
    sql<{ code: string; short_name: string }[]>`SELECT code, short_name FROM authorities ORDER BY display_order`,
  ]);
  const c = counts!;
  const tone = (v: string) => (v === "verified" ? "good" : v === "unverified" ? "" : v === "parser_attention" ? "warn" : "bad");

  return (
    <>
      <h1>Administration</h1>
      <AdminNav user={user} />
      <Flash msg={sp.msg} error={sp.error} />
      <div className="grid cols-4">
        <Link className="card" href="/admin/review"><h3 className="count">{c.needs_review}</h3><div className="meta">documents need review</div></Link>
        <Link className="card" href="/admin/review?tab=relationships"><h3 className="count">{c.proposed_rels}</h3><div className="meta">proposed relationships</div></Link>
        <Link className="card" href="/admin/review?tab=duplicates"><h3 className="count">{c.duplicates}</h3><div className="meta">possible duplicates</div></Link>
        <Link className="card" href="/admin/errors"><h3 className="count">{c.open_errors} / {c.dead}</h3><div className="meta">open errors / dead jobs</div></Link>
      </div>
      <p className="small muted" style={{ marginTop: 10 }}>
        Queue: {c.queued} queued, {c.running} running. Last job finished {c.last_job ? fmtRelative(c.last_job as unknown as string) : "never"}
        {!c.last_job && " — if this stays “never”, the worker process is not running."}
      </p>

      <section className="section">
        <div className="section-head"><h2>Sources</h2></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Source</th><th>Health</th><th>Last run</th><th>Entries / docs</th><th>Actions</th></tr></thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link href={`/admin/sources/${s.id}`}><strong>{s.code}</strong></Link>
                    <div className="small muted">{s.authority} · {s.connector}{!s.enabled && " · disabled"}</div>
                  </td>
                  <td>
                    <span className={`badge ${tone(s.verification_status)}`}>{s.verification_status.replace("_", " ")}</span>
                    {s.consecutive_failures > 0 && <div className="small muted">{s.consecutive_failures} consecutive failures</div>}
                  </td>
                  <td className="small">
                    {s.last_status ?? "—"}<br />
                    <span className="muted">{fmtDateTime(s.last_run_at)}</span>
                    {s.enabled && s.next_run_at && <div className="muted">next {fmtDateTime(s.next_run_at)}</div>}
                  </td>
                  <td className="small count">{s.entries} / {s.docs}</td>
                  <td>
                    <div className="row-actions">
                      {(["incremental", "backfill", "recheck"] as const).map((m) => (
                        <form key={m} action={triggerCrawlAction}>
                          <input type="hidden" name="sourceId" value={s.id} />
                          <input type="hidden" name="mode" value={m} />
                          <button className="btn small secondary" type="submit">{m === "incremental" ? "Crawl now" : m === "backfill" ? "Backfill" : "Recheck"}</button>
                        </form>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section">
        <div className="section-head"><h2>Add a source</h2></div>
        <form action={createSourceAction} className="form-grid card">
          <label>Code<input name="code" required placeholder="e.g. nsdl.fpi_circulars" pattern="[a-z0-9_.\-]{3,60}" /></label>
          <label>Name<input name="name" required /></label>
          <label>Authority
            <select name="authority">{authorities.map((a) => <option key={a.code} value={a.code}>{a.short_name}</option>)}</select>
          </label>
          <label>Connector
            <select name="connector">{Object.keys(CONNECTORS).map((k) => <option key={k}>{k}</option>)}</select>
          </label>
          <div style={{ alignSelf: "end" }}><button className="btn" type="submit">Create (disabled)</button></div>
        </form>
      </section>
    </>
  );
}
