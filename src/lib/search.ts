// Query-side helpers for full-text search: abbreviation/synonym expansion and
// British/American spelling variants, so "categorisation" finds "categorization"
// and "FPI" finds "foreign portfolio investor".

const SYNONYMS: Record<string, string[]> = {
  fpi: ["foreign portfolio investor"],
  fpis: ["foreign portfolio investors"],
  fii: ["foreign institutional investor"],
  fdi: ["foreign direct investment"],
  fvci: ["foreign venture capital investor"],
  ddp: ["designated depository participant"],
  ddps: ["designated depository participants"],
  odi: ["offshore derivative instrument"],
  odis: ["offshore derivative instruments"],
  kyc: ["know your customer", "know your client"],
  aml: ["anti money laundering"],
  pmla: ["prevention of money laundering"],
  fema: ["foreign exchange management"],
  ndi: ["non-debt instruments"],
  ifsc: ["international financial services centre"],
  ifsca: ["international financial services centres authority"],
  gift: ["gift city", "gift ifsc"],
  fme: ["fund management entity"],
  aif: ["alternative investment fund"],
  dtaa: ["double taxation avoidance agreement"],
  ecb: ["external commercial borrowing"],
  lrs: ["liberalised remittance scheme"],
  cbdt: ["central board of direct taxes"],
  dpiit: ["department for promotion of industry and internal trade", "dipp"],
  "master direction": ["md"],
};

const SPELLING: [RegExp, string][] = [
  [/is(e|ed|es|ing|ation|ations)\b/g, "iz$1"],
  [/iz(e|ed|es|ing|ation|ations)\b/g, "is$1"],
  [/centre\b/g, "center"],
  [/center\b/g, "centre"],
  [/licence\b/g, "license"],
  [/license\b/g, "licence"],
];

/** Returns the original query plus alternative phrasings to OR together. */
export function expandQuery(q: string): string[] {
  const base = q.trim().replace(/\s+/g, " ").slice(0, 200);
  if (!base) return [];
  const out = new Set<string>([base]);
  const lower = base.toLowerCase();
  for (const [abbr, alts] of Object.entries(SYNONYMS)) {
    const re = new RegExp(`\\b${abbr}\\b`, "i");
    if (re.test(lower)) for (const alt of alts) out.add(lower.replace(re, alt));
    for (const alt of alts) {
      if (lower.includes(alt)) out.add(lower.replace(alt, abbr));
    }
  }
  for (const [re, rep] of SPELLING) {
    const v = lower.replace(re, rep);
    if (v !== lower) out.add(v);
  }
  return [...out].slice(0, 8);
}

/** True when the query looks like a document number (circular number, notification number). */
export function looksLikeDocNumber(q: string): boolean {
  const s = q.trim();
  return /[A-Za-z]+\/[A-Za-z0-9]/.test(s) || /\b(G\.?S\.?R|S\.O|FEMA)\b/i.test(s) || /\bNo\.?\s*\d+/i.test(s) || /\d{4}-\d{2}\/\d+/.test(s);
}
