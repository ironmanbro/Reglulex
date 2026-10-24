// Browser end-to-end check against the production build.
// Builds a throwaway database (fi_library_e2e) through the real ingestion pipeline using
// synthetic fixtures, starts `next start`, and drives core journeys in Chromium.
//   pnpm build && pnpm test:e2e
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import postgres from "postgres";
import { chromium, type Page } from "playwright";

const DB = process.env.E2E_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/fi_library_e2e";
const PORT = 3100;
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.E2E_SCREENSHOTS ?? path.resolve("test-results/e2e");
const PASSWORD = "e2e-password-0123";
mkdirSync(SHOTS, { recursive: true });

process.env.FIRL_E2E = "1";
process.env.DATABASE_URL = DB;
process.env.STORAGE_DRIVER = "local";
process.env.STORAGE_LOCAL_DIR = mkdtempSync(path.join(tmpdir(), "firl-e2e-"));
process.env.LOG_LEVEL = "error";
process.env.SESSION_SECRET = "e2e-session-secret-0123456789abcdef-0123456789";

const { migrate } = await import("../../src/lib/migrate");
const { seed } = await import("../../src/lib/seed-data");
const { hashPassword } = await import("../../src/lib/password");
const { db, closeDb } = await import("../../src/lib/db");
const { addSource, makeDeps } = await import("../helpers/harness");
const { FixtureNet, indexHtml, textPdf } = await import("../helpers/fixtures");
const { runCrawl } = await import("../../src/ingest/pipeline");

// ---- 1. Fresh database populated through the real pipeline ----
const admin = postgres(DB, { max: 1, onnotice: () => {} });
await admin.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
await admin.end();
const sql = db();
await migrate(sql);
await seed(sql);

const net = new FixtureNet();
const IDX = "https://www.sebi.gov.in/e2e-index";
const P = (n: string) => `https://www.sebi.gov.in/sebi_data/attachdocs/e2e/${n}.pdf`;
net.set(IDX, { body: indexHtml([
  { date: "05/01/2099", title: "E2E test: Framework for Foreign Portfolio Investors", href: P("a") },
  { date: "10/02/2099", title: "E2E test: Amendment to FPI framework circular", href: P("b") },
]) });
net.set(P("a"), { body: await textPdf(["SEBI/HO/E2E/P/CIR/2099/1", "Synthetic end-to-end test document. Foreign portfolio investors.", "Custodians shall verify KYC. KYC records retained by custodians.", "Beneficial ownership of FPIs shall be disclosed."], 2), contentType: "application/pdf" });
net.set(P("b"), { body: await textPdf(["SEBI/HO/E2E/P/CIR/2099/2", "Synthetic end-to-end test document for foreign portfolio investors.", "In partial modification of circular SEBI/HO/E2E/P/CIR/2099/1, paragraph 2 is amended."]), contentType: "application/pdf" });
const sourceId = await addSource(sql, "e2e.fixture", "SEBI", "link_index", { pages: [IDX], linkPattern: "\\.pdf$", downloadPolicy: "all" });
const crawl = await runCrawl(makeDeps(net), sourceId, "incremental", "test");
assert.equal(crawl.status, "success_new");
const [docA] = await sql<{ id: string }[]>`SELECT id FROM documents WHERE title LIKE '%Framework%'`;
await closeDb();

