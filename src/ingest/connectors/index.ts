import { XMLParser } from "fast-xml-parser";
import { FetchError } from "@/lib/http/fetcher";
import { errorMessage } from "@/lib/log";
import { decodeHtml } from "../extract";
import { canonicalUrl, cleanTitle } from "../normalize";
import { extractLinks, firstDateIn, pageTitle } from "./html-links";
import {
  linkIndexConfigSchema,
  rbiIdScanConfigSchema,
  rssConfigSchema,
  sebiListingConfigSchema,
  type Connector,
  type ConnectorContext,
  type DiscoveredEntry,
  type DiscoveryResult,
  type PageReport,
} from "./types";

function titleFilter(cfg: { titleInclude?: string; titleExclude?: string }) {
  const inc = cfg.titleInclude ? new RegExp(cfg.titleInclude, "i") : null;
  const exc = cfg.titleExclude ? new RegExp(cfg.titleExclude, "i") : null;
  return (t: string) => (!inc || inc.test(t)) && (!exc || !exc.test(t));
}

function failedPage(url: string, err: unknown, expectsItems = true): PageReport {
  return {
    url,
    ok: false,
    status: err instanceof FetchError ? err.status : undefined,
    itemsFound: 0,
    expectsItems,
    error: errorMessage(err),
  };
}

// ---------------------------------------------------------------------------
// RSS / Atom feed
// ---------------------------------------------------------------------------

export const rssConnector: Connector = {
  async discover(ctx) {
    const cfg = rssConfigSchema.parse(ctx.config);
    const pages: PageReport[] = [];
    const entries: DiscoveredEntry[] = [];
    const notes: string[] = [];
    let body: string;
    try {
      const res = await ctx.fetcher.fetch(cfg.feedUrl);
      body = decodeHtml(res.body, res.contentType);
    } catch (err) {
      return { entries, pages: [failedPage(cfg.feedUrl, err)], notes };
    }
    let items: Record<string, unknown>[] = [];
    try {
      const parsed = new XMLParser({ ignoreAttributes: false, processEntities: true, htmlEntities: true }).parse(body);
      const raw = parsed?.rss?.channel?.item ?? parsed?.feed?.entry ?? parsed?.["rdf:RDF"]?.item ?? [];
      items = Array.isArray(raw) ? raw : [raw];
      if (!parsed?.rss && !parsed?.feed && !parsed?.["rdf:RDF"]) throw new Error("Response is not an RSS/Atom document");
    } catch (err) {
      pages.push({ url: cfg.feedUrl, ok: true, itemsFound: 0, expectsItems: true, error: `Feed parse failed: ${errorMessage(err)}` });
      return { entries, pages, notes };
    }
    const linkRe = cfg.linkPattern ? new RegExp(cfg.linkPattern, "i") : null;
    const keep = titleFilter(cfg);
    let filtered = 0;
    for (const it of items) {
      const linkRaw = typeof it.link === "string" ? it.link : ((it.link as Record<string, string>)?.["@_href"] ?? String(it.guid ?? ""));
      const url = canonicalUrl(String(linkRaw ?? ""), cfg.feedUrl);
      const title = cleanTitle(String((it.title as string) ?? ""));
      if (!url || !title) continue;
      if ((linkRe && !linkRe.test(url)) || !keep(title)) {
        filtered++;
        continue;
      }
      const isFile = /\.(pdf|docx?)($|\?)/i.test(url);
      entries.push({
        entryKey: url,
        landingUrl: isFile ? null : url,
        documentUrl: isFile ? url : null,
        title,
        dateRaw: String(it.pubDate ?? it.updated ?? it["dc:date"] ?? "") || null,
        hints: cfg.documentType ? { documentType: cfg.documentType } : undefined,
      });
    }
    if (filtered) notes.push(`${filtered} feed items outside configured link/title filters`);
    pages.push({ url: cfg.feedUrl, ok: true, itemsFound: items.length, expectsItems: true });
    return { entries, pages, notes };
  },
};

