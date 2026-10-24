import { ROUTE_TAGS, TOPIC_TAGS } from "@/ingest/classify";
import type { Sql } from "./db";

export const AUTHORITIES = [
  { code: "SEBI", short: "SEBI", name: "Securities and Exchange Board of India", website: "https://www.sebi.gov.in/", domains: ["sebi.gov.in"], order: 10,
    description: "Regulator for securities markets, including FPI and FVCI registration and operations." },
  { code: "RBI", short: "RBI", name: "Reserve Bank of India", website: "https://www.rbi.org.in/", domains: ["rbi.org.in"], order: 20,
    description: "Administers FEMA directions, reporting and foreign-exchange regulation." },
  { code: "DPIIT", short: "DPIIT", name: "Department for Promotion of Industry and Internal Trade", website: "https://www.dpiit.gov.in/", domains: ["dpiit.gov.in", "dipp.gov.in"], order: 30,
    description: "Owns India's FDI policy: consolidated policy and press notes." },
  { code: "IFSCA", short: "IFSCA", name: "International Financial Services Centres Authority", website: "https://ifsca.gov.in/", domains: ["ifsca.gov.in"], order: 40,
    description: "Unified regulator for International Financial Services Centres (GIFT IFSC)." },
  { code: "MOF", short: "MoF / DEA", name: "Ministry of Finance — Department of Economic Affairs", website: "https://dea.gov.in/", domains: ["dea.gov.in", "finmin.gov.in", "egazette.gov.in", "indiacode.nic.in"], order: 50,
    description: "Central Government rules under FEMA (including the Non-Debt Instruments Rules) and Gazette notifications." },
  { code: "ITD", short: "Income Tax / CBDT", name: "Income Tax Department — Central Board of Direct Taxes", website: "https://incometaxindia.gov.in/", domains: ["incometaxindia.gov.in", "incometax.gov.in"], order: 60,
    description: "Income-tax legislation, rules, notifications and circulars affecting foreign investors." },
  { code: "ED", short: "ED", name: "Directorate of Enforcement", website: "https://enforcementdirectorate.gov.in/", domains: ["enforcementdirectorate.gov.in"], order: 70,
    description: "Enforces FEMA and PMLA." },
  { code: "MCA", short: "MCA", name: "Ministry of Corporate Affairs", website: "https://www.mca.gov.in/", domains: ["mca.gov.in"], order: 80,
    description: "Company-law filings relevant to foreign-owned companies." },
  { code: "NSDL", short: "NSDL", name: "National Securities Depository Limited", website: "https://nsdl.co.in/", domains: ["nsdl.co.in"], order: 90,
    description: "Depository; publishes FPI monitoring and operational circulars." },
  { code: "CDSL", short: "CDSL", name: "Central Depository Services (India) Limited", website: "https://www.cdslindia.com/", domains: ["cdslindia.com"], order: 95,
    description: "Depository; operational circulars." },
  { code: "NSE", short: "NSE", name: "National Stock Exchange of India", website: "https://www.nseindia.com/", domains: ["nseindia.com"], order: 100,
    description: "Stock exchange circulars." },
  { code: "BSE", short: "BSE", name: "BSE Limited", website: "https://www.bseindia.com/", domains: ["bseindia.com"], order: 105,
    description: "Stock exchange circulars." },
] as const;

const SEBI_LEGAL_LINK = "^https?://(www\\.)?sebi\\.gov\\.in/legal/[a-z-]+/[a-z]{3}-\\d{4}/[^/?#]+_\\d+\\.html$";

function sebiListing(ssid: string, label: string) {
  return {
    listUrl: `https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=1&ssid=${ssid}&smid=0`,
    linkPattern: SEBI_LEGAL_LINK,
    form: { nextValue: "1", next: "n", search: "", fromDate: "", toDate: "", fromYear: "", toYear: "", deptId: "", sid: "1", ssid, smid: "0", ssidhidden: ssid, intmid: "-1", sText: "Legal", ssText: label, smText: "" },
    resolver: "sebi_detail",
  };
}

/**
 * Source registry. `enabled: false` marks sources whose endpoint could not be confirmed
 * while building; an administrator confirms the URL and enables them. Every source starts
 * `unverified` and becomes `verified` only after a successful crawl against the live site.
 */
