import type { Fetcher } from "@/lib/http/fetcher";
import { decodeHtml } from "../extract";
import { firstDateIn, findFileLink, pageTitle } from "./html-links";
import type { DiscoveredEntry, ResolvedDocument, SourceConfig } from "./types";

const PDF = /\.pdf($|[?#])/i;

/**
 * Turns a discovered entry into the URL of its authoritative file. Detail pages that
 * only wrap a PDF resolve to the PDF; detail pages whose content *is* the document
 * (some RBI and SEBI pages are HTML-only) resolve to the page itself.
 */
export async function resolveEntry(fetcher: Fetcher, entry: DiscoveredEntry, cfg: SourceConfig): Promise<ResolvedDocument> {
  if (entry.documentUrl) return { fileUrl: entry.documentUrl };
  if (!entry.landingUrl) throw new Error("Entry has neither a document URL nor a landing page");
  if (cfg.resolver === "direct") return { fileUrl: entry.landingUrl };

  const page = await fetcher.fetch(entry.landingUrl);
  const ct = page.contentType.toLowerCase();
  if (ct.includes("pdf") || page.body.subarray(0, 5).toString("latin1") === "%PDF-") {
    return { fileUrl: page.url, prefetched: page };
  }
  const html = decodeHtml(page.body, page.contentType);
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");

  switch (cfg.resolver) {
    case "sebi_detail": {
      const file =
        findFileLink(html, page.url, /sebi\.gov\.in\/sebi_data\/.+\.pdf($|\?)/i) ?? findFileLink(html, page.url, PDF);
      const title = pageTitle(html, ["h1", ".main_heading", "title"]);
      return {
        fileUrl: file ?? page.url,
        prefetched: file ? undefined : page,
        title: title?.replace(/\s*\|\s*SEBI.*$/i, "") ?? undefined,
        dateRaw: pageTitle(html, [".date_value", ".date", "h5"]) ?? firstDateIn(text.slice(0, 8000)),
      };
    }
    case "rbi_detail": {
      const file = findFileLink(html, page.url, /rbidocs\.rbi\.org\.in\/.+\.pdf($|\?)/i) ?? findFileLink(html, page.url, PDF);
      const refNo = /RBI\/(?:19|20)\d{2}-\d{2,4}\/\d{1,4}/.exec(text)?.[0] ?? null;
      return {
        fileUrl: file ?? page.url,
        prefetched: file ? undefined : page,
        title: pageTitle(html, [".tableheader b", ".tableheader", "h1", "title"]) ?? undefined,
        dateRaw: firstDateIn(text.slice(0, 20000)),
        documentNumber: refNo,
      };
    }
    case "detail_pdf":
    default: {
      const pattern = cfg.detailFilePattern ? new RegExp(cfg.detailFilePattern, "i") : PDF;
      const file = findFileLink(html, page.url, pattern);
      return {
        fileUrl: file ?? page.url,
        prefetched: file ? undefined : page,
        title: pageTitle(html, ["h1", "title"]) ?? undefined,
        dateRaw: firstDateIn(text.slice(0, 8000)),
      };
    }
  }
}
