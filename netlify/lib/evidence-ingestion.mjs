import { createPostgresEvidenceRepository } from '../../src/postgres-evidence-repository.js';
import { createNetlifyBlobsEvidenceObjectStore } from '../../src/evidence-object-store.js';
import { CHINA_TAX_POLICY_SOURCE } from '../../src/chinatax-evidence-adapter.js';
import { PHASE_2B_ALLOWED_DETAIL_URLS, parseChinaTaxPolicyEvidence } from '../../src/chinatax-evidence-collection.js';
import { buildPublicPolicyProjection, normalizeReviewFields } from '../../src/evidence-review.js';
import { importPolicies } from './policy-store.mjs';

export const PHASE_2D_IMPORT_CONFIRMATION = 'INGEST_PHASE2B_STA_TWO_URLS';
export const PHASE_2D_ONE_TIME_INGESTION_LOCK = 'taxkb:phase2d:phase2b-whitelist:first-production-ingestion';
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

function adminCandidateSummary(candidate) {
  return {
    candidate_id: candidate.candidate_id,
    source_id: candidate.source_id,
    source_name: candidate.source_name || null,
    official_domain: candidate.official_domain || null,
    official_url: candidate.official_url,
    parsed_fields: candidate.parsed_fields || {},
    verification_state: candidate.verification_state,
    legal_status: candidate.legal_status,
    created_at: candidate.created_at,
    updated_at: candidate.updated_at
  };
}

function adminReviewDetail(detail) {
  return {
    candidate: {
      candidate_id: detail.candidate.candidate_id,
      source_id: detail.candidate.source_id,
      official_url: detail.candidate.official_url,
      canonical_url: detail.candidate.canonical_url,
      parsed_fields: detail.candidate.parsed_fields || {},
      verification_state: detail.candidate.verification_state,
      legal_status: detail.candidate.legal_status,
      created_at: detail.candidate.created_at,
      updated_at: detail.candidate.updated_at
    },
    raw_snapshot: {
      snapshot_id: detail.raw_snapshot.snapshot_id,
      official_url: detail.raw_snapshot.official_url,
      canonical_url: detail.raw_snapshot.canonical_url,
      fetched_at: detail.raw_snapshot.fetched_at,
      http_status: detail.raw_snapshot.http_status,
      content_type: detail.raw_snapshot.content_type,
      raw_sha256: detail.raw_snapshot.raw_sha256,
      normalized_text_sha256: detail.raw_snapshot.normalized_text_sha256,
      parser_version: detail.raw_snapshot.parser_version,
      raw_html: detail.raw_snapshot.raw_html,
      normalized_text: detail.raw_snapshot.normalized_text
    },
    collection_run: detail.collection_run,
    source: detail.source
  };
}

async function defaultPublishProjection(policy) {
  return importPolicies([policy], { dryRun: false });
}

