import test from 'node:test';
import assert from 'node:assert/strict';
import { ensurePolicySchema, policyFromLegacyDocument, validatePolicies } from '../src/policy-schema.js';

test('旧法规迁移为标准政策字段，未知信息不编造', () => {
  const policy = policyFromLegacyDocument({
    id: 'doc-example', title: '示例政策', documentNumber: '', authority: '国家税务总局', publishedAt: '2026-08-29T08:00:00.000Z',
    effectiveAt: null, status: 'pending_verification', taxTypes: ['个人所得税'], summary: '', officialUrl: '', relations: [{ documentId: 'doc-related' }], createdAt: '2026-08-29T08:00:00.000Z'
  }, new Map());
  assert.deepEqual(policy, {
    id: 'doc-example', title: '示例政策', document_no: null, issuing_authority: ['国家税务总局'], publish_date: '2026-08-29', effective_date: null,
    expiry_date: null, status: 'pending', tax_categories: ['个人所得税'], topics: [], region: [], applicable_entities: [], keywords: ['示例政策', '个人所得税'],
    summary: null, key_points: [], practical_guidance: null, source_url: null, source_name: null, related_policies: ['doc-related'], last_verified_date: null,
    created_at: '2026-08-29', updated_at: null, legacy_document_id: 'doc-example', legacy_status: 'pending_verification'
  });
});

test('迁移保留旧 documents，并只补充缺失的标准政策', () => {
  const data = { sources: [{ id: 'source-1', name: '官方来源' }], documents: [{ id: 'doc-1', sourceId: 'source-1', title: '政策一', documentNumber: '公告1号', authority: '国家税务总局', publishedAt: '2026-01-01', effectiveAt: '2026-02-01', status: 'current', taxTypes: ['增值税'], summary: '摘要', officialUrl: 'https://www.chinatax.gov.cn/', relations: [], createdAt: '2026-01-01' }] };
  const first = ensurePolicySchema(data, { today: '2026-08-29' });
  assert.equal(first.additions, 1);
  assert.equal(data.documents.length, 1);
  assert.equal(data.policies.length, 1);
  assert.equal(data.policies[0].source_name, '官方来源');
  assert.equal(data.policies[0].status, 'effective');
  const second = ensurePolicySchema(data, { today: '2026-08-29' });
  assert.equal(second.additions, 0);
  assert.equal(data.policies.length, 1);
});

test('政策导入校验拒绝空标题、重复 id、非法日期和非法状态', () => {
  const policy = {
    id: 'policy-1', title: '', document_no: null, issuing_authority: [], publish_date: '2026-99-99', effective_date: null, expiry_date: null,
    status: 'unknown', tax_categories: [], topics: [], region: [], applicable_entities: [], keywords: [], summary: null, key_points: [], practical_guidance: null,
    source_url: null, source_name: null, related_policies: [], last_verified_date: null, created_at: null, updated_at: null
  };
  const result = validatePolicies([policy, { ...policy, title: '重复政策' }]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('title 不能为空')));
  assert.ok(result.errors.some((error) => error.includes('重复 id')));
  assert.ok(result.errors.some((error) => error.includes('publish_date')));
  assert.ok(result.errors.some((error) => error.includes('status')));
});
