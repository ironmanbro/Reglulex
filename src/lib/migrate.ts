import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Sql } from "./db";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "db/migrations");
const LOCK_KEY = 726354901;

/** Applies pending SQL migrations in filename order, each in its own transaction. */
export async function migrate(sql: Sql, dir = MIGRATIONS_DIR): Promise<string[]> {
  // Session-level advisory locks need one dedicated connection, not the pool.
  const conn = await sql.reserve();
  try {
    await conn`SELECT pg_advisory_lock(${LOCK_KEY})`;
    await conn`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const applied = new Set((await conn<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    const ran: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const body = await readFile(path.join(dir, file), "utf8");
      await conn.unsafe("BEGIN");
      try {
        await conn.unsafe(body);
        await conn`INSERT INTO schema_migrations (name) VALUES (${file})`;
        await conn.unsafe("COMMIT");
      } catch (err) {
        await conn.unsafe("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      ran.push(file);
    }
    return ran;
  } finally {
    await conn`SELECT pg_advisory_unlock(${LOCK_KEY})`.catch(() => {});
    conn.release();
  }
}
