import { NextResponse } from "next/server";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { searchDocuments, searchParamsSchema } from "@/lib/queries";

export const dynamic = "force-dynamic";

/** Read-only JSON search API. Same parameters as /documents. */
export async function GET(req: Request) {
  const rl = rateLimit(`search:${clientIp(req.headers)}`, 60, 60_000);
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } });
  const url = new URL(req.url);
  const raw: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    raw[key] = all.length > 1 ? all : all[0]!;
  }
  const params = searchParamsSchema.parse(raw);
  const res = await searchDocuments(params);
  return NextResponse.json({
    total: res.total,
    page: res.page,
    pageSize: res.pageSize,
    results: res.rows.map(({ rank: _rank, ...r }) => ({ ...r, url: `/documents/${r.id}` })),
  });
}
