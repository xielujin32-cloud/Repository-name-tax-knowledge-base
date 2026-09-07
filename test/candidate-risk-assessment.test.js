import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NetlifyDB } from '@netlify/database-dev';
import { CANDIDATE_RISK_RULE_VERSION, evaluateCandidateRisk } from '../src/candidate-risk-assessment.js';
import { createLocalEvidenceObjectStore } from '../src/evidence-object-store.js';
import { createPostgresEvidenceRepository } from '../src/postgres-evidence-repository.js';

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
const longBody = `为规范个人转让上市公司限售股个人所得税处理，现将有关事项公告如下。\n一、个人转让上市公司限售股取得的所得，按照财产转让所得缴纳个人所得税。\n二、上市公司申请办理股份初始登记时，应当申报限售股成本原值详细资料，证券机构按照规定预扣预缴个人所得税。\n三、纳税人应当提供限售股成本原值等资料办理清算申报，多退少补税款。\n四、证券登记结算公司和证券机构应当按照本公告规定做好限售股登记、资料留存和税款预扣预缴工作，并向纳税人提供必要的申报信息。\n五、本公告自公布之日起施行，此前规定与本公告不一致的，按本公告规定执行。`.repeat(2);

function detailFixture({ body = longBody, fields = {}, candidate = {}, snapshot = {}, source = {}, run = {}, conflicts = {} } = {}) {
  const rawHtml = `<article>${body}</article>`;
  const normalizedHash = sha256(body);
  return {
    detail: {
      candidate: {
        candidate_id: 'candidate-risk-fixture', snapshot_id: 'snapshot-risk-fixture', source_id: 'source-risk-fixture', collection_run_id: 'run-risk-fixture',
        official_url: 'https://fgk.chinatax.gov.cn/zcfgk/example/content.html', canonical_url: 'https://fgk.chinatax.gov.cn/zcfgk/example/content.html',
        normalized_text_sha256: normalizedHash, parsed_normalized_text: null, verification_state: 'pending_review', legal_status: 'pending',
        parsed_fields: {
          title: '财政部 税务总局关于规范限售股个人所得税政策的公告', document_no: '财政部 税务总局公告2026年第26号',
          document_no_source: 'structured_field', document_no_confidence: 'high', document_no_evidence: { source: 'structured_field', start: 0, end: 18 },
          issuing_authority: ['财政部', '税务总局'], publish_date: '2026-08-28', effective_date: null, expiry_date: null,
          ...fields
        },
        ...candidate
      },
      raw_snapshot: {
        snapshot_id: 'snapshot-risk-fixture', source_id: 'source-risk-fixture', collection_run_id: 'run-risk-fixture', http_status: 200,
        raw_html: rawHtml, normalized_text: body, raw_sha256: sha256(rawHtml), normalized_text_sha256: normalizedHash, parser_version: 'chinatax-evidence-2.0.0',
        ...snapshot
      },
      collection_run: { collection_run_id: 'run-risk-fixture', source_id: 'source-risk-fixture', ...run },
      source: { source_id: 'source-risk-fixture', official_domain: 'fgk.chinatax.gov.cn', enabled: true, ...source }
    },
    conflicts
  };
}

test('风险规则 v1 覆盖 Low、Medium、High 与硬阻断，且不触碰 legal_status', () => {
  const clean = detailFixture();
  const low = evaluateCandidateRisk(clean.detail, { conflicts: clean.conflicts });
  assert.equal(low.risk_level, 'low');
  assert.equal(low.risk_score, 0);
  assert.equal('legal_status' in low, false);
  assert.equal(clean.detail.candidate.legal_status, 'pending');

  const mediumInput = detailFixture({ fields: { document_no: '', issuing_authority: [] } });
  const medium = evaluateCandidateRisk(mediumInput.detail, { conflicts: mediumInput.conflicts });
  assert.equal(medium.risk_level, 'medium');
  assert.equal(medium.risk_score, 27);
  assert.deepEqual(medium.risk_reasons.map((item) => item.code), ['DOCUMENT_NO_MISSING', 'ISSUING_AUTHORITY_MISSING']);

  const shortInput = detailFixture({ body: '限售股个人所得税。' });
  const high = evaluateCandidateRisk(shortInput.detail, { conflicts: shortInput.conflicts });
  assert.equal(high.risk_level, 'high');
  assert.equal(high.risk_score, 100);
  assert.ok(high.risk_reasons.some((item) => item.code === 'BODY_SEVERELY_SHORT' && item.hard_blocker));

  const missingTitleInput = detailFixture({ fields: { title: '' } });
  const missingTitle = evaluateCandidateRisk(missingTitleInput.detail, { conflicts: missingTitleInput.conflicts });
  assert.equal(missingTitle.risk_level, 'high');
  assert.ok(missingTitle.risk_reasons.some((item) => item.code === 'TITLE_MISSING' && item.hard_blocker));
});

