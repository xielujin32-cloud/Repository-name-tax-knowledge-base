import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NetlifyDB } from '@netlify/database-dev';
import { collectChinaTaxPolicyCandidates } from '../src/chinatax-evidence-collection.js';
import { createLocalEvidenceObjectStore } from '../src/evidence-object-store.js';
import { createPostgresEvidenceRepository } from '../src/postgres-evidence-repository.js';
import { createEvidenceAdminHandler, PHASE4_STA_CANDIDATE_INGEST_CONFIRMATION, reviewEvidenceCandidate } from '../netlify/lib/evidence-ingestion.mjs';

const primaryUrl = 'https://fgk.chinatax.gov.cn/zcfgk/c100027/phase4-one/content.html';
const secondUrl = 'https://fgk.chinatax.gov.cn/zcfgk/c100027/phase4-two/content.html';
const body = '第一条 为规范增值税有关事项，纳税人应当按照本公告规定办理。'.repeat(18);
const page = (title, documentNo, content = body) => `<html><head><meta name="PubDate" content="2026-09-01"></head><body><div class="detials contentLeft"><h3>${title}</h3><h5 class="actfwzh">${documentNo}</h5><div class="article"><div class="arc_cont"><p>${content}</p></div></div></div></body></html>`;

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taxkb-phase4-mvp-'));
  const database = new NetlifyDB({ directory: path.join(root, 'database'), logger: () => {} });
  await database.start();
  await database.reset();
  await database.applyMigrations(path.join(process.cwd(), 'netlify', 'database', 'migrations'));
  const repository = createPostgresEvidenceRepository({ pool: database, objectStore: createLocalEvidenceObjectStore({ rootDirectory: path.join(root, 'objects') }) });
  return { root, database, repository };
}

async function dispose(value) {
  await value.repository.close();
  await value.database.stop();
  await rm(value.root, { recursive: true, force: true });
}

test('Phase 4 官方 STA intake 只创建 Evidence、Candidate、Risk 和关系提案，不创建 Policy 或公开投影', async () => {
  const value = await fixture();
  try {
    const pages = new Map([
      [primaryUrl, page('国家税务总局关于增值税测试事项的公告', '国家税务总局公告2026年第1号')],
      [secondUrl, page('国家税务总局关于增值税补充事项的公告', '国家税务总局公告2026年第2号')]
    ]);
    const result = await collectChinaTaxPolicyCandidates({
      repository: value.repository,
      urls: [primaryUrl, secondUrl],
      fetchImpl: async (url) => new Response(pages.get(String(url)) || '', { status: pages.has(String(url)) ? 200 : 404, headers: { 'content-type': 'text/html; charset=utf-8' } })
    });
    assert.equal(result.created.raw_snapshots, 2);
    assert.equal(result.created.candidates, 2);
    assert.equal(result.created.policies, 0);
    assert.equal(result.created.policy_versions, 0);
    assert.equal(result.created.public_projections, 0);
    const candidates = await value.repository.listCandidatesForReview({ limit: 10 });
    assert.ok(candidates.every((candidate) => candidate.verification_state === 'pending_review' && candidate.legal_status === 'pending'));
    const detail = await value.repository.getCandidateForReview(result.results[0].candidate_id);
    assert.deepEqual(detail.candidate.parsed_fields.tax_categories, ['增值税']);
    assert.deepEqual(detail.candidate.parsed_fields.region, ['全国']);
    assert.ok(detail.candidate.parsed_fields.topics.includes('增值税'));
    assert.equal(detail.candidate.parsed_fields.policy_category, 'tax_policy');
    assert.equal(detail.candidate.parsed_fields.validity_status_suggestion, 'pending_verification');
    assert.ok(detail.candidate.parsed_fields.metadata_suggestion);
    assert.equal((await value.database.query('SELECT COUNT(*)::int AS count FROM policies')).rows[0].count, 0);
    assert.equal((await value.database.query('SELECT trust_level FROM sources WHERE source_id=$1', ['source-sta-policy-regulations'])).rows[0].trust_level, 'official_primary');
    await assert.rejects(
      () => value.repository.addSource({ source_id: 'source-unregistered-official', source_name: '未注册来源', official_domain: 'example.gov.cn', source_type: 'official-policy-regulations', trust_level: 'official_primary', adapter_version: 'test', base_url: 'https://example.gov.cn/' }),
      /受信任来源注册表/
    );
  } finally { await dispose(value); }
});

