import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvidenceRepository, createMemoryObjectStore } from '../src/evidence-chain.js';
import { policySeedPolicies } from '../src/policy-seed.js';

function fixture() {
  let counter = 0;
  const repository = createEvidenceRepository({ now: () => '2026-08-29T08:00:00.000Z', id: (prefix) => `${prefix}-${++counter}` });
  const source = repository.addSource({ source_id: 'source-sta', source_name: '国家税务总局政策法规库', official_domain: 'fgk.chinatax.gov.cn', source_type: 'official_policy_library', adapter_version: '1.0.0', base_url: 'https://fgk.chinatax.gov.cn/zcfgk/index.html' });
  const run = repository.createCollectionRun({ collection_run_id: 'run-1', source_id: source.source_id });
  return { repository, source, run };
}

function snapshot(repository, run, overrides = {}) {
  return repository.recordRawSnapshot({
    snapshot_id: overrides.snapshot_id, source_id: 'source-sta', collection_run_id: run.collection_run_id,
    official_url: 'https://fgk.chinatax.gov.cn/zcfgk/example/content.html', canonical_url: 'https://fgk.chinatax.gov.cn/zcfgk/example/content.html',
    http_status: 200, response_headers_subset: { etag: 'etag-1' }, content_type: 'text/html', raw_content: '<h1>示例政策</h1>', normalized_text: '示例政策 第一条', parser_version: 'phase1-test', parse_result: { title: '示例政策' },
    ...overrides
  });
}

test('Raw Snapshot 使用独立对象 key，不能覆盖历史原始证据', () => {
  const { repository, run } = fixture();
  const first = snapshot(repository, run, { snapshot_id: 'snapshot-1' });
  assert.equal(repository.readRawObject(first.raw_object_key), '<h1>示例政策</h1>');
  assert.throws(() => snapshot(repository, run, { snapshot_id: 'snapshot-1', raw_content: '<h1>被覆盖</h1>' }), /不可覆盖/);
  assert.equal(repository.readRawObject(first.raw_object_key), '<h1>示例政策</h1>');
});

test('相同 URL 且正文未变化会留存新 snapshot，但不会产生错误的新 candidate 或 policy', () => {
  const { repository, run } = fixture();
  const first = snapshot(repository, run, { snapshot_id: 'snapshot-1' });
  const firstCandidate = repository.createCandidate({ candidate_id: 'candidate-1', snapshot_id: first.snapshot_id, parsed_fields: { title: '示例政策' } });
  const second = snapshot(repository, run, { snapshot_id: 'snapshot-2' });
  const secondCandidate = repository.createCandidate({ candidate_id: 'candidate-2', snapshot_id: second.snapshot_id, parsed_fields: { title: '示例政策' } });
  assert.notEqual(first.snapshot_id, second.snapshot_id);
  assert.equal(second.content_changed, false);
  assert.equal(firstCandidate.created, true);
  assert.equal(secondCandidate.created, false);
  assert.equal(secondCandidate.candidate.candidate_id, 'candidate-1');
  assert.deepEqual(repository.counts(), { source: 1, collection_run: 1, raw_snapshot: 2, candidate: 1, review_decision: 0, policy: 0, policy_version: 0, policy_relation: 0 });
});

test('正文变化会形成新 snapshot 与新 candidate，但不会自动发布 policy', () => {
  const { repository, run } = fixture();
  const first = snapshot(repository, run, { snapshot_id: 'snapshot-1' });
  repository.createCandidate({ candidate_id: 'candidate-1', snapshot_id: first.snapshot_id, parsed_fields: { title: '示例政策' } });
  const changed = snapshot(repository, run, { snapshot_id: 'snapshot-2', raw_content: '<h1>示例政策修订</h1>', normalized_text: '示例政策修订 第一条' });
  const candidate = repository.createCandidate({ candidate_id: 'candidate-2', snapshot_id: changed.snapshot_id, parsed_fields: { title: '示例政策修订' }, verification_state: 'normalized' });
  assert.equal(changed.content_changed, true);
  assert.equal(candidate.created, true);
  assert.equal(repository.counts().policy, 0);
});

