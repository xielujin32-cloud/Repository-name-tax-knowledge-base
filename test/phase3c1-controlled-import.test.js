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
import { createPostgresEvidenceRepository } from '../src/postgres-evidence-repository.js';
import { PHASE3C1_ASYNC_PREVIEW_TIME_BUDGET_MS, PHASE3C1_CANDIDATE_COOLDOWN_MS, PHASE3C1_FIXED_IMPORT_URLS, PHASE3C1_IMPORT_MANIFEST_CONFIRMATION, PHASE3C1_INCOMPLETE_HTML_RETRY_DELAY_MS, PHASE3C1_ORIGINAL_ELIGIBLE_CANDIDATE_POOL, PHASE3C1_PREVIEW_TIME_BUDGET_MS, Phase3C1PreviewFailure, comparePhase3C1FrozenManifest, fetchParsePhase3C1OfficialDetailWithRetry, preparePhase3C1ImportPreview, validatePhase3C1FallbackSelection } from '../src/phase3c1-controlled-import.js';
import { parseChinaTaxPolicyEvidence } from '../src/chinatax-evidence-collection.js';

const body = (index) => `为明确个人所得税征管事项，现将第${index}项安排公告如下。纳税人应当按照规定办理申报并保留资料，税务机关应当依法提供征管服务。${'本公告明确适用对象、申报要求、资料留存和监督管理安排。'.repeat(20)}`;
const html = (index) => `<!doctype html><html><head><meta name="PubDate" content="2020-01-${String(index).padStart(2, '0')}"></head><body><div class="detials contentLeft"><h3>国家税务总局关于第${index}项个人所得税征管事项的公告</h3><h5 class="actfwzh">国税发〔2020〕${index}号</h5><div class="article"><div class="arc_cont"><p>${body(index)}</p></div></div></div></body></html>`;
const clone = (value) => JSON.parse(JSON.stringify(value));

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taxkb-phase3c1-'));
  const database = new NetlifyDB({ directory: path.join(root, 'database'), logger: () => {} });
  await database.start(); await database.reset();
  await database.applyMigrations(path.join(process.cwd(), 'netlify', 'database', 'migrations'));
  const repository = createPostgresEvidenceRepository({
    pool: database,
    objectStore: createLocalEvidenceObjectStore({ rootDirectory: path.join(root, 'objects') }),
    id: (prefix) => `${prefix}-${randomUUID()}`
  });
  const source = await repository.addSource({ source_id: 'source-phase3c1', source_name: '国家税务总局政策法规库', official_domain: 'fgk.chinatax.gov.cn', source_type: 'official-policy-regulations', adapter_version: 'test', base_url: 'https://fgk.chinatax.gov.cn/zcfgk/' });
  const run = await repository.createCollectionRun({ source_id: source.source_id, mode: 'phase3c1-test' });
  return { root, database, repository, source, run };
}