test('Risk/Level 3 门禁只公开已核验且无阻断项的政策，缺少风险审查的批准不会写公开投影', async () => {
  const value = await fixture();
  try {
    const pages = new Map([[primaryUrl, page('国家税务总局关于增值税测试事项的公告', '国家税务总局公告2026年第1号')]]);
    const collected = await collectChinaTaxPolicyCandidates({
      repository: value.repository, urls: [primaryUrl],
      fetchImpl: async (url) => new Response(pages.get(String(url)) || '', { status: 200, headers: { 'content-type': 'text/html' } })
    });
    const candidateId = collected.results[0].candidate_id;
    const detail = await value.repository.getCandidateForReview(candidateId);
    const fields = {
      title: detail.candidate.parsed_fields.title,
      document_no: detail.candidate.parsed_fields.document_no,
      issuing_authority: detail.candidate.parsed_fields.issuing_authority,
      publish_date: detail.candidate.parsed_fields.publish_date,
      effective_date: detail.candidate.parsed_fields.effective_date,
      expiry_date: detail.candidate.parsed_fields.expiry_date,
      tax_categories: detail.candidate.parsed_fields.metadata_suggestion.tax_categories.values,
      keywords: detail.candidate.parsed_fields.metadata_suggestion.keywords.values,
      summary: detail.candidate.parsed_fields.metadata_suggestion.summary.value
    };
    const published = [];
    const approved = await reviewEvidenceCandidate(candidateId, { action: 'approve', legal_status: 'effective', fields }, {
      repository: value.repository,
      publishProjection: async (projection) => { published.push(projection); return { added: 1 }; },
      reviewerId: 'level3-test'
    });
    assert.equal(approved.publication_readiness.eligible, true);
    assert.equal(approved.publication.execution, 'published');
    assert.equal(published.length, 1);
    assert.equal(published[0].verification_state, 'verified');
    assert.equal(published[0].source_trust_level, 'official_primary');
    assert.equal(published[0].evidence.normalized_text, undefined);

    const run = await value.repository.createCollectionRun({ source_id: 'source-sta-policy-regulations', mode: 'missing-risk-test' });
    const snapshot = await value.repository.recordRawSnapshot({ source_id: 'source-sta-policy-regulations', collection_run_id: run.collection_run_id, official_url: 'https://fgk.chinatax.gov.cn/zcfgk/c100027/missing-risk/content.html', raw_content: '<article>正文</article>', normalized_text: body, parser_version: 'test', parse_result: {} });
    const unassessed = await value.repository.createCandidate({ snapshot_id: snapshot.snapshot_id, parsed_fields: { ...detail.candidate.parsed_fields, title: '国家税务总局关于未评估政策的公告', document_no: '国家税务总局公告2026年第99号', snapshot_id: snapshot.snapshot_id } });
    const blocked = await reviewEvidenceCandidate(unassessed.candidate.candidate_id, { action: 'approve', legal_status: 'effective', fields: { ...fields, title: '国家税务总局关于未评估政策的公告', document_no: '国家税务总局公告2026年第99号' } }, {
      repository: value.repository, publishProjection: async () => { throw new Error('blocked Candidate must not publish'); }, reviewerId: 'level3-test'
    });
    assert.equal(blocked.publication.execution, 'blocked');
    assert.ok(blocked.publication.blockers.includes('RISK_ASSESSMENT_MISSING'));
  } finally { await dispose(value); }
});

