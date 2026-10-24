import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { db } from "@/lib/db";
import { fmtDateTime } from "@/lib/format";
import { triggerCrawlAction, updateSourceAction } from "../../actions";
import { AdminNav, Flash } from "../../AdminNav";

export const dynamic = "force-dynamic";

export default async function SourceEdit({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; error?: string }> }) {
  const user = await requireAdmin();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^\d+$/.test(id)) notFound();
  const sql = db();
  const [s] = await sql`SELECT s.*, a.short_name AS authority FROM sources s JOIN authorities a ON a.id = s.authority_id WHERE s.id = ${Number(id)}`;
  if (!s) notFound();
  const runs = await sql`SELECT * FROM crawl_runs WHERE source_id = ${s.id} ORDER BY started_at DESC LIMIT 15`;
  const states = await sql<{ state: string; n: number }[]>`SELECT state, count(*)::int n FROM source_entries WHERE source_id = ${s.id} GROUP BY 1 ORDER BY 1`;

  return (
    <>
      <h1>{s.code}</h1>
      <AdminNav user={user} />
      <Flash msg={sp.msg} error={sp.error} />
      <p className="muted">{s.authority} · connector <code>{s.connector}</code> · verification: <strong>{s.verification_status}</strong></p>
      {s.verification_note && <p className="notice small">{s.verification_note}</p>}
      <form action={updateSourceAction} className="card stack">
        <input type="hidden" name="id" value={s.id} />
        <div className="form-grid">
          <label>Name<input name="name" defaultValue={s.name} /></label>
          <label>Check every (minutes)<input name="schedule_minutes" type="number" min={15} defaultValue={s.schedule_minutes} /></label>
          <label>Re-download known files every (days)<input name="recheck_days" type="number" min={1} defaultValue={s.recheck_days} /></label>
          <label style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><input type="checkbox" name="enabled" defaultChecked={s.enabled} /> Enabled</label>
        </div>
        <label>Coverage note (public)<input name="coverage_note" defaultValue={s.coverage_note ?? ""} /></label>
        <label>
          Configuration (JSON — validated against the connector schema; URLs must be on approved authority domains)
          <textarea name="config" rows={18} defaultValue={JSON.stringify(s.config, null, 2)} spellCheck={false} />
        </label>
        <div><button className="btn" type="submit">Save source</button></div>
      </form>

      <div className="row-actions" style={{ marginTop: 16 }}>
        {(["incremental", "backfill", "recheck"] as const).map((m) => (
          <form key={m} action={triggerCrawlAction}>
            <input type="hidden" name="sourceId" value={s.id} />
            <input type="hidden" name="mode" value={m} />
            <input type="hidden" name="return" value={`/admin/sources/${s.id}`} />
            <button className="btn secondary small" type="submit">Queue {m}</button>
          </form>
        ))}
      </div>

      <section className="section">
        <div className="section-head"><h2>Entries by state</h2></div>
        <p className="small">{states.length ? states.map((x) => `${x.state}: ${x.n}`).join(" · ") : "No entries yet."}</p>
      </section>

      <section className="section">
        <div className="section-head"><h2>Recent runs</h2><Link className="small" href={`/admin/runs?source=${s.id}`}>All runs</Link></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Started</th><th>Mode</th><th>Status</th><th>Pages ok/failed</th><th>Entries seen/new</th><th>Message</th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="small">{fmtDateTime(r.started_at)}</td><td>{r.mode}</td><td>{r.status}</td>
                  <td className="count">{r.pages_fetched}/{r.pages_failed}</td><td className="count">{r.entries_seen}/{r.entries_new}</td>
                  <td className="small">{r.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
