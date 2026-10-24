import * as cheerio from "cheerio";
import { canonicalUrl, cleanTitle, parseIndianDate } from "../normalize";

export interface ExtractedLink {
  url: string;
  title: string;
  dateRaw: string | null;
  rowText: string;
}

const GENERIC_ANCHOR = /^(download|pdf|view|click here|here|read more|more|details?|open|link|english|hindi|\(?\d+(\.\d+)?\s*(kb|mb)\)?|file)$/i;

function isGeneric(title: string): boolean {
  if (!title || GENERIC_ANCHOR.test(title)) return true;
  const rest = title.replace(/\(?\d+(\.\d+)?\s*(kb|mb)\)?/gi, " ").replace(/\b(download|view|pdf|click here|file|english|hindi)\b/gi, " ").trim();
  return rest.length < 6;
}

const DATE_TOKEN =
  /\b(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}(?:st|nd|rd|th)?[\s\-][A-Za-z]{3,9}\.?,?[\s\-]\d{4}|\d{4}-\d{2}-\d{2})\b/;

/**
 * Finds document links in an index page. Rather than relying on exact markup (which
 * government sites change without notice), it selects anchors whose absolute URL
 * matches `linkPattern`, then reads the title and date from the anchor and its row.
 */
export function extractLinks(html: string, baseUrl: string, linkPattern: RegExp): ExtractedLink[] {
  const $ = cheerio.load(html);
  const out = new Map<string, ExtractedLink>();
  $("a[href]").each((_, el) => {
    const a = $(el);
    const href = a.attr("href")!;
    if (/^(javascript|mailto|tel):/i.test(href.trim())) return;
    const url = canonicalUrl(href, baseUrl);
    if (!url || !linkPattern.test(url)) return;

    const row = a.closest("tr").length ? a.closest("tr") : a.closest("li").length ? a.closest("li") : a.parent();
    // Join cell/child texts with spaces so adjacent cells ("05/01/2099" + "Title") don't run together.
    const cells = row.find("td, th").length ? row.find("td, th") : row.contents();
    const rowText = cleanTitle(cells.map((_, c) => $(c).text()).get().join(" "));
    let title = cleanTitle(a.attr("title") || a.text());
    if (isGeneric(title)) {
      // Fall back to the row's text minus dates and file-size noise.
      title = cleanTitle(
        rowText
          .replace(new RegExp(DATE_TOKEN.source, "g"), " ")
          .replace(/\(?\d+(\.\d+)?\s*(KB|MB)\)?/gi, " ")
          .replace(/\b(download|view|pdf)\b/gi, " "),
      );
    }
    if (!title) return;
    const dateMatch = rowText.match(DATE_TOKEN);
    const dateRaw = dateMatch && parseIndianDate(dateMatch[0]) ? dateMatch[0] : null;

    const existing = out.get(url);
    if (!existing || (existing.title.length < title.length && isGeneric(existing.title))) {
      out.set(url, { url, title, dateRaw: dateRaw ?? existing?.dateRaw ?? null, rowText: rowText.slice(0, 500) });
    }
  });
  return [...out.values()];
}

/** Finds the first link (href/src, including PDF-viewer `file=` parameters) matching a pattern. */
export function findFileLink(html: string, baseUrl: string, pattern: RegExp): string | null {
  const $ = cheerio.load(html);
  const candidates: string[] = [];
  $("[href], [src], [data], [data-src]").each((_, el) => {
    for (const attr of ["href", "src", "data", "data-src"]) {
      const v = $(el).attr(attr);
      if (!v) continue;
      // PDF.js-style viewers wrap the real file: /web/?file=https://.../x.pdf — prefer the inner URL.
      const fileParam = /[?&]file=([^&#]+)/i.exec(v)?.[1];
      if (fileParam) candidates.push(decodeURIComponent(fileParam));
      candidates.push(v);
    }
  });
  for (const c of candidates) {
    const url = canonicalUrl(c, baseUrl);
    if (!url) continue;
    // Match on host + path only, so a viewer URL whose *query* mentions a PDF is not taken for the file.
    const u = new URL(url);
    if (pattern.test(u.hostname + u.pathname)) return url;
  }
  return null;
}

export function pageTitle(html: string, selectors: string[]): string | null {
  const $ = cheerio.load(html);
  for (const sel of selectors) {
    const t = cleanTitle($(sel).first().text());
    if (t && t.length > 4) return t;
  }
  return null;
}

export function firstDateIn(text: string): string | null {
  const m = text.match(new RegExp(DATE_TOKEN.source, "g"));
  for (const tok of m ?? []) if (parseIndianDate(tok)) return tok;
  return null;
}
