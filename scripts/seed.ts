import { closeDb, db } from "@/lib/db";
import { log } from "@/lib/log";
import { migrate } from "@/lib/migrate";
import { seed } from "@/lib/seed-data";

const sql = db();
await migrate(sql);
await seed(sql);
const [counts] = await sql`SELECT (SELECT count(*) FROM authorities)::int AS authorities, (SELECT count(*) FROM sources)::int AS sources,
  (SELECT count(*) FROM tags)::int AS tags, (SELECT count(*) FROM coverage_targets)::int AS coverage_targets`;
log.info("seed complete", counts as Record<string, unknown>);
await closeDb();
