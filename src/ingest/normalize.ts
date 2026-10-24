// Normalisation helpers for dates, document numbers, titles and document types.
// All functions are pure and return null rather than guessing.

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

function iso(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`;
}

/**
 * Parses the date formats used on Indian regulator websites. Numeric dates are read
 * day-first (DD/MM/YYYY), which is the Indian convention. Returns YYYY-MM-DD or null.
 */
export function parseIndianDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.replace(/\s+/g, " ").trim();
  let m: RegExpMatchArray | null;
  if ((m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/))) return iso(+m[1]!, +m[2]!, +m[3]!);
  if ((m = s.match(/\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})\b/))) return iso(+m[3]!, +m[2]!, +m[1]!);
  // "Oct 14, 2026" / "October 14, 2026"
  if ((m = s.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/))) {
    const mon = MONTHS[m[1]!.toLowerCase()];
    if (mon) return iso(+m[3]!, mon, +m[2]!);
  }
  // "14 Oct 2026" / "14th October, 2026" / "14-Oct-2026"
  if ((m = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?[\s\-]+([A-Za-z]{3,9})\.?,?[\s\-]+(\d{4})\b/))) {
    const mon = MONTHS[m[2]!.toLowerCase()];
    if (mon) return iso(+m[3]!, mon, +m[1]!);
  }
  // RFC 822 (RSS pubDate): "Tue, 14 Oct 2026 10:00:00 +0530"
  if (/^[A-Za-z]{3},/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      // Use the calendar date in IST, which is the publisher's local date.
      const ist = new Date(d.getTime() + 330 * 60_000);
      return iso(ist.getUTCFullYear(), ist.getUTCMonth() + 1, ist.getUTCDate());
    }
  }
  return null;
}

/** Canonical form for matching document numbers: upper-case, no whitespace, unified punctuation. */
export function normalizeDocNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw
    .toUpperCase()
    .replace(/[‐-―]/g, "-")
    .replace(/\bNO\s*\.\s*/g, "NO.")
    .replace(/\s+/g, "")
    .replace(/[.,;:]+$/, "");
  return s.length >= 3 ? s : null;
}

export function cleanTitle(raw: string | null | undefined): string {
  return (raw ?? "")
    .replace(/[ \s]+/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
}

export type DocumentType =
  | "act" | "rules" | "regulations" | "master_direction" | "master_circular" | "circular" | "notification"
  | "gazette_notification" | "press_note" | "policy" | "guidelines" | "faq" | "order" | "consultation_paper"
  | "press_release" | "corrigendum" | "amendment" | "clarification" | "form" | "report" | "other" | "unknown";

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  act: "Act", rules: "Rules", regulations: "Regulations", master_direction: "Master Direction",
  master_circular: "Master Circular", circular: "Circular", notification: "Notification",
  gazette_notification: "Gazette Notification", press_note: "Press Note", policy: "Policy",
  guidelines: "Guidelines", faq: "FAQ", order: "Order", consultation_paper: "Consultation Paper",
  press_release: "Press Release", corrigendum: "Corrigendum", amendment: "Amendment",
  clarification: "Clarification", form: "Form", report: "Report", other: "Other", unknown: "Unknown",
};

/**
 * Infers a document type from its title. Strong markers (corrigendum, amendment) override
 * the source's category hint; otherwise the hint wins over weaker title cues.
 */
export function inferDocumentType(title: string, hint?: DocumentType | null): DocumentType {
  const t = title.toLowerCase();
  if (/\bcorrigend(um|a)\b|\berratum\b/.test(t)) return "corrigendum";
  if (/\(\s*(\w+\s+)?amendment\s*\)\s*(regulations|rules|act|directions?)/.test(t)) return "amendment";
  if (/\bmaster direction\b/.test(t)) return "master_direction";
  if (/\bmaster circular\b/.test(t)) return "master_circular";
  if (hint && hint !== "unknown") return hint;
  if (/\bconsultation paper\b/.test(t)) return "consultation_paper";
  if (/\bpress note\b/.test(t)) return "press_note";
  if (/\bconsolidated fdi policy\b|\bfdi policy\b/.test(t)) return "policy";
  if (/\bfaqs?\b|frequently asked questions/.test(t)) return "faq";
  if (/\bpress release\b/.test(t)) return "press_release";
  if (/\bregulations?,?\s*\d{4}\b/.test(t)) return "regulations";
  if (/\brules,?\s*\d{4}\b/.test(t)) return "rules";
  if (/\bact,?\s*\d{4}\b/.test(t)) return "act";
  if (/\bgazette\b/.test(t)) return "gazette_notification";
  if (/\bnotification\b/.test(t)) return "notification";
  if (/\bguidelines?\b/.test(t)) return "guidelines";
  if (/\bclarification\b/.test(t)) return "clarification";
  if (/\bcircular\b/.test(t)) return "circular";
  if (/\border\b/.test(t)) return "order";
  return "unknown";
}

/** Strips tracking/session parameters so the same page is recognised across crawls. */
export function canonicalUrl(raw: string, base?: string): string | null {
  try {
    const u = new URL(raw.trim(), base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|jsessionid|sessionid)/i.test(p)) u.searchParams.delete(p);
    }
    u.hostname = u.hostname.toLowerCase();
    return u.toString();
  } catch {
    return null;
  }
}

export function fileFormatFrom(buf: Buffer, contentType: string, url: string): "pdf" | "html" | "docx" | "doc" | "xlsx" | "txt" | "other" {
  const head = buf.subarray(0, 8);
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) return "doc";
  const ct = contentType.toLowerCase();
  const path = url.toLowerCase().split("?")[0]!;
  if (head[0] === 0x50 && head[1] === 0x4b) {
    if (ct.includes("spreadsheet") || path.endsWith(".xlsx")) return "xlsx";
    return "docx";
  }
  const start = buf.subarray(0, 512).toString("latin1").trimStart().toLowerCase();
  if (ct.includes("html") || start.startsWith("<!doctype html") || start.startsWith("<html") || /<(head|body)[\s>]/.test(start)) return "html";
  if (ct.includes("text/plain")) return "txt";
  return "other";
}