async function close(value) { await value.database.stop(); await rm(value.root, { recursive: true, force: true }); }
function fakeFetch(url) {
  const index = PHASE3C1_FIXED_IMPORT_URLS.indexOf(String(url)) + 1;
  if (!index) return Promise.resolve(new Response('not found', { status: 404 }));
  return Promise.resolve(new Response(html(index), { status: 200, headers: { 'content-type': 'text/html' } }));
}
const poolRankFor = (url) => PHASE3C1_ORIGINAL_ELIGIBLE_CANDIDATE_POOL.find((item) => item.official_url === String(url))?.original_rank || 0;
const noWait = async () => {};
async function request(handler, pathname, { method = 'GET', token = '', body: input } = {}) {
  const response = await handler(new Request(`https://taxkb.example${pathname}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(input ? { 'content-type': 'application/json' } : {}) },
    body: input ? JSON.stringify(input) : undefined
  }));
  return { response, body: await response.json() };
}

test('Phase 3C-1 服务端固定 preview 冻结 10 条，浏览器不能指定内容', async () => {
  const value = await fixture();
  const previous = process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
  process.env.NETLIFY_TAXKB_ADMIN_TOKEN = 'phase3c1-test-token';
  try {
    const preview = await preparePhase3C1ImportPreview({ fetchImpl: fakeFetch, now: '2026-09-07T00:00:00.000Z', waitImpl: noWait });
    assert.equal(preview.items.length, 10);
    assert.deepEqual(preview.items.map((item) => item.official_url), PHASE3C1_FIXED_IMPORT_URLS);
    assert.ok(preview.items.every((item) => item.risk_assessment.risk_level === 'low' && item.risk_assessment.risk_score === 0));
    assert.ok(preview.items.every((item) => item.document_no_provenance.source === 'structured_field' && item.document_no_provenance.confidence === 'high'));
    assert.ok(preview.items.every((item) => item.relation_proposals.proposed_count === 0));

    const concurrent = await Promise.allSettled([
      value.repository.createPhase3C1FrozenImportManifest({ preview, created_by: 'test-admin-a' }),
      value.repository.createPhase3C1FrozenImportManifest({ preview, created_by: 'test-admin-b' })
    ]);
    const fulfilled = concurrent.filter((item) => item.status === 'fulfilled').map((item) => item.value);
    assert.equal(fulfilled.length, 1, 'concurrent freeze must admit at most one creator');
    const frozen = fulfilled[0];
    assert.equal(frozen.created, true); assert.equal(frozen.items.length, 10);
    assert.equal((await value.repository.counts()).candidates, 0);
    assert.equal((await value.repository.counts()).policies, 0);
    assert.equal((await value.database.query('SELECT COUNT(*)::int AS count FROM controlled_import_manifests')).rows[0].count, 1);
    const repeated = await value.repository.createPhase3C1FrozenImportManifest({ preview, created_by: 'test-admin' });
    assert.equal(repeated.created, false);
    await assert.rejects(() => value.database.query('UPDATE controlled_import_manifests SET manifest_hash=$1 WHERE controlled_manifest_id=$2', ['a'.repeat(64), frozen.manifest.controlled_manifest_id]), /frozen fields are immutable/);
    await assert.rejects(() => value.database.query('UPDATE controlled_import_manifest_items SET title=$1 WHERE controlled_manifest_id=$2', ['rewritten', frozen.manifest.controlled_manifest_id]), /immutable audit records/);
    await assert.rejects(() => value.database.query('DELETE FROM controlled_import_manifests WHERE controlled_manifest_id=$1', [frozen.manifest.controlled_manifest_id]), /retained audit records/);

    const handler = createApiHandler({ evidenceAdminHandler: createEvidenceAdminHandler({ repositoryFactory: () => value.repository, fetchImpl: fakeFetch, phase3c1PreviewFactory: async () => preview }) });
    assert.equal((await request(handler, '/api/admin/evidence/phase3c1/import-preview')).response.status, 401);
    assert.equal((await request(handler, `/api/admin/evidence/phase3c1/import-manifests/${frozen.manifest.controlled_manifest_id}/preflight`)).response.status, 401);
    const visiblePreview = await request(handler, '/api/admin/evidence/phase3c1/import-preview', { token: process.env.NETLIFY_TAXKB_ADMIN_TOKEN });
    assert.equal(visiblePreview.response.status, 200); assert.equal(visiblePreview.body.preview.items.length, 10);
    const injected = await request(handler, '/api/admin/evidence/phase3c1/import-manifests', { method: 'POST', token: process.env.NETLIFY_TAXKB_ADMIN_TOKEN, body: { freeze: true, confirmation: PHASE3C1_IMPORT_MANIFEST_CONFIRMATION, urls: ['https://attacker.invalid/'] } });
    assert.equal(injected.response.status, 400);
  } finally {
    if (previous === undefined) delete process.env.NETLIFY_TAXKB_ADMIN_TOKEN; else process.env.NETLIFY_TAXKB_ADMIN_TOKEN = previous;
    await close(value);
  }
});

test('Phase 3C-1 Preview fail-closed 返回安全的失败 ordinal 和阶段，不泄露正文', async () => {
  const previous = process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
  process.env.NETLIFY_TAXKB_ADMIN_TOKEN = 'phase3c1-failure-token';
  const secret = 'TOP_SECRET_POLICY_BODY_MUST_NOT_LEAK';
  const calls = [];
  const failingFetch = async (url) => {
    const ordinal = PHASE3C1_FIXED_IMPORT_URLS.indexOf(String(url)) + 1;
    calls.push(ordinal);
    if (ordinal === 4) return new Response(`<html><head><title>short response</title></head><body>${secret}</body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
    return new Response(html(ordinal), { status: 200, headers: { 'content-type': 'text/html' } });
  };
  try {
    const handler = createApiHandler({ evidenceAdminHandler: createEvidenceAdminHandler({
      phase3c1PreviewFactory: async () => preparePhase3C1ImportPreview({ fetchImpl: failingFetch, waitImpl: noWait })
    }) });
    const result = await request(handler, '/api/admin/evidence/phase3c1/import-preview', { token: process.env.NETLIFY_TAXKB_ADMIN_TOKEN });
    assert.equal(result.response.status, 422);
    assert.deepEqual(calls, [1, 2, 3, 4], 'first failure must stop the remaining fixed URLs');
    const failure = result.body.failure;
    assert.equal(failure.failed_ordinal, 4);
    assert.equal(failure.failure_stage, 'body-container');
    assert.equal(failure.failure_code, 'POLICY_BODY_CONTAINER_MISSING');
    assert.equal(failure.successfully_processed_count, 3);
    assert.equal(failure.official_url, PHASE3C1_FIXED_IMPORT_URLS[3]);
    assert.equal(failure.http_status, 200); assert.equal(failure.content_type, 'text/html');
    assert.equal(failure.final_url, PHASE3C1_FIXED_IMPORT_URLS[3]);
    assert.deepEqual(failure.redirect, { occurred: false, count: 0 });
    assert.equal(failure.html_character_length, `<html><head><title>short response</title></head><body>${secret}</body></html>`.length);
    assert.equal(failure.html_utf8_byte_length, new TextEncoder().encode(`<html><head><title>short response</title></head><body>${secret}</body></html>`).byteLength);
    assert.match(failure.html_sha256, /^[a-f0-9]{64}$/);
    assert.equal(failure.page_title, 'short response');
    assert.deepEqual(failure.selectors, {
      '.arc_cont': { exists: false, count: 0 }, '.TRS_Editor': { exists: false, count: 0 },
      '.article-content': { exists: false, count: 0 }, '.article_content': { exists: false, count: 0 }, article: { exists: false, count: 0 }
    });
    assert.equal(failure.parser_error_code, 'POLICY_BODY_CONTAINER_MISSING');
    const serialized = JSON.stringify(result.body);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes(process.env.NETLIFY_TAXKB_ADMIN_TOKEN), false);
  } finally {
    if (previous === undefined) delete process.env.NETLIFY_TAXKB_ADMIN_TOKEN; else process.env.NETLIFY_TAXKB_ADMIN_TOKEN = previous;
  }
});

