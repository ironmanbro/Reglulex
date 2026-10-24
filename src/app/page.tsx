import Link from "next/link";
import { DocList } from "@/components/DocList";
import { filterOptions, homeData } from "@/lib/queries";
import { fmtDateTime, fmtRelative, typeLabel } from "@/lib/format";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function Home() {
  const sql = db();
  const [{ stats, recentAdded, recentUpdated, foundational, coverage }, opts, authorities] = await Promise.all([
    homeData(sql),
    filterOptions(sql),
    sql<{ code: string; name: string; short_name: string; website: string; description: string | null }[]>`
      SELECT code, name, short_name, website, description FROM authorities ORDER BY display_order`,
  ]);
  const primary = authorities.filter((a) => ["SEBI", "RBI", "DPIIT", "IFSCA", "MOF", "ITD"].includes(a.code));
  const counts = new Map(opts.authorities.map((a) => [a.code, a.n]));
  const empty = stats.documents === 0;

  return (
    <>
      <section className="hero">
        <h1>Indian foreign-investment regulations, collected from official sources</h1>
        <p className="lede">
          Search circulars, master directions, regulations, press notes and notifications on FPI, FDI, FVCI, FEMA, GIFT IFSC and
          foreign-investor taxation — with links to the original official document and a record of every version collected.
        </p>
        <form className="searchbar" action="/documents" role="search">
          <label htmlFor="home-q" className="sr-only">Search the library</label>
          <input id="home-q" type="search" name="q" placeholder="Search by topic, title or circular number — e.g. “beneficial ownership FPI”" autoComplete="off" />
          <button className="btn" type="submit">Search</button>
        </form>
        <div className="status-strip" aria-label="Library status">
          <span>
            <span className={`dot ${stats.last_success ? "good" : "warn"}`} aria-hidden="true" />
            {stats.last_success ? (
              <>Last successful collection: <strong>{fmtDateTime(stats.last_success)}</strong> ({fmtRelative(stats.last_success)})</>
            ) : (
              <>No successful collection run has completed yet</>
            )}
          </span>
          <span className="count">{stats.documents.toLocaleString("en-IN")} documents in the library</span>
          <span>
            {stats.sources_verified} of {stats.sources_enabled} active sources verified
            {stats.sources_failing > 0 && <> · <Link href="/sources">{stats.sources_failing} need attention</Link></>}
          </span>
        </div>
      </section>

      {empty && (
        <div className="notice info" role="status">
          The library has not collected any documents yet. Documents appear here after the collection worker completes its first run
          against the official sources. Collection progress for each source is shown on <Link href="/sources">Sources &amp; coverage</Link>.
        </div>
      )}

      <section className="section" aria-labelledby="by-authority">
        <div className="section-head">
          <h2 id="by-authority">Browse by authority</h2>
          <Link href="/authorities" className="small">All authorities</Link>
        </div>
        <div className="grid cols-3">
          {primary.map((a) => (
            <Link key={a.code} className="card" href={`/documents?authority=${a.code}`}>
              <h3>{a.short_name}</h3>
              <div className="meta">{a.name}</div>
              <div className="meta count" style={{ marginTop: 8 }}>
                {counts.get(a.code) ? `${counts.get(a.code)!.toLocaleString("en-IN")} documents` : "No documents collected yet"}
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section className="section" aria-labelledby="by-route">
        <div className="section-head"><h2 id="by-route">Browse by investment route</h2></div>
        <div className="grid cols-4">
          {opts.routes.map((r) => (
            <Link key={r.code} className="card" href={`/documents?route=${r.code}`}>
              <h3>{r.label}</h3>
              <div className="meta count">{r.n ? `${r.n.toLocaleString("en-IN")} documents` : "None yet"}</div>
            </Link>
          ))}
        </div>
      </section>

      {opts.types.length > 0 && (
        <section className="section" aria-labelledby="by-type">
          <div className="section-head"><h2 id="by-type">Browse by document type</h2></div>
          <div className="tags">
            {opts.types.map((t) => (
              <Link key={t.document_type} className="badge accent" href={`/documents?type=${t.document_type}`}>
                {typeLabel(t.document_type)} <span className="count">({t.n})</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <div className="grid cols-2 section">
        <section aria-labelledby="recent-added">
          <div className="section-head">
            <h2 id="recent-added">Recently added</h2>
            <Link href="/documents?sort=added" className="small">View all</Link>
          </div>
          {recentAdded.length ? <DocList rows={recentAdded} /> : <p className="muted">Nothing collected yet.</p>}
        </section>
        <section aria-labelledby="recent-updated">
          <div className="section-head"><h2 id="recent-updated">Recently updated</h2></div>
          {recentUpdated.length ? (
            <ul className="doc-list">
              {recentUpdated.map((u) => (
                <li key={`${u.id}-${u.version_no}`}>
                  <Link className="doc-title" href={`/documents/${u.id}`}>{u.title}</Link>
                  <div className="doc-meta">
                    <span>{u.authority_short}</span>
                    <span>Version {u.version_no} detected {fmtDateTime(u.detected_at)}</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No changed files have been detected yet. When an official file is replaced, the new version appears here and the earlier one is kept.</p>
          )}
        </section>
      </div>

      <section className="section" aria-labelledby="foundational">
        <div className="section-head">
          <h2 id="foundational">Foundational legislation</h2>
          <Link href="/sources#coverage" className="small">
            {coverage.collected} of {coverage.total} tracked instruments collected
          </Link>
        </div>
        {foundational.length ? (
          <DocList rows={foundational} />
        ) : (
          <p className="muted">
            Acts, rules and principal regulations appear here once collected. The list of instruments the library tracks, and which are
            still missing, is on <Link href="/sources#coverage">Sources &amp; coverage</Link>.
          </p>
        )}
      </section>

      <section className="section" aria-labelledby="official">
        <div className="section-head"><h2 id="official">Official websites</h2></div>
        <ul className="grid cols-3" style={{ listStyle: "none", padding: 0 }}>
          {authorities.map((a) => (
            <li key={a.code}>
              <a href={a.website} target="_blank" rel="noopener noreferrer">{a.name}</a>
              <span className="muted small"> ↗</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
