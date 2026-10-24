// Detects explicit citations of other regulatory instruments inside a document's text,
// and derives the identifiers a document itself is known by. Relationship *types* are
// inferred only from wording in the immediate context of an explicit citation, and are
// stored as "proposed" until a reviewer confirms them.

import { normalizeDocNumber } from "./normalize";

export type RelType = "amends" | "supersedes" | "withdraws" | "corrects" | "consolidates" | "related_to";

export interface FoundReference {
  kind: string;
  norm: string;
  text: string;
  relType: RelType;
  context: string;
}

interface Pattern {
  kind: string;
  re: RegExp;
  norm: (m: RegExpExecArray) => string | null;
}

const squash = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Regulation/Rules/Act names: "SEBI (Foreign Portfolio Investors) Regulations, 2019" → REG:SEBI:FOREIGNPORTFOLIOINVESTORS:2019 */
function instrumentKey(issuer: string, subject: string, kind: string, year: string): string {
  return `${kind.toUpperCase()}:${issuer}:${squash(subject.replace(/\bamendment\b/gi, ""))}:${year}`;
}

const PATTERNS: Pattern[] = [
  {
    kind: "sebi_circular",
    re: /\bSEBI\/HO\/[A-Z0-9&().\-\/ ]{2,90}?\/(?:19|20)\d{2}\/\d{1,4}\b/gi,
    norm: (m) => normalizeDocNumber(m[0]),
  },
  {
    // Older SEBI style: CIR/IMD/FPIC/1/2014, IMD/FPIC/CIR/P/2016/123
    kind: "sebi_circular_legacy",
    re: /\b(?:CIR|IMD|MRD|MIRSD|SEBI)\/[A-Z0-9&\-]{2,20}(?:\/[A-Z0-9&\-]{1,20}){0,5}\/\d{1,4}\/(?:19|20)\d{2}\b/g,
    norm: (m) => normalizeDocNumber(m[0]),
  },
  { kind: "rbi_ref", re: /\bRBI\/(?:19|20)\d{2}-\d{2,4}\/\d{1,4}\b/gi, norm: (m) => normalizeDocNumber(m[0]) },
  {
    kind: "ap_dir_circular",
    re: /\bA\.\s*P\.\s*\(\s*DIR\s+Series\s*\)\s*Circular\s+No\.?\s*(\d{1,3})\b(?:\s*dated\s*(?:[A-Za-z]+\s+\d{1,2},?\s*((?:19|20)\d{2})|\d{1,2}[\/.\-]\d{1,2}[\/.\-]((?:19|20)\d{2})))?/gi,
    // Numbering restarts every financial year, so a citation without a date is ambiguous;
    // the date-less key will only resolve when exactly one collected document carries it.
    norm: (m) => `APDIR/${m[1]}${m[2] || m[3] ? "/" + (m[2] || m[3]) : ""}`,
  },
  {
    kind: "fema_notification",
    re: /\bFEMA\s*\.?\s*(\d{1,4})\s*(\(\s*R\s*\))?\s*(?:\(\s*\d+\s*\))?\s*\/\s*((?:19|20)\d{2})\s*-\s*RB\b/gi,
    norm: (m) => `FEMA${m[1]}${m[2] ? "(R)" : ""}/${m[3]}-RB`,
  },
  {
    kind: "fed_master_direction",
    re: /\b(?:FED\s+)?Master\s+Direction\s+No\.?\s*(\d{1,3})\s*\/\s*((?:19|20)\d{2}-\d{2})\b/gi,
    norm: (m) => `FEDMD${m[1]}/${m[2]}`,
  },
  {
    kind: "press_note",
    re: /\bPress\s+Note\s+No\.?\s*(\d{1,2})\s*\(\s*((?:19|20)\d{2})\s+Series\s*\)/gi,
    norm: (m) => `PN${m[1]}/${m[2]}`,
  },
  { kind: "gsr", re: /\bG\.?\s*S\.?\s*R\.?\s*(\d{1,4})\s*\(\s*E\s*\)/gi, norm: (m) => `GSR${m[1]}(E)` },
  { kind: "so", re: /\bS\.\s*O\.?\s*(\d{1,4})\s*\(\s*E\s*\)/gi, norm: (m) => `SO${m[1]}(E)` },
  {
    kind: "sebi_regulations",
    re: /\b(?:Securities\s+and\s+Exchange\s+Board\s+of\s+India|SEBI)\s*\(\s*([A-Za-z ,&\-]{4,120}?)\s*\)\s*(Regulations|Rules),?\s*((?:19|20)\d{2})\b/gi,
    norm: (m) => instrumentKey("SEBI", m[1]!, m[2]!, m[3]!),
  },
  {
    kind: "ifsca_regulations",
    re: /\b(?:International\s+Financial\s+Services\s+Centres\s+Authority|IFSCA)\s*\(\s*([A-Za-z ,&\-]{4,120}?)\s*\)\s*Regulations,?\s*((?:19|20)\d{2})\b/gi,
    norm: (m) => instrumentKey("IFSCA", m[1]!, "Regulations", m[2]!),
  },
  {
    kind: "fema_rules",
    re: /\bForeign\s+Exchange\s+Management\s*\(\s*([A-Za-z ,&\-]{4,120}?)\s*\)\s*(Rules|Regulations),?\s*((?:19|20)\d{2})\b/gi,
    norm: (m) => instrumentKey("FEMA", m[1]!, m[2]!, m[3]!),
  },
  { kind: "act", re: /\bForeign\s+Exchange\s+Management\s+Act,?\s*1999\b/gi, norm: () => "ACT:FEMA:1999" },
  { kind: "act", re: /\bIncome[- ]tax\s+Act,?\s*(1961|2025)\b/gi, norm: (m) => `ACT:INCOMETAX:${m[1]}` },
  { kind: "act", re: /\bSecurities\s+and\s+Exchange\s+Board\s+of\s+India\s+Act,?\s*1992\b/gi, norm: () => "ACT:SEBI:1992" },
  { kind: "act", re: /\bInternational\s+Financial\s+Services\s+Centres\s+Authority\s+Act,?\s*2019\b/gi, norm: () => "ACT:IFSCA:2019" },
  { kind: "act", re: /\bPrevention\s+of\s+Money[- ]Laundering\s+Act,?\s*2002\b/gi, norm: () => "ACT:PMLA:2002" },
];

