import { createHash } from 'node:crypto';
import { normalizeReviewFields } from './evidence-review.js';

export const LOW_RISK_BATCH_CONFIRMATION = 'CONFIRM_LOW_RISK_BATCH';

const sha256 = (value) => createHash('sha256').update(String(value || '')).digest('hex');
const stable = (value) => Array.isArray(value)
  ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
    : JSON.stringify(value);

export function sampleSizeForBatch(batchSize) {
  const size = Number(batchSize);
  if (!Number.isInteger(size) || size < 1) throw new Error('batch_size 必须为正整数。');
  return Math.min(size, Math.max(10, Math.ceil(size * 0.1)));
}

export function chooseSampleCandidateIds(candidateIds, samplingSeed) {
  const values = [...new Set((candidateIds || []).map((value) => String(value || '').trim()).filter(Boolean))];
  const count = sampleSizeForBatch(values.length);
  const seed = String(samplingSeed || '').trim();
  if (!seed) throw new Error('sampling_seed 不能为空。');
  return values
    .map((candidateId) => ({ candidateId, rank: sha256(`${seed}:${candidateId}`) }))
    .sort((left, right) => left.rank.localeCompare(right.rank) || left.candidateId.localeCompare(right.candidateId))
    .slice(0, count)
    .map((item) => item.candidateId);
}

export function confirmedFieldsFromLowRiskCandidate(parsedFields = {}) {
  const suggestion = parsedFields.metadata_suggestion || {};
  return normalizeReviewFields(parsedFields, {
    tax_categories: suggestion.tax_categories?.values || parsedFields.tax_categories || [],
    keywords: suggestion.keywords?.values || parsedFields.keywords || [],
    summary: suggestion.summary?.value || parsedFields.summary || null
  });
}

export function manifestHash({ filter_spec, risk_rule_version, sampling_seed, items }) {
  return sha256(stable({
    filter_spec,
    risk_rule_version,
    sampling_seed,
    items: [...items].map((item) => ({
      candidate_id: item.candidate_id,
      assessment_id: item.assessment_id,
      snapshot_id: item.snapshot_id,
      input_body_sha256: item.input_body_sha256,
      parser_version: item.parser_version,
      metadata_rule_version: item.metadata_rule_version,
      metadata_input_body_sha256: item.metadata_input_body_sha256
    })).sort((left, right) => left.candidate_id.localeCompare(right.candidate_id))
  }));
}

export function lowRiskEligibility(detail, assessment, { expectedRuleVersion = assessment?.rule_version, activeProposalCount = 0 } = {}) {
  const candidate = detail?.candidate || {};
  const snapshot = detail?.raw_snapshot || {};
  const source = detail?.source || {};
  const run = detail?.collection_run || {};
  const fields = candidate.parsed_fields || {};
  const suggestion = fields.metadata_suggestion || {};
  const body = candidate.parsed_normalized_text ?? snapshot.normalized_text ?? '';
  const parserVersion = fields.normalization?.parser_version || snapshot.parser_version || '';
  const reasons = [];
  if (candidate.verification_state !== 'pending_review') reasons.push('CANDIDATE_NOT_PENDING_REVIEW');
  if (candidate.legal_status !== 'pending') reasons.push('LEGAL_STATUS_NOT_PENDING');
  if (!assessment?.is_current || assessment.risk_level !== 'low' || Number(assessment.risk_score) >= 15) reasons.push('ASSESSMENT_NOT_LOW');
  if (!assessment?.assessment_id || assessment.rule_version !== expectedRuleVersion) reasons.push('RISK_RULE_VERSION_MISMATCH');
  if (assessment?.input_body_sha256 !== candidate.normalized_text_sha256) reasons.push('RISK_BODY_HASH_MISMATCH');
  if (assessment?.parser_version !== parserVersion) reasons.push('RISK_PARSER_VERSION_MISMATCH');
  if (!candidate.snapshot_id || candidate.snapshot_id !== snapshot.snapshot_id || candidate.source_id !== source.source_id || candidate.collection_run_id !== run.collection_run_id || run.source_id !== source.source_id) reasons.push('EVIDENCE_CHAIN_CHANGED');
  if (Number(snapshot.http_status) !== 200 || source.enabled !== true) reasons.push('SOURCE_OR_HTTP_INVALID');
  if (!String(fields.title || '').trim() || !Array.isArray(fields.issuing_authority) || !fields.issuing_authority.filter(Boolean).length || !String(fields.publish_date || '').trim()) reasons.push('CORE_FIELDS_INCOMPLETE');
  if (!suggestion.rule_version || suggestion.input_body_sha256 !== candidate.normalized_text_sha256) reasons.push('METADATA_SUGGESTION_STALE');
  if (activeProposalCount > 0) reasons.push('RELATION_PROPOSAL_PENDING');
  return Object.freeze({ eligible: reasons.length === 0, reasons, body, parser_version: parserVersion, metadata_rule_version: suggestion.rule_version || null, metadata_input_body_sha256: suggestion.input_body_sha256 || null });
}
