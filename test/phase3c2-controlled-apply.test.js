import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NetlifyDB } from '@netlify/database-dev';
import { createApiHandler } from '../netlify/functions/api.mjs';
import { createEvidenceAdminHandler } from '../netlify/lib/evidence-ingestion.mjs';
import { createLocalEvidenceObjectStore } from '../src/evidence-object-store.js';
import { createPostgresEvidenceRepository, phase3c1FrozenManifestIntegrity, phase3c1PreviewJobMaterialReadiness } from '../src/postgres-evidence-repository.js';
import { PHASE3C1_FIXED_IMPORT_URLS, PHASE3C2_CONTROLLED_APPLY_CONFIRMATION, collectPhase3C1ApplyMaterial, phase3c1ManifestFingerprint, phase3c1PreviewJobSelectionInput } from '../src/phase3c1-controlled-import.js';

const body = (index) => `为明确个人所得税征管事项，现将第${index}项安排公告如下。纳税人应当按照规定办理申报并保留资料，税务机关应当依法提供征管服务。${'本公告明确适用对象、申报要求、资料留存和监督管理安排。'.repeat(20)}`;
const html = (index) => `<!doctype html><html><head><meta name="PubDate" content="2020-01-${String(index).padStart(2, '0')}"></head><body><div class="detials contentLeft"><h3>国家税务总局关于第${index}项个人所得税征管事项的公告</h3><h5 class="actfwzh">国税发〔2020〕${index}号</h5><div class="article"><div class="arc_cont"><p>${body(index)}</p></div></div></div></body></html>`;
const clone = (value) => JSON.parse(JSON.stringify(value));

function fakeFetch(url) {
  const index = PHASE3C1_FIXED_IMPORT_URLS.indexOf(String(url)) + 1;
  return Promise.resolve(index ? new Response(html(index), { status: 200, headers: { 'content-type': 'text/html' } }) : new Response('not found', { status: 404 }));
}

