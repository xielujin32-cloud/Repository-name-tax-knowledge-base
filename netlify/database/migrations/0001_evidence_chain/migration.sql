CREATE TABLE IF NOT EXISTS sources (
  source_id TEXT PRIMARY KEY, source_name TEXT NOT NULL, official_domain TEXT NOT NULL, source_type TEXT NOT NULL, adapter_version TEXT NOT NULL, base_url TEXT, enabled BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS source_states (
  source_id TEXT PRIMARY KEY REFERENCES sources(source_id) ON DELETE RESTRICT, scan_cursor TEXT, high_watermark_date DATE, last_checked_at TIMESTAMPTZ, last_success_at TIMESTAMPTZ, last_full_scan_at TIMESTAMPTZ, last_error TEXT, etag TEXT, last_modified TEXT, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS collection_runs (
  collection_run_id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(source_id) ON DELETE RESTRICT, mode TEXT NOT NULL, collection_state TEXT NOT NULL CHECK (collection_state IN ('queued','running','completed','failed','cancelled')), started_at TIMESTAMPTZ NOT NULL, completed_at TIMESTAMPTZ, discovered_count INTEGER NOT NULL DEFAULT 0, errors JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS collection_runs_source_started_idx ON collection_runs(source_id, started_at DESC);
CREATE TABLE IF NOT EXISTS raw_snapshots (
  snapshot_id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(source_id) ON DELETE RESTRICT, collection_run_id TEXT NOT NULL REFERENCES collection_runs(collection_run_id) ON DELETE RESTRICT, official_url TEXT NOT NULL, canonical_url TEXT NOT NULL, fetched_at TIMESTAMPTZ NOT NULL, http_status INTEGER NOT NULL, response_headers_subset JSONB NOT NULL DEFAULT '{}'::jsonb, content_type TEXT NOT NULL, raw_object_key TEXT NOT NULL UNIQUE, normalized_text_object_key TEXT NOT NULL UNIQUE, raw_sha256 CHAR(64) NOT NULL, normalized_text_sha256 CHAR(64) NOT NULL, parser_version TEXT NOT NULL, parse_result_hash CHAR(64) NOT NULL, previous_snapshot_id TEXT REFERENCES raw_snapshots(snapshot_id) ON DELETE RESTRICT, content_changed BOOLEAN NOT NULL
);
CREATE INDEX IF NOT EXISTS raw_snapshots_url_checked_idx ON raw_snapshots(source_id, canonical_url, fetched_at DESC);
CREATE TABLE IF NOT EXISTS candidates (
  candidate_id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL REFERENCES raw_snapshots(snapshot_id) ON DELETE RESTRICT, source_id TEXT NOT NULL REFERENCES sources(source_id) ON DELETE RESTRICT, collection_run_id TEXT NOT NULL REFERENCES collection_runs(collection_run_id) ON DELETE RESTRICT, official_url TEXT NOT NULL, canonical_url TEXT NOT NULL, normalized_text_sha256 CHAR(64) NOT NULL, parsed_fields JSONB NOT NULL DEFAULT '{}'::jsonb, verification_state TEXT NOT NULL CHECK (verification_state IN ('discovered','normalized','pending_review','verified','legacy','rejected')), legal_status TEXT NOT NULL CHECK (legal_status IN ('effective','partially_effective','repealed','expired','pending')), observed_snapshot_ids JSONB NOT NULL DEFAULT '[]'::jsonb, last_seen_snapshot_id TEXT NOT NULL REFERENCES raw_snapshots(snapshot_id) ON DELETE RESTRICT, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, UNIQUE (source_id, canonical_url, normalized_text_sha256)
);
CREATE INDEX IF NOT EXISTS candidates_review_idx ON candidates(verification_state, legal_status, created_at);
CREATE TABLE IF NOT EXISTS review_decisions (
  review_decision_id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id) ON DELETE RESTRICT, reviewer_level SMALLINT NOT NULL CHECK (reviewer_level IN (1,2,3)), decision TEXT NOT NULL CHECK (decision IN ('approve','reject','return')), legal_status TEXT NOT NULL CHECK (legal_status IN ('effective','partially_effective','repealed','expired','pending')), note TEXT NOT NULL DEFAULT '', evidence_snapshot_ids JSONB NOT NULL DEFAULT '[]'::jsonb, decided_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS policies (
  policy_id TEXT PRIMARY KEY, canonical_title TEXT NOT NULL, legal_status TEXT NOT NULL CHECK (legal_status IN ('effective','partially_effective','repealed','expired','pending')), verification_state TEXT NOT NULL CHECK (verification_state IN ('discovered','normalized','pending_review','verified','legacy','rejected')), current_policy_version_id TEXT, source_ids JSONB NOT NULL DEFAULT '[]'::jsonb, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS policy_versions (
  policy_version_id TEXT PRIMARY KEY, policy_id TEXT NOT NULL REFERENCES policies(policy_id) ON DELETE RESTRICT, version_number INTEGER NOT NULL, review_decision_id TEXT NOT NULL REFERENCES review_decisions(review_decision_id) ON DELETE RESTRICT, candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id) ON DELETE RESTRICT, snapshot_id TEXT NOT NULL REFERENCES raw_snapshots(snapshot_id) ON DELETE RESTRICT, source_id TEXT NOT NULL REFERENCES sources(source_id) ON DELETE RESTRICT, official_url TEXT NOT NULL, canonical_url TEXT NOT NULL, title TEXT, document_no TEXT, legal_status TEXT NOT NULL CHECK (legal_status IN ('effective','partially_effective','repealed','expired','pending')), verification_state TEXT NOT NULL CHECK (verification_state IN ('discovered','normalized','pending_review','verified','legacy','rejected')), effective_date DATE, expiry_date DATE, source_links JSONB NOT NULL DEFAULT '[]'::jsonb, created_at TIMESTAMPTZ NOT NULL, UNIQUE (policy_id, version_number)
);
ALTER TABLE policies DROP CONSTRAINT IF EXISTS policies_current_policy_version_fk;
ALTER TABLE policies ADD CONSTRAINT policies_current_policy_version_fk FOREIGN KEY (current_policy_version_id) REFERENCES policy_versions(policy_version_id) ON DELETE RESTRICT;
CREATE TABLE IF NOT EXISTS policy_relations (
  policy_relation_id TEXT PRIMARY KEY, from_policy_version_id TEXT NOT NULL REFERENCES policy_versions(policy_version_id) ON DELETE RESTRICT, to_policy_version_id TEXT NOT NULL REFERENCES policy_versions(policy_version_id) ON DELETE RESTRICT, relation_type TEXT NOT NULL CHECK (relation_type IN ('supersedes','superseded_by','amends','amended_by','repeals','repealed_by','extends','interprets','implements','same_instrument','duplicate_candidate')), relation_state TEXT NOT NULL CHECK (relation_state IN ('proposed','confirmed','rejected')), review_decision_id TEXT REFERENCES review_decisions(review_decision_id) ON DELETE RESTRICT, evidence_snapshot_id TEXT REFERENCES raw_snapshots(snapshot_id) ON DELETE RESTRICT, created_at TIMESTAMPTZ NOT NULL, CHECK (from_policy_version_id <> to_policy_version_id)
);
CREATE TABLE IF NOT EXISTS audit_events (
  audit_event_id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, event_type TEXT NOT NULL, payload JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_events_entity_idx ON audit_events(entity_type, entity_id, created_at DESC);
