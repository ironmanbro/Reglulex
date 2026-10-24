import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import * as cheerio from "cheerio";
import { env } from "@/lib/env";

const run = promisify(execFile);

export type ExtractionStatus =
  | "ok" | "partial" | "ocr_ok" | "ocr_low_confidence" | "ocr_unavailable" | "failed" | "not_applicable";

export interface Extraction {
  method: "pdftotext" | "ocr" | "html" | "docx" | "text" | "none";
  status: ExtractionStatus;
  text: string;
  pages: string[] | null;
  pageCount: number | null;
  ocrConfidence: number | null;
  error: string | null;
}

/** Minimum average characters per page for a PDF text layer to be considered usable. */
const MIN_CHARS_PER_PAGE = 80;
const OCR_CONFIDENCE_OK = 70;

export function normalizeText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

let toolCache: Record<string, boolean> = {};
async function hasTool(cmd: string): Promise<boolean> {
  if (cmd in toolCache) return toolCache[cmd]!;
  try {
    await run(cmd, ["-v"], { timeout: 10_000 });
    toolCache[cmd] = true;
  } catch (err) {
    // pdftotext -v exits 0 on new poppler, 99 on old; ENOENT means missing.
    toolCache[cmd] = (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
  return toolCache[cmd]!;
}
export function resetToolCache() {
  toolCache = {};
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "firl-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function extractPdf(buf: Buffer, opts: { ocr?: boolean } = {}): Promise<Extraction> {
  if (!(await hasTool("pdftotext"))) {
    return { method: "none", status: "failed", text: "", pages: null, pageCount: null, ocrConfidence: null, error: "pdftotext (poppler-utils) is not installed" };
  }
  return withTemp(async (dir) => {
    const file = path.join(dir, "in.pdf");
    await writeFile(file, buf);
    let raw: string;
    try {
      const res = await run("pdftotext", ["-layout", "-enc", "UTF-8", file, "-"], { timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
      raw = res.stdout;
    } catch (err) {
      return { method: "pdftotext", status: "failed", text: "", pages: null, pageCount: null, ocrConfidence: null, error: `pdftotext failed: ${(err as Error).message.slice(0, 500)}` };
    }
    const pages = raw.split("\f").map(normalizeText);
    if (pages.length > 1 && pages[pages.length - 1] === "") pages.pop();
    const pageCount = pages.length;
    const total = pages.reduce((n, p) => n + p.length, 0);
    const emptyPages = pages.filter((p) => p.length < 20).length;

    if (pageCount > 0 && total / pageCount >= MIN_CHARS_PER_PAGE) {
      // Usable text layer. Flag as partial when a material share of pages has no text (mixed scans).
      const partial = emptyPages > 0 && emptyPages / pageCount > 0.2;
      return {
        method: "pdftotext",
        status: partial ? "partial" : "ok",
        text: pages.join("\n\n"),
        pages,
        pageCount,
        ocrConfidence: null,
        error: partial ? `${emptyPages} of ${pageCount} pages have no extractable text` : null,
      };
    }
    // No usable text layer: likely a scanned document.
    const ocrWanted = opts.ocr ?? env().OCR_ENABLED === "true";
    if (!ocrWanted || !(await hasTool("tesseract")) || !(await hasTool("pdftoppm"))) {
      return {
        method: "pdftotext",
        status: "ocr_unavailable",
        text: pages.join("\n\n"),
        pages,
        pageCount,
        ocrConfidence: null,
        error: ocrWanted ? "Scanned PDF and OCR tools (tesseract, pdftoppm) are not installed" : "Scanned PDF and OCR is disabled",
      };
    }
    return ocrPdf(file, dir, pageCount);
  });
}

async function ocrPdf(file: string, dir: string, pageCount: number): Promise<Extraction> {
  const maxPages = env().OCR_MAX_PAGES;
  const last = Math.max(1, Math.min(pageCount || maxPages, maxPages));
  try {
    await run("pdftoppm", ["-r", "200", "-gray", "-png", "-f", "1", "-l", String(last), file, path.join(dir, "pg")], { timeout: 600_000 });
  } catch (err) {
    return { method: "ocr", status: "failed", text: "", pages: null, pageCount, ocrConfidence: null, error: `pdftoppm failed: ${(err as Error).message.slice(0, 300)}` };
  }
  const images = (await readdir(dir)).filter((f) => f.startsWith("pg") && f.endsWith(".png")).sort();
  const pages: string[] = [];
  const confidences: number[] = [];
  for (const img of images) {
    const base = path.join(dir, img.replace(/\.png$/, ""));
    try {
      await run("tesseract", [path.join(dir, img), base, "-l", env().OCR_LANGUAGES, "txt", "tsv"], { timeout: 180_000 });
      pages.push(normalizeText(await readFile(base + ".txt", "utf8")));
      const tsv = await readFile(base + ".tsv", "utf8");
      for (const line of tsv.split("\n").slice(1)) {
        const cols = line.split("\t");
        const conf = Number(cols[10]);
        if (cols[11]?.trim() && conf >= 0) confidences.push(conf);
      }
    } catch (err) {
      pages.push("");
    }
  }
  const text = pages.join("\n\n");
  const mean = confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0;
  const truncated = pageCount > last;
  const lowConfidence = mean < OCR_CONFIDENCE_OK || text.length < 40;
  return {
    method: "ocr",
    status: lowConfidence ? "ocr_low_confidence" : truncated ? "partial" : "ocr_ok",
    text,
    pages,
    pageCount,
    ocrConfidence: Math.round(mean * 10) / 10,
    error: [
      lowConfidence ? `OCR mean confidence ${mean.toFixed(1)} below ${OCR_CONFIDENCE_OK}` : null,
      truncated ? `OCR limited to first ${last} of ${pageCount} pages` : null,
    ].filter(Boolean).join("; ") || null,
  };
}

/** Decodes HTML bytes using the declared charset (header or meta), defaulting to UTF-8. */
export function decodeHtml(buf: Buffer, contentType = ""): string {
  const fromHeader = /charset=([\w-]+)/i.exec(contentType)?.[1];
  const head = buf.subarray(0, 4096).toString("latin1");
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  const label = (fromHeader || fromMeta || "utf-8").toLowerCase();
  try {
    return new TextDecoder(label).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

/**
 * Extracts readable text from untrusted HTML. Scripts, styles and navigation chrome are
 * dropped; nothing from the page is ever executed or re-rendered as HTML.
 */
export function extractHtmlText(html: string, contentSelector?: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, iframe, object, embed, svg, form, nav, header, footer, select, button").remove();
  let root = contentSelector ? $(contentSelector).first() : $("main, article, #content, .content").first();
  if (!root.length) root = $("body");
  root.find("br").replaceWith("\n");
  root.find("p, div, li, tr, h1, h2, h3, h4, h5, h6, table, section").each((_, el) => {
    $(el).append("\n");
  });
  root.find("td, th").each((_, el) => {
    $(el).append(" \t");
  });
  return normalizeText(root.text());
}

export async function extractDocx(buf: Buffer): Promise<Extraction> {
  try {
    const mammoth = await import("mammoth");
    const res = await mammoth.extractRawText({ buffer: buf });
    const text = normalizeText(res.value);
    return { method: "docx", status: text ? "ok" : "failed", text, pages: null, pageCount: null, ocrConfidence: null, error: text ? null : "DOCX contained no text" };
  } catch (err) {
    return { method: "docx", status: "failed", text: "", pages: null, pageCount: null, ocrConfidence: null, error: `DOCX extraction failed: ${(err as Error).message}` };
  }
}

export async function extract(buf: Buffer, format: string, contentType: string, opts: { contentSelector?: string; ocr?: boolean } = {}): Promise<Extraction> {
  switch (format) {
    case "pdf":
      return extractPdf(buf, { ocr: opts.ocr });
    case "html": {
      const text = extractHtmlText(decodeHtml(buf, contentType), opts.contentSelector);
      return { method: "html", status: text.length > 40 ? "ok" : "failed", text, pages: null, pageCount: null, ocrConfidence: null, error: text.length > 40 ? null : "HTML page contained almost no text" };
    }
    case "docx":
      return extractDocx(buf);
    case "txt": {
      const text = normalizeText(buf.toString("utf8"));
      return { method: "text", status: "ok", text, pages: null, pageCount: null, ocrConfidence: null, error: null };
    }
    default:
      return { method: "none", status: "failed", text: "", pages: null, pageCount: null, ocrConfidence: null, error: `Text extraction not supported for format '${format}'` };
  }
}
