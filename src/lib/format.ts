import { DOCUMENT_TYPE_LABELS, type DocumentType } from "@/ingest/normalize";

const IST = "Asia/Kolkata";

export function fmtDate(d: string | null | undefined): string {
  if (!d) return "Date not recorded";
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function fmtDateTime(d: Date | string | null | undefined): string {
  if (!d) return "Never";
  return new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: IST, timeZoneName: "short" });
}

export function fmtRelative(d: Date | string | null | undefined, now = Date.now()): string {
  if (!d) return "never";
  const s = Math.round((now - new Date(d).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
  if (s < 129600) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export function typeLabel(t: string): string {
  return DOCUMENT_TYPE_LABELS[t as DocumentType] ?? t;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const ROUTE_LABELS: Record<string, string> = {
  fpi: "FPI", fdi: "FDI", fvci: "FVCI", fema: "FEMA", ifsc: "IFSC", taxation: "Tax", general: "General",
};

export const EXTRACTION_LABELS: Record<string, string> = {
  ok: "Text extracted",
  partial: "Partially extracted — some pages have no text",
  ocr_ok: "Text recognised by OCR",
  ocr_low_confidence: "OCR text — low confidence, may contain errors",
  ocr_unavailable: "Scanned document — not yet text-searchable",
  failed: "Text could not be extracted",
  pending: "Extraction pending",
  not_applicable: "No text content",
};