async function fixture({ objectStoreFactory = createLocalEvidenceObjectStore, poolFactory = (database) => database } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taxkb-phase3c2-'));
  const database = new NetlifyDB({ directory: path.join(root, 'database'), logger: () => {} });
  await database.start(); await database.reset();
  await database.applyMigrations(path.join(process.cwd(), 'netlify', 'database', 'migrations'));
  const repository = createPostgresEvidenceRepository({
    pool: poolFactory(database),
    objectStore: objectStoreFactory({ rootDirectory: path.join(root, 'objects') }),
    id: (prefix) => `${prefix}-${randomUUID()}`
  });
  return { root, database, repository };
}
async function close(value) { await value.database.stop(); await rm(value.root, { recursive: true, force: true }); }
async function createFrozenReady(value) {
  const frozenSelection = phase3c1PreviewJobSelectionInput();
  const collected = await collectPhase3C1ApplyMaterial({ fetchImpl: fakeFetch, now: '2026-09-07T00:00:00.000Z', waitImpl: async () => {}, frozen_selection_input: frozenSelection });
  const job = (await value.repository.createPhase3C1PreviewJob({ created_by: 'test-admin' })).job;
  await value.repository.beginPhase3C1PreviewJob(job.job_id);
  await value.repository.persistPhase3C1PreviewJobMaterials(job.job_id, { preview: collected.preview, materials: collected.materials, frozen_selection_input: frozenSelection });
  await value.repository.finishPhase3C1PreviewJob(job.job_id, { preview: collected.preview, state: 'passed', frozen_selection_input: frozenSelection });
  const frozen = await value.repository.createPhase3C1FrozenImportManifestFromPreviewJob({ source_preview_job_id: job.job_id, created_by: 'test-admin' });
  const checked = await value.repository.createPhase3C2ControlledPreflight({ controlled_manifest_id: frozen.manifest.controlled_manifest_id, manifest_hash: frozen.manifest.manifest_hash, checked_by: 'test-admin' });
  assert.equal(checked.preflight.preflight_state, 'ready', JSON.stringify(checked.evidence.validation));
  return { collected, job, frozen, checked };
}
async function request(handler, pathname, { method = 'GET', token = '', body: input } = {}) {
  const response = await handler(new Request(`https://taxkb.example${pathname}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(input ? { 'content-type': 'application/json' } : {}) }, body: input ? JSON.stringify(input) : undefined }));
  return { response, body: await response.json() };
}

test('Phase 3C-2 Apply 在一个数据库事务内创建待审 Evidence，并发与重复请求不会重复创建', async () => {
  const value = await fixture();
  try {
    const { collected, frozen, checked } = await createFrozenReady(value);
    const sameContentLater = await collectPhase3C1ApplyMaterial({ fetchImpl: fakeFetch, now: '2026-09-08T00:00:00.000Z', waitImpl: async () => {} });
    assert.equal(sameContentLater.preview.manifest_hash, collected.preview.manifest_hash, 'metadata generated_at must not invalidate an otherwise identical frozen body');
    const input = { controlled_manifest_id: frozen.manifest.controlled_manifest_id, manifest_hash: frozen.manifest.manifest_hash, preflight_id: checked.preflight.preflight_id, operator_id: 'test-admin' };
    const concurrent = await Promise.allSettled([value.repository.applyPhase3C2ControlledImport(input), value.repository.applyPhase3C2ControlledImport(input)]);
    assert.equal(concurrent.filter((item) => item.status === 'fulfilled' && item.value.execution === 'completed').length, 1);
    assert.ok(concurrent.some((item) => item.status === 'rejected' || item.value?.execution !== 'completed'));
    const counts = await value.repository.counts();
    assert.equal(counts.raw_snapshots, 10); assert.equal(counts.candidates, 10);
    assert.equal(counts.review_decisions, 0); assert.equal(counts.policies, 0); assert.equal(counts.policy_versions, 0);
    assert.equal((await value.database.query("SELECT COUNT(*)::int AS count FROM candidate_risk_assessments WHERE is_current")).rows[0].count, 10);
    const manifest = await value.repository.getControlledImportManifest(frozen.manifest.controlled_manifest_id);
    assert.equal(manifest.manifest.manifest_state, 'consumed');
    assert.equal((await value.repository.getPhase3C2ControlledPreflight(checked.preflight.preflight_id)).preflight_state, 'consumed');
    const replay = await value.repository.applyPhase3C2ControlledImport(input);
    assert.equal(replay.execution, 'already_completed');
    assert.deepEqual(await value.repository.counts(), counts, 'same frozen manifest must not create a second Evidence chain');
    const candidate = (await value.repository.listCandidatesForReview({ limit: 20 })).find((item) => item.official_url === PHASE3C1_FIXED_IMPORT_URLS[0]);
    assert.equal(candidate.verification_state, 'pending_review'); assert.equal(candidate.legal_status, 'pending');
  } finally { await close(value); }
});

test('PASSED Preview Job 冻结完整 material 后可幂等创建 manifest，且不把正文写入数据库', async () => {
  const value = await fixture();
  try {
    const { job, frozen } = await createFrozenReady(value);
    assert.equal(frozen.manifest.source_preview_job_id, job.job_id);
    const repeated = await value.repository.createPhase3C1FrozenImportManifestFromPreviewJob({ source_preview_job_id: job.job_id, created_by: 'another-admin' });
    assert.equal(repeated.created, false); assert.equal(repeated.manifest.controlled_manifest_id, frozen.manifest.controlled_manifest_id); assert.equal(repeated.manifest.manifest_hash, frozen.manifest.manifest_hash);
    const rows = (await value.database.query('SELECT item,material_provenance,raw_object_key,normalized_text_object_key FROM phase3c1_preview_job_materials WHERE job_id=$1 ORDER BY ordinal', [job.job_id])).rows;
    assert.equal(rows.length, 10); assert.equal(JSON.stringify(rows).includes(body(1)), false, 'no full policy body may be persisted in job audit rows');
    assert.equal((await value.repository.counts()).raw_snapshots, 0); assert.equal((await value.repository.counts()).candidates, 0); assert.equal((await value.repository.counts()).policies, 0);
  } finally { await close(value); }
});

test('Frozen Manifest GET integrity 逐条核验来源 Job material，不读取正文或对象存储', async () => {
  const value = await fixture();
  const previous = process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
  process.env.NETLIFY_TAXKB_ADMIN_TOKEN = 'phase3c1-manifest-integrity-token';
  try {
    const { job, frozen } = await createFrozenReady(value);
    const detail = await value.repository.getPhase3C1PreviewJobReadiness(job.job_id);
    const stored = await value.repository.getPhase3C1FrozenManifestIntegrity(frozen.manifest.controlled_manifest_id);
    const rows = (await value.database.query('SELECT * FROM phase3c1_preview_job_materials WHERE job_id=$1 ORDER BY ordinal', [job.job_id])).rows.map((row) => ({
      ...row,
      item: typeof row.item === 'string' ? JSON.parse(row.item) : row.item,
      material_provenance: typeof row.material_provenance === 'string' ? JSON.parse(row.material_provenance) : row.material_provenance
    }));
    assert.equal(frozen.manifest.manifest_hash, phase3c1ManifestFingerprint({ items: rows.map((row) => row.item), selection_criteria: detail.job.preview_selection_criteria }));
    assert.equal(stored.integrity.source_job_passed, true);
    assert.equal(stored.integrity.material_set_hash, detail.material_readiness.material_set_hash);
    assert.equal(stored.integrity.material_set_hash_matches_rows, true);
    assert.equal(stored.integrity.manifest_items_match_source_materials, true);
    assert.equal(stored.integrity.material_count, 10);
    assert.equal(stored.integrity.complete_material_count, 10);
    assert.equal(stored.integrity.ordinal_complete, true);
    assert.equal(stored.integrity.selection_provenance_complete, true);
    assert.equal(stored.integrity.manifest_hash_matches_frozen_items, true, JSON.stringify({ stored: stored.manifest.manifest_hash, computed: stored.integrity.computed_manifest_hash }));
    assert.equal(stored.integrity.ready_for_preflight_validation, true);

    const notPassed = clone(detail.job); notPassed.job_state = 'blocked';
    assert.equal(phase3c1FrozenManifestIntegrity(stored.manifest, stored.items, notPassed, rows).source_job_passed, false);
    const hashMismatch = clone(rows); hashMismatch[0].material_hash = 'f'.repeat(64);
    assert.equal(phase3c1FrozenManifestIntegrity(stored.manifest, stored.items, detail.job, hashMismatch).material_set_hash_matches_rows, false);
    const manifestMismatch = clone(stored.items); manifestMismatch[0].title = 'unexpected title';
    assert.equal(phase3c1FrozenManifestIntegrity(stored.manifest, manifestMismatch, detail.job, rows).manifest_items_match_source_materials, false);
    const provenanceMismatch = clone(rows); provenanceMismatch[0].original_rank = 99;
    assert.equal(phase3c1FrozenManifestIntegrity(stored.manifest, stored.items, detail.job, provenanceMismatch).selection_provenance_complete, false);

    const handler = createEvidenceAdminHandler({ repositoryFactory: () => value.repository, fetchImpl: async () => { throw new Error('manifest integrity must not fetch official URLs'); } });
    const pathname = `/api/admin/evidence/phase3c1/import-manifests/${frozen.manifest.controlled_manifest_id}`;
    const response = await handler(new Request(`https://taxkb.example${pathname}`, { headers: { authorization: 'Bearer phase3c1-manifest-integrity-token' } }), pathname, new URL(`https://taxkb.example${pathname}`));
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.manifest.source_preview_job_id, job.job_id);
    assert.equal(payload.items.length, 10);
    assert.equal(payload.integrity.manifest_items_match_source_materials, true);
    assert.equal(payload.integrity.ready_for_preflight_validation, true);
    assert.equal(payload.business_production_writes, 0);
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes(body(1)), false, 'Manifest GET must never expose raw or normalized policy body');
    assert.equal(serialized.includes('raw_object_key'), false, 'Manifest GET must never expose protected object keys');
    assert.equal(serialized.includes('normalized_text_object_key'), false, 'Manifest GET must never expose protected object keys');
    assert.equal(serialized.includes('phase3c1-manifest-integrity-token'), false, 'Manifest GET must never expose credentials');
  } finally {
    if (previous === undefined) delete process.env.NETLIFY_TAXKB_ADMIN_TOKEN; else process.env.NETLIFY_TAXKB_ADMIN_TOKEN = previous;
    await close(value);
  }
});