export const SOURCES = [
  {
    code: "sebi.rss", authority: "SEBI", name: "SEBI RSS feed (press releases, circulars, orders)", connector: "rss", enabled: true, schedule: 60, recheck: 14,
    config: { feedUrl: "https://www.sebi.gov.in/sebirss.xml", resolver: "sebi_detail", downloadPolicy: "relevant_only" },
    coverage: "Recent items only (the feed carries the latest publications). Historical coverage comes from the listing sources.",
    note: "Feed URL published on SEBI's official RSS page (sebi.gov.in/rss.html).",
  },
  {
    code: "sebi.circulars", authority: "SEBI", name: "SEBI Legal › Circulars", connector: "sebi_listing", enabled: true, schedule: 360, recheck: 30,
    config: { ...sebiListing("7", "Circulars"), documentType: "circular", downloadPolicy: "relevant_only" },
    coverage: "Backfill pages through SEBI's AJAX listing; only FPI/FVCI/foreign-investment-relevant circulars are downloaded (others recorded as skipped).",
    note: "Listing parameters (sid/ssid) and AJAX pagination fields follow the public site's listing page; confirm on first live run.",
  },
  {
    code: "sebi.master_circulars", authority: "SEBI", name: "SEBI Legal › Master Circulars", connector: "sebi_listing", enabled: true, schedule: 720, recheck: 14,
    config: { ...sebiListing("6", "Master Circulars"), documentType: "master_circular", downloadPolicy: "relevant_only" },
    coverage: "All master circulars are listed; FPI/DDP/custody-relevant ones are downloaded.",
    note: "ssid for Master Circulars to be confirmed on first live run.",
  },
  {
    code: "sebi.regulations", authority: "SEBI", name: "SEBI Legal › Regulations", connector: "sebi_listing", enabled: true, schedule: 720, recheck: 14,
    config: { ...sebiListing("3", "Regulations"), documentType: "regulations", downloadPolicy: "relevant_only" },
    coverage: "Regulations and amendment regulations; FPI and FVCI regulations are prioritised by relevance screening.",
    note: "ssid for Regulations to be confirmed on first live run.",
  },
  {
    code: "rbi.notifications_rss", authority: "RBI", name: "RBI notifications feed", connector: "rss", enabled: true, schedule: 60, recheck: 30,
    config: { feedUrl: "https://www.rbi.org.in/notifications_rss.xml", resolver: "rbi_detail", downloadPolicy: "relevant_only" },
    coverage: "Recent notifications; FEMA/foreign-investment items are downloaded.",
    note: "Feed URL found via third-party feed directories, not yet confirmed on an official RBI page. RBI is migrating to a new website; confirm the feed still resolves.",
  },
  {
    code: "rbi.master_directions", authority: "RBI", name: "RBI Master Directions index", connector: "link_index", enabled: true, schedule: 720, recheck: 3,
    config: {
      pages: ["https://www.rbi.org.in/Scripts/BS_ViewMasterDirections.aspx"],
      linkPattern: "rbi\\.org\\.in/scripts/BS_ViewMasDirections\\.aspx\\?id=\\d+",
      resolver: "rbi_detail", documentType: "master_direction", downloadPolicy: "relevant_only",
    },
    coverage: "Master Directions are updated in place; the 3-day recheck captures each updated file as a new version.",
    note: "Detail URLs of the form BS_ViewMasDirections.aspx?id=N confirmed via search-engine copies of RBI pages.",
  },
  {
    code: "rbi.notification_id_scan", authority: "RBI", name: "RBI notifications — historical ID scan (backfill only)", connector: "rbi_id_scan", enabled: false, schedule: 1440, recheck: 60,
    config: { startId: 1, endId: 1, maxPerRun: 200, resolver: "rbi_detail", downloadPolicy: "relevant_only",
      titleInclude: "foreign|FEMA|A\\.\\s?P\\.\\s?\\(DIR|non-resident|overseas|remittance|portfolio|KYC|know your customer" },
    coverage: "Historical notifications by sequential page ID. Set startId/endId to the desired range before enabling.",
    note: "Disabled until an administrator sets a verified ID range.",
  },
  {
    code: "dpiit.fdi", authority: "DPIIT", name: "DPIIT FDI policy and press notes", connector: "link_index", enabled: true, schedule: 720, recheck: 14,
    config: {
      pages: ["https://www.dpiit.gov.in/policies-rules-and-acts/press-notes-fdi-circular"],
      linkPattern: "\\.pdf($|\\?)", resolver: "direct", assumeInScope: true, defaultRoutes: ["fdi"], downloadPolicy: "all",
    },
    coverage: "Press notes and consolidated FDI policy PDFs listed on the index page.",
    note: "Index URL not confirmed while building (site unreachable from the build environment). If the first crawl fails, update `pages` to the current press-notes page.",
  },
  {
    code: "ifsca.circulars", authority: "IFSCA", name: "IFSCA Legal › Circulars", connector: "link_index", enabled: true, schedule: 720, recheck: 14,
    config: {
      pages: ["https://www.ifsca.gov.in/Legal/Index/wF6kttc1JR8="],
      linkPattern: "ifsca\\.gov\\.in/Document/Legal/.+\\.pdf($|\\?)", resolver: "direct", documentType: "circular",
      assumeInScope: true, defaultRoutes: ["ifsc"], downloadPolicy: "all",
    },
    coverage: "Circulars listed on IFSCA's legal index page.",
    note: "Listing URL identified via search-engine copy of IFSCA's circulars page.",
  },
  {
    code: "ifsca.fund_management", authority: "IFSCA", name: "IFSCA Fund Management page", connector: "link_index", enabled: true, schedule: 1440, recheck: 14,
    config: {
      pages: ["https://www.ifsca.gov.in/Pages/Contents/Fund-management"],
      linkPattern: "ifsca\\.gov\\.in/Document/.+\\.pdf($|\\?)", resolver: "direct",
      assumeInScope: true, defaultRoutes: ["ifsc"], downloadPolicy: "all",
    },
    coverage: "Regulations, circulars and FAQs linked from the fund-management section.",
    note: "Page URL identified via search-engine copy of the IFSCA site.",
  },
  {
    code: "ifsca.regulations", authority: "IFSCA", name: "IFSCA Legal › Regulations", connector: "link_index", enabled: false, schedule: 1440, recheck: 14,
    config: { pages: ["https://www.ifsca.gov.in/"], linkPattern: "ifsca\\.gov\\.in/Document/Legal/.+\\.pdf($|\\?)", resolver: "direct", assumeInScope: true, defaultRoutes: ["ifsc"], downloadPolicy: "all" },
    coverage: "Not yet configured.",
    note: "Needs the Legal/Index/<token> URL for the Regulations category (visible in IFSCA site navigation).",
  },
  {
    code: "mof.fema_rules", authority: "MOF", name: "DEA — FEMA rules and notifications", connector: "link_index", enabled: false, schedule: 1440, recheck: 30,
    config: { pages: ["https://dea.gov.in/"], linkPattern: "\\.pdf($|\\?)", resolver: "direct", downloadPolicy: "relevant_only", defaultRoutes: ["fema"] },
    coverage: "Not yet configured.",
    note: "Needs the DEA page listing FEMA (Non-Debt Instruments) Rules and amendments.",
  },
  {
    code: "itd.notifications", authority: "ITD", name: "Income Tax Department — notifications", connector: "link_index", enabled: false, schedule: 1440, recheck: 30,
    config: { pages: ["https://incometaxindia.gov.in/Pages/communications/notifications.aspx"], linkPattern: "\\.pdf($|\\?)", resolver: "direct", downloadPolicy: "relevant_only" },
    coverage: "Not yet configured.",
    note: "The notifications listing is rendered client-side; requires a dedicated connector or a confirmed static index.",
  },
] as const;

