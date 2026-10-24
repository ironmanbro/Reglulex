import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySession } from "./auth";
import type { Sql, TxSql } from "./db";

/** Re-verifies the admin session inside every server action and admin page (defence in depth beyond middleware). */
export async function requireAdmin(): Promise<string> {
  const jar = await cookies();
  const session = await verifySession(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect("/admin/login");
  return session.u;
}

export async function audit(sql: Sql | TxSql, actor: string, action: string, entityType: string, entityId: string | number | null, before?: unknown, after?: unknown) {
  await sql`INSERT INTO audit_log (actor, action, entity_type, entity_id, before, after)
            VALUES (${actor}, ${action}, ${entityType}, ${entityId === null ? null : String(entityId)},
                    ${before === undefined ? null : sql.json(before as never)}, ${after === undefined ? null : sql.json(after as never)})`;
}
