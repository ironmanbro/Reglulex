// Background worker: runs the scheduler and processes the job queue.
//   pnpm worker          long-running process (recommended: a dedicated worker service)
//   pnpm worker:once     one pass for cron-style platforms; exits when the queue is drained
import { closeDb, db } from "@/lib/db";
import { migrate } from "@/lib/migrate";
import { runWorker } from "@/jobs/runtime";

const once = process.argv.includes("--once");
const controller = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => controller.abort());

const sql = db();
await migrate(sql);
await runWorker(
  { sql },
  {
    once,
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
    budgetMs: Number(process.env.WORKER_ONCE_BUDGET_MS ?? 50 * 60_000),
    signal: controller.signal,
  },
);
await closeDb();
