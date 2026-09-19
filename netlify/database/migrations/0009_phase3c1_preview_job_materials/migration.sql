-- A passed Preview Job is the immutable source for the later frozen manifest.
-- Raw HTML and normalized text stay in protected immutable object storage; this
-- database stores only their opaque keys and cryptographic integrity hashes.
ALTER TABLE phase3c1_preview_jobs
  ADD COLUMN IF NOT EXISTS preview_selection_criteria JSONB,
  ADD COLUMN IF NOT EXISTS material_set_hash TEXT CHECK (material_set_hash IS NULL OR material_set_hash ~ '^[a-f0-9]{64}$');

CREATE TABLE IF NOT EXISTS phase3c1_preview_job_materials (
  job_id TEXT NOT NULL REFERENCES phase3c1_preview_jobs(job_id) ON DELETE RESTRICT,
  ordinal SMALLINT NOT NULL CHECK (ordinal BETWEEN 1 AND 10),
  original_rank SMALLINT NOT NULL,
  original_index SMALLINT NOT NULL,
  official_url TEXT NOT NULL,
  body_hash TEXT NOT NULL CHECK (body_hash ~ '^[a-f0-9]{64}$'),
  item_fingerprint TEXT NOT NULL CHECK (item_fingerprint ~ '^[a-f0-9]{64}$'),
  item JSONB NOT NULL CHECK (jsonb_typeof(item) = 'object'),
  material_provenance JSONB NOT NULL CHECK (jsonb_typeof(material_provenance) = 'object'),
  raw_object_key TEXT NOT NULL,
  normalized_text_object_key TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL CHECK (raw_sha256 ~ '^[a-f0-9]{64}$'),
  normalized_text_sha256 TEXT NOT NULL CHECK (normalized_text_sha256 ~ '^[a-f0-9]{64}$'),
  material_hash TEXT NOT NULL CHECK (material_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (job_id, ordinal),
  UNIQUE (job_id, official_url)
);
CREATE INDEX IF NOT EXISTS phase3c1_preview_job_materials_job_idx ON phase3c1_preview_job_materials(job_id, ordinal);

ALTER TABLE controlled_import_manifests
  ADD COLUMN IF NOT EXISTS source_preview_job_id TEXT REFERENCES phase3c1_preview_jobs(job_id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS controlled_import_manifests_source_preview_job_unique
  ON controlled_import_manifests(source_preview_job_id) WHERE source_preview_job_id IS NOT NULL;

CREATE OR REPLACE FUNCTION protect_phase3c1_preview_job()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'phase3c1 preview jobs are retained audit records'; END IF;
  IF NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.phase IS DISTINCT FROM OLD.phase
     OR NEW.job_mode IS DISTINCT FROM OLD.job_mode OR NEW.selection_rule_version IS DISTINCT FROM OLD.selection_rule_version
     OR NEW.candidate_pool_version IS DISTINCT FROM OLD.candidate_pool_version OR NEW.candidate_pool_hash IS DISTINCT FROM OLD.candidate_pool_hash
     OR NEW.selection_input IS DISTINCT FROM OLD.selection_input OR NEW.selection_hash IS DISTINCT FROM OLD.selection_hash
     OR NEW.total_count IS DISTINCT FROM OLD.total_count OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.business_production_writes <> 0 THEN RAISE EXCEPTION 'phase3c1 preview job immutable or business fields changed'; END IF;
  IF OLD.preview_selection_criteria IS NOT NULL AND NEW.preview_selection_criteria IS DISTINCT FROM OLD.preview_selection_criteria THEN RAISE EXCEPTION 'phase3c1 preview selection criteria are immutable'; END IF;
  IF OLD.material_set_hash IS NOT NULL AND NEW.material_set_hash IS DISTINCT FROM OLD.material_set_hash THEN RAISE EXCEPTION 'phase3c1 preview material set is immutable'; END IF;
  IF OLD.job_state IN ('passed','blocked','failed') THEN RAISE EXCEPTION 'phase3c1 preview job is terminal'; END IF;
  IF OLD.job_state = 'queued' AND NEW.job_state NOT IN ('queued','running','failed') THEN RAISE EXCEPTION 'invalid queued transition'; END IF;
  IF OLD.job_state = 'running' AND NEW.job_state NOT IN ('running','passed','blocked','failed') THEN RAISE EXCEPTION 'invalid running transition'; END IF;
  IF NEW.completed_count < OLD.completed_count THEN RAISE EXCEPTION 'preview progress may not move backwards'; END IF;
  IF NEW.job_state = 'passed' AND (NEW.preview_selection_criteria IS NULL OR NEW.material_set_hash IS NULL) THEN RAISE EXCEPTION 'passed preview job requires immutable material set'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION prevent_phase3c1_preview_job_material_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'phase3c1 preview job materials are immutable audit records';
END;
$$;
DROP TRIGGER IF EXISTS phase3c1_preview_job_materials_immutable ON phase3c1_preview_job_materials;
CREATE TRIGGER phase3c1_preview_job_materials_immutable
  BEFORE UPDATE OR DELETE ON phase3c1_preview_job_materials
  FOR EACH ROW EXECUTE FUNCTION prevent_phase3c1_preview_job_material_mutation();

CREATE OR REPLACE FUNCTION prevent_controlled_import_manifest_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'controlled import manifests are retained audit records'; END IF;
  IF NEW.controlled_manifest_id IS DISTINCT FROM OLD.controlled_manifest_id
     OR NEW.manifest_key IS DISTINCT FROM OLD.manifest_key
     OR NEW.source_preview_job_id IS DISTINCT FROM OLD.source_preview_job_id
     OR NEW.selection_criteria IS DISTINCT FROM OLD.selection_criteria
     OR NEW.manifest_hash IS DISTINCT FROM OLD.manifest_hash
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'controlled import manifest frozen fields are immutable';
  END IF;
  IF OLD.manifest_state <> 'frozen' THEN RAISE EXCEPTION 'controlled import manifest state is terminal: %', OLD.manifest_state; END IF;
  IF NEW.manifest_state NOT IN ('frozen','blocked','consumed','cancelled') THEN RAISE EXCEPTION 'controlled import manifest state transition is invalid'; END IF;
  RETURN NEW;
END;
$$;
