import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import { db } from "@/lib/db";
import { fmtDate, typeLabel } from "@/lib/format";
import { REL_LABELS } from "@/lib/queries";
import { markReviewedAction, resolveDuplicateAction, retryEntryAction, reviewRelationshipAction } from "../actions";
import { AdminNav, Flash } from "../AdminNav";

export const dynamic = "force-dynamic";

const TABS = { documents: "Needs review", unclassified: "Scope uncertain", relationships: "Relationships", duplicates: "Duplicates", skipped: "Skipped (out of scope)" } as const;

export default async function Review({ searchParams }: { searchParams: Promise<{ tab?: string; msg?: string; error?: string }> }) {
  const user = await requireAdmin();
  const sp = await searchParams;
  const tab = (sp.tab && sp.tab in TABS ? sp.tab : "documents") as keyof typeof TABS;
  const sql = db();
  const ret = `/admin/review?tab=${tab}`;

  let body: React.ReactNode = null;
  if (tab === "documents" || tab === "unclassified") {
    const docs = await sql`
      SELECT d.id, d.title, d.document_type, d.publication_date, d.review_reasons, d.relevance, d.extraction_status, a.short_name
      FROM documents d JOIN authorities a ON a.id = d.authority_id
      WHERE ${tab === "documents" ? sql`d.review_status = 'needs_review'` : sql`d.relevance = 'uncertain' OR NOT EXISTS (SELECT 1 FROM document_tags t JOIN tags g ON g.code = t.tag_code AND g.kind = 'route' WHERE t.document_id = d.id)`}
      ORDER BY d.created_at DESC LIMIT 200`;
    body = docs.length ? (
      <table className="data">
        <thead><tr><th>Document</th><th>Reasons</th><th>Actions</th></tr></thead>
        <tbody>
          {docs.map((d) => (
            <tr key={d.id}>
              <td><Link href={`/admin/documents/${d.id}`}>{d.title}</Link><div className="small muted">{d.short_name} · {typeLabel(d.document_type)} · {fmtDate(d.publication_date)} · {d.relevance}</div></td>
              <td className="small">{(d.review_reasons as string[]).join(", ") || `extraction: ${d.extraction_status}`}</td>
              <td>
                <form action={markReviewedAction}><input type="hidden" name="id" value={d.id} /><input type="hidden" name="return" value={ret} />
                  <button className="btn small secondary">Mark reviewed</button></form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : <p className="muted">Nothing to review.</p>;
  } else if (tab === "relationships") {
    const rels = await sql`
      SELECT r.*, f.title AS from_title, f.publication_date AS from_date, t.title AS to_title, t.publication_date AS to_date, t.legal_status AS to_status
      FROM document_relationships r JOIN documents f ON f.id = r.from_document_id JOIN documents t ON t.id = r.to_document_id
      WHERE r.status = 'proposed' ORDER BY r.created_at DESC LIMIT 200`;
    body = rels.length ? (
      <ul className="doc-list">
        {rels.map((r) => (
          <li key={r.id}>
            <div><Link href={`/admin/documents/${r.from_document_id}`}>{r.from_title}</Link> <span className="muted small">({fmtDate(r.from_date)})</span></div>
            <div><strong>{REL_LABELS[r.rel_type]?.out ?? r.rel_type}</strong> → <Link href={`/admin/documents/${r.to_document_id}`}>{r.to_title}</Link> <span className="muted small">({fmtDate(r.to_date)}, now {r.to_status})</span></div>
            {r.evidence_text && <blockquote className="evidence">… {r.evidence_text} …</blockquote>}
            <div className="row-actions" style={{ marginTop: 8 }}>
              <form action={reviewRelationshipAction} className="row-actions">
                <input type="hidden" name="relId" value={r.id} /><input type="hidden" name="decision" value="confirmed" /><input type="hidden" name="return" value={ret} />
                {["amends", "supersedes", "withdraws"].includes(r.rel_type) && (
                  <label className="small"><input type="checkbox" name="applyStatus" defaultChecked /> also set target status</label>
                )}
                <button className="btn small">Confirm</button>
              </form>
              <form action={reviewRelationshipAction}>
                <input type="hidden" name="relId" value={r.id} /><input type="hidden" name="decision" value="rejected" /><input type="hidden" name="return" value={ret} />
                <button className="btn small ghost">Reject</button>
              </form>
            </div>
          </li>
        ))}
      </ul>
    ) : <p className="muted">No proposed relationships.</p>;
  } else if (tab === "duplicates") {
    const dups = await sql`
      SELECT p.*, a.title AS a_title, a.publication_date AS a_date, a.document_number AS a_num, b.title AS b_title, b.publication_date AS b_date, b.document_number AS b_num
      FROM possible_duplicates p JOIN documents a ON a.id = p.document_a JOIN documents b ON b.id = p.document_b
      WHERE p.status = 'open' ORDER BY p.created_at DESC LIMIT 100`;
    body = dups.length ? (
      <ul className="doc-list">
        {dups.map((p) => (
          <li key={p.id}>
            <div className="small muted">{p.reason}</div>
            <div>A: <Link href={`/admin/documents/${p.document_a}`}>{p.a_title}</Link> <span className="small muted">{p.a_num} · {fmtDate(p.a_date)}</span></div>
            <div>B: <Link href={`/admin/documents/${p.document_b}`}>{p.b_title}</Link> <span className="small muted">{p.b_num} · {fmtDate(p.b_date)}</span></div>
            <form action={resolveDuplicateAction} className="row-actions" style={{ marginTop: 8 }}>
              <input type="hidden" name="dupId" value={p.id} />
              <button className="btn small ghost" name="decision" value="distinct">Different documents</button>
              <button className="btn small secondary" name="decision" value="merge_into_a">Merge into A</button>
              <button className="btn small secondary" name="decision" value="merge_into_b">Merge into B</button>
            </form>
          </li>
        ))}
      </ul>
    ) : <p className="muted">No open duplicate candidates.</p>;
  } else {
    const skipped = await sql`
      SELECT e.id, e.title_raw, e.date_raw, e.entry_key, s.code FROM source_entries e JOIN sources s ON s.id = e.source_id
      WHERE e.state = 'skipped_out_of_scope' ORDER BY e.first_seen_at DESC LIMIT 300`;
    body = skipped.length ? (
      <table className="data">
        <thead><tr><th>Listed title</th><th>Source</th><th></th></tr></thead>
        <tbody>
          {skipped.map((e) => (
            <tr key={e.id}>
              <td><a href={e.entry_key} target="_blank" rel="noopener noreferrer">{e.title_raw}</a><div className="small muted">{e.date_raw}</div></td>
              <td className="small">{e.code}</td>
              <td>
                <form action={retryEntryAction}><input type="hidden" name="entryId" value={e.id} /><input type="hidden" name="force" value="1" /><input type="hidden" name="return" value={ret} />
                  <button className="btn small secondary">Include &amp; collect</button></form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : <p className="muted">No skipped entries.</p>;
  }

  return (
    <>
      <h1>Review queue</h1>
      <AdminNav user={user} />
      <Flash msg={sp.msg} error={sp.error} />
      <nav className="tabs">
        {Object.entries(TABS).map(([k, v]) => <Link key={k} href={`/admin/review?tab=${k}`} aria-current={tab === k ? "page" : undefined}>{v}</Link>)}
      </nav>
      <div className="table-wrap">{body}</div>
    </>
  );
}
