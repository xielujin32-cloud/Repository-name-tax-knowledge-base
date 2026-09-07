import { createHash } from 'node:crypto';

export const CANDIDATE_RISK_RULE_VERSION = 'candidate-risk-rules-v1';

const TEMPLATE_MARKERS = Object.freeze([
  '国家税务总局政策法规库', '本站热词', '个人中心', '简 / 繁', '登录 EN', '发票查询'
]);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const sha256 = (value) => createHash('sha256').update(String(value || '')).digest('hex');
const stable = (value) => Array.isArray(value)
  ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const array = (value) => Array.isArray(value) ? value : [];
const text = (value) => String(value || '').trim();

function reason(code, score, field, evidence = {}, { hardBlocker = false } = {}) {
  return { code, score, field, evidence, hard_blocker: hardBlocker };
}

function markerHits(body) {
  return TEMPLATE_MARKERS.flatMap((marker) => {
    const start = body.indexOf(marker);
    return start < 0 ? [] : [{ marker, start, end: start + marker.length }];
  });
}

function fieldDateProblems(fields) {
  return ['publish_date', 'effective_date', 'expiry_date'].flatMap((field) => {
    const value = fields[field];
    return value === null || value === undefined || value === '' || DATE_PATTERN.test(String(value))
      ? [] : [{ field, value: String(value) }];
  });
}

function evidenceChainProblems(detail, bodyHash) {
  const candidate = object(detail.candidate);
  const snapshot = object(detail.raw_snapshot);
  const run = object(detail.collection_run);
  const source = object(detail.source);
  const problems = [];
  if (!candidate.snapshot_id || candidate.snapshot_id !== snapshot.snapshot_id) problems.push('candidate.snapshot_id');
  if (!candidate.source_id || candidate.source_id !== snapshot.source_id || source.source_id !== snapshot.source_id) problems.push('source_id');
  if (!candidate.collection_run_id || candidate.collection_run_id !== snapshot.collection_run_id || run.collection_run_id !== snapshot.collection_run_id) problems.push('collection_run_id');
  if (run.source_id !== snapshot.source_id) problems.push('collection_run.source_id');
  if (!SHA256_PATTERN.test(text(snapshot.raw_sha256))) problems.push('raw_sha256');
  if (!SHA256_PATTERN.test(text(snapshot.normalized_text_sha256))) problems.push('snapshot.normalized_text_sha256');
  if (!SHA256_PATTERN.test(text(candidate.normalized_text_sha256)) || candidate.normalized_text_sha256 !== bodyHash) problems.push('candidate.normalized_text_sha256');
  if (snapshot.raw_html !== undefined && sha256(snapshot.raw_html) !== snapshot.raw_sha256) problems.push('raw_sha256_content');
  if (candidate.parsed_normalized_text === null && sha256(snapshot.normalized_text) !== snapshot.normalized_text_sha256) problems.push('snapshot.normalized_text_sha256_content');
  return problems;
}

function sourceProblem(detail) {
  const candidate = object(detail.candidate);
  const source = object(detail.source);
  try {
    const host = new URL(text(candidate.official_url)).hostname.toLowerCase();
    return !source.enabled || !text(source.official_domain) || host !== text(source.official_domain).toLowerCase();
  } catch {
    return true;
  }
}

function trustedDocumentNo(fields) {
  const source = text(fields.document_no_source);
  const confidence = text(fields.document_no_confidence);
  return Boolean(text(fields.document_no))
    && confidence === 'high'
    && ['structured_field', 'title_nearby', 'body_lead'].includes(source);
}

/**
 * Deterministic Phase 3A risk evaluation. It only describes data quality and
 * evidence risk; it never returns or changes a legal-status conclusion.
 */
