export const POLICY_SCHEMA_VERSION = '1.0.0';
export const POLICY_STATUSES = Object.freeze(['effective', 'partially_effective', 'repealed', 'expired', 'pending']);
export const POLICY_REQUIRED_FIELDS = Object.freeze([
  'id', 'title', 'document_no', 'issuing_authority', 'publish_date', 'effective_date', 'expiry_date', 'status',
  'tax_categories', 'topics', 'region', 'applicable_entities', 'keywords', 'summary', 'key_points', 'practical_guidance',
  'source_url', 'source_name', 'related_policies', 'last_verified_date', 'created_at', 'updated_at'
]);
export const POLICY_ARRAY_FIELDS = Object.freeze(['issuing_authority', 'tax_categories', 'topics', 'region', 'applicable_entities', 'keywords', 'key_points', 'related_policies']);

const POLICY_DATE_FIELDS = Object.freeze(['publish_date', 'effective_date', 'expiry_date', 'last_verified_date', 'created_at', 'updated_at']);
const POLICY_NULLABLE_TEXT_FIELDS = Object.freeze(['document_no', 'summary', 'practical_guidance', 'source_url', 'source_name']);

const LEGACY_STATUS_MAP = Object.freeze({
  current: 'effective',
  revised: 'partially_effective',
  repealed: 'repealed',
  expired: 'expired',
  pending_verification: 'pending'
});

function isDateOrNull(value) {
  if (value === null) return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function validatePolicy(policy) {
  const errors = [];
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return ['policy 必须是对象。'];
  for (const field of POLICY_REQUIRED_FIELDS) if (!(field in policy)) errors.push(`缺少字段：${field}`);
  if (errors.length) return errors;
  if (typeof policy.id !== 'string' || !policy.id.trim()) errors.push('id 不能为空。');
  if (typeof policy.title !== 'string' || !policy.title.trim()) errors.push('title 不能为空。');
  if (!POLICY_STATUSES.includes(policy.status)) errors.push('status 必须是规定枚举值。');
  for (const field of POLICY_ARRAY_FIELDS) {
    if (!Array.isArray(policy[field])) errors.push(`${field} 必须是数组。`);
    else if (policy[field].some((value) => typeof value !== 'string')) errors.push(`${field} 只能包含字符串。`);
  }
  for (const field of POLICY_DATE_FIELDS) if (!isDateOrNull(policy[field])) errors.push(`${field} 必须为 YYYY-MM-DD 或 null。`);
  for (const field of POLICY_NULLABLE_TEXT_FIELDS) if (policy[field] !== null && typeof policy[field] !== 'string') errors.push(`${field} 必须为字符串或 null。`);
  return errors;
}

export function validatePolicies(policies) {
  const errors = [];
  if (!Array.isArray(policies)) return { valid: false, errors: ['policies 必须是数组。'] };
  const ids = new Set();
  policies.forEach((policy, index) => {
    for (const error of validatePolicy(policy)) errors.push(`第 ${index + 1} 条：${error}`);
    const id = typeof policy?.id === 'string' ? policy.id.trim() : '';
    if (id) {
      if (ids.has(id)) errors.push(`第 ${index + 1} 条：重复 id：${id}`);
      ids.add(id);
    }
  });
  return { valid: errors.length === 0, errors };
}

function textOrNull(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

export function dateOnlyOrNull(value) {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})(?:T.*)?$/);
  return match ? match[1] : null;
}

function stringArray(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean))];
}

export function policyFromLegacyDocument(document, sourceById = new Map()) {
  const title = textOrNull(document.title);
  const taxCategories = stringArray(document.taxTypes);
  const source = sourceById.get(document.sourceId);
  return {
    id: String(document.id),
    title,
    document_no: textOrNull(document.documentNumber),
    issuing_authority: textOrNull(document.authority) ? [textOrNull(document.authority)] : [],
    publish_date: dateOnlyOrNull(document.publishedAt),
    effective_date: dateOnlyOrNull(document.effectiveAt),
    expiry_date: null,
    status: LEGACY_STATUS_MAP[document.status] || 'pending',
    tax_categories: taxCategories,
    topics: [],
    region: [],
    applicable_entities: [],
    keywords: [...new Set([title, ...taxCategories].filter(Boolean))],
    summary: textOrNull(document.summary),
    key_points: [],
    practical_guidance: null,
    source_url: textOrNull(document.officialUrl),
    source_name: textOrNull(source?.name),
    related_policies: stringArray((document.relations || []).map((relation) => relation?.documentId)),
    last_verified_date: null,
    created_at: dateOnlyOrNull(document.createdAt),
    updated_at: null,
    legacy_document_id: String(document.id),
    legacy_status: textOrNull(document.status)
  };
}

export function ensurePolicySchema(data, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const sourceById = new Map((data.sources || []).map((source) => [source.id, source]));
  const documents = Array.isArray(data.documents) ? data.documents : [];
  let changed = false;

  if (!data.policy_schema || data.policy_schema.version !== POLICY_SCHEMA_VERSION) {
    data.policy_schema = {
      version: POLICY_SCHEMA_VERSION,
      canonical_collection: 'policies',
      legacy_collection: 'documents',
      date_format: 'YYYY-MM-DD'
    };
    changed = true;
  }
  if (!Array.isArray(data.policies)) {
    data.policies = [];
    changed = true;
  }

  const knownIds = new Set(data.policies.map((policy) => policy.id));
  const additions = documents
    .filter((document) => !knownIds.has(String(document.id)))
    .map((document) => policyFromLegacyDocument(document, sourceById));
  if (additions.length) {
    data.policies.push(...additions);
    changed = true;
  }

  if (!data.policy_migration || additions.length) {
    data.policy_migration = {
      source_collection: 'documents',
      migrated_policy_count: data.policies.length,
      last_migrated_date: today,
      note: '旧 documents 原样保留，policies 为标准化政策集合。'
    };
    changed = true;
  }
  return { changed, additions: additions.length };
}
