import { inflateRawSync } from 'node:zlib';

const TAX_TYPES = [
  '增值税', '企业所得税', '个人所得税', '消费税', '关税', '资源税', '环境保护税',
  '房产税', '城镇土地使用税', '土地增值税', '契税', '印花税', '车辆购置税', '车船税',
  '征收管理', '发票'
];

function decodeHtml(value = '') {
  return value.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

export function htmlToText(html = '') {
  return decodeHtml(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t\r]+/g, ' ')
    .replace(/\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normaliseUrl(href, baseUrl) {
  try {
    const url = new URL(href, baseUrl);
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function isChinaTaxPolicyUrl(url) {
  try {
    const parsed = new URL(url);
    return ['fgk.chinatax.gov.cn', 'www.chinatax.gov.cn'].includes(parsed.hostname) && parsed.pathname.startsWith('/zcfgk/');
  } catch {
    return false;
  }
}

const CHINA_TAX_CATALOG_URLS = [
  'https://fgk.chinatax.gov.cn/zcfgk/c100009/listflfg_fg.html',
  'https://fgk.chinatax.gov.cn/zcfgk/c100010/listflfg_fg.html',
  'https://fgk.chinatax.gov.cn/zcfgk/c102440/listflfg.html',
  'https://fgk.chinatax.gov.cn/zcfgk/c100011/list_guizhang.html',
  'https://fgk.chinatax.gov.cn/zcfgk/c102416/listflfg.html',
  'https://fgk.chinatax.gov.cn/zcfgk/c100012/listflfg.html',
  'https://fgk.chinatax.gov.cn/zcfgk/c100013/listflfg.html',
  'https://fgk.chinatax.gov.cn/zcfgk/c102424/listflfg.html'
];

function isListPage(url) {
  try {
    return /\/(?:list[^/]*|index(?:_\d+)?)\.html?(?:$|[?#])/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export function extractAnchors(html, baseUrl) {
  const anchors = [];
  const pattern = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    const url = normaliseUrl(match[1], baseUrl);
    if (url) anchors.push({ url, text: htmlToText(match[2]) });
  }
  return anchors;
}

export function classifyTaxTypes(text = '') {
  const matches = TAX_TYPES.filter((taxType) => text.includes(taxType));
  return matches.length ? matches : ['其他税收法规'];
}

export function inferStatus(text = '') {
  // 国家税务总局详情页会先给出“全文有效”等官方状态，随后才列出
  // 历次修订记录。先识别官方状态，避免把仍有效的现行文本误记为“已修订”。
  if (/全文有效|现行有效/.test(text)) return 'current';
  // “全文失效”是政策法规库中与“全文废止”并列的正式状态标识。
  // 这里只对页面页首的状态区域调用本函数，避免将正文里的引用误判为状态。
  if (/全文失效|全文废止|已废止|废止/.test(text)) return 'repealed';
  if (/已修改|已修订|修订/.test(text)) return 'revised';
  return 'pending_verification';
}

function dateValue(text) {
  const match = text.match(/(?:成文日期|发布日期|公布日期)[：:\s]*([12]\d{3})[年\-.](\d{1,2})[月\-.](\d{1,2})/);
  if (!match) return null;
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
}

function firstMatch(text, expression) {
  const value = text.match(expression)?.[1]?.replace(/\s+/g, ' ').trim();
  return value || '';
}

export function parsePolicyDocument(html, officialUrl, source) {
  const plainText = htmlToText(html);
  const annotationIndex = plainText.indexOf('注释');
  // 国家税务总局把当前文件的有效性放在“注释”之前，修订沿革通常在其后。
  // 只读取这一段，既能覆盖较长的页首信息，也不会把正文中提及的“废止”当作状态。
  const statusText = annotationIndex >= 0 ? plainText.slice(0, annotationIndex) : plainText.slice(0, 12_000);
  const printableText = annotationIndex >= 0 ? plainText.slice(annotationIndex + 2).split('【打印】')[0].trim() : plainText;
  const headings = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((match) => htmlToText(match[1]).replace(/\s+/g, ' ').trim()).filter((value) => value.length >= 4 && value.length <= 180);
  const pageTitle = htmlToText(firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i)).replace(/[_｜|].*$/, '').trim();
  const title = headings.find((value) => /(?:\u7a0e|\u6cd5|\u6761\u4f8b|\u516c\u544a|\u901a\u77e5|\u529e\u6cd5|\u89c4\u5b9a)/.test(value)) || (/(?:\u7a0e|\u6cd5|\u6761\u4f8b|\u516c\u544a|\u901a\u77e5|\u529e\u6cd5|\u89c4\u5b9a)/.test(pageTitle) ? pageTitle : '') || headings[0] || pageTitle;
  const sections = [];
  const articlePattern = /第[一二三四五六七八九十百千零〇0-9]+条[\s\S]*?(?=第[一二三四五六七八九十百千零〇0-9]+条|$)/g;
  let index = 0;
  for (const match of plainText.matchAll(articlePattern)) {
    const text = match[0].replace(/\s+/g, ' ').trim();
    const label = text.match(/^第[一二三四五六七八九十百千零〇0-9]+条/)?.[0] || `第${index + 1}段`;
    if (text.length > label.length + 2) sections.push({ label, text: text.slice(0, 1600) });
    if (sections.length >= 120) break;
    index += 1;
  }
  if (!sections.length && plainText) sections.push({ label: '正文摘录', text: plainText.slice(0, 3000) });
  if (!title || !sections.length) return null;
  const documentNumber = plainText.match(/(?:国家税务总局|财政部|国务院|主席令)[^\n]{0,45}?(?:第\s*\d+\s*号|〔\d{4}〕\d+号)/)?.[0]?.trim() || '';
  return {
    title,
    documentNumber,
    authority: source.authority,
    sourceId: source.id,
    officialUrl,
    publishedAt: dateValue(plainText),
    effectiveAt: null,
    // 税务总局页面有可机器读取的“全文有效/已废止/已修订”官方标记；
    // 财政部、人大和政府网的普通正文页通常没有统一状态标签，正文中
    // 提到“废止”并不等于该文件已废止，所以保留为待核验。
    status: /chinatax\.gov\.cn/.test(new URL(officialUrl).hostname) ? inferStatus(statusText) : 'pending_verification',
    taxTypes: classifyTaxTypes(`${title}\n${printableText.slice(0, 4000)}`),
    summary: printableText.slice(0, 220),
    relations: [],
    sections
  };
}

async function getText(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { 'user-agent': 'TaxPolicyKnowledgeBase/0.1 (official-source-review)' }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`采集请求失败：${response.status} ${url}`);
  return response.text();
}

async function getChinaTaxFileList(fetchImpl, channelId, page, size = 50) {
  const body = new URLSearchParams({ codeId: '', channelId, page: String(page), size: String(size), relateSubChannels: 'false' });
  const response = await fetchImpl('https://www.chinatax.gov.cn/getFileListByCodeId', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'user-agent': 'TaxPolicyKnowledgeBase/0.1 (official-source-review)' },
    body,
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`法规列表请求失败：${response.status}`);
  const payload = await response.json();
  const data = payload?.results?.data;
  if (!data || !Array.isArray(data.results)) throw new Error('法规列表响应格式不符合预期。');
  return data;
}

function channelIdFromPage(html) {
  return html.match(/var\s+channelId\s*=\s*["']([a-f0-9]{16,})["']/i)?.[1] || '';
}

function apiDocumentUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!isChinaTaxPolicyUrl(url.toString())) return null;
    url.protocol = 'https:';
    if (url.hostname === 'www.chinatax.gov.cn') url.hostname = 'fgk.chinatax.gov.cn';
    return url.toString();
  } catch {
    return null;
  }
}

export async function discoverChinaTaxPolicyUrls(source, { fetchImpl = fetch, maxListPages = 24 } = {}) {
  const rootUrl = source.collectionUrl || 'https://fgk.chinatax.gov.cn/zcfgk/index.html';
  if (!isChinaTaxPolicyUrl(rootUrl)) throw new Error('国家税务总局采集器只能访问政策法规库官方域名。');
  const configuredCatalogs = Array.isArray(source.catalogUrls) ? source.catalogUrls : CHINA_TAX_CATALOG_URLS;
  const queued = [...new Set([rootUrl, ...configuredCatalogs].filter(isChinaTaxPolicyUrl))];
  const visited = new Set();
  const detailUrls = new Set();
  const errors = [];
  let apiPagesScanned = 0;
  while (queued.length && visited.size + apiPagesScanned < maxListPages) {
    const listUrl = queued.shift();
    if (visited.has(listUrl)) continue;
    visited.add(listUrl);
    try {
      const html = await getText(fetchImpl, listUrl);
      for (const anchor of extractAnchors(html, listUrl)) {
        if (!isChinaTaxPolicyUrl(anchor.url)) continue;
        if (/\/content\.html(?:$|[?#])/.test(anchor.url)) detailUrls.add(anchor.url);
        if (isListPage(anchor.url) && !visited.has(anchor.url)) queued.push(anchor.url);
      }
      const channelId = channelIdFromPage(html);
      if (!channelId) continue;
      let page = 1;
      let totalPages = 1;
      while (page <= totalPages && visited.size + apiPagesScanned < maxListPages) {
        const data = await getChinaTaxFileList(fetchImpl, channelId, page);
        apiPagesScanned += 1;
        for (const item of data.results) {
          const detailUrl = apiDocumentUrl(item.url || item.redirectUrl);
          if (detailUrl) detailUrls.add(detailUrl);
        }
        totalPages = Math.ceil(Number(data.total || 0) / Number(data.rows || 50));
        page += 1;
      }
    } catch (error) {
      errors.push(error.message);
    }
  }
  return { detailUrls: [...detailUrls], scannedListPages: visited.size + apiPagesScanned, errors };
}

export async function fetchChinaTaxDocuments(source, detailUrls, { fetchImpl = fetch, concurrency = 3 } = {}) {
  const documents = [];
  const errors = [];
  const failures = [];
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < detailUrls.length) {
      const detailUrl = detailUrls[nextIndex];
      nextIndex += 1;
      try {
        const document = parsePolicyDocument(await getText(fetchImpl, detailUrl), detailUrl, source);
        if (document) documents.push(document);
      } catch (error) {
        errors.push(error.message);
        const status = Number(error.message.match(/：(\d{3})\s/)?.[1] || 0) || null;
        failures.push({ url: detailUrl, message: error.message, status });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(Number(concurrency) || 1, 1), detailUrls.length) }, worker));
  return { documents, errors, failures };
}

/**
 * 采集国家税务总局政策法规库。它会从入口页发现分类列表，再抓取列表中的
 * 详情链接；页面结构变化时会返回错误并记录在采集日志，而不是发布不完整资料。
 */
export async function collectChinaTaxLibrary(source, { fetchImpl = fetch, maxDocuments = 25, maxListPages = 24 } = {}) {
  const discovery = await discoverChinaTaxPolicyUrls(source, { fetchImpl, maxListPages });
  const fetched = await fetchChinaTaxDocuments(source, discovery.detailUrls.slice(0, maxDocuments), { fetchImpl });
  return { documents: fetched.documents, scannedListPages: discovery.scannedListPages, discoveredDetailUrls: discovery.detailUrls.length, errors: [...discovery.errors, ...fetched.errors] };
}

export async function discoverMofPolicyUrls(source, { fetchImpl = fetch, maxListPages = 24 } = {}) {
  const policyIndexUrl = 'https://szs.mof.gov.cn/zhengcefabu/';
  const urls = new Set();
  const errors = [];
  let pageCount = 1;
  const limit = Math.min(Math.max(Number(maxListPages) || 1, 1), 50);
  for (let page = 0; page < Math.min(pageCount, limit); page += 1) {
    const pageUrl = page === 0 ? policyIndexUrl : `${policyIndexUrl}index_${page}.htm`;
    try {
      const html = await getText(fetchImpl, pageUrl);
      if (page === 0) pageCount = Number(html.match(/var\s+countPage\s*=\s*(\d+)/)?.[1] || 1);
      for (const item of extractAnchors(html, pageUrl)) {
        // 财政部税政司目录本身就是税收政策目录，不能再按某一个税种过滤，
        // 否则会漏掉个人所得税、消费税、车船税、环保税等文件。
        if (/\.html?(?:$|[?#])/i.test(item.url) && !isListPage(item.url) && new URL(item.url).hostname.endsWith('mof.gov.cn') && item.text.length >= 6) urls.add(item.url);
      }
    } catch (error) { errors.push(error.message); }
  }
  return { detailUrls: [...urls], scannedListPages: Math.min(pageCount, limit), errors };
}

export async function collectMofVatSearch(source, { fetchImpl = fetch, maxDocuments = 25, maxListPages = 24 } = {}) {
  const discovery = await discoverMofPolicyUrls(source, { fetchImpl, maxListPages });
  const fetched = await fetchChinaTaxDocuments(source, discovery.detailUrls.slice(0, maxDocuments), { fetchImpl, concurrency: 2 });
  return { documents: fetched.documents, scannedListPages: discovery.scannedListPages, discoveredDetailUrls: discovery.detailUrls.length, errors: [...discovery.errors, ...fetched.errors] };
}

const GOV_POLICY_INDEX_URL = 'https://www.gov.cn/zhengce/zuixin/ZUIXINZHENGCE.json';
const NPC_SEARCH_URL = 'https://flk.npc.gov.cn/law-search/search/list';
const NPC_DETAIL_URL = 'https://flk.npc.gov.cn/law-search/search/flfgDetails';
const NPC_DOWNLOAD_URL = 'https://flk.npc.gov.cn/law-search/download/pc';
const TAX_POLICY_TITLE = /税|发票|关税|海关/;
const NPC_TAX_QUERIES = ['增值税', '企业所得税', '个人所得税', '消费税', '关税', '资源税', '环境保护税', '房产税', '城镇土地使用税', '土地增值税', '契税', '印花税', '车辆购置税', '车船税', '征收管理', '发票'];

function cleanTitle(value = '') {
  return String(value).replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').trim();
}

function npcDocumentUrl(bbbs) {
  return `https://flk.npc.gov.cn/detail?bbbs=${encodeURIComponent(bbbs)}`;
}

function npcBbbs(url) {
  try { return new URL(url).searchParams.get('bbbs') || ''; } catch { return ''; }
}

export async function discoverGovPolicyUrls(source, { fetchImpl = fetch } = {}) {
  const errors = [];
  try {
    const response = await fetchImpl(source.collectionUrl || GOV_POLICY_INDEX_URL, {
      headers: { 'user-agent': 'TaxPolicyKnowledgeBase/0.1 (official-source-review)' },
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) throw new Error(`中国政府网目录请求失败：${response.status}`);
    const items = JSON.parse(await response.text());
    const detailUrls = [...new Set(items
      .filter((item) => TAX_POLICY_TITLE.test(`${item.TITLE || ''} ${item.SUB_TITLE || ''}`))
      .map((item) => normaliseUrl(item.URL, 'https://www.gov.cn/'))
      .filter((url) => url && new URL(url).hostname.endsWith('gov.cn')))
    ];
    return { detailUrls, scannedListPages: 1, errors };
  } catch (error) {
    errors.push(error.message);
    return { detailUrls: [], scannedListPages: 1, errors };
  }
}

export async function collectGovPolicyLibrary(source, { fetchImpl = fetch, maxDocuments = 25 } = {}) {
  const discovery = await discoverGovPolicyUrls(source, { fetchImpl });
  const fetched = await fetchChinaTaxDocuments(source, discovery.detailUrls.slice(0, maxDocuments), { fetchImpl, concurrency: 2 });
  return { documents: fetched.documents, scannedListPages: discovery.scannedListPages, discoveredDetailUrls: discovery.detailUrls.length, errors: [...discovery.errors, ...fetched.errors] };
}

async function npcJson(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, {
    ...options,
    headers: { 'content-type': 'application/json;charset=utf-8', 'user-agent': 'TaxPolicyKnowledgeBase/0.1 (official-source-review)', ...(options.headers || {}) },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`国家法律法规数据库请求失败：${response.status}`);
  return response.json();
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function discoverNpcPolicyUrls(source, { fetchImpl = fetch, maxListPages = 120 } = {}) {
  const detailUrls = new Set();
  const errors = [];
  let scannedListPages = 0;
  const maxPages = Math.max(Number(maxListPages) || 1, 1);
  for (const searchContent of NPC_TAX_QUERIES) {
    if (scannedListPages >= maxPages) break;
    try {
      const payload = { searchRange: 1, sxrq: [], gbrq: [], searchType: 2, sxx: [], gbrqYear: [], flfgCodeId: [], zdjgCodeId: [], searchContent, pageNum: 1, pageSize: 100 };
      const result = await npcJson(fetchImpl, NPC_SEARCH_URL, { method: 'POST', body: JSON.stringify(payload) });
      scannedListPages += 1;
      if (result.code !== 200 || !Array.isArray(result.rows)) throw new Error(`国家法律法规数据库检索“${searchContent}”未返回有效目录`);
      for (const row of result.rows) {
        const title = cleanTitle(row.title || '');
        const isCentral = /全国人民代表大会|国务院/.test(row.zdjgName || '');
        if (row.bbbs && isCentral && TAX_POLICY_TITLE.test(title)) detailUrls.add(npcDocumentUrl(row.bbbs));
      }
    } catch (error) { errors.push(error.message); }
  }
  return { detailUrls: [...detailUrls], scannedListPages, errors };
}

function zipEntry(buffer, expectedName) {
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset -= 1) {
    if (buffer.readUInt32LE(offset) !== 0x06054b50) continue;
    const size = buffer.readUInt32LE(offset + 12);
    let cursor = buffer.readUInt32LE(offset + 16);
    const end = cursor + size;
    while (cursor < end && buffer.readUInt32LE(cursor) === 0x02014b50) {
      const compressedSize = buffer.readUInt32LE(cursor + 20);
      const fileNameLength = buffer.readUInt16LE(cursor + 28);
      const extraLength = buffer.readUInt16LE(cursor + 30);
      const commentLength = buffer.readUInt16LE(cursor + 32);
      const method = buffer.readUInt16LE(cursor + 10);
      const localOffset = buffer.readUInt32LE(cursor + 42);
      const name = buffer.subarray(cursor + 46, cursor + 46 + fileNameLength).toString('utf8');
      if (name === expectedName) {
        if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('DOCX 文件结构不完整');
        const localNameLength = buffer.readUInt16LE(localOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localOffset + 28);
        const body = buffer.subarray(localOffset + 30 + localNameLength + localExtraLength, localOffset + 30 + localNameLength + localExtraLength + compressedSize);
        return method === 8 ? inflateRawSync(body).toString('utf8') : body.toString('utf8');
      }
      cursor += 46 + fileNameLength + extraLength + commentLength;
    }
  }
  throw new Error('DOCX 中未找到正文');
}

function docxToText(buffer) {
  const xml = zipEntry(Buffer.from(buffer), 'word/document.xml');
  return decodeHtml(xml
    .replace(/<w:tab\/?\s*\/>/g, ' ')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\r/g, ''))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function npcSections(text) {
  const sections = [];
  const articlePattern = /第[一二三四五六七八九十百千万零〇0-9]+条[\s\S]*?(?=第[一二三四五六七八九十百千万零〇0-9]+条|$)/g;
  for (const match of text.matchAll(articlePattern)) {
    const value = match[0].replace(/\s+/g, ' ').trim();
    const label = value.match(/^第[一二三四五六七八九十百千万零〇0-9]+条/)?.[0] || '条款正文';
    if (value.length > label.length + 2) sections.push({ label, text: value.slice(0, 1600) });
    if (sections.length >= 120) break;
  }
  return sections.length ? sections : [{ label: '正文摘录', text: text.slice(0, 3000) }];
}

export async function fetchNpcDocuments(source, detailUrls, { fetchImpl = fetch, concurrency = 2 } = {}) {
  const documents = [];
  const errors = [];
  const failures = [];
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < detailUrls.length) {
      const officialUrl = detailUrls[nextIndex];
      nextIndex += 1;
      try {
        const bbbs = npcBbbs(officialUrl);
        if (!bbbs) throw new Error('国家法律法规数据库条目编号缺失');
        // 该官方站点会在短时间连续读取时主动断开连接。单条读取并仅对网络中断重试一次，
        // 避免把临时网络问题误记成法规不存在。
        let detail;
        try {
          detail = await npcJson(fetchImpl, `${NPC_DETAIL_URL}?bbbs=${encodeURIComponent(bbbs)}`);
        } catch (error) {
          if (error.message !== 'fetch failed') throw error;
          await wait(1_500);
          detail = await npcJson(fetchImpl, `${NPC_DETAIL_URL}?bbbs=${encodeURIComponent(bbbs)}`);
        }
        if (detail.code !== 200 || !detail.data?.title) throw new Error('国家法律法规数据库未返回法规详情');
        const download = await npcJson(fetchImpl, `${NPC_DOWNLOAD_URL}?bbbs=${encodeURIComponent(bbbs)}&format=docx`);
        if (download.code !== 200 || !download.data?.url) throw new Error('国家法律法规数据库未返回原文下载地址');
        const fileResponse = await fetchImpl(download.data.url, { headers: { 'user-agent': 'TaxPolicyKnowledgeBase/0.1 (official-source-review)' }, signal: AbortSignal.timeout(20_000) });
        if (!fileResponse.ok) throw new Error(`国家法律法规数据库原文下载失败：${fileResponse.status}`);
        const text = docxToText(await fileResponse.arrayBuffer());
        const title = cleanTitle(detail.data.title);
        const status = /（失效|已废止|废止）/.test(title) ? 'repealed' : detail.data.sxx === 3 ? 'current' : 'pending_verification';
        documents.push({
          title,
          documentNumber: '',
          authority: detail.data.zdjgName || source.authority,
          sourceId: source.id,
          officialUrl,
          publishedAt: detail.data.gbrq || null,
          effectiveAt: detail.data.sxrq || null,
          status,
          taxTypes: classifyTaxTypes(`${title}\n${text.slice(0, 4000)}`),
          summary: text.slice(0, 220),
          relations: [],
          sections: npcSections(text)
        });
      } catch (error) {
        errors.push(error.message);
        failures.push({ url: officialUrl, message: error.message, status: null });
      }
      await wait(700);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(Number(concurrency) || 1, 1), detailUrls.length) }, worker));
  return { documents, errors, failures };
}

export async function collectNpcLawLibrary(source, { fetchImpl = fetch, maxDocuments = 25, maxListPages = 120 } = {}) {
  const discovery = await discoverNpcPolicyUrls(source, { fetchImpl, maxListPages });
  const fetched = await fetchNpcDocuments(source, discovery.detailUrls.slice(0, maxDocuments), { fetchImpl });
  return { documents: fetched.documents, scannedListPages: discovery.scannedListPages, discoveredDetailUrls: discovery.detailUrls.length, errors: [...discovery.errors, ...fetched.errors] };
}

function sourceCollector(source) {
  if (source.collector) return source.collector;
  if (source.url.includes('fgk.chinatax.gov.cn')) return 'chinatax-library';
  if (source.url.includes('mof.gov.cn')) return 'mof-vat-search';
  if (source.url.includes('gov.cn/zhengce')) return 'gov-policy-library';
  if (source.url.includes('npc.gov.cn')) return 'npc-law-library';
  return '';
}

export async function discoverOfficialPolicyUrls(source, options = {}) {
  const collector = sourceCollector(source);
  if (collector === 'chinatax-library') return discoverChinaTaxPolicyUrls(source, options);
  if (collector === 'mof-vat-search') return discoverMofPolicyUrls(source, options);
  if (collector === 'gov-policy-library') return discoverGovPolicyUrls(source, options);
  if (collector === 'npc-law-library') return discoverNpcPolicyUrls(source, options);
  throw new Error(`来源“${source.name}”尚未配置采集器。`);
}

export async function fetchOfficialDocuments(source, detailUrls, options = {}) {
  const collector = sourceCollector(source);
  if (collector === 'npc-law-library') return fetchNpcDocuments(source, detailUrls, options);
  return fetchChinaTaxDocuments(source, detailUrls, options);
}

export async function collectOfficialSource(source, options = {}) {
  const collector = sourceCollector(source);
  if (collector === 'chinatax-library') return collectChinaTaxLibrary(source, options);
  if (collector === 'mof-vat-search') return collectMofVatSearch(source, options);
  if (collector === 'gov-policy-library') return collectGovPolicyLibrary(source, options);
  if (collector === 'npc-law-library') return collectNpcLawLibrary(source, options);
  throw new Error(`来源“${source.name}”尚未配置采集器。`);
}
