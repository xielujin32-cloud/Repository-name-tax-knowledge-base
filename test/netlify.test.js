import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobsServer } from '@netlify/blobs/server';
import { importPolicies, listPolicies, readPolicy, suppressPublicPoliciesForRelation } from '../netlify/lib/policy-store.mjs';
import { policySeedPolicies } from '../src/policy-seed.js';

const directory = await mkdtemp(join(tmpdir(), 'taxkb-netlify-blobs-'));
const blobsToken = `blobs-test-${randomUUID()}`;
const adminToken = `admin-test-${randomUUID()}`;
const blobs = new BlobsServer({ directory, port: 0, token: blobsToken, logger: () => {} });
await blobs.start();
process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({ edgeURL: blobs.address, token: blobsToken, siteID: 'taxkb-test' })).toString('base64');
process.env.NETLIFY_TAXKB_ADMIN_TOKEN = adminToken;
const { default: handler } = await import('../netlify/functions/api.mjs');
const policySeed = policySeedPolicies();
const verifiedPolicy = {
  ...policySeed[0],
  id: 'policy-verified-mvp', title: '国家税务总局公告〔2026〕1号（MVP 测试）', document_no: '国家税务总局公告〔2026〕1号',
  issuing_authority: ['国家税务总局'], publish_date: '2026-01-08', effective_date: '2026-02-01', status: 'effective', tax_categories: ['增值税'],
  source_url: 'https://fgk.chinatax.gov.cn/zcfgk/c100027/mvp/content.html', source_name: '国家税务总局政策法规库',
  verification_state: 'verified', source_trust_level: 'official_primary', policy_version_id: 'policy-version-verified-mvp',
  evidence: { candidate_id: 'candidate-verified-mvp', review_decision_id: 'review-verified-mvp', policy_version_id: 'policy-version-verified-mvp', source_id: 'source-sta-policy-regulations', official_url: 'https://fgk.chinatax.gov.cn/zcfgk/c100027/mvp/content.html', body_hash: 'a'.repeat(64) },
  review: { reviewer_level: 3, decision: 'approve', legal_status: 'effective', decided_at: '2026-01-09T00:00:00.000Z', review_decision_id: 'review-verified-mvp' }, version_relations: []
};

