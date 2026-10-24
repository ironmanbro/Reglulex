import type { Sql } from "@/lib/db";

export interface Job {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  dedupe_key: string | null;
}

export interface EnqueueOptions {
  dedupeKey?: string;
  priority?: number;
  runAfter?: Date;
  maxAttempts?: number;
}

/**
 * Adds a job. With a dedupe key, at most one queued-or-running job exists per key, so
 * enqueueing the same work twice (overlapping scheduler ticks, double clicks) is a no-op.
 */
export async function enqueue(sql: Sql, kind: string, payload: Record<string, unknown>, opts: EnqueueOptions = {}): Promise<number | null> {
  const rows = await sql<{ id: number }[]>`
    INSERT INTO jobs (kind, payload, dedupe_key, priority, run_after, max_attempts)
    VALUES (${kind}, ${sql.json(payload as never)}, ${opts.dedupeKey ?? null}, ${opts.priority ?? 100},
            ${opts.runAfter ?? new Date()}, ${opts.maxAttempts ?? 5})
    ON CONFLICT (dedupe_key) WHERE status IN ('queued','running') DO NOTHING
    RETURNING id`;
  return rows[0]?.id ?? null;
}

export async function claim(sql: Sql, workerId: string): Promise<Job | null> {
  const rows = await sql<Job[]>`
    UPDATE jobs SET status = 'running', locked_at = now(), locked_by = ${workerId}, attempts = attempts + 1, updated_at = now()
    WHERE id = (
      SELECT id FROM jobs WHERE status = 'queued' AND run_after <= now()
      ORDER BY priority, run_after, id
      FOR UPDATE SKIP LOCKED LIMIT 1
    )
    RETURNING id, kind, payload, attempts, max_attempts, dedupe_key`;
  return rows[0] ?? null;
}

export async function complete(sql: Sql, id: number) {
  await sql`UPDATE jobs SET status = 'done', finished_at = now(), updated_at = now(), locked_at = NULL, last_error = NULL WHERE id = ${id}`;
}

export function backoffSeconds(attempts: number): number {
  return Math.min(6 * 3600, 30 * 2 ** Math.max(0, attempts - 1));
}

/** Retries with exponential backoff, or moves the job to the dead-letter state. Returns true if dead. */
export async function fail(sql: Sql, job: Job, error: string, retryable = true): Promise<boolean> {
  const dead = !retryable || job.attempts >= job.max_attempts;
  if (dead) {
    await sql`UPDATE jobs SET status = 'dead', last_error = ${error.slice(0, 4000)}, finished_at = now(), updated_at = now(), locked_at = NULL WHERE id = ${job.id}`;
  } else {
    await sql`UPDATE jobs SET status = 'queued', last_error = ${error.slice(0, 4000)}, locked_at = NULL, locked_by = NULL,
              run_after = now() + make_interval(secs => ${backoffSeconds(job.attempts)}), updated_at = now() WHERE id = ${job.id}`;
  }
  return dead;
}

/** Requeues jobs whose worker died mid-run (lock older than the timeout). */
export async function reclaimStale(sql: Sql, timeoutMinutes = 45): Promise<number> {
  const rows = await sql`
    UPDATE jobs SET
      status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
      last_error = coalesce(last_error, '') || ' [lock expired: worker stopped or timed out]',
      locked_at = NULL, locked_by = NULL, updated_at = now(),
      finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END
    WHERE status = 'running' AND locked_at < now() - make_interval(mins => ${timeoutMinutes})
    RETURNING id`;
  return rows.length;
}

/** Admin action: put a dead job back in the queue with a fresh attempt budget. */
export async function retryDead(sql: Sql, id: number): Promise<boolean> {
  const rows = await sql`
    UPDATE jobs SET status = 'queued', attempts = 0, run_after = now(), finished_at = NULL, updated_at = now()
    WHERE id = ${id} AND status = 'dead'
      AND (dedupe_key IS NULL OR NOT EXISTS (
        SELECT 1 FROM jobs j2 WHERE j2.dedupe_key = jobs.dedupe_key AND j2.status IN ('queued','running')))
    RETURNING id`;
  return rows.length > 0;
}