export function evaluateCandidateRisk(detail, { ruleVersion = CANDIDATE_RISK_RULE_VERSION, conflicts = {} } = {}) {
  const candidate = object(detail.candidate);
  const snapshot = object(detail.raw_snapshot);
  const fields = object(candidate.parsed_fields);
  const normalization = object(fields.normalization);
  const body = candidate.parsed_normalized_text === null || candidate.parsed_normalized_text === undefined
    ? String(snapshot.normalized_text || '')
    : String(candidate.parsed_normalized_text || '');
  const bodyHash = sha256(body);
  const parserVersion = text(normalization.parser_version || snapshot.parser_version || 'unknown');
  const reasons = [];
  const add = (...args) => reasons.push(reason(...args));

  const chainProblems = evidenceChainProblems(detail, bodyHash);
  if (chainProblems.length) add('EVIDENCE_CHAIN_INVALID', 100, 'evidence_chain', { problems: chainProblems }, { hardBlocker: true });
  if (sourceProblem(detail)) add('SOURCE_PROVENANCE_INVALID', 100, 'source', { official_url: candidate.official_url || null, official_domain: detail.source?.official_domain || null }, { hardBlocker: true });
  if (Number(snapshot.http_status) !== 200) add('HTTP_STATUS_INVALID', 100, 'raw_snapshot.http_status', { http_status: snapshot.http_status ?? null }, { hardBlocker: true });

  const templateHits = markerHits(body);
  if (templateHits.length) add('TEMPLATE_POLLUTION', 100, 'normalized_text', { hits: templateHits }, { hardBlocker: true });
  if (body.length < 80) add('BODY_SEVERELY_SHORT', 100, 'normalized_text', { length: body.length, threshold: 80 }, { hardBlocker: true });
  else if (body.length < 300) add('BODY_SHORT', 35, 'normalized_text', { length: body.length, threshold: 300 });

  if (!text(fields.title)) add('TITLE_MISSING', 100, 'title', {}, { hardBlocker: true });
  if (!text(fields.document_no)) add('DOCUMENT_NO_MISSING', 12, 'document_no');
  if (!array(fields.issuing_authority).map(text).filter(Boolean).length) add('ISSUING_AUTHORITY_MISSING', 15, 'issuing_authority');
  if (!text(fields.publish_date)) add('PUBLISH_DATE_MISSING', 15, 'publish_date');
  const invalidDates = fieldDateProblems(fields);
  if (invalidDates.length) add('DATE_FORMAT_INVALID', 100, 'dates', { fields: invalidDates }, { hardBlocker: true });

  const metadataSuggestion = object(fields.metadata_suggestion);
  if (metadataSuggestion.input_body_sha256 && metadataSuggestion.input_body_sha256 !== bodyHash) {
    add('METADATA_BODY_HASH_MISMATCH', 20, 'metadata_suggestion.input_body_sha256', {
      expected: bodyHash,
      actual: metadataSuggestion.input_body_sha256
    });
  }
  // A document number can be a cited instrument unless the parser recorded
  // narrow, current-document provenance. Never turn unproven text into a
  // duplicate hard blocker.
  if (trustedDocumentNo(fields) && conflicts.document_no_conflicts?.length) {
    add('DOCUMENT_NO_CONFLICT', 100, 'document_no', { conflicts: conflicts.document_no_conflicts }, { hardBlocker: true });
  }
  if (conflicts.suspected_version_changes?.length) {
    add('SUSPECTED_VERSION_CHANGE', 30, 'canonical_url', { candidates: conflicts.suspected_version_changes });
  }
  if (conflicts.relation_conflicts?.length) {
    add('POLICY_RELATION_CONFLICT', 100, 'policy_relation', { conflicts: conflicts.relation_conflicts }, { hardBlocker: true });
  }

  const hardBlocker = reasons.some((item) => item.hard_blocker);
  const riskScore = hardBlocker ? 100 : Math.min(100, reasons.reduce((total, item) => total + item.score, 0));
  const riskLevel = hardBlocker || riskScore >= 50 ? 'high' : riskScore >= 15 ? 'medium' : 'low';
  const inputContextHash = sha256(stable({
    source_id: candidate.source_id || null,
    snapshot_id: candidate.snapshot_id || null,
    collection_run_id: candidate.collection_run_id || null,
    http_status: snapshot.http_status ?? null,
    title: fields.title || null,
    document_no: fields.document_no || null,
    document_no_source: fields.document_no_source || 'missing',
    document_no_confidence: fields.document_no_confidence || 'none',
    issuing_authority: array(fields.issuing_authority).map(text).filter(Boolean),
    publish_date: fields.publish_date || null,
    metadata_suggestion_input_body_sha256: metadataSuggestion.input_body_sha256 || null,
    conflicts
  }));
  return Object.freeze({
    rule_version: text(ruleVersion),
    input_body_sha256: bodyHash,
    parser_version: parserVersion,
    input_context_sha256: inputContextHash,
    risk_level: riskLevel,
    risk_score: riskScore,
    risk_reasons: reasons,
    quality_metrics: {
      normalized_text_length: body.length,
      template_markers: templateHits,
      http_status: snapshot.http_status ?? null,
      source_provenance_valid: !sourceProblem(detail),
      evidence_chain_valid: !chainProblems.length,
      title_present: Boolean(text(fields.title)),
      document_no_present: Boolean(text(fields.document_no)),
      document_no_trusted: trustedDocumentNo(fields),
      issuing_authority_present: Boolean(array(fields.issuing_authority).map(text).filter(Boolean).length),
      publish_date_present: Boolean(text(fields.publish_date)),
      parser_version: parserVersion,
      metadata_suggestion_hash_matches: !metadataSuggestion.input_body_sha256 || metadataSuggestion.input_body_sha256 === bodyHash
    }
  });
}
