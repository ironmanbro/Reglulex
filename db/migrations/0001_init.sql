-- Foreign Investment Regulatory Library — initial schema.
-- Conventions: stable text IDs for public documents, bigint identities elsewhere,
-- explicit CHECK constraints for every controlled vocabulary.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Immutable wrapper so unaccent can be used inside generated columns / indexes.
CREATE OR REPLACE FUNCTION immutable_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

-- ---------------------------------------------------------------------------
-- Authorities and the source registry
-- ---------------------------------------------------------------------------

CREATE TABLE authorities (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code          text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_]+$'),
  name          text NOT NULL,
  short_name    text NOT NULL,
  website       text NOT NULL,
  description   text,
  -- Domains the fetcher may contact on behalf of this authority's sources.
  allowed_domains text[] NOT NULL DEFAULT '{}',
  display_order int NOT NULL DEFAULT 100,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sources (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                  text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_.-]+$'),
  authority_id          bigint NOT NULL REFERENCES authorities(id),
  name                  text NOT NULL,
  connector             text NOT NULL,
  config                jsonb NOT NULL DEFAULT '{}',
  enabled               boolean NOT NULL DEFAULT false,
  -- How often an incremental crawl should run.
  schedule_minutes      int NOT NULL DEFAULT 360 CHECK (schedule_minutes >= 15),
  -- How often known entries are re-downloaded to detect silent replacements.
  recheck_days          int NOT NULL DEFAULT 7 CHECK (recheck_days >= 1),
  -- Whether the source's endpoint/parser has been confirmed to work against the live site.
  verification_status   text NOT NULL DEFAULT 'unverified'
                        CHECK (verification_status IN ('unverified','verified','failing','parser_attention','blocked')),
  verification_note     text,
  coverage_note         text,
  last_run_at           timestamptz,
  last_success_at       timestamptz,
  last_status           text,
  consecutive_failures  int NOT NULL DEFAULT 0,
  next_run_at           timestamptz,
  next_recheck_at       timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sources_due_idx ON sources (next_run_at) WHERE enabled;