test('Preview Job status 安全验证逐条 material 完整性，不返回正文或对象存储路径', async () => {
  const value = await fixture();
  const previous = process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
  process.env.NETLIFY_TAXKB_ADMIN_TOKEN = 'phase3c1-readiness-token';
  try {
    const { job } = await createFrozenReady(value);
    const detail = await value.repository.getPhase3C1PreviewJobReadiness(job.job_id);
    assert.equal(detail.material_readiness.material_count, 10);
    assert.equal(detail.material_readiness.complete_material_count, 10);
    assert.equal(detail.material_readiness.material_ordinals_complete, true);
    assert.equal(detail.material_readiness.selection_provenance_complete, true);
    assert.equal(detail.material_readiness.material_set_hash_matches_rows, true);
    assert.equal(detail.material_readiness.protected_object_integrity_metadata_present, true);
    assert.equal(detail.material_readiness.ready_to_create_frozen_manifest, 'YES');

    const rows = (await value.database.query('SELECT * FROM phase3c1_preview_job_materials WHERE job_id=$1 ORDER BY ordinal', [job.job_id])).rows.map((row) => ({
      ...row,
      item: typeof row.item === 'string' ? JSON.parse(row.item) : row.item,
      material_provenance: typeof row.material_provenance === 'string' ? JSON.parse(row.material_provenance) : row.material_provenance
    }));
    const incomplete = clone(rows); incomplete[0].item.title = '';
    assert.equal(phase3c1PreviewJobMaterialReadiness(detail.job, incomplete).complete_material_count, 9, 'complete count must validate each material payload, not only row count');

    const handler = createEvidenceAdminHandler({ repositoryFactory: () => value.repository, fetchImpl: async () => { throw new Error('status must not fetch official URLs'); } });
    const pathname = `/api/admin/evidence/phase3c1/import-preview-jobs/${job.job_id}`;
    const response = await handler(new Request(`https://taxkb.example${pathname}`, { headers: { authorization: 'Bearer phase3c1-readiness-token' } }), pathname, new URL(`https://taxkb.example${pathname}`));
    const payload = await response.json();
    assert.equal(response.status, 200); assert.equal(payload.job.job_state, 'passed'); assert.equal(payload.job.preview_result, 'PASS'); assert.equal(payload.job.complete_material_count, 10); assert.equal(payload.job.material_set_hash_matches_rows, true);
    assert.equal(payload.job.selection_provenance_complete, true); assert.equal(payload.job.protected_object_integrity_metadata_present, true); assert.equal(payload.job.ready_to_create_frozen_manifest, 'YES');
    assert.equal(JSON.stringify(payload).includes(body(1)), false, 'status API must never expose raw or normalized policy body');
    assert.equal(JSON.stringify(payload).includes('normalized_text_object_key'), false, 'status API must not expose protected object keys');
    assert.equal(payload.business_production_writes, 0);
  } finally {
    if (previous === undefined) delete process.env.NETLIFY_TAXKB_ADMIN_TOKEN; else process.env.NETLIFY_TAXKB_ADMIN_TOKEN = previous;
    await close(value);
  }
});

