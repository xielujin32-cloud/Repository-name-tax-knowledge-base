import { createHash } from 'node:crypto';
import { htmlToText } from './collector.js';
import { CHINA_TAX_POLICY_SOURCE, normalizeChinaTaxPolicyUrl } from './chinatax-evidence-adapter.js';
import { suggestEvidenceMetadata } from './evidence-metadata-suggestion.js';
import { proposeCandidateRelations } from './candidate-relation-proposal.js';

const DETAIL_USER_AGENT = 'TaxPolicyKnowledgeBase/0.2 (phase2b-evidence-collection)';

// This Phase 2B collector is deliberately allow-listed. It cannot be pointed at
// the legacy dataset, a search result, or another official/third-party URL.
export const PHASE_2B_ALLOWED_DETAIL_URLS = Object.freeze([
  'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5252027/content.html',
  'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5252024/content.html'
]);

const AUTHORITY_NAMES = Object.freeze(['国家税务总局', '财政部', '税务总局', '中国证监会', '海关总署', '国务院']);

// This is a deliberately small, review-oriented first batch. Every URL is a
// State Taxation Administration policy-library detail page found through its
// official index/search surface. The dry-run below reads only these pages; it
// cannot create Evidence, Candidate, Policy, or public projections.
export const PHASE4_P1_PILOT_OFFICIAL_URLS = Object.freeze([
  'https://fgk.chinatax.gov.cn/zcfgk/c100012/c5246538/content.html', // VAT general-taxpayer registration, 2026 No. 2
  'https://fgk.chinatax.gov.cn/zcfgk/c100012/c5247426/content.html', // VAT threshold / small-scale taxpayer, 2026 No. 4
  'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5252024/content.html', // VAT non-taxable transactions, 2026 No. 25
  'https://fgk.chinatax.gov.cn/zcfgk/c100012/c5196798/content.html', // repealed small-scale taxpayer rules, 2023 No. 1
  'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5210453/content.html', // small and micro enterprise policy, 2023 No. 12
  'https://fgk.chinatax.gov.cn/zcfgk/c100012/c5238152/content.html', // cross-border e-commerce overseas warehouse, 2025 No. 3
  'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5247663/content.html', // cross-border e-commerce returned exports, 2026 No. 16
  'https://fgk.chinatax.gov.cn/zcfgk/c100012/c5196771/content.html', // export-tax-refund administration, 2022 No. 9
  'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5202404/content.html', // cross-border e-commerce retail export, 2018 No. 103
  'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5247077/content.html' // enterprise-income-tax and VAT policy, 2026 No. 5
]);

export const PHASE4_P1_PILOT_TOPIC_LABELS = Object.freeze([
  '增值税', '小规模纳税人', '一般纳税人', '小型微利企业', '企业所得税', '出口退税', '出口免税', '跨境电商出口'
]);

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

const DOCUMENT_NO_AUTHORITY = '(?:国家税务总局|财政部|税务总局|中国证监会|海关总署|国务院)';
const DOCUMENT_NO_LITERAL = new RegExp(`${DOCUMENT_NO_AUTHORITY}(?:[、，,\\s]+${DOCUMENT_NO_AUTHORITY})*\\s*(?:公告|令|通知|决定)\\s*(?:〔\\d{4}〕\\d+号|\\d{4}年第\\d+号|第\\d+号)`, 'g');
const DOCUMENT_NO_REFERENCE_CONTEXT = /(?:根据|按照|依照|依据|参照|废止|修订|修改|替代|取代|附件|见)[^。；\n]{0,80}$/;

function plausibleDocumentNo(value) {
  const documentNo = clean(value);
  if (!documentNo || documentNo.length > 160) return null;
  return /(?:公告|令|通知|决定)\s*(?:〔\d{4}〕\d+号|\d{4}年第\d+号|第\d+号)$/.test(documentNo) ? documentNo : null;
}