test('review、policy_version 与 policy 可以完整追溯到 snapshot、collection_run、source 和官方 URL', () => {
  const { repository, run } = fixture();
  const raw = snapshot(repository, run, { snapshot_id: 'snapshot-1' });
  const candidate = repository.createCandidate({ candidate_id: 'candidate-1', snapshot_id: raw.snapshot_id, parsed_fields: { title: '示例政策' }, verification_state: 'pending_review', legal_status: 'effective' }).candidate;
  const review = repository.recordReviewDecision({ review_decision_id: 'review-1', candidate_id: candidate.candidate_id, reviewer_level: 3, decision: 'approve', legal_status: 'effective', note: '已核验官方正文。' });
  const policy = repository.createPolicy({ policy_id: 'policy-1', canonical_title: '示例政策' });
  const version = repository.createPolicyVersion({ policy_version_id: 'version-1', policy_id: policy.policy_id, review_decision_id: review.review_decision_id, document_no: '税总公告2026年第1号' });
  const trace = repository.tracePolicy(policy.policy_id);
  assert.equal(version.verification_state, 'verified');
  assert.equal(trace.policy_version.policy_version_id, 'version-1');
  assert.equal(trace.review_decision.candidate_id, 'candidate-1');
  assert.equal(trace.candidate.snapshot_id, 'snapshot-1');
  assert.equal(trace.raw_snapshot.collection_run_id, 'run-1');
  assert.equal(trace.collection_run.source_id, 'source-sta');
  assert.equal(trace.source.official_domain, 'fgk.chinatax.gov.cn');
  assert.equal(trace.official_url, 'https://fgk.chinatax.gov.cn/zcfgk/example/content.html');
});

test('verification_state 与 legal_status 独立，legacy 不能自动变为 verified', () => {
  const { repository, run } = fixture();
  const raw = snapshot(repository, run, { snapshot_id: 'snapshot-legacy' });
  const legacy = repository.createCandidate({ candidate_id: 'candidate-legacy', snapshot_id: raw.snapshot_id, parsed_fields: { title: '旧政策' }, legacy: true, legal_status: 'effective' }).candidate;
  assert.equal(legacy.verification_state, 'legacy');
  assert.equal(legacy.legal_status, 'effective');
  assert.throws(() => repository.transitionCandidate(legacy.candidate_id, 'verified'), /不能直接转为 verified/);
  const levelTwo = repository.recordReviewDecision({ review_decision_id: 'review-legacy-l2', candidate_id: legacy.candidate_id, reviewer_level: 2, decision: 'approve', legal_status: 'effective' });
  assert.equal(levelTwo.reviewer_level, 2);
  assert.equal(repository.tracePolicy, repository.tracePolicy);
  assert.throws(() => repository.createPolicyVersion({ policy_id: repository.createPolicy({ policy_id: 'policy-legacy', canonical_title: '旧政策' }).policy_id, review_decision_id: levelTwo.review_decision_id }), /Level 3/);
});

test('Policy relation 需要版本与证据，confirmed relation 需要 Level 3 review', () => {
  const { repository, run } = fixture();
  const first = snapshot(repository, run, { snapshot_id: 'snapshot-1' });
  const candidate = repository.createCandidate({ candidate_id: 'candidate-1', snapshot_id: first.snapshot_id, parsed_fields: { title: '政策甲' }, verification_state: 'pending_review' }).candidate;
  const review = repository.recordReviewDecision({ review_decision_id: 'review-1', candidate_id: candidate.candidate_id, reviewer_level: 3, decision: 'approve' });
  const one = repository.createPolicy({ policy_id: 'policy-1', canonical_title: '政策甲' });
  const two = repository.createPolicy({ policy_id: 'policy-2', canonical_title: '政策乙' });
  const versionOne = repository.createPolicyVersion({ policy_version_id: 'version-1', policy_id: one.policy_id, review_decision_id: review.review_decision_id });
  const versionTwo = repository.createPolicyVersion({ policy_version_id: 'version-2', policy_id: two.policy_id, review_decision_id: review.review_decision_id });
  const relation = repository.createPolicyRelation({ policy_relation_id: 'relation-1', from_policy_version_id: versionTwo.policy_version_id, to_policy_version_id: versionOne.policy_version_id, relation_type: 'amends', relation_state: 'confirmed', review_decision_id: review.review_decision_id, evidence_snapshot_id: first.snapshot_id });
  assert.equal(relation.relation_state, 'confirmed');
  assert.equal(relation.relation_type, 'amends');
});

test('Phase 1 repository 不接触现有三条 policy seed', () => {
  const before = policySeedPolicies();
  const { repository, run } = fixture();
  const raw = snapshot(repository, run, { snapshot_id: 'snapshot-1' });
  repository.createCandidate({ candidate_id: 'candidate-1', snapshot_id: raw.snapshot_id });
  assert.deepEqual(policySeedPolicies(), before);
  assert.equal(policySeedPolicies().length, 3);
});
