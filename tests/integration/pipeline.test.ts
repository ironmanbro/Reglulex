import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addSource, makeDeps, resetDb } from "../helpers/harness";
import { closeDb, db } from "../../src/lib/db";
import { storage } from "../../src/lib/storage";
import { processEntry, runCrawl } from "../../src/ingest/pipeline";
import { FixtureNet, indexHtml, scannedPdf, sebiDetailHtml, sebiListingHtml, textPdf } from "../helpers/fixtures";

const sql = db();
const LIST = "https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=1&ssid=7&smid=0";
const AJAX = "https://www.sebi.gov.in/sebiweb/ajax/home/getnewslistinfo.jsp";
const D1 = "https://www.sebi.gov.in/legal/circulars/jan-2099/framework-for-foreign-portfolio-investors-test_90001.html";
const D2 = "https://www.sebi.gov.in/legal/circulars/feb-2099/amendment-to-fpi-test-circular_90002.html";
const D3 = "https://www.sebi.gov.in/legal/circulars/mar-2099/mutual-fund-expense-ratio-test_90003.html";
const P1 = "https://www.sebi.gov.in/sebi_data/attachdocs/jan-2099/90001.pdf";
const P2 = "https://www.sebi.gov.in/sebi_data/attachdocs/feb-2099/90002.pdf";

const CIRC1 = "SEBI/HO/TEST/P/CIR/2099/1";

async function pdf1() {
  return textPdf([
    "CIRCULAR",
    CIRC1,
    "January 05, 2099",
    "To All Foreign Portfolio Investors (FPIs) and Designated Depository Participants (DDPs)",
    "Subject: Framework for Foreign Portfolio Investors - test fixture",
    "1. This synthetic test circular concerns registration of foreign portfolio investors.",
    "2. Custodians shall complete KYC of FPIs as per the test framework.",
    "3. KYC documents shall be retained by the custodian; registration shall be renewed annually.",
  ]);
}
async function pdf2() {
  return textPdf([
    "CIRCULAR",
    "SEBI/HO/TEST/P/CIR/2099/2",
    "February 10, 2099",
    "To All Foreign Portfolio Investors and Custodians",
    "Subject: Amendment to FPI test circular",
    `1. In partial modification of circular ${CIRC1} dated January 05, 2099, paragraph 2 is amended.`,
    "2. Designated Depository Participants shall report the change to SEBI.",
  ]);
}

async function standardNet() {
  const net = new FixtureNet();
  net.set(LIST, {
    body: sebiListingHtml([
      { date: "Feb 10, 2099", title: "Amendment to FPI test circular", href: D2 },
      { date: "Jan 05, 2099", title: "Framework for Foreign Portfolio Investors (test)", href: D1 },
    ]),
  });
  // Page 2 via AJAX POST
  net.set(AJAX, (init) => {
    const page = new URLSearchParams(init.body).get("doDirect");
    if (page === "1") return { body: sebiListingHtml([{ date: "Mar 01, 2099", title: "Mutual fund expense ratio (test)", href: D3 }]) };
    return { body: sebiListingHtml([]) };
  });
  net.set(D1, { body: sebiDetailHtml("Framework for Foreign Portfolio Investors (test)", "Jan 05, 2099", P1) });
  net.set(D2, { body: sebiDetailHtml("Amendment to FPI test circular", "Feb 10, 2099", P2) });
  net.set(D3, { body: sebiDetailHtml("Mutual fund expense ratio (test)", "Mar 01, 2099", "https://www.sebi.gov.in/sebi_data/attachdocs/mar-2099/90003.pdf") });
  net.set(P1, { body: await pdf1(), contentType: "application/pdf", headers: { etag: '"v1"' } });
  net.set(P2, { body: await pdf2(), contentType: "application/pdf" });
  return net;
}

