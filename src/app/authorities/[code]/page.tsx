import Link from "next/link";
import { notFound } from "next/navigation";
import { DocList } from "@/components/DocList";
import { typeLabel } from "@/lib/format";
import { authorityPage, searchDocuments, searchParamsSchema } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function AuthorityPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!/^[a-z0-9_]{2,20}$/i.test(code)) notFound();
  const data = await authorityPage(code);
  if (!data) notFound();
  const { authority, types } = data;
  const latest = await searchDocuments(searchParamsSchema.parse({ authority: authority.code }));
  return (
    <>
      <nav className="breadcrumbs"><Link href="/authorities">Authorities</Link> › {authority.short_name}</nav>
      <h1>{authority.name}</h1>
      <p className="muted" style={{ maxWidth: 820 }}>{authority.description}</p>
      <p><a href={authority.website} target="_blank" rel="noopener noreferrer">Official website ↗</a></p>
      {types.length > 0 && (
        <div className="tags" style={{ margin: "16px 0" }}>
          {types.map((t) => (
            <Link key={t.document_type} className="badge accent" href={`/documents?authority=${authority.code}&type=${t.document_type}`}>
              {typeLabel(t.document_type)} ({t.n})
            </Link>
          ))}
        </div>
      )}
      <section className="section">
        <div className="section-head">
          <h2>Latest documents</h2>
          {latest.total > 0 && <Link className="small" href={`/documents?authority=${authority.code}`}>All {latest.total}</Link>}
        </div>
        {latest.rows.length ? <DocList rows={latest.rows} /> : <p className="muted">No documents from this authority have been collected yet. See <Link href="/sources">collection status</Link>.</p>}
      </section>
    </>
  );
}