test('blocked 或不完整 Preview Job 不能创建 frozen manifest', async () => {
  const value = await fixture();
  try {
    const job = (await value.repository.createPhase3C1PreviewJob()).job;
    await assert.rejects(() => value.repository.createPhase3C1FrozenImportManifestFromPreviewJob({ source_preview_job_id: job.job_id }), /完整 PASSED Preview Job/);
    assert.equal((await value.database.query('SELECT COUNT(*)::int AS count FROM controlled_import_manifests')).rows[0].count, 0);
  } finally { await close(value); }
});

test('Phase 3C-2 拒绝错误 manifest/preflight，失败回滚 Evidence 并要求新的 preflight 才能重试', async () => {
  let writes = 0;
  const cleaned = [];
  const value = await fixture({ objectStoreFactory: (options) => {
    const base = createLocalEvidenceObjectStore(options);
    return { ...base, async putImmutable(key, content) { writes += 1; if (writes === 22) throw new Error('simulated immutable store failure'); return base.putImmutable(key, content); }, async deleteUnreferenced(key) { cleaned.push(key); return base.deleteUnreferenced(key); } };
  } });
  try {
    const { collected, frozen, checked } = await createFrozenReady(value);
    const input = { controlled_manifest_id: frozen.manifest.controlled_manifest_id, manifest_hash: frozen.manifest.manifest_hash, preflight_id: checked.preflight.preflight_id };
    await assert.rejects(() => value.repository.applyPhase3C2ControlledImport({ ...input, manifest_hash: 'a'.repeat(64) }), /manifest hash/);
    await assert.rejects(() => value.repository.applyPhase3C2ControlledImport(input), /simulated immutable store failure/);
    const counts = await value.repository.counts();
    assert.equal(counts.raw_snapshots, 0); assert.equal(counts.candidates, 0); assert.equal(counts.review_decisions, 0); assert.equal(counts.policies, 0);
    assert.equal(cleaned.length, 1, 'a failed transaction must remove the one raw object that was never referenced by a Snapshot');
    assert.equal((await value.repository.getPhase3C2ControlledPreflight(checked.preflight.preflight_id)).preflight_state, 'expired');
    assert.equal((await value.database.query("SELECT apply_state FROM controlled_import_apply_attempts")).rows[0].apply_state, 'failed');
    const retryPreflight = await value.repository.createPhase3C2ControlledPreflight({ controlled_manifest_id: frozen.manifest.controlled_manifest_id, manifest_hash: frozen.manifest.manifest_hash });
    assert.equal(retryPreflight.created, true);
    const retry = await value.repository.applyPhase3C2ControlledImport({ ...input, preflight_id: retryPreflight.preflight.preflight_id });
    assert.equal(retry.execution, 'completed');
  } finally { await close(value); }
});

