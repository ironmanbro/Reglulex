import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { db } from "@/lib/db";
import { DOCUMENT_TYPE_LABELS } from "@/ingest/normalize";
import { getDocument, LEGAL_STATUS, REL_LABELS } from "@/lib/queries";
import { addRelationshipAction, markReviewedAction, reviewRelationshipAction, setTagsAction, updateDocumentAction } from "../../actions";
import { AdminNav, Flash } from "../../AdminNav";

export const dynamic = "force-dynamic";

export default async function EditDocument({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; error?: string }> }) {
  const user = await requireAdmin();
  const { id } = await params;
  const sp = await searchParams;
  const data = await getDocument(id);
  if (!data) notFound();
  const { doc, tags, outgoing, incoming } = data;
  const allTags = await db()<{ code: string; kind: string; label: string }[]>`SELECT code, kind, label FROM tags ORDER BY display_order`;
  const has = new Set(tags.map((t) => t.code));

  return (
    <>
      <h1 style={{ fontSize: "1.4rem" }}>{doc.title}</h1>
      <AdminNav user={user} />
      <Flash msg={sp.msg} error={sp.error} />
      <p className="small"><Link href={`/documents/${doc.id}`}>Public page</Link> · review: {doc.review_status} {doc.review_reasons.length > 0 && `(${doc.review_reasons.join(", ")})`}</p>
      <form action={markReviewedAction} style={{ marginBottom: 16 }}>
        <input type="hidden" name="id" value={doc.id} /><button className="btn secondary small">Mark reviewed</button>
      </form>

      <form action={updateDocumentAction} className="card stack">
        <h2>Metadata</h2>
        <input type="hidden" name="id" value={doc.id} />
        <label>Title<input name="title" defaultValue={doc.title} required /></label>
        <div className="form-grid">
          <label>Document number<input name="document_number" defaultValue={doc.document_number ?? ""} /></label>
          <label>Type
            <select name="document_type" defaultValue={doc.document_type}>
              {Object.entries(DOCUMENT_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label>Department<input name="issuing_department" defaultValue={doc.issuing_department ?? ""} /></label>
          <label>Publication date<input type="date" name="publication_date" defaultValue={doc.publication_date ?? ""} /></label>
          <label>Effective date (only if stated)<input type="date" name="effective_date" defaultValue={doc.effective_date ?? ""} /></label>
          <label>Amendment date<input type="date" name="amendment_date" defaultValue={doc.amendment_date ?? ""} /></label>
          <label>Legal status
            <select name="legal_status" defaultValue={doc.legal_status}>
              {Object.entries(LEGAL_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </label>
          <label>Scope
            <select name="relevance" defaultValue={doc.relevance}>
              <option value="in_scope">In scope (public)</option><option value="uncertain">Uncertain (public, flagged)</option><option value="out_of_scope">Out of scope (hidden)</option>
            </select>
          </label>
          <label style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><input type="checkbox" name="is_foundational" defaultChecked={doc.is_foundational} /> Foundational instrument</label>
        </div>
        <label>Legal status note — evidence for the status (required for “Current — verified”; shown publicly)<textarea name="legal_status_note" rows={3} defaultValue={doc.legal_status_note ?? ""} style={{ fontFamily: "var(--sans)" }} /></label>
        <label>Internal notes / uncertainty<textarea name="notes" rows={3} defaultValue={doc.notes ?? ""} style={{ fontFamily: "var(--sans)" }} /></label>
        <div><button className="btn" type="submit">Save metadata</button></div>
      </form>

      <form action={setTagsAction} className="card stack" style={{ marginTop: 16 }}>
        <h2>Tags</h2>
        <input type="hidden" name="id" value={doc.id} />
        {(["route", "topic"] as const).map((kind) => (
          <fieldset key={kind} style={{ border: 0, padding: 0 }}>
            <legend><strong>{kind === "route" ? "Investment routes" : "Topics"}</strong></legend>
            <div className="tags">
              {allTags.filter((t) => t.kind === kind).map((t) => (
                <label key={t.code} className="badge muted"><input type="checkbox" name="tag" value={t.code} defaultChecked={has.has(t.code)} /> {t.label}</label>
              ))}
            </div>
          </fieldset>
        ))}
        <div><button className="btn secondary" type="submit">Save tags</button></div>
      </form>

      <section className="card stack" style={{ marginTop: 16 }}>
        <h2>Relationships</h2>
        <ul className="doc-list">
          {[...outgoing.map((r) => ({ r, dir: "out" as const })), ...incoming.map((r) => ({ r, dir: "in" as const }))].map(({ r, dir }) => (
            <li key={`${dir}${r.id}`}>
              <strong>{REL_LABELS[r.rel_type]?.[dir]}</strong> <Link href={`/admin/documents/${r.other_id}`}>{r.other_title}</Link> — <span className="small">{r.status} ({r.evidence_kind})</span>
              {r.evidence_text && <blockquote className="evidence">{r.evidence_text}</blockquote>}
              {r.status === "proposed" && (
                <div className="row-actions" style={{ marginTop: 6 }}>
                  <form action={reviewRelationshipAction}><input type="hidden" name="relId" value={r.id} /><input type="hidden" name="decision" value="confirmed" />
                    <input type="hidden" name="applyStatus" value="on" /><input type="hidden" name="return" value={`/admin/documents/${doc.id}`} /><button className="btn small">Confirm</button></form>
                  <form action={reviewRelationshipAction}><input type="hidden" name="relId" value={r.id} /><input type="hidden" name="decision" value="rejected" />
                    <input type="hidden" name="return" value={`/admin/documents/${doc.id}`} /><button className="btn small ghost">Reject</button></form>
                </div>
              )}
            </li>
          ))}
        </ul>
        <form action={addRelationshipAction} className="form-grid">
          <input type="hidden" name="from" value={doc.id} />
          <label>This document…
            <select name="rel_type">{Object.entries(REL_LABELS).map(([k, v]) => <option key={k} value={k}>{v.out}</option>)}</select>
          </label>
          <label>Target document ID or URL<input name="to" required placeholder="d_xxxxxxxxxxxx" /></label>
          <label style={{ gridColumn: "1 / -1" }}>Evidence (quote the provision or paragraph)<textarea name="evidence" rows={2} required style={{ fontFamily: "var(--sans)" }} /></label>
          <div><button className="btn secondary" type="submit">Add confirmed relationship</button></div>
        </form>
      </section>
    </>
  );
}
