-- Phase 4 P0: retain the verified fields and source-trust attestation used by
-- the public policy index. Existing rows are deliberately non-public until
-- their originating Evidence and Level 3 decision are verified.

ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS trust_level TEXT NOT NULL DEFAULT 'unknown'
  CHECK (trust_level IN ('official_primary','official_authoritative','unknown'));

ALTER TABLE policies
  ADD COLUMN IF NOT EXISTS publication_state TEXT NOT NULL DEFAULT 'private'
  CHECK (publication_state IN ('private','eligible','published','blocked'));

ALTER TABLE policy_versions
  ADD COLUMN IF NOT EXISTS publish_date DATE,
  ADD COLUMN IF NOT EXISTS confirmed_fields JSONB NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(confirmed_fields) = 'object'),
  ADD COLUMN IF NOT EXISTS source_trust_level TEXT NOT NULL DEFAULT 'unknown'
  CHECK (source_trust_level IN ('official_primary','official_authoritative','unknown'));

CREATE INDEX IF NOT EXISTS policy_versions_document_no_idx
  ON policy_versions (document_no) WHERE document_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS policy_versions_publish_date_idx
  ON policy_versions (publish_date DESC);
CREATE INDEX IF NOT EXISTS candidates_reviewable_mvp_idx
  ON candidates (verification_state, legal_status, source_id, created_at);

-- A low-risk batch may streamline internal Evidence triage, but it cannot
-- establish a legal-effect status or publish a policy. Keep such items in an
-- explicit terminal private state rather than treating a blocked public
-- projection as a retryable operational failure.
ALTER TABLE review_batch_items
  DROP CONSTRAINT IF EXISTS review_batch_items_item_state_check;
ALTER TABLE review_batch_items
  ADD CONSTRAINT review_batch_items_item_state_check
  CHECK (item_state IN ('selected','sample_required','sample_approved','processing','reviewed_private','published','failed','blocked'));
