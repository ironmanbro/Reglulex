// Structured JSON logging. One line per event so platform log drains can parse it.
type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const lvl = (process.env.LOG_LEVEL as Level) || "info";
  return order[lvl] ?? 20;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (order[level] < threshold()) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }, (_k, v) =>
    v instanceof Error ? { name: v.name, message: v.message } : v,
  );
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => emit("debug", msg, f),
  info: (msg: string, f?: Record<string, unknown>) => emit("info", msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => emit("warn", msg, f),
  error: (msg: string, f?: Record<string, unknown>) => emit("error", msg, f),
};

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
