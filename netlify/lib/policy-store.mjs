import { getStore } from '@netlify/blobs';
import { POLICY_SCHEMA_VERSION, validatePolicies } from '../../src/policy-schema.js';

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
  const corpus = [entry.title, entry.document_no, ...(entry.tax_categories || []), ...(entry.topics || []), ...(entry.region || []), ...(entry.keywords || []), entry.summary, entry.source_name]
    .filter(Boolean).join(' ').toLocaleLowerCase('zh-CN').replace(/\s+/g, '');
  return corpus.includes(term);
}

export async function listPolicies({ query = '', taxCategory = '', status = '', region = '', limit = 30, offset = 0 } = {}) {
  const index = await readIndexFrom(getStore(POLICY_STORE_NAME));
  const entries = index.entries.filter((entry) => matchesQuery(entry, query)
    && (!taxCategory || (entry.tax_categories || []).includes(taxCategory))
    && (!status || entry.status === status)
    && (!region || (entry.region || []).includes(region)));
  const start = Math.max(Number(offset) || 0, 0);
  const size = Math.min(Math.max(Number(limit) || 30, 1), 100);
  return { total: entries.length, results: entries.slice(start, start + size) };
}

export async function readPolicy(id) {
  const value = String(id || '').trim();
  if (!value) return null;
  return (await getStore(POLICY_STORE_NAME).get(policyKey(value), { type: 'json' })) || null;
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
    if (existing && stableStringify(existing) === stableStringify(policy)) {
      skipped += 1;
      continue;
    }
    changes.push({ type: 'update', policy });
  }

  const added = changes.filter((change) => change.type === 'add').length;
  const updated = changes.length - added;
  const result = { dryRun, total: policies.length, added, updated, skipped, errors: [] };
  if (dryRun) return result;

  for (const change of changes) await store.setJSON(policyKey(change.policy.id), change.policy);
  const nextEntries = new Map(index.entries.map((entry) => [entry.id, entry]));
  for (const change of changes) nextEntries.set(change.policy.id, policyListEntry(change.policy));
  await store.setJSON(POLICY_INDEX_KEY, { version: POLICY_SCHEMA_VERSION, entries: [...nextEntries.values()] });
  return result;
}
