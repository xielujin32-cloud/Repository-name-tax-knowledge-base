import { createHash, randomUUID } from 'node:crypto';
import { getDatabase } from '@netlify/database';

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
const stable = (value) => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
const now = () => new Date().toISOString();
const required = (value, label) => { const text = String(value || '').trim(); if (!text) throw new Error(`${label} 不能为空。`); return text; };
const canonical = (value) => { const url = new URL(required(value, 'official_url')); url.hash = ''; return url.toString(); };

export function createPostgresEvidenceRepository({ pool = getDatabase().pool, objectStore, id = (prefix) => `${prefix}-${randomUUID()}`, clock = now } = {}) {
  if (!objectStore) throw new Error('持久化 Evidence Repository 必须提供独立 objectStore。');
  async function addSource(input) {
    const source = { source_id: required(input.source_id || id('source'), 'source_id'), source_name: required(input.source_name, 'source_name'), official_domain: required(input.official_domain, 'official_domain'), source_type: required(input.source_type, 'source_type'), adapter_version: required(input.adapter_version, 'adapter_version'), base_url: input.base_url ? canonical(input.base_url) : null, enabled: input.enabled !== false, created_at: clock() };
    await pool.query(`INSERT INTO sources (source_id,source_name,official_domain,source_type,adapter_version,base_url,enabled,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) ON CONFLICT (source_id) DO NOTHING`, [source.source_id,source.source_name,source.official_domain,source.source_type,source.adapter_version,source.base_url,source.enabled,source.created_at]);
    await pool.query(`INSERT INTO source_states (source_id,updated_at) VALUES ($1,$2) ON CONFLICT (source_id) DO NOTHING`, [source.source_id,clock()]);
    return (await pool.query('SELECT * FROM sources WHERE source_id=$1',[source.source_id])).rows[0];
  }
  async function createCollectionRun({ source_id, collection_run_id = id('collection-run'), mode = 'manual', collection_state = 'running' }) {
    const started_at = clock(); await pool.query(`INSERT INTO collection_runs (collection_run_id,source_id,mode,collection_state,started_at) VALUES ($1,$2,$3,$4,$5)`,[collection_run_id,source_id,mode,collection_state,started_at]); return (await pool.query('SELECT * FROM collection_runs WHERE collection_run_id=$1',[collection_run_id])).rows[0];
  }
  async function finishCollectionRun(runId, collection_state='completed') { await pool.query('UPDATE collection_runs SET collection_state=$2, completed_at=$3 WHERE collection_run_id=$1',[runId,collection_state,clock()]); }
  async function recordRawSnapshot(input) {
    const snapshot_id = required(input.snapshot_id || id('snapshot'),'snapshot_id'); const official_url = canonical(input.official_url); const canonical_url = canonical(input.canonical_url || official_url); const raw = String(input.raw_content ?? ''); const normalized = String(input.normalized_text ?? raw); const raw_object_key=`raw-snapshots/${snapshot_id}/raw`; const normalized_text_object_key=`raw-snapshots/${snapshot_id}/normalized-text`;
    const inTransaction = async (work) => {
      if (typeof pool.transaction === 'function') return pool.transaction(work);
      const client = await pool.connect();
      try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    };
    try {
      await inTransaction(async (client) => { const existing = await client.query('SELECT 1 FROM raw_snapshots WHERE snapshot_id=$1',[snapshot_id]); if (existing.rows.length) throw new Error(`raw_snapshot 不可覆盖：${snapshot_id}`);
      const previous = await client.query('SELECT snapshot_id, normalized_text_sha256 FROM raw_snapshots WHERE source_id=$1 AND canonical_url=$2 ORDER BY fetched_at DESC LIMIT 1',[input.source_id,canonical_url]);
      await objectStore.putImmutable(raw_object_key,raw); await objectStore.putImmutable(normalized_text_object_key,normalized);
      const fetched_at=input.fetched_at || clock(); const raw_sha256=sha256(raw); const normalized_text_sha256=sha256(normalized); const previous_snapshot_id=previous.rows[0]?.snapshot_id || null; const content_changed=!previous.rows[0] || previous.rows[0].normalized_text_sha256!==normalized_text_sha256;
      await client.query(`INSERT INTO raw_snapshots (snapshot_id,source_id,collection_run_id,official_url,canonical_url,fetched_at,http_status,response_headers_subset,content_type,raw_object_key,normalized_text_object_key,raw_sha256,normalized_text_sha256,parser_version,parse_result_hash,previous_snapshot_id,content_changed) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,[snapshot_id,input.source_id,input.collection_run_id,official_url,canonical_url,fetched_at,Number(input.http_status||200),input.response_headers_subset||{},required(input.content_type||'text/html','content_type'),raw_object_key,normalized_text_object_key,raw_sha256,normalized_text_sha256,required(input.parser_version||'1.0.0','parser_version'),sha256(stable(input.parse_result||{})),previous_snapshot_id,content_changed]);
      await client.query('UPDATE collection_runs SET discovered_count=discovered_count+1 WHERE collection_run_id=$1',[input.collection_run_id]); }); return (await pool.query('SELECT * FROM raw_snapshots WHERE snapshot_id=$1',[snapshot_id])).rows[0];
    } catch (error) { throw error; }
  }
  async function createCandidate({ snapshot_id, candidate_id = id('candidate'), parsed_fields = {}, verification_state='pending_review', legal_status='pending' }) {
    const snapshot=(await pool.query('SELECT * FROM raw_snapshots WHERE snapshot_id=$1',[snapshot_id])).rows[0]; if(!snapshot) throw new Error(`snapshot 不存在：${snapshot_id}`); const timestamp=clock();
    const inserted=await pool.query(`INSERT INTO candidates (candidate_id,snapshot_id,source_id,collection_run_id,official_url,canonical_url,normalized_text_sha256,parsed_fields,verification_state,legal_status,observed_snapshot_ids,last_seen_snapshot_id,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$2,$12,$12) ON CONFLICT (source_id,canonical_url,normalized_text_sha256) DO NOTHING RETURNING *`,[candidate_id,snapshot_id,snapshot.source_id,snapshot.collection_run_id,snapshot.official_url,snapshot.canonical_url,snapshot.normalized_text_sha256,parsed_fields,verification_state,legal_status,JSON.stringify([snapshot_id]),timestamp]);
    if(inserted.rows.length) return {candidate:inserted.rows[0],created:true};
    const existing=(await pool.query('SELECT * FROM candidates WHERE source_id=$1 AND canonical_url=$2 AND normalized_text_sha256=$3',[snapshot.source_id,snapshot.canonical_url,snapshot.normalized_text_sha256])).rows[0]; const observed=new Set(existing.observed_snapshot_ids); observed.add(snapshot_id); await pool.query('UPDATE candidates SET last_seen_snapshot_id=$2, observed_snapshot_ids=$3, updated_at=$4 WHERE candidate_id=$1',[existing.candidate_id,snapshot_id,JSON.stringify([...observed]),timestamp]); return {candidate:(await pool.query('SELECT * FROM candidates WHERE candidate_id=$1',[existing.candidate_id])).rows[0],created:false};
  }
  async function traceCandidate(candidateId) { const result=await pool.query(`SELECT c.*, row_to_json(s.*) AS raw_snapshot, row_to_json(r.*) AS collection_run, row_to_json(so.*) AS source FROM candidates c JOIN raw_snapshots s ON s.snapshot_id=c.snapshot_id JOIN collection_runs r ON r.collection_run_id=s.collection_run_id JOIN sources so ON so.source_id=s.source_id WHERE c.candidate_id=$1`,[candidateId]); if(!result.rows.length) throw new Error(`candidate 不存在：${candidateId}`); return result.rows[0]; }
  async function listCandidateStatuses({ limit = 100 } = {}) { const size=Math.min(Math.max(Number(limit)||100,1),100); return (await pool.query('SELECT candidate_id,snapshot_id,last_seen_snapshot_id,source_id,official_url,verification_state,legal_status,created_at,updated_at FROM candidates ORDER BY created_at ASC LIMIT $1',[size])).rows; }
  async function counts() { const tables=['sources','source_states','collection_runs','raw_snapshots','candidates','review_decisions','policies','policy_versions','policy_relations','audit_events']; const output={}; for(const table of tables) output[table]=(await pool.query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0].count; return output; }
  return Object.freeze({addSource,createCollectionRun,finishCollectionRun,recordRawSnapshot,createCandidate,traceCandidate,listCandidateStatuses,counts,readRawObject:(key)=>objectStore.read(key),close:()=>pool.end?.()});
}
