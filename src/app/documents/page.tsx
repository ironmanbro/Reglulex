import type { Metadata } from "next";
import Link from "next/link";
import { DocList } from "@/components/DocList";
import { db } from "@/lib/db";
import { typeLabel } from "@/lib/format";
import { filterOptions, LEGAL_STATUS, searchDocuments, searchParamsSchema, type SearchParams } from "@/lib/queries";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Library" };

type Raw = Record<string, string | string[] | undefined>;

function hrefWith(params: SearchParams, patch: Partial<Record<keyof SearchParams, unknown>>): string {
  const merged = { ...params, ...patch } as Record<string, unknown>;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) continue;
    if (k === "page" && v === 1) continue;
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)));
    else qs.set(k, String(v));
  }
  const s = qs.toString();
  return `/documents${s ? `?${s}` : ""}`;
}

export default async function Library({ searchParams }: { searchParams: Promise<Raw> }) {
  const params = searchParamsSchema.parse(await searchParams);
  const sql = db();
  const [result, opts] = await Promise.all([searchDocuments(params, { sql }), filterOptions(sql)]);
  const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const active = params.authority.length + params.route.length + params.topic.length + params.type.length + params.status.length + (params.from ? 1 : 0) + (params.to ? 1 : 0);

  const checkbox = (name: keyof SearchParams, value: string, label: string, count?: number) => {
    const selected = (params[name] as string[]).map((s) => s.toLowerCase()).includes(value.toLowerCase());
    const id = `f-${name}-${value}`;
    return (
      <label key={id} className="opt" htmlFor={id}>
        <input id={id} type="checkbox" name={name} value={value} defaultChecked={selected} />
        <span>{label}</span>
        {count !== undefined && <span className="count">{count}</span>}
      </label>
    );
  };

  return (
    <>
      <h1>Document library</h1>
      <form action="/documents" className="searchbar" role="search" style={{ maxWidth: "none", marginBottom: 24 }}>
        <label htmlFor="q" className="sr-only">Search</label>
        <input id="q" type="search" name="q" defaultValue={params.q ?? ""} placeholder="Title, topic, provision or document number" form="filters" />
        <button className="btn" type="submit" form="filters">Search</button>
      </form>

      <div className="library">
        <aside aria-label="Filters">
          <form id="filters" action="/documents" className="filters">
            {params.sort && <input type="hidden" name="sort" value={params.sort} />}
            <fieldset>
              <legend>Authority</legend>
              {opts.authorities.filter((a) => a.n > 0 || params.authority.includes(a.code)).map((a) => checkbox("authority", a.code, a.short_name, a.n))}
              {opts.authorities.every((a) => a.n === 0) && <p className="small muted">No documents collected yet.</p>}
            </fieldset>
            <fieldset>
              <legend>Investment route</legend>
              {opts.routes.map((r) => checkbox("route", r.code, r.label, r.n))}
            </fieldset>
            <fieldset>
              <legend>Document type</legend>
              {opts.types.map((t) => checkbox("type", t.document_type, typeLabel(t.document_type), t.n))}
              {!opts.types.length && <p className="small muted">—</p>}
            </fieldset>
            <fieldset>
              <legend>Legal status</legend>
              {Object.entries(LEGAL_STATUS).map(([k, v]) => checkbox("status", k, v.label))}
            </fieldset>
            <fieldset>
              <legend>Publication date</legend>
              <div className="row">
                <label>From<input type="date" name="from" defaultValue={params.from} /></label>
                <label>To<input type="date" name="to" defaultValue={params.to} /></label>
              </div>
            </fieldset>
            <details open={params.topic.length > 0}>
              <summary>Topic</summary>
              <fieldset>
                <legend className="sr-only">Topic</legend>
                {opts.topics.map((t) => checkbox("topic", t.code, t.label, t.n))}
              </fieldset>
            </details>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn" type="submit">Apply filters</button>
              {active > 0 && <Link className="btn ghost" href={hrefWith(params, { authority: [], route: [], topic: [], type: [], status: [], from: undefined, to: undefined, page: 1 })}>Clear</Link>}
            </div>
          </form>
        </aside>

        <section aria-labelledby="results-heading">
          <div className="results-head">
            <h2 id="results-heading" className="small" style={{ fontFamily: "var(--sans)", fontSize: "1rem", margin: 0 }} aria-live="polite">
              {result.total.toLocaleString("en-IN")} {result.total === 1 ? "document" : "documents"}
              {params.q ? <> matching “{params.q}”</> : null}
            </h2>
            <nav aria-label="Sort" className="tags small">
              Sort:
              {(params.q ? ["relevance", "newest", "oldest", "title", "added"] : ["newest", "oldest", "title", "added"]).map((s) => (
                <Link key={s} href={hrefWith(params, { sort: s, page: 1 })} aria-current={result.sort === s ? "true" : undefined}
                  className={`badge ${result.sort === s ? "accent" : "muted"}`}>
                  {{ relevance: "Relevance", newest: "Newest", oldest: "Oldest", title: "Title", added: "Recently added" }[s]}
                </Link>
              ))}
            </nav>
          </div>

          {result.rows.length ? (
            <DocList rows={result.rows} showSnippet={!!params.q} />
          ) : (
            <div className="empty">
              <h3>No documents found</h3>
              {opts.authorities.every((a) => a.n === 0) ? (
                <p>The library is empty until the first collection run completes. See <Link href="/sources">collection status</Link>.</p>
              ) : (
                <p>Try fewer words, a different spelling, or remove some filters. Document numbers can be searched as printed (e.g. <span className="mono">RBI/2024-25/12</span>).</p>
              )}
            </div>
          )}

          {totalPages > 1 && (
            <nav className="pagination" aria-label="Pagination">
              {result.page > 1 && <Link href={hrefWith(params, { page: result.page - 1 })} rel="prev">← Previous</Link>}
              {Array.from({ length: totalPages }, (_, i) => i + 1)
                .filter((n) => n === 1 || n === totalPages || Math.abs(n - result.page) <= 2)
                .map((n, i, arr) => (
                  <span key={n} style={{ display: "contents" }}>
                    {i > 0 && n - arr[i - 1]! > 1 && <span aria-hidden="true">…</span>}
                    {n === result.page ? <span aria-current="page">{n}</span> : <Link href={hrefWith(params, { page: n })}>{n}</Link>}
                  </span>
                ))}
              {result.page < totalPages && <Link href={hrefWith(params, { page: result.page + 1 })} rel="next">Next →</Link>}
            </nav>
          )}
        </section>
      </div>
    </>
  );
}
