import { POLICY_STATUSES, dateOnlyOrNull, validatePolicy } from './policy-schema.js';

const ARRAY_FIELDS = Object.freeze(['issuing_authority', 'tax_categories', 'topics', 'region', 'applicable_entities', 'keywords', 'key_points', 'related_policies']);
const TEXT_FIELDS = Object.freeze(['title', 'document_no', 'summary', 'practical_guidance']);
const DATE_FIELDS = Object.freeze(['publish_date', 'effective_date', 'expiry_date']);

function textOrNull(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
}

function safeDate(value, field) {
  const date = dateOnlyOrNull(value);
  if (value !== null && value !== undefined && String(value).trim() && !date) throw new Error(`${field} 必须为 YYYY-MM-DD 或空值。`);
  return date;
}

export function reviewFieldsFromCandidate(parsedFields = {}) {
  return {
    title: textOrNull(parsedFields.title) || '',
    document_no: textOrNull(parsedFields.document_no),
    issuing_authority: stringArray(parsedFields.issuing_authority),
    publish_date: dateOnlyOrNull(parsedFields.publish_date),
    effective_date: dateOnlyOrNull(parsedFields.effective_date),
    expiry_date: dateOnlyOrNull(parsedFields.expiry_date),
    tax_categories: stringArray(parsedFields.tax_categories),
    topics: stringArray(parsedFields.topics),
    region: stringArray(parsedFields.region),
    applicable_entities: stringArray(parsedFields.applicable_entities),
    keywords: stringArray(parsedFields.keywords),
    summary: textOrNull(parsedFields.summary),
    key_points: stringArray(parsedFields.key_points),
    practical_guidance: textOrNull(parsedFields.practical_guidance),
    related_policies: stringArray(parsedFields.related_policies)
  };
}

export function normalizeReviewFields(parsedFields = {}, overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('审核字段必须是对象。');
  const allowed = new Set([...TEXT_FIELDS, ...ARRAY_FIELDS, ...DATE_FIELDS]);
  for (const key of Object.keys(overrides)) if (!allowed.has(key)) throw new Error(`不允许修改审核字段：${key}`);
  const fields = reviewFieldsFromCandidate(parsedFields);
  for (const field of TEXT_FIELDS) if (field in overrides) fields[field] = textOrNull(overrides[field]);
  for (const field of ARRAY_FIELDS) if (field in overrides) {
    if (!Array.isArray(overrides[field])) throw new Error(`${field} 必须为字符串数组。`);
    fields[field] = stringArray(overrides[field]);
  }
  for (const field of DATE_FIELDS) if (field in overrides) fields[field] = safeDate(overrides[field], field);
  if (!fields.title) throw new Error('审核发布必须确认政策标题。');
  return fields;
}

export function buildPublicPolicyProjection({ candidate, source, reviewDecision, policy, policyVersion, confirmedFields, normalizedText, now = new Date() }) {
  const reviewedDate = now.toISOString().slice(0, 10);
  const projection = {
    id: policy.policy_id,
    title: confirmedFields.title,
    document_no: confirmedFields.document_no,
    issuing_authority: confirmedFields.issuing_authority,
    publish_date: confirmedFields.publish_date,
    effective_date: confirmedFields.effective_date,
    expiry_date: confirmedFields.expiry_date,
    status: reviewDecision.legal_status,
    tax_categories: confirmedFields.tax_categories,
    topics: confirmedFields.topics,
    region: confirmedFields.region,
    applicable_entities: confirmedFields.applicable_entities,
    keywords: [...new Set([confirmedFields.title, confirmedFields.document_no, ...confirmedFields.keywords].filter(Boolean))],
    summary: confirmedFields.summary,
    key_points: confirmedFields.key_points,
    practical_guidance: confirmedFields.practical_guidance,
    source_url: candidate.official_url,
    source_name: source.source_name,
    related_policies: confirmedFields.related_policies,
    last_verified_date: reviewedDate,
    created_at: dateOnlyOrNull(candidate.created_at) || reviewedDate,
    updated_at: reviewedDate,
    evidence: {
      candidate_id: candidate.candidate_id,
      review_decision_id: reviewDecision.review_decision_id,
      policy_version_id: policyVersion.policy_version_id,
      source_id: source.source_id,
      official_url: candidate.official_url,
      normalized_text: String(normalizedText || '')
    }
  };
  if (!POLICY_STATUSES.includes(projection.status)) throw new Error('审核效力状态无效。');
  const errors = validatePolicy(projection);
  if (errors.length) throw new Error(`公开政策投影校验失败：${errors.join('；')}`);
  return projection;
}
