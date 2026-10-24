# Foreign Investment Regulatory Library

A searchable, automatically maintained library of Indian foreign-investment regulations (FPI, FDI, FVCI, FEMA, GIFT IFSC, foreign-investor taxation). It collects documents from official sources, keeps the original files with SHA-256 fingerprints, records every version, extracts text (with OCR for scans), classifies documents, and links amendments only where an explicit citation supports it.

> Research aid only. Not affiliated with any authority. The official documents govern.

## Architecture

```
                ┌──────────────┐  schedule + queue (Postgres)  ┌───────────────────┐
  browser ───▶  │  Next.js web │ ◀──────────── reads ───────── │   PostgreSQL      │
                │  (read-only  │                                │  documents, FTS,  │
                │  + admin)    │ ── admin actions enqueue ───▶ │  versions, jobs,  │
                └──────────────┘                                │  audit, sources   │
                                                                └─────────▲─────────┘
                ┌──────────────┐  fetch (allowlisted, robots,             │
  official ◀──  │   Worker     │  rate-limited) → store → extract → ──────┘
  sources       │ scheduler +  │  classify → link
                │ job runner   │ ──── originals ────▶ S3-compatible object storage
                └──────────────┘
```

- **One codebase, one language (TypeScript), one image.** The web app and the worker are the same Docker image started with different commands.
- **PostgreSQL** holds everything structured: the source registry, crawl runs, entries, documents, versions, extracted text, tags, relationships, the job queue (`FOR UPDATE SKIP LOCKED`), and the audit log. Full-text search uses weighted `tsvector`s plus `pg_trgm` for typo tolerance and document-number matching.
- **Object storage** (S3, Cloudflare R2, MinIO…) holds original files, content-addressed by SHA-256 and written once.
- **Worker** runs the scheduler (every minute; idempotent, deduplicated) and processes jobs: `crawl` (discovery), `process_entry` (resolve → download → store → extract → classify → link), `reconcile` (daily retries and late reference linking). It never depends on web traffic.
- **Text extraction**: `pdftotext` (poppler) per page, then Tesseract OCR when there is no text layer, with a confidence score. DOCX via mammoth, HTML via a sanitising text extractor.

### Key directories

| Path | Purpose |
|---|---|
| `db/migrations/` | SQL migrations (applied automatically by web, worker and CLI) |
| `src/ingest/connectors/` | Connector framework: `rss`, `link_index`, `sebi_listing`, `rbi_id_scan`, plus detail-page resolvers |
| `src/ingest/pipeline.ts` | Crawl runs, entry processing, versioning, duplicates, reference linking |
| `src/ingest/classify.ts` | Rule-based, explainable classification (routes, topics, relevance) |
| `src/ingest/references.ts` | Citation detection and the document's own identifiers |
| `src/lib/http/fetcher.ts` | Safe crawler HTTP client (allowlist, SSRF checks, robots.txt, retries, size caps) |
| `src/jobs/` | Queue, scheduler, worker loop, alerts |
| `src/lib/seed-data.ts` | Authorities, taxonomy, **source registry**, coverage targets |
| `src/app/` | Public site, admin area, API routes |
| `tests/` | Unit, integration (real Postgres) and browser end-to-end tests |

## Local development

Requirements: Node 20+, pnpm, PostgreSQL 14+ (with `pg_trgm` and `unaccent`, both part of standard contrib), `poppler-utils`, and `tesseract-ocr` (for OCR).

```bash
pnpm install
cp .env.example .env                   # set DATABASE_URL
createdb fi_library
pnpm db:seed                           # migrations + authorities, taxonomy, source registry
pnpm admin:hash-password               # paste output into ADMIN_PASSWORD_HASH; also set SESSION_SECRET
pnpm dev                               # http://localhost:3000
pnpm worker                            # separate terminal: scheduler + job processing
```

Manual crawl from the CLI (useful for verifying a source):

```bash
pnpm crawl sebi.rss --inline                 # discover and process now, logging each entry
pnpm crawl rbi.master_directions --mode backfill
pnpm crawl all                               # queue all enabled sources for the worker
```

## Tests

```bash
createdb fi_library_test && createdb fi_library_e2e
pnpm test          # unit + integration (needs Postgres, poppler, tesseract)
pnpm build && pnpm test:e2e   # real browser journeys against the production build
```

Tests never touch live regulator sites. A fixture transport replays synthetic pages and PDFs, which are generated at runtime and clearly marked as test data (year 2099, "TEST"/"E2E" numbering). The scanned-PDF fixture is a rendered image with no text layer, so OCR is exercised for real. If Playwright's bundled browser isn't installed, set `PW_CHROMIUM_PATH` to a Chromium binary.

## Deployment

See **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** for the checklist, platform options, backups and restore.

Summary: run the same image twice, as `web` (serves on `$PORT`, applies migrations and the idempotent seed at start) and as `worker`. Attach managed PostgreSQL and S3-compatible storage. `render.yaml` is a ready Render blueprint; `docker-compose.yml` runs the whole stack on a single VM.

## Operating the library

- **Admin**: `/admin` (scrypt password hash + signed, HttpOnly, SameSite=strict session cookie; every action re-checks the session and is written to the audit log).
- **Sources**: each source is a row with a connector kind and JSON config (URLs, link patterns, pagination). Fix a broken parser by editing the config in `/admin/sources/<id>`. URLs are validated against the authority domain allowlist.
- **Health**: `/sources` (public) and `/admin` show per-source status. A crawl that loads a page but parses zero entries is marked **parser attention**, never a silent success. `/api/health` reports database reachability, the last successful collection, failing sources and dead jobs.
- **Alerts**: set `ALERT_WEBHOOK_URL` (Slack/Discord-compatible). Alerts fire when a source first reaches `ALERT_FAILURE_THRESHOLD` consecutive failures, when a parser breaks, and when a job is dead-lettered.
- **Review**: `/admin/review` lists documents needing review (changed files, incomplete OCR, uncertain scope, possible duplicates), proposed relationships (confirm/reject with evidence) and skipped out-of-scope entries (include on demand).

### Legal-status rules enforced in code

- New documents start as **Status not yet verified**. Nothing is marked current automatically.
- A changed file creates a new version and flags review. It never changes legal status.
- "Amends / supersedes / withdraws" relationships are proposed only from an explicit citation of an identifier that resolves to **exactly one** collected document, using wording in the same sentence. Ambiguous citations stay unresolved.
- Confirming a relationship can set the target's status (amended/superseded/withdrawn) with a public note naming the evidence. "Current — verified" requires a written verification note.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Source shows **Check failing** with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` or similar | Some government sites serve incomplete TLS chains. Add the missing intermediate certificate to a bundle and set `NODE_EXTRA_CA_CERTS` on the worker. Do **not** disable TLS verification. |
| Source shows **Page changed** (parser attention) | The site's markup or URLs changed. Open the listing in a browser, update `linkPattern` / `pages` / form fields in the source config, then use "Crawl now". |
| `robots_disallowed` errors | The site's robots.txt forbids that path. Respect it; find an allowed listing or feed. |
| HTTP 403 / 429 | Increase `CRAWLER_MIN_INTERVAL_MS`; check whether the site blocks automated access (do not attempt to bypass). |
| Documents flagged `ocr_unavailable` | Worker lacks `tesseract`/`pdftoppm` (use the Docker image) or `OCR_ENABLED=false`. |
| Queue never drains / "Last job finished never" | The worker isn't running. Check the worker service logs. |
| Admin login button disabled | `ADMIN_PASSWORD_HASH` or `SESSION_SECRET` (≥32 chars) not set on the web service. |
