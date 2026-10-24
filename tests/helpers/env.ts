import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TEST_DATABASE_URL } from "../global-setup";

// Must be imported before any module that reads env(). The e2e runner sets its own
// database and storage (FIRL_E2E=1), so they are left untouched there.
if (!process.env.FIRL_E2E) {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.STORAGE_DRIVER = "local";
  process.env.STORAGE_LOCAL_DIR = mkdtempSync(path.join(tmpdir(), "firl-test-storage-"));
}
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
process.env.CRAWLER_MIN_INTERVAL_MS = "250";
process.env.SESSION_SECRET ??= "test-session-secret-0123456789abcdef0123456789";
