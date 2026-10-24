import { requireAdmin } from "@/lib/admin";
import { db } from "@/lib/db";
import { fmtDateTime } from "@/lib/format";
import { AdminNav } from "../AdminNav";

export const dynamic = "force-dynamic";

export default async function Audit() {
  const user = await requireAdmin();
  const rows = await db()`SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 300`;
  return (
    <>
      <h1>Audit log</h1>
      <AdminNav user={user} />
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Change</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="small">{fmtDateTime(r.created_at)}</td><td>{r.actor}</td><td>{r.action}</td>
                <td className="small">{r.entity_type} {r.entity_id}</td>
                <td className="small">
                  {(r.before || r.after) && (
                    <details><summary>details</summary><pre className="mono small" style={{ whiteSpace: "pre-wrap", maxWidth: 600 }}>{JSON.stringify({ before: r.before, after: r.after }, null, 1).slice(0, 4000)}</pre></details>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
