import type { Metadata } from "next";
import Link from "next/link";
import { filterOptions } from "@/lib/queries";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Authorities" };

export default async function AuthoritiesPage() {
  const sql = db();
  const [opts, rows] = await Promise.all([
    filterOptions(sql),
    sql<{ code: string; name: string; short_name: string; website: string; description: string | null; sources: number }[]>`
      SELECT a.code, a.name, a.short_name, a.website, a.description, (SELECT count(*)::int FROM sources s WHERE s.authority_id = a.id AND s.enabled) AS sources
      FROM authorities a ORDER BY display_order`,
  ]);
  const counts = new Map(opts.authorities.map((a) => [a.code, a.n]));
  return (
    <>
      <h1>Authorities</h1>
      <p className="muted" style={{ maxWidth: 820 }}>
        Indian foreign-investment rules are spread across several bodies. A single framework can involve policy from one authority,
        rules from another and operating directions from a third. Documents are filed under their issuing authority and linked to related instruments.
      </p>
      <div className="grid cols-2">
        {rows.map((a) => (
          <div key={a.code} className="card">
            <h2 style={{ fontSize: "1.15rem" }}><Link href={`/authorities/${a.code.toLowerCase()}`}>{a.name}</Link></h2>
            <p className="small">{a.description}</p>
            <div className="doc-meta">
              <span className="count">{counts.get(a.code) ? `${counts.get(a.code)} documents` : "No documents collected yet"}</span>
              <span>{a.sources ? `${a.sources} active source${a.sources > 1 ? "s" : ""}` : "No active collection source"}</span>
              <a href={a.website} target="_blank" rel="noopener noreferrer">Official website ↗</a>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
