import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1).default("postgres://postgres@localhost:5432/fi_library"),
  DATABASE_SSL: z.enum(["disable", "require", "no-verify"]).default("disable"),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),

  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default("./data/storage"),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("false"),

  ADMIN_USERNAME: z.string().default("admin"),
  // scrypt hash produced by `pnpm admin:hash-password`. Admin login is disabled when unset.
  ADMIN_PASSWORD_HASH: z.string().optional(),
  SESSION_SECRET: z.string().optional(),

  CRAWLER_USER_AGENT: z
    .string()
    .default("FIRegLibraryBot/0.1 (+research library of Indian foreign-investment regulations)"),
  CRAWLER_MIN_INTERVAL_MS: z.coerce.number().int().min(250).default(2000),
  CRAWLER_TIMEOUT_MS: z.coerce.number().int().min(1000).default(45_000),
  CRAWLER_MAX_BYTES: z.coerce.number().int().min(1024).default(80 * 1024 * 1024),
  CRAWLER_RESPECT_ROBOTS: z.enum(["true", "false"]).default("true"),
  // Comma-separated extra hostnames the fetcher may contact (in addition to authority domains).
  CRAWLER_EXTRA_ALLOWED_HOSTS: z.string().default(""),

  OCR_ENABLED: z.enum(["true", "false"]).default("true"),
  OCR_LANGUAGES: z.string().default("eng"),
  OCR_MAX_PAGES: z.coerce.number().int().min(1).default(60),

  ALERT_WEBHOOK_URL: z.string().url().optional().or(z.literal("")),
  ALERT_FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(3),

  PUBLIC_SITE_URL: z.string().default("http://localhost:3000"),
  SERVE_ORIGINAL_FILES: z.enum(["true", "false"]).default("true"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Invalid environment configuration: ${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

export function resetEnvCache() {
  cached = undefined;
}