const sebiConfig = {
  listUrl: LIST,
  form: { sid: "1", ssid: "7", smid: "0" },
  resolver: "sebi_detail",
  documentType: "circular",
  downloadPolicy: "relevant_only",
  linkPattern: "^https?://(www\\.)?sebi\\.gov\\.in/legal/[a-z-]+/[a-z]{3}-\\d{4}/[^/?#]+_\\d+\\.html$",
};

beforeEach(async () => {
  await resetDb(sql);
});
afterAll(async () => {
  await closeDb();
});

describe("end-to-end ingestion", () => {
  it("discovers, paginates, downloads, stores, extracts, classifies, indexes and links", async () => {
    const net = await standardNet();
    const deps = makeDeps(net);
    const sourceId = await addSource(sql, "test.sebi", "SEBI", "sebi_listing", sebiConfig);

    const res = await runCrawl(deps, sourceId, "backfill", "test");
    expect(res.status).toBe("success_new");
    expect(res.newEntries).toBe(3);
    // Page 2 fetched by POST with the configured page field.
    expect(net.requests.some((r) => r.method === "POST" && r.url === AJAX && r.body?.includes("doDirect=1"))).toBe(true);

    const entries = await sql`SELECT entry_key, state, document_id FROM source_entries ORDER BY id`;
    expect(entries.map((e) => e.state).sort()).toEqual(["processed", "processed", "skipped_out_of_scope"]);

    const docs = await sql`SELECT d.*, f.sha256, f.storage_key, f.size_bytes, f.file_format FROM documents d
      JOIN document_versions v ON v.id = d.current_version_id JOIN stored_files f ON f.id = v.file_id ORDER BY publication_date`;
    expect(docs).toHaveLength(2);
    const [a, b] = docs as unknown as Record<string, unknown>[];
    expect(a!.title).toBe("Framework for Foreign Portfolio Investors (test)");
    expect(a!.publication_date).toBe("2099-01-05");
    expect(a!.document_number).toBe(CIRC1);
    expect(a!.document_type).toBe("circular");
    expect(a!.original_url).toBe(P1);
    expect(a!.landing_url).toBe(D1);
    expect(a!.relevance).toBe("in_scope");
    expect(a!.legal_status).toBe("pending_verification");
    expect(a!.extraction_status).toBe("ok");
    expect(a!.file_format).toBe("pdf");
    expect(String(a!.sha256)).toMatch(/^[0-9a-f]{64}$/);
    // Original stored unmodified.
    const stored = await storage().get(String(a!.storage_key));
    expect(stored.equals(await pdf1())).toBe(true);

    const tags = (await sql`SELECT tag_code FROM document_tags WHERE document_id = ${a!.id as string}`).map((t) => t.tag_code);
    expect(tags).toEqual(expect.arrayContaining(["fpi", "kyc_aml", "custody"]));

    // Amendment relationship proposed from explicit citation, with evidence.
    const rels = await sql`SELECT * FROM document_relationships`;
    expect(rels).toHaveLength(1);
    expect(rels[0]).toMatchObject({ from_document_id: b!.id, to_document_id: a!.id, rel_type: "amends", status: "proposed", evidence_kind: "explicit_reference" });
    expect(String(rels[0]!.evidence_text)).toContain("In partial modification");

    // Full-text search over extracted text and normalized number.
    const hits = await sql`SELECT id FROM documents WHERE search_vector @@ websearch_to_tsquery('english', 'custodians KYC')`;
    expect(hits.map((h) => h.id)).toContain(a!.id);
    const numHit = await sql`SELECT id FROM documents WHERE document_number_norm = ${"SEBI/HO/TEST/P/CIR/2099/1"}`;
    expect(numHit).toHaveLength(1);

    const [run] = await sql`SELECT * FROM crawl_runs WHERE id = ${res.runId}`;
    // Page 3 (empty) is fetched to confirm the end of pagination.
    expect(run).toMatchObject({ status: "success_new", entries_new: 3, pages_fetched: 3, pages_failed: 0 });
    const [src] = await sql`SELECT verification_status, last_success_at, consecutive_failures FROM sources WHERE id = ${sourceId}`;
    expect(src).toMatchObject({ verification_status: "verified", consecutive_failures: 0 });
    expect(src!.last_success_at).not.toBeNull();
  });

  it("is idempotent: re-running a crawl creates no duplicate entries, documents or versions", async () => {
    const net = await standardNet();
    const deps = makeDeps(net);
    const sourceId = await addSource(sql, "test.sebi", "SEBI", "sebi_listing", sebiConfig);
    await runCrawl(deps, sourceId, "backfill", "test");
    const second = await runCrawl(deps, sourceId, "backfill", "test");
    expect(second.status).toBe("success_no_new");
    expect(second.newEntries).toBe(0);
    const [c] = await sql`SELECT (SELECT count(*) FROM documents)::int d, (SELECT count(*) FROM document_versions)::int v,
      (SELECT count(*) FROM source_entries)::int e, (SELECT count(*) FROM stored_files)::int f, (SELECT count(*) FROM document_relationships)::int r`;
    expect(c).toEqual({ d: 2, v: 2, e: 3, f: 2, r: 1 });
  });

  it("does not duplicate a document listed on two official pages; keeps both source references", async () => {
    const net = await standardNet();
    const deps = makeDeps(net);
    const s1 = await addSource(sql, "test.sebi", "SEBI", "sebi_listing", sebiConfig);
    const IDX = "https://www.sebi.gov.in/test-index.html";
    net.set(IDX, { body: indexHtml([{ date: "05/01/2099", title: "Framework for Foreign Portfolio Investors (test)", href: P1 }]) });
    const s2 = await addSource(sql, "test.index", "SEBI", "link_index", { pages: [IDX], linkPattern: "\\.pdf$", downloadPolicy: "all" });
    await runCrawl(deps, s1, "backfill", "test");
    await runCrawl(deps, s2, "incremental", "test");
    const [c] = await sql`SELECT count(*)::int n FROM documents`;
    expect(c!.n).toBe(2);
    const refs = await sql`SELECT source_id FROM source_entries WHERE document_id = (SELECT document_id FROM source_entries WHERE entry_key = ${P1})`;
    expect(refs.map((r) => r.source_id).sort()).toEqual([s1, s2].sort());
  });

  it("preserves history when a file is replaced at the same URL", async () => {
    const net = await standardNet();
    const deps = makeDeps(net);
    const sourceId = await addSource(sql, "test.sebi", "SEBI", "sebi_listing", sebiConfig);
    await runCrawl(deps, sourceId, "backfill", "test");
    const [entry] = await sql`SELECT id, document_id FROM source_entries WHERE entry_key = ${D1}`;

    // Unchanged on first recheck.
    expect(await processEntry(deps, entry!.id, { finalAttempt: true })).toBe("unchanged");

    const replaced = await textPdf(["CIRCULAR", CIRC1, "January 05, 2099", "Foreign Portfolio Investors - revised file (test)", "Custodians KYC updated text."]);
    net.set(P1, { body: replaced, contentType: "application/pdf", headers: { etag: '"v2"' } });
    expect(await processEntry(deps, entry!.id, { finalAttempt: true })).toBe("new_version");

    const versions = await sql`SELECT v.version_no, v.change_kind, v.previous_sha256, f.sha256 FROM document_versions v
      JOIN stored_files f ON f.id = v.file_id WHERE v.document_id = ${entry!.document_id} ORDER BY version_no`;
    expect(versions).toHaveLength(2);
    expect(versions[1]!.change_kind).toBe("file_replaced");
    expect(versions[1]!.previous_sha256).toBe(versions[0]!.sha256);
    const [doc] = await sql`SELECT legal_status, review_status, review_reasons, current_version_id FROM documents WHERE id = ${entry!.document_id}`;
    // A changed file is flagged for review — not treated as a legal amendment.
    expect(doc!.legal_status).toBe("pending_verification");
    expect(doc!.review_status).toBe("needs_review");
    expect(doc!.review_reasons).toContain("file_changed");
    // Both originals still retrievable.
    const files = await sql`SELECT storage_key FROM stored_files`;
    for (const f of files) expect(await storage().exists(f.storage_key)).toBe(true);
  });

  it("resolves a citation when the cited document arrives later, and refuses ambiguous matches", async () => {
    const net = await standardNet();
    const deps = makeDeps(net);
    const IDX = "https://www.sebi.gov.in/idx.html";
    // Only the amending circular is listed first.
    net.set(IDX, { body: indexHtml([{ date: "10/02/2099", title: "Amendment to FPI test circular", href: P2 }]) });
    const s = await addSource(sql, "test.idx", "SEBI", "link_index", { pages: [IDX], linkPattern: "\\.pdf$", downloadPolicy: "all" });
    await runCrawl(deps, s, "incremental", "test");
    expect(await sql`SELECT * FROM document_relationships`).toHaveLength(0);
    const [pending] = await sql`SELECT reference_norm, resolved_document_id FROM document_references WHERE rel_type = 'amends'`;
    expect(pending).toMatchObject({ reference_norm: CIRC1, resolved_document_id: null });

    net.set(IDX, { body: indexHtml([
      { date: "10/02/2099", title: "Amendment to FPI test circular", href: P2 },
      { date: "05/01/2099", title: "Framework for Foreign Portfolio Investors (test)", href: P1 },
    ]) });
    await runCrawl(deps, s, "incremental", "test");
    const rels = await sql`SELECT rel_type, status FROM document_relationships`;
    expect(rels).toEqual([{ rel_type: "amends", status: "proposed" }]);
  });

  it("does not link a reference that matches more than one document", async () => {
    const net = new FixtureNet();
    const deps = makeDeps(net);
    const IDX = "https://www.ifsca.gov.in/idx";
    const mk = (n: number) => `https://www.ifsca.gov.in/Document/Legal/test-${n}.pdf`;
    net.set(IDX, { body: indexHtml([1, 2, 3].map((n) => ({ date: `0${n}/01/2099`, title: `IFSC test notice ${n}`, href: mk(n) }))) });
    // Two different documents both titled with A.P. (DIR Series) Circular No. 5 (numbering restarts yearly) …
    net.set(mk(1), { body: await textPdf(["A.P. (DIR Series) Circular No. 5", "IFSC fund management entity test one"]), contentType: "application/pdf" });
    net.set(mk(2), { body: await textPdf(["A.P. (DIR Series) Circular No. 5", "IFSC fund management entity test two"]), contentType: "application/pdf" });
    // … and a third that cites it without a date.
    net.set(mk(3), { body: await textPdf(["IFSC test", "In supersession of A.P. (DIR Series) Circular No. 5, the following applies."]), contentType: "application/pdf" });
    const s = await addSource(sql, "test.ifsca", "IFSCA", "link_index", { pages: [IDX], linkPattern: "\\.pdf$", assumeInScope: true, downloadPolicy: "all" });
    await runCrawl(deps, s, "incremental", "test");
    // Both notices carry the number in their header, so it is one of their own identifiers.
    const ids = await sql`SELECT count(DISTINCT document_id)::int n FROM document_identifiers WHERE ident_norm = 'APDIR/5'`;
    expect(ids[0]!.n).toBe(2);
    const { reconcile } = await import("../../src/jobs/runtime");
    await reconcile(deps);
    expect(await sql`SELECT * FROM document_relationships`).toHaveLength(0);
    const [ref] = await sql`SELECT resolved_document_id FROM document_references WHERE reference_norm = 'APDIR/5'`;
    expect(ref!.resolved_document_id).toBeNull();
  });

  it("flags parser attention when an index page loads but yields no entries", async () => {
    const net = new FixtureNet();
    net.set(LIST, { body: "<html><body><p>Site redesigned</p></body></html>" });
    const deps = makeDeps(net);
    const s = await addSource(sql, "test.sebi", "SEBI", "sebi_listing", sebiConfig);
    const res = await runCrawl(deps, s, "incremental", "test");
    expect(res.status).toBe("parser_attention");
    const [src] = await sql`SELECT verification_status, consecutive_failures FROM sources WHERE id = ${s}`;
    expect(src).toMatchObject({ verification_status: "parser_attention", consecutive_failures: 1 });
    const errs = await sql`SELECT stage FROM collection_errors WHERE source_id = ${s}`;
    expect(errs.map((e) => e.stage)).toContain("parse_index");
  });

  it("records a failed crawl when the source is unreachable, without affecting other sources", async () => {
    const net = await standardNet();
    net.set(LIST, { status: 503, body: "unavailable" });
    const deps = makeDeps(net);
    const bad = await addSource(sql, "test.sebi", "SEBI", "sebi_listing", sebiConfig);
    const IDX = "https://www.ifsca.gov.in/ok";
    net.set(IDX, { body: indexHtml([{ date: "05/01/2099", title: "IFSC fund management test circular", href: "https://www.ifsca.gov.in/Document/Legal/ok.pdf" }]) });
    net.set("https://www.ifsca.gov.in/Document/Legal/ok.pdf", { body: await textPdf(["IFSCA test circular on fund management entities in GIFT IFSC"]), contentType: "application/pdf" });
    const good = await addSource(sql, "test.ifsca", "IFSCA", "link_index", { pages: [IDX], linkPattern: "\\.pdf$", assumeInScope: true, downloadPolicy: "all" });
    expect((await runCrawl(deps, bad, "incremental", "test")).status).toBe("failed");
    expect((await runCrawl(deps, good, "incremental", "test")).status).toBe("success_new");
    expect(net.requests.filter((r) => r.url === LIST).length).toBe(3); // retried with backoff
    const [s] = await sql`SELECT verification_status, consecutive_failures, last_success_at FROM sources WHERE id = ${bad}`;
    expect(s).toMatchObject({ verification_status: "failing", consecutive_failures: 1, last_success_at: null });
  });

  it("records download failures visibly instead of discarding them", async () => {
    const net = await standardNet();
    net.set(P1, { status: 404, body: "gone" });
    const deps = makeDeps(net);
    const s = await addSource(sql, "test.sebi", "SEBI", "sebi_listing", sebiConfig);
    await runCrawl(deps, s, "backfill", "test");
    const [e] = await sql`SELECT state, last_error FROM source_entries WHERE entry_key = ${D1}`;
    expect(e!.state).toBe("download_failed");
    const [err] = await sql`SELECT stage, error_code, url FROM collection_errors WHERE entry_id IS NOT NULL`;
    expect(err).toMatchObject({ stage: "download", error_code: "http_status", url: D1 });
  });

  it("OCRs a scanned PDF and records the OCR status", async () => {
    const net = new FixtureNet();
    const IDX = "https://www.ifsca.gov.in/scan";
    const PDF = "https://www.ifsca.gov.in/Document/Legal/scan.pdf";
    net.set(IDX, { body: indexHtml([{ date: "05/01/2099", title: "Scanned IFSC custody notice (test)", href: PDF }]) });
    net.set(PDF, { body: await scannedPdf(["International Financial Services Centres", "Custody of securities held by", "fund management entities", "This is a scanned test page."]), contentType: "application/pdf" });
    const deps = makeDeps(net);
    const s = await addSource(sql, "test.ifsca", "IFSCA", "link_index", { pages: [IDX], linkPattern: "\\.pdf$", assumeInScope: true, downloadPolicy: "all" });
    await runCrawl(deps, s, "incremental", "test");
    const [d] = await sql`SELECT d.extraction_status, e.method, e.ocr_confidence, e.text_content FROM documents d JOIN extracted_texts e ON e.version_id = d.current_version_id`;
    expect(d!.method).toBe("ocr");
    expect(["ocr_ok", "ocr_low_confidence"]).toContain(d!.extraction_status);
    expect(String(d!.text_content).toLowerCase()).toContain("custody");
  });
});
