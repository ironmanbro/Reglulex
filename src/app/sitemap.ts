import type { MetadataRoute } from "next";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const site = (process.env.PUBLIC_SITE_URL || "http://localhost:3000").replace(/\/$/, "");
  const docs = await db()<{ id: string; updated_at: Date }[]>`
    SELECT id, updated_at FROM documents WHERE relevance <> 'out_of_scope' ORDER BY updated_at DESC LIMIT 45000`;
  return [
    { url: `${site}/`, changeFrequency: "daily" },
    { url: `${site}/documents`, changeFrequency: "daily" },
    { url: `${site}/sources`, changeFrequency: "daily" },
    ...docs.map((d) => ({ url: `${site}/documents/${d.id}`, lastModified: d.updated_at })),
  ];
}
