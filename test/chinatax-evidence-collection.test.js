import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvidenceRepository } from '../src/evidence-chain.js';
import { PHASE_2B_ALLOWED_DETAIL_URLS, addChinaTaxPolicySource, collectPhase2BDetails, parseChinaTaxPolicyEvidence } from '../src/chinatax-evidence-collection.js';
import { policySeedPolicies } from '../src/policy-seed.js';

const [firstUrl, secondUrl] = PHASE_2B_ALLOWED_DETAIL_URLS;
const pages = new Map([
  [firstUrl, `<html><head><meta name="ArticleTitle" content="财政部 税务总局 中国证监会关于规范转让上市公司限售股个人所得税政策的公告" /><meta name="PubDate" content="2026-08-28 18:45:40" /></head><body><header>国家税务总局政策法规库 简 / 繁 登录 EN 本站热词 发票 小微企业 个人所得税 个人中心</header><div class="detials contentLeft"><h3>财政部 税务总局 中国证监会关于规范转让上市公司限售股个人所得税政策的公告</h3><h5 class="actfwzh">财政部 税务总局 中国证监会公告2026年第26号</h5><div class="article"><div class="arc_cont"><p>本公告自2026年9月1日起施行。</p><p>第一条 本公告规定个人所得税政策。</p><p>财政部 税务总局 中国证监会</p><p>2026年8月28日</p></div></div></div><footer>关联解读 纠错或建议</footer></body></html>`],
  [secondUrl, `<html><head><meta name="ArticleTitle" content="财政部 税务总局关于明确非应税交易等增值税有关事项的公告" /><meta name="PubDate" content="2026-08-27 18:46:49" /></head><body><nav>登录 本站热词 发票查询 社保 个人中心</nav><div class="detials contentLeft"><h3>财政部 税务总局关于明确非应税交易等增值税有关事项的公告</h3><h5 class="actfwzh">财政部 税务总局公告2026年第25号</h5><p class="arc_date">成文日期：2026-08-27</p><div class="article"><div class="arc_cont"><p>自2026年9月1日起施行。</p><p>第一条 本公告明确增值税事项。</p><p>财政部 税务总局</p><p>2026年8月27日</p></div></div></div><footer>关联文件</footer></body></html>`]
]);

function fixedRepository() {
  let count = 0;
  const repository = createEvidenceRepository({ now: () => '2026-08-29T09:00:00.000Z', id: (prefix) => `${prefix}-${++count}` });
  const source = addChinaTaxPolicySource(repository);
  return { repository, source };
}

async function fakeFetch(url) {
  const body = pages.get(String(url));
  return {
    ok: Boolean(body), status: body ? 200 : 404,
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8', etag: `etag-${String(url).slice(-18, -13)}`, 'last-modified': 'Sat, 29 Aug 2026 00:00:00 GMT' }),
    text: async () => body || ''
  };
}

test('两条官方详情页只解析页面明确载明的字段，状态保持待审核', () => {
  const first = parseChinaTaxPolicyEvidence(pages.get(firstUrl));
  const second = parseChinaTaxPolicyEvidence(pages.get(secondUrl));
  assert.equal(first.title, '财政部 税务总局 中国证监会关于规范转让上市公司限售股个人所得税政策的公告');
  assert.equal(first.document_no, '财政部 税务总局 中国证监会公告2026年第26号');
  assert.deepEqual(first.issuing_authority, ['财政部', '税务总局', '中国证监会']);
  assert.equal(first.publish_date, '2026-08-28');
  assert.equal(first.effective_date, '2026-09-01');
  assert.equal(second.document_no, '财政部 税务总局公告2026年第25号');
  assert.equal(second.publish_date, '2026-08-27');
  assert.equal(second.expiry_date, null);
  assert.equal(second.verification_state, 'pending_review');
  assert.equal(second.legal_status, 'pending');
});

test('国家税务总局详情页只提取 .arc_cont 政策正文，排除网站模板污染', () => {
  const parsed = parseChinaTaxPolicyEvidence(pages.get(firstUrl));
  assert.match(parsed.normalized_text, /^本公告自2026年9月1日起施行。/);
  assert.match(parsed.normalized_text, /第一条 本公告规定个人所得税政策。/);
  assert.match(parsed.normalized_text, /财政部 税务总局 中国证监会\n2026年8月28日$/);
  assert.doesNotMatch(parsed.normalized_text, /国家税务总局政策法规库|简\s*\/\s*繁|登录|本站热词|发票查询|个人中心|关联解读|纠错或建议/);
});

test('首次抓取保留两份原始 HTML、正文、hash 与 source/run/snapshot/candidate 证据链', async () => {
  const { repository, source } = fixedRepository();
  const result = await collectPhase2BDetails({ repository, source_id: source.source_id, fetchImpl: fakeFetch });
  assert.deepEqual(result.created, { snapshots: 2, candidates: 2, policies: 0, netlify_blobs: 0 });
  for (const item of result.results) {
    assert.match(repository.readRawObject(item.snapshot.raw_object_key), /<html>/);
    assert.match(repository.readRawObject(item.snapshot.normalized_text_object_key), /第一条/);
    assert.match(item.snapshot.raw_sha256, /^[a-f0-9]{64}$/);
    assert.match(item.snapshot.normalized_text_sha256, /^[a-f0-9]{64}$/);
    assert.equal(item.snapshot.collection_run_id, result.run.collection_run_id);
    assert.equal(item.candidate.source_id, source.source_id);
    assert.equal(item.candidate.snapshot_id, item.snapshot.snapshot_id);
    assert.equal(item.candidate.verification_state, 'pending_review');
    assert.equal(item.candidate.legal_status, 'pending');
  }
  assert.deepEqual(repository.counts(), { source: 1, collection_run: 1, raw_snapshot: 2, candidate: 2, review_decision: 0, policy: 0, policy_version: 0, policy_relation: 0 });
});

test('重复抓取相同正文会新增不可覆盖 snapshot，但不会新增 candidate 或 policy', async () => {
  const { repository, source } = fixedRepository();
  const first = await collectPhase2BDetails({ repository, source_id: source.source_id, fetchImpl: fakeFetch });
  const second = await collectPhase2BDetails({ repository, source_id: source.source_id, fetchImpl: fakeFetch });
  assert.equal(first.created.snapshots, 2);
  assert.equal(first.created.candidates, 2);
  assert.equal(second.created.snapshots, 2);
  assert.equal(second.created.candidates, 0);
  assert.ok(second.results.every((item) => item.candidate_created === false));
  assert.ok(second.results.every((item) => item.snapshot.previous_snapshot_id));
  assert.ok(second.results.every((item) => item.snapshot.content_changed === false));
  assert.deepEqual(repository.counts(), { source: 1, collection_run: 2, raw_snapshot: 4, candidate: 2, review_decision: 0, policy: 0, policy_version: 0, policy_relation: 0 });
});

test('Phase 2B allow-list 拒绝历史 URL，并且不影响现有三条 seed policy', async () => {
  const before = policySeedPolicies();
  const { repository, source } = fixedRepository();
  await assert.rejects(() => collectPhase2BDetails({ repository, source_id: source.source_id, fetchImpl: fakeFetch, urls: [firstUrl, 'https://fgk.chinatax.gov.cn/zcfgk/c100012/c5193137/content.html'] }), /只允许读取已确认的两条/);
  assert.deepEqual(policySeedPolicies(), before);
  assert.equal(policySeedPolicies().length, 3);
  assert.equal(repository.counts().policy, 0);
});