test('Phase 3C transient retry only recovers a strictly incomplete 200 page and audits both attempts', async () => {
  const calls = [];
  const waits = [];
  const incomplete = '<html><body>temporary shell</body></html>';
  const retryFetch = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) return new Response(incomplete, { status: 200, headers: { 'content-type': 'text/html' } });
    const ordinal = PHASE3C1_FIXED_IMPORT_URLS.indexOf(String(url)) + 1;
    return new Response(html(ordinal), { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const preview = await preparePhase3C1ImportPreview({ fetchImpl: retryFetch, now: '2026-09-07T00:00:00.000Z', waitImpl: async (milliseconds) => { waits.push(milliseconds); } });
  assert.equal(calls.length, 11); assert.equal(calls[0], PHASE3C1_FIXED_IMPORT_URLS[0]); assert.equal(calls[1], PHASE3C1_FIXED_IMPORT_URLS[0]);
  assert.deepEqual(waits, [PHASE3C1_INCOMPLETE_HTML_RETRY_DELAY_MS, ...Array(9).fill(PHASE3C1_CANDIDATE_COOLDOWN_MS)]);
  assert.equal(preview.items[0].upstream_attempts.length, 2);
  assert.deepEqual(preview.items[0].upstream_attempts.map((item) => [item.attempt_number, item.retry_eligible, item.wait_before_next_ms, item.parser_error_code, item.candidate_cooldown_before_ms]), [[1, true, PHASE3C1_INCOMPLETE_HTML_RETRY_DELAY_MS, 'POLICY_BODY_CONTAINER_MISSING', 0], [2, false, 0, null, 0]]);
  assert.equal(preview.items[0].upstream_attempts[0].title_present, false);
  assert.equal(preview.items[0].upstream_attempts[0].body_text_length, 'temporary shell'.length);
  assert.match(preview.items[0].body_hash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(preview).includes(incomplete), false);
});

test('Phase 3C fallback keeps original rank 10 when its transient incomplete page recovers', async () => {
  const calls = []; const waits = []; const attempts = new Map();
  const incomplete = '<html><body>temporary shell</body></html>';
  const preview = await preparePhase3C1ImportPreview({
    fetchImpl: async (url) => {
      const rank = poolRankFor(url); calls.push(rank); attempts.set(rank, (attempts.get(rank) || 0) + 1);
      if (rank === 10 && attempts.get(rank) === 1) return new Response(incomplete, { status: 200, headers: { 'content-type': 'text/html' } });
      return new Response(html(rank), { status: 200, headers: { 'content-type': 'text/html' } });
    },
    waitImpl: async (milliseconds) => { waits.push(milliseconds); }, now: '2026-09-07T00:00:00.000Z'
  });
  assert.deepEqual(preview.items.map((item) => item.original_rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(preview.skip_audit, []);
  assert.equal(calls.includes(11), false);
  assert.equal(calls.filter((rank) => rank === 10).length, 2);
  assert.deepEqual(waits, [...Array(9).fill(PHASE3C1_CANDIDATE_COOLDOWN_MS), PHASE3C1_INCOMPLETE_HTML_RETRY_DELAY_MS]);
});

test('Phase 3C fallback skips exhausted rank 10 and naturally selects original rank 11', async () => {
  const calls = []; const waits = []; const incomplete = '<html><body>temporary shell</body></html>';
  const preview = await preparePhase3C1ImportPreview({
    fetchImpl: async (url) => {
      const rank = poolRankFor(url); calls.push(rank);
      return rank === 10
        ? new Response(incomplete, { status: 200, headers: { 'content-type': 'text/html' } })
        : new Response(html(rank), { status: 200, headers: { 'content-type': 'text/html' } });
    }, waitImpl: async (milliseconds) => { waits.push(milliseconds); }, now: '2026-09-07T00:00:00.000Z'
  });
  assert.deepEqual(preview.items.map((item) => item.original_rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 11]);
  assert.equal(preview.items[9].original_index, 12);
  assert.equal(preview.items[9].official_url, PHASE3C1_ORIGINAL_ELIGIBLE_CANDIDATE_POOL[10].official_url);
  assert.equal(preview.skip_audit.length, 1);
  assert.deepEqual(preview.skip_audit[0].original_rank, 10);
  assert.equal(preview.skip_audit[0].failure_code, 'INCOMPLETE_HTML_200');
  assert.equal(preview.skip_audit[0].attempts.length, 2);
  assert.equal(JSON.stringify(preview).includes(incomplete), false);
  assert.deepEqual(calls, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 11]);
  assert.deepEqual(waits, [...Array(9).fill(PHASE3C1_CANDIDATE_COOLDOWN_MS), PHASE3C1_INCOMPLETE_HTML_RETRY_DELAY_MS, PHASE3C1_CANDIDATE_COOLDOWN_MS]);
  assert.deepEqual(validatePhase3C1FallbackSelection(preview), { valid: true, issues: [] });
  const repeated = await preparePhase3C1ImportPreview({
    fetchImpl: async (url) => {
      const rank = poolRankFor(url);
      return rank === 10
        ? new Response(incomplete, { status: 200, headers: { 'content-type': 'text/html' } })
        : new Response(html(rank), { status: 200, headers: { 'content-type': 'text/html' } });
    }, waitImpl: async () => {}, now: '2026-09-07T00:00:00.000Z'
  });
  assert.equal(repeated.manifest_hash, preview.manifest_hash, '相同上游结果必须产生相同的 fallback set、skip audit 与 manifest hash');
  assert.deepEqual(repeated.selection_criteria, preview.selection_criteria);
});

test('Phase 3C fallback preview exposes only safe skip audit metadata and stays repository-free', async () => {
  const previous = process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
  process.env.NETLIFY_TAXKB_ADMIN_TOKEN = 'phase3c1-fallback-token';
  const secret = 'FALLBACK_UPSTREAM_HTML_MUST_NOT_LEAK';
  let repositoryFactoryCalls = 0;
  try {
    const preview = await preparePhase3C1ImportPreview({
      fetchImpl: async (url) => {
        const rank = poolRankFor(url);
        return rank === 10
          ? new Response(`<html><body>${secret}</body></html>`, { status: 200, headers: { 'content-type': 'text/html' } })
          : new Response(html(rank), { status: 200, headers: { 'content-type': 'text/html' } });
      }, waitImpl: noWait
    });
    const handler = createApiHandler({ evidenceAdminHandler: createEvidenceAdminHandler({
      repositoryFactory: () => { repositoryFactoryCalls += 1; throw new Error('Preview must not open repository'); },
      phase3c1PreviewFactory: async () => preview
    }) });
    const result = await request(handler, '/api/admin/evidence/phase3c1/import-preview', { token: process.env.NETLIFY_TAXKB_ADMIN_TOKEN });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.preview.items[9].original_rank, 11);
    assert.equal(result.body.preview.skip_audit[0].original_rank, 10);
    const serialized = JSON.stringify(result.body);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes(process.env.NETLIFY_TAXKB_ADMIN_TOKEN), false);
    assert.equal(repositoryFactoryCalls, 0);
  } finally {
    if (previous === undefined) delete process.env.NETLIFY_TAXKB_ADMIN_TOKEN; else process.env.NETLIFY_TAXKB_ADMIN_TOKEN = previous;
  }
});

