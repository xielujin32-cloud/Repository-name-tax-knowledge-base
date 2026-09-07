import { createHash } from 'node:crypto';
import { CHINA_TAX_POLICY_SOURCE, normalizeChinaTaxPolicyUrl } from './chinatax-evidence-adapter.js';
import { parseChinaTaxPolicyEvidence } from './chinatax-evidence-collection.js';
import { CANDIDATE_RISK_RULE_VERSION, evaluateCandidateRisk } from './candidate-risk-assessment.js';
import { CANDIDATE_RELATION_RULE_VERSION, proposeCandidateRelations } from './candidate-relation-proposal.js';
import { suggestEvidenceMetadata } from './evidence-metadata-suggestion.js';

export const PHASE3C1_IMPORT_MANIFEST_KEY = 'phase3c1-first-ten-v1';
export const PHASE3C1_IMPORT_PARSER_VERSION = 'chinatax-evidence-2.1.0-dom-body';
export const PHASE3C1_IMPORT_MANIFEST_CONFIRMATION = 'FREEZE_PHASE3C1_FIRST_TEN';
export const PHASE3C2_CONTROLLED_APPLY_CONFIRMATION = 'APPLY_PHASE3C2_FROZEN_MANIFEST';
const PHASE3C1_PREVIEW_USER_AGENT = 'TaxPolicyKnowledgeBase/0.3 (phase3c1-controlled-preview)';
const PHASE3C1_FETCH_TIMEOUT_MS = 20_000;
const PHASE3C1_SHORT_CADENCE_DELAY_MS = 2_000;
const PHASE3C1_TRANSIENT_MAX_ATTEMPTS = 2;
const PHASE3C1_TRANSIENT_RETRY_DELAY_MS = 5_000;
const PHASE3C1_RATE_LIMIT_MAX_DELAY_MS = 15_000;
export const PHASE3C1_IMPORT_SELECTION_CRITERIA = Object.freeze({
  selection_version: 'phase3c1-fixed-preview-v1',
  source: 'Phase 3C-0 verified STA list.html through list_4.html, preserve page order, URL dedupe, first 50',
  eligibility: Object.freeze([
    'official STA policy detail URL', 'HTTP 200', 'supported DOM body extraction', 'no template contamination',
    'title/issuing authority/publish date present', 'trusted document number', 'risk low with score 0',
    'no document-number conflict', 'no suspected duplicate/version change', 'no relation proposal'
  ]),
  selection: 'Fixed ordinal allowlist below; browser input cannot add, remove, or reorder items.'
});

// This immutable list is the outcome of the accepted Phase 3C-0.5 dry-run.
// It is deliberately server-owned: no request can replace it with URL, body,
// Candidate, Policy, or legal-status input.
export const PHASE3C1_FIXED_IMPORT_URLS = Object.freeze([
  'https://fgk.chinatax.gov.cn/zcfgk/c100012/c5194512/content.html',
  'https://fgk.chinatax.gov.cn/zcfgk/c100012/c5211588/content.html',
  'https://fgk.chinatax.gov.cn/zcfgk/c100012/c5193287/content.html',
  'https://fgk.chinatax.gov.cn/zcfgk/c100012/c5214066/content.html',
  'https://fgk.chinatax.gov.cn/zcfgk/c100012/c5207053/content.html',
  'https://fgk.chinatax.gov.cn/zcfgk/c100012/c5193409/content.html',
  'https://fgk.chinatax.gov.cn/zcfgk/c100012/c5193400/content.html',
  'https://fgk.chinatax.gov.cn/zcfgk/c100012/c5193388/content.html',
  'https://fgk.chinatax.gov.cn/zcfgk/c100012/c5193156/content.html',
  'https://fgk.chinatax.gov.cn/zcfgk/c100012/c5210371/content.html'
]);

const sha256 = (value) => createHash('sha256').update(String(value || '')).digest('hex');
const stable = (value) => Array.isArray(value)
  ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const canonical = (value) => normalizeChinaTaxPolicyUrl(value) || (() => { const url = new URL(value); url.hash = ''; return url.toString(); })();
// generated_at is audit metadata, not a change to the deterministic rule
// output. Including it would incorrectly block a later preflight for exactly
// the same official content.
function metadataSuggestionFingerprint(metadata) {
  const { generated_at: ignored, ...content } = metadata || {};
  return sha256(stable(content));
}

/**
 * Both the official preview and its diagnostic must use this exact request
 * shape. No credentials, cookies, referer, Accept, or Accept-Language are
 * added to an upstream China Tax request.
 */
