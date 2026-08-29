import { createPostgresEvidenceRepository } from '../../src/postgres-evidence-repository.js';
import { createNetlifyBlobsEvidenceObjectStore } from '../../src/evidence-object-store.js';
import { CHINA_TAX_POLICY_SOURCE } from '../../src/chinatax-evidence-adapter.js';
import { PHASE_2B_ALLOWED_DETAIL_URLS, parseChinaTaxPolicyEvidence } from '../../src/chinatax-evidence-collection.js';

export const PHASE_2D_IMPORT_CONFIRMATION = 'INGEST_PHASE2B_STA_TWO_URLS';
const DETAIL_USER_AGENT = 'TaxPolicyKnowledgeBase/0.2 (phase2d-server-evidence-ingestion)';
const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

function requireAdmin(request) {
  const expected = process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
  const received = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return Boolean(expected && received && received === expected);
}

async function requestBody(request) {
  const text = await request.text();
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { throw new SyntaxError('请求正文必须是 JSON。'); }
}

function defaultRepositoryFactory() {
  return createPostgresEvidenceRepository({ objectStore: createNetlifyBlobsEvidenceObjectStore() });
}

function safeCandidate(candidate) {
  return {
    candidate_id: candidate.candidate_id,
    snapshot_id: candidate.snapshot_id,
    last_seen_snapshot_id: candidate.last_seen_snapshot_id,
    source_id: candidate.source_id,
    official_url: candidate.official_url,
    verification_state: candidate.verification_state,
    legal_status: candidate.legal_status,
    created_at: candidate.created_at,
    updated_at: candidate.updated_at
  };
}

function safeTrace(trace) {
  return {
    candidate: safeCandidate(trace),
    snapshot: {
      snapshot_id: trace.raw_snapshot.snapshot_id,
      source_id: trace.raw_snapshot.source_id,
      collection_run_id: trace.raw_snapshot.collection_run_id,
      official_url: trace.raw_snapshot.official_url,
      canonical_url: trace.raw_snapshot.canonical_url,
      fetched_at: trace.raw_snapshot.fetched_at,
      http_status: trace.raw_snapshot.http_status,
      content_type: trace.raw_snapshot.content_type,
      raw_sha256: trace.raw_snapshot.raw_sha256,
      normalized_text_sha256: trace.raw_snapshot.normalized_text_sha256,
      parser_version: trace.raw_snapshot.parser_version,
      parse_result_hash: trace.raw_snapshot.parse_result_hash,
      previous_snapshot_id: trace.raw_snapshot.previous_snapshot_id,
      content_changed: trace.raw_snapshot.content_changed
    },
    collection_run: {
      collection_run_id: trace.collection_run.collection_run_id,
      source_id: trace.collection_run.source_id,
      mode: trace.collection_run.mode,
      collection_state: trace.collection_run.collection_state,
      started_at: trace.collection_run.started_at,
      completed_at: trace.collection_run.completed_at,
      discovered_count: trace.collection_run.discovered_count
    },
    source: {
      source_id: trace.source.source_id,
      source_name: trace.source.source_name,
      official_domain: trace.source.official_domain,
      source_type: trace.source.source_type,
      adapter_version: trace.source.adapter_version,
      base_url: trace.source.base_url,
      enabled: trace.source.enabled
    }
  };
}

async function fetchAllowedOfficialDetail(fetchImpl, officialUrl) {
  const response = await fetchImpl(officialUrl, {
    headers: { 'user-agent': DETAIL_USER_AGENT }, signal: AbortSignal.timeout(20_000)
  });
  const rawHtml = await response.text();
  if (!response.ok) throw new Error(`国家税务总局政策详情请求失败：${response.status}`);
  const headers = {};
  for (const key of ['content-type', 'etag', 'last-modified', 'content-length', 'date']) {
    const value = response.headers?.get?.(key);
    if (value) headers[key] = String(value);
  }
  return { rawHtml, httpStatus: response.status, headers, contentType: response.headers?.get?.('content-type') || 'text/html' };
}

/**
 * This is deliberately the only production ingestion path in Phase 2D. It
 * cannot receive URLs, IDs, a source name, or policy content from a request.
 */