// ---- 2. Start the production server ----
// Refuse to run against a leftover server from an earlier run (it would serve another database).
if (await fetch(`${BASE}/api/health`).then(() => true, () => false)) throw new Error(`Port ${PORT} is already in use — stop the old server first`);
const server = spawn("node_modules/.bin/next", ["start", "-p", String(PORT)], {
  env: { ...process.env, ADMIN_PASSWORD_HASH: await hashPassword(PASSWORD), PUBLIC_SITE_URL: BASE, NODE_ENV: "production" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${BASE}/api/health`)).ok) break;
  } catch {}
  if (i > 60) throw new Error(`server did not start:\n${serverLog}`);
  await new Promise((r) => setTimeout(r, 500));
}

// PW_CHROMIUM_PATH lets environments with a pre-installed Chromium skip `playwright install`.
const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});
const results: { name: string; ok: boolean; error?: string }[] = [];
const consoleErrors: string[] = [];

async function step(name: string, fn: (page: Page) => Promise<void>, viewport = { width: 1366, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(`${name}: ${m.text()}`));
  page.on("pageerror", (e) => consoleErrors.push(`${name}: ${e.message}`));
  try {
    await fn(page);
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: (err as Error).message.split("\n")[0] });
    await page.screenshot({ path: path.join(SHOTS, `FAIL-${name.replace(/\W+/g, "_")}.png`), fullPage: true }).catch(() => {});
  } finally {
    await ctx.close();
  }
}

try {
  await step("home shows real status and search", async (page) => {
    await page.goto(BASE);
    await page.getByRole("heading", { level: 1 }).waitFor();
    const status = await page.getByLabel("Library status").innerText();
    assert.match(status, /Last successful collection/);
    assert.match(status, /2 documents/);
    await page.screenshot({ path: path.join(SHOTS, "home.png"), fullPage: true });
    await page.getByLabel("Search the library").fill("beneficial ownership");
    await page.getByRole("button", { name: "Search" }).click();
    await page.waitForURL(/\/documents\?q=/);
    await page.getByRole("link", { name: /Framework for Foreign Portfolio Investors/ }).waitFor();
    assert.ok(await page.locator("mark").count() > 0, "snippet highlights");
  });

  await step("library filters and document-number search", async (page) => {
    await page.goto(`${BASE}/documents`);
    assert.match(await page.locator("#results-heading").innerText(), /^2 documents/);
    await page.locator("#f-authority-SEBI").check();
    await page.getByRole("button", { name: "Apply filters" }).click();
    await page.waitForURL(/authority=SEBI/);
    assert.match(await page.locator("#results-heading").innerText(), /^2 documents/);
    await page.goto(`${BASE}/documents?q=${encodeURIComponent("sebi/ho/e2e/p/cir/2099/2")}`);
    assert.match(await page.locator("#results-heading").innerText(), /^1 document/);
    await page.goto(`${BASE}/documents?authority=RBI`);
    await page.getByText("No documents found").waitFor();
    await page.screenshot({ path: path.join(SHOTS, "library.png"), fullPage: true });
  });

  await step("document detail: metadata, official link, PDF, text, history", async (page) => {
    await page.goto(`${BASE}/documents/${docA!.id}`);
    await page.getByRole("heading", { level: 1, name: /Framework for Foreign Portfolio Investors/ }).waitFor();
    const official = page.getByRole("link", { name: /Open official source/ });
    assert.equal(await official.getAttribute("href"), P("a"));
    assert.equal(await official.getAttribute("target"), "_blank");
    assert.match(await page.locator("aside").innerText(), /SEBI\/HO\/E2E\/P\/CIR\/2099\/1/);
    assert.match(await page.locator("body").innerText(), /Legal status not verified/);
    // History: amended-by relation, labelled unconfirmed, with evidence.
    const history = page.locator("ol.timeline");
    assert.match(await history.innerText(), /Amended by/);
    assert.match(await history.innerText(), /unconfirmed/);
    // Embedded PDF is served with the right type.
    const data = await page.locator("object.viewer").getAttribute("data");
    const res = await page.request.get(`${BASE}${data}`);
    assert.equal(res.status(), 200);
    assert.equal(res.headers()["content-type"], "application/pdf");
    assert.equal((await res.body()).subarray(0, 5).toString(), "%PDF-");
    await page.screenshot({ path: path.join(SHOTS, "detail.png"), fullPage: true });
    await page.getByRole("link", { name: "Extracted text" }).click();
    await page.getByText("Page 2", { exact: true }).waitFor();
    await page.screenshot({ path: path.join(SHOTS, "detail-text.png"), fullPage: false });
  });

  await step("mobile layout has no horizontal scroll", async (page) => {
    for (const url of ["/", "/documents", `/documents/${docA!.id}`, "/sources"]) {
      await page.goto(BASE + url);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 1, `${url} overflows by ${overflow}px`);
    }
    await page.goto(`${BASE}/documents/${docA!.id}`);
    await page.screenshot({ path: path.join(SHOTS, "mobile-detail.png"), fullPage: false });
  }, { width: 390, height: 844 });

  await step("sources page shows honest coverage", async (page) => {
    await page.goto(`${BASE}/sources`);
    assert.match(await page.locator("body").innerText(), /Not yet checked/);
    assert.match(await page.locator("body").innerText(), /0 of 14 collected/);
    await page.screenshot({ path: path.join(SHOTS, "sources.png"), fullPage: true });
  });

  await step("admin is protected", async (page) => {
    const r = await page.request.get(`${BASE}/admin`, { maxRedirects: 0 });
    assert.equal(r.status(), 307);
    assert.match(r.headers()["location"] ?? "", /\/admin\/login/);
    await page.goto(`${BASE}/admin/review`);
    await page.waitForURL(/\/admin\/login/);
    await page.getByLabel("Username").fill("admin");
    await page.getByLabel("Password").fill("wrong-password-xyz");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByText("Incorrect username or password").waitFor();
    // Forged cookie is rejected.
    await page.context().addCookies([{ name: "firl_admin", value: "eyJ1IjoiYWRtaW4iLCJleHAiOjk5OTk5OTk5OTl9.AAAA", url: BASE }]);
    await page.goto(`${BASE}/admin`);
    await page.waitForURL(/\/admin\/login/);
  });

  await step("admin: login, queue a crawl, confirm relationship, edit metadata, audit", async (page) => {
    await page.goto(`${BASE}/admin/login`);
    await page.getByLabel("Username").fill("admin");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(`${BASE}/admin`);
    await page.screenshot({ path: path.join(SHOTS, "admin.png"), fullPage: true });
    const row = page.locator("tr", { hasText: "e2e.fixture" });
    await row.getByRole("button", { name: "Crawl now" }).click();
    await page.getByText(/Queued incremental crawl/).waitFor();
    await page.goto(`${BASE}/admin/review?tab=relationships`);
    await page.getByRole("button", { name: "Confirm" }).first().click();
    await page.getByText("Relationship confirmed").waitFor();
    await page.goto(`${BASE}/documents/${docA!.id}`);
    assert.match(await page.locator("ol.timeline").innerText(), /Confirmed by reviewer/);
    assert.match(await page.locator(".doc-header").innerText(), /Amended/);
    await page.goto(`${BASE}/admin/documents/${docA!.id}`);
    await page.getByLabel(/Effective date/).fill("2099-02-01");
    await page.getByRole("button", { name: "Save metadata" }).click();
    await page.getByText("Saved", { exact: true }).waitFor();
    await page.goto(`${BASE}/admin/audit`);
    const audit = await page.locator("table").innerText();
    for (const a of ["login", "trigger_incremental", "relationship_confirmed", "status_from_relationship", "update_document"]) assert.match(audit, new RegExp(a));
  });

  await step("health and search API", async (page) => {
    const h = await (await page.request.get(`${BASE}/api/health`)).json();
    assert.equal(h.status, "ok");
    const s = await (await page.request.get(`${BASE}/api/search?q=custodians`)).json();
    assert.equal(s.total, 1);
    const f = await page.request.get(`${BASE}/api/files/999999`);
    assert.equal(f.status(), 404);
  });
} finally {
  await browser.close();
  server.kill("SIGTERM");
}

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.error ? `\n      ${r.error}` : ""}`);
const relevantConsole = consoleErrors.filter((e) => !/Failed to load resource: the server responded with a status of 404/.test(e));
if (relevantConsole.length) console.log("Browser console errors:\n  " + relevantConsole.join("\n  "));
console.log(`Screenshots: ${SHOTS}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} journeys passed`);
process.exit(failed || relevantConsole.length ? 1 : 0);