test('Phase 3C-2 admin API 只能消费服务器 material，拒绝未授权、注入内容、blocked/过期 preflight', async () => {
  const value = await fixture();
  const previous = process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
  process.env.NETLIFY_TAXKB_ADMIN_TOKEN = 'phase3c2-test-token';
  try {
    const { collected, frozen } = await createFrozenReady(value);
    const handler = createApiHandler({ evidenceAdminHandler: createEvidenceAdminHandler({ repositoryFactory: () => value.repository, fetchImpl: async () => { throw new Error('must not fetch after manifest'); }, phase3c1PreviewFactory: async () => { throw new Error('must not re-preview'); }, phase3c1ApplyMaterialFactory: async () => { throw new Error('must not recollect'); } }) });
    const base = `/api/admin/evidence/phase3c1/import-manifests/${frozen.manifest.controlled_manifest_id}`;
    assert.equal((await request(handler, `${base}/preflights`, { method: 'POST', body: { check: true, manifest_hash: frozen.manifest.manifest_hash } })).response.status, 401);
    assert.equal((await request(handler, `${base}/apply`, { method: 'POST', body: { apply: true } })).response.status, 401);
    const injected = await request(handler, `${base}/preflights`, { method: 'POST', token: process.env.NETLIFY_TAXKB_ADMIN_TOKEN, body: { check: true, manifest_hash: frozen.manifest.manifest_hash, urls: ['https://attacker.invalid/'] } });
    assert.equal(injected.response.status, 400);
    const changed = clone(collected.preview); changed.items[0].body_hash = 'a'.repeat(64); changed.manifest_hash = phase3c1ManifestFingerprint({ items: changed.items, selection_criteria: changed.selection_criteria });
    const blocked = await value.repository.createPhase3C2ControlledPreflight({ controlled_manifest_id: frozen.manifest.controlled_manifest_id, manifest_hash: frozen.manifest.manifest_hash, current_preview: changed });
    assert.equal(blocked.preflight.preflight_state, 'blocked');
    const preflight = await request(handler, `${base}/preflights`, { method: 'POST', token: process.env.NETLIFY_TAXKB_ADMIN_TOKEN, body: { check: true, manifest_hash: frozen.manifest.manifest_hash } });
    assert.equal(preflight.response.status, 200); assert.equal(preflight.body.preflight.preflight_state, 'ready');
    const apply = await request(handler, `${base}/apply`, { method: 'POST', token: process.env.NETLIFY_TAXKB_ADMIN_TOKEN, body: { apply: true, confirmation: PHASE3C2_CONTROLLED_APPLY_CONFIRMATION, manifest_hash: frozen.manifest.manifest_hash, preflight_id: preflight.body.preflight.preflight_id } });
    assert.equal(apply.response.status, 200); assert.equal(apply.body.execution, 'completed');
    assert.equal(apply.body.apply.result.review_decision_ids.length, 0); assert.equal(apply.body.apply.result.policy_ids.length, 0); assert.equal(apply.body.apply.result.policy_version_ids.length, 0);

  } finally {
    if (previous === undefined) delete process.env.NETLIFY_TAXKB_ADMIN_TOKEN; else process.env.NETLIFY_TAXKB_ADMIN_TOKEN = previous;
    await close(value);
  }
});

