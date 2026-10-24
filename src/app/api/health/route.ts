import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Liveness + readiness: confirms the database answers. Exposes no configuration or secrets. */
export async function GET() {
  try {
    const [row] = await db()<{ last_success: Date | null; failing: number; dead_jobs: number }[]>`
      SELECT (SELECT max(last_success_at) FROM sources) AS last_success,
             (SELECT count(*)::int FROM sources WHERE enabled AND verification_status IN ('failing','parser_attention')) AS failing,
             (SELECT count(*)::int FROM jobs WHERE status = 'dead') AS dead_jobs`;
    return NextResponse.json({ status: "ok", database: "ok", lastSuccessfulCollection: row?.last_success ?? null, sourcesNeedingAttention: row?.failing ?? 0, deadJobs: row?.dead_jobs ?? 0 });
  } catch {
    return NextResponse.json({ status: "error", database: "unreachable" }, { status: 503 });
  }
}
