// Deterministic, explainable classification. Every tag records the terms that triggered it.
// Scores: a title hit counts 3, each distinct body hit counts 1 (capped per pattern).

export type Relevance = "in_scope" | "uncertain" | "out_of_scope";

interface TagRule {
  code: string;
  kind: "route" | "topic";
  patterns: RegExp[];
  threshold: number;
}

export const ROUTE_TAGS = [
  { code: "fpi", label: "FPI", description: "Foreign Portfolio Investment" },
  { code: "fdi", label: "FDI", description: "Foreign Direct Investment" },
  { code: "fvci", label: "FVCI", description: "Foreign Venture Capital Investment" },
  { code: "fema", label: "FEMA / common framework", description: "Foreign Exchange Management Act and common foreign-investment framework" },
  { code: "ifsc", label: "IFSC / GIFT City", description: "International Financial Services Centres" },
  { code: "taxation", label: "Taxation", description: "Taxation of foreign investors" },
  { code: "general", label: "General / cross-cutting", description: "Applies across investment routes" },
] as const;

export const TOPIC_TAGS = [
  { code: "registration", label: "Registration and eligibility" },
  { code: "categorization", label: "Investor categorization" },
  { code: "beneficial_ownership", label: "Beneficial ownership" },
  { code: "control_ownership", label: "Control and ownership" },
  { code: "kyc_aml", label: "KYC and AML" },
  { code: "onboarding", label: "Onboarding" },
  { code: "custody", label: "Custody" },
  { code: "investment_limits", label: "Investment limits" },
  { code: "sectoral_caps", label: "Sectoral caps" },
  { code: "entry_routes", label: "Entry routes" },
  { code: "reporting", label: "Reporting" },
  { code: "disclosure", label: "Disclosure" },
  { code: "pricing", label: "Pricing" },
  { code: "remittances", label: "Remittances" },
  { code: "tax_matters", label: "Taxation" },
  { code: "compliance", label: "Compliance" },
  { code: "enforcement", label: "Enforcement" },
  { code: "fund_management", label: "Fund management" },
] as const;

const r = (s: string) => new RegExp(s, "gi");