async function call(path, { method = 'GET', token = '', body } = {}) {
  const response = await handler(new Request(`https://taxkb.example${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }));
  return { response, body: await response.json() };
}

test.after(async () => {
  await blobs.stop();
  await rm(directory, { recursive: true, force: true });
});

test('Netlify Function 从 Blobs 初始化公开知识卡片，并保护管理员接口', async () => {
  const publicCards = await call(`/api/knowledge/cards?query=${encodeURIComponent('年终奖')}`);
  assert.equal(publicCards.response.status, 200);
  assert.ok(publicCards.body.results.some((item) => item.card.topic === '全年一次性奖金单独计税'));

  const unauthenticated = await call('/api/admin/knowledge-cards');
  assert.equal(unauthenticated.response.status, 401);
});

test('Netlify Function 可审核发布知识卡片并持久化到 Blobs', async () => {
  const token = process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
  const input = {
    taxType: 'Netlify 测试税种', topic: 'Blobs 审核卡片', keywords: ['Blobs审核'], formula: '应纳税额 = 计税依据 × 税率。',
    rateTable: [{ bracket: '测试级距', rate: '1%', quickDeduction: '0' }], conditions: ['仅用于 Netlify Function 测试。'], example: '计税依据 100 元，应纳税额 1 元。', effectiveAt: '2026-01-01',
    officialBases: [{ title: '测试官方依据', authority: '国家税务总局', url: 'https://www.chinatax.gov.cn/' }]
  };
  const created = await call('/api/admin/knowledge-card-candidates', { method: 'POST', token, body: input });
  assert.equal(created.response.status, 201);
  const before = await call(`/api/knowledge/cards?query=${encodeURIComponent('Blobs审核')}`);
  assert.equal(before.body.results.length, 0);
  const published = await call(`/api/admin/knowledge-card-candidates/${created.body.candidate.id}/review`, { method: 'POST', token, body: { action: 'publish' } });
  assert.equal(published.response.status, 200);
  const after = await call(`/api/knowledge/cards?query=${encodeURIComponent('Blobs审核')}`);
  assert.equal(after.body.results.length, 1);
});

test('Policy Store 支持 dry-run 和重复 id 拒绝', async () => {
  const dryRun = await importPolicies(policySeed, { dryRun: true });
  assert.deepEqual(dryRun, { dryRun: true, total: 3, added: 3, updated: 0, skipped: 0, errors: [] });
  assert.equal((await listPolicies()).total, 0);

  const duplicate = await importPolicies([...policySeed, policySeed[0]], { dryRun: true });
  assert.ok(duplicate.errors.some((error) => error.includes('重复 id')));
  assert.equal((await listPolicies()).total, 0);
});

test('Policy 种子导入接口拒绝无 Token 和错误 Token，且不写入', async () => {
  const noToken = await call('/api/admin/policies/import-seed', { method: 'POST' });
  assert.equal(noToken.response.status, 401);
  const wrongToken = await call('/api/admin/policies/import-seed', { method: 'POST', token: `wrong-${randomUUID()}` });
  assert.equal(wrongToken.response.status, 401);
  const configuredToken = process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
  delete process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
  try {
    const missingConfiguredToken = await call('/api/admin/policies/import-seed', { method: 'POST', token: configuredToken });
    assert.equal(missingConfiguredToken.response.status, 401);
  } finally {
    process.env.NETLIFY_TAXKB_ADMIN_TOKEN = configuredToken;
  }
  const querySource = await call('/api/admin/policies/import-seed?source=data/knowledge-base.json', { method: 'POST', token: configuredToken });
  assert.equal(querySource.response.status, 400);
  const bodySource = await call('/api/admin/policies/import-seed', { method: 'POST', token: configuredToken, body: { source: 'data/knowledge-base.json' } });
  assert.equal(bodySource.response.status, 400);
  assert.equal((await listPolicies()).total, 0);
});

test('Policy 种子导入接口默认 dry-run，不写入 Blobs', async () => {
  const token = process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
  const dryRun = await call('/api/admin/policies/import-seed', { method: 'POST', token });
  assert.equal(dryRun.response.status, 200);
  assert.deepEqual(dryRun.body, { source: 'data/policy-seed.json', mode: 'dry-run', dryRun: true, total: 3, added: 3, updated: 0, skipped: 0, errors: [] });
  assert.equal((await listPolicies()).total, 0);
});

test('Policy 种子导入接口只写入三条政策，并且可幂等重复执行', async () => {
  const token = process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
  const imported = await call('/api/admin/policies/import-seed', { method: 'POST', token, body: { apply: true } });
  assert.equal(imported.response.status, 200);
  assert.deepEqual(imported.body, { source: 'data/policy-seed.json', mode: 'apply', dryRun: false, total: 3, added: 3, updated: 0, skipped: 0, errors: [] });
  assert.equal((await listPolicies()).total, 0, '旧种子未经过 Evidence/Level 3，不得出现在公开政策结果中');

  const repeated = await call('/api/admin/policies/import-seed', { method: 'POST', token, body: { apply: true } });
  assert.deepEqual(repeated.body, { source: 'data/policy-seed.json', mode: 'apply', dryRun: false, total: 3, added: 0, updated: 0, skipped: 3, errors: [] });
  assert.equal(await readPolicy('doc-vat-law-2024'), null);
});

test('Netlify Function 提供可追溯的已核验政策检索，不暴露旧种子', async () => {
  await importPolicies([verifiedPolicy], { dryRun: false });
  const listed = await call(`/api/policies?taxCategory=${encodeURIComponent('增值税')}&documentNo=${encodeURIComponent('〔2026〕1号')}&authority=${encodeURIComponent('国家税务总局')}&publishedFrom=2026-01-01&publishedTo=2026-12-31&effectiveFrom=2026-02-01`);
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.total, 1);
  assert.equal(listed.body.results[0].id, verifiedPolicy.id);
  assert.equal(listed.body.results[0].public_policy_eligible, true);
  assert.equal(listed.body.results[0].evidence.body_hash, 'a'.repeat(64));

  const detail = await call(`/api/policies/${verifiedPolicy.id}`);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.policy.document_no, verifiedPolicy.document_no);
  assert.equal(detail.body.policy.evidence.normalized_text, undefined);

  const hiddenLegacy = await call('/api/policies/doc-vat-law-2024');
  assert.equal(hiddenLegacy.response.status, 404);

  const cards = await call(`/api/knowledge/cards?query=${encodeURIComponent('年终奖')}`);
  assert.equal(cards.response.status, 200);
  assert.ok(cards.body.results.some((item) => item.card.topic === '全年一次性奖金单独计税'));

  const suppressed = await suppressPublicPoliciesForRelation({ policyVersionIds: [verifiedPolicy.policy_version_id] });
  assert.deepEqual(suppressed.policy_ids, [verifiedPolicy.id]);
  assert.equal((await call(`/api/policies?documentNo=${encodeURIComponent('〔2026〕1号')}`)).body.total, 0);
  assert.equal((await call(`/api/policies/${verifiedPolicy.id}`)).response.status, 404);
});
