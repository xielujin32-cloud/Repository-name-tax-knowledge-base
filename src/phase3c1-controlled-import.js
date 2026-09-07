import { createHash } from 'node:crypto';
import { CHINA_TAX_POLICY_SOURCE, normalizeChinaTaxPolicyUrl } from './chinatax-evidence-adapter.js';
import { parseChinaTaxPolicyEvidence } from './chinatax-evidence-collection.js';
import { CANDIDATE_RISK_RULE_VERSION, evaluateCandidateRisk } from './candidate-risk-assessment.js';
import { CANDIDATE_RELATION_RULE_VERSION, proposeCandidateRelations } from './candidate-relation-proposal.js';
import { suggestEvidenceMetadata } from './evidence-metadata-suggestion.js';

export const PHASE3C1_IMPORT_MANIFEST_KEY = 'phase3c1-first-ten-v1';
export const PHASE3C1_IMPORT_PARSER_VERSION = 'chinatax-evidence-2.1.0-dom-body';
export const PHASE3C1_IMPORT_MANIFEST_CONFIRMATION = 'FREEZE_PHASE3C1_FIRST_TEN';
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
export async function preparePhase3C1ImportPreview({ fetchImpl = fetch, now = new Date().toISOString() } = {}) {
  const items = [];
  for (const [offset, configuredUrl] of PHASE3C1_FIXED_IMPORT_URLS.entries()) {
    const ordinal = offset + 1;
    const officialUrl = canonical(configuredUrl);
    const response = await fetchImpl(officialUrl, {
      headers: { 'user-agent': 'TaxPolicyKnowledgeBase/0.3 (phase3c1-controlled-preview)' },
      signal: AbortSignal.timeout(20_000)
    });
    const rawHtml = await response.text();
    if (!response.ok) throw new Error(`Phase 3C-1 官方详情请求失败：${response.status} (${ordinal})`);
    const parsed = parseChinaTaxPolicyEvidence(rawHtml);
    const metadata = suggestEvidenceMetadata({ title: parsed.title, normalized_text: parsed.normalized_text, generated_at: now });
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
    const risk = evaluateCandidateRisk(syntheticRiskDetail({ ordinal, officialUrl, rawHtml, parsed, fields }));
    const proposals = proposeCandidateRelations({ normalized_text: parsed.normalized_text });
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
      parser_version: PHASE3C1_IMPORT_PARSER_VERSION,
      risk_assessment: { ...risk, assessment_hash: sha256(stable(risk)) },
      metadata_suggestion: {
        rule_version: metadata.rule_version,
        input_body_sha256: metadata.input_body_sha256,
        suggestion_hash: sha256(stable(metadata)),
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
    if (issues.length) throw new Error(`Phase 3C-1 固定条目 ${ordinal} 不再满足冻结条件：${issues.join(',')}`);
    items.push(Object.freeze(item));
  }
  if (items.length !== PHASE3C1_FIXED_IMPORT_URLS.length) throw new Error('Phase 3C-1 固定清单数量异常。');
  return Object.freeze({
    manifest_key: PHASE3C1_IMPORT_MANIFEST_KEY,
    selection_criteria: PHASE3C1_IMPORT_SELECTION_CRITERIA,
    created_at: now,
    items: Object.freeze(items),
    manifest_hash: phase3c1ManifestFingerprint({ items })
  });
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