test('Phase 3C upstream incomplete circuit breaker blocks after two distinct exhausted candidates and does not consume later ranks', async () => {
  const incomplete = '<html><body>temporary shell</body></html>';
  const multipleCalls = [];
  await assert.rejects(() => preparePhase3C1ImportPreview({
    fetchImpl: async (url) => {
      const rank = poolRankFor(url); multipleCalls.push(rank);
      return [10, 11].includes(rank)
        ? new Response(incomplete, { status: 200, headers: { 'content-type': 'text/html' } })
        : new Response(html(rank), { status: 200, headers: { 'content-type': 'text/html' } });
    }, waitImpl: noWait, now: '2026-09-07T00:00:00.000Z'
  }), (error) => error instanceof Phase3C1PreviewFailure
    && error.safe_diagnostic.failure_code === 'UPSTREAM_INCOMPLETE_RESPONSE_STREAK'
    && error.safe_diagnostic.successfully_processed_count === 9
    && error.safe_diagnostic.selection_skip_audit.length === 2);
  assert.deepEqual(multipleCalls, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 11, 11]);

  await assert.rejects(
    () => preparePhase3C1ImportPreview({
      fetchImpl: async () => new Response('retryable upstream status', { status: 429, headers: { 'retry-after': '1' } }),
      waitImpl: noWait
    }),
    (error) => error instanceof Phase3C1PreviewFailure
      && error.safe_diagnostic.failure_stage === 'selection'
      && error.safe_diagnostic.failure_code === 'CANDIDATE_POOL_EXHAUSTED'
      && error.safe_diagnostic.selection_skip_audit.length === PHASE3C1_ORIGINAL_ELIGIBLE_CANDIDATE_POOL.length
  );
});

