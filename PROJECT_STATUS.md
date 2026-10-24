# Project status

_Last updated: 2026-10-25 (end of build session 1)_

## Summary

The full system is built and tested: ingestion engine, database, versioning, OCR, relationship linking, job queue and scheduler, public site, protected admin area, deployment configuration and documentation.

**It has not yet collected a single real document.** The build environment's network policy blocked every regulator domain (sebi.gov.in, rbi.org.in, dpiit.gov.in, ifsca.gov.in, incometaxindia.gov.in, dea.gov.in), so no connector has run against a live site. Every source is therefore marked `unverified`. The first real crawl will happen after deployment, or in a session with network access to those domains.

## Completed

| Area | State | Verified by |
|---|---|---|
| Schema (20+ tables), migrations, constraints, FTS + trigram indexes | Done | migration tests (fresh schema + idempotent re-run) |
| Source registry (12 authorities, 13 sources, 25 tags, 14 coverage targets) | Done | idempotent seed run twice |
| Safe fetcher: allowlist, SSRF/private-IP block, redirect re-validation, robots.txt, per-host delay, retries with backoff, size cap, conditional GET | Done | 10 unit tests |
| Connectors: `rss`, `link_index` (paginated), `sebi_listing` (GET + AJAX POST paging), `rbi_id_scan` (backfill) + resolvers `sebi_detail`, `rbi_detail`, `detail_pdf`, `direct` | Done | integration tests on synthetic fixtures; **not run against live sites** |
| Pipeline: discover → store original (S3/local, SHA-256, write-once) → extract → classify → identifiers → link → index | Done | 10 end-to-end ingestion tests |
| Idempotency, cross-source dedupe, possible-duplicate detection | Done | tests |
| Version history on changed files (raw-byte hash; text hash for HTML) | Done | tests |
| PDF text per page; OCR (Tesseract) with confidence; DOCX; HTML | Done | tests incl. real OCR of an image-only PDF |
| Relationship detection from explicit citations (same-sentence cues, unique-match rule, late resolution) | Done | unit + integration tests |
| Parser-breakage detection (zero entries ≠ success), failure isolation per source | Done | tests |
| Job queue (SKIP LOCKED, dedupe keys, exponential backoff, dead-letter, stale-lock reclaim), scheduler, daily reconcile, webhook alerts | Done | 6 tests |
| Public site: home, library (search, 7 filters, sort, pagination), document page (PDF viewer, text by page, history with evidence, versions, provenance, citation copy), authorities, sources & coverage, about | Done | 8 Playwright journeys on the production build, desktop + 390 px mobile |
| Admin: login (scrypt + HMAC session, rate-limited), sources (edit JSON config with schema + domain validation, enable, crawl/backfill/recheck), crawl log, failures (retry/exclude), dead jobs, review queue (docs, scope, relationships, duplicates merge, skipped entries), document editor, tags, audit log | Done | e2e journey + auth unit tests |
| Security headers/CSP, untrusted HTML never rendered, HTML originals served as sandboxed text download, API rate limits | Done | — |
| Dockerfile (web + worker), docker-compose (Postgres + MinIO), Render blueprint, `.env.example`, README, DEPLOYMENT.md | Done | `pnpm install` + `next build` inside Docker succeed; final apt layer **not verified** (deb.debian.org blocked in build sandbox) |

**Test totals (last run):** 75 unit/integration tests passing (`pnpm test`); 8/8 browser journeys passing (`pnpm test:e2e`); production build passes; `tsc --noEmit` clean.

## Source coverage

| Source | Enabled | Endpoint evidence | Live-verified |
|---|---|---|---|
| sebi.rss | yes | URL published on SEBI's official RSS page | no |
| sebi.circulars / master_circulars / regulations | yes | Detail-URL pattern confirmed via search-engine copies; listing `ssid` values and AJAX paging fields from the public site's form, unconfirmed | no |
| rbi.notifications_rss | yes | Third-party feed directories only; RBI is migrating to a new website | no |
| rbi.master_directions | yes | `BS_ViewMasDirections.aspx?id=N` confirmed via search-engine copies | no |
| rbi.notification_id_scan | **no** | Needs an ID range set by admin | no |
| dpiit.fdi | yes | Index URL **not confirmed** | no |
| ifsca.circulars | yes | `Legal/Index/wF6kttc1JR8=` seen in search results as circulars list | no |
| ifsca.fund_management | yes | Page seen in search results | no |
| ifsca.regulations | **no** | Needs the Regulations index token | no |
| mof.fema_rules | **no** | Needs DEA listing URL | no |
| itd.notifications | **no** | Listing is client-rendered; needs a dedicated connector | no |
| ED, MCA, NSDL, CDSL, NSE, BSE | no sources | Authorities registered; add sources via admin | — |

Historical completeness is **unknown** until backfills run. Do not claim full coverage.

## Known issues / risks

1. **Unverified selectors.** The SEBI listing `ssid` values and AJAX parameters, and the DPIIT index URL, are best-effort. If wrong, the first crawl reports `failing` or `parser attention` (by design), and the fix is a config edit in `/admin/sources/<id>`.
2. **Government TLS chains.** Some sites serve incomplete certificate chains; Node will refuse them. The fix is `NODE_EXTRA_CA_CERTS` (README → Troubleshooting).
3. **Copyright/redistribution** of mirrored files has not been reviewed per authority. `SERVE_ORIGINAL_FILES=false` switches to link-only.
4. Embedded PDF viewing depends on the browser (mobile browsers often show only a fallback link, which is provided).
5. Rate limiting and politeness delays are per process.
6. Classification is keyword-based; expect some mis-tags until reviewed. AI-assisted classification is not implemented (deliberately deferred).

## Exact next steps

1. **Deploy** (docs/DEPLOYMENT.md, Option A or B). Needs: a Render (or similar) account, an R2/S3 bucket, and an admin password hash.
2. In `/admin`, press **Crawl now** on each enabled source. Triage each to `Working` or fix its config:
   - SEBI listings: if `parser attention`, open the circulars listing in a browser, confirm `sid/ssid` and the AJAX form fields (DevTools → Network), and update the config.
   - DPIIT: set `pages` to the current press-notes/FDI-policy page.
3. Run **Backfill** on SEBI listings, RBI Master Directions, DPIIT and IFSCA. Then check `/sources#coverage` for foundational instruments still missing.
4. Configure the disabled sources (IFSCA regulations token, DEA FEMA rules page, RBI ID range, Income Tax connector).
5. Review the first batch in `/admin/review`: confirm or reject proposed relationships, and set legal status with evidence for the foundational instruments.
6. Update this file with live-verification results.
