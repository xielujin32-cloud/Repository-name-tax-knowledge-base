-- Phase 3C-1 freezes a server-selected import preview before any new Evidence
-- exists. It is separate from review_batch_manifests, which only operates on
-- already-created Candidates, and from all public-policy projection records.

CREATE TABLE IF NOT EXISTS controlled_import_manifests (
  controlled_manifest_id TEXT PRIMARY KEY,
  manifest_key TEXT NOT NULL UNIQUE,
  selection_criteria JSONB NOT NULL CHECK (jsonb_typeof(selection_criteria) = 'object'),
  manifest_hash TEXT NOT NULL CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
  manifest_state TEXT NOT NULL CHECK (manifest_state IN ('frozen','blocked','consumed','cancelled')) DEFAULT 'frozen',
  blocked_reason TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  blocked_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS controlled_import_manifest_items (
  controlled_manifest_item_id TEXT PRIMARY KEY,
  controlled_manifest_id TEXT NOT NULL REFERENCES controlled_import_manifests(controlled_manifest_id) ON DELETE RESTRICT,
  ordinal SMALLINT NOT NULL CHECK (ordinal >= 1 AND ordinal <= 10),
  official_url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  title TEXT NOT NULL,
  document_no TEXT NOT NULL,
  document_no_provenance JSONB NOT NULL CHECK (jsonb_typeof(document_no_provenance) = 'object'),
  issuing_authority JSONB NOT NULL CHECK (jsonb_typeof(issuing_authority) = 'array'),
  publish_date DATE NOT NULL,
  effective_date DATE,
  body_hash TEXT NOT NULL CHECK (body_hash ~ '^[a-f0-9]{64}$'),
  parser_version TEXT NOT NULL,
  risk_assessment JSONB NOT NULL CHECK (jsonb_typeof(risk_assessment) = 'object'),
  metadata_suggestion JSONB NOT NULL CHECK (jsonb_typeof(metadata_suggestion) = 'object'),
  relation_proposals JSONB NOT NULL CHECK (jsonb_typeof(relation_proposals) = 'object'),
  item_fingerprint TEXT NOT NULL CHECK (item_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (controlled_manifest_id, ordinal),
  UNIQUE (controlled_manifest_id, canonical_url)
);
CREATE INDEX IF NOT EXISTS controlled_import_manifest_items_url_idx
  ON controlled_import_manifest_items(canonical_url);
CREATE INDEX IF NOT EXISTS controlled_import_manifest_items_document_no_idx
  ON controlled_import_manifest_items(document_no);
-- This table is intentionally Phase 3C-1-specific. An official URL cannot
-- silently appear in another controlled-import manifest later.
CREATE UNIQUE INDEX IF NOT EXISTS controlled_import_manifest_items_url_global_unique
  ON controlled_import_manifest_items(canonical_url);
CREATE INDEX IF NOT EXISTS controlled_import_manifests_state_created_idx
  ON controlled_import_manifests(manifest_state, created_at DESC);

-- Frozen import evidence is append-only. A manifest can only transition away
-- from frozen by an explicit later controlled-import workflow; its identity
-- and item payload can never be rewritten.
CREATE OR REPLACE FUNCTION prevent_controlled_import_manifest_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'controlled import manifests are retained audit records';
  END IF;
  IF NEW.controlled_manifest_id IS DISTINCT FROM OLD.controlled_manifest_id
     OR NEW.manifest_key IS DISTINCT FROM OLD.manifest_key
     OR NEW.selection_criteria IS DISTINCT FROM OLD.selection_criteria
     OR NEW.manifest_hash IS DISTINCT FROM OLD.manifest_hash
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'controlled import manifest frozen fields are immutable';
  END IF;
  IF OLD.manifest_state <> 'frozen' THEN
    RAISE EXCEPTION 'controlled import manifest state is terminal: %', OLD.manifest_state;
  END IF;
  IF NEW.manifest_state NOT IN ('frozen','blocked','consumed','cancelled') THEN
    RAISE EXCEPTION 'controlled import manifest state transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS controlled_import_manifests_immutable ON controlled_import_manifests;
CREATE TRIGGER controlled_import_manifests_immutable
  BEFORE UPDATE OR DELETE ON controlled_import_manifests
  FOR EACH ROW EXECUTE FUNCTION prevent_controlled_import_manifest_mutation();

CREATE OR REPLACE FUNCTION prevent_controlled_import_manifest_item_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'controlled import manifest items are immutable audit records';
END;
$$;
DROP TRIGGER IF EXISTS controlled_import_manifest_items_immutable ON controlled_import_manifest_items;
CREATE TRIGGER controlled_import_manifest_items_immutable
  BEFORE UPDATE OR DELETE ON controlled_import_manifest_items
  FOR EACH ROW EXECUTE FUNCTION prevent_controlled_import_manifest_item_mutation();
