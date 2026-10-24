import Link from "next/link";
import type { DocumentListRow } from "@/lib/queries";
import { fmtDate, ROUTE_LABELS, typeLabel } from "@/lib/format";
import { StatusBadge } from "./StatusBadge";
import { Snippet } from "./Snippet";

export function DocList({ rows, showSnippet = false }: { rows: DocumentListRow[]; showSnippet?: boolean }) {
  return (
    <ul className="doc-list">
      {rows.map((d) => (
        <li key={d.id}>
          <Link className="doc-title" href={`/documents/${d.id}`}>
            {d.title}
          </Link>
          <div className="doc-meta">
            <span>{d.authority_short}</span>
            <span>{typeLabel(d.document_type)}</span>
            {d.document_number && <span className="mono">{d.document_number}</span>}
            <span>{fmtDate(d.publication_date)}</span>
            <StatusBadge status={d.legal_status} />
            {d.relevance === "uncertain" && <span className="badge muted" title="Automatic classification could not confirm this falls within the library's scope">Scope unconfirmed</span>}
            {d.routes?.map((r) => (
              <span key={r} className="badge route">{ROUTE_LABELS[r] ?? r}</span>
            ))}
          </div>
          {showSnippet && <Snippet text={d.snippet} />}
        </li>
      ))}
    </ul>
  );
}
