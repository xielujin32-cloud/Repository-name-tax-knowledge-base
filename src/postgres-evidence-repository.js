import { createHash, randomUUID } from 'node:crypto';
import { getDatabase } from '@netlify/database';
import { POLICY_STATUSES } from './policy-schema.js';

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
const stable = (value) => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
const now = () => new Date().toISOString();
const required = (value, label) => { const text = String(value || '').trim(); if (!text) throw new Error(`${label} 不能为空。`); return text; };
const canonical = (value) => { const url = new URL(required(value, 'official_url')); url.hash = ''; return url.toString(); };
const jsonObject = (value, fallback = {}) => {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || ''); } catch { return fallback; }
};

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
  async function listCandidatesForReview({ limit = 100 } = {}) {
    const size = Math.min(Math.max(Number(limit) || 100, 1), 100);
    return (await pool.query(
      `SELECT c.candidate_id,c.snapshot_id,c.source_id,c.official_url,c.canonical_url,c.parsed_fields,c.verification_state,c.legal_status,c.created_at,c.updated_at,
              s.source_name,s.official_domain
       FROM candidates c JOIN sources s ON s.source_id=c.source_id
       ORDER BY CASE WHEN c.verification_state='pending_review' THEN 0 ELSE 1 END, c.created_at ASC LIMIT $1`,
      [size]
    )).rows.map((row) => ({ ...row, parsed_fields: jsonObject(row.parsed_fields) }));
  }
  async function getCandidateForReview(candidateId) {
    const result = await pool.query(
      `SELECT c.*, row_to_json(s.*) AS raw_snapshot, row_to_json(r.*) AS collection_run, row_to_json(so.*) AS source
       FROM candidates c
       JOIN raw_snapshots s ON s.snapshot_id=c.snapshot_id
       JOIN collection_runs r ON r.collection_run_id=c.collection_run_id
       JOIN sources so ON so.source_id=c.source_id
       WHERE c.candidate_id=$1`,
      [required(candidateId, 'candidate_id')]
    );
    if (!result.rows.length) throw new Error(`candidate 不存在：${candidateId}`);
    const row = result.rows[0];
    const snapshot = jsonObject(row.raw_snapshot);
    const rawHtml = await objectStore.read(snapshot.raw_object_key);
    const normalizedText = await objectStore.read(snapshot.normalized_text_object_key);
    const parsedFields = jsonObject(row.parsed_fields);
    const normalization = jsonObject(parsedFields.normalization);
    const reparsedText = normalization.normalized_text_object_key
      ? await objectStore.read(normalization.normalized_text_object_key)
      : null;
    return {
      candidate: {
        ...row,
        parsed_fields: parsedFields,
        observed_snapshot_ids: jsonObject(row.observed_snapshot_ids, []),
        parsed_normalized_text: reparsedText === null ? null : String(reparsedText || '')
      },
      raw_snapshot: { ...snapshot, raw_html: String(rawHtml || ''), normalized_text: String(normalizedText || '') },
      collection_run: jsonObject(row.collection_run),
      source: jsonObject(row.source)
    };
  }
  async function reparseCandidate(candidateId, { parsed_fields = {}, normalized_text, parser_version } = {}) {
    const candidateKey = required(candidateId, 'candidate_id');
    const body = required(normalized_text, 'normalized_text');
    const parserVersion = required(parser_version, 'parser_version');
    const bodyHash = sha256(body);
    const locked = await withExclusiveLock(`taxkb:evidence-reparse:${candidateKey}`, async () => {
      const detail = await getCandidateForReview(candidateKey);
      const candidate = detail.candidate;
      if (candidate.verification_state !== 'pending_review') throw new Error('只有 pending_review Candidate 可以重新解析。');
      const previousNormalization = jsonObject(candidate.parsed_fields).normalization || {};
      if (previousNormalization.normalized_text_sha256 === bodyHash && previousNormalization.parser_version === parserVersion && candidate.parsed_normalized_text === body) {
        return { ...detail, reparsed: false };
      }
      const collision = await pool.query(
        'SELECT candidate_id FROM candidates WHERE source_id=$1 AND canonical_url=$2 AND normalized_text_sha256=$3 AND candidate_id<>$4',
        [candidate.source_id, candidate.canonical_url, bodyHash, candidateKey]
      );
      if (collision.rows.length) throw new Error(`重新解析结果已属于 Candidate：${collision.rows[0].candidate_id}`);
      const objectKey = `candidate-normalizations/${candidateKey}/${bodyHash}/normalized-text`;
      if (!(typeof objectStore.has === 'function' && await objectStore.has(objectKey))) {
        try { await objectStore.putImmutable(objectKey, body); }
        catch (error) {
          // A retry may reach an already-created immutable object after an
          // earlier request stored it but failed before the database update.
          if (!/不可覆盖|already exists|EEXIST/i.test(String(error?.message || error))) throw error;
        }
      }
      const timestamp = clock();
      const fields = {
        ...jsonObject(parsed_fields),
        normalization: {
          parser_version: parserVersion,
          normalized_text_sha256: bodyHash,
          normalized_text_object_key: objectKey,
          derived_from_snapshot_id: candidate.snapshot_id,
          reparsed_at: timestamp
        }
      };
      await pool.query(
        'UPDATE candidates SET normalized_text_sha256=$2, parsed_fields=$3, updated_at=$4 WHERE candidate_id=$1',
        [candidateKey, bodyHash, JSON.stringify(fields), timestamp]
      );
      await pool.query(
        'INSERT INTO audit_events (audit_event_id,entity_type,entity_id,event_type,payload,created_at) VALUES ($1,$2,$3,$4,$5,$6)',
        [id('audit'), 'candidate', candidateKey, 'candidate_reparsed', JSON.stringify({ parser_version: parserVersion, normalized_text_sha256: bodyHash, derived_from_snapshot_id: candidate.snapshot_id }), timestamp]
      );
      const updated = await getCandidateForReview(candidateKey);
      return {
        candidate: updated.candidate,
        raw_snapshot: updated.raw_snapshot,
        collection_run: updated.collection_run,
        source: updated.source,
        reparsed: true
      };
    });
    if (!locked.acquired) throw new Error('该 Candidate 正在重新解析中，请稍后重试。');
    return locked.result;
  }
  async function reviewCandidate(candidateId, { action, legal_status = 'pending', reviewer_id = 'netlify-admin', note = '', confirmed_fields = {} } = {}) {
    const candidateKey = required(candidateId, 'candidate_id');
    const requestedAction = required(action, 'action');
    if (!['approve', 'reject', 'return'].includes(requestedAction)) throw new Error('审核动作无效。');
    if (!POLICY_STATUSES.includes(legal_status)) throw new Error('审核效力状态无效。');
    const reviewer = required(reviewer_id, 'reviewer_id');
    const locked = await withExclusiveLock(`taxkb:evidence-review:${candidateKey}`, async () => {
      const detail = await getCandidateForReview(candidateKey);
      const candidate = detail.candidate;
      const reviews = (await pool.query('SELECT * FROM review_decisions WHERE candidate_id=$1 ORDER BY decided_at DESC', [candidateKey])).rows
        .map((row) => ({ ...row, confirmed_fields: jsonObject(row.confirmed_fields), evidence_snapshot_ids: jsonObject(row.evidence_snapshot_ids, []) }));
      const existingApproval = reviews.find((item) => item.reviewer_level === 3 && item.decision === 'approve');
      if (requestedAction === 'approve' && existingApproval) {
        const version = (await pool.query('SELECT * FROM policy_versions WHERE candidate_id=$1', [candidateKey])).rows[0];
        const policy = version ? (await pool.query('SELECT * FROM policies WHERE policy_id=$1', [version.policy_id])).rows[0] : null;
        if (!version || !policy) throw new Error('已批准 Candidate 缺少 Policy Version，需人工处理。');
        return { execution: 'already_approved', ...detail, review_decision: existingApproval, policy, policy_version: version, confirmed_fields: existingApproval.confirmed_fields };
      }
      if (requestedAction === 'reject' && candidate.verification_state === 'rejected') {
        const review = reviews.find((item) => item.reviewer_level === 3 && item.decision === 'reject');
        return { execution: 'already_rejected', ...detail, review_decision: review || null, policy: null, policy_version: null, confirmed_fields: review?.confirmed_fields || {} };
      }
      if (requestedAction === 'approve' && candidate.verification_state !== 'pending_review') throw new Error('只有 pending_review Candidate 可以批准发布。');
      if (requestedAction === 'reject' && candidate.verification_state !== 'pending_review') throw new Error('只有 pending_review Candidate 可以驳回。');

      const timestamp = clock();
      const reviewId = id('review');
      const fields = jsonObject(confirmed_fields);
      await pool.query(
        `INSERT INTO review_decisions (review_decision_id,candidate_id,reviewer_level,decision,legal_status,note,evidence_snapshot_ids,decided_at,reviewer_id,confirmed_fields)
         VALUES ($1,$2,3,$3,$4,$5,$6,$7,$8,$9)`,
        [reviewId, candidateKey, requestedAction, legal_status, String(note || ''), JSON.stringify([candidate.snapshot_id]), timestamp, reviewer, JSON.stringify(fields)]
      );
      const review = (await pool.query('SELECT * FROM review_decisions WHERE review_decision_id=$1', [reviewId])).rows[0];
      const nextVerification = requestedAction === 'approve' ? 'verified' : requestedAction === 'reject' ? 'rejected' : 'pending_review';
      const nextLegal = requestedAction === 'return' ? candidate.legal_status : legal_status;
      await pool.query('UPDATE candidates SET verification_state=$2, legal_status=$3, updated_at=$4 WHERE candidate_id=$1', [candidateKey, nextVerification, nextLegal, timestamp]);
      let policy = null;
      let policyVersion = null;
      if (requestedAction === 'approve') {
        const policyId = `policy-${candidateKey}`;
        const policyVersionId = `policy-version-${candidateKey}`;
        await pool.query(
          `INSERT INTO policies (policy_id,canonical_title,legal_status,verification_state,current_policy_version_id,source_ids,created_at,updated_at)
           VALUES ($1,$2,$3,'verified',NULL,$4,$5,$5)
           ON CONFLICT (policy_id) DO UPDATE SET canonical_title=EXCLUDED.canonical_title,legal_status=EXCLUDED.legal_status,verification_state='verified',source_ids=EXCLUDED.source_ids,updated_at=EXCLUDED.updated_at`,
          [policyId, required(fields.title, '审核标题'), legal_status, JSON.stringify([candidate.source_id]), timestamp]
        );
        await pool.query(
          `INSERT INTO policy_versions (policy_version_id,policy_id,version_number,review_decision_id,candidate_id,snapshot_id,source_id,official_url,canonical_url,title,document_no,legal_status,verification_state,effective_date,expiry_date,source_links,created_at)
           VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,$11,'verified',$12,$13,$14,$15)`,
          [policyVersionId, policyId, reviewId, candidateKey, candidate.snapshot_id, candidate.source_id, candidate.official_url, candidate.canonical_url, fields.title, fields.document_no || null, legal_status, fields.effective_date || null, fields.expiry_date || null, JSON.stringify([{ source_id: candidate.source_id, snapshot_id: candidate.snapshot_id, official_url: candidate.official_url }]), timestamp]
        );
        await pool.query('UPDATE policies SET current_policy_version_id=$2,updated_at=$3 WHERE policy_id=$1', [policyId, policyVersionId, timestamp]);
        policy = (await pool.query('SELECT * FROM policies WHERE policy_id=$1', [policyId])).rows[0];
        policyVersion = (await pool.query('SELECT * FROM policy_versions WHERE policy_version_id=$1', [policyVersionId])).rows[0];
      }
      await pool.query(
        'INSERT INTO audit_events (audit_event_id,entity_type,entity_id,event_type,payload,created_at) VALUES ($1,$2,$3,$4,$5,$6)',
        [id('audit'), 'candidate', candidateKey, `level3_${requestedAction}`, JSON.stringify({ review_decision_id: reviewId, reviewer_id: reviewer, legal_status: nextLegal, policy_id: policy?.policy_id || null, policy_version_id: policyVersion?.policy_version_id || null }), timestamp]
      );
      const activeDetail = await getCandidateForReview(candidateKey);
      return { execution: requestedAction, ...activeDetail, candidate: activeDetail.candidate, review_decision: { ...review, confirmed_fields: fields }, policy, policy_version: policyVersion, confirmed_fields: fields };
    });
    if (!locked.acquired) throw new Error('该 Candidate 正在审核中，请稍后重试。');
    return locked.result;
  }
  async function hasCompletedCandidatesForUrls({ source_id, canonical_urls = [] } = {}) {
    const urls = [...new Set(canonical_urls.map(canonical))];
    if (!required(source_id, 'source_id') || !urls.length) return false;
    const result = await pool.query(
      `SELECT COUNT(DISTINCT s.canonical_url)::int AS count
      FROM raw_snapshots s
      JOIN collection_runs r ON r.collection_run_id=s.collection_run_id
      JOIN candidates c ON c.source_id=s.source_id
                        AND c.canonical_url=s.canonical_url
                        -- Candidate normalizations can be improved later
                        -- without mutating a historical Raw Snapshot. The
                        -- completed-ingestion marker must therefore follow
                        -- the snapshot observed by the Candidate, not require
                        -- its current derived-text hash to equal the old one.
                        AND c.observed_snapshot_ids @> jsonb_build_array(s.snapshot_id)
       WHERE s.source_id=$1
         AND s.canonical_url = ANY($2::text[])
         AND r.mode='phase2d-production-whitelist'
         AND r.collection_state='completed'`,
      [source_id, urls]
    );
    return result.rows[0].count === urls.length;
  }
  async function withExclusiveLock(lockName, work) {
    if (typeof pool.connect !== 'function') {
      // @netlify/database-dev exposes a single local query interface. The
      // production pg pool uses the connection-scoped branch below.
      const lock = await pool.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [required(lockName, 'lockName')]);
      if (!lock.rows[0]?.acquired) return { acquired: false, result: null };
      try { return { acquired: true, result: await work() }; }
      finally { await pool.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]); }
    }
    const client = await pool.connect();
    try {
      const lock = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [required(lockName, 'lockName')]);
      if (!lock.rows[0]?.acquired) return { acquired: false, result: null };
      try { return { acquired: true, result: await work() }; }
      finally { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]); }
    } finally { client.release(); }
  }
  async function counts() { const tables=['sources','source_states','collection_runs','raw_snapshots','candidates','review_decisions','policies','policy_versions','policy_relations','audit_events']; const output={}; for(const table of tables) output[table]=(await pool.query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0].count; return output; }
  return Object.freeze({addSource,createCollectionRun,finishCollectionRun,recordRawSnapshot,createCandidate,traceCandidate,listCandidateStatuses,listCandidatesForReview,getCandidateForReview,reparseCandidate,reviewCandidate,hasCompletedCandidatesForUrls,withExclusiveLock,counts,readRawObject:(key)=>objectStore.read(key),close:()=>pool.end?.()});
}
