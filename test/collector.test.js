import test from 'node:test';
import assert from 'node:assert/strict';
import { collectChinaTaxLibrary, collectMofVatSearch, discoverGovPolicyUrls, discoverNpcPolicyUrls, inferStatus, parsePolicyDocument } from '../src/collector.js';
import { automaticReviewDecision, candidateScopeReviewSummary, secondaryReviewSummary, publishedDocumentReviewSummary, publishedDocumentVersionReviewSummary } from '../src/auto-review.js';
import { searchDocuments } from '../src/search.js';
import { priorityReviewQueue } from '../src/priority-review.js';
import { inferTaxTopics } from '../src/topics.js';

const source = {
  id: 'source-chinatax',
  authority: '国家税务总局',
  name: '国家税务总局政策法规库',
  collectionUrl: 'https://fgk.chinatax.gov.cn/zcfgk/index.html',
  catalogUrls: []
};

const pages = new Map([
  ['https://fgk.chinatax.gov.cn/zcfgk/index.html', '<a href="c100027/list.html">最新文件</a><a href="c100009/list.html">法律</a>'],
  ['https://fgk.chinatax.gov.cn/zcfgk/c100027/list.html', '<a href="c1/content.html">增值税文件</a>'],
  ['https://fgk.chinatax.gov.cn/zcfgk/c100009/list.html', '<a href="c2/content.html">征管文件</a>'],
  ['https://fgk.chinatax.gov.cn/zcfgk/c100027/c1/content.html', '<html><h1>国家税务总局关于增值税的公告</h1><p>全文有效 成文日期：2026年7月1日</p><p>第一条 为规范增值税征收管理，制定本公告。</p><p>第二条 增值税纳税人应当依法办理。</p></html>'],
  ['https://fgk.chinatax.gov.cn/zcfgk/c100009/c2/content.html', '<html><h1>税收征收管理示例文件</h1><p>已修订 成文日期：2025年1月2日</p><p>第一条 税收征收管理应当依法实施。</p></html>']
]);

async function fakeFetch(url) {
  const text = pages.get(String(url));
  return { ok: Boolean(text), status: text ? 200 : 404, text: async () => text || '' };
}

test('采集器只发现官方详情页，并提取条款、日期、状态和税种', async () => {
  const result = await collectChinaTaxLibrary(source, { fetchImpl: fakeFetch, maxDocuments: 10 });
  assert.equal(result.scannedListPages, 3);
  assert.equal(result.discoveredDetailUrls, 2);
  assert.equal(result.errors.length, 0);
  assert.equal(result.documents.length, 2);
  const vat = result.documents.find((item) => item.title.includes('增值税'));
  assert.equal(vat.status, 'current');
  assert.equal(vat.publishedAt, '2026-07-01');
  assert.ok(vat.taxTypes.includes('增值税'));
  assert.equal(vat.sections.length, 2);
  assert.match(vat.officialUrl, /content\.html$/);
  const revised = result.documents.find((item) => item.title.includes('征收管理'));
  assert.equal(revised.status, 'revised');
});

test('采集器通过官方分页接口发现动态加载的历史文件', async () => {
  const dynamicSource = { ...source, catalogUrls: [] };
  const calls = [];
  async function dynamicFetch(url, options = {}) {
    calls.push({ url: String(url), method: options.method || 'GET' });
    if (String(url) === dynamicSource.collectionUrl) {
      return { ok: true, text: async () => '<script>var channelId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";</script>' };
    }
    if (String(url) === 'https://www.chinatax.gov.cn/getFileListByCodeId') {
      const page = Number(options.body.get('page'));
      const results = page === 1
        ? [{ url: 'http://www.chinatax.gov.cn/zcfgk/c100009/a/content.html' }]
        : [{ url: 'http://www.chinatax.gov.cn/zcfgk/c100009/b/content.html' }];
      return { ok: true, json: async () => ({ results: { data: { page, rows: 50, total: 100, results } } }) };
    }
    if (String(url).endsWith('/a/content.html')) return { ok: true, text: async () => '<h1>动态文件甲</h1><p>第一条 内容甲。</p>' };
    if (String(url).endsWith('/b/content.html')) return { ok: true, text: async () => '<h1>动态文件乙</h1><p>第一条 内容乙。</p>' };
    return { ok: false, status: 404, text: async () => '' };
  }
  const result = await collectChinaTaxLibrary(dynamicSource, { fetchImpl: dynamicFetch, maxDocuments: 10, maxListPages: 5 });
  assert.equal(result.scannedListPages, 3);
  assert.equal(result.discoveredDetailUrls, 2);
  assert.equal(result.documents.length, 2);
  assert.equal(calls.filter((call) => call.url.includes('getFileListByCodeId')).length, 2);
  assert.ok(result.documents.every((document) => document.officialUrl.startsWith('https://fgk.chinatax.gov.cn/')));
});

