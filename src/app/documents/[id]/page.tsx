import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Fragment } from "react";
import { CopyButton } from "@/components/CopyButton";
import { StatusBadge } from "@/components/StatusBadge";
import { env } from "@/lib/env";
import { EXTRACTION_LABELS, fmtBytes, fmtDate, fmtDateTime, typeLabel } from "@/lib/format";
import { getDocument, REL_LABELS, type RelRow } from "@/lib/queries";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ view?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const data = await getDocument(id);
  return { title: data?.doc.title ?? "Document not found" };
}

function Relationship({ r, direction }: { r: RelRow; direction: "out" | "in" }) {
  const label = REL_LABELS[r.rel_type]?.[direction] ?? r.rel_type;
  return (
    <li className={r.status === "proposed" ? "proposed" : ""}>
      <div className="small">
        <strong>{label}</strong>{" "}
        {r.status === "confirmed" ? (
          <span className="badge good">Confirmed by reviewer</span>
        ) : (
          <span className="badge muted" title="Detected automatically from an explicit citation in the text; not yet confirmed by a reviewer">
            Detected reference · unconfirmed
          </span>
        )}
      </div>
      <Link href={`/documents/${r.other_id}`}>{r.other_title}</Link>
      <div className="doc-meta">
        <span>{fmtDate(r.other_date)}</span>
        {r.other_number && <span className="mono">{r.other_number}</span>}
      </div>
      {r.evidence_text && (
        <details>
          <summary className="small muted">Evidence</summary>
          <blockquote className="evidence">… {r.evidence_text} …</blockquote>
        </details>
      )}
    </li>
  );
}

