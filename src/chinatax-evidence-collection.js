import { htmlToText } from './collector.js';
import { CHINA_TAX_POLICY_SOURCE, normalizeChinaTaxPolicyUrl } from './chinatax-evidence-adapter.js';

const DETAIL_USER_AGENT = 'TaxPolicyKnowledgeBase/0.2 (phase2b-evidence-collection)';

// This Phase 2B collector is deliberately allow-listed. It cannot be pointed at
// the legacy dataset, a search result, or another official/third-party URL.
export const PHASE_2B_ALLOWED_DETAIL_URLS = Object.freeze([
  'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5252027/content.html',
  'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5252024/content.html'
]);

const AUTHORITY_NAMES = Object.freeze(['国家税务总局', '财政部', '税务总局', '中国证监会', '海关总署', '国务院']);

function clean(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text || null;
}

function dateOnly(value) {
  const match = String(value || '').match(/([12]\d{3})[年\-\/.](\d{1,2})[月\-\/.](\d{1,2})/);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function textFromFirst(html, pattern) {
  return clean(htmlToText(String(html || '').match(pattern)?.[1] || ''));
}

function attributeValue(openTag, attribute) {
  const match = String(openTag || '').match(new RegExp(`\\b${attribute}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'));
  return match?.[2] || '';
}

/**
 * Returns the outer HTML of the first element that has every requested class.
 * This deliberately walks matching start/end tags rather than relying on a
 * non-nesting-safe regular expression: China Tax's article container contains
 * links, inline elements and nested divs.
 */
function elementWithClasses(html, requiredClasses) {
  const source = String(html || '');
  const opening = /<([a-z][\w:-]*)\b[^>]*>/gi;
  let match;
  while ((match = opening.exec(source))) {
    const classes = attributeValue(match[0], 'class').split(/\s+/).filter(Boolean);
    if (!requiredClasses.every((value) => classes.includes(value))) continue;
    const tag = match[1].toLowerCase();
    const pair = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi');
    pair.lastIndex = match.index;
    let depth = 0;
    let part;
    while ((part = pair.exec(source))) {
      const isClosing = /^<\//.test(part[0]);
      if (!isClosing) depth += 1;
      else depth -= 1;
      if (depth === 0) return source.slice(match.index, pair.lastIndex);
    }
    return null;
  }
  return null;
}

function firstTagElement(html, tagName) {
  const source = String(html || '');
  const match = new RegExp(`<${tagName}\\b[^>]*>`, 'i').exec(source);
  if (!match) return null;
  const closing = new RegExp(`</${tagName}\\s*>`, 'ig');
  closing.lastIndex = match.index + match[0].length;
  const end = closing.exec(source);
  return end ? source.slice(match.index, closing.lastIndex) : null;
}

function metaContent(html, name) {
  const tags = String(html || '').match(/<meta\b[^>]*>/gi) || [];
  const target = String(name).toLowerCase();
  const tag = tags.find((value) => attributeValue(value, 'name').toLowerCase() === target);
  return tag ? attributeValue(tag, 'content') : null;
}

/**
 * The policy-regulations detail template keeps document prose in
 * .article > .arc_cont. The surrounding page is a site shell (header, search
 * hotwords, account controls, sharing tools and related-content panels), and
 * must never be converted into official policy text.
 */
export function extractChinaTaxPolicyBodyHtml(html) {
  const primary = elementWithClasses(html, ['arc_cont']);
  if (primary) return primary;

  // Conservative structural fallbacks for official detail-template revisions.
  // Do not fall back to the entire <body>, because that reintroduces website
  // navigation into a legal document's normalized text.
  return elementWithClasses(html, ['TRS_Editor'])
    || elementWithClasses(html, ['article-content'])
    || elementWithClasses(html, ['article_content'])
    || firstTagElement(html, 'article')
    || null;
}

function documentDetailHtml(html) {
  return elementWithClasses(html, ['detials', 'contentLeft']) || String(html || '');
}

function policyText(html) {
  return htmlToText(html)
    .replace(/&(ensp|emsp|thinsp);/gi, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .trim();
}

function titleFromDetail(html) {
  const detailHtml = documentDetailHtml(html);
  const heading = textFromFirst(detailHtml, /<h3\b[^>]*>([\s\S]*?)<\/h3>/i);
  if (heading) return heading;
  const metaTitle = clean(metaContent(html, 'ArticleTitle'));
  if (metaTitle) return metaTitle;
  const headings = [...detailHtml.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
    .map((match) => clean(htmlToText(match[1])))
    .filter(Boolean);
  // A site heading such as “国家税务总局政策法规库” is not a document
  // title. Require a formal-document marker before selecting a heading.
  const policyTitle = headings.find((heading) => /关于|公告|通知|办法|规定|条例|(?:^|\s)法(?:$|\s)/.test(heading));
  const pageTitle = textFromFirst(detailHtml, /<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return policyTitle || (pageTitle && /税|法|条例|公告|通知|办法|规定/.test(pageTitle) ? pageTitle : null) || headings[0] || pageTitle;
}

function documentNoFromText(text) {
  // Only retain an actual document-number literal visible in the official page.
  const authority = '(?:国家税务总局|财政部|税务总局|中国证监会|海关总署|国务院)';
  const expression = new RegExp(`(?:${authority})(?:[、，,\\s]+${authority})*\\s*(?:公告|令|通知|决定)\\s*(?:〔\\d{4}〕\\d+号|\\d{4}年第\\d+号|第\\d+号)`);
  return clean(String(text || '').match(expression)?.[0]);
}

function authoritiesFromDocumentNo(documentNo) {
  if (!documentNo) return [];
  const prefix = documentNo.split(/公告|令|通知|决定/)[0] || '';
  return [...new Set(AUTHORITY_NAMES.filter((authority) => prefix.includes(authority)))];
}

function labelledDate(text, labels) {
  const label = labels.join('|');
  const match = String(text || '').match(new RegExp(`(?:${label})[：:\\s]*([12]\\d{3}[年\\-\\/.]\\d{1,2}[月\\-\\/.]\\d{1,2})`));
  return dateOnly(match?.[1]);
}

function effectiveDateFromText(text) {
  const match = String(text || '').match(/自\s*([12]\d{3}[年\-\/.]\d{1,2}[月\-\/.]\d{1,2})日?\s*(?:起)?施行/);
  return dateOnly(match?.[1]);
}

function expiryDateFromText(text) {
  const match = String(text || '').match(/本(?:公告|通知|办法|规定|文件)[^。\n]{0,100}?(?:执行|施行|有效)至\s*([12]\d{3}[年\-\/.]\d{1,2}[月\-\/.]\d{1,2})/);
  return dateOnly(match?.[1]);
}

function headersSubset(headers) {
  const keys = ['content-type', 'etag', 'last-modified', 'content-length', 'date'];
  const subset = {};
  for (const key of keys) {
    const value = typeof headers?.get === 'function' ? headers.get(key) : headers?.[key];
    if (value) subset[key] = String(value);
  }
  return subset;
}

function allowedUrl(value) {
  const normalized = normalizeChinaTaxPolicyUrl(value);
  if (!normalized || !PHASE_2B_ALLOWED_DETAIL_URLS.includes(normalized)) {
    throw new Error('Phase 2B 只允许读取已确认的两条国家税务总局官方详情 URL。');
  }
  return normalized;
}

export function parseChinaTaxPolicyEvidence(html) {
  const bodyHtml = extractChinaTaxPolicyBodyHtml(html);
  if (!bodyHtml) throw new Error('国家税务总局详情页未找到受支持的政策正文容器。');
  const normalizedText = policyText(bodyHtml);
  const detailText = htmlToText(documentDetailHtml(html));
  const documentNo = textFromFirst(documentDetailHtml(html), /<h5\b[^>]*\bclass\s*=\s*["'][^"']*\bactfwzh\b[^"']*["'][^>]*>([\s\S]*?)<\/h5>/i)
    || documentNoFromText(detailText);
  const publishedMeta = dateOnly(metaContent(html, 'PubDate'));
  return Object.freeze({
    title: titleFromDetail(html),
    document_no: documentNo,
    issuing_authority: authoritiesFromDocumentNo(documentNo),
    // The template's PubDate can be the CMS page-generation time. A labelled
    // document date shown in the official detail area is stronger evidence.
    publish_date: labelledDate(detailText, ['发布日期', '发布时间', '成文日期', '发文日期']) || publishedMeta,
    effective_date: effectiveDateFromText(normalizedText),
    expiry_date: expiryDateFromText(normalizedText),
    normalized_text: normalizedText,
    // A future legal-status adapter may propose a state from a structured page
    // marker. Phase 2B deliberately does not draw a legal conclusion.
    legal_status: 'pending',
    verification_state: 'pending_review'
  });
}

async function fetchOfficialDetail(fetchImpl, officialUrl) {
  const response = await fetchImpl(officialUrl, {
    headers: { 'user-agent': DETAIL_USER_AGENT },
    signal: AbortSignal.timeout(20_000)
  });
  const rawHtml = await response.text();
  if (!response.ok) throw new Error(`国家税务总局政策详情请求失败：${response.status}`);
  return {
    http_status: response.status,
    response_headers_subset: headersSubset(response.headers),
    content_type: response.headers?.get?.('content-type') || 'text/html',
    raw_html: rawHtml
  };
}

export function addChinaTaxPolicySource(repository) {
  return repository.addSource({
    source_id: CHINA_TAX_POLICY_SOURCE.source_id,
    source_name: CHINA_TAX_POLICY_SOURCE.source_name,
    official_domain: CHINA_TAX_POLICY_SOURCE.official_domain,
    source_type: CHINA_TAX_POLICY_SOURCE.source_type,
    adapter_version: '2.0.0-phase2b',
    base_url: CHINA_TAX_POLICY_SOURCE.collection_url
  });
}

/**
 * Fetches only the two Phase 2B allow-listed official pages into the supplied
 * local evidence repository. It has no Netlify/Blob imports and creates no
 * policy or policy version.
 */
export async function collectPhase2BDetails({ repository, source_id = CHINA_TAX_POLICY_SOURCE.source_id, fetchImpl = fetch, urls = PHASE_2B_ALLOWED_DETAIL_URLS } = {}) {
  if (!repository) throw new Error('Phase 2B 必须提供 evidence repository。');
  const selectedUrls = [...new Set(urls.map(allowedUrl))];
  if (selectedUrls.length !== PHASE_2B_ALLOWED_DETAIL_URLS.length || selectedUrls.some((url) => !PHASE_2B_ALLOWED_DETAIL_URLS.includes(url))) {
    throw new Error('Phase 2B 必须且只能处理两条已确认的官方详情 URL。');
  }
  const run = repository.createCollectionRun({ source_id, mode: 'manual-phase2b' });
  const results = [];
  try {
    for (const officialUrl of selectedUrls) {
      const response = await fetchOfficialDetail(fetchImpl, officialUrl);
      const parsed = parseChinaTaxPolicyEvidence(response.raw_html);
      const snapshot = repository.recordRawSnapshot({
        source_id,
        collection_run_id: run.collection_run_id,
        official_url: officialUrl,
        canonical_url: officialUrl,
        http_status: response.http_status,
        response_headers_subset: response.response_headers_subset,
        content_type: response.content_type,
        raw_content: response.raw_html,
        normalized_text: parsed.normalized_text,
        parser_version: 'chinatax-evidence-2.0.0-phase2b',
        parse_result: {
          title: parsed.title,
          document_no: parsed.document_no,
          issuing_authority: parsed.issuing_authority,
          publish_date: parsed.publish_date,
          effective_date: parsed.effective_date,
          expiry_date: parsed.expiry_date,
          legal_status: parsed.legal_status
        }
      });
      const candidateResult = repository.createCandidate({
        snapshot_id: snapshot.snapshot_id,
        parsed_fields: {
          title: parsed.title,
          document_no: parsed.document_no,
          issuing_authority: parsed.issuing_authority,
          publish_date: parsed.publish_date,
          effective_date: parsed.effective_date,
          expiry_date: parsed.expiry_date,
          official_url: snapshot.official_url,
          source_id: snapshot.source_id,
          snapshot_id: snapshot.snapshot_id
        },
        verification_state: 'pending_review',
        legal_status: 'pending'
      });
      results.push(Object.freeze({ official_url: officialUrl, parsed, snapshot, candidate: candidateResult.candidate, candidate_created: candidateResult.created }));
    }
    repository.finishCollectionRun(run.collection_run_id);
  } catch (error) {
    repository.finishCollectionRun(run.collection_run_id, { collection_state: 'failed', error: error.message });
    throw error;
  }
  return Object.freeze({ run, results: Object.freeze(results), created: Object.freeze({ snapshots: results.length, candidates: results.filter((item) => item.candidate_created).length, policies: 0, netlify_blobs: 0 }) });
}
