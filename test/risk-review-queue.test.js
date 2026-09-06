import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NetlifyDB } from '@netlify/database-dev';
import { createApiHandler } from '../netlify/functions/api.mjs';
import { applyLowRiskReviewManifest, createEvidenceAdminHandler, LOW_RISK_BATCH_CONFIRMATION_PHRASE } from '../netlify/lib/evidence-ingestion.mjs';
import { suggestEvidenceMetadata } from '../src/evidence-metadata-suggestion.js';
import { createLocalEvidenceObjectStore } from '../src/evidence-object-store.js';
import { createPostgresEvidenceRepository } from '../src/postgres-evidence-repository.js';
import { chooseSampleCandidateIds, sampleSizeForBatch } from '../src/risk-review-queue.js';

const bodyBase = `为规范个人所得税征管事项，现将有关事项公告如下。纳税人应当按照规定办理个人所得税纳税申报并保留相关资料。税务机关应当按照法定程序开展征管服务，相关主体应当如实提供资料并履行法定义务。本文明确适用对象、办理要求、资料留存和监督管理安排，确保税收政策执行有据可查。`;
const body = (suffix = '') => `${bodyBase.repeat(4)}${suffix}`;

async function openFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taxkb-risk-queue-'));
  const database = new NetlifyDB({ directory: path.join(root, 'database'), logger: () => {} });
  await database.start(); await database.reset();
  await database.applyMigrations(path.join(process.cwd(), 'netlify', 'database', 'migrations'));
  const repository = createPostgresEvidenceRepository({
    pool: database, objectStore: createLocalEvidenceObjectStore({ rootDirectory: path.join(root, 'objects') }),
    id: (prefix) => `${prefix}-${randomUUID()}`
  });
  const source = await repository.addSource({ source_id: 'source-risk-queue', source_name: '国家税务总局政策法规库', official_domain: 'fgk.chinatax.gov.cn', source_type: 'official-policy-regulations', adapter_version: 'risk-queue-test', base_url: 'https://fgk.chinatax.gov.cn/zcfgk/', enabled: true });
  const run = await repository.createCollectionRun({ source_id: source.source_id, mode: 'risk-queue-test' });
  return { root, database, repository, source, run };
}

async function closeFixture(fixture) { await fixture.database.stop(); await rm(fixture.root, { recursive: true, force: true }); }

async function seedLowCandidate(fixture, index, { content = body(), documentNo = `国家税务总局公告2026年第${index}号`, title = `风险队列测试政策${index}`, issuingAuthority = ['国家税务总局'], metadataRuleVersion = undefined, expectedRisk = 'low', collectionRun = fixture.run } = {}) {
  const url = `https://fgk.chinatax.gov.cn/zcfgk/risk-queue/${index}/content.html`;
  const snapshot = await fixture.repository.recordRawSnapshot({ source_id: fixture.source.source_id, collection_run_id: collectionRun.collection_run_id, official_url: url, canonical_url: url, http_status: 200, content_type: 'text/html', raw_content: `<article>${content}</article>`, normalized_text: content, parser_version: 'risk-queue-parser-v1', parse_result: { title } });
  const created = await fixture.repository.createCandidate({ snapshot_id: snapshot.snapshot_id, parsed_fields: { title, document_no: documentNo, issuing_authority: issuingAuthority, publish_date: '2026-09-01', tax_categories: ['个人所得税'] }, verification_state: 'pending_review', legal_status: 'pending' });
  const suggestion = suggestEvidenceMetadata({ title, normalized_text: content });
  await fixture.repository.saveMetadataSuggestion(created.candidate.candidate_id, metadataRuleVersion ? { ...suggestion, rule_version: metadataRuleVersion } : suggestion);
  const assessment = await fixture.repository.assessCandidateRisk(created.candidate.candidate_id);
  assert.equal(assessment.assessment.risk_level, expectedRisk);
  return created.candidate;
}

async function approveSample(repository, candidateId) {
  const detail = await repository.getCandidateForReview(candidateId);
  const fields = detail.candidate.parsed_fields;
  return repository.reviewCandidate(candidateId, {
    action: 'approve', legal_status: 'pending', reviewer_id: 'manual-sample-reviewer',
    confirmed_fields: { title: fields.title, document_no: fields.document_no, issuing_authority: fields.issuing_authority, publish_date: fields.publish_date, effective_date: null, expiry_date: null, tax_categories: fields.metadata_suggestion.tax_categories.values, keywords: fields.metadata_suggestion.keywords.values, summary: fields.metadata_suggestion.summary.value }
  });
}

