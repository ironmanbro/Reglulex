import { z } from "zod";
import type { Fetcher, FetchResult } from "@/lib/http/fetcher";
import type { DocumentType } from "../normalize";

export interface DiscoveredEntry {
  /** Stable identity of the entry within its source (canonical landing or file URL). */
  entryKey: string;
  landingUrl: string | null;
  documentUrl: string | null;
  title: string;
  dateRaw?: string | null;
  hints?: {
    documentType?: DocumentType;
    documentNumber?: string;
    department?: string;
    /** Set when discovery already established the entry is out of scope (e.g. ID scan). */
    prescreen?: "out_of_scope";
  };
}

export interface PageReport {
  url: string;
  ok: boolean;
  status?: number;
  itemsFound: number;
  /** True when this page is expected to contain entries (a zero count then means the parser needs attention). */
  expectsItems: boolean;
  error?: string;
}

export interface DiscoveryResult {
  entries: DiscoveredEntry[];
  pages: PageReport[];
  notes: string[];
  /** Persisted back into sources.config.state (e.g. a scan cursor). */
  state?: Record<string, unknown>;
}

export interface ResolvedDocument {
  fileUrl: string;
  /** If the resolver already downloaded the file (e.g. an HTML page that is itself the document). */
  prefetched?: FetchResult;
  title?: string;
  dateRaw?: string | null;
  documentNumber?: string | null;
  department?: string | null;
}

export type CrawlMode = "incremental" | "backfill";

export interface ConnectorContext {
  fetcher: Fetcher;
  mode: CrawlMode;
  config: SourceConfig;
  isKnown: (entryKey: string) => Promise<boolean>;
}

export interface Connector {
  discover(ctx: ConnectorContext): Promise<DiscoveryResult>;
}

const docType = z.enum([
  "act", "rules", "regulations", "master_direction", "master_circular", "circular", "notification",
  "gazette_notification", "press_note", "policy", "guidelines", "faq", "order", "consultation_paper",
  "press_release", "corrigendum", "amendment", "clarification", "form", "report", "other", "unknown",
]);

/** Settings shared by every connector; connector-specific keys live alongside. */
export const baseConfigSchema = z.object({
  resolver: z.enum(["direct", "detail_pdf", "sebi_detail", "rbi_detail"]).default("direct"),
  detailFilePattern: z.string().optional(),
  documentType: docType.optional(),
  assumeInScope: z.boolean().default(false),
  defaultRoutes: z.array(z.string()).default([]),
  downloadPolicy: z.enum(["all", "relevant_only"]).default("relevant_only"),
  titleInclude: z.string().optional(),
  titleExclude: z.string().optional(),
  contentSelector: z.string().optional(),
  redistribution: z.enum(["mirror", "link_only"]).default("mirror"),
  state: z.record(z.unknown()).default({}),
});

export const rssConfigSchema = baseConfigSchema.extend({
  feedUrl: z.string().url(),
  linkPattern: z.string().optional(),
});

export const linkIndexConfigSchema = baseConfigSchema.extend({
  pages: z.array(z.string().url()).min(1),
  linkPattern: z.string(),
  minLinksPerPage: z.number().int().min(0).default(1),
  pagination: z
    .object({
      param: z.string(),
      start: z.number().int().default(1),
      maxPagesIncremental: z.number().int().min(1).default(1),
      maxPagesBackfill: z.number().int().min(1).default(50),
    })
    .optional(),
});

export const sebiListingConfigSchema = baseConfigSchema.extend({
  listUrl: z.string().url(),
  ajaxUrl: z.string().url().default("https://www.sebi.gov.in/sebiweb/ajax/home/getnewslistinfo.jsp"),
  linkPattern: z.string().default("^https?://(www\\.)?sebi\\.gov\\.in/(legal|enforcement|media|sebi_data)/.+\\.(html|pdf)$"),
  form: z.record(z.string()).default({}),
  pageField: z.string().default("doDirect"),
  pageFieldZeroBased: z.boolean().default(true),
  maxPagesIncremental: z.number().int().min(1).default(2),
  maxPagesBackfill: z.number().int().min(1).default(300),
});

export const rbiIdScanConfigSchema = baseConfigSchema.extend({
  urlTemplate: z.string().default("https://www.rbi.org.in/Scripts/NotificationUser.aspx?Id={id}&Mode=0"),
  startId: z.number().int().min(1),
  endId: z.number().int().min(1),
  maxPerRun: z.number().int().min(1).max(2000).default(200),
});

export type SourceConfig = z.infer<typeof baseConfigSchema> & Record<string, unknown>;
