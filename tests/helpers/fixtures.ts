// Synthetic fixtures. They mimic the *structure* of official pages (listing tables,
// detail pages wrapping PDFs) but carry invented content clearly marked as test data
// (year 2099, "TEST" department codes). They are never loaded into a real database.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { Transport } from "../../src/lib/http/fetcher";

export interface FixtureResponse {
  status?: number;
  body: string | Buffer;
  contentType?: string;
  headers?: Record<string, string>;
}

export type Route = FixtureResponse | ((init: { method: string; body?: string; headers: Record<string, string> }) => FixtureResponse);

/** A fake network: URL → response. Unknown URLs return 404. Records every request. */
export class FixtureNet {
  routes = new Map<string, Route>();
  requests: { url: string; method: string; body?: string }[] = [];

  set(url: string, r: Route) {
    this.routes.set(url, r);
    return this;
  }

  transport: Transport = async (url, init) => {
    this.requests.push({ url, method: init.method, body: init.body });
    const route = this.routes.get(url);
    const r: FixtureResponse = !route ? { status: 404, body: "not found" } : typeof route === "function" ? route(init) : route;
    const body = typeof r.body === "string" ? Buffer.from(r.body, "utf8") : r.body;
    const headers = new Headers({ "content-type": r.contentType ?? "text/html; charset=utf-8", ...(r.headers ?? {}) });
    return {
      status: r.status ?? 200,
      headers,
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(body));
          c.close();
        },
      }),
    };
  };
}

export async function textPdf(lines: string[], pages = 1): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage([595, 842]);
    let y = 800;
    for (const line of lines) {
      page.drawText(line, { x: 40, y, size: 11, font });
      y -= 18;
    }
    page.drawText(`Page ${p + 1}`, { x: 280, y: 30, size: 9, font });
  }
  // Fixed dates so identical input produces identical bytes.
  doc.setCreationDate(new Date("2099-01-01T00:00:00Z"));
  doc.setModificationDate(new Date("2099-01-01T00:00:00Z"));
  return Buffer.from(await doc.save());
}

/** Renders a text PDF to an image and wraps the image in a new PDF: a true "scanned" PDF with no text layer. */
export async function scannedPdf(lines: string[]): Promise<Buffer> {
  const dir = mkdtempSync(path.join(tmpdir(), "firl-scan-"));
  const src = path.join(dir, "src.pdf");
  writeFileSync(src, await bigTextPdf(lines));
  execFileSync("pdftoppm", ["-r", "150", "-png", "-singlefile", src, path.join(dir, "img")]);
  const png = readFileSync(path.join(dir, "img.png"));
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(png);
  const page = doc.addPage([img.width, img.height]);
  page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  return Buffer.from(await doc.save());
}

async function bigTextPdf(lines: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  let y = 780;
  for (const line of lines) {
    page.drawText(line, { x: 40, y, size: 16, font });
    y -= 28;
  }
  return Buffer.from(await doc.save());
}

export function blankPdf(): Promise<Buffer> {
  return PDFDocument.create().then(async (d) => {
    d.addPage([595, 842]);
    return Buffer.from(await d.save());
  });
}

// ---- Page builders modelled on the structure of the official sites ----

export function sebiListingHtml(rows: { date: string; title: string; href: string }[]) {
  return `<!doctype html><html><head><title>SEBI | Circulars</title><script>var x = 1;</script></head><body>
  <div class="table-responsive"><table id="sample_1" class="table"><thead><tr><th>Date</th><th>Title</th></tr></thead><tbody>
  ${rows.map((r) => `<tr role="row"><td>${r.date}</td><td><a href="${r.href}" title="${r.title}">${r.title}</a></td></tr>`).join("\n")}
  </tbody></table></div><div class="pagination_outer"><a href="javascript:void(0)" onclick="searchFormNewsList('n', '1')">Next</a></div></body></html>`;
}

export function sebiDetailHtml(title: string, date: string, pdfUrl: string) {
  return `<!doctype html><html><head><title>SEBI | ${title}</title></head><body>
  <h1>${title}</h1><h5>${date}</h5>
  <iframe src="../../../web/?file=${pdfUrl}" width="100%"></iframe></body></html>`;
}

export function indexHtml(rows: { date: string; title: string; href: string }[]) {
  return `<!doctype html><html><body><table class="table">
  ${rows.map((r) => `<tr><td>${r.date}</td><td>${r.title}</td><td><a href="${r.href}">Download (245 KB)</a></td></tr>`).join("\n")}
  </table></body></html>`;
}