export const COVERAGE_TARGETS = [
  { authority: "SEBI", title: "SEBI (Foreign Portfolio Investors) Regulations, 2019", type: "regulations", pattern: "foreign portfolio investors\\)?\\s*regulations,?\\s*2019" },
  { authority: "SEBI", title: "SEBI (Foreign Venture Capital Investors) Regulations, 2000", type: "regulations", pattern: "foreign venture capital investors\\)?\\s*regulations,?\\s*2000" },
  { authority: "SEBI", title: "Master Circular for Foreign Portfolio Investors, Designated Depository Participants and Eligible Foreign Investors", type: "master_circular", pattern: "master circular.*foreign portfolio investors" },
  { authority: "RBI", title: "Master Direction – Foreign Investment in India", type: "master_direction", pattern: "master direction.*foreign investment in india" },
  { authority: "RBI", title: "Master Direction – Reporting under Foreign Exchange Management Act, 1999", type: "master_direction", pattern: "master direction.*reporting under foreign exchange management act" },
  { authority: "RBI", title: "Master Direction – Know Your Customer (KYC) Direction", type: "master_direction", pattern: "master direction.*know your customer" },
  { authority: "DPIIT", title: "Consolidated FDI Policy", type: "policy", pattern: "consolidated fdi policy" },
  { authority: "IFSCA", title: "IFSCA (Fund Management) Regulations, 2025", type: "regulations", pattern: "fund management\\)?\\s*regulations,?\\s*2025" },
  { authority: "IFSCA", title: "International Financial Services Centres Authority Act, 2019", type: "act", pattern: "international financial services centres authority act,?\\s*2019" },
  { authority: "MOF", title: "Foreign Exchange Management Act, 1999", type: "act", pattern: "^(the )?foreign exchange management act,?\\s*1999" },
  { authority: "MOF", title: "Foreign Exchange Management (Non-debt Instruments) Rules, 2019", type: "rules", pattern: "non[- ]debt instruments\\)?\\s*rules,?\\s*2019" },
  { authority: "ITD", title: "Income-tax Act, 1961", type: "act", pattern: "income[- ]tax act,?\\s*1961" },
  { authority: "ITD", title: "Income-tax Act, 2025", type: "act", pattern: "income[- ]tax act,?\\s*2025" },
  { authority: "ITD", title: "Income-tax Rules, 1962", type: "rules", pattern: "income[- ]tax rules,?\\s*1962" },
] as const;

