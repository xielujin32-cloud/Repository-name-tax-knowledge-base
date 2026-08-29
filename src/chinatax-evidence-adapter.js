import { extractAnchors, htmlToText } from './collector.js';

const POLICY_HOSTS = new Set(['fgk.chinatax.gov.cn', 'www.chinatax.gov.cn']);
const LIST_API_URL = 'https://www.chinatax.gov.cn/getFileListByCodeId';
const USER_AGENT = 'TaxPolicyKnowledgeBase/0.2 (source-discovery-dry-run)';

export const CHINA_TAX_POLICY_SOURCE = Object.freeze({
  source_id: 'source-sta-policy-regulations',
  source_name: '国家税务总局政策法规库',
  official_domain: 'fgk.chinatax.gov.cn',
  source_type: 'official_policy_library',
  adapter_version: '2.0.0-phase2a',
  collection_url: 'https://fgk.chinatax.gov.cn/zcfgk/c100027/list.html'
});

function validDate(value) {
  const match = String(value || '').match(/([12]\d{3})[年\-\/.](\d{1,2})[月\-\/.](\d{1,2})/);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function cleanText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text || null;
}

function titleFromListFragment(fragment) {
  // The official "最新政策文件" list places sequence number, title, document
  // number and date inside one <a>. Prefer its explicitly labelled bt column.
  const titleHtml = String(fragment || '').match(/<p\b[^>]*\bclass\s*=\s*["'][^"']*\bbt\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1];
  return cleanText(titleHtml ? htmlToText(titleHtml) : '');
}

function contentPage(url) {
  try {
    return /\/content\.html(?:$|[?#])/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * A candidate official document URL must stay inside the State Taxation
 * Administration's regulations library. The list API itself is intentionally
 * not accepted here because it is not a document URL.
 */
export function normalizeChinaTaxPolicyUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!POLICY_HOSTS.has(url.hostname) || !url.pathname.startsWith('/zcfgk/') || !contentPage(url)) return null;
    url.protocol = 'https:';
    if (url.hostname === 'www.chinatax.gov.cn') url.hostname = 'fgk.chinatax.gov.cn';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export function isChinaTaxPolicyUrl(value) {
  return Boolean(normalizeChinaTaxPolicyUrl(value));
}

function channelIdFromPage(html) {
  return String(html || '').match(/var\s+channelId\s*=\s*["']([a-f0-9]{16,})["']/i)?.[1] || null;
}

function mergeRecords(records) {
  const byUrl = new Map();
  for (const record of records) {
    if (!record?.official_url) continue;
    const existing = byUrl.get(record.official_url);
    byUrl.set(record.official_url, {
      official_url: record.official_url,
      // Keep the first record's fields so the API (placed first by dry-run)
      // remains authoritative when the HTML list repeats the same link.
      title: existing?.title || cleanText(record.title) || null,
      publish_date: existing?.publish_date || record.publish_date || null,
      discovery_method: existing
        ? [...new Set(`${existing.discovery_method}+${record.discovery_method}`.split('+'))].join('+')
        : record.discovery_method
    });
  }
  return [...byUrl.values()];
}

/** Parse only information visibly supplied by a regulations-library list page. */
export function parseChinaTaxListPageRecords(html, listUrl) {
  const records = [];
  const fragments = [...String(html || '').matchAll(/<(?:li|tr)\b[^>]*>[\s\S]*?<\/(?:li|tr)>/gi)].map((match) => match[0]);
  for (const fragment of fragments) {
    const listedDate = validDate(htmlToText(fragment));
    const listedTitle = titleFromListFragment(fragment);
    for (const anchor of extractAnchors(fragment, listUrl)) {
      const officialUrl = normalizeChinaTaxPolicyUrl(anchor.url);
      if (officialUrl) records.push({ official_url: officialUrl, title: listedTitle || cleanText(anchor.text), publish_date: listedDate, discovery_method: 'official-list-page' });
    }
  }
  for (const anchor of extractAnchors(html, listUrl)) {
    const officialUrl = normalizeChinaTaxPolicyUrl(anchor.url);
    if (officialUrl) records.push({ official_url: officialUrl, title: cleanText(anchor.text), publish_date: null, discovery_method: 'official-list-page' });
  }
  return mergeRecords(records);
}

function listItemTitle(item) {
  // These fields are read only when the official list response labels them as a title.
  return cleanText(item?.title) || cleanText(item?.documentTitle) || cleanText(item?.fileTitle) || null;
}

function listItemDate(item) {
  return validDate(item?.publishDate) || validDate(item?.publishedAt) || validDate(item?.publish_date) || validDate(item?.date) || null;
}

export function parseChinaTaxListApiPayload(payload) {
  const data = payload?.results?.data;
  if (!data || !Array.isArray(data.results)) throw new Error('国家税务总局法规列表响应格式不符合预期。');
  const records = data.results.map((item) => ({
    official_url: normalizeChinaTaxPolicyUrl(item?.url || item?.redirectUrl),
    title: listItemTitle(item),
    publish_date: listItemDate(item),
    discovery_method: 'official-list-api'
  }));
  return { records: mergeRecords(records), page: Number(data.page) || null, rows: Number(data.rows) || null, total: Number(data.total) || null };
}

async function fetchListPage(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`国家税务总局法规目录请求失败：${response.status}`);
  return response.text();
}

async function fetchListApi(fetchImpl, channelId) {
  const body = new URLSearchParams({ codeId: '', channelId, page: '1', size: '5', relateSubChannels: 'false' });
  const response = await fetchImpl(LIST_API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'user-agent': USER_AGENT },
    body,
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`国家税务总局法规列表接口请求失败：${response.status}`);
  return response.json();
}

/**
 * Reads one official listing page and, when present, one official list API page.
 * It never requests a /content.html page, records a snapshot, creates a
 * candidate, or writes to any repository/Blob store.
 */
export async function discoverChinaTaxPolicyDryRun({ fetchImpl = fetch, source = CHINA_TAX_POLICY_SOURCE, limit = 5 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 5, 1), 5);
  const collectionUrl = source.collection_url || CHINA_TAX_POLICY_SOURCE.collection_url;
  const collectionPage = new URL(collectionUrl);
  if (!POLICY_HOSTS.has(collectionPage.hostname) || !collectionPage.pathname.startsWith('/zcfgk/')) {
    throw new Error('国家税务总局 discovery 入口必须是政策法规库官方地址。');
  }

  const html = await fetchListPage(fetchImpl, collectionUrl);
  const pageRecords = parseChinaTaxListPageRecords(html, collectionUrl);
  const channelId = channelIdFromPage(html);
  let apiRecords = [];
  let listApiUsed = false;
  if (channelId) {
    const payload = await fetchListApi(fetchImpl, channelId);
    apiRecords = parseChinaTaxListApiPayload(payload).records;
    listApiUsed = true;
  }

  // The API keeps its official ordering; list-page entries fill only missing URLs.
  const records = mergeRecords([...apiRecords, ...pageRecords]).slice(0, safeLimit);
  return Object.freeze({
    mode: 'dry-run',
    source: Object.freeze({ ...source, collection_url: collectionUrl }),
    discovery: Object.freeze({ collection_page: collectionUrl, list_api_used: listApiUsed, channel_id_found: Boolean(channelId), detail_pages_requested: 0 }),
    candidates: Object.freeze(records.map((record) => Object.freeze({ ...record, source_id: source.source_id, source_name: source.source_name, official_domain: source.official_domain }))),
    writes: Object.freeze({ raw_snapshots: 0, candidates: 0, policies: 0, netlify_blobs: 0 })
  });
}
