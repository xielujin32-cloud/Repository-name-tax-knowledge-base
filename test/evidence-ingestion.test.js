import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NetlifyDB } from '@netlify/database-dev';
import { createApiHandler } from '../netlify/functions/api.mjs';
import { createEvidenceAdminHandler, ingestPhase2BWhitelistOnce, PHASE_2D_IMPORT_CONFIRMATION, PHASE_2D_REPARSE_CONFIRMATION } from '../netlify/lib/evidence-ingestion.mjs';
import { createLocalEvidenceObjectStore } from '../src/evidence-object-store.js';
import { createPostgresEvidenceRepository } from '../src/postgres-evidence-repository.js';
import { PHASE_2B_ALLOWED_DETAIL_URLS } from '../src/chinatax-evidence-collection.js';

const [firstUrl, secondUrl] = PHASE_2B_ALLOWED_DETAIL_URLS;
const pages = new Map([
  [firstUrl, '<html><head><meta name="ArticleTitle" content="财政部 税务总局 中国证监会关于规范转让上市公司限售股个人所得税政策的公告"><meta name="PubDate" content="2026-08-28"></head><body><header>登录 本站热词 个人中心</header><div class="detials contentLeft"><h3>财政部 税务总局 中国证监会关于规范转让上市公司限售股个人所得税政策的公告</h3><h5 class="actfwzh">财政部 税务总局 中国证监会公告2026年第26号</h5><div class="article"><div class="arc_cont"><p>本公告自2026年9月1日起施行。</p><p>第一条 原始证据正文一。</p></div></div></div></body></html>'],
  [secondUrl, '<html><head><meta name="ArticleTitle" content="财政部 税务总局关于明确非应税交易等增值税有关事项的公告"><meta name="PubDate" content="2026-08-27"></head><body><nav>登录 本站热词</nav><div class="detials contentLeft"><h3>财政部 税务总局关于明确非应税交易等增值税有关事项的公告</h3><h5 class="actfwzh">财政部 税务总局公告2026年第25号</h5><div class="article"><div class="arc_cont"><p>自2026年9月1日起施行。</p><p>第一条 原始证据正文二。</p></div></div></div></body></html>']
]);

async function fakeFetch(url) {
  const body = pages.get(String(url));
  return new Response(body || '', { status: body ? 200 : 404, headers: { 'content-type': 'text/html; charset=utf-8', etag: `etag-${String(url).slice(-12)}` } });
}