test('财政部税政司目录采集全部税种文件，不只过滤增值税', async () => {
  const source = { id: 'source-mof', authority: '财政部', url: 'https://szs.mof.gov.cn/zhengcefabu/' };
  const mofPages = new Map([
    ['https://szs.mof.gov.cn/zhengcefabu/', '<script>var countPage = 2;</script><a href="index_1.htm">下一页</a><a href="2026/a.htm">关于个人所得税的公告</a><a href="2026/b.htm">关于消费税的公告</a>'],
    ['https://szs.mof.gov.cn/zhengcefabu/index_1.htm', '<a href="2026/c.htm">关于车船税的公告</a>'],
    ['https://szs.mof.gov.cn/zhengcefabu/2026/a.htm', '<h1>关于个人所得税的公告</h1><p>全文有效</p><p>第一条 个人所得税政策。</p>'],
    ['https://szs.mof.gov.cn/zhengcefabu/2026/b.htm', '<h1>关于消费税的公告</h1><p>全文有效</p><p>第一条 消费税政策。</p>'],
    ['https://szs.mof.gov.cn/zhengcefabu/2026/c.htm', '<h1>关于车船税的公告</h1><p>全文有效</p><p>第一条 车船税政策。</p>']
  ]);
  async function mofFetch(url) {
    const text = mofPages.get(String(url));
    return { ok: Boolean(text), status: text ? 200 : 404, text: async () => text || '' };
  }
  const result = await collectMofVatSearch(source, { fetchImpl: mofFetch, maxDocuments: 10, maxListPages: 2 });
  assert.equal(result.discoveredDetailUrls, 3);
  assert.equal(result.documents.length, 3);
  assert.ok(result.documents.some((document) => document.title.includes('个人所得税')));
  assert.ok(result.documents.some((document) => document.title.includes('消费税')));
  assert.ok(result.documents.some((document) => document.title.includes('车船税')));
  assert.ok(result.documents.every((document) => document.status === 'pending_verification'));
});

test('中国政府网目录只发现税收相关的官方原文链接', async () => {
  const source = { id: 'source-gov', authority: '国务院', url: 'https://www.gov.cn/zhengce/' };
  async function govFetch() {
    return { ok: true, text: async () => JSON.stringify([
      { TITLE: '中华人民共和国增值税法实施条例', URL: 'https://www.gov.cn/zhengce/content/2025-12/25/content_123.htm' },
      { TITLE: '关于促进消费的若干措施', URL: 'https://www.gov.cn/zhengce/content/2025-12/25/content_456.htm' },
      { TITLE: '关于预算管理的通知', URL: '/zhengce/content/2025-12/25/content_789.htm' }
    ]) };
  }
  const result = await discoverGovPolicyUrls(source, { fetchImpl: govFetch });
  assert.equal(result.scannedListPages, 1);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.detailUrls, ['https://www.gov.cn/zhengce/content/2025-12/25/content_123.htm']);
});

test('国家法律法规数据库按税种关键词发现可去重的官方法规条目', async () => {
  async function npcFetch(url) {
    const content = JSON.parse(arguments[1]?.body || '{}').searchContent;
    return { ok: true, json: async () => ({ code: 200, rows: [
      { bbbs: `${content}-one`, title: `${content}法`, zdjgName: '全国人民代表大会常务委员会' },
      { bbbs: 'shared', title: '中华人民共和国增值税法', zdjgName: '全国人民代表大会常务委员会' },
      { bbbs: 'local', title: '消费者权益保护条例', zdjgName: '某市人民代表大会常务委员会' }
    ] }) };
  }
  const result = await discoverNpcPolicyUrls({ id: 'source-npc', authority: '全国人大常委会', url: 'https://www.npc.gov.cn/' }, { fetchImpl: npcFetch, maxListPages: 2 });
  assert.equal(result.scannedListPages, 2);
  assert.equal(result.errors.length, 0);
  assert.equal(result.detailUrls.length, 3);
  assert.ok(result.detailUrls.every((url) => url.startsWith('https://flk.npc.gov.cn/detail?bbbs=')));
});

