import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverChinaTaxPolicyDryRun, isChinaTaxPolicyUrl, normalizeChinaTaxPolicyUrl, parseChinaTaxListApiPayload, parseChinaTaxListPageRecords } from '../src/chinatax-evidence-adapter.js';

const listUrl = 'https://fgk.chinatax.gov.cn/zcfgk/c100027/list.html';
const listHtml = `
  <script>var channelId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";</script>
  <ul>
    <li><a href="a/content.html"><p class="xh">1</p><p class="bt">目录文件甲</p><p class="fwzh">税总公告 1 号</p><span>2026-08-28</span></a></li>
    <li><a href="https://example.test/content.html">非官方文件</a><span>2026-08-27</span></li>
  </ul>`;

test('国家税务总局 discovery 只接受法规库官方详情 URL', () => {
  assert.equal(isChinaTaxPolicyUrl('https://fgk.chinatax.gov.cn/zcfgk/c1/content.html'), true);
  assert.equal(normalizeChinaTaxPolicyUrl('http://www.chinatax.gov.cn/zcfgk/c1/content.html'), 'https://fgk.chinatax.gov.cn/zcfgk/c1/content.html');
  assert.equal(isChinaTaxPolicyUrl('https://www.chinatax.gov.cn/not-policy/content.html'), false);
  assert.equal(isChinaTaxPolicyUrl('https://example.test/zcfgk/c1/content.html'), false);
});

test('官方列表页面只解析可追溯的链接标题与列表中明确给出的日期', () => {
  const records = parseChinaTaxListPageRecords(listHtml, listUrl);
  assert.deepEqual(records, [{
    official_url: 'https://fgk.chinatax.gov.cn/zcfgk/c100027/a/content.html',
    title: '目录文件甲', publish_date: '2026-08-28', discovery_method: 'official-list-page'
  }]);
});

test('官方列表 API 只保留其明确返回的标题、日期和法规库 URL', () => {
  const payload = { results: { data: { page: 1, rows: 5, total: 9, results: [
    { title: 'API 文件甲', url: 'http://www.chinatax.gov.cn/zcfgk/c100027/a/content.html', publishDate: '2026-08-29' },
    { title: '第三方文件', url: 'https://example.test/content.html', publishDate: '2026-08-28' }
  ] } } };
  const parsed = parseChinaTaxListApiPayload(payload);
  assert.deepEqual(parsed.records, [{
    official_url: 'https://fgk.chinatax.gov.cn/zcfgk/c100027/a/content.html',
    title: 'API 文件甲', publish_date: '2026-08-29', discovery_method: 'official-list-api'
  }]);
  assert.equal(parsed.total, 9);
});

test('dry-run 在受限分页内发现官方候选，不请求详情页，也不写入任何存储', async () => {
  const calls = [];
  async function fakeFetch(url, options = {}) {
    calls.push({ url: String(url), method: options.method || 'GET' });
    if (String(url) === listUrl) return { ok: true, text: async () => listHtml };
    if (String(url) === 'https://www.chinatax.gov.cn/getFileListByCodeId') {
      assert.equal(options.body.get('channelId'), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      const payload = { results: { data: { page: 1, rows: 5, total: 6, results: [
        { title: 'API 文件甲', url: 'https://fgk.chinatax.gov.cn/zcfgk/c100027/a/content.html', publishDate: '2026-08-29' },
        { title: 'API 文件乙', url: 'https://fgk.chinatax.gov.cn/zcfgk/c100027/b/content.html', publishDate: '2026-08-28' },
        { title: 'API 文件丙', url: 'https://fgk.chinatax.gov.cn/zcfgk/c100027/c/content.html', publishDate: '2026-08-27' },
        { title: 'API 文件丁', url: 'https://fgk.chinatax.gov.cn/zcfgk/c100027/d/content.html', publishDate: '2026-08-26' },
        { title: 'API 文件戊', url: 'https://fgk.chinatax.gov.cn/zcfgk/c100027/e/content.html', publishDate: '2026-08-25' },
        { title: 'API 文件己', url: 'https://fgk.chinatax.gov.cn/zcfgk/c100027/f/content.html', publishDate: '2026-08-24' }
      ] } } };
      return { ok: true, json: async () => payload };
    }
    throw new Error(`不应请求：${url}`);
  }
  const result = await discoverChinaTaxPolicyDryRun({ fetchImpl: fakeFetch, limit: 99 });
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.candidates.length, 6);
  assert.equal(result.candidates[0].title, 'API 文件甲');
  assert.equal(result.candidates[0].publish_date, '2026-08-29');
  assert.ok(result.candidates.every((candidate) => candidate.official_url.startsWith('https://fgk.chinatax.gov.cn/zcfgk/')));
  assert.equal(result.discovery.detail_pages_requested, 0);
  assert.equal(result.discovery.page_size, 10);
  assert.equal(result.discovery.api_pages_requested, 1);
  assert.deepEqual(result.writes, { raw_snapshots: 0, candidates: 0, policies: 0, netlify_blobs: 0 });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => !call.url.includes('/content.html')));
});

test('dry-run 在上限内请求多页官方目录，并在到达 limit 后停止', async () => {
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url: String(url), page: options.body?.get?.('page') || null });
    if (String(url) === listUrl) return { ok: true, text: async () => listHtml };
    const page = Number(options.body.get('page'));
    const results = page === 1
      ? [{ title: '第一页甲', url: 'https://fgk.chinatax.gov.cn/zcfgk/c100027/one/content.html', publishDate: '2026-09-01' }, { title: '第一页乙', url: 'https://fgk.chinatax.gov.cn/zcfgk/c100027/two/content.html', publishDate: '2026-08-31' }]
      : [{ title: '第二页甲', url: 'https://fgk.chinatax.gov.cn/zcfgk/c100027/three/content.html', publishDate: '2026-08-30' }, { title: '第二页乙', url: 'https://fgk.chinatax.gov.cn/zcfgk/c100027/four/content.html', publishDate: '2026-08-29' }];
    return { ok: true, json: async () => ({ results: { data: { page, rows: 2, total: 4, results } } }) };
  };
  const result = await discoverChinaTaxPolicyDryRun({ fetchImpl: fakeFetch, limit: 3, pageSize: 2, maxPages: 5 });
  assert.equal(result.candidates.length, 3);
  assert.equal(result.discovery.api_pages_requested, 2);
  assert.equal(result.discovery.detail_pages_requested, 0);
  assert.deepEqual(calls.map((item) => item.page).filter(Boolean), ['1', '2']);
});
