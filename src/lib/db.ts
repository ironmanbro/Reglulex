import postgres from "postgres";
import { env } from "./env";

export type Sql = postgres.Sql<Record<string, never>>;
export type TxSql = postgres.TransactionSql<Record<string, never>>;

const globalForDb = globalThis as unknown as { __fiSql?: Sql };

export function db(): Sql {
  if (!globalForDb.__fiSql) {
    const e = env();
    globalForDb.__fiSql = postgres(e.DATABASE_URL, {
      max: e.DATABASE_POOL_MAX,
      ssl: e.DATABASE_SSL === "disable" ? false : e.DATABASE_SSL === "require" ? "require" : { rejectUnauthorized: false },
      onnotice: () => {},
      types: {
        // Return DATE columns as 'YYYY-MM-DD' strings; avoids timezone shifts.
        date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x },
        // Identity columns are bigint; values stay far below 2^53, so plain numbers are safe and simpler.
        bigint: { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
      },
    }) as unknown as Sql;
  }
  return globalForDb.__fiSql;
}

export async function closeDb() {
  if (globalForDb.__fiSql) {
    await globalForDb.__fiSql.end({ timeout: 5 });
    globalForDb.__fiSql = undefined;
  }
}