test('候选范围复核会剔除非税收题名和全国人大来源中的地方性法规', () => {
  const candidates = [
    { id: 'tax', state: 'pending', document: { title: '中华人民共和国增值税法', sourceId: 'source-npc', authority: '全国人民代表大会常务委员会' } },
    { id: 'local', state: 'pending', document: { title: '地方增值税管理条例', sourceId: 'source-npc', authority: '某市人民代表大会常务委员会' } },
    { id: 'other', state: 'pending', document: { title: '消费者权益保护条例', sourceId: 'source-npc', authority: '全国人民代表大会常务委员会' } }
  ];
  const review = candidateScopeReviewSummary(candidates);
  assert.equal(review.rejectable, 2);
  assert.equal(review.retained, 1);
  assert.equal(review.decisions.find((item) => item.candidateId === 'tax').decision, 'keep');
});

test('国家法律法规数据库的官方现行有效性代码可作为自动发布依据', () => {
  const decision = automaticReviewDecision({ sourceId: 'source-npc', status: 'current', title: '中华人民共和国增值税法', summary: '', sections: [{ text: '第一条 本法适用于增值税。' }] });
  assert.equal(decision.decision, 'publish');
  assert.equal(decision.evidence, 'npc-official-current-code');
});

test('官方全文有效标记优先于正文中的历次修订记录', () => {
  assert.equal(inferStatus('全文有效 根据2024年决定第二次修订'), 'current');
  assert.equal(inferStatus('已废止 根据历史文件修订'), 'repealed');
  assert.equal(inferStatus('全文失效'), 'repealed');
});

test('政府网页面在标题层不含法规名称时，使用页面标题作为法规标题', () => {
  const document = parsePolicyDocument('<html><title>中华人民共和国个人所得税法实施条例_税务_中国政府网</title><h1>索 引 号：</h1><p>第一条 根据个人所得税法，制定本条例。</p></html>', 'https://www.gov.cn/zhengce/example.htm', { id: 'source-gov', authority: '国务院' });
  assert.equal(document.title, '中华人民共和国个人所得税法实施条例');
  assert.equal(document.status, 'pending_verification');
});

test('法规列表默认按成文日期倒序，日期相同时再按状态排序', () => {
  const current = { id: 'current', title: '增值税现行规则', status: 'current', publishedAt: '2025-01-01', documentNumber: '', summary: '', taxTypes: ['增值税'], sections: [{ id: 'current-1', label: '第一条', text: '增值税现行规则。' }] };
  const pending = { id: 'pending', title: '增值税政策专项通知', status: 'pending_verification', publishedAt: '2026-01-01', documentNumber: '', summary: '增值税政策', taxTypes: ['增值税'], sections: [{ id: 'pending-1', label: '第一条', text: '增值税政策专项通知。' }] };
  const results = searchDocuments([pending, current], { query: '增值税政策' });
  assert.equal(results[0].document.id, 'pending');
});

test('检索可按发布日期年份筛选，不改变文件有效状态判断', () => {
  const documents = [
    { id: 'new', title: '2026增值税公告', status: 'pending_verification', publishedAt: '2026-01-01', documentNumber: '', summary: '', taxTypes: ['增值税'], sections: [] },
    { id: 'old', title: '2025增值税公告', status: 'current', publishedAt: '2025-01-01', documentNumber: '', summary: '', taxTypes: ['增值税'], sections: [] }
  ];
  const results = searchDocuments(documents, { taxType: '增值税', publishedYear: '2026' });
  assert.deepEqual(results.map((item) => item.document.id), ['new']);
  assert.equal(results[0].document.status, 'pending_verification');
});

test('高频待核验清单优先展示核心税种中的法规层级文件', () => {
  const documents = [
    { id: 'current', title: '增值税现行文件', status: 'current', sourceId: 'source-chinatax', publishedToMembersAt: '2026-01-01', publishedAt: '2026-01-01', taxTypes: ['增值税'] },
    { id: 'notice', title: '增值税通知', status: 'pending_verification', sourceId: 'source-mof', publishedToMembersAt: '2026-01-01', publishedAt: '2026-01-01', taxTypes: ['增值税'] },
    { id: 'law', title: '增值税管理办法', status: 'pending_verification', sourceId: 'source-chinatax', publishedToMembersAt: '2026-01-01', publishedAt: '2026-01-01', taxTypes: ['增值税'] },
    { id: 'eit', title: '企业所得税公告', status: 'pending_verification', sourceId: 'source-mof', publishedToMembersAt: '2026-01-01', publishedAt: '2026-01-01', taxTypes: ['企业所得税'] }
  ];
  const queue = priorityReviewQueue(documents, { limit: 5 });
  assert.equal(queue.groups.find((group) => group.id === 'vat').total, 2);
  assert.equal(queue.groups.find((group) => group.id === 'vat').items[0].document.id, 'law');
  assert.equal(queue.groups.find((group) => group.id === 'eit').total, 1);
});