// ---------------------------------------------------------------------------
// Generic link index (one or more HTML pages listing documents, optional ?page=N)
// ---------------------------------------------------------------------------

export const linkIndexConnector: Connector = {
  async discover(ctx) {
    const cfg = linkIndexConfigSchema.parse(ctx.config);
    const re = new RegExp(cfg.linkPattern, "i");
    const keep = titleFilter(cfg);
    const pages: PageReport[] = [];
    const notes: string[] = [];
    const entries = new Map<string, DiscoveredEntry>();

    for (const base of cfg.pages) {
      const maxPages = cfg.pagination ? (ctx.mode === "backfill" ? cfg.pagination.maxPagesBackfill : cfg.pagination.maxPagesIncremental) : 1;
      for (let i = 0; i < maxPages; i++) {
        let url = base;
        if (cfg.pagination) {
          const u = new URL(base);
          u.searchParams.set(cfg.pagination.param, String(cfg.pagination.start + i));
          url = i === 0 && !u.search ? base : u.toString();
        }
        let html: string;
        try {
          const res = await ctx.fetcher.fetch(url);
          html = decodeHtml(res.body, res.contentType);
        } catch (err) {
          // A 404 beyond the first page means we ran past the end of pagination.
          if (i > 0 && err instanceof FetchError && err.status === 404) break;
          pages.push(failedPage(url, err, i === 0));
          break;
        }
        const links = extractLinks(html, url, re);
        pages.push({ url, ok: true, itemsFound: links.length, expectsItems: i === 0 && cfg.minLinksPerPage > 0 });
        let fresh = 0;
        for (const l of links) {
          if (entries.has(l.url) || !keep(l.title)) continue;
          const isFile = /\.(pdf|docx?|xlsx?)($|\?)/i.test(l.url);
          entries.set(l.url, {
            entryKey: l.url,
            landingUrl: isFile ? url : l.url,
            documentUrl: isFile ? l.url : null,
            title: l.title,
            dateRaw: l.dateRaw,
            hints: cfg.documentType ? { documentType: cfg.documentType } : undefined,
          });
          fresh++;
        }
        if (fresh === 0) break; // end of pagination or a repeated page
        if (ctx.mode === "incremental" && cfg.pagination) {
          const unknown = await Promise.all(links.map((l) => ctx.isKnown(l.url).then((k) => !k)));
          if (!unknown.some(Boolean)) break; // everything on this page already collected
        }
      }
    }
    return { entries: [...entries.values()], pages, notes };
  },
};

// ---------------------------------------------------------------------------
// SEBI listing: first page by GET, later pages via the site's AJAX listing endpoint.
// ---------------------------------------------------------------------------

