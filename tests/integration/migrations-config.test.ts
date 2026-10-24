import { readFileSync, existsSync } from "node:fs";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/lib/migrate";
import { TEST_DATABASE_URL } from "../global-setup";

const sql = postgres(TEST_DATABASE_URL, { max: 2, onnotice: () => {} });
afterAll(async () => sql.end());

describe("migrations", () => {
  it("are idempotent on an up-to-date database", async () => {
    expect(await migrate(sql as never)).toEqual([]);
  });
  it("apply cleanly to an empty schema", async () => {
    await sql.unsafe("DROP SCHEMA IF EXISTS mtest CASCADE; CREATE SCHEMA mtest;");
    const scoped = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {}, connection: { search_path: "mtest,public" } });
    try {
      const ran = await migrate(scoped as never);
      expect(ran).toEqual(["0001_init.sql", "0002_identifiers.sql"]);
      const [t] = await scoped`SELECT count(*)::int n FROM information_schema.tables WHERE table_schema = 'mtest'`;
      expect(t!.n).toBeGreaterThanOrEqual(20);
    } finally {
      await scoped.end();
      await sql.unsafe("DROP SCHEMA mtest CASCADE");
    }
  });
});

describe("deployment configuration", () => {
  it(".env.example documents every variable the app reads", () => {
    const example = readFileSync(".env.example", "utf8");
    const envSrc = readFileSync("src/lib/env.ts", "utf8");
    const keys = [...envSrc.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(20);
    for (const k of keys) expect(example, `missing ${k}`).toMatch(new RegExp(`^${k}=`, "m"));
    expect(example).not.toMatch(/^SESSION_SECRET=.+/m);
    expect(example).not.toMatch(/^ADMIN_PASSWORD_HASH=.+/m);
  });
  it("ships Docker, compose and platform blueprint with web, worker and health check", () => {
    for (const f of ["Dockerfile", "docker-compose.yml", "render.yaml"]) expect(existsSync(f), f).toBe(true);
    const docker = readFileSync("Dockerfile", "utf8");
    expect(docker).toMatch(/tesseract-ocr/);
    expect(docker).toMatch(/poppler-utils/);
    const render = readFileSync("render.yaml", "utf8");
    expect(render).toMatch(/type: worker/);
    expect(render).toMatch(/healthCheckPath: \/api\/health/);
  });
});
