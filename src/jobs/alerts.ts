import type { Sql } from "@/lib/db";
import { env } from "@/lib/env";
import { errorMessage, log } from "@/lib/log";

/**
 * Raises an operational alert: always logged and stored; also POSTed to ALERT_WEBHOOK_URL
 * when configured (payload carries both `text` and `content`, which Slack and Discord accept).
 */
export async function sendAlert(sql: Sql, kind: string, message: string, detail: Record<string, unknown> = {}) {
  log.error(`ALERT ${kind}: ${message}`, detail);
  await sql`INSERT INTO app_events (kind, detail) VALUES (${"alert:" + kind}, ${sql.json({ message, ...detail } as never)})`;
  const url = env().ALERT_WEBHOOK_URL;
  if (!url) return;
  const text = `[FI Regulatory Library] ${message}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, content: text, kind, ...detail }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) log.warn("alert webhook returned non-2xx", { status: res.status });
  } catch (err) {
    log.warn("alert webhook failed", { error: errorMessage(err) });
  }
}
