import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tempData = await mkdtemp(join(tmpdir(), 'taxkb-'));
await copyFile(resolve('data/seed.json'), join(tempData, 'seed.json'));
process.env.TAXKB_DATA_DIR = tempData;
const { createApp } = await import('../src/server.js');
const server = await createApp();
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const base = `http://127.0.0.1:${server.address().port}`;

async function request(path, options = {}, token = '') {
  return fetch(`${base}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers } });
}
async function login(username, password) {
  const response = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  assert.equal(response.status, 200);
  return (await response.json()).token;
}

test.after(async () => new Promise((resolveClose) => server.close(resolveClose)));

test('根路径交付手机知识库与 PWA 配置', async () => {
  const home = await request('/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /手机税务知识库/);
  const manifest = await request('/manifest.webmanifest');
  assert.equal(manifest.status, 200);
  assert.equal((await manifest.json()).display, 'standalone');
  const worker = await request('/sw.js');
  assert.equal(worker.status, 200);
  assert.match(await worker.text(), /api\/knowledge/);
});

test('已发布官方文件可检索，并保留官方链接和条款', async () => {
  const token = await login('member', 'member-demo');
  const response = await request('/api/query', { method: 'POST', body: JSON.stringify({ question: '哪些主体是增值税纳税人？' }) }, token);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.answered, true);
  assert.ok(body.citations.length > 0);
  assert.match(body.citations[0].officialUrl, /^https:\/\//);
  assert.ok(body.citations.some((citation) => citation.sectionLabel === '第三条'));
});

test('法规分类接口按税种返回统计，并支持分类后的分页浏览', async () => {
  const token = await login('member', 'member-demo');
  const taxonomyResponse = await request('/api/taxonomy', {}, token);
  assert.equal(taxonomyResponse.status, 200);
  const taxonomy = await taxonomyResponse.json();
  assert.ok(taxonomy.categories.length > 0);
  const category = taxonomy.categories[0];
  assert.ok(category.count > 0);
  assert.ok('repealed' in category);
  assert.ok('expired' in category);
  const browseResponse = await request(`/api/documents?taxType=${encodeURIComponent(category.label)}&limit=1&offset=0`, {}, token);
  assert.equal(browseResponse.status, 200);
  const browse = await browseResponse.json();
  assert.equal(browse.total, category.count);
  assert.ok(browse.results.length <= 1);
});

test('法规浏览结果包含成文日期字段，供页面在每条法规下方展示', async () => {
  const token = await login('member', 'member-demo');
  const response = await request('/api/documents?limit=1&offset=0', {}, token);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok('publishedAt' in body.results[0].document);
});

test('无证据的问题拒答，且不会返回引用', async () => {
  const token = await login('member', 'member-demo');
  const response = await request('/api/query', { method: 'POST', body: JSON.stringify({ question: '研发费用加计扣除比例是多少？' }) }, token);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.answered, false);
  assert.equal(body.citations.length, 0);
});

test('仅命中税收等泛词时拒答，不把无关法规当作依据', async () => {
  const token = await login('member', 'member-demo');
  const response = await request('/api/query', { method: 'POST', body: JSON.stringify({ question: '一个不存在的税收优惠政策是什么？' }) }, token);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.answered, false);
  assert.equal(body.citations.length, 0);
});

test('成员不能创建来源或发布文件', async () => {
  const token = await login('member', 'member-demo');
  const response = await request('/api/admin/sources', { method: 'POST', body: JSON.stringify({ name: 'x', authority: 'x', url: 'https://example.com' }) }, token);
  assert.equal(response.status, 403);
});

test('管理员审核发布候选后，成员才能查询到它', async () => {
  const admin = await login('admin', 'admin-demo');
  const source = await request('/api/admin/sources', {}, admin).then((response) => response.json()).then((body) => body.sources[0]);
  const input = { title: '测试官方文件', authority: '国家税务总局', sourceId: source.id, officialUrl: 'https://fgk.chinatax.gov.cn/zcfgk/index.html', status: 'current', taxTypes: ['测试税种'], sections: [{ label: '第一条', text: '测试文件仅用于验证候选审核后发布并可检索。' }] };
  const created = await request('/api/admin/candidates', { method: 'POST', body: JSON.stringify(input) }, admin);
  assert.equal(created.status, 201);
  const candidate = (await created.json()).candidate;
  const beforeToken = await login('member', 'member-demo');
  const before = await request('/api/documents?query=候选审核', {}, beforeToken).then((response) => response.json());
  assert.equal(before.results.length, 0);
  const reviewed = await request(`/api/admin/candidates/${candidate.id}/review`, { method: 'POST', body: JSON.stringify({ action: 'publish' }) }, admin);
  assert.equal(reviewed.status, 200);
  const after = await request('/api/documents?query=候选审核', {}, beforeToken).then((response) => response.json());
  assert.equal(after.results.length, 1);
  assert.equal(after.results[0].document.status, 'current');
});

test('自动初审只发布有明确现行有效依据且未到期的候选文件', async () => {
  const admin = await login('admin', 'admin-demo');
  const source = await request('/api/admin/sources', {}, admin).then((response) => response.json()).then((body) => body.sources[0]);
  const inputs = [
    { title: '自动初审可发布', authority: '国家税务总局', sourceId: source.id, officialUrl: 'https://fgk.chinatax.gov.cn/zcfgk/auto-current/content.html', status: 'current', sections: [{ label: '正文', text: '本文件现行有效。' }] },
    { title: '自动初审到期', authority: '国家税务总局', sourceId: source.id, officialUrl: 'https://fgk.chinatax.gov.cn/zcfgk/auto-expired/content.html', status: 'current', sections: [{ label: '正文', text: '本文件全文有效，自2018年1月1日至2020年12月31日止。' }] },
    { title: '自动初审无依据', authority: '国家税务总局', sourceId: source.id, officialUrl: 'https://fgk.chinatax.gov.cn/zcfgk/auto-unknown/content.html', status: 'current', sections: [{ label: '正文', text: '本文件规定有关事项。' }] }
  ];
  for (const input of inputs) assert.equal((await request('/api/admin/candidates', { method: 'POST', body: JSON.stringify(input) }, admin)).status, 201);
  const preview = await request('/api/admin/auto-review', { method: 'POST', body: JSON.stringify({ apply: false }) }, admin).then((response) => response.json());
  assert.ok(preview.publishable >= 1);
  const applied = await request('/api/admin/auto-review', { method: 'POST', body: JSON.stringify({ apply: true }) }, admin).then((response) => response.json());
  assert.ok(applied.published >= 1);
  const member = await login('member', 'member-demo');
  const published = await request('/api/documents?query=自动初审可发布', {}, member).then((response) => response.json());
  const expired = await request('/api/documents?query=自动初审到期', {}, member).then((response) => response.json());
  assert.ok(published.results.some((item) => item.document.title === '自动初审可发布'));
  assert.ok(!expired.results.some((item) => item.document.title === '自动初审到期'));
});

test('第二轮复核归档已修订和已废止文件，且问答不会用历史文件作依据', async () => {
  const admin = await login('admin', 'admin-demo');
  const source = await request('/api/admin/sources', {}, admin).then((response) => response.json()).then((body) => body.sources[0]);
  const input = { title: '第二轮已废止文件', authority: '国家税务总局', sourceId: source.id, officialUrl: 'https://fgk.chinatax.gov.cn/zcfgk/secondary-repealed/content.html', status: 'repealed', sections: [{ label: '正文', text: '本文件已废止。' }] };
  assert.equal((await request('/api/admin/candidates', { method: 'POST', body: JSON.stringify(input) }, admin)).status, 201);
  const preview = await request('/api/admin/secondary-review', { method: 'POST', body: JSON.stringify({ apply: false }) }, admin).then((response) => response.json());
  assert.ok(preview.archivable >= 1);
  const applied = await request('/api/admin/secondary-review', { method: 'POST', body: JSON.stringify({ apply: true }) }, admin).then((response) => response.json());
  assert.ok(applied.archived >= 1);
  const member = await login('member', 'member-demo');
  const browse = await request('/api/documents?query=第二轮已废止文件&status=repealed', {}, member).then((response) => response.json());
  const answer = await request('/api/query', { method: 'POST', body: JSON.stringify({ question: '第二轮已废止文件' }) }, member).then((response) => response.json());
  assert.ok(browse.results.some((item) => item.document.title === '第二轮已废止文件'));
  assert.ok(answer.citations.every((citation) => citation.status === 'current'));
  assert.ok(!answer.citations.some((citation) => citation.title === '第二轮已废止文件'));
});

test('第三轮复核将原文明确到期的待核验文件归档为期限届满', async () => {
  const admin = await login('admin', 'admin-demo');
  const source = await request('/api/admin/sources', {}, admin).then((response) => response.json()).then((body) => body.sources[0]);
  const input = { title: '第三轮期限届满文件', authority: '国家税务总局', sourceId: source.id, officialUrl: 'https://fgk.chinatax.gov.cn/zcfgk/third-expired/content.html', status: 'pending_verification', sections: [{ label: '正文', text: '本政策自2018年1月1日至2020年12月31日止。' }] };
  assert.equal((await request('/api/admin/candidates', { method: 'POST', body: JSON.stringify(input) }, admin)).status, 201);
  await request('/api/admin/secondary-review', { method: 'POST', body: JSON.stringify({ apply: true }) }, admin);
  const preview = await request('/api/admin/third-review', { method: 'POST', body: JSON.stringify({ apply: false }) }, admin).then((response) => response.json());
  assert.ok(preview.expiryArchivable >= 1);
  const applied = await request('/api/admin/third-review', { method: 'POST', body: JSON.stringify({ apply: true }) }, admin).then((response) => response.json());
  assert.ok(applied.archivedExpired >= 1);
  const member = await login('member', 'member-demo');
  const browse = await request('/api/documents?query=第三轮期限届满文件&status=expired', {}, member).then((response) => response.json());
  assert.ok(browse.results.some((item) => item.document.title === '第三轮期限届满文件'));
});

test('增值税专题返回现行文件及可引用的条款，并将历史文件分开', async () => {
  const admin = await login('admin', 'admin-demo');
  const source = await request('/api/admin/sources', {}, admin).then((response) => response.json()).then((body) => body.sources[0]);
  const input = { title: '增值税专题测试法', authority: '国家税务总局', sourceId: source.id, officialUrl: 'https://fgk.chinatax.gov.cn/zcfgk/topic-vat/content.html', status: 'current', sections: [{ label: '第一条', text: '为规范增值税征收，制定本办法。' }, { label: '第三条', text: '销售货物的单位和个人为增值税纳税人。' }] };
  const candidate = await request('/api/admin/candidates', { method: 'POST', body: JSON.stringify(input) }, admin).then((response) => response.json()).then((body) => body.candidate);
  await request(`/api/admin/candidates/${candidate.id}/review`, { method: 'POST', body: JSON.stringify({ action: 'publish' }) }, admin);
  const member = await login('member', 'member-demo');
  const topic = await request('/api/topics/vat', {}, member).then((response) => response.json());
  const result = topic.current.find((item) => item.document.title === '增值税专题测试法');
  assert.ok(result);
  assert.equal(result.document.status, 'current');
  assert.ok(result.matchingSections.some((section) => section.label === '第三条'));
});

test('公开知识卡片无需登录即可按个人所得税及同义关键词查询', async () => {
  const taxTypes = await request('/api/knowledge/tax-types');
  assert.equal(taxTypes.status, 200);
  assert.ok((await taxTypes.json()).taxTypes.some((item) => item.label === '个人所得税'));

  const taxSearch = await request(`/api/knowledge/cards?query=${encodeURIComponent('个人所得税')}`);
  assert.equal(taxSearch.status, 200);
  const cards = (await taxSearch.json()).results.map((item) => item.card);
  assert.ok(cards.some((card) => card.topic === '工资薪金累计预扣'));
  assert.ok(cards.some((card) => card.topic === '综合所得年度汇算'));
  assert.ok(cards.some((card) => card.topic === '全年一次性奖金单独计税'));
  assert.ok(cards.some((card) => card.topic === '经营所得'));
  for (const card of cards.filter((item) => item.taxType === '个人所得税')) {
    assert.ok(card.formula);
    assert.ok(card.rateTable.length);
    assert.ok(card.officialBases.length);
    assert.equal(card.status, 'published');
  }
  const synonymSearch = await request(`/api/knowledge/cards?query=${encodeURIComponent('工资')}`);
  assert.ok((await synonymSearch.json()).results.some((item) => item.card.topic === '工资薪金累计预扣'));
  const bonusSearch = await request(`/api/knowledge/cards?query=${encodeURIComponent('年终奖')}`);
  assert.ok((await bonusSearch.json()).results.some((item) => item.card.topic === '全年一次性奖金单独计税'));
  const deductions = await request(`/api/knowledge/cards?query=${encodeURIComponent('业务招待费')}`);
  const deductionCard = (await deductions.json()).results.find((item) => item.card.topic === '常见费用税前扣除比例')?.card;
  assert.ok(deductionCard);
  assert.match(deductionCard.formula, /60%/);
  assert.ok(deductionCard.rateTable.some((row) => row.bracket === '职工福利费' && row.rate.includes('14%')));
});

test('知识卡片仅在管理员审核发布后公开，并支持版本回退', async () => {
  const admin = await login('admin', 'admin-demo');
  const input = {
    taxType: '测试税种', topic: '待审知识卡片', keywords: ['待审卡片'], formula: '应纳税额 = 计税依据 × 税率。',
    rateTable: [{ bracket: '测试级距', rate: '1%', quickDeduction: '0' }], conditions: ['仅用于接口测试。'],
    example: '计税依据 100 元，应纳税额 1 元。', effectiveAt: '2026-01-01',
    officialBases: [{ title: '测试官方依据', authority: '国家税务总局', url: 'https://www.chinatax.gov.cn/' }]
  };
  const created = await request('/api/admin/knowledge-card-candidates', { method: 'POST', body: JSON.stringify(input) }, admin);
  assert.equal(created.status, 201);
  const candidate = (await created.json()).candidate;
  const before = await request(`/api/knowledge/cards?query=${encodeURIComponent('待审卡片')}`);
  assert.equal((await before.json()).results.length, 0);

  const published = await request(`/api/admin/knowledge-card-candidates/${candidate.id}/review`, { method: 'POST', body: JSON.stringify({ action: 'publish' }) }, admin);
  assert.equal(published.status, 200);
  const card = (await published.json()).card;
  assert.equal(card.version, 1);
  const after = await request(`/api/knowledge/cards?query=${encodeURIComponent('待审卡片')}`);
  assert.equal((await after.json()).results.length, 1);

  const updateInput = { ...input, topic: '已更新知识卡片', replacesCardId: card.id };
  const updateCandidate = await request('/api/admin/knowledge-card-candidates', { method: 'POST', body: JSON.stringify(updateInput) }, admin).then((response) => response.json()).then((body) => body.candidate);
  const updated = await request(`/api/admin/knowledge-card-candidates/${updateCandidate.id}/review`, { method: 'POST', body: JSON.stringify({ action: 'publish' }) }, admin).then((response) => response.json());
  assert.equal(updated.card.version, 2);
  const rollback = await request(`/api/admin/knowledge-cards/${card.id}/rollback`, { method: 'POST', body: JSON.stringify({ version: 1 }) }, admin);
  assert.equal(rollback.status, 200);
  assert.equal((await rollback.json()).card.topic, '待审知识卡片');
});