test('Phase 3C-2 拒绝 blocked、过期或不再 frozen 的 preflight，且不创建 Evidence', async () => {
  const value = await fixture();
  try {
    const { collected, frozen } = await createFrozenReady(value);
    const changed = clone(collected.preview);
    changed.items[0].body_hash = 'a'.repeat(64);
    changed.manifest_hash = phase3c1ManifestFingerprint({ items: changed.items, selection_criteria: changed.selection_criteria });
    const blocked = await value.repository.createPhase3C2ControlledPreflight({ controlled_manifest_id: frozen.manifest.controlled_manifest_id, manifest_hash: frozen.manifest.manifest_hash, current_preview: changed });
    assert.equal(blocked.preflight.preflight_state, 'blocked');
    const rejected = await value.repository.applyPhase3C2ControlledImport({ controlled_manifest_id: frozen.manifest.controlled_manifest_id, manifest_hash: frozen.manifest.manifest_hash, preflight_id: blocked.preflight.preflight_id, current_preview: collected.preview, materials: collected.materials });
    assert.equal(rejected.execution, 'rejected'); assert.equal(rejected.apply.failure_reason, 'PREFLIGHT_BLOCKED');
    assert.equal((await value.repository.counts()).candidates, 0);

    const expiring = await value.repository.createPhase3C2ControlledPreflight({ controlled_manifest_id: frozen.manifest.controlled_manifest_id, manifest_hash: frozen.manifest.manifest_hash, current_preview: collected.preview, ttl_ms: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const expired = await value.repository.applyPhase3C2ControlledImport({ controlled_manifest_id: frozen.manifest.controlled_manifest_id, manifest_hash: frozen.manifest.manifest_hash, preflight_id: expiring.preflight.preflight_id, current_preview: collected.preview, materials: collected.materials });
    assert.equal(expired.execution, 'rejected'); assert.equal(expired.apply.failure_reason, 'PREFLIGHT_EXPIRED');
    assert.equal((await value.repository.counts()).candidates, 0);
  } finally { await close(value); }
});

test('Preflight database connection failure creates no additional preflight/audit half-record and no business Evidence', async () => {
  let failDuplicateRead = false;
  const value = await fixture({ poolFactory: (database) => ({
    query: async (...args) => {
      if (failDuplicateRead && String(args[0]).includes('SELECT snapshot_id')) throw new Error('Connection terminated unexpectedly');
      return database.query(...args);
    },
    transaction: database.transaction.bind(database)
  }) });
  try {
    const { frozen } = await createFrozenReady(value);
    const before = await Promise.all([
      value.database.query('SELECT COUNT(*)::int AS count FROM controlled_import_preflights'),
      value.database.query("SELECT COUNT(*)::int AS count FROM audit_events WHERE entity_type='controlled_import_preflight'")
    ]);
    failDuplicateRead = true;
    await assert.rejects(
      () => value.repository.createPhase3C2ControlledPreflight({ controlled_manifest_id: frozen.manifest.controlled_manifest_id, manifest_hash: frozen.manifest.manifest_hash }),
      /Connection terminated unexpectedly/
    );
    const after = await Promise.all([
      value.database.query('SELECT COUNT(*)::int AS count FROM controlled_import_preflights'),
      value.database.query("SELECT COUNT(*)::int AS count FROM audit_events WHERE entity_type='controlled_import_preflight'")
    ]);
    assert.deepEqual(after.map((result) => result.rows), before.map((result) => result.rows), 'failed duplicate validation must not leave a new preflight or audit record');
    const counts = await value.repository.counts();
    assert.equal(counts.raw_snapshots, 0); assert.equal(counts.candidates, 0); assert.equal(counts.policies, 0); assert.equal(counts.policy_versions, 0);
  } finally { await close(value); }
});