CREATE TABLE crawl_runs (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id       bigint NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  mode            text NOT NULL CHECK (mode IN ('incremental','backfill','recheck')),
  status          text NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','success_new','success_no_new','failed','parser_attention','partial')),
  trigger         text NOT NULL DEFAULT 'schedule' CHECK (trigger IN ('schedule','admin','cli','test')),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  pages_fetched   int NOT NULL DEFAULT 0,
  pages_failed    int NOT NULL DEFAULT 0,
  entries_seen    int NOT NULL DEFAULT 0,
  entries_new     int NOT NULL DEFAULT 0,
  entries_skipped int NOT NULL DEFAULT 0,
  errors_count    int NOT NULL DEFAULT 0,
  message         text,
  stats           jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX crawl_runs_source_idx ON crawl_runs (source_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- Files and documents
-- ---------------------------------------------------------------------------

-- Content-addressed original files. Never modified after insert.
CREATE TABLE stored_files (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sha256            text NOT NULL UNIQUE CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key       text NOT NULL,
  content_type      text NOT NULL,
  file_format       text NOT NULL CHECK (file_format IN ('pdf','html','docx','doc','xlsx','txt','other')),
  size_bytes        bigint NOT NULL CHECK (size_bytes >= 0),
  original_filename text,
  first_source_url  text NOT NULL,
  downloaded_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE documents (
  id                    text PRIMARY KEY CHECK (id ~ '^d_[0-9a-z]{12}$'),
  title                 text NOT NULL,
  authority_id          bigint NOT NULL REFERENCES authorities(id),
  issuing_department    text,
  document_number       text,
  document_number_norm  text,
  document_type         text NOT NULL DEFAULT 'unknown' CHECK (document_type IN (
                          'act','rules','regulations','master_direction','master_circular','circular',
                          'notification','gazette_notification','press_note','policy','guidelines',
                          'faq','order','consultation_paper','press_release','corrigendum','amendment',
                          'clarification','form','report','other','unknown')),
  publication_date      date,
  effective_date        date,
  amendment_date        date,
  landing_url           text,
  original_url          text,
  language              text,
  legal_status          text NOT NULL DEFAULT 'pending_verification' CHECK (legal_status IN (
                          'current_verified','historical','amended','superseded','withdrawn',
                          'pending_verification','unknown')),
  legal_status_note     text,
  relevance             text NOT NULL DEFAULT 'uncertain' CHECK (relevance IN ('in_scope','uncertain','out_of_scope')),
  relevance_locked      boolean NOT NULL DEFAULT false,
  review_status         text NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed','needs_review','reviewed')),
  review_reasons        text[] NOT NULL DEFAULT '{}',
  extraction_status     text NOT NULL DEFAULT 'pending' CHECK (extraction_status IN (
                          'pending','ok','partial','ocr_ok','ocr_low_confidence','ocr_unavailable','failed','not_applicable')),
  is_foundational       boolean NOT NULL DEFAULT false,
  metadata_locked       boolean NOT NULL DEFAULT false,
  notes                 text,
  current_version_id    bigint,
  collected_at          timestamptz NOT NULL DEFAULT now(),
  last_verified_at      timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- Kept in sync by refresh_document_search(); weighted: title/number A, tags B, body C.
  search_vector         tsvector
);
CREATE INDEX documents_search_idx ON documents USING gin (search_vector);
CREATE INDEX documents_title_trgm_idx ON documents USING gin (lower(title) gin_trgm_ops);
CREATE INDEX documents_number_trgm_idx ON documents USING gin (document_number_norm gin_trgm_ops);
CREATE INDEX documents_number_norm_idx ON documents (authority_id, document_number_norm);
CREATE INDEX documents_pubdate_idx ON documents (publication_date DESC NULLS LAST);
CREATE INDEX documents_authority_idx ON documents (authority_id);
CREATE INDEX documents_created_idx ON documents (created_at DESC);

-- A document can involve several authorities in different roles.
CREATE TABLE document_authorities (
  document_id  text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  authority_id bigint NOT NULL REFERENCES authorities(id),
  role         text NOT NULL CHECK (role IN ('issuer','co_issuer','administrator','enforcer','policy_owner')),
  evidence     text,
  PRIMARY KEY (document_id, authority_id, role)
);

CREATE TABLE document_versions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id     text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_no      int NOT NULL CHECK (version_no >= 1),
  file_id         bigint NOT NULL REFERENCES stored_files(id),
  source_url      text NOT NULL,
  detected_at     timestamptz NOT NULL DEFAULT now(),
  -- 'initial' for the first capture; 'file_replaced' when the same source URL returned different bytes.
  change_kind     text NOT NULL CHECK (change_kind IN ('initial','file_replaced','admin_upload','new_source_file')),
  change_note     text,
  previous_sha256 text,
  UNIQUE (document_id, version_no),
  UNIQUE (document_id, file_id)
);
ALTER TABLE documents
  ADD CONSTRAINT documents_current_version_fk FOREIGN KEY (current_version_id)
  REFERENCES document_versions(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE extracted_texts (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version_id      bigint NOT NULL UNIQUE REFERENCES document_versions(id) ON DELETE CASCADE,
  method          text NOT NULL CHECK (method IN ('pdftotext','ocr','html','docx','text','none')),
  status          text NOT NULL CHECK (status IN (
                    'ok','partial','ocr_ok','ocr_low_confidence','ocr_unavailable','failed','not_applicable')),
  text_content    text NOT NULL DEFAULT '',
  -- Per-page text where the format has pages (PDF); NULL otherwise.
  pages           text[],
  page_count      int,
  char_count      int NOT NULL DEFAULT 0,
  ocr_confidence  real,
  language        text,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Where a document was found. One document may be listed on several official pages.
CREATE TABLE source_entries (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id        bigint NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  entry_key        text NOT NULL,
  landing_url      text,
  document_url     text,
  title_raw        text,
  date_raw         text,
  hints            jsonb NOT NULL DEFAULT '{}',
  document_id      text REFERENCES documents(id) ON DELETE SET NULL,
  state            text NOT NULL DEFAULT 'discovered' CHECK (state IN (
                     'discovered','processed','skipped_out_of_scope','download_failed','failed','excluded')),
  http_etag        text,
  http_last_modified text,
  last_sha256      text,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_checked_at  timestamptz,
  last_error       text,
  UNIQUE (source_id, entry_key)
);
CREATE INDEX source_entries_document_idx ON source_entries (document_id);
CREATE INDEX source_entries_recheck_idx ON source_entries (source_id, last_checked_at NULLS FIRST);

-- ---------------------------------------------------------------------------
-- Classification
-- ---------------------------------------------------------------------------

CREATE TABLE tags (
  code   text PRIMARY KEY CHECK (code ~ '^[a-z0-9_]+$'),
  kind   text NOT NULL CHECK (kind IN ('route','topic')),
  label  text NOT NULL,
  description text,
  display_order int NOT NULL DEFAULT 100
);

CREATE TABLE document_tags (
  document_id   text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag_code      text NOT NULL REFERENCES tags(code),
  origin        text NOT NULL CHECK (origin IN ('rule','admin','source')),
  score         real,
  matched_terms text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (document_id, tag_code)
);
CREATE INDEX document_tags_tag_idx ON document_tags (tag_code);

-- ---------------------------------------------------------------------------
-- Relationships between documents (amendment history)
-- ---------------------------------------------------------------------------

CREATE TABLE document_relationships (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  from_document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  to_document_id   text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  rel_type         text NOT NULL CHECK (rel_type IN (
                     'amends','supersedes','withdraws','corrects','consolidates','related_to','derives_authority_from')),
  -- 'proposed' = detected automatically from an explicit reference; not yet confirmed by a reviewer.
  status           text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','confirmed','rejected')),
  evidence_kind    text NOT NULL CHECK (evidence_kind IN ('explicit_reference','admin','source_metadata')),
  evidence_text    text,
  matched_reference text,
  created_by       text NOT NULL DEFAULT 'system',
  created_at       timestamptz NOT NULL DEFAULT now(),
  reviewed_at      timestamptz,
  reviewed_by      text,
  CHECK (from_document_id <> to_document_id),
  UNIQUE (from_document_id, to_document_id, rel_type)
);
CREATE INDEX document_relationships_to_idx ON document_relationships (to_document_id);

-- References found in a document's text that do not (yet) match a collected document.
CREATE TABLE document_references (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id    text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  reference_norm text NOT NULL,
  reference_text text NOT NULL,
  reference_kind text NOT NULL,
  rel_type       text NOT NULL,
  context        text,
  resolved_document_id text REFERENCES documents(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, reference_norm, rel_type)
);
CREATE INDEX document_references_norm_idx ON document_references (reference_norm) WHERE resolved_document_id IS NULL;

CREATE TABLE possible_duplicates (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_a    text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  document_b    text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  reason        text NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','merged','distinct')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  resolved_by   text,
  CHECK (document_a < document_b),
  UNIQUE (document_a, document_b)
);

-- ---------------------------------------------------------------------------
-- Operations: errors, jobs, audit, coverage
-- ---------------------------------------------------------------------------

CREATE TABLE collection_errors (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id    bigint REFERENCES sources(id) ON DELETE CASCADE,
  crawl_run_id bigint REFERENCES crawl_runs(id) ON DELETE SET NULL,
  entry_id     bigint REFERENCES source_entries(id) ON DELETE CASCADE,
  document_id  text REFERENCES documents(id) ON DELETE CASCADE,
  stage        text NOT NULL CHECK (stage IN ('fetch_index','parse_index','resolve','download','store','extract','classify','link','alert')),
  url          text,
  error_code   text,
  message      text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  resolved_by  text
);
CREATE INDEX collection_errors_open_idx ON collection_errors (created_at DESC) WHERE resolved_at IS NULL;

CREATE TABLE jobs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','dead')),
  priority     int NOT NULL DEFAULT 100,
  run_after    timestamptz NOT NULL DEFAULT now(),
  attempts     int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  dedupe_key   text,
  locked_at    timestamptz,
  locked_by    text,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
-- At most one live (queued or running) job per dedupe key: makes enqueueing idempotent.
CREATE UNIQUE INDEX jobs_dedupe_live_idx ON jobs (dedupe_key) WHERE status IN ('queued','running');
CREATE INDEX jobs_claim_idx ON jobs (priority, run_after) WHERE status = 'queued';

CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor       text NOT NULL,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text,
  before      jsonb,
  after       jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Foundational instruments we intend to hold. Used to report coverage honestly:
-- a target is "collected" only when linked to a real collected document.
CREATE TABLE coverage_targets (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  authority_code text NOT NULL REFERENCES authorities(code),
  title          text NOT NULL UNIQUE,
  document_type  text NOT NULL,
  -- Case-insensitive POSIX regex matched against collected document titles.
  title_pattern  text NOT NULL,
  notes          text,
  document_id    text REFERENCES documents(id) ON DELETE SET NULL,
  matched_at     timestamptz
);

CREATE TABLE app_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind       text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Search vector maintenance
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION refresh_document_search(p_document_id text) RETURNS void
LANGUAGE sql AS $$
  UPDATE documents d SET search_vector =
      setweight(to_tsvector('english', immutable_unaccent(coalesce(d.title, ''))), 'A')
   || setweight(to_tsvector('simple', coalesce(d.document_number, '') || ' ' || coalesce(d.document_number_norm, '')), 'A')
   || setweight(to_tsvector('english', coalesce((
        SELECT string_agg(t.label, ' ') FROM document_tags dt JOIN tags t ON t.code = dt.tag_code
        WHERE dt.document_id = d.id), '')), 'B')
   || setweight(to_tsvector('english', coalesce(d.issuing_department, '')), 'B')
   || setweight(to_tsvector('english', immutable_unaccent(left(coalesce((
        SELECT et.text_content FROM extracted_texts et WHERE et.version_id = d.current_version_id), ''), 600000))), 'C')
  WHERE d.id = p_document_id;
$$;