export const sebiListingConnector: Connector = {
  async discover(ctx) {
    const cfg = sebiListingConfigSchema.parse(ctx.config);
    const re = new RegExp(cfg.linkPattern, "i");
    const keep = titleFilter(cfg);
    const pages: PageReport[] = [];
    const notes: string[] = [];
    const entries = new Map<string, DiscoveredEntry>();
    const maxPages = ctx.mode === "backfill" ? cfg.maxPagesBackfill : cfg.maxPagesIncremental;

    for (let page = 1; page <= maxPages; page++) {
      const url = page === 1 ? cfg.listUrl : cfg.ajaxUrl;
      let html: string;
      try {
        const res =
          page === 1
            ? await ctx.fetcher.fetch(url)
            : await ctx.fetcher.fetch(url, {
                method: "POST",
                form: { ...cfg.form, [cfg.pageField]: String(cfg.pageFieldZeroBased ? page - 1 : page) },
                headers: { "x-requested-with": "XMLHttpRequest", referer: cfg.listUrl },
              });
        html = decodeHtml(res.body, res.contentType);
      } catch (err) {
        pages.push(failedPage(page === 1 ? url : `${url}#page=${page}`, err, page === 1));
        break;
      }
      const links = extractLinks(html, cfg.listUrl, re).filter((l) => !/\/(sebiweb|web)\//.test(new URL(l.url).pathname));
      const label = page === 1 ? url : `${url}#page=${page}`;
      pages.push({ url: label, ok: true, itemsFound: links.length, expectsItems: page === 1 });
      let fresh = 0;
      for (const l of links) {
        if (entries.has(l.url) || !keep(l.title)) continue;
        entries.set(l.url, {
          entryKey: l.url,
          landingUrl: /\.pdf$/i.test(l.url) ? cfg.listUrl : l.url,
          documentUrl: /\.pdf$/i.test(l.url) ? l.url : null,
          title: l.title,
          dateRaw: l.dateRaw,
          hints: cfg.documentType ? { documentType: cfg.documentType } : undefined,
        });
        fresh++;
      }
      if (fresh === 0) {
        if (page === 2) notes.push("Pagination request returned no new entries; AJAX pagination parameters may need review");
        break;
      }
      if (ctx.mode === "incremental") {
        const known = await Promise.all(links.map((l) => ctx.isKnown(l.url)));
        if (known.every(Boolean)) break;
      }
    }
    return { entries: [...entries.values()], pages, notes };
  },
};

// ---------------------------------------------------------------------------
// RBI notification ID scan — historical backfill by walking sequential page IDs.
// Discovery fetches each page to read its title so out-of-scope notices are screened early.
// ---------------------------------------------------------------------------

export const rbiIdScanConnector: Connector = {
  async discover(ctx) {
    const cfg = rbiIdScanConfigSchema.parse(ctx.config);
    const pages: PageReport[] = [];
    const notes: string[] = [];
    const entries: DiscoveredEntry[] = [];
    if (ctx.mode !== "backfill") {
      notes.push("ID scan runs only in backfill mode; incremental discovery comes from the RBI feed");
      return { entries, pages, notes };
    }
    const cursor = Number((cfg.state as { cursor?: number }).cursor ?? cfg.startId);
    const stop = Math.min(cfg.endId, cursor + cfg.maxPerRun - 1);
    const keep = titleFilter(cfg);
    let id = cursor;
    let consecutiveFailures = 0;
    for (; id <= stop; id++) {
      const url = cfg.urlTemplate.replace("{id}", String(id));
      if (await ctx.isKnown(url)) continue;
      try {
        const res = await ctx.fetcher.fetch(url, { acceptStatuses: [404] });
        consecutiveFailures = 0;
        if (res.status === 404) continue;
        const html = decodeHtml(res.body, res.contentType);
        const title = pageTitle(html, [".tableheader b", ".tableheader", "td.tableheader", "h1", "title"]);
        if (!title || /^reserve bank of india\s*$/i.test(title)) {
          pages.push({ url, ok: true, itemsFound: 0, expectsItems: false });
          continue;
        }
        pages.push({ url, ok: true, itemsFound: 1, expectsItems: false });
        entries.push({
          entryKey: url,
          landingUrl: url,
          documentUrl: null,
          title,
          dateRaw: firstDateIn(html.replace(/<[^>]+>/g, " ").slice(0, 20000)),
          hints: { documentType: "notification", ...(keep(title) ? {} : { prescreen: "out_of_scope" as const }) },
        });
      } catch (err) {
        pages.push(failedPage(url, err, false));
        if (++consecutiveFailures >= 5) {
          notes.push(`Stopped after 5 consecutive failures at id ${id}`);
          break;
        }
      }
    }
    const next = consecutiveFailures >= 5 ? id : stop + 1;
    notes.push(`Scanned ids ${cursor}–${Math.min(id, stop)}; next cursor ${next}${next > cfg.endId ? " (range complete)" : ""}`);
    return { entries, pages, notes, state: { cursor: next } };
  },
};

export const CONNECTORS: Record<string, Connector> = {
  rss: rssConnector,
  link_index: linkIndexConnector,
  sebi_listing: sebiListingConnector,
  rbi_id_scan: rbiIdScanConnector,
};

export function getConnector(kind: string): Connector {
  const c = CONNECTORS[kind];
  if (!c) throw new Error(`Unknown connector kind: ${kind}`);
  return c;
}

export type { ConnectorContext, DiscoveryResult };