test('风险规则保存模板污染、字段缺失、冲突和证据链异常的具体证据', () => {
  const pollutionInput = detailFixture({ body: `${longBody}\n国家税务总局政策法规库 本站热词 个人中心` });
  const pollution = evaluateCandidateRisk(pollutionInput.detail, { conflicts: pollutionInput.conflicts });
  const template = pollution.risk_reasons.find((item) => item.code === 'TEMPLATE_POLLUTION');
  assert.equal(pollution.risk_level, 'high');
  assert.ok(template.hard_blocker);
  assert.ok(template.evidence.hits.every((hit) => Number.isInteger(hit.start) && Number.isInteger(hit.end)));

  const conflictInput = detailFixture({ conflicts: {
    document_no_conflicts: [{ candidate_id: 'candidate-other', canonical_url: 'https://fgk.chinatax.gov.cn/zcfgk/other/content.html' }],
    suspected_version_changes: [{ candidate_id: 'candidate-old', normalized_text_sha256: 'a'.repeat(64) }]
  } });
  const conflict = evaluateCandidateRisk(conflictInput.detail, { conflicts: conflictInput.conflicts });
  assert.equal(conflict.risk_level, 'high');
  assert.ok(conflict.risk_reasons.some((item) => item.code === 'DOCUMENT_NO_CONFLICT' && item.hard_blocker));
  assert.ok(conflict.risk_reasons.some((item) => item.code === 'SUSPECTED_VERSION_CHANGE' && item.score === 30));

  const versionInput = detailFixture({ conflicts: { suspected_version_changes: [{ candidate_id: 'candidate-old' }] } });
  const version = evaluateCandidateRisk(versionInput.detail, { conflicts: versionInput.conflicts });
  assert.equal(version.risk_level, 'medium');
  assert.equal(version.risk_score, 30);

  const brokenInput = detailFixture({ candidate: { snapshot_id: 'wrong-snapshot' } });
  const broken = evaluateCandidateRisk(brokenInput.detail, { conflicts: brokenInput.conflicts });
  const chain = broken.risk_reasons.find((item) => item.code === 'EVIDENCE_CHAIN_INVALID');
  assert.equal(broken.risk_level, 'high');
  assert.deepEqual(chain.evidence.problems, ['candidate.snapshot_id']);
});

test('只有有可信 provenance 的文号才能触发文号冲突硬阻断', () => {
  const conflicts = { document_no_conflicts: [{ candidate_id: 'candidate-other', canonical_url: 'https://fgk.chinatax.gov.cn/zcfgk/other/content.html' }] };
  const missing = detailFixture({ fields: {
    document_no: null, document_no_source: 'missing', document_no_confidence: 'none', document_no_evidence: null
  }, conflicts });
  const noNumber = evaluateCandidateRisk(missing.detail, { conflicts });
  assert.equal(noNumber.risk_level, 'low');
  assert.ok(noNumber.risk_reasons.some((item) => item.code === 'DOCUMENT_NO_MISSING'));
  assert.ok(!noNumber.risk_reasons.some((item) => item.code === 'DOCUMENT_NO_CONFLICT'));

  const untrusted = detailFixture({ fields: {
    document_no_source: 'missing', document_no_confidence: 'none', document_no_evidence: null
  }, conflicts });
  const ignored = evaluateCandidateRisk(untrusted.detail, { conflicts });
  assert.equal(ignored.risk_level, 'low');
  assert.ok(!ignored.risk_reasons.some((item) => item.code === 'DOCUMENT_NO_CONFLICT'));

  const trusted = detailFixture({ conflicts });
  const conflict = evaluateCandidateRisk(trusted.detail, { conflicts });
  assert.equal(conflict.risk_level, 'high');
  assert.ok(conflict.risk_reasons.some((item) => item.code === 'DOCUMENT_NO_CONFLICT' && item.hard_blocker));
});

