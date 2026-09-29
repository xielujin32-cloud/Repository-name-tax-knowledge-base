import test from 'node:test';
import assert from 'node:assert/strict';
import { PHASE4_P1_PILOT_OFFICIAL_URLS, PHASE4_P1_PILOT_TOPIC_LABELS, dryRunChinaTaxPolicyPilot } from '../src/chinatax-evidence-collection.js';
import { createEvidenceAdminHandler } from '../netlify/lib/evidence-ingestion.mjs';

const rows = [
  ['国家税务总局关于增值税一般纳税人登记管理有关事项的公告', '国家税务总局公告2026年第2号', '2026-01-01', '一般纳税人 增值税纳税人登记管理。'],
  ['国家税务总局关于起征点标准等增值税征管事项的公告', '国家税务总局公告2026年第4号', '2026-01-30', '小规模纳税人发生增值税应税交易，适用起征点标准。'],
  ['财政部 税务总局关于明确非应税交易等增值税有关事项的公告', '财政部 税务总局公告2026年第25号', '2026-08-27', '本公告自2026年9月1日起施行，明确增值税非应税交易。'],
  ['国家税务总局关于增值税小规模纳税人减免增值税等政策有关征管事项的公告', '国家税务总局公告2023年第1号', '2023-01-09', '根据《国家税务总局关于起征点标准等增值税征管事项的公告》（国家税务总局公告2026年第4号），本公告全文废止。'],
  ['财政部 税务总局关于进一步支持小微企业和个体工商户发展有关税费政策的公告', '财政部 税务总局公告2023年第12号', '2023-08-02', '小型微利企业减按规定缴纳企业所得税，政策执行至2027年12月31日。'],
  ['国家税务总局关于支持跨境电商出口海外仓发展出口退（免）税有关事项的公告', '国家税务总局公告2025年第3号', '2025-01-27', '跨境电商出口海外仓货物可以按照规定申报办理出口退（免）税。'],
  ['财政部 海关总署 税务总局关于跨境电子商务出口退运商品税收优惠政策的公告', '财政部 海关总署 税务总局公告2026年第16号', '2026-02-06', '跨境电子商务出口退运商品符合条件的免征进口环节增值税和消费税。'],
  ['国家税务总局关于进一步便利出口退税办理促进外贸平稳发展有关事项的公告', '国家税务总局公告2022年第9号', '2022-04-29', '出口退税企业可以按照规定办理出口退（免）税事项。'],
  ['财政部 税务总局 商务部 海关总署关于跨境电子商务综合试验区零售出口货物税收政策的通知', '财税〔2018〕103号', '2018-09-28', '跨境电子商务零售出口货物符合条件的，试行增值税、消费税免税政策。'],
  ['财政部 税务总局关于延续实施境外机构投资境内债券市场企业所得税、增值税政策的公告', '财政部 税务总局公告2026年第5号', '2026-01-13', '境外机构取得债券利息收入暂免征收企业所得税和增值税。']
];

function page([title, documentNo, date, body], index) {
  const status = index === 3 ? '全文废止' : '全文有效';
  return `<html><head><meta name="ArticleTitle" content="${title}" /><meta name="PubDate" content="${date}" /></head><body><div class="detials contentLeft"><h3>${title}</h3><h5 class="actfwzh">${documentNo}</h5><p>${status} 成文日期：${date}</p><div class="article"><div class="arc_cont"><p>${body}</p><p>本文件由官方发布机构发布，相关资料应当留存备查。</p></div></div></div></body></html>`;
}

test('Phase 4 P1 官方试运行只读取受控 STA 页面，输出待核验元数据、风险和关系提示，不创建业务对象', async () => {
  const htmlByUrl = new Map(PHASE4_P1_PILOT_OFFICIAL_URLS.map((url, index) => [url, page(rows[index], index)]));
  const result = await dryRunChinaTaxPolicyPilot({
    fetchImpl: async (url) => new Response(htmlByUrl.get(String(url)) || '', { status: htmlByUrl.has(String(url)) ? 200 : 404, headers: { 'content-type': 'text/html' } })
  });

  assert.equal(result.mode, 'dry-run');
  assert.equal(result.candidate_count, 10);
  assert.deepEqual(result.writes, { raw_snapshots: 0, evidence: 0, candidates: 0, reviews: 0, policies: 0, policy_versions: 0, public_projections: 0, business_production_writes: 0 });
  assert.deepEqual(result.coverage.missing_topics, []);
  assert.ok(PHASE4_P1_PILOT_TOPIC_LABELS.every((topic) => result.coverage.covered_topics.includes(topic)));
  assert.ok(result.candidates.every((item) => item.suggested_validity_status === 'pending_verification'));
  assert.ok(result.candidates.every((item) => item.body_hash?.length === 64 && !('official_body' in item) && !('raw_html' in item)));
  assert.equal(result.candidates[3].official_status_hint, 'official_page_marks_repealed_or_expired');
  assert.ok(result.candidates[3].relation_proposals.some((item) => item.relation_type === 'repeals'));
});

test('Phase 4 P1 试运行拒绝第三方 URL，且不开始任何详情请求', async () => {
  let calls = 0;
  await assert.rejects(
    () => dryRunChinaTaxPolicyPilot({ urls: ['https://example.com/policy/content.html'], fetchImpl: async () => { calls += 1; return new Response(''); } }),
    /国家税务总局法规库详情 URL/
  );
  assert.equal(calls, 0);
});

test('Phase 4 P1 管理员 dry-run 只调用受控只读检查，不构造 repository 或业务对象', async () => {
  const previous = process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
  process.env.NETLIFY_TAXKB_ADMIN_TOKEN = 'phase4p1-test-token';
  let repositoryCalls = 0;
  let pilotCalls = 0;
  try {
    const handler = createEvidenceAdminHandler({
      repositoryFactory: () => { repositoryCalls += 1; throw new Error('dry-run must not open repository'); },
      chinaTaxPilotDryRunFactory: async () => {
        pilotCalls += 1;
        return { mode: 'dry-run', candidate_count: 10, candidates: [], writes: { business_production_writes: 0 } };
      }
    });
    const response = await handler(new Request('https://taxkb.test/api/admin/evidence/sources/chinatax/pilot-dry-run', {
      headers: { authorization: 'Bearer phase4p1-test-token' }
    }), '/api/admin/evidence/sources/chinatax/pilot-dry-run', new URL('https://taxkb.test/api/admin/evidence/sources/chinatax/pilot-dry-run'));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { mode: 'dry-run', candidate_count: 10, candidates: [], writes: { business_production_writes: 0 } });
    assert.equal(pilotCalls, 1);
    assert.equal(repositoryCalls, 0);
  } finally {
    if (previous === undefined) delete process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
    else process.env.NETLIFY_TAXKB_ADMIN_TOKEN = previous;
  }
});
