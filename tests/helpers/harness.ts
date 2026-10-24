import "./env";
import { db, type Sql } from "../../src/lib/db";
import { Fetcher } from "../../src/lib/http/fetcher";
import { seed } from "../../src/lib/seed-data";
import { storage } from "../../src/lib/storage";
import { processEntry, type IngestDeps } from "../../src/ingest/pipeline";
import { FixtureNet } from "./fixtures";

export const ALLOWED = ["sebi.gov.in", "rbi.org.in", "ifsca.gov.in", "dpiit.gov.in"];

export async function resetDb(sql: Sql) {
  await sql.unsafe(`TRUNCATE documents, source_entries, crawl_runs, sources, stored_files, collection_errors, jobs,
    audit_log, app_events, possible_duplicates, coverage_targets RESTART IDENTITY CASCADE`);
  await seed(sql, { sources: false });
}

export function makeDeps(net: FixtureNet, mode: "inline" | "queue" = "inline"): IngestDeps {
  const sql = db();
  const fetcher = new Fetcher({
    transport: net.transport,
    allowedHosts: () => ALLOWED,
    resolveHost: async () => ["203.0.113.10"],
    minIntervalMs: 0,
    respectRobots: false,
    sleep: async () => {},
  });
  const deps: IngestDeps = { sql, fetcher, storage: storage() };
  if (mode === "inline") {
    deps.onEntry = async (id) => {
      await processEntry(deps, id, { finalAttempt: true });
    };
  }
  return deps;
}

export async function addSource(sql: Sql, code: string, authority: string, connector: string, config: Record<string, unknown>, extra: { enabled?: boolean } = {}) {
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO sources (code, authority_id, name, connector, config, enabled)
    VALUES (${code}, (SELECT id FROM authorities WHERE code = ${authority}), ${code}, ${connector}, ${sql.json(config as never)}, ${extra.enabled ?? true})
    RETURNING id`;
  return row!.id;
}