export function phase3c1OfficialFetchOptions() {
  return {
    headers: { 'user-agent': PHASE3C1_PREVIEW_USER_AGENT },
    signal: AbortSignal.timeout(PHASE3C1_FETCH_TIMEOUT_MS)
  };
}

export const PHASE3C1_FETCH_ENVIRONMENT = Object.freeze({
  method: 'GET (fetch default)',
  redirect: 'follow (fetch default)',
  user_agent: { configured: true, value: PHASE3C1_PREVIEW_USER_AGENT },
  accept: { configured: false },
  accept_language: { configured: false },
  referer: { configured: false },
  cookie: { configured: false },
  authorization: { configured: false }
});

/** Shared upstream fetch used by preview, diagnostics, manifest, and Apply. */
export async function fetchPhase3C1OfficialDetail(officialUrl, { fetchImpl = fetch } = {}) {
  const requestedUrl = canonical(officialUrl);
  const response = await fetchImpl(requestedUrl, phase3c1OfficialFetchOptions());
  const raw_html = await response.text();
  return { requested_url: requestedUrl, response, raw_html };
}

function safeTitle(html) {
  const match = String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const value = String(match?.[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return value ? value.slice(0, 500) : null;
}

function classSelectorCount(html, className) {
  const openingTags = String(html || '').match(/<[a-z][\w:-]*\b[^>]*>/gi) || [];
  return openingTags.filter((tag) => {
    const match = tag.match(/\bclass\s*=\s*(["'])([\s\S]*?)\1/i);
    return match?.[2].split(/\s+/).includes(className);
  }).length;
}

function diagnosticSelectors(html) {
  const articleCount = (String(html || '').match(/<article\b[^>]*>/gi) || []).length;
  const classes = {
    '.arc_cont': classSelectorCount(html, 'arc_cont'),
    '.TRS_Editor': classSelectorCount(html, 'TRS_Editor'),
    '.article-content': classSelectorCount(html, 'article-content'),
    '.article_content': classSelectorCount(html, 'article_content'),
    article: articleCount
  };
  return Object.fromEntries(Object.entries(classes).map(([selector, count]) => [selector, { exists: count > 0, count }]));
}

function wafSignals(html) {
  const value = String(html || '');
  return {
    captcha_or_verification: /(?:验证码|安全验证|人机验证|验证身份|captcha|verify you are human)/i.test(value),
    access_denied_or_forbidden: /(?:access denied|forbidden|拒绝访问|无权访问)/i.test(value),
    likely_error_page: /(?:系统错误|服务异常|页面不存在|not found|error page)/i.test(value)
  };
}

function diagnosticParse(rawHtml) {
  try {
    parseChinaTaxPolicyEvidence(rawHtml);
    return { result: 'PASS', error_code: null };
  } catch (error) {
    const message = String(error?.message || '');
    return {
      result: 'FAIL',
      error_code: message === '国家税务总局详情页未找到受支持的政策正文容器。'
        ? 'POLICY_BODY_CONTAINER_MISSING'
        : 'PARSER_ERROR'
    };
  }
}

const SAFE_UPSTREAM_RESPONSE_HEADERS = Object.freeze([
  'server', 'via', 'cache-control', 'age', 'content-length', 'content-encoding',
  'x-cache', 'x-cache-hits', 'x-served-by', 'cf-cache-status', 'x-webcache-source'
]);

function safeUpstreamResponseHeaders(headers) {
  const values = {};
  for (const name of SAFE_UPSTREAM_RESPONSE_HEADERS) {
    const value = headers?.get?.(name);
    if (value) values[name] = String(value).slice(0, 500);
  }
  return values;
}

function shortResponseStructure(rawHtml) {
  const value = String(rawHtml || '');
  const short = value.length < 2_000;
  if (!short) return { analyzed: false };
  const text = value.replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ').replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return {
    analyzed: true,
    complete_html_document: /<html\b/i.test(value) && /<\/html\s*>/i.test(value),
    script: /<script\b/i.test(value),
    meta_refresh: /<meta\b[^>]*\bhttp-equiv\s*=\s*(["'])?refresh\1/i.test(value),
    location_script: /(?:window|document)\.location\b|\blocation\.(?:href|assign|replace)\b/i.test(value),
    iframe: /<iframe\b/i.test(value),
    form: /<form\b/i.test(value),
    js_challenge: /(?:challenge|captcha|recaptcha|hcaptcha|turnstile|_cf_chl|bot\s*(?:check|detection))/i.test(value),
    empty_shell: text.length <= 80
  };
}

function diagnosticItem({ ordinal, requested_url, response, raw_html }, { include_response_headers = false, include_short_structure = false } = {}) {
  const value = {
    ordinal,
    official_url: requested_url,
    http_status: response.status,
    response_ok: response.ok,
    content_type: response.headers?.get?.('content-type') || null,
    final_url: response.url || requested_url,
    redirect: { occurred: Boolean(response.redirected), count: response.redirected ? null : 0 },
    html_character_length: raw_html.length,
    html_utf8_byte_length: new TextEncoder().encode(raw_html).byteLength,
    html_sha256: sha256(raw_html),
    page_title: safeTitle(raw_html),
    selectors: diagnosticSelectors(raw_html),
    waf_signals: wafSignals(raw_html),
    parse: diagnosticParse(raw_html)
  };
  if (include_response_headers) value.response_headers = safeUpstreamResponseHeaders(response.headers);
  if (include_short_structure) value.short_response_structure = shortResponseStructure(raw_html);
  return Object.freeze(value);
}

/**
 * A deliberately content-free error context for the fail-closed official
 * preview.  It is safe to return only to the existing admin-only endpoint:
 * raw HTML, normalized policy text, request credentials, and upstream error
 * text never become part of this object.
 */
export class Phase3C1PreviewFailure extends Error {
  constructor({ ordinal, stage, processed_count, requested_url, response = null, raw_html = null, parser_error_code = null, code = 'PREVIEW_ITEM_FAILED', upstream_attempts = [] } = {}) {
    super(`Phase 3C-1 Preview stopped at ordinal ${ordinal}.`);
    this.name = 'Phase3C1PreviewFailure';
    const hasHtml = typeof raw_html === 'string';
    this.safe_diagnostic = Object.freeze({
      failed_ordinal: ordinal,
      failure_stage: stage,
      failure_code: code,
      successfully_processed_count: processed_count,
      official_url: requested_url || null,
      http_status: response?.status ?? null,
      content_type: response?.headers?.get?.('content-type') || null,
      final_url: response?.url || requested_url || null,
      redirect: response ? { occurred: Boolean(response.redirected), count: response.redirected ? null : 0 } : null,
      html_character_length: hasHtml ? raw_html.length : null,
      html_utf8_byte_length: hasHtml ? new TextEncoder().encode(raw_html).byteLength : null,
      html_sha256: hasHtml ? sha256(raw_html) : null,
      page_title: hasHtml ? safeTitle(raw_html) : null,
      selectors: hasHtml ? diagnosticSelectors(raw_html) : null,
      parser_error_code: parser_error_code || (hasHtml ? diagnosticParse(raw_html).error_code : null),
      upstream_attempts: Object.freeze([...(upstream_attempts || [])])
    });
  }
}

function phase3c1PreviewFailure(input) {
  return new Phase3C1PreviewFailure(input);
}

const waitFor = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function retryAfterDelay(headers) {
  const seconds = String(headers?.get?.('retry-after') || '').trim();
  if (!/^\d+$/.test(seconds)) return PHASE3C1_TRANSIENT_RETRY_DELAY_MS;
  return Math.max(PHASE3C1_TRANSIENT_RETRY_DELAY_MS, Math.min(Number(seconds) * 1000, PHASE3C1_RATE_LIMIT_MAX_DELAY_MS));
}

function transientNetworkFailure(error) {
  const code = String(error?.code || error?.cause?.code || '').toUpperCase();
  const name = String(error?.name || '').toLowerCase();
  return name === 'aborterror' || ['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code);
}

function allSupportedContainersMissing(selectors) {
  return Object.values(selectors || {}).every((value) => Number(value?.count) === 0);
}

function safeRetryAttempt({ attempt_number, response = null, raw_html = null, requested_url = null, fetch_error = null, diagnostic = null, retry_eligible = false, wait_before_next_ms = 0 } = {}) {
  const value = diagnostic || (typeof raw_html === 'string' && response ? diagnosticItem({ ordinal: null, requested_url, response, raw_html }) : null);
  return Object.freeze({
    attempt_number,
    retry_eligible,
    wait_before_next_ms,
    http_status: value?.http_status ?? null,
    content_type: value?.content_type ?? null,
    final_url: value?.final_url ?? requested_url,
    html_length: value?.html_character_length ?? null,
    html_sha256: value?.html_sha256 ?? null,
    page_title: value?.page_title ?? null,
    selector_counts: value?.selectors ?? null,
    parser_result: value?.parse?.result ?? 'FAIL',
    parser_error_code: value?.parse?.error_code ?? (fetch_error ? 'UPSTREAM_FETCH_FAILED' : null)
  });
}

function retryDecision({ response = null, diagnostic = null, error = null } = {}) {
  if (error) return { retry_eligible: transientNetworkFailure(error), delay_ms: PHASE3C1_TRANSIENT_RETRY_DELAY_MS, code: 'UPSTREAM_FETCH_FAILED' };
  const status = Number(response?.status);
  if (status === 429) return { retry_eligible: true, delay_ms: retryAfterDelay(response.headers), code: 'UPSTREAM_HTTP_429' };
  if ([502, 503, 504].includes(status)) return { retry_eligible: true, delay_ms: PHASE3C1_TRANSIENT_RETRY_DELAY_MS, code: `UPSTREAM_HTTP_${status}` };
  const incomplete200 = status === 200
    && Number(diagnostic?.html_character_length) < 2_000
    && !diagnostic?.page_title
    && allSupportedContainersMissing(diagnostic?.selectors)
    && diagnostic?.parse?.error_code === 'POLICY_BODY_CONTAINER_MISSING';
  return { retry_eligible: incomplete200, delay_ms: PHASE3C1_TRANSIENT_RETRY_DELAY_MS, code: incomplete200 ? 'INCOMPLETE_HTML_200' : null };
}

/**
 * Shared by the formal Preview, manifest material collection, and Apply
 * material collection. Diagnostics deliberately continue to call the raw
 * one-shot fetch helper so they expose upstream behavior without recovery.
 */
export async function fetchParsePhase3C1OfficialDetailWithRetry(officialUrl, { fetchImpl = fetch, waitImpl = waitFor, ordinal = null, processed_count = 0 } = {}) {
  const requestedUrl = canonical(officialUrl);
  const upstreamAttempts = [];
  for (let attempt = 1; attempt <= PHASE3C1_TRANSIENT_MAX_ATTEMPTS; attempt += 1) {
    let fetched;
    try {
      fetched = await fetchPhase3C1OfficialDetail(requestedUrl, { fetchImpl });
    } catch (error) {
      const decision = retryDecision({ error });
      const canRetry = decision.retry_eligible && attempt < PHASE3C1_TRANSIENT_MAX_ATTEMPTS;
      upstreamAttempts.push(safeRetryAttempt({ attempt_number: attempt, requested_url: requestedUrl, fetch_error: error, retry_eligible: canRetry, wait_before_next_ms: canRetry ? decision.delay_ms : 0 }));
      if (canRetry) { await waitImpl(decision.delay_ms); continue; }
      throw phase3c1PreviewFailure({ ordinal, stage: 'fetch', processed_count, requested_url: requestedUrl, code: decision.code || 'UPSTREAM_FETCH_FAILED', upstream_attempts: upstreamAttempts });
    }
    const diagnostic = diagnosticItem({ ordinal, ...fetched });
    const decision = retryDecision({ response: fetched.response, diagnostic });
    const success = fetched.response.ok && diagnostic.parse.result === 'PASS';
    const canRetry = !success && decision.retry_eligible && attempt < PHASE3C1_TRANSIENT_MAX_ATTEMPTS;
    upstreamAttempts.push(safeRetryAttempt({ attempt_number: attempt, requested_url: fetched.requested_url, response: fetched.response, raw_html: fetched.raw_html, diagnostic, retry_eligible: canRetry, wait_before_next_ms: canRetry ? decision.delay_ms : 0 }));
    if (success) {
      let parsed;
      try { parsed = parseChinaTaxPolicyEvidence(fetched.raw_html); }
      catch { throw phase3c1PreviewFailure({ ordinal, stage: 'parse', processed_count, requested_url: fetched.requested_url, response: fetched.response, raw_html: fetched.raw_html, parser_error_code: 'PARSER_ERROR', code: 'PARSER_ERROR', upstream_attempts: upstreamAttempts }); }
      return Object.freeze({ ...fetched, parsed, upstream_attempts: Object.freeze(upstreamAttempts) });
    }
    if (canRetry) { await waitImpl(decision.delay_ms); continue; }
    const stage = !fetched.response.ok ? 'http' : diagnostic.parse.error_code === 'POLICY_BODY_CONTAINER_MISSING' ? 'body-container' : 'parse';
    throw phase3c1PreviewFailure({ ordinal, stage, processed_count, requested_url: fetched.requested_url, response: fetched.response, raw_html: fetched.raw_html, parser_error_code: diagnostic.parse.error_code, code: decision.code || diagnostic.parse.error_code || 'UPSTREAM_HTTP_NOT_OK', upstream_attempts: upstreamAttempts });
  }
  throw new Error('Phase 3C transient retry attempt limit invariant failed.');
}

/**
 * Admin-only callers receive response diagnostics, never raw HTML or policy
 * prose. It deliberately does not throw on one failed item so a Production
 * operator can see every fixed URL affected by an upstream variant.
 */
export async function diagnosePhase3C1ImportPreview({ fetchImpl = fetch } = {}) {
  const items = [];
  for (const [offset, configuredUrl] of PHASE3C1_FIXED_IMPORT_URLS.entries()) {
    const ordinal = offset + 1;
    try {
      const { requested_url, response, raw_html } = await fetchPhase3C1OfficialDetail(configuredUrl, { fetchImpl });
      items.push(diagnosticItem({ ordinal, requested_url, response, raw_html }));
    } catch (error) {
      items.push(Object.freeze({
        ordinal,
        official_url: canonical(configuredUrl),
        fetch_error: { code: 'UPSTREAM_FETCH_FAILED', name: String(error?.name || 'Error') },
        parse: { result: 'FAIL', error_code: 'UPSTREAM_FETCH_FAILED' }
      }));
    }
  }
  return Object.freeze({
    mode: 'read_only_diagnostic',
    fetch_environment: PHASE3C1_FETCH_ENVIRONMENT,
    items: Object.freeze(items)
  });
}

/**
 * Fixed, read-only stability probe for the only Production-blocking source
 * entry. There is intentionally no ordinal/URL/attempt input in this API.
 */
export async function diagnosePhase3C1OrdinalTenUpstreamStability({ fetchImpl = fetch } = {}) {
  const ordinal = PHASE3C1_FIXED_IMPORT_URLS.length;
  const configuredUrl = PHASE3C1_FIXED_IMPORT_URLS[ordinal - 1];
  const attempts = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const fetched = await fetchPhase3C1OfficialDetail(configuredUrl, { fetchImpl });
      attempts.push(Object.freeze({ attempt, ...diagnosticItem({ ordinal, ...fetched }, { include_response_headers: true, include_short_structure: true }) }));
    } catch (error) {
      attempts.push(Object.freeze({
        attempt,
        ordinal,
        official_url: canonical(configuredUrl),
        fetch_error: { code: 'UPSTREAM_FETCH_FAILED', name: String(error?.name || 'Error') },
        parse: { result: 'FAIL', error_code: 'UPSTREAM_FETCH_FAILED' }
      }));
    }
  }
  return Object.freeze({
    mode: 'read_only_ordinal_ten_stability_diagnostic',
    fixed_ordinal: ordinal,
    maximum_attempts: 3,
    fetch_environment: PHASE3C1_FETCH_ENVIRONMENT,
    attempts: Object.freeze(attempts)
  });
}

function cadenceFetchFailure({ request_sequence, ordinal, official_url, error }) {
  return Object.freeze({
    request_sequence,
    ordinal,
    official_url,
    fetch_error: { code: 'UPSTREAM_FETCH_FAILED', name: String(error?.name || 'Error') },
    parse: { result: 'FAIL', error_code: 'UPSTREAM_FETCH_FAILED' }
  });
}

/**
 * A fixed, low-volume cadence probe. It intentionally has no caller-supplied
 * ordinal, URL, or delay. Any bad HTTP response or parse stops the sequence
 * before another official-site request is made.
 */
export async function diagnosePhase3C1ShortCadence({ fetchImpl = fetch, waitImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) } = {}) {
  const ordinals = Object.freeze([8, 9, 10]);
  const items = [];
  let blocked = false;
  for (const [offset, ordinal] of ordinals.entries()) {
    if (offset > 0) await waitImpl(PHASE3C1_SHORT_CADENCE_DELAY_MS);
    const configuredUrl = PHASE3C1_FIXED_IMPORT_URLS[ordinal - 1];
    try {
      const fetched = await fetchPhase3C1OfficialDetail(configuredUrl, { fetchImpl });
      const item = Object.freeze({
        request_sequence: offset + 1,
        ...diagnosticItem({ ordinal, ...fetched }, { include_response_headers: true })
      });
      items.push(item);
      if (!item.response_ok || item.parse.result !== 'PASS') {
        blocked = true;
        break;
      }
    } catch (error) {
      items.push(cadenceFetchFailure({ request_sequence: offset + 1, ordinal, official_url: canonical(configuredUrl), error }));
      blocked = true;
      break;
    }
  }
  return Object.freeze({
    mode: 'read_only_short_cadence_diagnostic',
    fixed_ordinals: ordinals,
    fixed_delay_ms: PHASE3C1_SHORT_CADENCE_DELAY_MS,
    maximum_requests: ordinals.length,
    result: blocked ? 'BLOCKED' : 'PASS',
    fetch_environment: PHASE3C1_FETCH_ENVIRONMENT,
    items: Object.freeze(items)
  });
}

/**
 * The full, fixed-list counterpart to cadence-short. Its order, interval,
 * and maximum request count are server-owned and cannot be altered by an
 * admin request. This is observability only; it never opens a repository.
 */
export async function diagnosePhase3C1FullCadence({ fetchImpl = fetch, waitImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) } = {}) {
  const ordinals = Object.freeze(PHASE3C1_FIXED_IMPORT_URLS.map((_, offset) => offset + 1));
  const items = [];
  let blocked = false;
  for (const [offset, ordinal] of ordinals.entries()) {
    if (offset > 0) await waitImpl(PHASE3C1_SHORT_CADENCE_DELAY_MS);
    const configuredUrl = PHASE3C1_FIXED_IMPORT_URLS[ordinal - 1];
    try {
      const fetched = await fetchPhase3C1OfficialDetail(configuredUrl, { fetchImpl });
      const item = Object.freeze({
        request_sequence: offset + 1,
        ...diagnosticItem({ ordinal, ...fetched }, { include_response_headers: true })
      });
      items.push(item);
      if (!item.response_ok || item.parse.result !== 'PASS') {
        blocked = true;
        break;
      }
    } catch (error) {
      items.push(cadenceFetchFailure({ request_sequence: offset + 1, ordinal, official_url: canonical(configuredUrl), error }));
      blocked = true;
      break;
    }
  }
  return Object.freeze({
    mode: 'read_only_full_cadence_diagnostic',
    fixed_ordinals: ordinals,
    fixed_delay_ms: PHASE3C1_SHORT_CADENCE_DELAY_MS,
    maximum_requests: ordinals.length,
    result: blocked ? 'BLOCKED' : 'PASS',
    fetch_environment: PHASE3C1_FETCH_ENVIRONMENT,
    items: Object.freeze(items)
  });
}

function frozenItemShape(item) {
  return {
    ordinal: item.ordinal,
    official_url: item.official_url,
    canonical_url: item.canonical_url,
    title: item.title,
    document_no: item.document_no,
    document_no_provenance: item.document_no_provenance,
    issuing_authority: item.issuing_authority,
    publish_date: item.publish_date,
    effective_date: item.effective_date,
    body_hash: item.body_hash,
    parser_version: item.parser_version,
    risk_assessment: item.risk_assessment,
    metadata_suggestion: item.metadata_suggestion,
    relation_proposals: item.relation_proposals
  };
}

export function phase3c1ItemFingerprint(item) {
  return sha256(stable(frozenItemShape(item)));
}

export function phase3c1ManifestFingerprint({ items, selection_criteria = PHASE3C1_IMPORT_SELECTION_CRITERIA } = {}) {
  return sha256(stable({ manifest_key: PHASE3C1_IMPORT_MANIFEST_KEY, selection_criteria, items: items.map(frozenItemShape) }));
}

function headersSubset(headers) {
  const result = {};
  for (const key of ['content-type', 'etag', 'last-modified', 'content-length', 'date']) {
    const value = headers?.get?.(key);
    if (value) result[key] = String(value);
  }
  return result;
}

function syntheticRiskDetail({ ordinal, officialUrl, rawHtml, parsed, fields }) {
  const body = parsed.normalized_text;
  const bodyHash = sha256(body);
  const snapshotId = `phase3c1-preview-snapshot-${ordinal}`;
  const collectionRunId = `phase3c1-preview-run-${ordinal}`;
  return {
    candidate: {
      candidate_id: `phase3c1-preview-candidate-${ordinal}`,
      snapshot_id: snapshotId,
      source_id: CHINA_TAX_POLICY_SOURCE.source_id,
      collection_run_id: collectionRunId,
      official_url: officialUrl,
      canonical_url: officialUrl,
      normalized_text_sha256: bodyHash,
      parsed_fields: fields,
      parsed_normalized_text: body
    },
    raw_snapshot: {
      snapshot_id: snapshotId,
      source_id: CHINA_TAX_POLICY_SOURCE.source_id,
      collection_run_id: collectionRunId,
      official_url: officialUrl,
      canonical_url: officialUrl,
      http_status: 200,
      raw_html: rawHtml,
      raw_sha256: sha256(rawHtml),
      normalized_text: body,
      normalized_text_sha256: bodyHash,
      parser_version: PHASE3C1_IMPORT_PARSER_VERSION
    },
    collection_run: { collection_run_id: collectionRunId, source_id: CHINA_TAX_POLICY_SOURCE.source_id },
    source: { source_id: CHINA_TAX_POLICY_SOURCE.source_id, official_domain: CHINA_TAX_POLICY_SOURCE.official_domain, enabled: true }
  };
}

function eligibilityProblems(item) {
  const issues = [];
  if (item.risk_assessment.risk_level !== 'low' || Number(item.risk_assessment.risk_score) !== 0) issues.push('RISK_NOT_LOW_ZERO');
  if (item.document_no_provenance.confidence !== 'high') issues.push('DOCUMENT_NO_NOT_TRUSTED');
  if (!['structured_field', 'title_nearby', 'body_lead'].includes(item.document_no_provenance.source)) issues.push('DOCUMENT_NO_PROVENANCE_INVALID');
  if (!item.title || !item.publish_date || !item.issuing_authority.length) issues.push('REQUIRED_FIELD_MISSING');
  if (item.relation_proposals.proposed_count !== 0) issues.push('RELATION_PROPOSAL_PRESENT');
  return issues;
}

/**
 * Read-only collection/parse/risk preview for the frozen 10. It creates no
 * Evidence records or Blob objects. The caller can persist only its output
 * through the dedicated controlled-import repository method.
 */
export async function collectPhase3C1ApplyMaterial({ fetchImpl = fetch, now = new Date().toISOString(), waitImpl = waitFor } = {}) {
  const items = [];
  const materials = [];
  for (const [offset, configuredUrl] of PHASE3C1_FIXED_IMPORT_URLS.entries()) {
    const ordinal = offset + 1;
    const officialUrl = canonical(configuredUrl);
    const fetched = await fetchParsePhase3C1OfficialDetailWithRetry(officialUrl, { fetchImpl, waitImpl, ordinal, processed_count: items.length });
    const { response, raw_html: rawHtml, parsed, upstream_attempts: upstreamAttempts } = fetched;
    let metadata;
    try {
      metadata = suggestEvidenceMetadata({ title: parsed.title, normalized_text: parsed.normalized_text, generated_at: now });
    } catch {
      throw phase3c1PreviewFailure({ ordinal, stage: 'metadata', processed_count: items.length, requested_url: fetched.requested_url, response, raw_html: rawHtml, code: 'METADATA_SUGGESTION_FAILED', upstream_attempts: upstreamAttempts });
    }
    const fields = {
      title: parsed.title,
      document_no: parsed.document_no,
      document_no_source: parsed.document_no_source,
      document_no_confidence: parsed.document_no_confidence,
      document_no_evidence: parsed.document_no_evidence,
      issuing_authority: parsed.issuing_authority,
      publish_date: parsed.publish_date,
      effective_date: parsed.effective_date,
      expiry_date: parsed.expiry_date,
      metadata_suggestion: metadata
    };
    let risk;
    try {
      risk = evaluateCandidateRisk(syntheticRiskDetail({ ordinal, officialUrl, rawHtml, parsed, fields }));
    } catch {
      throw phase3c1PreviewFailure({ ordinal, stage: 'risk', processed_count: items.length, requested_url: fetched.requested_url, response, raw_html: rawHtml, code: 'RISK_ASSESSMENT_FAILED', upstream_attempts: upstreamAttempts });
    }
    let proposals;
    try {
      proposals = proposeCandidateRelations({ normalized_text: parsed.normalized_text });
    } catch {
      throw phase3c1PreviewFailure({ ordinal, stage: 'relation', processed_count: items.length, requested_url: fetched.requested_url, response, raw_html: rawHtml, code: 'RELATION_PROPOSAL_FAILED', upstream_attempts: upstreamAttempts });
    }
    const item = {
      ordinal,
      official_url: officialUrl,
      canonical_url: officialUrl,
      http_status: response.status,
      response_headers_subset: headersSubset(response.headers),
      title: parsed.title,
      document_no: parsed.document_no,
      document_no_provenance: {
        source: parsed.document_no_source,
        confidence: parsed.document_no_confidence,
        evidence: parsed.document_no_evidence
      },
      issuing_authority: parsed.issuing_authority || [],
      publish_date: parsed.publish_date,
      effective_date: parsed.effective_date,
      body_hash: sha256(parsed.normalized_text),
      body_length: parsed.normalized_text.length,
      upstream_attempts: upstreamAttempts,
      parser_version: PHASE3C1_IMPORT_PARSER_VERSION,
      risk_assessment: { ...risk, assessment_hash: sha256(stable(risk)) },
      metadata_suggestion: {
        rule_version: metadata.rule_version,
        input_body_sha256: metadata.input_body_sha256,
        suggestion_hash: metadataSuggestionFingerprint(metadata),
        tax_categories: metadata.tax_categories,
        keywords: metadata.keywords,
        summary: metadata.summary
      },
      relation_proposals: {
        rule_version: CANDIDATE_RELATION_RULE_VERSION,
        input_body_sha256: sha256(parsed.normalized_text),
        proposed_count: proposals.length,
        state: proposals.length ? 'proposed' : 'none'
      }
    };
    item.item_fingerprint = phase3c1ItemFingerprint(item);
    const issues = eligibilityProblems(item);
    if (issues.length) {
      const stage = issues.includes('RISK_NOT_LOW_ZERO') ? 'risk'
        : issues.includes('RELATION_PROPOSAL_PRESENT') ? 'relation'
          : 'eligibility';
      throw phase3c1PreviewFailure({ ordinal, stage, processed_count: items.length, requested_url: fetched.requested_url, response, raw_html: rawHtml, code: issues[0], upstream_attempts: upstreamAttempts });
    }
    items.push(Object.freeze(item));
    materials.push(Object.freeze({
      ordinal,
      official_url: officialUrl,
      http_status: response.status,
      response_headers_subset: headersSubset(response.headers),
      upstream_attempts: upstreamAttempts,
      raw_html: rawHtml,
      normalized_text: parsed.normalized_text
    }));
  }
  if (items.length !== PHASE3C1_FIXED_IMPORT_URLS.length) throw new Error('Phase 3C-1 固定清单数量异常。');
  const preview = Object.freeze({
    manifest_key: PHASE3C1_IMPORT_MANIFEST_KEY,
    selection_criteria: PHASE3C1_IMPORT_SELECTION_CRITERIA,
    created_at: now,
    items: Object.freeze(items),
    materials: Object.freeze(materials),
    manifest_hash: phase3c1ManifestFingerprint({ items })
  });
  const { materials: safeMaterials, ...publicPreview } = preview;
  return Object.freeze({ preview: Object.freeze(publicPreview), materials: safeMaterials });
}

/** Public/admin preview deliberately omits raw HTML and normalized text. */
export async function preparePhase3C1ImportPreview(options = {}) {
  return (await collectPhase3C1ApplyMaterial(options)).preview;
}

/** Returns immutable-field mismatches without mutating an existing manifest. */
export function comparePhase3C1FrozenManifest(frozenItems, currentItems) {
  const frozen = new Map((frozenItems || []).map((item) => [item.ordinal, item]));
  const current = new Map((currentItems || []).map((item) => [item.ordinal, item]));
  const changes = [];
  if (frozen.size !== PHASE3C1_FIXED_IMPORT_URLS.length || current.size !== PHASE3C1_FIXED_IMPORT_URLS.length) {
    changes.push({ code: 'MANIFEST_ITEM_COUNT_CHANGED' });
  }
  for (const ordinal of [...frozen.keys()].sort((a, b) => a - b)) {
    const before = frozen.get(ordinal);
    const after = current.get(ordinal);
    if (!after) { changes.push({ ordinal, code: 'MANIFEST_ITEM_MISSING' }); continue; }
    if (before.official_url !== after.official_url) changes.push({ ordinal, code: 'OFFICIAL_URL_CHANGED' });
    if (before.body_hash !== after.body_hash) changes.push({ ordinal, code: 'BODY_HASH_CHANGED' });
    if (before.parser_version !== after.parser_version) changes.push({ ordinal, code: 'PARSER_VERSION_CHANGED' });
    if (before.risk_assessment?.assessment_hash !== after.risk_assessment?.assessment_hash) changes.push({ ordinal, code: 'RISK_ASSESSMENT_CHANGED' });
    if (before.risk_assessment?.rule_version !== after.risk_assessment?.rule_version) changes.push({ ordinal, code: 'RISK_RULE_VERSION_CHANGED' });
    if (before.metadata_suggestion?.suggestion_hash !== after.metadata_suggestion?.suggestion_hash) changes.push({ ordinal, code: 'METADATA_SUGGESTION_CHANGED' });
    if (before.metadata_suggestion?.rule_version !== after.metadata_suggestion?.rule_version) changes.push({ ordinal, code: 'METADATA_RULE_VERSION_CHANGED' });
    if (before.relation_proposals?.rule_version !== after.relation_proposals?.rule_version) changes.push({ ordinal, code: 'RELATION_RULE_VERSION_CHANGED' });
    if (before.relation_proposals?.proposed_count !== after.relation_proposals?.proposed_count) changes.push({ ordinal, code: 'RELATION_PROPOSAL_STATE_CHANGED' });
  }
  return Object.freeze(changes);
}
