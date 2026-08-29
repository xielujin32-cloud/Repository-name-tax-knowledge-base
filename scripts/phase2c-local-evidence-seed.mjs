import { NetlifyDB } from '@netlify/database-dev';
import path from 'node:path';
import { createPostgresEvidenceRepository } from '../src/postgres-evidence-repository.js';
import { createLocalEvidenceObjectStore } from '../src/evidence-object-store.js';
import { CHINA_TAX_POLICY_SOURCE } from '../src/chinatax-evidence-adapter.js';
import { PHASE_2B_ALLOWED_DETAIL_URLS, parseChinaTaxPolicyEvidence } from '../src/chinatax-evidence-collection.js';

const database = new NetlifyDB({ directory: path.join(process.cwd(), '.netlify', 'phase2c-evidence-db'), logger: () => {} });
await database.start();
await database.reset();
await database.applyMigrations(path.join(process.cwd(), 'netlify', 'database', 'migrations'));
const repository = createPostgresEvidenceRepository({ pool: database, objectStore: createLocalEvidenceObjectStore() });
const source = await repository.addSource({ ...CHINA_TAX_POLICY_SOURCE, adapter_version: '2.0.0-phase2c', base_url: CHINA_TAX_POLICY_SOURCE.collection_url });

async function capture(url, run) {
  const response = await fetch(url, { headers: { 'user-agent': 'TaxPolicyKnowledgeBase/0.2 (phase2c-local-test)' }, signal: AbortSignal.timeout(20_000) });
  const raw = await response.text();
  if (!response.ok) throw new Error(`官方详情读取失败：${response.status}`);
  const parsed = parseChinaTaxPolicyEvidence(raw);
  const snapshot = await repository.recordRawSnapshot({ source_id: source.source_id, collection_run_id: run.collection_run_id, official_url: url, canonical_url: url, http_status: response.status, response_headers_subset: { 'content-type': response.headers.get('content-type') || '' }, content_type: response.headers.get('content-type') || 'text/html', raw_content: raw, normalized_text: parsed.normalized_text, parser_version: 'chinatax-evidence-2.0.0-phase2c', parse_result: parsed });
  const candidate = await repository.createCandidate({ snapshot_id: snapshot.snapshot_id, parsed_fields: { title: parsed.title, document_no: parsed.document_no, issuing_authority: parsed.issuing_authority, publish_date: parsed.publish_date, effective_date: parsed.effective_date, expiry_date: parsed.expiry_date }, verification_state: 'pending_review', legal_status: 'pending' });
  return { snapshot, candidate };
}

const firstRun = await repository.createCollectionRun({ source_id: source.source_id, mode: 'phase2c-local-seed' });
const first = []; for (const url of PHASE_2B_ALLOWED_DETAIL_URLS) first.push(await capture(url, firstRun)); await repository.finishCollectionRun(firstRun.collection_run_id);
const secondRun = await repository.createCollectionRun({ source_id: source.source_id, mode: 'phase2c-local-repeat' });
const second = []; for (const url of PHASE_2B_ALLOWED_DETAIL_URLS) second.push(await capture(url, secondRun)); await repository.finishCollectionRun(secondRun.collection_run_id);
console.log(JSON.stringify({ first: { snapshots: first.length, candidates: first.filter((x) => x.candidate.created).length }, second: { snapshots: second.length, candidates: second.filter((x) => x.candidate.created).length }, candidate_ids: first.map((x) => x.candidate.candidate.candidate_id), snapshot_ids: first.map((x) => x.snapshot.snapshot_id) }, null, 2));
await repository.close();
await database.stop();
