-- Normalised identifiers a document is known by (its own number, title-derived citation keys).
-- References found in other documents are matched against these — never against fuzzy text.
CREATE TABLE document_identifiers (
  document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ident_norm  text NOT NULL,
  kind        text NOT NULL,
  origin      text NOT NULL DEFAULT 'derived' CHECK (origin IN ('derived','admin')),
  PRIMARY KEY (document_id, ident_norm)
);
CREATE INDEX document_identifiers_norm_idx ON document_identifiers (ident_norm);