function plausibleStructuredDocumentNo(value) {
  const documentNo = clean(value);
  if (!documentNo || documentNo.length > 160) return null;
  if (/(?:公告|令|通知|决定)\s*(?:〔\d{4}〕\d+号|\d{4}年第\d+号|第\d+号)$/.test(documentNo)) return documentNo;
  // Historical STA detail pages place codes such as 国税发〔1994〕122号
  // and 国税函[1999]207号 in their own header <h5>. Accept these only from
  // that structural field, never from the policy body or cited materials.
  return /^(?:国税(?:发|函|函发|函字)?|税总(?:发|函)?|财税(?:字)?)\s*[〔\[【(]?\s*\d{4}\s*[〕\]】)]?\s*\d+号$/.test(documentNo)
    ? documentNo
    : null;
}

function documentNoCandidate(text, { source, maxStart = Infinity } = {}) {
  const value = String(text || '');
  DOCUMENT_NO_LITERAL.lastIndex = 0;
  let match;
  while ((match = DOCUMENT_NO_LITERAL.exec(value))) {
    if (match.index > maxStart) break;
    const documentNo = plausibleDocumentNo(match[0]);
    if (!documentNo) continue;
    const prefix = value.slice(Math.max(0, match.index - 220), match.index);
    // A cited instrument is never evidence of this page's own document number.
    if (DOCUMENT_NO_REFERENCE_CONTEXT.test(prefix)) continue;
    return {
      document_no: documentNo,
      document_no_source: source,
      document_no_confidence: 'high',
      document_no_evidence: { source, start: match.index, end: match.index + match[0].length, text: documentNo }
    };
  }
  return null;
}