async function call(handler, pathname, { method = 'GET', token = '', body: requestBody } = {}) {
  const response = await handler(new Request(`https://taxkb.example${pathname}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(requestBody ? { 'content-type': 'application/json' } : {}) }, body: requestBody ? JSON.stringify(requestBody) : undefined }));
  return { response, body: await response.json() };
}

test('Phase 3B 抽样数量固定为全量小批次、10 条下限和 10% 比例', () => {
  assert.equal(sampleSizeForBatch(1), 1);
  assert.equal(sampleSizeForBatch(9), 9);
  assert.equal(sampleSizeForBatch(10), 10);
  assert.equal(sampleSizeForBatch(50), 10);
  assert.equal(sampleSizeForBatch(100), 10);
  assert.equal(sampleSizeForBatch(500), 50);
  const sample = chooseSampleCandidateIds(['c1', 'c2', 'c3', 'c4', 'c5'], 'fixed-seed');
  assert.equal(sample.length, 5);
  assert.deepEqual(sample, chooseSampleCandidateIds(['c1', 'c2', 'c3', 'c4', 'c5'], 'fixed-seed'));
});

test('Risk Queue API 鉴权、筛选和 manifest 均由服务端控制', async () => {
  const fixture = await openFixture();
  const previous = process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
  process.env.NETLIFY_TAXKB_ADMIN_TOKEN = 'risk-queue-test-token';
  try {
    await seedLowCandidate(fixture, 1);
    const handler = createApiHandler({ evidenceAdminHandler: createEvidenceAdminHandler({ repositoryFactory: () => fixture.repository, publishProjection: async () => ({ added: 1 }) }) });
    for (const [method, pathname] of [
      ['GET', '/api/admin/evidence/risk-queue'],
      ['POST', '/api/admin/evidence/risk-queue/manifests'],
      ['GET', '/api/admin/evidence/risk-queue/manifests/manifest-test'],
      ['POST', '/api/admin/evidence/risk-queue/manifests/manifest-test/apply'],
      ['GET', '/api/admin/evidence/candidates/candidate-test/risk-assessments'],
      ['GET', '/api/admin/evidence/candidates/candidate-test/relation-proposals'],
      ['POST', '/api/admin/evidence/candidates/candidate-test/relation-proposals'],
      ['POST', '/api/admin/evidence/relation-proposals/proposal-test/review']
    ]) assert.equal((await call(handler, pathname, { method })).response.status, 401, `${method} ${pathname}`);
    const queue = await call(handler, '/api/admin/evidence/risk-queue?risk_level=low&tax_category=%E4%B8%AA%E4%BA%BA%E6%89%80%E5%BE%97%E7%A8%8E', { token: process.env.NETLIFY_TAXKB_ADMIN_TOKEN });
    assert.equal(queue.response.status, 200); assert.equal(queue.body.total, 1);
    assert.equal(queue.body.results[0].assessment.risk_level, 'low');
    assert.equal('raw_html' in queue.body.results[0], false);
    const invalid = await call(handler, '/api/admin/evidence/risk-queue/manifests', { method: 'POST', token: process.env.NETLIFY_TAXKB_ADMIN_TOKEN, body: { filters: { candidate_ids: ['forbidden'] } } });
    assert.equal(invalid.response.status, 422);
    const manifest = await call(handler, '/api/admin/evidence/risk-queue/manifests', { method: 'POST', token: process.env.NETLIFY_TAXKB_ADMIN_TOKEN, body: { filters: {} } });
    assert.equal(manifest.response.status, 200); assert.equal(manifest.body.manifest.batch_size, 1); assert.equal(manifest.body.items[0].is_sample, true);
    const invalidApply = await call(handler, `/api/admin/evidence/risk-queue/manifests/${manifest.body.manifest.manifest_id}/apply`, { method: 'POST', token: process.env.NETLIFY_TAXKB_ADMIN_TOKEN, body: { apply: true, confirmation: 'wrong' } });
    assert.equal(invalidApply.response.status, 400);
  } finally { if (previous === undefined) delete process.env.NETLIFY_TAXKB_ADMIN_TOKEN; else process.env.NETLIFY_TAXKB_ADMIN_TOKEN = previous; await closeFixture(fixture); }
});

test('Low Risk manifest 抽样、并发 apply、projection 失败重试和幂等发布', async () => {
  const fixture = await openFixture();
  try {
    for (let index = 1; index <= 11; index += 1) await seedLowCandidate(fixture, index);
    const manifest = await fixture.repository.createLowRiskReviewManifest({ filters: {}, created_by: 'batch-test' });
    assert.equal(manifest.manifest.batch_size, 11); assert.equal(manifest.manifest.sample_size, 10);
    await assert.rejects(() => fixture.repository.createLowRiskReviewManifest({ filters: {}, created_by: 'other-admin' }), /其他活动 manifest/);
    for (const item of manifest.items.filter((item) => item.is_sample)) await approveSample(fixture.repository, item.candidate_id);
    let releaseFirst; let publisherEntered = false;
    const firstPromise = applyLowRiskReviewManifest(manifest.manifest.manifest_id, { repository: fixture.repository, publishProjection: async () => {
      publisherEntered = true;
      return new Promise((resolve) => { releaseFirst = () => resolve({ added: 1, updated: 0, skipped: 0, errors: [] }); });
    } });
    while (!publisherEntered) await new Promise((resolve) => setTimeout(resolve, 5));
    const concurrent = await applyLowRiskReviewManifest(manifest.manifest.manifest_id, { repository: fixture.repository, publishProjection: async () => ({ added: 1 }) });
    assert.equal(concurrent.execution, 'in_progress');
    releaseFirst();
    const firstResult = await firstPromise;
    assert.equal(firstResult.execution, 'completed');
    const firstCounts = (await fixture.database.query('SELECT (SELECT COUNT(*)::int FROM review_decisions) AS reviews,(SELECT COUNT(*)::int FROM policies) AS policies,(SELECT COUNT(*)::int FROM policy_versions) AS versions,(SELECT COUNT(*)::int FROM policy_projection_jobs) AS jobs')).rows[0];
    const repeated = await applyLowRiskReviewManifest(manifest.manifest.manifest_id, { repository: fixture.repository, publishProjection: async () => { throw new Error('completed manifest must not publish again'); } });
    assert.equal(repeated.execution, 'already_completed');
    assert.deepEqual((await fixture.database.query('SELECT (SELECT COUNT(*)::int FROM review_decisions) AS reviews,(SELECT COUNT(*)::int FROM policies) AS policies,(SELECT COUNT(*)::int FROM policy_versions) AS versions,(SELECT COUNT(*)::int FROM policy_projection_jobs) AS jobs')).rows[0], firstCounts);

    for (let index = 12; index <= 22; index += 1) await seedLowCandidate(fixture, index);
    const retryManifest = await fixture.repository.createLowRiskReviewManifest({ filters: {}, created_by: 'retry-test' });
    for (const item of retryManifest.items.filter((item) => item.is_sample)) await approveSample(fixture.repository, item.candidate_id);
    let attempts = 0;
    const first = await applyLowRiskReviewManifest(retryManifest.manifest.manifest_id, { repository: fixture.repository, publishProjection: async () => { attempts += 1; throw new Error('temporary projection outage'); } });
    assert.equal(first.execution, 'failed');
    const afterFailure = await fixture.repository.getReviewBatchManifest(retryManifest.manifest.manifest_id);
    const failed = afterFailure.items.find((item) => item.item_state === 'failed');
    assert.ok(failed?.policy_version_id, 'projection 失败后 Policy Version 已保存，重试不得重新审核');
    const failedCounts = (await fixture.database.query('SELECT (SELECT COUNT(*)::int FROM review_decisions WHERE candidate_id=$1) AS reviews,(SELECT COUNT(*)::int FROM policies WHERE policy_id=$2) AS policies,(SELECT COUNT(*)::int FROM policy_versions WHERE candidate_id=$1) AS versions,(SELECT COUNT(*)::int FROM policy_projection_jobs WHERE policy_version_id=$3) AS jobs', [failed.candidate_id, failed.policy_id, failed.policy_version_id])).rows[0];
    const retry = await applyLowRiskReviewManifest(retryManifest.manifest.manifest_id, { repository: fixture.repository, publishProjection: async () => { attempts += 1; return { added: 1, updated: 0, skipped: 0, errors: [] }; } });
    assert.equal(retry.execution, 'completed'); assert.equal(attempts, 2);
    const completed = await fixture.repository.getReviewBatchManifest(retryManifest.manifest.manifest_id);
    assert.equal(completed.manifest.manifest_state, 'completed');
    assert.equal(completed.items.filter((item) => item.item_state === 'published').length, 1);
    assert.equal((await fixture.repository.getProjectionJobForPolicyVersion(failed.policy_version_id)).job_state, 'published');
    assert.deepEqual((await fixture.database.query('SELECT (SELECT COUNT(*)::int FROM review_decisions WHERE candidate_id=$1) AS reviews,(SELECT COUNT(*)::int FROM policies WHERE policy_id=$2) AS policies,(SELECT COUNT(*)::int FROM policy_versions WHERE candidate_id=$1) AS versions,(SELECT COUNT(*)::int FROM policy_projection_jobs WHERE policy_version_id=$3) AS jobs', [failed.candidate_id, failed.policy_id, failed.policy_version_id])).rows[0], failedCounts);
  } finally { await closeFixture(fixture); }
});

test('manifest 在 Candidate、assessment、metadata 或 relation proposal 变化后被阻断，已发布 Candidate 不再入队', async () => {
  const fixture = await openFixture();
  try {
    const candidate = await seedLowCandidate(fixture, 31);
    const manifest = await fixture.repository.createLowRiskReviewManifest({ filters: {} });
    const detail = await fixture.repository.getCandidateForReview(candidate.candidate_id);
    await fixture.repository.reparseCandidate(candidate.candidate_id, { parsed_fields: detail.candidate.parsed_fields, normalized_text: `${body('正文版本变化。')}`, parser_version: 'risk-queue-parser-v2' });
    await fixture.repository.assessCandidateRisk(candidate.candidate_id, { ruleVersion: 'candidate-risk-rules-v2-test' });
    await approveSample(fixture.repository, candidate.candidate_id);
    const blocked = await fixture.repository.beginReviewBatchApply(manifest.manifest.manifest_id);
    assert.equal(blocked.execution, 'blocked');
    assert.match(blocked.manifest.blocked_reason, /CANDIDATE_BODY_CHANGED|ASSESSMENT_SUPERSEDED|RISK_RULE_VERSION_CHANGED|METADATA_SUGGESTION_CHANGED/);

    const metadataCandidate = await seedLowCandidate(fixture, 33);
    const metadataManifest = await fixture.repository.createLowRiskReviewManifest({ filters: {} });
    const metadataDetail = await fixture.repository.getCandidateForReview(metadataCandidate.candidate_id);
    await fixture.repository.saveMetadataSuggestion(metadataCandidate.candidate_id, { ...metadataDetail.candidate.parsed_fields.metadata_suggestion, rule_version: 'evidence-metadata-rules-v999-test' });
    await approveSample(fixture.repository, metadataCandidate.candidate_id);
    const metadataBlocked = await fixture.repository.beginReviewBatchApply(metadataManifest.manifest.manifest_id);
    assert.equal(metadataBlocked.execution, 'blocked');
    assert.match(metadataBlocked.manifest.blocked_reason, /METADATA_SUGGESTION_CHANGED/);

    const published = await seedLowCandidate(fixture, 32);
    await approveSample(fixture.repository, published.candidate_id);
    await assert.rejects(() => fixture.repository.createLowRiskReviewManifest({ filters: { source_id: fixture.source.source_id } }), /没有满足/);
  } finally { await closeFixture(fixture); }
});

test('High Risk Candidate 无法通过任何 Low Risk manifest', async () => {
  const fixture = await openFixture();
  try {
    const candidate = await seedLowCandidate(fixture, 39);
    const detail = await fixture.repository.getCandidateForReview(candidate.candidate_id);
    await fixture.repository.reparseCandidate(candidate.candidate_id, { parsed_fields: detail.candidate.parsed_fields, normalized_text: '个人所得税。', parser_version: 'risk-queue-parser-short' });
    const assessment = await fixture.repository.assessCandidateRisk(candidate.candidate_id);
    assert.equal(assessment.assessment.risk_level, 'high');
    assert.equal((await fixture.repository.listRiskQueue({ risk_level: 'high' })).total, 1);
    await assert.rejects(() => fixture.repository.createLowRiskReviewManifest({ filters: {} }), /没有满足/);
  } finally { await closeFixture(fixture); }
});

test('Medium Risk 可进入快速审核队列，但不能进入 Low Risk manifest', async () => {
  const fixture = await openFixture();
  try {
    const candidate = await seedLowCandidate(fixture, 40, { documentNo: null, issuingAuthority: [], expectedRisk: 'medium' });
    const queue = await fixture.repository.listRiskQueue({ risk_level: 'medium' });
    assert.equal(queue.total, 1);
    assert.equal(queue.results[0].candidate.candidate_id, candidate.candidate_id);
    await assert.rejects(() => fixture.repository.createLowRiskReviewManifest({ filters: {} }), /没有满足/);
    assert.equal((await fixture.repository.getCandidateForReview(candidate.candidate_id)).candidate.verification_state, 'pending_review');
  } finally { await closeFixture(fixture); }
});

test('关系线索只产生 proposed，阻断 manifest，且不会自动改变 legal_status 或 confirmed relation', async () => {
  const fixture = await openFixture();
  try {
    const target = await seedLowCandidate(fixture, 42, { documentNo: '国家税务总局公告2025年第1号', title: '被引用的历史公告' });
    const candidate = await seedLowCandidate(fixture, 41, { content: body('《国家税务总局关于测试事项的公告》（国家税务总局公告2025年第1号）同时废止。') });
    const manifest = await fixture.repository.createLowRiskReviewManifest({ filters: {} });
    const proposed = await fixture.repository.generateCandidateRelationProposals(candidate.candidate_id);
    assert.equal(proposed.created.length, 1); assert.equal(proposed.created[0].proposal_state, 'proposed');
    assert.equal(proposed.created[0].to_candidate_id, target.candidate_id);
    assert.equal((await fixture.repository.getCandidateForReview(candidate.candidate_id)).candidate.legal_status, 'pending');
    await assert.rejects(
      () => fixture.repository.reviewCandidateRelationProposal(proposed.created[0].proposal_id, { action: 'confirm', reviewer_id: 'level-3' }),
      /两端 Candidate 均必须已有 Policy Version/
    );
    await approveSample(fixture.repository, candidate.candidate_id);
    await approveSample(fixture.repository, target.candidate_id);
    const blocked = await fixture.repository.beginReviewBatchApply(manifest.manifest.manifest_id);
    assert.equal(blocked.execution, 'blocked');
    assert.equal((await fixture.repository.listCandidateRelationProposals(candidate.candidate_id))[0].proposal_state, 'proposed');
    const confirmed = await fixture.repository.reviewCandidateRelationProposal(proposed.created[0].proposal_id, { action: 'confirm', reviewer_id: 'level-3', note: '人工确认关系' });
    assert.equal(confirmed.proposal.proposal_state, 'confirmed');
    assert.equal(confirmed.policy_relation.relation_state, 'confirmed');
    assert.equal((await fixture.repository.getCandidateForReview(candidate.candidate_id)).candidate.legal_status, 'pending');
  } finally { await closeFixture(fixture); }
});

test('冻结 manifest 在正文、解析器、评估规则、metadata 或关系线索变化后立即 blocked，不创建 Policy', async () => {
  const fixture = await openFixture();
  try {
    async function isolatedRun(index) {
      return fixture.repository.createCollectionRun({ source_id: fixture.source.source_id, mode: `risk-queue-freeze-${index}` });
    }
    async function manifestFor(candidate, run) {
      return fixture.repository.createLowRiskReviewManifest({ filters: { collection_run_id: run.collection_run_id } });
    }
    async function expectBlocked(manifest, code) {
      const result = await fixture.repository.beginReviewBatchApply(manifest.manifest.manifest_id);
      assert.equal(result.execution, 'blocked');
      assert.match(result.manifest.blocked_reason, new RegExp(code));
    }

    const bodyRun = await isolatedRun(51);
    const bodyCandidate = await seedLowCandidate(fixture, 51, { collectionRun: bodyRun });
    const bodyManifest = await manifestFor(bodyCandidate, bodyRun);
    const bodyDetail = await fixture.repository.getCandidateForReview(bodyCandidate.candidate_id);
    await fixture.repository.reparseCandidate(bodyCandidate.candidate_id, { parsed_fields: bodyDetail.candidate.parsed_fields, normalized_text: body('正文已变化。'), parser_version: 'risk-queue-parser-v1' });
    await expectBlocked(bodyManifest, 'CANDIDATE_BODY_CHANGED');

    const parserRun = await isolatedRun(52);
    const parserCandidate = await seedLowCandidate(fixture, 52, { collectionRun: parserRun });
    const parserManifest = await manifestFor(parserCandidate, parserRun);
    const parserDetail = await fixture.repository.getCandidateForReview(parserCandidate.candidate_id);
    await fixture.repository.reparseCandidate(parserCandidate.candidate_id, { parsed_fields: parserDetail.candidate.parsed_fields, normalized_text: body(), parser_version: 'risk-queue-parser-v2' });
    await expectBlocked(parserManifest, 'PARSER_VERSION_CHANGED');

    const assessmentRun = await isolatedRun(53);
    const assessmentCandidate = await seedLowCandidate(fixture, 53, { collectionRun: assessmentRun });
    const assessmentManifest = await manifestFor(assessmentCandidate, assessmentRun);
    await fixture.repository.assessCandidateRisk(assessmentCandidate.candidate_id, { ruleVersion: 'candidate-risk-rules-v2-test' });
    await expectBlocked(assessmentManifest, 'ASSESSMENT_SUPERSEDED');

    const metadataRun = await isolatedRun(54);
    const metadataCandidate = await seedLowCandidate(fixture, 54, { collectionRun: metadataRun });
    const metadataManifest = await manifestFor(metadataCandidate, metadataRun);
    const metadataDetail = await fixture.repository.getCandidateForReview(metadataCandidate.candidate_id);
    await fixture.repository.saveMetadataSuggestion(metadataCandidate.candidate_id, { ...metadataDetail.candidate.parsed_fields.metadata_suggestion, rule_version: 'evidence-metadata-rules-v999-test' });
    await expectBlocked(metadataManifest, 'METADATA_SUGGESTION_CHANGED');

    const relationRun = await isolatedRun(55);
    await seedLowCandidate(fixture, 56, { collectionRun: relationRun, documentNo: '国家税务总局公告2025年第1号', issuingAuthority: [], expectedRisk: 'medium' });
    const relationCandidate = await seedLowCandidate(fixture, 55, { collectionRun: relationRun, content: body('《国家税务总局关于测试事项的公告》（国家税务总局公告2025年第1号）同时废止。') });
    const relationManifest = await manifestFor(relationCandidate, relationRun);
    assert.equal((await fixture.repository.generateCandidateRelationProposals(relationCandidate.candidate_id)).created.length, 1);
    await expectBlocked(relationManifest, 'RELATION_PROPOSAL_PENDING');

    assert.equal((await fixture.database.query('SELECT COUNT(*)::int AS count FROM policies')).rows[0].count, 0);
  } finally { await closeFixture(fixture); }
});

test('抽样 Candidate Reject 或 Return 均会阻断整个 manifest', async () => {
  const fixture = await openFixture();
  try {
    for (const [index, action] of [[61, 'reject'], [62, 'return']]) {
      const run = await fixture.repository.createCollectionRun({ source_id: fixture.source.source_id, mode: `risk-queue-sample-${action}` });
      const candidate = await seedLowCandidate(fixture, index, { collectionRun: run });
      const manifest = await fixture.repository.createLowRiskReviewManifest({ filters: { collection_run_id: run.collection_run_id } });
      await fixture.repository.reviewCandidate(candidate.candidate_id, { action, legal_status: 'pending', reviewer_id: 'sample-reviewer', confirmed_fields: {} });
      const result = await fixture.repository.beginReviewBatchApply(manifest.manifest.manifest_id);
      assert.equal(result.execution, 'blocked');
      assert.match(result.manifest.blocked_reason, /未通过 Level 3 审核/);
    }
    assert.equal((await fixture.database.query('SELECT COUNT(*)::int AS count FROM policies')).rows[0].count, 0);
  } finally { await closeFixture(fixture); }
});

test('审核后 Candidate、Review Decision 与 Policy Version 在数据库层不可覆盖或删除', async () => {
  const fixture = await openFixture();
  try {
    const candidate = await seedLowCandidate(fixture, 71);
    const approved = await approveSample(fixture.repository, candidate.candidate_id);
    await assert.rejects(
      () => fixture.database.query("UPDATE candidates SET parsed_fields='{}'::jsonb WHERE candidate_id=$1", [candidate.candidate_id]),
      /reviewed candidate is immutable/
    );
    await assert.rejects(
      () => fixture.database.query("UPDATE review_decisions SET note='rewritten' WHERE review_decision_id=$1", [approved.review_decision.review_decision_id]),
      /review_decisions are immutable/
    );
    await assert.rejects(
      () => fixture.database.query("UPDATE policy_versions SET title='rewritten' WHERE policy_version_id=$1", [approved.policy_version.policy_version_id]),
      /policy_versions are immutable/
    );
    await assert.rejects(
      () => fixture.database.query('DELETE FROM policy_versions WHERE policy_version_id=$1', [approved.policy_version.policy_version_id]),
      /policy_versions are immutable/
    );
  } finally { await closeFixture(fixture); }
});
