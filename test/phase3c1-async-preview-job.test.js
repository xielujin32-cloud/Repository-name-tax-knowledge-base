import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NetlifyDB } from '@netlify/database-dev';
import { createEvidenceAdminHandler } from '../netlify/lib/evidence-ingestion.mjs';
import { runPhase3C1PreviewJob } from '../netlify/lib/phase3c1-preview-job.mjs';
import { createPhase3C1PreviewJobBackgroundHandler } from '../netlify/functions/phase3c1-preview-job-background.mjs';
import { createHash } from 'node:crypto';
import { Phase3C1PreviewFailure, PHASE3C1_ORIGINAL_ELIGIBLE_CANDIDATE_POOL, collectPhase3C1ApplyMaterial, phase3c1PreviewJobSelectionInput } from '../src/phase3c1-controlled-import.js';
import { createPostgresEvidenceRepository } from '../src/postgres-evidence-repository.js';
import { createLocalEvidenceObjectStore } from '../src/evidence-object-store.js';

const request = (handler, pathname, { method = 'GET', token = '', body } = {}) => { const url = new URL(`https://example.test${pathname}`); return handler(new Request(url, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }), pathname, url); };
const fakeJob = (state = 'queued') => ({ job_id: 'phase3c1-preview-job-1', job_state: state, completed_count: 0, total_count: 10, current_ordinal: null, selection_rule_version: 'v', candidate_pool_version: 'pool', candidate_pool_hash: 'a'.repeat(64), selection_hash: 'b'.repeat(64), selection_input: phase3c1PreviewJobSelectionInput(), selected_items: [], skip_audit: [], safe_failure: {}, preview_job_audit_writes: 1, business_production_writes: 0 });
const stable = (value) => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
const sha256 = (value) => createHash('sha256').update(String(value || '')).digest('hex');
const tenOnlyFrozenInput = () => {
  const base = phase3c1PreviewJobSelectionInput(); const frozen_candidate_pool = base.frozen_candidate_pool.slice(0, 10);
  const candidate_pool_hash = sha256(stable({ candidate_pool_version: base.candidate_pool_version, original_candidate_count: 50, eligible_candidate_count: 10, candidates: frozen_candidate_pool.map(({ original_rank, original_index, official_url }) => ({ original_rank, original_index, official_url })) }));
  return { ...base, eligible_candidate_count: 10, frozen_candidate_pool, candidate_pool_hash };
};

test('异步 Preview Job API 必须管理员认证、拒绝目标注入且只调度固定 Job', async () => {
  const previous = process.env.NETLIFY_TAXKB_ADMIN_TOKEN; process.env.NETLIFY_TAXKB_ADMIN_TOKEN = 'token';
  const created = fakeJob(); const calls = [];
  const repository = { createPhase3C1PreviewJob: async () => ({ created: true, job: created }), getPhase3C1PreviewJob: async () => created };
  const handler = createEvidenceAdminHandler({ repositoryFactory: () => repository, phase3c1PreviewJobDispatcher: async (value) => calls.push(value) });
  try {
    assert.equal((await request(handler, '/api/admin/evidence/phase3c1/import-preview-jobs', { method: 'POST' })).status, 401);
    assert.equal((await request(handler, '/api/admin/evidence/phase3c1/import-preview-jobs', { method: 'POST', token: 'token', body: { url: 'https://attacker.invalid/' } })).status, 400);
    const response = await request(handler, '/api/admin/evidence/phase3c1/import-preview-jobs', { method: 'POST', token: 'token' });
    assert.equal(response.status, 202); const body = await response.json(); assert.equal(body.job.business_production_writes, 0); assert.deepEqual(calls, [{ job_id: created.job_id }]);
    const stale = { ...created, is_stale: true };
    const staleHandler = createEvidenceAdminHandler({ repositoryFactory: () => ({ getPhase3C1PreviewJob: async () => stale }) });
    const staleResponse = await request(staleHandler, `/api/admin/evidence/phase3c1/import-preview-jobs/${created.job_id}`, { token: 'token' });
    const staleBody = await staleResponse.json(); assert.equal(staleBody.job.status, 'failed'); assert.equal(staleBody.job.failure_code, 'PREVIEW_JOB_STALE'); assert.equal(staleBody.job.ready_to_create_frozen_manifest, 'NO');
  } finally { if (previous === undefined) delete process.env.NETLIFY_TAXKB_ADMIN_TOKEN; else process.env.NETLIFY_TAXKB_ADMIN_TOKEN = previous; }
});

