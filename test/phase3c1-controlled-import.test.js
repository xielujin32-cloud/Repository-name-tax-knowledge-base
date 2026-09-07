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
import { PHASE3C1_FIXED_IMPORT_URLS, PHASE3C1_IMPORT_MANIFEST_CONFIRMATION, Phase3C1PreviewFailure, comparePhase3C1FrozenManifest, fetchParsePhase3C1OfficialDetailWithRetry, preparePhase3C1ImportPreview } from '../src/phase3c1-controlled-import.js';
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
    const preview = await preparePhase3C1ImportPreview({ fetchImpl: fakeFetch, now: '2026-09-07T00:00:00.000Z' });
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
    const handler = createApiHandler({ evidenceAdminHandler: createEvidenceAdminHandler({ fetchImpl: failingFetch }) });
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
  assert.deepEqual(waits, [5000]);
  assert.equal(preview.items[0].upstream_attempts.length, 2);
  assert.deepEqual(preview.items[0].upstream_attempts.map((item) => [item.attempt_number, item.retry_eligible, item.wait_before_next_ms, item.parser_error_code]), [[1, true, 5000, 'POLICY_BODY_CONTAINER_MISSING'], [2, false, 0, null]]);
  assert.match(preview.items[0].body_hash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(preview).includes(incomplete), false);
});

test('Phase 3C transient retry fails closed after two incomplete pages and never fetches a later fixed URL', async () => {
  const calls = [];
  const waits = [];
  const incomplete = '<html><body>temporary shell</body></html>';
  await assert.rejects(
    () => preparePhase3C1ImportPreview({ fetchImpl: async (url) => { calls.push(String(url)); return new Response(incomplete, { status: 200, headers: { 'content-type': 'text/html' } }); }, waitImpl: async (milliseconds) => { waits.push(milliseconds); } }),
    (error) => error instanceof Phase3C1PreviewFailure
      && error.safe_diagnostic.failed_ordinal === 1
      && error.safe_diagnostic.upstream_attempts.length === 2
      && error.safe_diagnostic.upstream_attempts.every((item) => item.parser_error_code === 'POLICY_BODY_CONTAINER_MISSING')
  );
  assert.deepEqual(calls, [PHASE3C1_FIXED_IMPORT_URLS[0], PHASE3C1_FIXED_IMPORT_URLS[0]]);
  assert.deepEqual(waits, [5000]);
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
  const frozen = await preparePhase3C1ImportPreview({ fetchImpl: fakeFetch, now: '2026-09-07T00:00:00.000Z' });
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

test('Phase 3C-1 预检只读识别 URL、可信文号、正文 hash、Candidate、Review、Policy 和公开投影', async () => {
  const value = await fixture();
  try {
    const preview = await preparePhase3C1ImportPreview({ fetchImpl: fakeFetch, now: '2026-09-07T00:00:00.000Z' });
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