const RULES: TagRule[] = [
  { code: "fpi", kind: "route", threshold: 3, patterns: [r("\\bforeign portfolio invest(?:or|ors|ment)s?\\b"), r("\\bFPIs?\\b"), r("\\bforeign institutional investors?\\b"), r("\\bFIIs?\\b"), r("\\bdesignated depository participants?\\b"), r("\\bDDPs?\\b"), r("\\boffshore derivative instruments?\\b"), r("\\bODIs?\\b"), r("\\bportfolio investment scheme\\b")] },
  { code: "fdi", kind: "route", threshold: 3, patterns: [r("\\bforeign direct investment\\b"), r("\\bFDI\\b"), r("\\bpress note\\b.{0,40}\\bseries\\b"), r("\\bsectoral (?:cap|limit)s?\\b"), r("\\b(?:automatic|government|approval) route\\b"), r("\\bdownstream investment\\b"), r("\\bFC-GPR\\b"), r("\\bFC-TRS\\b"), r("\\bsingle master form\\b"), r("\\bForeign Investment Facilitation Portal\\b")] },
  { code: "fvci", kind: "route", threshold: 3, patterns: [r("\\bforeign venture capital invest(?:or|ors|ment)s?\\b"), r("\\bFVCIs?\\b")] },
  { code: "fema", kind: "route", threshold: 3, patterns: [r("\\bforeign exchange management\\b"), r("\\bFEMA\\b"), r("\\bnon[- ]debt instruments?\\b"), r("\\bauthori[sz]ed dealer\\b"), r("\\bAD Category[- ]I\\b"), r("\\bA\\.\\s?P\\.\\s?\\(DIR Series\\)"), r("\\bpersons? resident outside India\\b"), r("\\boverseas investment\\b"), r("\\bexternal commercial borrowings?\\b"), r("\\bliberali[sz]ed remittance scheme\\b"), r("\\bnon[- ]resident\\b")] },
  { code: "ifsc", kind: "route", threshold: 3, patterns: [r("\\bIFSCA?\\b"), r("\\binternational financial services cent(?:re|er)s?\\b"), r("\\bGIFT[- ]?(?:City|IFSC)\\b"), r("\\bfund management entit(?:y|ies)\\b"), r("\\bFMEs?\\b")] },
  { code: "taxation", kind: "route", threshold: 3, patterns: [r("\\bincome[- ]tax\\b"), r("\\b115AD\\b"), r("\\bwithholding tax\\b"), r("\\btax deducted at source\\b"), r("\\bcapital gains?\\b"), r("\\bdouble taxation avoidance\\b"), r("\\bDTAA\\b"), r("\\btax treat(?:y|ies)\\b"), r("\\bCBDT\\b"), r("\\bCentral Board of Direct Taxes\\b"), r("\\bsecurities transaction tax\\b")] },

  { code: "registration", kind: "topic", threshold: 2, patterns: [r("\\bregistration\\b"), r("\\beligibility\\b"), r("\\bcertificate of registration\\b"), r("\\bgrant of (?:registration|licen[cs]e)\\b"), r("\\blicen[cs]ing\\b")] },
  { code: "categorization", kind: "topic", threshold: 2, patterns: [r("\\bcategory (?:I|II|III)\\b"), r("\\bcategori[sz]ation\\b"), r("\\breclassif")] },
  { code: "beneficial_ownership", kind: "topic", threshold: 2, patterns: [r("\\bbeneficial own(?:er|ers|ership)\\b"), r("\\bsignificant beneficial\\b"), r("\\bultimate beneficial\\b"), r("\\bgranular (?:data|details)\\b")] },
  { code: "control_ownership", kind: "topic", threshold: 2, patterns: [r("\\bownership and control\\b"), r("\\bowned (?:and|or) controlled\\b"), r("\\btransfer of (?:ownership|control)\\b"), r("\\bcontrol of (?:an )?Indian compan")] },
  { code: "kyc_aml", kind: "topic", threshold: 2, patterns: [r("\\bKYC\\b"), r("\\bknow your (?:customer|client)\\b"), r("\\banti[- ]money laundering\\b"), r("\\bAML\\b"), r("\\bPMLA?\\b"), r("\\bmoney[- ]laundering\\b"), r("\\bCKYC")] },
  { code: "onboarding", kind: "topic", threshold: 2, patterns: [r("\\bonboarding\\b"), r("\\baccount opening\\b"), r("\\bcommon application form\\b")] },
  { code: "custody", kind: "topic", threshold: 2, patterns: [r("\\bcustodians?\\b"), r("\\bcustody\\b"), r("\\bcustodial\\b"), r("\\bsafekeeping\\b")] },
  { code: "investment_limits", kind: "topic", threshold: 2, patterns: [r("\\binvestment limits?\\b"), r("\\baggregate limit\\b"), r("\\binvestment ceiling\\b"), r("\\bconcentration limit")] },
  { code: "sectoral_caps", kind: "topic", threshold: 2, patterns: [r("\\bsectoral (?:cap|limit)s?\\b"), r("\\bsector[- ]specific conditions\\b")] },
  { code: "entry_routes", kind: "topic", threshold: 2, patterns: [r("\\b(?:automatic|government|approval) route\\b"), r("\\bprior (?:government )?approval\\b"), r("\\bland border\\b")] },
  { code: "reporting", kind: "topic", threshold: 2, patterns: [r("\\breporting\\b"), r("\\bFC-GPR\\b"), r("\\bFC-TRS\\b"), r("\\bannual return\\b"), r("\\bFLA return\\b"), r("\\bsubmission of (?:data|information)\\b")] },
  { code: "disclosure", kind: "topic", threshold: 2, patterns: [r("\\bdisclos(?:e|ure|ures)\\b")] },
  { code: "pricing", kind: "topic", threshold: 2, patterns: [r("\\bpricing guidelines?\\b"), r("\\bfair (?:market )?value\\b"), r("\\bvaluation\\b")] },
  { code: "remittances", kind: "topic", threshold: 2, patterns: [r("\\bremittances?\\b"), r("\\brepatriat"), r("\\binward\\b"), r("\\boutward\\b")] },
  { code: "tax_matters", kind: "topic", threshold: 2, patterns: [r("\\bincome[- ]tax\\b"), r("\\bcapital gains?\\b"), r("\\bwithholding\\b"), r("\\btax treat")] },
  { code: "compliance", kind: "topic", threshold: 2, patterns: [r("\\bcompliance\\b"), r("\\bcontravention\\b"), r("\\bcompounding\\b")] },
  { code: "enforcement", kind: "topic", threshold: 3, patterns: [r("\\badjudicat"), r("\\bshow cause notice\\b"), r("\\bpenalt(?:y|ies)\\b"), r("\\benforcement\\b")] },
  { code: "fund_management", kind: "topic", threshold: 2, patterns: [r("\\bfund management\\b"), r("\\balternative investment funds?\\b"), r("\\bAIFs?\\b"), r("\\bretail schemes?\\b"), r("\\bventure capital schemes?\\b"), r("\\bfund of funds\\b")] },
];

