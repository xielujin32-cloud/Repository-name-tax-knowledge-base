-- Phase 3C-2 adds durable, auditable checkpoints for the controlled Apply
-- workflow. It never creates a Policy or public projection: a successful
-- Apply stops at pending_review / pending Candidates.

ALTER TABLE controlled_import_manifests
  ADD CONSTRAINT controlled_import_manifests_id_hash_unique
  UNIQUE (controlled_manifest_id, manifest_hash);

CREATE TABLE IF NOT EXISTS controlled_import_preflights (
  preflight_id TEXT PRIMARY KEY,
  controlled_manifest_id TEXT NOT NULL,
  manifest_hash TEXT NOT NULL CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
  preview_hash TEXT NOT NULL CHECK (preview_hash ~ '^[a-f0-9]{64}$'),
  validation JSONB NOT NULL CHECK (jsonb_typeof(validation) = 'object'),
  preflight_state TEXT NOT NULL CHECK (preflight_state IN ('ready','blocked','failed','expired','consumed')),
  checked_by TEXT NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_by_apply_id TEXT,
  FOREIGN KEY (controlled_manifest_id, manifest_hash)
    REFERENCES controlled_import_manifests(controlled_manifest_id, manifest_hash) ON DELETE RESTRICT,
  UNIQUE (preflight_id, controlled_manifest_id, manifest_hash)
);
CREATE INDEX IF NOT EXISTS controlled_import_preflights_manifest_state_idx
  ON controlled_import_preflights(controlled_manifest_id, preflight_state, expires_at DESC);

CREATE TABLE IF NOT EXISTS controlled_import_apply_attempts (
  controlled_apply_id TEXT PRIMARY KEY,
  controlled_manifest_id TEXT NOT NULL,
  manifest_hash TEXT NOT NULL CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
  preflight_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  apply_state TEXT NOT NULL CHECK (apply_state IN ('running','completed','rejected','failed')),
  result JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result) = 'object'),
  failure_reason TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  FOREIGN KEY (controlled_manifest_id, manifest_hash)
    REFERENCES controlled_import_manifests(controlled_manifest_id, manifest_hash) ON DELETE RESTRICT,
  FOREIGN KEY (preflight_id, controlled_manifest_id, manifest_hash)
    REFERENCES controlled_import_preflights(preflight_id, controlled_manifest_id, manifest_hash) ON DELETE RESTRICT,
  UNIQUE (controlled_manifest_id, preflight_id)
);
CREATE INDEX IF NOT EXISTS controlled_import_apply_attempts_manifest_state_idx
  ON controlled_import_apply_attempts(controlled_manifest_id, apply_state, started_at DESC);

CREATE OR REPLACE FUNCTION prevent_controlled_import_preflight_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'controlled import preflights are retained audit records';
  END IF;
  IF NEW.preflight_id IS DISTINCT FROM OLD.preflight_id
     OR NEW.controlled_manifest_id IS DISTINCT FROM OLD.controlled_manifest_id
     OR NEW.manifest_hash IS DISTINCT FROM OLD.manifest_hash
     OR NEW.preview_hash IS DISTINCT FROM OLD.preview_hash
     OR NEW.validation IS DISTINCT FROM OLD.validation
     OR NEW.checked_by IS DISTINCT FROM OLD.checked_by
     OR NEW.checked_at IS DISTINCT FROM OLD.checked_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'controlled import preflight evidence is immutable';
  END IF;
  IF OLD.preflight_state <> 'ready' OR NEW.preflight_state NOT IN ('consumed','expired') THEN
    RAISE EXCEPTION 'controlled import preflight state transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS controlled_import_preflights_immutable ON controlled_import_preflights;
CREATE TRIGGER controlled_import_preflights_immutable
  BEFORE UPDATE OR DELETE ON controlled_import_preflights
  FOR EACH ROW EXECUTE FUNCTION prevent_controlled_import_preflight_mutation();

CREATE OR REPLACE FUNCTION prevent_controlled_import_apply_attempt_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'controlled import apply attempts are retained audit records';
  END IF;
  IF NEW.controlled_apply_id IS DISTINCT FROM OLD.controlled_apply_id
     OR NEW.controlled_manifest_id IS DISTINCT FROM OLD.controlled_manifest_id
     OR NEW.manifest_hash IS DISTINCT FROM OLD.manifest_hash
     OR NEW.preflight_id IS DISTINCT FROM OLD.preflight_id
     OR NEW.operator_id IS DISTINCT FROM OLD.operator_id
     OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'controlled import apply identity is immutable';
  END IF;
  IF OLD.apply_state <> 'running' OR NEW.apply_state NOT IN ('completed','rejected','failed') THEN
    RAISE EXCEPTION 'controlled import apply state transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS controlled_import_apply_attempts_immutable ON controlled_import_apply_attempts;
CREATE TRIGGER controlled_import_apply_attempts_immutable
  BEFORE UPDATE OR DELETE ON controlled_import_apply_attempts
  FOR EACH ROW EXECUTE FUNCTION prevent_controlled_import_apply_attempt_mutation();
