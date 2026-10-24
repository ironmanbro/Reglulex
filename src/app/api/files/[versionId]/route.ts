import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { storage } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * Serves an archived original. HTML originals are never served as HTML from this origin
 * (they are untrusted third-party markup): they are sent as a download with a sandbox CSP.
 */
export async function GET(req: Request, { params }: { params: Promise<{ versionId: string }> }) {
  if (env().SERVE_ORIGINAL_FILES !== "true") return new NextResponse("Archived copies are not served; use the official source link.", { status: 404 });
  const { versionId } = await params;
  if (!/^\d{1,12}$/.test(versionId)) return new NextResponse("Not found", { status: 404 });
  const rl = rateLimit(`file:${clientIp(req.headers)}`, 120, 60_000);
  if (!rl.ok) return new NextResponse("Too many requests", { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } });

  const [row] = await db()<{ storage_key: string; file_format: string; content_type: string; sha256: string; original_filename: string | null; document_id: string }[]>`
    SELECT f.storage_key, f.file_format, f.content_type, f.sha256, f.original_filename, v.document_id
    FROM document_versions v JOIN stored_files f ON f.id = v.file_id JOIN documents d ON d.id = v.document_id
    WHERE v.id = ${Number(versionId)} AND d.relevance <> 'out_of_scope'`;
  if (!row) return new NextResponse("Not found", { status: 404 });

  const etag = `"${row.sha256}"`;
  if (req.headers.get("if-none-match") === etag) return new NextResponse(null, { status: 304, headers: { etag } });

  let body: Buffer;
  try {
    body = await storage().get(row.storage_key);
  } catch {
    return new NextResponse("The archived file is temporarily unavailable. Use the official source link.", { status: 503 });
  }
  const download = new URL(req.url).searchParams.has("download") || row.file_format !== "pdf";
  const safeName = (row.original_filename || `${row.document_id}.${row.file_format}`).replace(/[^\w.\-]+/g, "_").slice(0, 120);
  const type = row.file_format === "pdf" ? "application/pdf"
    : row.file_format === "html" ? "text/plain; charset=utf-8"
    : row.file_format === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    : "application/octet-stream";
  return new NextResponse(new Uint8Array(body), {
    headers: {
      "content-type": type,
      "content-length": String(body.length),
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${safeName}"`,
      "cache-control": "public, max-age=86400, immutable",
      etag,
      "x-content-type-options": "nosniff",
      ...(row.file_format === "pdf" ? {} : { "content-security-policy": "sandbox; default-src 'none'" }),
    },
  });
}
