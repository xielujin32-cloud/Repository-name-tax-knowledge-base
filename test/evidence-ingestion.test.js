import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NetlifyDB } from '@netlify/database-dev';
import { createApiHandler } from '../netlify/functions/api.mjs';
import { createEvidenceAdminHandler, PHASE_2D_IMPORT_CONFIRMATION } from '../netlify/lib/evidence-ingestion.mjs';
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
    const handler = createApiHandler({ evidenceAdminHandler: createEvidenceAdminHandler({ repositoryFactory, fetchImpl: fakeFetch }) });
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
    assert.ok(first.body.results.every((item) => item.candidate.verification_state === 'pending_review' && item.candidate.legal_status === 'pending'));

    const second = await call(handler, '/api/admin/evidence/import-phase2b', { method: 'POST', token: testAdminToken, body: { apply: true, confirmation: PHASE_2D_IMPORT_CONFIRMATION } });
    assert.equal(second.response.status, 200);
    assert.equal(second.body.snapshots_created, 2);
    assert.equal(second.body.candidates_created, 0);
    assert.equal(second.body.candidates_skipped, 2);

    const status = await call(handler, '/api/admin/evidence/status', { token: testAdminToken });
    assert.equal(status.response.status, 200);
    assert.deepEqual(status.body.counts, { sources: 1, source_states: 1, collection_runs: 2, raw_snapshots: 4, candidates: 2, review_decisions: 0, policies: 0, policy_versions: 0, policy_relations: 0, audit_events: 0 });
    assert.equal(status.body.candidates.length, 2);
    assert.ok(status.body.candidates.every((item) => item.verification_state === 'pending_review' && item.legal_status === 'pending'));

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
