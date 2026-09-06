-- Phase 3B keeps batch-review control records separate from Candidate evidence
-- and from public-policy projections. None of these tables can change a
-- Candidate legal_status without the existing Level 3 review workflow.

CREATE TABLE IF NOT EXISTS candidate_relation_proposals (
  proposal_id TEXT PRIMARY KEY,
  from_candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id) ON DELETE RESTRICT,
  to_candidate_id TEXT REFERENCES candidates(candidate_id) ON DELETE RESTRICT,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('supersedes','superseded_by','amends','amended_by','repeals','repealed_by','extends','interprets','implements','same_instrument','duplicate_candidate')),
  rule_version TEXT NOT NULL,
  input_body_sha256 TEXT NOT NULL CHECK (input_body_sha256 ~ '^[a-f0-9]{64}$'),
  target_reference JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(target_reference) = 'object'),
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array'),
  confidence SMALLINT NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
  proposal_state TEXT NOT NULL CHECK (proposal_state IN ('proposed','confirmed','rejected')) DEFAULT 'proposed',
  supersedes_proposal_id TEXT REFERENCES candidate_relation_proposals(proposal_id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS candidate_relation_proposals_current_identity_unique
  ON candidate_relation_proposals(from_candidate_id, relation_type, rule_version, input_body_sha256, (target_reference::text))
  WHERE proposal_state = 'proposed';
CREATE INDEX IF NOT EXISTS candidate_relation_proposals_from_state_idx
  ON candidate_relation_proposals(from_candidate_id, proposal_state, created_at DESC);
CREATE INDEX IF NOT EXISTS candidate_relation_proposals_target_idx
  ON candidate_relation_proposals(to_candidate_id) WHERE to_candidate_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS candidate_relation_proposal_reviews (
  relation_review_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES candidate_relation_proposals(proposal_id) ON DELETE RESTRICT,
  reviewer_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('confirm','reject')),
  note TEXT NOT NULL DEFAULT '',
  decided_at TIMESTAMPTZ NOT NULL,
  UNIQUE (proposal_id)
);

CREATE TABLE IF NOT EXISTS review_batch_manifests (
  manifest_id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  filter_spec JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(filter_spec) = 'object'),
  risk_rule_version TEXT NOT NULL,
  batch_size INTEGER NOT NULL CHECK (batch_size > 0 AND batch_size <= 500),
  sample_size INTEGER NOT NULL CHECK (sample_size > 0 AND sample_size <= batch_size),
  sampling_seed TEXT NOT NULL,
  confirmation_phrase TEXT NOT NULL,
  manifest_hash TEXT NOT NULL CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
  manifest_state TEXT NOT NULL CHECK (manifest_state IN ('sample_review','ready','processing','completed','blocked','failed','cancelled')),
  blocked_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS review_batch_manifests_state_created_idx
  ON review_batch_manifests(manifest_state, created_at DESC);

