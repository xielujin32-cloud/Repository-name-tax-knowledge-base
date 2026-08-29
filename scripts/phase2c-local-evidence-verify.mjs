import { NetlifyDB } from '@netlify/database-dev';
import path from 'node:path';
import { createPostgresEvidenceRepository } from '../src/postgres-evidence-repository.js';
import { createLocalEvidenceObjectStore } from '../src/evidence-object-store.js';

const database = new NetlifyDB({ directory: path.join(process.cwd(), '.netlify', 'phase2c-evidence-db'), logger: () => {} });
await database.start();
await database.applyMigrations(path.join(process.cwd(), 'netlify', 'database', 'migrations'));
const repository = createPostgresEvidenceRepository({ pool: database, objectStore: createLocalEvidenceObjectStore() });
const rows = (await database.query(`SELECT candidate_id FROM candidates WHERE source_id='source-sta-policy-regulations' ORDER BY created_at`)).rows;
if (rows.length < 2) throw new Error(`本地持久化 Candidate 不足：${rows.length}`);
const traces = []; for (const row of rows.slice(0, 2)) { const trace = await repository.traceCandidate(row.candidate_id); const raw = await repository.readRawObject(trace.raw_snapshot.raw_object_key); const normalized = await repository.readRawObject(trace.raw_snapshot.normalized_text_object_key); if (!raw || !normalized || !trace.source.official_domain || !trace.raw_snapshot.official_url) throw new Error('Evidence trace 不完整。'); traces.push({ candidate_id: trace.candidate_id, snapshot_id: trace.snapshot_id, official_url: trace.raw_snapshot.official_url, verification_state: trace.verification_state, legal_status: trace.legal_status }); }
console.log(JSON.stringify({ persisted_candidates: traces, counts: await repository.counts() }, null, 2));
await repository.close();
await database.stop();
