import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addSource, makeDeps, resetDb } from "../helpers/harness";
import { closeDb, db } from "../../src/lib/db";
import { runCrawl } from "../../src/ingest/pipeline";
import { getDocument, searchDocuments, searchParamsSchema } from "../../src/lib/queries";
import { expandQuery } from "../../src/lib/search";
import { FixtureNet, indexHtml, textPdf } from "../helpers/fixtures";

const sql = db();
const P = (n: string) => `https://www.sebi.gov.in/sebi_data/attachdocs/test/${n}.pdf`;
const search = (p: Record<string, unknown>) => searchDocuments(searchParamsSchema.parse(p), { sql });

beforeAll(async () => {
  await resetDb(sql);
  const net = new FixtureNet();
  const IDX = "https://www.sebi.gov.in/idx";
  net.set(IDX, { body: indexHtml([
    { date: "05/01/2099", title: "Categorisation of Foreign Portfolio Investors (test)", href: P("a") },
    { date: "10/03/2099", title: "Beneficial ownership disclosure by FPIs (test)", href: P("b") },
    { date: "12/06/2098", title: "Mutual fund expense ratio (test)", href: P("c") },
  ]) });
  net.set(P("a"), { body: await textPdf(["SEBI/HO/TEST/P/CIR/2099/11", "Foreign portfolio investors shall be categorised. Registration of FPIs.", "Category I FPI and Category II FPI registration."]), contentType: "application/pdf" });
  net.set(P("b"), { body: await textPdf(["SEBI/HO/TEST/P/CIR/2099/12", "Foreign portfolio investors shall disclose beneficial owners.", "Granular details of beneficial ownership."]), contentType: "application/pdf" });
  net.set(P("c"), { body: await textPdf(["Mutual fund schemes total expense ratio for test."]), contentType: "application/pdf" });
  const s = await addSource(sql, "s.idx", "SEBI", "link_index", { pages: [IDX], linkPattern: "\\.pdf$", downloadPolicy: "all" });
  await runCrawl(makeDeps(net), s, "incremental", "test");
});
afterAll(async () => closeDb());

describe("search and filters", () => {
  it("finds documents by full text, hiding out-of-scope ones", async () => {
    const r = await search({ q: "beneficial owners" });
    expect(r.rows.map((x) => x.title)).toEqual(["Beneficial ownership disclosure by FPIs (test)"]);
    expect(r.rows[0]!.snippet).toContain("⟦");
    expect((await search({ q: "expense ratio" })).total).toBe(0);
  });
  it("handles spelling variants and abbreviations", async () => {
    expect((await search({ q: "categorization" })).total).toBeGreaterThan(0);
    expect((await search({ q: "FPI beneficial" })).total).toBe(1);
    expect(expandQuery("FPI kyc")).toContain("foreign portfolio investor kyc");
  });
  it("finds a document by number however it is spaced", async () => {
    const r = await search({ q: "sebi/ho/test/p/cir/2099/12" });
    expect(r.rows[0]!.title).toContain("Beneficial ownership");
  });
  it("tolerates small typos in titles", async () => {
    expect((await search({ q: "Benefical ownershp disclosure" })).total).toBeGreaterThan(0);
  });
  it("filters by authority, route, topic, type and date, and sorts", async () => {
    expect((await search({ authority: "SEBI" })).total).toBe(2);
    expect((await search({ authority: "RBI" })).total).toBe(0);
    expect((await search({ route: "fpi" })).total).toBe(2);
    expect((await search({ topic: "beneficial_ownership" })).total).toBe(1);
    expect((await search({ from: "2099-02-01" })).total).toBe(1);
    expect((await search({ to: "2099-02-01" })).total).toBe(1);
    expect((await search({ status: "pending_verification" })).total).toBe(2);
    expect((await search({ status: "superseded" })).total).toBe(0);
    const asc = await search({ sort: "oldest" });
    expect(asc.rows[0]!.publication_date).toBe("2099-01-05");
  });
  it("ignores malformed parameters instead of erroring", async () => {
    const r = await search({ page: "-4", from: "not-a-date", sort: "drop table", authority: ["SEBI'; --"] });
    expect(r.page).toBe(1);
  });
  it("returns full document detail with provenance", async () => {
    const [{ id }] = (await sql`SELECT id FROM documents WHERE title LIKE 'Beneficial%'`) as unknown as [{ id: string }];
    const d = (await getDocument(id, sql))!;
    expect(d.doc.document_number).toBe("SEBI/HO/TEST/P/CIR/2099/12");
    expect(d.versions).toHaveLength(1);
    expect(d.sources[0]!.source_code).toBe("s.idx");
    expect(d.text!.text_content).toContain("beneficial owners");
    expect(await getDocument("../../etc/passwd", sql)).toBeNull();
  });
});