test('异步 Worker 只消费 Job frozen snapshot，PASS 不创建 manifest 或业务对象', async () => {
  const calls = []; let finishedWithSelection; const repository = {
    beginPhase3C1PreviewJob: async () => ({ claimed: true, job: fakeJob('running') }),
    updatePhase3C1PreviewJobProgress: async (_, progress) => calls.push(progress),
    finishPhase3C1PreviewJob: async (_, { preview, frozen_selection_input }) => { finishedWithSelection = frozen_selection_input; return { ...fakeJob('passed'), completed_count: 10, result_hash: preview.manifest_hash }; },
    blockPhase3C1PreviewJob: async () => assert.fail('must not block'), failPhase3C1PreviewJob: async () => assert.fail('must not fail')
  };
  const preview = { manifest_hash: 'c'.repeat(64), selection_criteria: { selected: [{ ordinal: 1, original_rank: 1, original_index: 4, official_url: 'https://fgk.chinatax.gov.cn/fixed' }] }, skip_audit: [], items: Array.from({ length: 10 }, (_, index) => ({ ordinal: index + 1, body_hash: 'd'.repeat(64), document_no: `国税发〔2020〕${index + 1}号`, document_no_provenance: { confidence: 'high', source: 'structured_field' }, risk_assessment: { risk_level: 'low', risk_score: 0 }, relation_proposals: { proposed_count: 0 } })) };
  let receivedSelection;
  const result = await runPhase3C1PreviewJob({ job_id: 'job', repository, collectPreview: async ({ onProgress, frozen_selection_input }) => { receivedSelection = frozen_selection_input; await onProgress({ current_ordinal: 1, completed_count: 1, total_count: 10, selected_items: [{ ordinal: 1 }], skip_audit: [] }); return { preview }; } });
  assert.equal(result.job_state, 'passed'); assert.equal(calls.length, 1); assert.equal(JSON.stringify(calls).includes('raw_html'), false);
  assert.deepEqual(receivedSelection.frozen_candidate_pool, phase3c1PreviewJobSelectionInput().frozen_candidate_pool);
  assert.deepEqual(finishedWithSelection.frozen_candidate_pool, receivedSelection.frozen_candidate_pool);
});

test('Worker 对 PreviewFailure block，对未知异常 failed，且不泄露异常文本', async () => {
  const secret = 'DO_NOT_PERSIST_SECRET_HTML'; let blocked; let failed;
  const repository = { beginPhase3C1PreviewJob: async () => ({ claimed: true, job: fakeJob('running') }), updatePhase3C1PreviewJobProgress: async () => {}, blockPhase3C1PreviewJob: async (_, value) => { blocked = value; return fakeJob('blocked'); }, failPhase3C1PreviewJob: async (_, value) => { failed = value; return fakeJob('failed'); } };
  const failure = new Phase3C1PreviewFailure({ ordinal: 10, stage: 'body-container', processed_count: 9, code: 'INCOMPLETE_HTML_200' });
  await runPhase3C1PreviewJob({ job_id: 'job', repository, collectPreview: async () => { throw failure; } }); assert.equal(blocked.failure_code, 'INCOMPLETE_HTML_200');
  await runPhase3C1PreviewJob({ job_id: 'job', repository, collectPreview: async () => { throw new Error(secret); } }); assert.equal(failed.exception_type, 'Error'); assert.equal(JSON.stringify(failed).includes(secret), false);
});

test('缺失或篡改 frozen selection 时 Worker fail-closed，绝不调用 collection', async () => {
  let called = false; let blocked;
  const repository = { beginPhase3C1PreviewJob: async () => ({ claimed: true, job: { ...fakeJob('running'), selection_input: { phase: 'phase3c1' } } }), blockPhase3C1PreviewJob: async (_, value) => { blocked = value; return fakeJob('blocked'); } };
  await runPhase3C1PreviewJob({ job_id: 'job', repository, collectPreview: async () => { called = true; } });
  assert.equal(called, false); assert.equal(blocked.failure_code, 'FROZEN_SELECTION_INPUT_INVALID');
});

