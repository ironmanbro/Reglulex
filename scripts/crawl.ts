// Manual crawl from the command line.
//   pnpm crawl <source-code|all> [--mode incremental|backfill|recheck] [--inline]
// Without --inline, entries are queued for the worker. With --inline, they are processed now.
import { closeDb, db } from "@/lib/db";
import { log } from "@/lib/log";
import { migrate } from "@/lib/migrate";
import { buildDeps } from "@/jobs/runtime";
import { processEntry, runCrawl } from "@/ingest/pipeline";

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--"));
const mode = (args[args.indexOf("--mode") + 1] && args.includes("--mode") ? args[args.indexOf("--mode") + 1] : "incremental") as
  "incremental" | "backfill" | "recheck";
const inline = args.includes("--inline");
if (!target) {
  console.error("usage: pnpm crawl <source-code|all> [--mode incremental|backfill|recheck] [--inline]");
  process.exit(2);
}

const sql = db();
await migrate(sql);
const sources = await sql<{ id: number; code: string }[]>`
  SELECT id, code FROM sources WHERE ${target === "all" ? sql`enabled` : sql`code = ${target}`} ORDER BY id`;
if (!sources.length) {
  console.error(`No source matches '${target}'`);
  process.exit(2);
}
const deps = buildDeps({ sql });
if (inline) {
  deps.onEntry = async (entryId) => {
    try {
      const outcome = await processEntry(deps, entryId, { finalAttempt: true });
      log.info("entry processed", { entryId, outcome });
    } catch (err) {
      log.error("entry failed", { entryId, error: (err as Error).message });
    }
  };
}
for (const s of sources) {
  const res = await runCrawl(deps, s.id, mode, "cli");
  console.log(JSON.stringify({ source: s.code, ...res }));
}
await closeDb();