async function databaseFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taxkb-risk-assessment-'));
  const database = new NetlifyDB({ directory: path.join(root, 'database'), logger: () => {} });
  await database.start();
  await database.reset();
  await database.applyMigrations(path.join(process.cwd(), 'netlify', 'database', 'migrations'));
  const repository = createPostgresEvidenceRepository({
    pool: database,
    objectStore: createLocalEvidenceObjectStore({ rootDirectory: path.join(root, 'taxkb-evidence-raw') }),
    id: (prefix) => `${prefix}-${randomUUID()}`
  });
  const source = await repository.addSource({
    source_id: 'source-risk-db', source_name: '国家税务总局政策法规库', official_domain: 'fgk.chinatax.gov.cn',
    source_type: 'official-policy-regulations', adapter_version: 'risk-test', base_url: 'https://fgk.chinatax.gov.cn/zcfgk/', enabled: true
  });
  const run = await repository.createCollectionRun({ source_id: source.source_id, mode: 'risk-test' });
  const snapshot = await repository.recordRawSnapshot({
    source_id: source.source_id, collection_run_id: run.collection_run_id,
    official_url: 'https://fgk.chinatax.gov.cn/zcfgk/risk-test/content.html', canonical_url: 'https://fgk.chinatax.gov.cn/zcfgk/risk-test/content.html',
    http_status: 200, content_type: 'text/html', raw_content: `<article>${longBody}</article>`, normalized_text: longBody,
    parser_version: 'risk-parser-v1', parse_result: { title: '风险测试政策' }
  });
  const created = await repository.createCandidate({
    snapshot_id: snapshot.snapshot_id,
    parsed_fields: { title: '风险测试政策', document_no: '税总公告2026年第99号', issuing_authority: ['国家税务总局'], publish_date: '2026-09-01' },
    verification_state: 'pending_review', legal_status: 'pending'
  });
  return { root, database, repository, candidate: created.candidate };
}

