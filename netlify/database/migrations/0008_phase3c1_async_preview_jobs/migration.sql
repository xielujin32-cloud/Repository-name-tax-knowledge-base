-- Durable audit-only execution records for Phase 3C1 background previews.
-- They are intentionally separate from manifests, candidates, snapshots and
-- projections: a preview job may not create any Evidence business object.
CREATE TABLE phase3c1_preview_jobs (
  job_id TEXT PRIMARY KEY,
  phase TEXT NOT NULL CHECK (phase = 'phase3c1'),
  job_mode TEXT NOT NULL CHECK (job_mode = 'production_preview'),
  job_state TEXT NOT NULL CHECK (job_state IN ('queued','running','passed','blocked','failed')),
  selection_rule_version TEXT NOT NULL,
  candidate_pool_version TEXT NOT NULL,
  candidate_pool_hash TEXT NOT NULL CHECK (candidate_pool_hash ~ '^[a-f0-9]{64}$'),
  selection_input JSONB NOT NULL CHECK (jsonb_typeof(selection_input) = 'object'),
  selection_hash TEXT NOT NULL CHECK (selection_hash ~ '^[a-f0-9]{64}$'),
  selected_items JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(selected_items) = 'array'),
  skip_audit JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(skip_audit) = 'array'),
  completed_count SMALLINT NOT NULL DEFAULT 0 CHECK (completed_count BETWEEN 0 AND 10),
  total_count SMALLINT NOT NULL DEFAULT 10 CHECK (total_count = 10),
  current_ordinal SMALLINT,
  failure_code TEXT,
  safe_failure JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(safe_failure) = 'object'),
  result_hash TEXT CHECK (result_hash IS NULL OR result_hash ~ '^[a-f0-9]{64}$'),
  preview_job_audit_writes INTEGER NOT NULL DEFAULT 1 CHECK (preview_job_audit_writes >= 1),
  business_production_writes INTEGER NOT NULL DEFAULT 0 CHECK (business_production_writes = 0),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX phase3c1_preview_jobs_one_active_selection
  ON phase3c1_preview_jobs(selection_hash) WHERE job_state IN ('queued','running');
CREATE INDEX phase3c1_preview_jobs_state_created_idx ON phase3c1_preview_jobs(job_state, created_at DESC);

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
  IF OLD.job_state IN ('passed','blocked','failed') THEN RAISE EXCEPTION 'phase3c1 preview job is terminal'; END IF;
  IF OLD.job_state = 'queued' AND NEW.job_state NOT IN ('queued','running','failed') THEN RAISE EXCEPTION 'invalid queued transition'; END IF;
  IF OLD.job_state = 'running' AND NEW.job_state NOT IN ('running','passed','blocked','failed') THEN RAISE EXCEPTION 'invalid running transition'; END IF;
  IF NEW.completed_count < OLD.completed_count THEN RAISE EXCEPTION 'preview progress may not move backwards'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER phase3c1_preview_jobs_protected BEFORE UPDATE OR DELETE ON phase3c1_preview_jobs
  FOR EACH ROW EXECUTE FUNCTION protect_phase3c1_preview_job();
