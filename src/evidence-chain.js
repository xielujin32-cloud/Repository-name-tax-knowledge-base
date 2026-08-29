import { createHash, randomUUID } from 'node:crypto';

export const VERIFICATION_STATES = Object.freeze(['discovered', 'normalized', 'pending_review', 'verified', 'legacy', 'rejected']);
export const LEGAL_STATUSES = Object.freeze(['effective', 'partially_effective', 'repealed', 'expired', 'pending']);
export const COLLECTION_STATES = Object.freeze(['queued', 'running', 'completed', 'failed', 'cancelled']);
export const POLICY_RELATION_TYPES = Object.freeze(['supersedes', 'superseded_by', 'amends', 'amended_by', 'repeals', 'repealed_by', 'extends', 'interprets', 'implements', 'same_instrument', 'duplicate_candidate']);

function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

function required(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${label} 不能为空。`);
  return text;
}

function status(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`${label} 无效：${value}`);
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function canonicalizeOfficialUrl(value) {
  const url = new URL(required(value, 'official_url'));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('official_url 必须使用 http 或 https。');
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  return url.toString();
}

export function createMemoryObjectStore() {
  const values = new Map();
  return Object.freeze({
    putImmutable(key, value) {
      const objectKey = required(key, 'object_key');
      if (values.has(objectKey)) throw new Error(`原始对象不可覆盖：${objectKey}`);
      values.set(objectKey, typeof value === 'string' ? value : copy(value));
      return objectKey;
    },
    read(key) {
      return copy(values.get(key));
    },
    has(key) {
      return values.has(key);
    }
  });
}

/**
 * Phase 1 的本地/测试 Repository abstraction。
 * 不依赖 Netlify Blobs，不会写入任何生产 Store；后续可由 PostgreSQL 与对象存储实现同一接口。
 */
export function createEvidenceRepository({ objectStore = createMemoryObjectStore(), now = () => new Date().toISOString(), id = (prefix) => `${prefix}-${randomUUID()}` } = {}) {
  const sources = new Map();
  const sourceStates = new Map();
  const collectionRuns = new Map();
  const snapshots = new Map();
  const candidates = new Map();
  const reviews = new Map();
  const policies = new Map();
  const policyVersions = new Map();
  const policyRelations = new Map();

  const get = (map, entityId, label) => {
    const value = map.get(required(entityId, `${label}_id`));
    if (!value) throw new Error(`${label} 不存在：${entityId}`);
    return value;
  };
  const newId = (prefix, requested) => required(requested || id(prefix), `${prefix}_id`);
  const snapshotFor = (snapshotId) => get(snapshots, snapshotId, 'snapshot');

  function addSource(input) {
    const sourceId = newId('source', input.source_id);
    if (sources.has(sourceId)) throw new Error(`source 已存在：${sourceId}`);
    const officialDomain = String(input.official_domain || new URL(input.base_url || input.official_url).hostname).toLowerCase();
    const source = freeze({
      source_id: sourceId,
      source_name: required(input.source_name, 'source_name'),
      official_domain: required(officialDomain, 'official_domain'),
      source_type: required(input.source_type || 'official_policy_library', 'source_type'),
      adapter_version: required(input.adapter_version || '1.0.0', 'adapter_version'),
      base_url: input.base_url ? canonicalizeOfficialUrl(input.base_url) : null,
      enabled: input.enabled !== false,
      created_at: now()
    });
    const sourceState = { source_id: sourceId, scan_cursor: null, high_watermark_date: null, last_checked_at: null, last_success_at: null, last_full_scan_at: null, last_error: null, etag: null, last_modified: null, updated_at: now() };
    sources.set(sourceId, source);
    sourceStates.set(sourceId, sourceState);
    return copy(source);
  }

  function updateSourceState(sourceId, patch = {}) {
    const state = get(sourceStates, sourceId, 'source_state');
    const allowed = ['scan_cursor', 'high_watermark_date', 'last_checked_at', 'last_success_at', 'last_full_scan_at', 'last_error', 'etag', 'last_modified'];
    for (const field of allowed) if (field in patch) state[field] = patch[field] ?? null;
    state.updated_at = now();
    return copy(state);
  }

  function createCollectionRun({ source_id, collection_run_id, mode = 'manual', collection_state = 'running', started_at = now() }) {
    get(sources, source_id, 'source');
    const runId = newId('collection-run', collection_run_id);
    if (collectionRuns.has(runId)) throw new Error(`collection_run 已存在：${runId}`);
    const run = { collection_run_id: runId, source_id, mode: required(mode, 'mode'), collection_state: status(collection_state, COLLECTION_STATES, 'collection_state'), started_at, completed_at: null, discovered_count: 0, snapshot_ids: [], errors: [] };
    collectionRuns.set(runId, run);
    return copy(run);
  }

  function finishCollectionRun(collectionRunId, { collection_state = 'completed', error = null } = {}) {
    const run = get(collectionRuns, collectionRunId, 'collection_run');
    run.collection_state = status(collection_state, COLLECTION_STATES, 'collection_state');
    run.completed_at = now();
    if (error) run.errors.push(String(error));
    return copy(run);
  }

  function recordRawSnapshot(input) {
    const run = get(collectionRuns, input.collection_run_id, 'collection_run');
    const source = get(sources, input.source_id, 'source');
    if (run.source_id !== source.source_id) throw new Error('collection_run 与 source 不匹配。');
    const snapshotId = newId('snapshot', input.snapshot_id);
    if (snapshots.has(snapshotId)) throw new Error(`raw_snapshot 不可覆盖：${snapshotId}`);
    const officialUrl = canonicalizeOfficialUrl(input.official_url);
    const canonicalUrl = canonicalizeOfficialUrl(input.canonical_url || officialUrl);
    const rawContent = String(input.raw_content ?? '');
    const normalizedText = String(input.normalized_text ?? rawContent);
    const rawObjectKey = `raw-snapshots/${snapshotId}/raw`;
    const normalizedObjectKey = `raw-snapshots/${snapshotId}/normalized-text`;
    objectStore.putImmutable(rawObjectKey, rawContent);
    objectStore.putImmutable(normalizedObjectKey, normalizedText);
    const previous = [...snapshots.values()].filter((item) => item.source_id === source.source_id && item.canonical_url === canonicalUrl).at(-1) || null;
    const snapshot = freeze({
      snapshot_id: snapshotId,
      source_id: source.source_id,
      collection_run_id: run.collection_run_id,
      official_url: officialUrl,
      canonical_url: canonicalUrl,
      fetched_at: input.fetched_at || now(),
      http_status: Number(input.http_status ?? 200),
      response_headers_subset: copy(input.response_headers_subset || {}),
      content_type: required(input.content_type || 'text/html', 'content_type'),
      raw_object_key: rawObjectKey,
      normalized_text_object_key: normalizedObjectKey,
      raw_sha256: sha256(rawContent),
      normalized_text_sha256: sha256(normalizedText),
      parser_version: required(input.parser_version || '1.0.0', 'parser_version'),
      parse_result_hash: sha256(stable(input.parse_result || {})),
      previous_snapshot_id: previous?.snapshot_id || null,
      content_changed: previous ? previous.normalized_text_sha256 !== sha256(normalizedText) : true
    });
    snapshots.set(snapshotId, snapshot);
    run.snapshot_ids.push(snapshotId);
    run.discovered_count += 1;
    const statePatch = { last_checked_at: snapshot.fetched_at, etag: snapshot.response_headers_subset.etag || null, last_modified: snapshot.response_headers_subset['last-modified'] || null };
    if (snapshot.http_status >= 200 && snapshot.http_status < 400) statePatch.last_success_at = snapshot.fetched_at;
    updateSourceState(source.source_id, statePatch);
    return copy(snapshot);
  }

  function createCandidate({ candidate_id, snapshot_id, parsed_fields = {}, verification_state = 'discovered', legal_status = 'pending', legacy = false }) {
    const snapshot = snapshotFor(snapshot_id);
    const verification = status(legacy ? 'legacy' : verification_state, VERIFICATION_STATES, 'verification_state');
    const legal = status(legal_status, LEGAL_STATUSES, 'legal_status');
    const existing = [...candidates.values()].find((candidate) => candidate.canonical_url === snapshot.canonical_url && candidate.normalized_text_sha256 === snapshot.normalized_text_sha256 && candidate.verification_state !== 'rejected');
    if (existing) {
      if (!existing.observed_snapshot_ids.includes(snapshot.snapshot_id)) existing.observed_snapshot_ids.push(snapshot.snapshot_id);
      existing.last_seen_snapshot_id = snapshot.snapshot_id;
      return { candidate: copy(existing), created: false };
    }
    const candidateId = newId('candidate', candidate_id);
    if (candidates.has(candidateId)) throw new Error(`candidate 已存在：${candidateId}`);
    const candidate = {
      candidate_id: candidateId,
      snapshot_id: snapshot.snapshot_id,
      observed_snapshot_ids: [snapshot.snapshot_id],
      last_seen_snapshot_id: snapshot.snapshot_id,
      source_id: snapshot.source_id,
      collection_run_id: snapshot.collection_run_id,
      official_url: snapshot.official_url,
      canonical_url: snapshot.canonical_url,
      normalized_text_sha256: snapshot.normalized_text_sha256,
      parsed_fields: copy(parsed_fields),
      verification_state: verification,
      legal_status: legal,
      review_decision_ids: [],
      created_at: now(),
      updated_at: now()
    };
    candidates.set(candidateId, candidate);
    return { candidate: copy(candidate), created: true };
  }

  function transitionCandidate(candidateId, verificationState) {
    const candidate = get(candidates, candidateId, 'candidate');
    const next = status(verificationState, VERIFICATION_STATES, 'verification_state');
    if (next === 'verified') throw new Error('candidate 不能直接转为 verified，必须由 Level 3 review 决定。');
    if (candidate.verification_state === 'legacy' && next === 'verified') throw new Error('legacy 数据不得自动成为 verified。');
    candidate.verification_state = next;
    candidate.updated_at = now();
    return copy(candidate);
  }

  function recordReviewDecision({ review_decision_id, candidate_id, reviewer_level, decision, legal_status, note = '', evidence_snapshot_ids = [] }) {
    const candidate = get(candidates, candidate_id, 'candidate');
    const level = Number(reviewer_level);
    if (![1, 2, 3].includes(level)) throw new Error('reviewer_level 必须为 1、2 或 3。');
    if (!['approve', 'reject', 'return'].includes(decision)) throw new Error('review decision 无效。');
    const reviewId = newId('review', review_decision_id);
    if (reviews.has(reviewId)) throw new Error(`review_decision 已存在：${reviewId}`);
    const snapshotIds = [...new Set([candidate.snapshot_id, ...evidence_snapshot_ids])];
    for (const snapshotId of snapshotIds) snapshotFor(snapshotId);
    const review = freeze({ review_decision_id: reviewId, candidate_id: candidate.candidate_id, reviewer_level: level, decision, legal_status: legal_status ? status(legal_status, LEGAL_STATUSES, 'legal_status') : candidate.legal_status, note: String(note), evidence_snapshot_ids: snapshotIds, decided_at: now() });
    reviews.set(reviewId, review);
    candidate.review_decision_ids.push(reviewId);
    candidate.legal_status = review.legal_status;
    candidate.verification_state = decision === 'reject' ? 'rejected' : (decision === 'approve' && level === 3 ? 'verified' : 'pending_review');
    candidate.updated_at = now();
    return copy(review);
  }

  function createPolicy({ policy_id, canonical_title, legal_status = 'pending', verification_state = 'discovered' }) {
    const policyId = newId('policy', policy_id);
    if (policies.has(policyId)) throw new Error(`policy 已存在：${policyId}`);
    const policy = { policy_id: policyId, canonical_title: required(canonical_title, 'canonical_title'), legal_status: status(legal_status, LEGAL_STATUSES, 'legal_status'), verification_state: status(verification_state, VERIFICATION_STATES, 'verification_state'), current_policy_version_id: null, source_ids: [], created_at: now(), updated_at: now() };
    policies.set(policyId, policy);
    return copy(policy);
  }

  function createPolicyVersion({ policy_version_id, policy_id, review_decision_id, version_number, document_no = null, title = null, effective_date = null, expiry_date = null }) {
    const policy = get(policies, policy_id, 'policy');
    const review = get(reviews, review_decision_id, 'review_decision');
    const candidate = get(candidates, review.candidate_id, 'candidate');
    if (review.decision !== 'approve' || review.reviewer_level !== 3 || candidate.verification_state !== 'verified') throw new Error('policy_version 必须基于 Level 3 批准的 verified candidate。');
    const versionId = newId('policy-version', policy_version_id);
    if (policyVersions.has(versionId)) throw new Error(`policy_version 已存在：${versionId}`);
    const policyVersion = { policy_version_id: versionId, policy_id: policy.policy_id, version_number: Number(version_number || [...policyVersions.values()].filter((item) => item.policy_id === policy.policy_id).length + 1), review_decision_id: review.review_decision_id, candidate_id: candidate.candidate_id, snapshot_id: candidate.snapshot_id, source_id: candidate.source_id, official_url: candidate.official_url, canonical_url: candidate.canonical_url, title: title || candidate.parsed_fields.title || policy.canonical_title, document_no, legal_status: review.legal_status, verification_state: candidate.verification_state, effective_date, expiry_date, source_links: [{ source_id: candidate.source_id, snapshot_id: candidate.snapshot_id, official_url: candidate.official_url }], created_at: now() };
    policyVersions.set(versionId, policyVersion);
    policy.current_policy_version_id = versionId;
    policy.legal_status = policyVersion.legal_status;
    policy.verification_state = policyVersion.verification_state;
    policy.source_ids = [...new Set([...policy.source_ids, candidate.source_id])];
    policy.updated_at = now();
    return copy(policyVersion);
  }

  function createPolicyRelation({ policy_relation_id, from_policy_version_id, to_policy_version_id, relation_type, review_decision_id = null, evidence_snapshot_id = null, relation_state = 'proposed' }) {
    const from = get(policyVersions, from_policy_version_id, 'policy_version');
    const to = get(policyVersions, to_policy_version_id, 'policy_version');
    if (from.policy_version_id === to.policy_version_id) throw new Error('policy_relation 不能指向自身。');
    const relationId = newId('policy-relation', policy_relation_id);
    if (policyRelations.has(relationId)) throw new Error(`policy_relation 已存在：${relationId}`);
    status(relation_type, POLICY_RELATION_TYPES, 'relation_type');
    if (evidence_snapshot_id) snapshotFor(evidence_snapshot_id);
    if (relation_state === 'confirmed') {
      const review = get(reviews, review_decision_id, 'review_decision');
      if (review.reviewer_level !== 3 || review.decision !== 'approve') throw new Error('确认 policy_relation 必须有 Level 3 批准记录。');
    }
    const relation = freeze({ policy_relation_id: relationId, from_policy_version_id: from.policy_version_id, to_policy_version_id: to.policy_version_id, relation_type, relation_state, review_decision_id, evidence_snapshot_id, created_at: now() });
    policyRelations.set(relationId, relation);
    return copy(relation);
  }

  function tracePolicy(policyId) {
    const policy = get(policies, policyId, 'policy');
    const version = policy.current_policy_version_id ? get(policyVersions, policy.current_policy_version_id, 'policy_version') : null;
    const review = version ? get(reviews, version.review_decision_id, 'review_decision') : null;
    const candidate = review ? get(candidates, review.candidate_id, 'candidate') : null;
    const snapshot = candidate ? snapshotFor(candidate.snapshot_id) : null;
    const run = snapshot ? get(collectionRuns, snapshot.collection_run_id, 'collection_run') : null;
    const source = snapshot ? get(sources, snapshot.source_id, 'source') : null;
    return copy({ policy, policy_version: version, review_decision: review, candidate, raw_snapshot: snapshot, collection_run: run, source, official_url: snapshot?.official_url || null });
  }

  return Object.freeze({
    addSource, updateSourceState, createCollectionRun, finishCollectionRun, recordRawSnapshot, createCandidate, transitionCandidate,
    recordReviewDecision, createPolicy, createPolicyVersion, createPolicyRelation, tracePolicy,
    readSnapshot: (snapshotId) => copy(snapshotFor(snapshotId)), readRawObject: (key) => objectStore.read(key), readSourceState: (sourceId) => copy(get(sourceStates, sourceId, 'source_state')),
    counts: () => ({ source: sources.size, collection_run: collectionRuns.size, raw_snapshot: snapshots.size, candidate: candidates.size, review_decision: reviews.size, policy: policies.size, policy_version: policyVersions.size, policy_relation: policyRelations.size })
  });
}