/** Idempotent. Existing sources are not overwritten so admin edits survive re-seeding. */
export async function seed(sql: Sql, opts: { sources?: boolean } = {}) {
  for (const a of AUTHORITIES) {
    await sql`
      INSERT INTO authorities (code, name, short_name, website, description, allowed_domains, display_order)
      VALUES (${a.code}, ${a.name}, ${a.short}, ${a.website}, ${a.description}, ${[...a.domains]}, ${a.order})
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, short_name = EXCLUDED.short_name, website = EXCLUDED.website,
        description = EXCLUDED.description, allowed_domains = EXCLUDED.allowed_domains, display_order = EXCLUDED.display_order`;
  }
  let order = 0;
  for (const t of ROUTE_TAGS) {
    await sql`INSERT INTO tags (code, kind, label, description, display_order) VALUES (${t.code}, 'route', ${t.label}, ${t.description}, ${order++})
              ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description, display_order = EXCLUDED.display_order`;
  }
  for (const t of TOPIC_TAGS) {
    await sql`INSERT INTO tags (code, kind, label, display_order) VALUES (${t.code}, 'topic', ${t.label}, ${order++})
              ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, display_order = EXCLUDED.display_order`;
  }
  if (opts.sources !== false) {
    for (const s of SOURCES) {
      await sql`
        INSERT INTO sources (code, authority_id, name, connector, config, enabled, schedule_minutes, recheck_days, verification_note, coverage_note)
        VALUES (${s.code}, (SELECT id FROM authorities WHERE code = ${s.authority}), ${s.name}, ${s.connector},
                ${sql.json(s.config as never)}, ${s.enabled}, ${s.schedule}, ${s.recheck}, ${s.note}, ${s.coverage})
        ON CONFLICT (code) DO NOTHING`;
    }
  }
  for (const t of COVERAGE_TARGETS) {
    await sql`INSERT INTO coverage_targets (authority_code, title, document_type, title_pattern)
              VALUES (${t.authority}, ${t.title}, ${t.type}, ${t.pattern})
              ON CONFLICT (title) DO UPDATE SET title_pattern = EXCLUDED.title_pattern, document_type = EXCLUDED.document_type`;
  }
}
