import { requireAdmin } from "@/lib/admin";
import { db } from "@/lib/db";
import { fmtDateTime } from "@/lib/format";
import { AdminNav } from "../AdminNav";

export const dynamic = "force-dynamic";

export default async function Runs({ searchParams }: { searchParams: Promise<{ source?: string }> }) {
  const user = await requireAdmin();
  const { source } = await searchParams;
  const sql = db();
  const runs = await sql`
    SELECT r.*, s.code FROM crawl_runs r JOIN sources s ON s.id = r.source_id
    ${source && /^\d+$/.test(source) ? sql`WHERE r.source_id = ${Number(source)}` : sql``}
    ORDER BY r.started_at DESC LIMIT 200`;
  return (
    <>
      <h1>Crawl log</h1>
      <AdminNav user={user} />
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Started</th><th>Source</th><th>Mode</th><th>Trigger</th><th>Status</th><th>Pages ok/failed</th><th>Seen/new/skipped</th><th>Duration</th><th>Message</th></tr></thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td className="small">{fmtDateTime(r.started_at)}</td><td>{r.code}</td><td>{r.mode}</td><td>{r.trigger}</td>
                <td>{r.status}</td><td className="count">{r.pages_fetched}/{r.pages_failed}</td>
                <td className="count">{r.entries_seen}/{r.entries_new}/{r.entries_skipped}</td>
                <td className="small">{r.finished_at ? `${Math.round((+new Date(r.finished_at) - +new Date(r.started_at)) / 1000)} s` : "running"}</td>
                <td className="small">{r.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!runs.length && <p className="muted">No crawl runs recorded yet.</p>}
      </div>
    </>
  );
}