async function call(handler, pathname, { method = 'GET', token = '', body } = {}) {
  const response = await handler(new Request(`https://taxkb.example${pathname}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  }));
  return { response, body: await response.json() };
}

test('Phase 2D Evidence 管理接口仅允许管理员，并在本地完成白名单导入、状态和追溯', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taxkb-phase2d-'));
  const database = new NetlifyDB({ directory: path.join(root, 'database'), logger: () => {} });
  const originalToken = process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
  const testAdminToken = `phase2d-test-${randomUUID()}`;
  process.env.NETLIFY_TAXKB_ADMIN_TOKEN = testAdminToken;
  try {
    await database.start();
    await database.reset();
    await database.applyMigrations(path.join(process.cwd(), 'netlify', 'database', 'migrations'));
    const repositoryFactory = () => createPostgresEvidenceRepository({
      pool: database,
      objectStore: createLocalEvidenceObjectStore({ rootDirectory: path.join(root, 'taxkb-evidence-raw') })
    });
    // A completed run from another mode for a whitelisted URL is not the
    // Phase 2D one-time completion marker and must not suppress the import.
    const repository = repositoryFactory();
    await repository.addSource({
      source_id: 'source-sta-policy-regulations', source_name: '国家税务总局', official_domain: 'fgk.chinatax.gov.cn',
      source_type: 'official-policy-regulations', adapter_version: 'test', base_url: 'https://fgk.chinatax.gov.cn/', enabled: true
    });
    const unrelatedRun = await repository.createCollectionRun({ source_id: 'source-sta-policy-regulations', mode: 'manual' });
    const unrelatedSnapshot = await repository.recordRawSnapshot({
      source_id: 'source-sta-policy-regulations', collection_run_id: unrelatedRun.collection_run_id, official_url: firstUrl,
      canonical_url: firstUrl, http_status: 200, content_type: 'text/html', raw_content: '<html>unrelated prior evidence</html>',
      normalized_text: 'unrelated prior evidence', parser_version: 'test', parse_result: {}
    });
    await repository.createCandidate({ snapshot_id: unrelatedSnapshot.snapshot_id, parsed_fields: { title: 'unrelated prior evidence' } });
    await repository.finishCollectionRun(unrelatedRun.collection_run_id, 'completed');
    let fetchCount = 0;
    const countingFetch = async (...args) => {
      fetchCount += 1;
      return fakeFetch(...args);
    };
    const handler = createApiHandler({ evidenceAdminHandler: createEvidenceAdminHandler({ repositoryFactory, fetchImpl: countingFetch }) });
    const noToken = await call(handler, '/api/admin/evidence/status');
    assert.equal(noToken.response.status, 401);
    const wrongToken = await call(handler, '/api/admin/evidence/status', { token: `wrong-${randomUUID()}` });
    assert.equal(wrongToken.response.status, 401);
    const invalidInput = await call(handler, '/api/admin/evidence/import-phase2b', { method: 'POST', token: testAdminToken, body: { apply: true, url: firstUrl } });
    assert.equal(invalidInput.response.status, 400);

    const first = await call(handler, '/api/admin/evidence/import-phase2b', { method: 'POST', token: testAdminToken, body: { apply: true, confirmation: PHASE_2D_IMPORT_CONFIRMATION } });
    assert.equal(first.response.status, 200);
    assert.equal(first.body.allowlist_size, 2);
    assert.equal(first.body.snapshots_created, 2);
    assert.equal(first.body.candidates_created, 2);
    assert.equal(fetchCount, 2);
    assert.ok(first.body.results.every((item) => item.candidate.verification_state === 'pending_review' && item.candidate.legal_status === 'pending'));

    // A later human review must not reopen this one-time technical import.
    await database.query("UPDATE candidates SET verification_state='verified', legal_status='effective'");

    const second = await call(handler, '/api/admin/evidence/import-phase2b', { method: 'POST', token: testAdminToken, body: { apply: true, confirmation: PHASE_2D_IMPORT_CONFIRMATION } });
    assert.equal(second.response.status, 200);
    assert.equal(second.body.execution, 'already_completed');
    assert.equal(second.body.snapshots_created, 0);
    assert.equal(second.body.candidates_created, 0);
    assert.equal(second.body.candidates_skipped, 2);
    assert.equal(fetchCount, 2, 'already_completed must exit before another official-page request');

    const status = await call(handler, '/api/admin/evidence/status', { token: testAdminToken });
    assert.equal(status.response.status, 200);
    assert.deepEqual(status.body.counts, { sources: 1, source_states: 1, collection_runs: 2, raw_snapshots: 3, candidates: 3, review_decisions: 0, policies: 0, policy_versions: 0, policy_relations: 0, audit_events: 0 });
    assert.equal(status.body.candidates.length, 3);
    assert.ok(status.body.candidates.every((item) => item.verification_state === 'verified' && item.legal_status === 'effective'));

    const candidateId = first.body.results[0].candidate.candidate_id;
    const trace = await call(handler, `/api/admin/evidence/candidates/${candidateId}/trace`, { token: testAdminToken });
    assert.equal(trace.response.status, 200);
    assert.equal(trace.body.trace.snapshot.official_url, firstUrl);
    assert.equal(trace.body.trace.source.official_domain, 'fgk.chinatax.gov.cn');
    assert.equal(trace.body.trace.collection_run.collection_state, 'completed');
    assert.equal(/<html>|原始证据正文/.test(JSON.stringify(trace.body)), false);
  } finally {
    if (originalToken === undefined) delete process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
    else process.env.NETLIFY_TAXKB_ADMIN_TOKEN = originalToken;
    await database.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('Phase 2D 首次失败不会完成；安全重试完成后才阻止后续网络请求', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taxkb-phase2d-retry-'));
  const database = new NetlifyDB({ directory: path.join(root, 'database'), logger: () => {} });
  const originalToken = process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
  const testAdminToken = `phase2d-retry-${randomUUID()}`;
  process.env.NETLIFY_TAXKB_ADMIN_TOKEN = testAdminToken;
  let failSecond = true;
  let fetchCount = 0;
  try {
    await database.start();
    await database.reset();
    await database.applyMigrations(path.join(process.cwd(), 'netlify', 'database', 'migrations'));
    const repositoryFactory = () => createPostgresEvidenceRepository({
      pool: database,
      objectStore: createLocalEvidenceObjectStore({ rootDirectory: path.join(root, 'taxkb-evidence-raw') })
    });
    const handler = createApiHandler({ evidenceAdminHandler: createEvidenceAdminHandler({
      repositoryFactory,
      fetchImpl: async (url) => {
        fetchCount += 1;
        if (String(url) === secondUrl && failSecond) return new Response('unavailable', { status: 503 });
        return fakeFetch(url);
      }
    }) });

    const input = { method: 'POST', token: testAdminToken, body: { apply: true, confirmation: PHASE_2D_IMPORT_CONFIRMATION } };
    const failed = await call(handler, '/api/admin/evidence/import-phase2b', input);
    assert.equal(failed.response.status, 422);
    assert.deepEqual(await repositoryFactory().counts(), { sources: 1, source_states: 1, collection_runs: 1, raw_snapshots: 1, candidates: 1, review_decisions: 0, policies: 0, policy_versions: 0, policy_relations: 0, audit_events: 0 });
    assert.equal((await database.query("SELECT collection_state FROM collection_runs")).rows[0].collection_state, 'failed');

    failSecond = false;
    const retry = await call(handler, '/api/admin/evidence/import-phase2b', input);
    assert.equal(retry.response.status, 200);
    assert.equal(retry.body.execution, 'completed');
    assert.equal(retry.body.snapshots_created, 2);
    assert.equal(retry.body.candidates_created, 1);
    assert.equal(retry.body.candidates_skipped, 1);
    assert.deepEqual(await repositoryFactory().counts(), { sources: 1, source_states: 1, collection_runs: 2, raw_snapshots: 3, candidates: 2, review_decisions: 0, policies: 0, policy_versions: 0, policy_relations: 0, audit_events: 0 });

    const completed = await call(handler, '/api/admin/evidence/import-phase2b', input);
    assert.equal(completed.response.status, 200);
    assert.equal(completed.body.execution, 'already_completed');
    assert.equal(fetchCount, 4, 'post-completion call must not fetch either official detail page');
  } finally {
    if (originalToken === undefined) delete process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
    else process.env.NETLIFY_TAXKB_ADMIN_TOKEN = originalToken;
    await database.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('Phase 2D production-style advisory lock lets only one concurrent request enter the completion and import interval', async () => {
  let locked = false;
  let releaseFirstFetch;
  let firstFetchStarted;
  const firstFetchGate = new Promise((resolve) => { releaseFirstFetch = resolve; });
  const firstFetchStartedGate = new Promise((resolve) => { firstFetchStarted = resolve; });
  let fetchCount = 0;
  let sourceCount = 0;
  let runCount = 0;
  let snapshotCount = 0;
  let candidateCount = 0;
  const objectStore = { putImmutable: async () => {}, read: async () => '' };
  const repository = {
    async withExclusiveLock(_name, work) {
      if (locked) return { acquired: false, result: null };
      locked = true;
      try { return { acquired: true, result: await work() }; } finally { locked = false; }
    },
    async hasCompletedCandidatesForUrls() { return false; },
    async addSource(value) { sourceCount += 1; return value; },
    async createCollectionRun({ source_id, mode }) { runCount += 1; return { collection_run_id: `run-${runCount}`, source_id, mode }; },
    async recordRawSnapshot(input) { snapshotCount += 1; return { snapshot_id: `snapshot-${snapshotCount}`, source_id: input.source_id, official_url: input.official_url }; },
    async createCandidate({ snapshot_id, verification_state, legal_status }) { candidateCount += 1; return { created: true, candidate: { candidate_id: `candidate-${candidateCount}`, snapshot_id, last_seen_snapshot_id: snapshot_id, source_id: 'source-chinatax-policy-regulations', official_url: candidateCount === 1 ? firstUrl : secondUrl, verification_state, legal_status, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' } }; },
    async finishCollectionRun() {},
    objectStore
  };
  const fetchImpl = async (url) => {
    fetchCount += 1;
    if (fetchCount === 1) {
      firstFetchStarted();
      await firstFetchGate;
    }
    return fakeFetch(url);
  };
  const first = ingestPhase2BWhitelistOnce({ repository, fetchImpl });
  await firstFetchStartedGate;
  const concurrent = await ingestPhase2BWhitelistOnce({ repository, fetchImpl });
  assert.equal(concurrent.execution, 'in_progress');
  assert.equal(fetchCount, 1);
  assert.equal(sourceCount, 1);
  assert.equal(runCount, 1);
  releaseFirstFetch();
  const completed = await first;
  assert.equal(completed.execution, 'completed');
  assert.equal(fetchCount, 2);
  assert.equal(snapshotCount, 2);
  assert.equal(candidateCount, 2);
});

test('Phase 2B Candidate 可从不可变 Raw HTML 重新解析正文，不新建 Candidate 或 Snapshot', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taxkb-evidence-reparse-'));
  const database = new NetlifyDB({ directory: path.join(root, 'database'), logger: () => {} });
  const originalToken = process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
  const testAdminToken = `evidence-reparse-${randomUUID()}`;
  process.env.NETLIFY_TAXKB_ADMIN_TOKEN = testAdminToken;
  const projections = [];
  try {
    await database.start();
    await database.reset();
    await database.applyMigrations(path.join(process.cwd(), 'netlify', 'database', 'migrations'));
    const repositoryFactory = () => createPostgresEvidenceRepository({
      pool: database,
      objectStore: createLocalEvidenceObjectStore({ rootDirectory: path.join(root, 'taxkb-evidence-raw') })
    });
    const handler = createApiHandler({ evidenceAdminHandler: createEvidenceAdminHandler({
      repositoryFactory,
      fetchImpl: fakeFetch,
      publishProjection: async (policy) => { projections.push(policy); return { total: 1, added: 1, updated: 0, skipped: 0, errors: [] }; }
    }) });
    const ingest = await call(handler, '/api/admin/evidence/import-phase2b', { method: 'POST', token: testAdminToken, body: { apply: true, confirmation: PHASE_2D_IMPORT_CONFIRMATION } });
    assert.equal(ingest.response.status, 200);
    const reparseInput = { method: 'POST', token: testAdminToken, body: { apply: true, confirmation: PHASE_2D_REPARSE_CONFIRMATION } };
    const first = await call(handler, '/api/admin/evidence/reparse-phase2b', reparseInput);
    assert.equal(first.response.status, 200);
    assert.equal(first.body.execution, 'reparsed');
    assert.equal(first.body.reparsed_candidates, 2);
    assert.ok(first.body.results.every((item) => item.verification_state === 'pending_review' && item.legal_status === 'pending'));
    assert.deepEqual(await repositoryFactory().counts(), { sources: 1, source_states: 1, collection_runs: 1, raw_snapshots: 2, candidates: 2, review_decisions: 0, policies: 0, policy_versions: 0, policy_relations: 0, audit_events: 2 });

    const repeatBeforeReview = await call(handler, '/api/admin/evidence/reparse-phase2b', reparseInput);
    assert.equal(repeatBeforeReview.response.status, 200);
    assert.deepEqual(await repositoryFactory().counts(), { sources: 1, source_states: 1, collection_runs: 1, raw_snapshots: 2, candidates: 2, review_decisions: 0, policies: 0, policy_versions: 0, policy_relations: 0, audit_events: 2 });
    const importAfterReparse = await call(handler, '/api/admin/evidence/import-phase2b', { method: 'POST', token: testAdminToken, body: { apply: true, confirmation: PHASE_2D_IMPORT_CONFIRMATION } });
    assert.equal(importAfterReparse.response.status, 200);
    assert.equal(importAfterReparse.body.execution, 'already_completed');
    assert.deepEqual(await repositoryFactory().counts(), { sources: 1, source_states: 1, collection_runs: 1, raw_snapshots: 2, candidates: 2, review_decisions: 0, policies: 0, policy_versions: 0, policy_relations: 0, audit_events: 2 });

    const candidateId = ingest.body.results[0].candidate.candidate_id;
    const detail = await call(handler, `/api/admin/evidence/candidates/${candidateId}`, { token: testAdminToken });
    assert.equal(detail.response.status, 200);
    assert.match(detail.body.detail.raw_snapshot.normalized_text, /第一条 原始证据正文一/);
    assert.doesNotMatch(detail.body.detail.raw_snapshot.normalized_text, /登录|本站热词|个人中心/);
    assert.match(detail.body.detail.raw_snapshot.raw_html, /登录 本站热词 个人中心/);
    assert.doesNotMatch(JSON.stringify(detail.body.detail.candidate.parsed_fields), /normalized_text_object_key/);

    const approved = await call(handler, `/api/admin/evidence/candidates/${candidateId}/review`, {
      method: 'POST', token: testAdminToken,
      body: { action: 'approve', legal_status: 'pending', fields: {
        title: detail.body.detail.candidate.parsed_fields.title,
        document_no: detail.body.detail.candidate.parsed_fields.document_no,
        issuing_authority: detail.body.detail.candidate.parsed_fields.issuing_authority,
        publish_date: detail.body.detail.candidate.parsed_fields.publish_date,
        effective_date: detail.body.detail.candidate.parsed_fields.effective_date,
        expiry_date: detail.body.detail.candidate.parsed_fields.expiry_date,
        tax_categories: [], keywords: []
      } }
    });
    assert.equal(approved.response.status, 200);
    assert.equal(projections.length, 1);
    assert.match(projections[0].evidence.normalized_text, /第一条 原始证据正文一/);
    assert.doesNotMatch(projections[0].evidence.normalized_text, /登录|本站热词|个人中心/);

    const second = await call(handler, '/api/admin/evidence/reparse-phase2b', reparseInput);
    assert.equal(second.response.status, 422, '已审核 Candidate 不能通过重新解析接口重写');
    assert.deepEqual(await repositoryFactory().counts(), { sources: 1, source_states: 1, collection_runs: 1, raw_snapshots: 2, candidates: 2, review_decisions: 1, policies: 1, policy_versions: 1, policy_relations: 0, audit_events: 3 });
  } finally {
    if (originalToken === undefined) delete process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
    else process.env.NETLIFY_TAXKB_ADMIN_TOKEN = originalToken;
    await database.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('Evidence Candidate 经过 Level 3 审核后生成幂等 Policy Version 与公开投影', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taxkb-evidence-review-api-'));
  const database = new NetlifyDB({ directory: path.join(root, 'database'), logger: () => {} });
  const originalToken = process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
  const testAdminToken = `evidence-review-${randomUUID()}`;
  process.env.NETLIFY_TAXKB_ADMIN_TOKEN = testAdminToken;
  const projections = [];
  try {
    await database.start();
    await database.reset();
    await database.applyMigrations(path.join(process.cwd(), 'netlify', 'database', 'migrations'));
    const repositoryFactory = () => createPostgresEvidenceRepository({
      pool: database,
      objectStore: createLocalEvidenceObjectStore({ rootDirectory: path.join(root, 'taxkb-evidence-raw') })
    });
    const handler = createApiHandler({ evidenceAdminHandler: createEvidenceAdminHandler({
      repositoryFactory,
      fetchImpl: fakeFetch,
      publishProjection: async (policy) => { projections.push(policy); return { dryRun: false, total: 1, added: projections.length === 1 ? 1 : 0, updated: projections.length > 1 ? 1 : 0, skipped: 0, errors: [] }; }
    }) });
    const ingest = await call(handler, '/api/admin/evidence/import-phase2b', { method: 'POST', token: testAdminToken, body: { apply: true, confirmation: PHASE_2D_IMPORT_CONFIRMATION } });
    const candidateId = ingest.body.results[0].candidate.candidate_id;

    const noToken = await call(handler, '/api/admin/evidence/candidates');
    assert.equal(noToken.response.status, 401);
    const detail = await call(handler, `/api/admin/evidence/candidates/${candidateId}`, { token: testAdminToken });
    assert.equal(detail.response.status, 200);
    assert.match(detail.body.detail.raw_snapshot.normalized_text, /原始证据正文一/);
    assert.match(detail.body.detail.raw_snapshot.raw_html, /<html>/);

    const reviewBody = { action: 'approve', legal_status: 'effective', note: 'Level 3 已人工核验。', fields: { title: detail.body.detail.candidate.parsed_fields.title, document_no: detail.body.detail.candidate.parsed_fields.document_no, issuing_authority: detail.body.detail.candidate.parsed_fields.issuing_authority, publish_date: detail.body.detail.candidate.parsed_fields.publish_date, effective_date: detail.body.detail.candidate.parsed_fields.effective_date, expiry_date: null, tax_categories: ['个人所得税'], keywords: ['限售股'] } };
    const first = await call(handler, `/api/admin/evidence/candidates/${candidateId}/review`, { method: 'POST', token: testAdminToken, body: reviewBody });
    assert.equal(first.response.status, 200);
    assert.equal(first.body.execution, 'approve');
    assert.equal(first.body.candidate.verification_state, 'verified');
    assert.equal(first.body.candidate.legal_status, 'effective');
    assert.equal(first.body.policy_version.candidate_id, candidateId);
    assert.equal(projections.length, 1);
    assert.equal(projections[0].title, reviewBody.fields.title);
    assert.equal(projections[0].evidence.normalized_text.includes('原始证据正文一'), true);

    const repeat = await call(handler, `/api/admin/evidence/candidates/${candidateId}/review`, { method: 'POST', token: testAdminToken, body: reviewBody });
    assert.equal(repeat.response.status, 200);
    assert.equal(repeat.body.execution, 'already_approved');
    assert.equal(repeat.body.policy_version.policy_version_id, first.body.policy_version.policy_version_id);
    const counts = await repositoryFactory().counts();
    assert.equal(counts.review_decisions, 1);
    assert.equal(counts.policies, 1);
    assert.equal(counts.policy_versions, 1);
    assert.equal(counts.audit_events, 1);
  } finally {
    if (originalToken === undefined) delete process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
    else process.env.NETLIFY_TAXKB_ADMIN_TOKEN = originalToken;
    await database.stop();
    await rm(root, { recursive: true, force: true });
  }
});
