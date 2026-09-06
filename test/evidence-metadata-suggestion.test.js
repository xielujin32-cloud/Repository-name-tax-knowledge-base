import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestEvidenceMetadata } from '../src/evidence-metadata-suggestion.js';

const personalIncomeBody = `为规范转让上市公司限售股个人所得税政策，现将有关事项公告如下。
一、个人转让上市公司限售股取得的所得，按照“财产转让所得”，适用20%税率缴纳个人所得税。
上市公司应当申报限售股成本原值详细资料，证券机构按照规定预扣预缴个人所得税。
纳税人可以按照规定办理清算申报，并提供限售股成本原值等相关资料。
本公告涉及的发票资料应当依法留存。`;

const vatBody = `根据增值税法有关规定，现将非应税交易等增值税有关事项公告如下。
一、纳税人发生非应税交易的，对应进项税额可以按照规定从销项税额中抵扣。
二、增值税扣税凭证中的农产品销售发票，是指农业生产者销售自产农产品开具的普通发票。
三、资产重组业务和放弃增值税优惠等事项，按照本公告规定执行。`;

function assertSummaryTrace(body, suggestion) {
  assert.ok(suggestion.summary.value.length >= 60 && suggestion.summary.value.length <= 150);
  assert.equal(suggestion.summary.value, suggestion.summary.evidence.map((item) => item.text).join(''));
  for (const item of suggestion.summary.evidence) {
    assert.equal(body.slice(item.start, item.end).replace(/\s+/g, ' ').trim(), item.text);
    assert.ok(item.matched_keywords.every((term) => item.text.includes(term)));
    assert.ok(item.newly_covered_keywords.every((term) => item.text.includes(term)));
  }
}

test('个人所得税 Candidate 识别正式税种，不会把正文中的发票作为税种', () => {
  const suggestion = suggestEvidenceMetadata({
    title: '关于规范转让上市公司限售股个人所得税政策的公告',
    normalized_text: personalIncomeBody,
    generated_at: '2026-09-05T00:00:00.000Z'
  });
  assert.deepEqual(suggestion.tax_categories.values, ['个人所得税']);
  assert.ok(suggestion.keywords.values.includes('个人所得税'));
  assert.ok(suggestion.keywords.values.includes('限售股'));
  assert.equal(suggestion.tax_categories.values.includes('发票'), false);
  assert.equal(suggestion.keywords.values.some((value) => ['公告', '规定', '有关', '事项', '通知'].includes(value)), false);
  assertSummaryTrace(personalIncomeBody, suggestion);
  assert.match(suggestion.summary.value, /限售股.*个人所得税/);
  assert.match(suggestion.summary.value, /成本原值/);
  assert.match(suggestion.summary.value, /预扣预缴/);
  assert.match(suggestion.summary.value, /清算申报/);
  assert.ok(suggestion.summary.evidence.length >= 3, '应覆盖核心税务处理与不同征管安排，而不是只取单一条款');
});

test('增值税 Candidate 识别增值税及高价值检索词，建议可追溯到正文', () => {
  const suggestion = suggestEvidenceMetadata({
    title: '关于明确非应税交易等增值税有关事项的公告',
    normalized_text: vatBody,
    generated_at: '2026-09-05T00:00:00.000Z'
  });
  assert.deepEqual(suggestion.tax_categories.values, ['增值税']);
  assert.ok(suggestion.keywords.values.includes('非应税交易'));
  assert.ok(suggestion.keywords.values.includes('进项税额'));
  assert.ok(suggestion.keywords.values.length >= 3 && suggestion.keywords.values.length <= 8);
  for (const match of suggestion.keywords.matches) {
    assert.equal(vatBody.includes(match.term) || match.source === 'title', true);
  }
  assertSummaryTrace(vatBody, suggestion);
  assert.match(suggestion.summary.value, /非应税交易.*进项税额/);
  assert.match(suggestion.summary.value, /增值税扣税凭证/);
});

test('相同正文的 metadata_suggestion 除 generated_at 外保持确定性，且不含法律状态推断', () => {
  const first = suggestEvidenceMetadata({ title: '关于明确非应税交易等增值税有关事项的公告', normalized_text: vatBody, generated_at: '2026-09-05T00:00:00.000Z' });
  const second = suggestEvidenceMetadata({ title: '关于明确非应税交易等增值税有关事项的公告', normalized_text: vatBody, generated_at: '2026-09-06T00:00:00.000Z' });
  assert.equal(first.input_body_sha256, second.input_body_sha256);
  assert.deepEqual({ ...first, generated_at: null }, { ...second, generated_at: null });
  assert.equal('legal_status' in first, false);
});