export interface TagHit {
  code: string;
  kind: "route" | "topic";
  score: number;
  terms: string[];
}

export interface Classification {
  tags: TagHit[];
  relevance: Relevance;
  reasons: string[];
}

function score(rule: TagRule, title: string, body: string): TagHit | null {
  let s = 0;
  const terms = new Set<string>();
  for (const p of rule.patterns) {
    p.lastIndex = 0;
    const tm = title.match(p);
    if (tm) {
      s += 3;
      terms.add(tm[0].trim());
    }
    p.lastIndex = 0;
    const bm = body.match(p);
    if (bm) {
      s += Math.min(3, bm.length > 5 ? 3 : bm.length > 1 ? 2 : 1);
      terms.add(bm[0].trim());
    }
  }
  if (s < rule.threshold) return null;
  return { code: rule.code, kind: rule.kind, score: s, terms: [...terms].slice(0, 8) };
}

/**
 * Classifies a document. `assumeInScope` is set for sources that only publish in-scope
 * material (e.g. an FDI press-note index), so relevance cannot fall to out_of_scope there.
 */
export function classify(input: { title: string; text?: string | null; assumeInScope?: boolean; defaultRoutes?: string[] }): Classification {
  const title = input.title ?? "";
  // Bodies of master circulars can be huge; the first ~300k chars carry the scope.
  const body = (input.text ?? "").slice(0, 300_000);
  const tags: TagHit[] = [];
  for (const rule of RULES) {
    const hit = score(rule, title, body);
    if (hit) tags.push(hit);
  }
  for (const code of input.defaultRoutes ?? []) {
    if (!tags.some((t) => t.code === code)) tags.push({ code, kind: "route", score: 0, terms: ["source default"] });
  }
  const routes = tags.filter((t) => t.kind === "route");
  const strongRoute = routes.some((t) => t.score >= 4 || (t.score >= 3 && t.terms.length >= 2));
  const titleRoute = routes.some((t) => t.score >= 3 && RULES.find((r) => r.code === t.code)!.patterns.some((p) => { p.lastIndex = 0; return p.test(title); }));
  const scopeTopic = tags.some((t) => ["kyc_aml", "custody", "onboarding", "beneficial_ownership"].includes(t.code));
  const reasons: string[] = [];
  let relevance: Relevance;
  if (input.assumeInScope) {
    relevance = "in_scope";
    reasons.push("source configured as in scope");
  } else if (titleRoute || strongRoute) {
    relevance = "in_scope";
    reasons.push(`matched routes: ${routes.map((t) => t.code).join(", ")}`);
  } else if (routes.length || scopeTopic) {
    relevance = "uncertain";
    reasons.push("weak route/topic signals only");
  } else {
    relevance = "out_of_scope";
    reasons.push("no foreign-investment signals");
  }
  return { tags, relevance, reasons };
}

/** Title-only pre-screen used to decide whether a document is worth downloading. */
export function prescreen(title: string, assumeInScope?: boolean): Relevance {
  return classify({ title, assumeInScope }).relevance === "out_of_scope" ? "out_of_scope" : "uncertain";
}
