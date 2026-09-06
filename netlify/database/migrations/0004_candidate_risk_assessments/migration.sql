CREATE TABLE IF NOT EXISTS candidate_risk_assessments (
  assessment_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id) ON DELETE RESTRICT,
  rule_version TEXT NOT NULL,
  input_body_sha256 TEXT NOT NULL CHECK (input_body_sha256 ~ '^[a-f0-9]{64}$'),
  parser_version TEXT NOT NULL,
  input_context_sha256 TEXT NOT NULL CHECK (input_context_sha256 ~ '^[a-f0-9]{64}$'),
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
  risk_score SMALLINT NOT NULL CHECK (risk_score >= 0 AND risk_score <= 100),
  risk_reasons JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(risk_reasons) = 'array'),
  quality_metrics JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(quality_metrics) = 'object'),
  assessed_at TIMESTAMPTZ NOT NULL,
  supersedes_assessment_id TEXT REFERENCES candidate_risk_assessments(assessment_id) ON DELETE RESTRICT,
  is_current BOOLEAN NOT NULL DEFAULT true,
  superseded_at TIMESTAMPTZ NULL
);

-- A repeated assessment of the current Candidate content and rule set must
-- reuse the existing result. Historical results remain available when a body
-- or parser changes and later returns to an earlier value.
CREATE UNIQUE INDEX IF NOT EXISTS candidate_risk_assessments_current_identity_unique
  ON candidate_risk_assessments(candidate_id, input_body_sha256, parser_version, input_context_sha256, rule_version)
  WHERE is_current;

CREATE UNIQUE INDEX IF NOT EXISTS candidate_risk_assessments_one_current_per_candidate
  ON candidate_risk_assessments(candidate_id)
  WHERE is_current;

CREATE INDEX IF NOT EXISTS candidate_risk_assessments_candidate_history_idx
  ON candidate_risk_assessments(candidate_id, assessed_at DESC);

CREATE INDEX IF NOT EXISTS candidate_risk_assessments_current_queue_idx
  ON candidate_risk_assessments(risk_level, risk_score, assessed_at ASC)
  WHERE is_current;

-- Risk evidence is append-only in substance. The application may only mark a
-- current assessment superseded; score, reasons and metrics can never change.
CREATE OR REPLACE FUNCTION prevent_candidate_risk_assessment_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'candidate_risk_assessment cannot be deleted: %', OLD.assessment_id;
  END IF;
  IF OLD.is_current = false THEN
    RAISE EXCEPTION 'candidate_risk_assessment is immutable once superseded: %', OLD.assessment_id;
  END IF;
  IF NEW.assessment_id IS DISTINCT FROM OLD.assessment_id
     OR NEW.candidate_id IS DISTINCT FROM OLD.candidate_id
     OR NEW.rule_version IS DISTINCT FROM OLD.rule_version
     OR NEW.input_body_sha256 IS DISTINCT FROM OLD.input_body_sha256
     OR NEW.parser_version IS DISTINCT FROM OLD.parser_version
     OR NEW.input_context_sha256 IS DISTINCT FROM OLD.input_context_sha256
     OR NEW.risk_level IS DISTINCT FROM OLD.risk_level
     OR NEW.risk_score IS DISTINCT FROM OLD.risk_score
     OR NEW.risk_reasons IS DISTINCT FROM OLD.risk_reasons
     OR NEW.quality_metrics IS DISTINCT FROM OLD.quality_metrics
     OR NEW.assessed_at IS DISTINCT FROM OLD.assessed_at
     OR NEW.supersedes_assessment_id IS DISTINCT FROM OLD.supersedes_assessment_id
     OR NEW.is_current <> false
     OR NEW.superseded_at IS NULL THEN
    RAISE EXCEPTION 'candidate_risk_assessment core fields are immutable: %', OLD.assessment_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS candidate_risk_assessments_immutable ON candidate_risk_assessments;
CREATE TRIGGER candidate_risk_assessments_immutable
  BEFORE UPDATE OR DELETE ON candidate_risk_assessments
  FOR EACH ROW EXECUTE FUNCTION prevent_candidate_risk_assessment_mutation();