const REL_CUES: { rel: RelType; re: RegExp }[] = [
  { rel: "withdraws", re: /\b(stand[s]?\s+withdrawn|hereby\s+withdrawn?|is\s+withdrawn|are\s+withdrawn|rescind(ed|s)?|stand[s]?\s+rescinded|repeal(ed|s)?)\b/i },
  { rel: "supersedes", re: /\b(in\s+supersession\s+of|supersed(e|es|ed|ing)|stand[s]?\s+superseded)\b/i },
  { rel: "corrects", re: /\b(corrigendum|erratum|correction\s+(to|in))\b/i },
  { rel: "amends", re: /\b(amend(s|ed|ing|ment)?|in\s+partial\s+modification|stand[s]?\s+modified|(is|are|shall\s+be)\s+substituted)\b/i },
];

/**
 * Infers the relationship from wording in a short window *before* the citation
 * ("In partial modification of circular X") and a shorter one after it ("X stands withdrawn").
 */
// A sentence boundary: ". " or "; " followed by a capital/opening bracket (so "No. 5" or "Jan. 1" do not split).
const SENTENCE_END = /[.;]\s+(?=[A-Z(])/g;

function relationFromContext(before: string, after: string): RelType {
  // Only wording in the same sentence as the citation counts.
  const parts = before.slice(-200).split(SENTENCE_END);
  const sameBefore = parts[parts.length - 1] ?? "";
  const sameAfter = after.slice(0, 100).split(SENTENCE_END)[0] ?? "";
  const window = sameBefore.slice(-160) + " " + sameAfter;
  for (const cue of REL_CUES) if (cue.re.test(window)) return cue.rel;
  return "related_to";
}

export function findReferences(text: string, selfIdentifiers: string[] = []): FoundReference[] {
  const self = new Set(selfIdentifiers);
  const out = new Map<string, FoundReference>();
  const flat = text.replace(/\s+/g, " ");
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(flat))) {
      const norm = p.norm(m);
      if (!norm || self.has(norm)) continue;
      const start = m.index;
      const end = start + m[0].length;
      const before = flat.slice(Math.max(0, start - 200), start);
      const after = flat.slice(end, end + 120);
      const relType = relationFromContext(before, after);
      const key = `${norm}|${relType}`;
      if (!out.has(key)) {
        out.set(key, {
          kind: p.kind,
          norm,
          text: m[0].trim(),
          relType,
          context: (before.slice(-140) + m[0] + after.slice(0, 80)).trim(),
        });
      }
    }
  }
  // When the same instrument is cited both neutrally and with a typed cue, keep only the typed one.
  const typed = new Set([...out.values()].filter((r) => r.relType !== "related_to").map((r) => r.norm));
  return [...out.values()].filter((r) => r.relType !== "related_to" || !typed.has(r.norm));
}

/** Identifiers a document is itself known by, derived from its number and title. */
const HEADER_KINDS = new Set(["sebi_circular", "sebi_circular_legacy", "rbi_ref", "ap_dir_circular", "fema_notification", "fed_master_direction", "press_note"]);

/**
 * Identifiers a document is itself known by: its number, citation keys in its title, and
 * issuance numbers printed in its header (the first lines, before any body text cites others).
 * Header numbers are only taken when not preceded by citation wording ("in modification of …").
 */
export function deriveIdentifiers(input: { documentNumber?: string | null; title: string; headerText?: string; publicationYear?: number | null }): { norm: string; kind: string }[] {
  const ids = new Map<string, string>();
  const num = normalizeDocNumber(input.documentNumber);
  if (num) ids.set(num, "document_number");
  for (const p of PATTERNS) {
    // Only parse citation keys from the title itself (a document's own name), plus the document number.
    for (const src of [input.title, input.documentNumber ?? ""]) {
      p.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = p.re.exec(src.replace(/\s+/g, " ")))) {
        const n = p.norm(m);
        if (n) ids.set(n, p.kind);
      }
    }
  }
  if (input.headerText) {
    const head = input.headerText.replace(/\s+/g, " ");
    for (const p of PATTERNS) {
      if (!HEADER_KINDS.has(p.kind)) continue;
      p.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = p.re.exec(head))) {
        const before = head.slice(Math.max(0, m.index - 120), m.index);
        if (/\b(of|to|under|vide|with|see|in terms of|refer)\s*(the\s+)?(circular|notification|direction)?\s*(no\.?)?\s*$/i.test(before)) continue;
        if (relationFromContext(before, "") !== "related_to") continue;
        const n = p.norm(m);
        if (n) ids.set(n, p.kind);
      }
    }
  }
  // A dated A.P. (DIR Series) circular is also citable by number+year.
  if (input.publicationYear) {
    for (const [n, kind] of [...ids]) {
      if (kind === "ap_dir_circular" && /^APDIR\/\d+$/.test(n)) ids.set(`${n}/${input.publicationYear}`, kind);
    }
  }
  return [...ids].map(([norm, kind]) => ({ norm, kind }));
}