test('税种索引覆盖房产税、契税、印花税等非高频税种', () => {
  const topics = inferTaxTopics({ title: '关于房产税、契税和印花税征收事项的公告', sections: [] });
  assert.ok(topics.includes('房产税'));
  assert.ok(topics.includes('契税'));
  assert.ok(topics.includes('印花税'));
});

test('已发布待核验文件仅在正文明确载明本文件期限届满时归档', () => {
  const documents = [
    { id: 'expired', title: '阶段性税收优惠公告', status: 'pending_verification', publishedToMembersAt: '2024-01-01', sections: [{ text: '本公告执行至2025年12月31日。' }] },
    { id: 'ambiguous', title: '申报说明', status: 'pending_verification', publishedToMembersAt: '2024-01-01', sections: [{ text: '申请材料提交截止至2025年12月31日。' }] },
    { id: 'current', title: '现行文件', status: 'current', publishedToMembersAt: '2024-01-01', sections: [{ text: '本公告执行至2025年12月31日。' }] }
  ];
  const review = publishedDocumentReviewSummary(documents, new Date('2026-07-30T00:00:00Z'));
  assert.equal(review.examined, 2);
  assert.equal(review.expirable, 1);
  assert.equal(review.decisions.find((item) => item.documentId === 'expired').expiryDate, '2025-12-31');
});

test('已发布文件仅在后发原文同句明确点名并标记废止或修订时建立版本关系', () => {
  const documents = [
    { id: 'old', title: '某项税收优惠政策实施通知', status: 'pending_verification', publishedToMembersAt: '2020-01-01', publishedAt: '2020-01-01', sections: [{ text: '旧政策正文。' }] },
    { id: 'new', title: '税收优惠政策调整公告', status: 'pending_verification', publishedToMembersAt: '2021-01-01', publishedAt: '2021-01-01', sections: [{ text: '《某项税收优惠政策实施通知》同时废止。' }] },
    { id: 'ambiguous', title: '政策说明', status: 'pending_verification', publishedToMembersAt: '2021-01-01', publishedAt: '2021-01-02', sections: [{ text: '《某项税收优惠政策实施通知》适用范围不变。其他附件废止。' }] }
  ];
  const review = publishedDocumentVersionReviewSummary(documents);
  assert.equal(review.relationLinks.length, 1);
  assert.equal(review.relationLinks[0].type, 'repeals');
  assert.deepEqual(review.statusUpdates, [{ documentId: 'old', status: 'repealed', sourceId: 'new', type: 'repeals' }]);
});

test('版本关系只有在废止或修订标记紧邻被提及文件时才作为线索', () => {
  const target = { id: 'target', title: '某项旧税收政策通知', officialUrl: 'https://example.test/old', publishedAt: '2020-01-01', status: 'current', sections: [{ text: '旧政策正文' }] };
  const incidental = { id: 'incidental', title: '贯彻执行政策公告', officialUrl: 'https://example.test/incidental', publishedAt: '2021-01-01', status: 'pending_verification', sections: [{ text: '为贯彻落实《某项旧税收政策通知》，现公告有关事项。本公告废止其他附件。' }] };
  const direct = { id: 'direct', title: '新税收政策公告', officialUrl: 'https://example.test/new', publishedAt: '2021-01-01', status: 'pending_verification', sections: [{ text: '《某项旧税收政策通知》同时废止。' }] };
  const candidates = [
    { id: 'candidate-incidental', state: 'pending', document: incidental },
    { id: 'candidate-direct', state: 'pending', document: direct }
  ];
  const summary = secondaryReviewSummary(candidates, [target], new Date('2026-01-01'));
  assert.equal(summary.relationHints, 1);
  assert.equal(summary.decisions.find((item) => item.candidateId === 'candidate-direct').relationHint.type, 'repeals');
  assert.equal(summary.decisions.find((item) => item.candidateId === 'candidate-incidental').relationHint, null);
});