test('风险评估持久化幂等，正文/解析器/规则变化保留历史且不改变 Candidate 状态', async () => {
  const fixture = await databaseFixture();
  try {
    const first = await fixture.repository.assessCandidateRisk(fixture.candidate.candidate_id);
    const repeated = await fixture.repository.assessCandidateRisk(fixture.candidate.candidate_id);
    assert.equal(first.created, true);
    assert.equal(repeated.created, false);
    assert.equal(first.assessment.assessment_id, repeated.assessment.assessment_id);
    assert.equal(first.assessment.rule_version, CANDIDATE_RISK_RULE_VERSION);
    assert.equal((await fixture.repository.listCandidateRiskAssessments(fixture.candidate.candidate_id)).length, 1);
    assert.equal((await fixture.repository.getCandidateForReview(fixture.candidate.candidate_id)).candidate.legal_status, 'pending');

    const reparsed = await fixture.repository.reparseCandidate(fixture.candidate.candidate_id, {
      parsed_fields: { title: '风险测试政策', document_no: '税总公告2026年第99号', issuing_authority: ['国家税务总局'], publish_date: '2026-09-01' },
      normalized_text: `${longBody}\n补充的官方条款内容。`.repeat(2), parser_version: 'risk-parser-v1'
    });
    assert.equal(reparsed.reparsed, true);
    const bodyChanged = await fixture.repository.assessCandidateRisk(fixture.candidate.candidate_id);
    assert.equal(bodyChanged.created, true);
    assert.equal(bodyChanged.assessment.supersedes_assessment_id, first.assessment.assessment_id);

    await fixture.repository.reparseCandidate(fixture.candidate.candidate_id, {
      parsed_fields: { title: '风险测试政策', document_no: '税总公告2026年第99号', issuing_authority: ['国家税务总局'], publish_date: '2026-09-01' },
      normalized_text: `${longBody}\n补充的官方条款内容。`.repeat(2), parser_version: 'risk-parser-v2'
    });
    const parserChanged = await fixture.repository.assessCandidateRisk(fixture.candidate.candidate_id);
    const ruleChanged = await fixture.repository.assessCandidateRisk(fixture.candidate.candidate_id, { ruleVersion: 'candidate-risk-rules-v2-test' });
    assert.equal(parserChanged.created, true);
    assert.equal(ruleChanged.created, true);

    const history = await fixture.repository.listCandidateRiskAssessments(fixture.candidate.candidate_id);
    assert.equal(history.length, 4);
    assert.equal(history.filter((item) => item.is_current).length, 1);
    assert.equal(history[0].rule_version, 'candidate-risk-rules-v2-test');
    assert.equal(history.filter((item) => !item.is_current).every((item) => item.superseded_at), true);
    await assert.rejects(
      () => fixture.database.query('UPDATE candidate_risk_assessments SET risk_score=99 WHERE assessment_id=$1', [first.assessment.assessment_id]),
      /immutable/
    );
    await assert.rejects(
      () => fixture.database.query('DELETE FROM candidate_risk_assessments WHERE assessment_id=$1', [ruleChanged.assessment.assessment_id]),
      /cannot be deleted/
    );
    assert.equal((await fixture.repository.getCandidateForReview(fixture.candidate.candidate_id)).candidate.legal_status, 'pending');
  } finally {
    await fixture.database.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('持久化重复检测只把双方均有可信文号 provenance 的记录视为文号冲突', async () => {
  const fixture = await databaseFixture();
  try {
    const otherBody = `${longBody}\n另一份官方正文。`;
    const run = await fixture.repository.createCollectionRun({ source_id: 'source-risk-db', mode: 'risk-conflict-test' });
    const snapshot = await fixture.repository.recordRawSnapshot({
      source_id: 'source-risk-db', collection_run_id: run.collection_run_id,
      official_url: 'https://fgk.chinatax.gov.cn/zcfgk/risk-other/content.html', canonical_url: 'https://fgk.chinatax.gov.cn/zcfgk/risk-other/content.html',
      http_status: 200, content_type: 'text/html', raw_content: `<article>${otherBody}</article>`, normalized_text: otherBody,
      parser_version: 'risk-parser-v1', parse_result: { title: '另一份风险测试政策' }
    });
    const other = await fixture.repository.createCandidate({
      snapshot_id: snapshot.snapshot_id,
      parsed_fields: { title: '另一份风险测试政策', document_no: '税总公告2026年第99号', document_no_source: 'structured_field', document_no_confidence: 'high', issuing_authority: ['国家税务总局'], publish_date: '2026-09-01' },
      verification_state: 'pending_review', legal_status: 'pending'
    });
    const initial = await fixture.repository.detectCandidateRiskConflicts(await fixture.repository.getCandidateForReview(fixture.candidate.candidate_id));
    assert.deepEqual(initial.document_no_conflicts, []);

    await fixture.repository.reparseCandidate(fixture.candidate.candidate_id, {
      parsed_fields: { title: '风险测试政策', document_no: '税总公告2026年第99号', document_no_source: 'title_nearby', document_no_confidence: 'high', issuing_authority: ['国家税务总局'], publish_date: '2026-09-01' },
      normalized_text: longBody, parser_version: 'risk-parser-v2'
    });
    const trusted = await fixture.repository.detectCandidateRiskConflicts(await fixture.repository.getCandidateForReview(fixture.candidate.candidate_id));
    assert.equal(trusted.document_no_conflicts.length, 1);
    assert.equal(trusted.document_no_conflicts[0].candidate_id, other.candidate.candidate_id);
  } finally {
    await fixture.database.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