export async function ingestPhase2BWhitelist({ repository = defaultRepositoryFactory(), fetchImpl = fetch } = {}) {
  const source = await repository.addSource({
    ...CHINA_TAX_POLICY_SOURCE,
    adapter_version: '2.0.0-phase2d-server',
    base_url: CHINA_TAX_POLICY_SOURCE.collection_url
  });
  const run = await repository.createCollectionRun({ source_id: source.source_id, mode: 'phase2d-production-whitelist' });
  const results = [];
  try {
    for (const officialUrl of PHASE_2B_ALLOWED_DETAIL_URLS) {
      const response = await fetchAllowedOfficialDetail(fetchImpl, officialUrl);
      const parsed = parseChinaTaxPolicyEvidence(response.rawHtml);
      const snapshot = await repository.recordRawSnapshot({
        source_id: source.source_id,
        collection_run_id: run.collection_run_id,
        official_url: officialUrl,
        canonical_url: officialUrl,
        http_status: response.httpStatus,
        response_headers_subset: response.headers,
        content_type: response.contentType,
        raw_content: response.rawHtml,
        normalized_text: parsed.normalized_text,
        parser_version: 'chinatax-evidence-2.0.0-phase2d',
        parse_result: parsed
      });
      const candidateResult = await repository.createCandidate({
        snapshot_id: snapshot.snapshot_id,
        parsed_fields: {
          title: parsed.title,
          document_no: parsed.document_no,
          issuing_authority: parsed.issuing_authority,
          publish_date: parsed.publish_date,
          effective_date: parsed.effective_date,
          expiry_date: parsed.expiry_date,
          official_url: snapshot.official_url,
          source_id: snapshot.source_id,
          snapshot_id: snapshot.snapshot_id
        },
        verification_state: 'pending_review',
        legal_status: 'pending'
      });
      results.push({ official_url: officialUrl, snapshot_id: snapshot.snapshot_id, candidate: candidateResult.candidate, candidate_created: candidateResult.created });
    }
    await repository.finishCollectionRun(run.collection_run_id, 'completed');
  } catch (error) {
    await repository.finishCollectionRun(run.collection_run_id, 'failed');
    throw error;
  }
  return {
    source_id: source.source_id,
    collection_run_id: run.collection_run_id,
    snapshots_created: results.length,
    candidates_created: results.filter((item) => item.candidate_created).length,
    candidates_skipped: results.filter((item) => !item.candidate_created).length,
    results: results.map((item) => ({ official_url: item.official_url, snapshot_id: item.snapshot_id, candidate: safeCandidate(item.candidate), candidate_created: item.candidate_created }))
  };
}

export async function readEvidenceStatus({ repository = defaultRepositoryFactory() } = {}) {
  return { counts: await repository.counts(), candidates: (await repository.listCandidateStatuses()).map(safeCandidate) };
}

export async function readEvidenceCandidateTrace(candidateId, { repository = defaultRepositoryFactory() } = {}) {
  return safeTrace(await repository.traceCandidate(candidateId));
}

export function createEvidenceAdminHandler({ repositoryFactory = defaultRepositoryFactory, fetchImpl = fetch } = {}) {
  return async function handleEvidenceAdmin(request, pathname, url) {
    if (!requireAdmin(request)) return json({ error: '仅管理员可执行此操作。' }, 401);
    if (url.search) return json({ error: 'Evidence 接口不接受查询参数。' }, 400);
    if (request.method === 'POST' && pathname === '/api/admin/evidence/import-phase2b') {
      const input = await requestBody(request);
      if (Object.keys(input).length !== 2 || input.apply !== true || input.confirmation !== PHASE_2D_IMPORT_CONFIRMATION) {
        return json({ error: 'Evidence 导入只接受固定 apply 与 confirmation，且不能指定 URL、文件或政策内容。' }, 400);
      }
      const result = await ingestPhase2BWhitelist({ repository: repositoryFactory(), fetchImpl });
      return json({ mode: 'apply', allowlist_size: PHASE_2B_ALLOWED_DETAIL_URLS.length, ...result });
    }
    if (request.method === 'GET' && pathname === '/api/admin/evidence/status') return json(await readEvidenceStatus({ repository: repositoryFactory() }));
    if (request.method === 'GET' && /^\/api\/admin\/evidence\/candidates\/[^/]+\/trace$/.test(pathname)) {
      const candidateId = decodeURIComponent(pathname.split('/')[5]);
      return json({ trace: await readEvidenceCandidateTrace(candidateId, { repository: repositoryFactory() }) });
    }
    return json({ error: 'Evidence 接口不存在。' }, 404);
  };
}