export default async function DocumentPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { view } = await searchParams;
  const data = await getDocument(id);
  if (!data) notFound();
  const { doc, versions, tags, outgoing, incoming, unresolved, sources, authorities, text } = data;
  const current = versions.find((v) => v.id === doc.current_version_id) ?? versions[0];
  const isPdf = current?.file_format === "pdf";
  const serveFiles = env().SERVE_ORIGINAL_FILES === "true";
  const tab = view === "text" || !isPdf || !serveFiles ? "text" : "document";
  const site = env().PUBLIC_SITE_URL.replace(/\/$/, "");

  const citation = [
    doc.authority_name,
    `"${doc.title}"`,
    doc.document_number,
    doc.publication_date ? `dated ${fmtDate(doc.publication_date)}` : null,
    doc.original_url ? `Official source: ${doc.original_url}` : null,
    `Accessed via Foreign Investment Regulatory Library, ${site}/documents/${doc.id}`,
  ].filter(Boolean).join(", ");

  const routes = tags.filter((t) => t.kind === "route");
  const topics = tags.filter((t) => t.kind === "topic");
  const history = [
    ...outgoing.map((r) => ({ r, dir: "out" as const })),
    ...incoming.map((r) => ({ r, dir: "in" as const })),
  ];

  return (
    <article>
      <header className="doc-header">
        <nav className="breadcrumbs" aria-label="Breadcrumb">
          <Link href="/documents">Library</Link> › <Link href={`/documents?authority=${doc.authority_code}`}>{doc.authority_short}</Link> ›{" "}
          <Link href={`/documents?authority=${doc.authority_code}&type=${doc.document_type}`}>{typeLabel(doc.document_type)}</Link>
        </nav>
        <h1>{doc.title}</h1>
        <div className="doc-meta" style={{ fontSize: ".95rem" }}>
          <span>{doc.authority_name}</span>
          {doc.document_number && <span className="mono">{doc.document_number}</span>}
          <span>{fmtDate(doc.publication_date)}</span>
          <StatusBadge status={doc.legal_status} />
        </div>
        <div className="actions">
          {doc.original_url && (
            <a className="btn" href={doc.original_url} target="_blank" rel="noopener noreferrer">Open official source ↗</a>
          )}
          {doc.landing_url && doc.landing_url !== doc.original_url && (
            <a className="btn secondary" href={doc.landing_url} target="_blank" rel="noopener noreferrer">Official listing page ↗</a>
          )}
          {current && serveFiles && (
            <a className="btn secondary" href={`/api/files/${current.id}?download=1`}>Download archived copy ({fmtBytes(current.size_bytes)})</a>
          )}
          <CopyButton text={citation} />
        </div>
      </header>

      {doc.legal_status === "pending_verification" || doc.legal_status === "unknown" ? (
        <p className="notice" style={{ marginBottom: 20 }}>
          <strong>Legal status not verified.</strong> This document was collected from the official source, but whether it is currently
          in force — or has been amended, superseded or withdrawn — has not been confirmed. Check the issuing authority before relying on it.
        </p>
      ) : doc.legal_status_note ? (
        <p className="notice info" style={{ marginBottom: 20 }}>{doc.legal_status_note}</p>
      ) : null}

      <div className="doc-layout">
        <div>
          <nav className="tabs" aria-label="Document view">
            {isPdf && serveFiles && (
              <Link href={`/documents/${doc.id}`} aria-current={tab === "document" ? "page" : undefined}>Document</Link>
            )}
            <Link href={`/documents/${doc.id}?view=text`} aria-current={tab === "text" ? "page" : undefined}>Extracted text</Link>
          </nav>

          {tab === "document" && current ? (
            <object className="viewer" data={`/api/files/${current.id}`} type="application/pdf" aria-label={`PDF of ${doc.title}`}>
              <div className="empty">
                <p>Your browser cannot display the PDF inline.</p>
                <p>
                  <a href={`/api/files/${current.id}`}>Open the archived PDF</a>
                  {doc.original_url && <> or <a href={doc.original_url} target="_blank" rel="noopener noreferrer">open the official source</a></>}.
                </p>
              </div>
            </object>
          ) : text ? (
            <>
              <p className="small muted">
                {EXTRACTION_LABELS[text.status] ?? text.status}
                {text.method === "ocr" && current?.ocr_confidence != null && ` (mean OCR confidence ${current.ocr_confidence})`}
                {" · "}Machine-extracted text for searching; the official document governs.
                {text.char_count > 400000 && " Showing the first 400,000 characters."}
              </p>
              {text.error && <p className="notice small">{text.error}</p>}
              {text.text_content ? (
                <div className="textbox" tabIndex={0} aria-label="Extracted text">
                  {text.pages && text.pages.length > 1
                    ? text.pages.map((p, i) => (
                        <div key={i}>
                          <span className="page-break">Page {i + 1}</span>
                          {p}
                        </div>
                      ))
                    : text.text_content}
                </div>
              ) : (
                <div className="empty">
                  <p>No searchable text is available for this document.</p>
                  {doc.original_url && <a href={doc.original_url} target="_blank" rel="noopener noreferrer">Open the official document ↗</a>}
                </div>
              )}
            </>
          ) : (
            <div className="empty"><p>No extracted text is available.</p></div>
          )}

          <section className="section" aria-labelledby="history-h">
            <div className="section-head"><h2 id="history-h">Amendment history &amp; related documents</h2></div>
            {history.length ? (
              <ol className="timeline">
                {history
                  .sort((a, b) => (a.r.other_date ?? "").localeCompare(b.r.other_date ?? ""))
                  .map(({ r, dir }) => <Relationship key={`${dir}-${r.id}`} r={r} direction={dir} />)}
              </ol>
            ) : (
              <p className="muted">No relationships to other collected documents have been recorded.</p>
            )}
            {unresolved.length > 0 && (
              <details style={{ marginTop: 12 }}>
                <summary>Cites {unresolved.length} instrument{unresolved.length > 1 ? "s" : ""} not (yet) in the library</summary>
                <ul className="small">
                  {unresolved.map((u, i) => (
                    <li key={i}><span className="mono">{u.reference_text}</span>{u.rel_type !== "related_to" && <span className="muted"> — wording suggests “{u.rel_type}”</span>}</li>
                  ))}
                </ul>
              </details>
            )}
          </section>

          <section className="section" aria-labelledby="versions-h">
            <div className="section-head"><h2 id="versions-h">Versions collected</h2></div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Version</th><th>Detected</th><th>Change</th><th>File</th><th>SHA-256</th></tr>
                </thead>
                <tbody>
                  {versions.map((v) => (
                    <tr key={v.id}>
                      <td>v{v.version_no}{v.id === doc.current_version_id && <> <span className="badge accent">latest</span></>}</td>
                      <td>{fmtDateTime(v.detected_at)}</td>
                      <td className="small">{v.change_note ?? v.change_kind}</td>
                      <td className="small">
                        {serveFiles ? <a href={`/api/files/${v.id}?download=1`}>{v.file_format.toUpperCase()}, {fmtBytes(v.size_bytes)}</a> : `${v.file_format.toUpperCase()}, ${fmtBytes(v.size_bytes)}`}
                        {v.page_count ? `, ${v.page_count} pp.` : ""}
                      </td>
                      <td className="mono small" title={v.sha256}>{v.sha256.slice(0, 16)}…</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {versions.length > 1 && (
              <p className="small muted" style={{ marginTop: 8 }}>
                A new version means the official file changed. That is not by itself a legal amendment.
              </p>
            )}
          </section>
        </div>

        <aside className="stack" aria-label="Document details">
          <div className="card">
            <h2 style={{ fontSize: "1.05rem" }}>Details</h2>
            <dl className="meta">
              <dt>Authority</dt><dd>{doc.authority_name}</dd>
              {authorities.filter((a) => a.role !== "issuer").map((a) => (
                <Fragment key={`${a.code}-${a.role}`}><dt>{a.role.replace("_", " ")}</dt><dd>{a.short_name}</dd></Fragment>
              ))}
              {doc.issuing_department && (<><dt>Department</dt><dd>{doc.issuing_department}</dd></>)}
              <dt>Type</dt><dd>{typeLabel(doc.document_type)}</dd>
              <dt>Number</dt><dd className="mono">{doc.document_number ?? <span className="muted">Not recorded</span>}</dd>
              <dt>Published</dt><dd>{fmtDate(doc.publication_date)}</dd>
              <dt>Effective</dt><dd>{doc.effective_date ? fmtDate(doc.effective_date) : <span className="muted">Not stated</span>}</dd>
              {doc.amendment_date && (<><dt>Amended</dt><dd>{fmtDate(doc.amendment_date)}</dd></>)}
              <dt>Status</dt><dd><StatusBadge status={doc.legal_status} /></dd>
              <dt>Review</dt><dd>{doc.review_status === "reviewed" ? "Metadata reviewed" : doc.review_status === "needs_review" ? "Awaiting review" : "Not reviewed"}</dd>
              <dt>Language</dt><dd>{doc.language === "hi+en" ? "Hindi and English" : doc.language === "hi" ? "Hindi" : doc.language === "en" ? "English" : "Unknown"}</dd>
              <dt>Library ID</dt><dd className="mono">{doc.id}</dd>
            </dl>
          </div>

          {(routes.length > 0 || topics.length > 0) && (
            <div className="card">
              <h2 style={{ fontSize: "1.05rem" }}>Classification</h2>
              {routes.length > 0 && (
                <div className="tags" style={{ marginBottom: 8 }}>
                  {routes.map((t) => <Link key={t.code} className="badge route" href={`/documents?route=${t.code}`}>{t.label}</Link>)}
                </div>
              )}
              <div className="tags">
                {topics.map((t) => <Link key={t.code} className="badge" href={`/documents?topic=${t.code}`}>{t.label}</Link>)}
              </div>
              {tags.some((t) => t.origin === "rule") && (
                <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }}>Tags assigned automatically from keywords in the text unless reviewed.</p>
              )}
            </div>
          )}

          <div className="card">
            <h2 style={{ fontSize: "1.05rem" }}>Provenance</h2>
            <dl className="meta">
              <dt>Collected</dt><dd>{fmtDateTime(doc.collected_at)}</dd>
              <dt>Last verified</dt><dd>{fmtDateTime(doc.last_verified_at)}</dd>
            </dl>
            <ul className="small" style={{ paddingLeft: 18, marginBottom: 0 }}>
              {sources.map((s) => (
                <li key={s.entry_key}>
                  Listed on <strong>{s.source_name}</strong>
                  {s.landing_url && <> — <a href={s.landing_url} target="_blank" rel="noopener noreferrer">page ↗</a></>}
                  <br /><span className="muted">first seen {fmtDateTime(s.first_seen_at)}; checked {fmtDateTime(s.last_checked_at)}</span>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </article>
  );
}