export async function reviewEvidenceCandidate(candidateId, input, { repository = defaultRepositoryFactory(), publishProjection = defaultPublishProjection, reviewerId = 'netlify-admin' } = {}) {
  const action = String(input?.action || '').trim();
  if (!['approve', 'reject', 'return'].includes(action)) throw new Error('审核动作无效。');
  const detail = await repository.getCandidateForReview(candidateId);
  const confirmedFields = action === 'approve'
    ? normalizeReviewFields(detail.candidate.parsed_fields, input.fields || {})
    : {};
  const result = await repository.reviewCandidate(candidateId, {
    action,
    legal_status: input.legal_status || 'pending',
    note: String(input.note || ''),
    reviewer_id: reviewerId,
    confirmed_fields: confirmedFields
  });
  let publication = null;
  if (action === 'approve') {
    const projection = buildPublicPolicyProjection({
      candidate: result.candidate,
      source: result.source,
      reviewDecision: result.review_decision,
      policy: result.policy,
      policyVersion: result.policy_version,
      confirmedFields: result.confirmed_fields,
      normalizedText: result.raw_snapshot.normalized_text
    });
    publication = await publishProjection(projection);
  }
  return {
    execution: result.execution,
    candidate: adminCandidateSummary(result.candidate),
    review_decision: result.review_decision ? {
      review_decision_id: result.review_decision.review_decision_id,
      reviewer_level: result.review_decision.reviewer_level,
      reviewer_id: result.review_decision.reviewer_id,
      decision: result.review_decision.decision,
      legal_status: result.review_decision.legal_status,
      note: result.review_decision.note,
      decided_at: result.review_decision.decided_at,
      confirmed_fields: result.confirmed_fields
    } : null,
    policy: result.policy ? { policy_id: result.policy.policy_id, canonical_title: result.policy.canonical_title, legal_status: result.policy.legal_status, verification_state: result.policy.verification_state } : null,
    policy_version: result.policy_version ? { policy_version_id: result.policy_version.policy_version_id, policy_id: result.policy_version.policy_id, version_number: result.policy_version.version_number, candidate_id: result.policy_version.candidate_id } : null,
    publication
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

/**
 * The protected admin endpoint uses this wrapper. Completion means that each
 * of the two fixed URLs has matching candidate evidence from a completed
 * Phase 2D run. This remains true if a later human review changes the
 * candidate's review or legal state, and a later invocation exits before any
 * HTTP request, collection run, snapshot, or candidate write.
 */
export async function ingestPhase2BWhitelistOnce({ repository = defaultRepositoryFactory(), fetchImpl = fetch } = {}) {
  if (typeof repository.hasCompletedCandidatesForUrls !== 'function' || typeof repository.withExclusiveLock !== 'function') {
    throw new Error('Evidence Repository 不支持一次性 Phase 2B 导入锁。');
  }
  const locked = await repository.withExclusiveLock(PHASE_2D_ONE_TIME_INGESTION_LOCK, async () => {
    const complete = await repository.hasCompletedCandidatesForUrls({
      source_id: CHINA_TAX_POLICY_SOURCE.source_id,
      canonical_urls: PHASE_2B_ALLOWED_DETAIL_URLS
    });
    if (complete) {
      return Object.freeze({
        execution: 'already_completed',
        source_id: CHINA_TAX_POLICY_SOURCE.source_id,
        snapshots_created: 0,
        candidates_created: 0,
        candidates_skipped: PHASE_2B_ALLOWED_DETAIL_URLS.length,
        results: []
      });
    }
    return Object.freeze({ execution: 'completed', ...(await ingestPhase2BWhitelist({ repository, fetchImpl })) });
  });
  if (!locked.acquired) {
    return Object.freeze({
      execution: 'in_progress',
      source_id: CHINA_TAX_POLICY_SOURCE.source_id,
      snapshots_created: 0,
      candidates_created: 0,
      candidates_skipped: 0,
      results: []
    });
  }
  return locked.result;
}

export async function readEvidenceStatus({ repository = defaultRepositoryFactory() } = {}) {
  return { counts: await repository.counts(), candidates: (await repository.listCandidateStatuses()).map(safeCandidate) };
}

export async function readEvidenceCandidateTrace(candidateId, { repository = defaultRepositoryFactory() } = {}) {
  return safeTrace(await repository.traceCandidate(candidateId));
}

export function createEvidenceAdminHandler({ repositoryFactory = defaultRepositoryFactory, fetchImpl = fetch, publishProjection = defaultPublishProjection } = {}) {
  return async function handleEvidenceAdmin(request, pathname, url) {
    if (!requireAdmin(request)) return json({ error: '仅管理员可执行此操作。' }, 401);
    if (url.search) return json({ error: 'Evidence 接口不接受查询参数。' }, 400);
    if (request.method === 'POST' && pathname === '/api/admin/evidence/import-phase2b') {
      const input = await requestBody(request);
      if (Object.keys(input).length !== 2 || input.apply !== true || input.confirmation !== PHASE_2D_IMPORT_CONFIRMATION) {
        return json({ error: 'Evidence 导入只接受固定 apply 与 confirmation，且不能指定 URL、文件或政策内容。' }, 400);
      }
      const result = await ingestPhase2BWhitelistOnce({ repository: repositoryFactory(), fetchImpl });
      return json({ mode: 'apply', allowlist_size: PHASE_2B_ALLOWED_DETAIL_URLS.length, ...result });
    }
    if (request.method === 'GET' && pathname === '/api/admin/evidence/status') return json(await readEvidenceStatus({ repository: repositoryFactory() }));
    if (request.method === 'GET' && pathname === '/api/admin/evidence/candidates') {
      const candidates = await repositoryFactory().listCandidatesForReview();
      return json({ candidates: candidates.map(adminCandidateSummary) });
    }
    if (request.method === 'GET' && /^\/api\/admin\/evidence\/candidates\/[^/]+$/.test(pathname)) {
      const candidateId = decodeURIComponent(pathname.split('/')[5]);
      return json({ detail: adminReviewDetail(await repositoryFactory().getCandidateForReview(candidateId)) });
    }
    if (request.method === 'POST' && /^\/api\/admin\/evidence\/candidates\/[^/]+\/review$/.test(pathname)) {
      const candidateId = decodeURIComponent(pathname.split('/')[5]);
      const input = await requestBody(request);
      const allowed = new Set(['action', 'legal_status', 'note', 'fields']);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !allowed.has(key))) {
        return json({ error: 'Evidence 审核只接受 action、legal_status、note 和 fields。' }, 400);
      }
      return json(await reviewEvidenceCandidate(candidateId, input, { repository: repositoryFactory(), publishProjection }));
    }
    if (request.method === 'GET' && /^\/api\/admin\/evidence\/candidates\/[^/]+\/trace$/.test(pathname)) {
      const candidateId = decodeURIComponent(pathname.split('/')[5]);
      return json({ trace: await readEvidenceCandidateTrace(candidateId, { repository: repositoryFactory() }) });
    }
    return json({ error: 'Evidence 接口不存在。' }, 404);
  };
}