CREATE TABLE IF NOT EXISTS review_batch_items (
  manifest_item_id TEXT PRIMARY KEY,
  manifest_id TEXT NOT NULL REFERENCES review_batch_manifests(manifest_id) ON DELETE RESTRICT,
  candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id) ON DELETE RESTRICT,
  assessment_id TEXT NOT NULL REFERENCES candidate_risk_assessments(assessment_id) ON DELETE RESTRICT,
  snapshot_id TEXT NOT NULL REFERENCES raw_snapshots(snapshot_id) ON DELETE RESTRICT,
  source_id TEXT NOT NULL REFERENCES sources(source_id) ON DELETE RESTRICT,
  collection_run_id TEXT NOT NULL REFERENCES collection_runs(collection_run_id) ON DELETE RESTRICT,
  input_body_sha256 TEXT NOT NULL CHECK (input_body_sha256 ~ '^[a-f0-9]{64}$'),
  parser_version TEXT NOT NULL,
  risk_rule_version TEXT NOT NULL,
  risk_level TEXT NOT NULL CHECK (risk_level = 'low'),
  risk_score SMALLINT NOT NULL CHECK (risk_score >= 0 AND risk_score < 15),
  metadata_rule_version TEXT NOT NULL,
  metadata_input_body_sha256 TEXT NOT NULL CHECK (metadata_input_body_sha256 ~ '^[a-f0-9]{64}$'),
  relation_proposal_count INTEGER NOT NULL DEFAULT 0 CHECK (relation_proposal_count = 0),
  confirmed_fields JSONB NOT NULL CHECK (jsonb_typeof(confirmed_fields) = 'object'),
  is_sample BOOLEAN NOT NULL DEFAULT false,
  item_state TEXT NOT NULL CHECK (item_state IN ('selected','sample_required','sample_approved','processing','published','failed','blocked')),
  review_decision_id TEXT REFERENCES review_decisions(review_decision_id) ON DELETE RESTRICT,
  policy_id TEXT REFERENCES policies(policy_id) ON DELETE RESTRICT,
  policy_version_id TEXT REFERENCES policy_versions(policy_version_id) ON DELETE RESTRICT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (manifest_id, candidate_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS review_batch_items_candidate_live_reservation_unique
  ON review_batch_items(candidate_id)
  WHERE item_state IN ('selected','sample_required','sample_approved','processing','failed');
CREATE INDEX IF NOT EXISTS review_batch_items_manifest_state_idx
  ON review_batch_items(manifest_id, item_state, created_at);

CREATE TABLE IF NOT EXISTS policy_projection_jobs (
  projection_job_id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES policies(policy_id) ON DELETE RESTRICT,
  policy_version_id TEXT NOT NULL REFERENCES policy_versions(policy_version_id) ON DELETE RESTRICT,
  candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id) ON DELETE RESTRICT,
  review_decision_id TEXT NOT NULL REFERENCES review_decisions(review_decision_id) ON DELETE RESTRICT,
  manifest_id TEXT REFERENCES review_batch_manifests(manifest_id) ON DELETE RESTRICT,
  projection_hash TEXT NOT NULL CHECK (projection_hash ~ '^[a-f0-9]{64}$'),
  job_state TEXT NOT NULL CHECK (job_state IN ('pending','processing','published','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ,
  UNIQUE (policy_version_id)
);
CREATE INDEX IF NOT EXISTS policy_projection_jobs_state_created_idx
  ON policy_projection_jobs(job_state, created_at);

-- A reviewed Candidate is evidence for a published policy and must not be
-- rewritten or deleted later. Pending-review Candidates retain the existing
-- controlled reparse/metadata workflow; Raw Snapshots remain immutable under
-- migration 0002.
CREATE OR REPLACE FUNCTION prevent_terminal_candidate_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'candidates are retained evidence records and cannot be deleted';
  END IF;
  IF OLD.verification_state IN ('verified', 'rejected') THEN
    RAISE EXCEPTION 'reviewed candidate is immutable: %', OLD.candidate_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS candidates_prevent_terminal_mutation ON candidates;
CREATE TRIGGER candidates_prevent_terminal_mutation
BEFORE UPDATE OR DELETE ON candidates
FOR EACH ROW EXECUTE FUNCTION prevent_terminal_candidate_mutation();

CREATE OR REPLACE FUNCTION prevent_review_decision_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'review_decisions are immutable audit records';
END;
$$;

DROP TRIGGER IF EXISTS review_decisions_prevent_mutation ON review_decisions;
CREATE TRIGGER review_decisions_prevent_mutation
BEFORE UPDATE OR DELETE ON review_decisions
FOR EACH ROW EXECUTE FUNCTION prevent_review_decision_mutation();

CREATE OR REPLACE FUNCTION prevent_policy_version_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'policy_versions are immutable historical records';
END;
$$;

DROP TRIGGER IF EXISTS policy_versions_prevent_mutation ON policy_versions;
CREATE TRIGGER policy_versions_prevent_mutation
BEFORE UPDATE OR DELETE ON policy_versions
FOR EACH ROW EXECUTE FUNCTION prevent_policy_version_mutation();
