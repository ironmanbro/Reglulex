import { requireAdmin } from "@/lib/admin";
import { db } from "@/lib/db";
import { fmtDateTime } from "@/lib/format";
import { excludeEntryAction, resolveErrorAction, retryEntryAction, retryJobAction } from "../actions";
import { AdminNav, Flash } from "../AdminNav";

export const dynamic = "force-dynamic";

export default async function Errors({ searchParams }: { searchParams: Promise<{ msg?: string; error?: string }> }) {
  const user = await requireAdmin();
  const sp = await searchParams;
  const sql = db();
  const [failedEntries, dead, errors] = await Promise.all([
    sql`SELECT e.id, e.title_raw, e.entry_key, e.last_error, e.last_checked_at, s.code FROM source_entries e JOIN sources s ON s.id = e.source_id
        WHERE e.state IN ('download_failed','failed') ORDER BY e.last_checked_at DESC NULLS LAST LIMIT 200`,
    sql`SELECT id, kind, payload, attempts, last_error, finished_at FROM jobs WHERE status = 'dead' ORDER BY finished_at DESC LIMIT 100`,
    sql`SELECT c.*, s.code FROM collection_errors c LEFT JOIN sources s ON s.id = c.source_id WHERE c.resolved_at IS NULL ORDER BY c.created_at DESC LIMIT 300`,
  ]);
  return (
    <>
      <h1>Failures &amp; retries</h1>
      <AdminNav user={user} />
      <Flash msg={sp.msg} error={sp.error} />

      <section className="section">
        <div className="section-head"><h2>Failed downloads ({failedEntries.length})</h2></div>
        {failedEntries.length ? (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Entry</th><th>Error</th><th>Actions</th></tr></thead>
            <tbody>
              {failedEntries.map((e) => (
                <tr key={e.id}>
                  <td><a href={e.entry_key} target="_blank" rel="noopener noreferrer">{e.title_raw || e.entry_key}</a><div className="small muted">{e.code} · {fmtDateTime(e.last_checked_at)}</div></td>
                  <td className="small">{e.last_error}</td>
                  <td><div className="row-actions">
                    <form action={retryEntryAction}><input type="hidden" name="entryId" value={e.id} /><button className="btn small secondary">Retry</button></form>
                    <form action={excludeEntryAction}><input type="hidden" name="entryId" value={e.id} /><button className="btn small ghost">Exclude</button></form>
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        ) : <p className="muted">None.</p>}
      </section>

      <section className="section">
        <div className="section-head"><h2>Dead jobs ({dead.length})</h2></div>
        {dead.length ? (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Job</th><th>Attempts</th><th>Last error</th><th></th></tr></thead>
            <tbody>
              {dead.map((j) => (
                <tr key={j.id}>
                  <td>{j.kind} #{j.id}<div className="small muted mono">{JSON.stringify(j.payload)}</div></td>
                  <td>{j.attempts}</td><td className="small">{j.last_error}</td>
                  <td><form action={retryJobAction}><input type="hidden" name="jobId" value={j.id} /><button className="btn small secondary">Retry</button></form></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        ) : <p className="muted">None.</p>}
      </section>

      <section className="section">
        <div className="section-head"><h2>Open collection errors ({errors.length})</h2></div>
        {errors.length ? (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>When</th><th>Source</th><th>Stage</th><th>Error</th><th></th></tr></thead>
            <tbody>
              {errors.map((e) => (
                <tr key={e.id}>
                  <td className="small">{fmtDateTime(e.created_at)}</td><td>{e.code}</td><td>{e.stage}</td>
                  <td className="small">{e.error_code && <code>{e.error_code}</code>} {e.message}{e.url && <div className="muted" style={{ overflowWrap: "anywhere" }}>{e.url}</div>}</td>
                  <td><form action={resolveErrorAction}><input type="hidden" name="errorId" value={e.id} /><button className="btn small ghost">Resolve</button></form></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        ) : <p className="muted">None.</p>}
      </section>
    </>
  );
}
