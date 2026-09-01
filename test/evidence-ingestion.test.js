import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NetlifyDB } from '@netlify/database-dev';
import { createApiHandler } from '../netlify/functions/api.mjs';
import { createEvidenceAdminHandler, ingestPhase2BWhitelistOnce, PHASE_2D_IMPORT_CONFIRMATION } from '../netlify/lib/evidence-ingestion.mjs';
import { createLocalEvidenceObjectStore } from '../src/evidence-object-store.js';
import { createPostgresEvidenceRepository } from '../src/postgres-evidence-repository.js';
import { PHASE_2B_ALLOWED_DETAIL_URLS } from '../src/chinatax-evidence-collection.js';

const [firstUrl, secondUrl] = PHASE_2B_ALLOWED_DETAIL_URLS;
const pages = new Map([
  [firstUrl, '<html><body><h1>财政部 税务总局 中国证监会关于规范转让上市公司限售股个人所得税政策的公告</h1><p>财政部 税务总局 中国证监会公告2026年第26号</p><p>发布时间：2026年8月28日</p><p>本公告自2026年9月1日起施行。</p><p>第一条 原始证据正文一。</p></body></html>'],
  [secondUrl, '<html><body><h1>财政部 税务总局关于明确非应税交易等增值税有关事项的公告</h1><p>财政部 税务总局公告2026年第25号</p><p>成文日期：2026-08-27</p><p>自2026年9月1日起施行。</p><p>第一条 原始证据正文二。</p></body></html>']
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