test('Phase 3C fallback never treats a business eligibility failure as an upstream skip', async () => {
  const calls = [];
  const missingDocumentNo = html(10).replace(/<h5 class="actfwzh">[\s\S]*?<\/h5>/, '');
  await assert.rejects(
    () => preparePhase3C1ImportPreview({
      fetchImpl: async (url) => {
        const rank = poolRankFor(url); calls.push(rank);
        return new Response(rank === 10 ? missingDocumentNo : html(rank), { status: 200, headers: { 'content-type': 'text/html' } });
      }, waitImpl: async () => {}
    }),
    (error) => error instanceof Phase3C1PreviewFailure
      && error.safe_diagnostic.failure_stage === 'risk'
      && error.safe_diagnostic.selection_skip_audit.length === 0
  );
  assert.deepEqual(calls, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('Phase 3C retry classifier caps transient HTTP and network failures, but never retries non-transient or complete-page parse failures', async () => {
  const retryable = [429, 502, 503, 504];
  for (const status of retryable) {
    const calls = []; const waits = [];
    const result = await fetchParsePhase3C1OfficialDetailWithRetry(PHASE3C1_FIXED_IMPORT_URLS[0], {
      fetchImpl: async () => { calls.push('request'); return calls.length === 1 ? new Response('temporary', { status, headers: { 'retry-after': status === 429 ? '1' : '' } }) : new Response(html(1), { status: 200, headers: { 'content-type': 'text/html' } }); },
      waitImpl: async (milliseconds) => { waits.push(milliseconds); }
    });
    assert.equal(result.upstream_attempts.length, 2); assert.deepEqual(waits, [5000]); assert.equal(calls.length, 2);
  }
  for (const code of ['ETIMEDOUT', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT']) {
    const calls = []; const waits = [];
    const result = await fetchParsePhase3C1OfficialDetailWithRetry(PHASE3C1_FIXED_IMPORT_URLS[0], {
      fetchImpl: async () => { calls.push('request'); if (calls.length === 1) throw Object.assign(new Error('transient'), { code }); return new Response(html(1), { status: 200, headers: { 'content-type': 'text/html' } }); },
      waitImpl: async (milliseconds) => { waits.push(milliseconds); }
    });
    assert.equal(result.upstream_attempts.length, 2); assert.deepEqual(waits, [5000]);
  }
  const noRetryCases = [
    new Response('not found', { status: 404 }),
    new Response(`<html><head><title>complete but unsupported</title></head><body>${'x'.repeat(2500)}</body></html>`, { status: 200, headers: { 'content-type': 'text/html' } }),
    new Response('<html><head><title>short title</title></head><body>x</body></html>', { status: 200, headers: { 'content-type': 'text/html' } })
  ];
  for (const response of noRetryCases) {
    let calls = 0;
    await assert.rejects(() => fetchParsePhase3C1OfficialDetailWithRetry(PHASE3C1_FIXED_IMPORT_URLS[0], { fetchImpl: async () => { calls += 1; return response.clone(); }, waitImpl: async () => { throw new Error('must not wait'); } }));
    assert.equal(calls, 1);
  }
});

test('Phase 3C retry does not weaken frozen body-hash comparison', async () => {
  const frozen = await preparePhase3C1ImportPreview({ fetchImpl: fakeFetch, now: '2026-09-07T00:00:00.000Z', waitImpl: noWait });
  const calls = [];
  const changed = await preparePhase3C1ImportPreview({
    fetchImpl: async (url) => {
      const ordinal = PHASE3C1_FIXED_IMPORT_URLS.indexOf(String(url)) + 1;
      calls.push(ordinal);
      if (ordinal === 1 && calls.filter((value) => value === 1).length === 1) return new Response('<html><body>temporary shell</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
      return new Response(ordinal === 1 ? html(1).replace('纳税人应当按照规定办理申报', '纳税人应当另行办理申报') : html(ordinal), { status: 200, headers: { 'content-type': 'text/html' } });
    },
    waitImpl: async () => {}
  });
  assert.equal(changed.items[0].upstream_attempts.length, 2);
  assert.notEqual(changed.items[0].body_hash, frozen.items[0].body_hash);
  assert.ok(comparePhase3C1FrozenManifest(frozen.items, changed.items).some((item) => item.code === 'BODY_HASH_CHANGED'));
});

test('Phase 3C Preview stays read-only and never retries a downstream risk/eligibility failure', async () => {
  const previous = process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
  process.env.NETLIFY_TAXKB_ADMIN_TOKEN = 'phase3c1-read-only-retry-token';
  let repositoryFactoryCalls = 0;
  const calls = [];
  const missingDocumentNo = html(1).replace(/<h5 class="actfwzh">[\s\S]*?<\/h5>/, '');
  try {
    const handler = createApiHandler({ evidenceAdminHandler: createEvidenceAdminHandler({
      repositoryFactory: () => { repositoryFactoryCalls += 1; throw new Error('Preview must not open a repository'); },
      fetchImpl: async (url) => { calls.push(String(url)); return new Response(missingDocumentNo, { status: 200, headers: { 'content-type': 'text/html' } }); }
    }) });
    const result = await request(handler, '/api/admin/evidence/phase3c1/import-preview', { token: process.env.NETLIFY_TAXKB_ADMIN_TOKEN });
    assert.equal(result.response.status, 422);
    assert.equal(result.body.failure.failure_stage, 'risk');
    assert.equal(result.body.failure.upstream_attempts.length, 1);
    assert.equal(repositoryFactoryCalls, 0);
    assert.deepEqual(calls, [PHASE3C1_FIXED_IMPORT_URLS[0]]);
  } finally {
    if (previous === undefined) delete process.env.NETLIFY_TAXKB_ADMIN_TOKEN; else process.env.NETLIFY_TAXKB_ADMIN_TOKEN = previous;
  }
});

test('Phase 3C Preview 在总预算内完成，并且不会改变既有 deterministic fallback 选择', async () => {
  let monotonicNow = 0;
  const candidateCooldowns = [];
  assert.equal(PHASE3C1_CANDIDATE_COOLDOWN_MS, 30_000, 'candidate cooldown must remain the audited 30 seconds');
  const preview = await preparePhase3C1ImportPreview({
    fetchImpl: async (url) => { monotonicNow += 20_000; return fakeFetch(url); },
    now: '2026-09-07T00:00:00.000Z',
    clock: () => monotonicNow,
    time_budget_ms: PHASE3C1_ASYNC_PREVIEW_TIME_BUDGET_MS,
    waitImpl: async (milliseconds) => { candidateCooldowns.push(milliseconds); monotonicNow += milliseconds; }
  });
  assert.equal(preview.items.length, 10);
  assert.deepEqual(preview.items.map((item) => item.original_rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(preview.skip_audit.length, 0);
  assert.deepEqual(candidateCooldowns, Array(9).fill(PHASE3C1_CANDIDATE_COOLDOWN_MS));
  assert.deepEqual(preview.items.map((item) => item.upstream_attempts[0].candidate_cooldown_before_ms), [0, ...Array(9).fill(PHASE3C1_CANDIDATE_COOLDOWN_MS)]);
  assert.equal(monotonicNow, 470_000, 'ten 20-second fetches plus nine 30-second cooldowns remain within the 12-minute async budget');
});

test('Phase 3C Preview 在下一条 fetch 前总预算不足时 fail-closed，且不请求后续 URL', async () => {
  let monotonicNow = 0;
  const calls = [];
  await assert.rejects(
    () => preparePhase3C1ImportPreview({
      fetchImpl: async (url) => {
        const rank = poolRankFor(url); calls.push(rank);
        monotonicNow = 39_000;
        return new Response(html(rank), { status: 200, headers: { 'content-type': 'text/html' } });
      },
      clock: () => monotonicNow,
      time_budget_ms: 45_000,
      waitImpl: noWait
    }),
    (error) => error instanceof Phase3C1PreviewFailure
      && error.safe_diagnostic.failure_stage === 'time-budget'
      && error.safe_diagnostic.failure_code === 'PREVIEW_TIME_BUDGET_EXCEEDED'
      && error.safe_diagnostic.failed_ordinal === 2
      && error.safe_diagnostic.successfully_processed_count === 1
      && error.safe_diagnostic.elapsed_ms === 39_000
      && error.safe_diagnostic.time_budget_ms === 45_000
  );
  assert.deepEqual(calls, [1]);
});

test('Phase 3C Preview 在 retry 前或 retry wait 会耗尽总预算时停止，不发送第二次或后续 URL', async () => {
  let monotonicNow = 0;
  const calls = [];
  const waits = [];
  const incomplete = '<html><body>temporary shell</body></html>';
  await assert.rejects(
    () => preparePhase3C1ImportPreview({
      fetchImpl: async (url) => {
        calls.push(poolRankFor(url));
        monotonicNow = 39_000;
        return new Response(incomplete, { status: 200, headers: { 'content-type': 'text/html' } });
      },
      waitImpl: async (milliseconds) => { waits.push(milliseconds); monotonicNow += milliseconds; },
      clock: () => monotonicNow,
      time_budget_ms: 45_000
    }),
    (error) => error instanceof Phase3C1PreviewFailure
      && error.safe_diagnostic.failure_stage === 'time-budget'
      && error.safe_diagnostic.failure_code === 'PREVIEW_TIME_BUDGET_EXCEEDED'
      && error.safe_diagnostic.upstream_attempts.length === 1
      && error.safe_diagnostic.upstream_attempts[0].retry_eligible === false
      && error.safe_diagnostic.upstream_attempts[0].wait_before_next_ms === 0
  );
  assert.deepEqual(calls, [1]);
  assert.deepEqual(waits, []);

  monotonicNow = 0;
  const recoveredCalls = [];
  const recoveredWaits = [];
  const recovered = await preparePhase3C1ImportPreview({
    fetchImpl: async (url) => {
      const rank = poolRankFor(url);
      recoveredCalls.push(rank);
      if (rank === 1 && recoveredCalls.length === 1) {
        monotonicNow = 33_000;
        return new Response(incomplete, { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return new Response(html(rank), { status: 200, headers: { 'content-type': 'text/html' } });
    },
    waitImpl: async (milliseconds) => { recoveredWaits.push(milliseconds); monotonicNow += milliseconds; },
    clock: () => monotonicNow,
    time_budget_ms: 400_000
  });
  assert.equal(recovered.items.length, 10);
  assert.deepEqual(recoveredCalls.slice(0, 2), [1, 1]);
  assert.deepEqual(recoveredWaits, [PHASE3C1_INCOMPLETE_HTML_RETRY_DELAY_MS, ...Array(9).fill(PHASE3C1_CANDIDATE_COOLDOWN_MS)]);
  assert.equal(monotonicNow, 333_000, 'retry and candidate cooldowns must leave the response reserve and must not exceed the total budget');
});

test('Phase 3C Preview 时间预算保留 retry wait 与安全返回窗口，且 422 只返回安全字段并保持只读', async () => {
  const previous = process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
  process.env.NETLIFY_TAXKB_ADMIN_TOKEN = 'phase3c1-time-budget-token';
  const secret = 'TIME_BUDGET_SECRET_MUST_NOT_LEAK';
  let repositoryFactoryCalls = 0;
  try {
    const handler = createApiHandler({ evidenceAdminHandler: createEvidenceAdminHandler({
      repositoryFactory: () => { repositoryFactoryCalls += 1; throw new Error('time-budget preview must not open repository'); },
      phase3c1PreviewFactory: async () => {
        throw new Phase3C1PreviewFailure({
          ordinal: 4,
          stage: 'time-budget',
          processed_count: 3,
          requested_url: PHASE3C1_FIXED_IMPORT_URLS[3],
          raw_html: `<html><body>${secret}</body></html>`,
          code: 'PREVIEW_TIME_BUDGET_EXCEEDED',
          elapsed_ms: 45_000,
          time_budget_ms: 45_000
        });
      }
    }) });
    const result = await request(handler, '/api/admin/evidence/phase3c1/import-preview', { token: process.env.NETLIFY_TAXKB_ADMIN_TOKEN });
    assert.equal(result.response.status, 422);
    assert.equal(result.body.mode, 'read_only_preview');
    assert.equal(result.body.preview_result, 'BLOCKED');
    assert.equal(result.body.failure.failure_code, 'PREVIEW_TIME_BUDGET_EXCEEDED');
    assert.equal(result.body.failure.failed_ordinal, 4);
    assert.equal(result.body.failure.successfully_processed_count, 3);
    assert.equal(result.body.failure.elapsed_ms, 45_000);
    assert.equal(result.body.failure.time_budget_ms, 45_000);
    assert.equal(result.body.ready_to_create_frozen_manifest, 'NO');
    assert.equal(result.body.production_writes, 0);
    assert.equal(repositoryFactoryCalls, 0);
    assert.equal(JSON.stringify(result.body).includes(secret), false);
    assert.equal(JSON.stringify(result.body).includes(process.env.NETLIFY_TAXKB_ADMIN_TOKEN), false);
  } finally {
    if (previous === undefined) delete process.env.NETLIFY_TAXKB_ADMIN_TOKEN; else process.env.NETLIFY_TAXKB_ADMIN_TOKEN = previous;
  }
});

test('Phase 3C preflight blocks any selection rule, pool hash, provenance, or body change', async () => {
  const value = await fixture();
  try {
    const preview = await preparePhase3C1ImportPreview({ fetchImpl: fakeFetch, now: '2026-09-07T00:00:00.000Z', waitImpl: noWait });
    const frozen = await value.repository.createPhase3C1FrozenImportManifest({ preview, created_by: 'test-admin' });
    for (const [mutate, expected] of [
      [(current) => { current.selection_criteria.selection_version = 'unexpected-rule'; }, 'SELECTION_RULE_VERSION_CHANGED'],
      [(current) => { current.selection_criteria.candidate_pool_hash = 'b'.repeat(64); }, 'CANDIDATE_POOL_HASH_CHANGED'],
      [(current) => { current.selection_criteria.selected[9].original_rank = 11; }, 'SELECTION_PROVENANCE_CHANGED'],
      [(current) => { current.items[0].body_hash = 'a'.repeat(64); }, 'BODY_HASH_CHANGED']
    ]) {
      const current = clone(preview); mutate(current);
      const result = await value.repository.preflightControlledImportManifest(frozen.manifest.controlled_manifest_id, { current_preview: current });
      assert.equal(result.validation.state, 'blocked');
      assert.ok(result.validation.changes.some((change) => change.code === expected));
    }
    const injected = clone(preview);
    injected.items[9].official_url = 'https://attacker.invalid/content.html';
    injected.items[9].original_rank = 11;
    assert.deepEqual(validatePhase3C1FallbackSelection(injected).valid, false, '候选 URL 或 original rank 不能由调用方替换');
  } finally { await close(value); }
});

test('Phase 3C-1 预检只读识别 URL、可信文号、正文 hash、Candidate、Review、Policy 和公开投影', async () => {
  const value = await fixture();
  try {
    const preview = await preparePhase3C1ImportPreview({ fetchImpl: fakeFetch, now: '2026-09-07T00:00:00.000Z', waitImpl: noWait });
    const frozen = await value.repository.createPhase3C1FrozenImportManifest({ preview });
    const first = preview.items[0];
    const snapshot = await value.repository.recordRawSnapshot({ source_id: value.source.source_id, collection_run_id: value.run.collection_run_id, official_url: first.official_url, canonical_url: first.official_url, http_status: 200, content_type: 'text/html', raw_content: '<article>stored</article>', normalized_text: 'not the preview body', parser_version: first.parser_version, parse_result: { title: first.title } });
    const created = await value.repository.createCandidate({ snapshot_id: snapshot.snapshot_id, parsed_fields: { title: first.title, document_no: first.document_no, document_no_source: 'structured_field', document_no_confidence: 'high', issuing_authority: first.issuing_authority, publish_date: first.publish_date }, verification_state: 'pending_review', legal_status: 'pending' });
    const fields = { title: first.title, document_no: first.document_no, issuing_authority: first.issuing_authority, publish_date: first.publish_date, effective_date: null, expiry_date: null, tax_categories: ['个人所得税'], keywords: ['个人所得税'], summary: '测试摘要。' };
    await value.repository.reviewCandidate(created.candidate.candidate_id, { action: 'approve', legal_status: 'pending', reviewer_id: 'test-reviewer', confirmed_fields: fields });
    const sameBody = parseChinaTaxPolicyEvidence(html(1)).normalized_text;
    const bodySnapshot = await value.repository.recordRawSnapshot({ source_id: value.source.source_id, collection_run_id: value.run.collection_run_id, official_url: 'https://fgk.chinatax.gov.cn/zcfgk/test/same-body/content.html', canonical_url: 'https://fgk.chinatax.gov.cn/zcfgk/test/same-body/content.html', http_status: 200, content_type: 'text/html', raw_content: '<article>same body</article>', normalized_text: sameBody, parser_version: first.parser_version, parse_result: { title: '相似标题但不同证据' } });
    await value.repository.createCandidate({ snapshot_id: bodySnapshot.snapshot_id, parsed_fields: { title: '相似标题但不同证据', document_no: '国税发〔2021〕99号', document_no_source: 'structured_field', document_no_confidence: 'high', issuing_authority: first.issuing_authority, publish_date: first.publish_date }, verification_state: 'pending_review', legal_status: 'pending' });
    const sameDocumentSnapshot = await value.repository.recordRawSnapshot({ source_id: value.source.source_id, collection_run_id: value.run.collection_run_id, official_url: 'https://fgk.chinatax.gov.cn/zcfgk/test/same-document/content.html', canonical_url: 'https://fgk.chinatax.gov.cn/zcfgk/test/same-document/content.html', http_status: 200, content_type: 'text/html', raw_content: '<article>same document</article>', normalized_text: '不同正文但同一可信文号。'.repeat(40), parser_version: first.parser_version, parse_result: { title: '同文号文件' } });
    await value.repository.createCandidate({ snapshot_id: sameDocumentSnapshot.snapshot_id, parsed_fields: { title: '同文号文件', document_no: first.document_no, document_no_source: 'structured_field', document_no_confidence: 'high', issuing_authority: first.issuing_authority, publish_date: first.publish_date }, verification_state: 'pending_review', legal_status: 'pending' });
    const similarSnapshot = await value.repository.recordRawSnapshot({ source_id: value.source.source_id, collection_run_id: value.run.collection_run_id, official_url: 'https://fgk.chinatax.gov.cn/zcfgk/test/similar-title/content.html', canonical_url: 'https://fgk.chinatax.gov.cn/zcfgk/test/similar-title/content.html', http_status: 200, content_type: 'text/html', raw_content: '<article>different</article>', normalized_text: '完全不同的正文内容。'.repeat(40), parser_version: first.parser_version, parse_result: { title: `${first.title}（其他文件）` } });
    const similarCandidate = await value.repository.createCandidate({ snapshot_id: similarSnapshot.snapshot_id, parsed_fields: { title: `${first.title}（其他文件）`, document_no: '国税发〔2021〕100号', document_no_source: 'structured_field', document_no_confidence: 'high', issuing_authority: first.issuing_authority, publish_date: first.publish_date }, verification_state: 'pending_review', legal_status: 'pending' });
    const before = await value.repository.counts();
    const evidence = await value.repository.preflightControlledImportManifest(frozen.manifest.controlled_manifest_id, { current_preview: preview });
    assert.equal(evidence.validation.state, 'blocked');
    assert.equal(evidence.evidence_duplicate_free, false);
    assert.equal(evidence.evidence_duplicates[0].raw_snapshots[0].match_basis, 'official_url');
    assert.equal(evidence.evidence_duplicates[0].candidates[0].match_basis, 'official_url');
    assert.equal(evidence.evidence_duplicates[0].reviewed_candidates.length, 1);
    assert.deepEqual(evidence.evidence_duplicates[0].policies[0].match_basis, ['official_url']);
    assert.equal(evidence.evidence_duplicates[0].policy_versions[0].match_basis, 'official_url');
    assert.ok(evidence.evidence_duplicates[0].candidates.some((item) => item.match_basis === 'body_hash'));
    assert.ok(evidence.evidence_duplicates[0].candidates.some((item) => item.match_basis === 'document_no'));
    assert.equal(evidence.evidence_duplicates.flatMap((item) => item.candidates).some((item) => item.candidate_id === similarCandidate.candidate.candidate_id), false, '标题相似但 URL、文号、正文证据不同不得误判');
    assert.deepEqual(await value.repository.counts(), before, 'GET preflight must not write Evidence data');
    assert.equal((await value.repository.getCandidateForReview(created.candidate.candidate_id)).candidate.legal_status, 'pending');

    for (const [mutate, expectedCode] of [
      [(item) => { item.official_url = 'https://fgk.chinatax.gov.cn/zcfgk/other/content.html'; }, 'OFFICIAL_URL_CHANGED'],
      [(item) => { item.document_no = '国税发〔2020〕999号'; }, 'DOCUMENT_NO_CHANGED'],
      [(item) => { item.document_no_provenance.evidence.text = 'changed'; }, 'DOCUMENT_NO_PROVENANCE_CHANGED'],
      [(item) => { item.title = 'changed'; }, 'TITLE_CHANGED'],
      [(item) => { item.body_hash = 'a'.repeat(64); }, 'BODY_HASH_CHANGED'],
      [(item) => { item.parser_version = 'changed-parser'; }, 'PARSER_VERSION_CHANGED'],
      [(item) => { item.risk_assessment.rule_version = 'changed-risk-rule'; }, 'RISK_RULE_VERSION_CHANGED'],
      [(item) => { item.metadata_suggestion.rule_version = 'changed-metadata-rule'; }, 'METADATA_RULE_VERSION_CHANGED'],
      [(item) => { item.relation_proposals.proposed_count = 1; item.relation_proposals.state = 'proposed'; }, 'RELATION_PROPOSAL_STATE_CHANGED']
    ]) {
      const changed = clone(preview); mutate(changed.items[0]);
      const blocked = await value.repository.preflightControlledImportManifest(frozen.manifest.controlled_manifest_id, { current_preview: changed });
      assert.equal(blocked.validation.state, 'blocked');
      assert.ok(blocked.validation.changes.some((item) => item.code === expectedCode));
    }

    const handler = createApiHandler({ evidenceAdminHandler: createEvidenceAdminHandler({
      repositoryFactory: () => value.repository,
      fetchImpl: fakeFetch,
      phase3c1PreviewFactory: async () => preview,
      listPublicPolicies: async () => ({ results: [{ id: 'public-match' }] }),
      readPublicPolicy: async () => ({ id: 'public-match', source_url: first.official_url, document_no: first.document_no, evidence: { normalized_text: '' } })
    }) });
    const previous = process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
    process.env.NETLIFY_TAXKB_ADMIN_TOKEN = 'phase3c1-preflight-token';
    try {
      const response = await request(handler, `/api/admin/evidence/phase3c1/import-manifests/${frozen.manifest.controlled_manifest_id}/preflight`, { token: process.env.NETLIFY_TAXKB_ADMIN_TOKEN });
      assert.equal(response.response.status, 200);
      assert.equal(response.body.public_projection_duplicate_free, false);
      assert.equal(response.body.validation.state, 'blocked');
      assert.deepEqual(response.body.public_projections[0].projections[0].match_basis, ['official_url', 'document_no']);
      assert.equal('raw_html' in response.body, false);
      assert.equal('legal_status' in response.body, false);
    } finally { if (previous === undefined) delete process.env.NETLIFY_TAXKB_ADMIN_TOKEN; else process.env.NETLIFY_TAXKB_ADMIN_TOKEN = previous; }
  } finally { await close(value); }
});