function structuredDocumentNo(detailHtml) {
  const value = textFromFirst(detailHtml, /<h5\b[^>]*\bclass\s*=\s*["'][^"']*\bactfwzh\b[^"']*["'][^>]*>([\s\S]*?)<\/h5>/i);
  const documentNo = plausibleStructuredDocumentNo(value);
  if (documentNo) return { document_no: documentNo, document_no_source: 'structured_field', document_no_confidence: 'high', document_no_evidence: { source: 'structured_field', start: 0, end: documentNo.length, text: documentNo } };
  const headerEnd = detailHtml.indexOf('<div class="article"');
  const headerHtml = headerEnd >= 0 ? detailHtml.slice(0, headerEnd) : detailHtml;
  const candidates = [...headerHtml.matchAll(/<h5\b[^>]*>([\s\S]*?)<\/h5>/gi)]
    .map((match) => ({ documentNo: plausibleStructuredDocumentNo(htmlToText(match[1])), start: match.index }))
    .filter((item) => item.documentNo);
  // A single header H5 is a stable, page-owned field. Multiple candidates are
  // deliberately left unresolved rather than guessing which one is current.
  if (candidates.length !== 1) return null;
  return { document_no: candidates[0].documentNo, document_no_source: 'structured_field', document_no_confidence: 'high', document_no_evidence: { source: 'structured_field', start: candidates[0].start, end: candidates[0].start + candidates[0].documentNo.length, text: candidates[0].documentNo } };
}

function documentNoNearTitle(detailHtml, title) {
  const headerEnd = detailHtml.indexOf('<div class="article"');
  const headerText = htmlToText(headerEnd >= 0 ? detailHtml.slice(0, headerEnd) : detailHtml);
  const titleStart = title ? headerText.indexOf(title) : -1;
  if (titleStart < 0) return null;
  const nearby = headerText.slice(Math.max(0, titleStart - 120), titleStart + title.length + 320);
  const candidate = documentNoCandidate(nearby, { source: 'title_nearby' });
  if (!candidate) return null;
  return { ...candidate, document_no_evidence: { ...candidate.document_no_evidence, start: candidate.document_no_evidence.start + Math.max(0, titleStart - 120), end: candidate.document_no_evidence.end + Math.max(0, titleStart - 120) } };
}

function documentNoFromBodyLead(bodyText) {
  return documentNoCandidate(String(bodyText || '').slice(0, 600), { source: 'body_lead' });
}

function missingDocumentNo() {
  return { document_no: null, document_no_source: 'missing', document_no_confidence: 'none', document_no_evidence: null };
}

function authoritiesFromDocumentNo(documentNo) {
  if (!documentNo) return [];
  const prefix = documentNo.split(/公告|令|通知|决定/)[0] || '';
  return [...new Set(AUTHORITY_NAMES.filter((authority) => prefix.includes(authority)))];
}

function authoritiesFromTitle(title) {
  const heading = String(title || '').split(/关于|公告|通知|办法|规定|条例/)[0] || '';
  return [...new Set(AUTHORITY_NAMES.filter((authority) => heading.includes(authority)))];
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
  const detailHtml = documentDetailHtml(html);
  const detailText = htmlToText(detailHtml);
  const title = titleFromDetail(html);
  // Never scan the full detail text: it can contain cited instruments,
  // attachments, recommendations and other page-local content. A missing
  // number is safer than assigning a referenced policy's number to this page.
  const documentNo = structuredDocumentNo(detailHtml)
    || documentNoNearTitle(detailHtml, title)
    || documentNoFromBodyLead(normalizedText)
    || missingDocumentNo();
  const publishedMeta = dateOnly(metaContent(html, 'PubDate'));
  return Object.freeze({
    title,
    document_no: documentNo.document_no,
    document_no_source: documentNo.document_no_source,
    document_no_confidence: documentNo.document_no_confidence,
    document_no_evidence: documentNo.document_no_evidence,
    issuing_authority: authoritiesFromDocumentNo(documentNo.document_no).length ? authoritiesFromDocumentNo(documentNo.document_no) : authoritiesFromTitle(title),
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

function sha256(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function topicMatches(title, normalizedText) {
  const corpus = `${title || ''}\n${normalizedText || ''}`;
  const rules = [
    ['增值税', /增值税/],
    ['小规模纳税人', /小规模纳税人/],
    ['一般纳税人', /一般纳税人/],
    ['小型微利企业', /小型微利企业/],
    ['企业所得税', /企业所得税/],
    ['出口退税', /出口退\s*[（(]?免[）)]?税|出口退税/],
    ['出口免税', /出口[^。；\n]{0,18}免税|免税[^。；\n]{0,18}出口/],
    ['跨境电商出口', /跨境电子商务|跨境电商|出口海外仓/]
  ];
  return rules.filter(([, pattern]) => pattern.test(corpus)).map(([label]) => label);
}

function officialStatusHint(html) {
  const value = htmlToText(documentDetailHtml(html));
  if (/全文(?:废止|失效)|全文无效/.test(value)) return 'official_page_marks_repealed_or_expired';
  if (/已修改|部分废止|部分失效/.test(value)) return 'official_page_marks_partially_changed';
  if (/全文有效/.test(value)) return 'official_page_marks_effective';
  return 'official_page_status_not_structurally_found';
}

function preliminaryRisk(parsed, { duplicateUrls, duplicateDocumentNumbers, duplicateTitles }) {
  const reasons = [];
  if (!parsed.title) reasons.push('TITLE_MISSING');
  if (!parsed.document_no) reasons.push('DOCUMENT_NO_MISSING');
  if (!parsed.publish_date) reasons.push('PUBLISH_DATE_MISSING');
  if (!parsed.effective_date) reasons.push('EFFECTIVE_DATE_NOT_EXPLICIT');
  if (!parsed.normalized_text || parsed.normalized_text.length < 80) reasons.push('BODY_TOO_SHORT');
  if (duplicateUrls) reasons.push('DUPLICATE_OFFICIAL_URL_IN_PILOT');
  if (duplicateDocumentNumbers) reasons.push('DUPLICATE_DOCUMENT_NUMBER_IN_PILOT');
  if (duplicateTitles) reasons.push('DUPLICATE_TITLE_IN_PILOT');
  return reasons;
}

const INTAKE_BLOCKING_RISK_FLAGS = new Set([
  'TITLE_MISSING',
  'DOCUMENT_NO_MISSING',
  'PUBLISH_DATE_MISSING',
  'BODY_TOO_SHORT',
  'DUPLICATE_OFFICIAL_URL_IN_PILOT',
  'DUPLICATE_DOCUMENT_NUMBER_IN_PILOT',
  'DUPLICATE_TITLE_IN_PILOT'
]);

function isIntakeReady(riskFlags) {
  return !riskFlags.some((flag) => INTAKE_BLOCKING_RISK_FLAGS.has(flag));
}

function officialDetailFailureCode(error) {
  const message = String(error?.message || '');
  const httpStatus = message.match(/政策详情请求失败：(\d{3})/);
  if (httpStatus) return `OFFICIAL_DETAIL_HTTP_${httpStatus[1]}`;
  if (/未找到受支持的政策正文容器/.test(message)) return 'POLICY_BODY_CONTAINER_MISSING';
  if (/AbortError|timeout|timed out/i.test(message)) return 'OFFICIAL_DETAIL_TIMEOUT';
  return 'OFFICIAL_DETAIL_READ_FAILED';
}

/**
 * A deliberately safe error for the write-time attestation gate.  Its code is
 * suitable for an administrator response; it never includes an upstream body
 * or an authentication value.
 */
export class ChinaTaxCandidatePrewriteValidationError extends Error {
  constructor(code, mismatch = null) {
    super(code);
    this.name = 'ChinaTaxCandidatePrewriteValidationError';
    this.code = code;
    this.mismatch = mismatch;
  }
}

function prewriteFailure(code, mismatch = null) {
  throw new ChinaTaxCandidatePrewriteValidationError(code, mismatch);
}

function selectedChinaTaxPolicyUrls(urls, maxCandidates) {
  if (!Array.isArray(urls) || !urls.length) {
    throw new Error('必须提供已发现的国家税务总局官方详情 URL。');
  }
  const selectedUrls = [...new Set(urls.map((value) => normalizeChinaTaxPolicyUrl(value)).filter(Boolean))];
  if (!selectedUrls.length || selectedUrls.length > maxCandidates || selectedUrls.length !== new Set(urls.map(String)).size) {
    throw new Error(`官方 Candidate 收集仅接受 1 至 ${maxCandidates} 条互不重复的法规库详情 URL。`);
  }
  return selectedUrls;
}

function expectedItemsByOfficialUrl(selectedUrls, expectedItems) {
  if (!Array.isArray(expectedItems) || expectedItems.length !== selectedUrls.length) {
    prewriteFailure('PREWRITE_URL_SET_MISMATCH');
  }
  const byUrl = new Map();
  for (const item of expectedItems) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) prewriteFailure('PREWRITE_EXPECTED_ITEM_INVALID');
    const officialUrl = normalizeChinaTaxPolicyUrl(item.official_url);
    if (!officialUrl || byUrl.has(officialUrl)) prewriteFailure('PREWRITE_URL_SET_MISMATCH');
    const bodyHash = String(item.body_hash || '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(bodyHash)) prewriteFailure('PREWRITE_EXPECTED_BODY_HASH_MISSING');
    const policyTitle = clean(item.policy_title);
    const documentNumber = clean(item.document_number);
    const publicationDate = clean(item.publication_date);
    if (!policyTitle || !documentNumber || !/^\d{4}-\d{2}-\d{2}$/.test(publicationDate || '')) {
      prewriteFailure('PREWRITE_EXPECTED_METADATA_MISSING');
    }
    byUrl.set(officialUrl, Object.freeze({
      official_url: officialUrl,
      body_hash: bodyHash,
      policy_title: policyTitle,
      document_number: documentNumber,
      publication_date: publicationDate
    }));
  }
  if (byUrl.size !== selectedUrls.length || selectedUrls.some((officialUrl) => !byUrl.has(officialUrl))) {
    prewriteFailure('PREWRITE_URL_SET_MISMATCH');
  }
  return byUrl;
}

/**
 * Refetches the already dry-run-approved detail pages and attests the exact
 * content and identity before any repository write begins.  This is separate
 * from persistence so a changed upstream page cannot leave a partial intake.
 */
export async function preflightChinaTaxPolicyCandidateImport({
  urls = [], expectedItems = [], fetchImpl = fetch, maxCandidates = 20
} = {}) {
  const cap = Math.min(Math.max(Number(maxCandidates) || 20, 1), 20);
  const selectedUrls = selectedChinaTaxPolicyUrls(urls, cap);
  const expectedByUrl = expectedItemsByOfficialUrl(selectedUrls, expectedItems);
  const staged = [];

  for (const [index, officialUrl] of selectedUrls.entries()) {
    const ordinal = index + 1;
    const expected = expectedByUrl.get(officialUrl);
    let response;
    let parsed;
    try {
      response = await fetchOfficialDetail(fetchImpl, officialUrl);
      parsed = parseChinaTaxPolicyEvidence(response.raw_html);
    } catch (error) {
      prewriteFailure(`PREWRITE_${officialDetailFailureCode(error)}`, Object.freeze({ ordinal, official_url: officialUrl, mismatch_reason: officialDetailFailureCode(error) }));
    }
    const actual = Object.freeze({
      body_hash: sha256(parsed.normalized_text),
      policy_title: clean(parsed.title),
      document_number: clean(parsed.document_no),
      publication_date: clean(parsed.publish_date)
    });
    if (actual.body_hash !== expected.body_hash) {
      prewriteFailure('PREWRITE_BODY_HASH_MISMATCH', Object.freeze({
        ordinal,
        official_url: officialUrl,
        mismatch_reason: 'BODY_HASH_MISMATCH',
        expected,
        actual
      }));
    }
    if (actual.policy_title !== expected.policy_title
      || actual.document_number !== expected.document_number
      || actual.publication_date !== expected.publication_date) {
      prewriteFailure('PREWRITE_METADATA_MISMATCH', Object.freeze({
        ordinal,
        official_url: officialUrl,
        mismatch_reason: 'METADATA_MISMATCH',
        expected,
        actual
      }));
    }
    staged.push({ officialUrl, response, parsed });
  }

  const countBy = (selector) => {
    const counts = new Map();
    for (const item of staged) {
      const value = selector(item);
      if (!value) continue;
      counts.set(value, (counts.get(value) || 0) + 1);
    }
    return counts;
  };
  const urlCounts = countBy((item) => item.officialUrl);
  const documentNoCounts = countBy((item) => item.parsed.document_no || '');
  const titleCounts = countBy((item) => item.parsed.title || '');
  return Object.freeze(staged.map((item) => {
    const riskFlags = preliminaryRisk(item.parsed, {
      duplicateUrls: (urlCounts.get(item.officialUrl) || 0) > 1,
      duplicateDocumentNumbers: item.parsed.document_no && (documentNoCounts.get(item.parsed.document_no) || 0) > 1,
      duplicateTitles: item.parsed.title && (titleCounts.get(item.parsed.title) || 0) > 1
    });
    if (!isIntakeReady(riskFlags)) prewriteFailure('PREWRITE_CANDIDATE_NOT_INTAKE_READY');
    return Object.freeze({
      officialUrl: item.officialUrl,
      response: item.response,
      parsed: item.parsed,
      metadataSuggestion: suggestEvidenceMetadata({ title: item.parsed.title || '', normalized_text: item.parsed.normalized_text }),
      pilotTopics: topicMatches(item.parsed.title, item.parsed.normalized_text),
      sourceStatusHint: officialStatusHint(item.response.raw_html)
    });
  }));
}

/**
 * Inspects a bounded State Taxation Administration pilot batch without
 * persisting any data. It is intentionally not an importer: legal status is
 * always pending_verification and all relation clues remain proposals.
 */
export async function dryRunChinaTaxPolicyPilot({
  urls = PHASE4_P1_PILOT_OFFICIAL_URLS,
  fetchImpl = fetch,
  source = CHINA_TAX_POLICY_SOURCE,
  maxCandidates = 20
} = {}) {
  const cap = Math.min(Math.max(Number(maxCandidates) || 20, 1), 20);
  if (!Array.isArray(urls) || urls.length < 1 || urls.length > cap) {
    throw new Error(`Phase 4 P1 试运行只接受 1 至 ${cap} 条官方详情 URL。`);
  }
  const selectedUrls = urls.map((value) => normalizeChinaTaxPolicyUrl(value));
  if (selectedUrls.some((value) => !value) || new Set(selectedUrls).size !== selectedUrls.length) {
    throw new Error('Phase 4 P1 试运行只接受互不重复的国家税务总局法规库详情 URL。');
  }

  const staged = [];
  for (const officialUrl of selectedUrls) {
    try {
      const response = await fetchOfficialDetail(fetchImpl, officialUrl);
      const parsed = parseChinaTaxPolicyEvidence(response.raw_html);
      const metadata = suggestEvidenceMetadata({ title: parsed.title || '', normalized_text: parsed.normalized_text });
      staged.push({ officialUrl, response, parsed, metadata, statusHint: officialStatusHint(response.raw_html) });
    } catch (error) {
      // Do not include upstream response bodies in a dry-run report.
      staged.push({ officialUrl, failureCode: officialDetailFailureCode(error) });
    }
  }

  const countBy = (selector) => {
    const counts = new Map();
    for (const item of staged) {
      const value = selector(item);
      if (!value) continue;
      counts.set(value, (counts.get(value) || 0) + 1);
    }
    return counts;
  };
  const urlCounts = countBy((item) => item.officialUrl);
  const documentNoCounts = countBy((item) => item.parsed?.document_no || '');
  const titleCounts = countBy((item) => item.parsed?.title || '');

  const candidates = staged.map((item, index) => {
    if (item.failureCode) return Object.freeze({
      ordinal: index + 1,
      official_url: item.officialUrl,
      source_id: source.source_id,
      source_name: source.source_name,
      source_agency: '国家税务总局',
      source_domain: source.official_domain,
      candidate_state: 'failed',
      dry_run_error: item.failureCode,
      suggested_validity_status: 'pending_verification',
      risk_flags: [item.failureCode],
      relation_proposals: [],
      intake_ready: false
    });
    const { parsed, metadata } = item;
    const relations = proposeCandidateRelations({ normalized_text: parsed.normalized_text });
    const risks = preliminaryRisk(parsed, {
      duplicateUrls: (urlCounts.get(item.officialUrl) || 0) > 1,
      duplicateDocumentNumbers: parsed.document_no && (documentNoCounts.get(parsed.document_no) || 0) > 1,
      duplicateTitles: parsed.title && (titleCounts.get(parsed.title) || 0) > 1
    });
    const topics = topicMatches(parsed.title, parsed.normalized_text);
    return Object.freeze({
      ordinal: index + 1,
      official_url: item.officialUrl,
      source_id: source.source_id,
      source_name: source.source_name,
      source_agency: '国家税务总局',
      source_domain: source.official_domain,
      policy_title: parsed.title,
      document_number: parsed.document_no,
      document_number_provenance: parsed.document_no_source,
      issuer: parsed.issuing_authority,
      publication_date: parsed.publish_date,
      effective_date: parsed.effective_date,
      expiry_date: parsed.expiry_date,
      suggested_validity_status: 'pending_verification',
      official_status_hint: item.statusHint,
      suggested_tax_categories: metadata.tax_categories.values,
      pilot_topics: topics,
      policy_category: 'tax_policy',
      region: ['全国'],
      keywords: metadata.keywords.values,
      summary: metadata.summary.value,
      body_hash: sha256(parsed.normalized_text),
      parser_version: 'chinatax-evidence-3.0.0-mvp',
      risk_flags: preliminaryRisk(parsed, {
        duplicateUrls: (urlCounts.get(item.officialUrl) || 0) > 1,
        duplicateDocumentNumbers: parsed.document_no && (documentNoCounts.get(parsed.document_no) || 0) > 1,
        duplicateTitles: parsed.title && (titleCounts.get(parsed.title) || 0) > 1
      }),
      relation_proposals: relations.map((relation) => ({ relation_type: relation.relation_type, target_reference: relation.target_reference, confidence: relation.confidence })),
      candidate_state: isIntakeReady(risks) ? 'ready' : 'failed',
      intake_ready: isIntakeReady(risks)
    });
  });
  const covered = new Set(candidates.flatMap((item) => item.pilot_topics || []));
  return Object.freeze({
    mode: 'dry-run',
    source: Object.freeze({ source_id: source.source_id, source_name: source.source_name, source_domain: source.official_domain, trust_level: source.trust_level }),
    candidate_count: candidates.length,
    import_ready_count: candidates.filter((item) => item.intake_ready).length,
    skipped_count: candidates.filter((item) => !item.intake_ready).length,
    failed_count: candidates.filter((item) => !item.intake_ready).length,
    coverage: Object.freeze({ requested_topics: PHASE4_P1_PILOT_TOPIC_LABELS, covered_topics: [...covered], missing_topics: PHASE4_P1_PILOT_TOPIC_LABELS.filter((item) => !covered.has(item)) }),
    candidates: Object.freeze(candidates),
    writes: Object.freeze({ raw_snapshots: 0, evidence: 0, candidates: 0, reviews: 0, policies: 0, policy_versions: 0, public_projections: 0, business_production_writes: 0 })
  });
}

export function addChinaTaxPolicySource(repository) {
  return repository.addSource({
    source_id: CHINA_TAX_POLICY_SOURCE.source_id,
    source_name: CHINA_TAX_POLICY_SOURCE.source_name,
    official_domain: CHINA_TAX_POLICY_SOURCE.official_domain,
    source_type: CHINA_TAX_POLICY_SOURCE.source_type,
    trust_level: CHINA_TAX_POLICY_SOURCE.trust_level,
    adapter_version: '2.0.0-phase2b',
    base_url: CHINA_TAX_POLICY_SOURCE.collection_url
  });
}

/**
 * Creates Evidence/Candidate records only for a bounded, already-discovered
 * set of State Taxation Administration detail URLs. It never creates a
 * Policy, Policy Version, or public Blob projection. Production callers must
 * supply an explicit reviewed selection and confirmation at the API layer.
 */
export async function collectChinaTaxPolicyCandidates({ repository, urls = [], expectedItems = null, fetchImpl = fetch, source = CHINA_TAX_POLICY_SOURCE, maxCandidates = 20, mode = 'mvp-official-candidate-intake' } = {}) {
  if (!repository) throw new Error('官方 Candidate 收集必须提供 Evidence Repository。');
  const cap = Math.min(Math.max(Number(maxCandidates) || 20, 1), 20);
  const selectedUrls = selectedChinaTaxPolicyUrls(urls, cap);
  // An expected set is present only on the protected Production endpoint. It
  // is fully read and attested before addSource/createCollectionRun, so no
  // snapshot, Evidence, Candidate, Risk or Relation write can precede it.
  const prewritePreparedByUrl = Array.isArray(expectedItems)
    ? new Map((await preflightChinaTaxPolicyCandidateImport({ urls: selectedUrls, expectedItems, fetchImpl, maxCandidates: cap }))
      .map((item) => [item.officialUrl, item]))
    : null;
  const sourceRecord = await addChinaTaxPolicySource(repository);
  const run = await repository.createCollectionRun({ source_id: sourceRecord.source_id, mode });
  const results = [];
  const skipped = [];
  try {
    for (const officialUrl of selectedUrls) {
      let prepared;
      if (prewritePreparedByUrl) {
        prepared = prewritePreparedByUrl.get(officialUrl);
        // The preflight maps exactly to selectedUrls. Keep this fail-closed
        // guard in case a future caller changes that invariant.
        if (!prepared) prewriteFailure('PREWRITE_URL_SET_MISMATCH');
      } else {
        try {
          const response = await fetchOfficialDetail(fetchImpl, officialUrl);
          const parsed = parseChinaTaxPolicyEvidence(response.raw_html);
          const riskFlags = preliminaryRisk(parsed, { duplicateUrls: false, duplicateDocumentNumbers: false, duplicateTitles: false });
          if (!isIntakeReady(riskFlags)) {
            skipped.push(Object.freeze({
              official_url: officialUrl,
              outcome: 'skipped',
              reason: 'PILOT_CANDIDATE_NOT_INTAKE_READY',
              risk_flags: Object.freeze(riskFlags)
            }));
            continue;
          }
          prepared = {
            response,
            parsed,
            metadataSuggestion: suggestEvidenceMetadata({ title: parsed.title || '', normalized_text: parsed.normalized_text }),
            pilotTopics: topicMatches(parsed.title, parsed.normalized_text),
            sourceStatusHint: officialStatusHint(response.raw_html)
          };
        } catch (error) {
          skipped.push(Object.freeze({
            official_url: officialUrl,
            outcome: 'failed',
            reason: officialDetailFailureCode(error),
            risk_flags: Object.freeze([officialDetailFailureCode(error)])
          }));
          continue;
        }
      }
      const { response, parsed, metadataSuggestion, pilotTopics, sourceStatusHint } = prepared;
      const snapshot = await repository.recordRawSnapshot({
        source_id: sourceRecord.source_id,
        collection_run_id: run.collection_run_id,
        official_url: officialUrl,
        canonical_url: officialUrl,
        http_status: response.http_status,
        response_headers_subset: response.response_headers_subset,
        content_type: response.content_type,
        raw_content: response.raw_html,
        normalized_text: parsed.normalized_text,
        parser_version: 'chinatax-evidence-3.0.0-mvp',
        parse_result: {
          title: parsed.title,
          document_no: parsed.document_no,
          document_no_source: parsed.document_no_source,
          document_no_confidence: parsed.document_no_confidence,
          document_no_evidence: parsed.document_no_evidence,
          issuing_authority: parsed.issuing_authority,
          publish_date: parsed.publish_date,
          effective_date: parsed.effective_date,
          expiry_date: parsed.expiry_date,
          legal_status: 'pending',
          validity_status_suggestion: 'pending_verification',
          official_status_hint: sourceStatusHint,
          tax_categories: metadataSuggestion.tax_categories.values,
          topics: pilotTopics,
          region: ['全国'],
          policy_category: 'tax_policy'
        }
      });
      const created = await repository.createCandidate({
        snapshot_id: snapshot.snapshot_id,
        parsed_fields: {
          title: parsed.title,
          document_no: parsed.document_no,
          document_no_source: parsed.document_no_source,
          document_no_confidence: parsed.document_no_confidence,
          document_no_evidence: parsed.document_no_evidence,
          issuing_authority: parsed.issuing_authority,
          publish_date: parsed.publish_date,
          effective_date: parsed.effective_date,
          expiry_date: parsed.expiry_date,
          official_url: snapshot.official_url,
          source_id: snapshot.source_id,
          snapshot_id: snapshot.snapshot_id,
          // All of these are suggestions/provenance for the existing review
          // workflow. They are never a legal-effect determination.
          tax_categories: metadataSuggestion.tax_categories.values,
          topics: pilotTopics,
          region: ['全国'],
          policy_category: 'tax_policy',
          validity_status_suggestion: 'pending_verification',
          official_status_hint: sourceStatusHint,
          metadata_suggestion: metadataSuggestion
        },
        verification_state: 'pending_review',
        legal_status: 'pending'
      });
      let riskAssessment = null;
      let relationProposals = [];
      if (created.created) {
        await repository.saveMetadataSuggestion(created.candidate.candidate_id, metadataSuggestion);
        riskAssessment = await repository.assessCandidateRisk(created.candidate.candidate_id);
        relationProposals = (await repository.generateCandidateRelationProposals(created.candidate.candidate_id)).created;
      }
      results.push({
        official_url: officialUrl,
        candidate_id: created.candidate.candidate_id,
        candidate_created: created.created,
        verification_state: created.candidate.verification_state,
        legal_status: created.candidate.legal_status,
        title_present: Boolean(parsed.title),
        document_no_present: Boolean(parsed.document_no),
        metadata_suggestion_created: Boolean(created.created),
        risk_level: riskAssessment?.assessment?.risk_level || null,
        risk_score: riskAssessment?.assessment?.risk_score ?? null,
        relation_proposals_created: relationProposals.length
      });
    }
    await repository.finishCollectionRun(run.collection_run_id);
  } catch (error) {
    await repository.finishCollectionRun(run.collection_run_id, 'failed');
    throw error;
  }
  return Object.freeze({
    mode,
    run: { collection_run_id: run.collection_run_id, source_id: sourceRecord.source_id },
    results: Object.freeze(results),
    skipped: Object.freeze(skipped),
    failed: Object.freeze(skipped.filter((item) => item.outcome === 'failed')),
    created: Object.freeze({
      raw_snapshots: results.length,
      candidates: results.filter((item) => item.candidate_created).length,
      risk_assessments: results.filter((item) => item.risk_level !== null).length,
      relation_proposals: results.reduce((total, item) => total + item.relation_proposals_created, 0),
      policies: 0,
      policy_versions: 0,
      public_projections: 0
    })
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
          document_no_source: parsed.document_no_source,
          document_no_confidence: parsed.document_no_confidence,
          document_no_evidence: parsed.document_no_evidence,
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
          document_no_source: parsed.document_no_source,
          document_no_confidence: parsed.document_no_confidence,
          document_no_evidence: parsed.document_no_evidence,
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
