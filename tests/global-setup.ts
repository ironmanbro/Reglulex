import postgres from "postgres";
import { migrate } from "../src/lib/migrate";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/fi_library_test";

/** Recreates the test database schema from migrations before the suite runs. */
export default async function setup() {
  const sql = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await migrate(sql as never);
  await sql.end();
}
