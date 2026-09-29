import { getStore } from '@netlify/blobs';
import { POLICY_SCHEMA_VERSION, publicPolicyAvailability, validatePolicies } from '../../src/policy-schema.js';

export const POLICY_STORE_NAME = 'taxkb-policies';
export const POLICY_INDEX_KEY = 'policy-index-v1';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function policyKey(id) {
  return `policy:${encodeURIComponent(id)}`;
}

function defaultIndex() {
  return { version: POLICY_SCHEMA_VERSION, entries: [] };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function policyListEntry(policy) {
  const availability = publicPolicyAvailability(policy);
  return {
    id: policy.id,
    title: policy.title,
    document_no: policy.document_no,
    issuing_authority: clone(policy.issuing_authority),
    publish_date: policy.publish_date,
    effective_date: policy.effective_date,
    expiry_date: policy.expiry_date,
    status: policy.status,
    tax_categories: clone(policy.tax_categories),
    topics: clone(policy.topics),
    region: clone(policy.region),
    applicable_entities: clone(policy.applicable_entities),
    keywords: clone(policy.keywords),
    summary: policy.summary,
    source_name: policy.source_name,
    source_url: policy.source_url,
    source_id: policy.evidence?.source_id || null,
    source_trust_level: policy.source_trust_level || 'unknown',
    verification_state: policy.verification_state || 'legacy_unverified',
    policy_version_id: policy.policy_version_id || policy.evidence?.policy_version_id || null,
    review: policy.review ? {
      reviewer_level: policy.review.reviewer_level,
      decision: policy.review.decision,
      decided_at: policy.review.decided_at || null
    } : null,
    evidence: policy.evidence ? {
      candidate_id: policy.evidence.candidate_id || null,
      review_decision_id: policy.evidence.review_decision_id || null,
      policy_version_id: policy.evidence.policy_version_id || null,
      source_id: policy.evidence.source_id || null,
      official_url: policy.evidence.official_url || policy.source_url || null,
      body_hash: policy.evidence.body_hash || null
    } : null,
    version_relations: clone(policy.version_relations || []),
    public_policy_eligible: availability.eligible,
    last_verified_date: policy.last_verified_date,
    updated_at: policy.updated_at
  };
}

async function readIndexFrom(store) {
  const saved = await store.get(POLICY_INDEX_KEY, { type: 'json' });
  if (!saved) return defaultIndex();
  if (!Array.isArray(saved.entries)) throw new Error('政策索引格式无效。');
  const ids = new Set();
  for (const entry of saved.entries) {
    if (typeof entry?.id !== 'string' || !entry.id.trim()) throw new Error('政策索引包含空 id。');
    if (ids.has(entry.id)) throw new Error(`政策索引包含重复 id：${entry.id}`);
    ids.add(entry.id);
  }
  return { version: saved.version || POLICY_SCHEMA_VERSION, entries: saved.entries };
}

function matchesQuery(entry, query) {
  if (!query) return true;
  const term = String(query).toLocaleLowerCase('zh-CN').replace(/\s+/g, '');
  const corpus = [entry.title, entry.document_no, ...(entry.tax_categories || []), ...(entry.topics || []), ...(entry.region || []), ...(entry.keywords || []), entry.summary, entry.source_name, ...(entry.issuing_authority || [])]
    .filter(Boolean).join(' ').toLocaleLowerCase('zh-CN').replace(/\s+/g, '');
  return corpus.includes(term);
}

function normalized(value) {
  return String(value || '').toLocaleLowerCase('zh-CN').replace(/[\s\-—_（）()\[\]【】〔〕]/g, '');
}

function requestedValues(value) {
  return new Set(String(value || '').split(',').map((item) => item.trim()).filter(Boolean));
}

function dateInRange(value, from, to) {
  if (!value) return false;
  return (!from || String(value) >= String(from)) && (!to || String(value) <= String(to));
}

function sourceMatches(entry, source) {
  if (!source) return true;
  const target = normalized(source);
  return [entry.source_id, entry.source_name, ...(entry.issuing_authority || [])]
    .filter(Boolean).some((value) => normalized(value).includes(target));
}

function documentNoMatches(entry, documentNo) {
  return !documentNo || normalized(entry.document_no).includes(normalized(documentNo));
}

function sortEntries(entries, { query = '', sort = '' } = {}) {
  const ranked = [...entries];
  if (sort === 'publish_date_asc') return ranked.sort((a, b) => String(a.publish_date || '').localeCompare(String(b.publish_date || '')) || a.id.localeCompare(b.id));
  if (sort === 'publish_date_desc' || !query) return ranked.sort((a, b) => String(b.publish_date || '').localeCompare(String(a.publish_date || '')) || String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  const queryText = normalized(query);
  return ranked.sort((a, b) => {
    const score = (entry) => (normalized(entry.document_no) === queryText ? 30 : 0)
      + (normalized(entry.title).includes(queryText) ? 20 : 0)
      + ((entry.keywords || []).some((item) => normalized(item) === queryText) ? 10 : 0);
    return score(b) - score(a) || String(b.publish_date || '').localeCompare(String(a.publish_date || ''));
  });
}

export async function listPolicies({ query = '', documentNo = '', taxCategory = '', status = '', source = '', authority = '', region = '', publishedFrom = '', publishedTo = '', effectiveFrom = '', effectiveTo = '', sort = '', limit = 30, offset = 0 } = {}) {
  const index = await readIndexFrom(getStore(POLICY_STORE_NAME));
  const statuses = requestedValues(status);
  const entries = index.entries.filter((entry) => entry.public_policy_eligible === true
    && matchesQuery(entry, query)
    && documentNoMatches(entry, documentNo)
    && (!taxCategory || (entry.tax_categories || []).includes(taxCategory))
    && (!statuses.size ? ['effective', 'partially_effective'].includes(entry.status) : (statuses.has('all') || statuses.has(entry.status)))
    && (!region || (entry.region || []).includes(region))
    && sourceMatches(entry, source)
    && sourceMatches({ ...entry, source_id: null, source_name: null, issuing_authority: entry.issuing_authority || [] }, authority)
    && dateInRange(entry.publish_date, publishedFrom, publishedTo)
    && dateInRange(entry.effective_date || entry.publish_date, effectiveFrom, effectiveTo));
  const start = Math.max(Number(offset) || 0, 0);
  const size = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const results = sortEntries(entries, { query, sort });
  return {
    total: results.length,
    results: results.slice(start, start + size),
    applied_filters: { query, document_no: documentNo, tax_category: taxCategory, status: status || 'effective,partially_effective', source, authority, region, published_from: publishedFrom || null, published_to: publishedTo || null, effective_from: effectiveFrom || null, effective_to: effectiveTo || null, sort: sort || (query ? 'relevance' : 'publish_date_desc') }
  };
}

export async function readPolicy(id) {
  const value = String(id || '').trim();
  if (!value) return null;
  const store = getStore(POLICY_STORE_NAME);
  const index = await readIndexFrom(store);
  const entry = index.entries.find((item) => item.id === value);
  if (!entry?.public_policy_eligible) return null;
  const policy = (await store.get(policyKey(value), { type: 'json' })) || null;
  return policy && publicPolicyAvailability(policy).eligible ? policy : null;
}

export async function importPolicies(policies, { dryRun = true } = {}) {
  const validation = validatePolicies(policies);
  if (!validation.valid) return { dryRun, total: Array.isArray(policies) ? policies.length : 0, added: 0, updated: 0, skipped: 0, errors: validation.errors };

  const store = getStore(POLICY_STORE_NAME);
  const index = await readIndexFrom(store);
  const entriesById = new Map(index.entries.map((entry) => [entry.id, entry]));
  const changes = [];
  let skipped = 0;
  for (const policy of policies) {
    const listed = entriesById.get(policy.id);
    if (!listed) {
      changes.push({ type: 'add', policy });
      continue;
    }
    const existing = await store.get(policyKey(policy.id), { type: 'json' });
    const nextEntry = policyListEntry(policy);
    if (existing && stableStringify(existing) === stableStringify(policy)) {
      if (stableStringify(listed) === stableStringify(nextEntry)) {
        skipped += 1;
        continue;
      }
      changes.push({ type: 'refresh', policy });
      continue;
    }
    changes.push({ type: 'update', policy });
  }

  const added = changes.filter((change) => change.type === 'add').length;
  const updated = changes.length - added;
  const result = { dryRun, total: policies.length, added, updated, skipped, errors: [] };
  if (dryRun) return result;

  for (const change of changes) if (change.type !== 'refresh') await store.setJSON(policyKey(change.policy.id), change.policy);
  const nextEntries = new Map(index.entries.map((entry) => [entry.id, entry]));
  for (const change of changes) nextEntries.set(change.policy.id, policyListEntry(change.policy));
  await store.setJSON(POLICY_INDEX_KEY, { version: POLICY_SCHEMA_VERSION, entries: [...nextEntries.values()] });
  return result;
}

/**
 * Removes already-published policies from public search when a confirmed
 * version relation requires fresh Level 3 assessment. It only changes the
 * public index visibility marker; Evidence, Policy, Version, and raw source
 * records remain immutable and untouched.
 */
export async function suppressPublicPoliciesForRelation({ policyVersionIds = [], reason = 'CONFIRMED_VERSION_RELATION_REQUIRES_LEVEL3_REVALIDATION' } = {}) {
  const versionIds = new Set((Array.isArray(policyVersionIds) ? policyVersionIds : []).map((value) => String(value || '').trim()).filter(Boolean));
  if (!versionIds.size) return { suppressed: 0, policy_ids: [], reason };
  const store = getStore(POLICY_STORE_NAME);
  const index = await readIndexFrom(store);
  const policyIds = [];
  const entries = index.entries.map((entry) => {
    if (!versionIds.has(String(entry.policy_version_id || ''))) return entry;
    policyIds.push(entry.id);
    return {
      ...entry,
      public_policy_eligible: false,
      publication_visibility: 'blocked_pending_level3_revalidation',
      publication_block_reason: reason
    };
  });
  if (policyIds.length) await store.setJSON(POLICY_INDEX_KEY, { version: POLICY_SCHEMA_VERSION, entries });
  return { suppressed: policyIds.length, policy_ids: policyIds, reason };
}
