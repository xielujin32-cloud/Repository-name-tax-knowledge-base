-- Level 3 review metadata is kept with the decision, not by altering the
-- immutable source evidence or by writing directly to the public projection.
ALTER TABLE review_decisions
  ADD COLUMN IF NOT EXISTS reviewer_id TEXT NOT NULL DEFAULT 'netlify-admin';

ALTER TABLE review_decisions
  ADD COLUMN IF NOT EXISTS confirmed_fields JSONB NOT NULL DEFAULT '{}'::jsonb;

-- A candidate can receive at most one Level 3 approval and can create only
-- one Policy Version. These constraints make repeated Approve requests safe.
CREATE UNIQUE INDEX IF NOT EXISTS review_decisions_level3_approve_candidate_unique
  ON review_decisions(candidate_id)
  WHERE reviewer_level = 3 AND decision = 'approve';

CREATE UNIQUE INDEX IF NOT EXISTS policy_versions_candidate_unique
  ON policy_versions(candidate_id);