test('Phase 4 STA discovery 只读且 Candidate intake 需要固定确认，不会进入公开发布流程', async () => {
  const previous = process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
  process.env.NETLIFY_TAXKB_ADMIN_TOKEN = 'phase4-admin-token';
  let discoveryOptions = null;
  let intakeCalls = 0;
  const relationSteps = [];
  const handler = createEvidenceAdminHandler({
    repositoryFactory: () => ({
      relationProposalAffectedPolicyVersions: async () => { relationSteps.push('read'); return ['policy-version-a', 'policy-version-b']; },
      reviewCandidateRelationProposal: async () => { relationSteps.push('confirm'); return { execution: 'confirm', policy_relation: { policy_relation_id: 'relation-test' } }; }
    }),
    suppressPublicPolicies: async ({ policyVersionIds }) => { relationSteps.push(`suppress:${policyVersionIds.join(',')}`); return { suppressed: policyVersionIds.length, policy_ids: ['policy-a', 'policy-b'] }; },
    chinaTaxDiscoveryFactory: async (options) => {
      discoveryOptions = options;
      return { mode: 'dry-run', candidates: [{ official_url: primaryUrl, title: '安全摘要' }], writes: { raw_snapshots: 0, candidates: 0, policies: 0, netlify_blobs: 0 } };
    },
    chinaTaxCandidateCollector: async ({ urls }) => {
      intakeCalls += 1;
      return { selected_count: urls.length, created: { raw_snapshots: 1, candidates: 1, policies: 0, policy_versions: 0, public_projections: 0 } };
    }
  });
  const invoke = (pathname, { method = 'GET', token = '', body: requestBody } = {}) => handler(
    new Request(`https://taxkb.example${pathname}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(requestBody ? { 'content-type': 'application/json' } : {}) },
      body: requestBody ? JSON.stringify(requestBody) : undefined
    }), new URL(`https://taxkb.example${pathname}`).pathname, new URL(`https://taxkb.example${pathname}`)
  );
  try {
    assert.equal((await invoke('/api/admin/evidence/sources/chinatax/discovery')).status, 401);
    const discovery = await invoke('/api/admin/evidence/sources/chinatax/discovery?limit=999&page_size=999&max_pages=999', { token: process.env.NETLIFY_TAXKB_ADMIN_TOKEN });
    assert.equal(discovery.status, 200);
    const discoveryBody = await discovery.json();
    assert.equal(discoveryBody.writes.candidates, 0);
    assert.equal('raw_html' in discoveryBody.candidates[0], false);
    assert.equal(discoveryOptions.limit, 100);
    assert.equal(discoveryOptions.pageSize, 20);
    assert.equal(discoveryOptions.maxPages, 5);

    const rejected = await invoke('/api/admin/evidence/sources/chinatax/candidates', {
      method: 'POST', token: process.env.NETLIFY_TAXKB_ADMIN_TOKEN, body: { apply: true, confirmation: 'wrong', official_urls: [primaryUrl] }
    });
    assert.equal(rejected.status, 400);
    assert.equal(intakeCalls, 0);

    const intake = await invoke('/api/admin/evidence/sources/chinatax/candidates', {
      method: 'POST', token: process.env.NETLIFY_TAXKB_ADMIN_TOKEN,
      body: { apply: true, confirmation: PHASE4_STA_CANDIDATE_INGEST_CONFIRMATION, official_urls: [primaryUrl] }
    });
    const intakeBody = await intake.json();
    assert.equal(intake.status, 201);
    assert.equal(intakeCalls, 1);
    assert.equal(intakeBody.created.policies, 0);
    assert.equal(intakeBody.created.public_projections, 0);

    const relation = await invoke('/api/admin/evidence/relation-proposals/proposal-test/review', {
      method: 'POST', token: process.env.NETLIFY_TAXKB_ADMIN_TOKEN, body: { action: 'confirm', note: '人工确认关系' }
    });
    assert.equal(relation.status, 200);
    assert.deepEqual(relationSteps, ['read', 'suppress:policy-version-a,policy-version-b', 'confirm']);
    assert.equal((await relation.json()).public_visibility_suppression.suppressed, 2);
  } finally {
    if (previous === undefined) delete process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
    else process.env.NETLIFY_TAXKB_ADMIN_TOKEN = previous;
  }
});

test('确认版本关系后，可使用既有 Level 3 审核材料重新投影，不重抓正文或绕过关系门禁', async () => {
  const value = await fixture();
  try {
    const targetTitle = '国家税务总局关于被替代事项的公告';
    const targetDocumentNo = '国家税务总局公告2026年第2号';
    const sourceTitle = '国家税务总局关于替代事项的公告';
    const sourceDocumentNo = '国家税务总局公告2026年第3号';
    const pages = new Map([
      [secondUrl, page(targetTitle, targetDocumentNo)],
      [primaryUrl, page(sourceTitle, sourceDocumentNo, `${body}《${targetTitle}》（${targetDocumentNo}）废止。`)]
    ]);
    const collected = await collectChinaTaxPolicyCandidates({
      repository: value.repository, urls: [secondUrl, primaryUrl],
      fetchImpl: async (url) => new Response(pages.get(String(url)) || '', { status: 200, headers: { 'content-type': 'text/html' } })
    });
    const byUrl = new Map(collected.results.map((item) => [item.official_url, item.candidate_id]));
    const sourceCandidateId = byUrl.get(primaryUrl);
    const targetCandidateId = byUrl.get(secondUrl);
    const projected = [];
    const approve = async (candidateId) => {
      const detail = await value.repository.getCandidateForReview(candidateId);
      return reviewEvidenceCandidate(candidateId, {
        action: 'approve', legal_status: 'effective',
        fields: {
          title: detail.candidate.parsed_fields.title,
          document_no: detail.candidate.parsed_fields.document_no,
          issuing_authority: detail.candidate.parsed_fields.issuing_authority,
          publish_date: detail.candidate.parsed_fields.publish_date,
          effective_date: detail.candidate.parsed_fields.effective_date,
          expiry_date: detail.candidate.parsed_fields.expiry_date,
          tax_categories: detail.candidate.parsed_fields.metadata_suggestion.tax_categories.values,
          keywords: detail.candidate.parsed_fields.metadata_suggestion.keywords.values,
          summary: detail.candidate.parsed_fields.metadata_suggestion.summary.value
        }
      }, { repository: value.repository, publishProjection: async (projection) => { projected.push(projection); return { added: 1 }; }, reviewerId: 'level3-test' });
    };

    const initiallyBlocked = await approve(sourceCandidateId);
    assert.equal(initiallyBlocked.publication.execution, 'blocked');
    assert.ok(initiallyBlocked.publication.blockers.includes('RELATION_REVIEW_REQUIRED'));
    await approve(targetCandidateId);
    const proposals = await value.repository.listCandidateRelationProposals(sourceCandidateId);
    assert.ok(proposals.length >= 1);
    for (const proposal of proposals) {
      const confirmed = await value.repository.reviewCandidateRelationProposal(proposal.proposal_id, { action: 'confirm', reviewer_id: 'level3-test' });
      assert.equal(confirmed.policy_relation.relation_state, 'confirmed');
    }
    assert.equal((await value.repository.listCandidateRelationProposals(sourceCandidateId)).filter((item) => item.proposal_state === 'proposed').length, 0);

    const reprojected = await approve(sourceCandidateId);
    assert.equal(reprojected.execution, 'already_approved');
    assert.equal(reprojected.publication.execution, 'published', JSON.stringify(reprojected.publication));
    const sourceProjection = projected.find((item) => item.id === reprojected.policy.policy_id);
    assert.ok(sourceProjection.version_relations.length >= 1);
    assert.ok(sourceProjection.version_relations.every((item) => item.relation_state === 'confirmed'));
    assert.ok(sourceProjection.version_relations.every((item) => item.document_no === targetDocumentNo));
  } finally { await dispose(value); }
});