test('fallback strictly stops at a frozen pool boundary and cannot reach the global pool', async () => {
  const frozen = tenOnlyFrozenInput(); const calls = [];
  const incomplete = '<html><body>short</body></html>';
  await assert.rejects(() => collectPhase3C1ApplyMaterial({ frozen_selection_input: frozen, waitImpl: async () => {}, fetchImpl: async (url) => { calls.push(String(url)); return new Response(incomplete, { status: 200, headers: { 'content-type': 'text/html' } }); } }), (error) => error instanceof Phase3C1PreviewFailure && error.safe_diagnostic.failure_code === 'CANDIDATE_POOL_EXHAUSTED');
  assert.equal(calls.length, 20, 'each frozen candidate gets only two transient attempts');
  assert.equal(new Set(calls).size, 10); assert.deepEqual([...new Set(calls)], frozen.frozen_candidate_pool.map((item) => item.official_url));
  assert.equal(calls.includes(PHASE3C1_ORIGINAL_ELIGIBLE_CANDIDATE_POOL[10].official_url), false);
});

test('Background route accepts only internally authenticated job_id and never accepts URL', async () => {
  const calls = []; const handler = createPhase3C1PreviewJobBackgroundHandler({ dispatchToken: () => 'internal', repositoryFactory: () => ({ marker: true }), previewJobRunner: async (input) => calls.push(input) });
  assert.equal((await handler(new Request('https://x', { method: 'POST', body: JSON.stringify({ job_id: 'x' }) }))).status, 401);
  assert.equal((await handler(new Request('https://x', { method: 'POST', headers: { 'x-phase3c1-preview-dispatch': 'internal', 'content-type': 'application/json' }, body: JSON.stringify({ job_id: 'x', url: 'https://attacker.invalid' }) }))).status, 400);
  assert.equal((await handler(new Request('https://x', { method: 'POST', headers: { 'x-phase3c1-preview-dispatch': 'internal', 'content-type': 'application/json' }, body: JSON.stringify({ job_id: 'x' }) }))).status, 204); assert.equal(calls.length, 1); assert.equal(calls[0].job_id, 'x');
});

test('Preview Job 持久化输入幂等、进度可审计、stale 可恢复且业务写入始终为零', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taxkb-async-preview-job-')); const database = new NetlifyDB({ directory: path.join(root, 'database'), logger: () => {} });
  let timestamp = '2026-09-08T00:00:00.000Z'; let sequence = 0;
  await database.start(); await database.reset(); await database.applyMigrations(path.join(process.cwd(), 'netlify', 'database', 'migrations'));
  const repository = createPostgresEvidenceRepository({ pool: database, objectStore: createLocalEvidenceObjectStore({ rootDirectory: path.join(root, 'objects') }), id: (prefix) => `${prefix}-${++sequence}`, clock: () => timestamp });
  try {
    const first = await repository.createPhase3C1PreviewJob(); const repeated = await repository.createPhase3C1PreviewJob();
    assert.equal(first.created, true); assert.equal(repeated.created, false); assert.equal(repeated.job.job_id, first.job.job_id);
    assert.equal((await repository.beginPhase3C1PreviewJob(first.job.job_id)).claimed, true);
    await repository.updatePhase3C1PreviewJobProgress(first.job.job_id, { current_ordinal: 3, completed_count: 2, total_count: 10, selected_items: [{ ordinal: 1, original_rank: 1, original_index: 4, official_url: 'https://fgk.chinatax.gov.cn/fixed' }], skip_audit: [] });
    assert.equal((await repository.getPhase3C1PreviewJob(first.job.job_id)).completed_count, 2);
    timestamp = '2026-09-08T00:21:00.000Z'; const stale = await repository.getPhase3C1PreviewJob(first.job.job_id); assert.equal(stale.is_stale, true);
    const replacement = await repository.createPhase3C1PreviewJob(); assert.equal(replacement.created, true); assert.notEqual(replacement.job.job_id, first.job.job_id);
    const old = await repository.getPhase3C1PreviewJob(first.job.job_id); assert.equal(old.job_state, 'failed'); assert.equal(old.failure_code, 'PREVIEW_JOB_STALE');
    const counts = await repository.counts(); assert.equal(counts.raw_snapshots, 0); assert.equal(counts.candidates, 0); assert.equal(counts.policies, 0); assert.equal((await database.query('SELECT COUNT(*)::int AS count FROM controlled_import_manifests')).rows[0].count, 0);
  } finally { await database.stop(); await rm(root, { recursive: true, force: true }); }
});
