import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addSource, makeDeps, resetDb } from "../helpers/harness";
import { closeDb, db } from "../../src/lib/db";
import { backoffSeconds, claim, complete, enqueue, fail, reclaimStale, retryDead } from "../../src/jobs/queue";
import { handleJob, schedulerTick } from "../../src/jobs/runtime";
import { FixtureNet, indexHtml, textPdf } from "../helpers/fixtures";

const sql = db();
beforeEach(async () => resetDb(sql));
afterAll(async () => closeDb());

describe("job queue", () => {
  it("deduplicates live jobs by key", async () => {
    expect(await enqueue(sql, "crawl", { a: 1 }, { dedupeKey: "k" })).not.toBeNull();
    expect(await enqueue(sql, "crawl", { a: 1 }, { dedupeKey: "k" })).toBeNull();
    const j = (await claim(sql, "w"))!;
    expect(await enqueue(sql, "crawl", { a: 1 }, { dedupeKey: "k" })).toBeNull(); // still running
    await complete(sql, j.id);
    expect(await enqueue(sql, "crawl", { a: 1 }, { dedupeKey: "k" })).not.toBeNull(); // done → new work allowed
  });

  it("never hands the same job to two workers", async () => {
    await enqueue(sql, "x", {});
    const [a, b] = await Promise.all([claim(sql, "w1"), claim(sql, "w2")]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("retries with exponential backoff, then dead-letters", async () => {
    await enqueue(sql, "x", {}, { maxAttempts: 2 });
    const j1 = (await claim(sql, "w"))!;
    expect(await fail(sql, j1, "boom")).toBe(false);
    const [row] = await sql`SELECT status, run_after > now() + interval '20 seconds' AS later FROM jobs WHERE id = ${j1.id}`;
    expect(row).toMatchObject({ status: "queued", later: true });
    expect(await claim(sql, "w")).toBeNull(); // not yet due
    await sql`UPDATE jobs SET run_after = now()`;
    const j2 = (await claim(sql, "w"))!;
    expect(await fail(sql, j2, "boom again")).toBe(true);
    expect((await sql`SELECT status FROM jobs`)[0]!.status).toBe("dead");
    expect(await retryDead(sql, j2.id)).toBe(true);
    expect((await sql`SELECT status, attempts FROM jobs`)[0]).toMatchObject({ status: "queued", attempts: 0 });
    expect(backoffSeconds(1)).toBe(30);
    expect(backoffSeconds(20)).toBe(6 * 3600);
  });

  it("reclaims jobs from crashed workers", async () => {
    await enqueue(sql, "x", {});
    await claim(sql, "w");
    await sql`UPDATE jobs SET locked_at = now() - interval '2 hours'`;
    expect(await reclaimStale(sql)).toBe(1);
    expect((await sql`SELECT status FROM jobs`)[0]!.status).toBe("queued");
  });
});

describe("scheduler", () => {
  it("is idempotent: repeated ticks enqueue each due crawl once", async () => {
    await addSource(sql, "a.one", "SEBI", "rss", { feedUrl: "https://www.sebi.gov.in/x.xml" });
    await addSource(sql, "a.two", "RBI", "rss", { feedUrl: "https://www.rbi.org.in/x.xml" });
    await addSource(sql, "a.off", "RBI", "rss", { feedUrl: "https://www.rbi.org.in/y.xml" }, { enabled: false });
    const t1 = await schedulerTick(sql);
    const t2 = await schedulerTick(sql);
    expect(t1.crawls).toBe(2);
    expect(t2.crawls).toBe(0);
    const jobs = await sql`SELECT kind, payload FROM jobs ORDER BY id`;
    expect(jobs.filter((j) => j.kind === "crawl")).toHaveLength(2);
    expect(jobs.filter((j) => j.kind === "reconcile")).toHaveLength(1);
    // Even if next_run_at is reset (e.g. two schedulers), the dedupe key prevents duplicates.
    await sql`UPDATE sources SET next_run_at = NULL`;
    await schedulerTick(sql);
    expect((await sql`SELECT count(*)::int n FROM jobs WHERE kind = 'crawl' AND status = 'queued'`)[0]!.n).toBe(2);
  });

  it("worker jobs run a crawl and process entries end to end, independent of web traffic", async () => {
    const net = new FixtureNet();
    const IDX = "https://www.ifsca.gov.in/idx";
    const PDF = "https://www.ifsca.gov.in/Document/Legal/q.pdf";
    net.set(IDX, { body: indexHtml([{ date: "01/02/2099", title: "IFSC fund management test circular", href: PDF }]) });
    net.set(PDF, { body: await textPdf(["IFSCA test circular for fund management entities in GIFT IFSC"]), contentType: "application/pdf" });
    const deps = makeDeps(net, "queue");
    deps.enqueue = async (kind, payload, o) => { await enqueue(sql, kind, payload, o); };
    await addSource(sql, "q.ifsca", "IFSCA", "link_index", { pages: [IDX], linkPattern: "\\.pdf$", assumeInScope: true, downloadPolicy: "all" });
    await schedulerTick(sql);
    for (let i = 0; i < 10; i++) {
      const job = await claim(sql, "w");
      if (!job) break;
      await handleJob(deps, job);
      await complete(sql, job.id);
    }
    expect((await sql`SELECT count(*)::int n FROM documents`)[0]!.n).toBe(1);
    expect((await sql`SELECT count(*)::int n FROM jobs WHERE status <> 'done'`)[0]!.n).toBe(0);
  });
});
