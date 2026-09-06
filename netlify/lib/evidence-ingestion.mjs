import { createPostgresEvidenceRepository } from '../../src/postgres-evidence-repository.js';
import { createHash } from 'node:crypto';
import { createNetlifyBlobsEvidenceObjectStore } from '../../src/evidence-object-store.js';
import { CHINA_TAX_POLICY_SOURCE } from '../../src/chinatax-evidence-adapter.js';
import { PHASE_2B_ALLOWED_DETAIL_URLS, parseChinaTaxPolicyEvidence } from '../../src/chinatax-evidence-collection.js';
import { buildPublicPolicyProjection, normalizeReviewFields } from '../../src/evidence-review.js';
import { suggestEvidenceMetadata } from '../../src/evidence-metadata-suggestion.js';
import { LOW_RISK_BATCH_CONFIRMATION } from '../../src/risk-review-queue.js';
import { importPolicies } from './policy-store.mjs';

export const PHASE_2D_IMPORT_CONFIRMATION = 'INGEST_PHASE2B_STA_TWO_URLS';
export const PHASE_2D_ONE_TIME_INGESTION_LOCK = 'taxkb:phase2d:phase2b-whitelist:first-production-ingestion';
export const PHASE_2D_REPARSE_CONFIRMATION = 'REPARSE_PHASE2B_TWO_CANDIDATES';
export const PHASE_2D_METADATA_SUGGESTION_CONFIRMATION = 'SUGGEST_PHASE2B_TWO_CANDIDATES';
export const LOW_RISK_BATCH_CONFIRMATION_PHRASE = LOW_RISK_BATCH_CONFIRMATION;
const DETAIL_USER_AGENT = 'TaxPolicyKnowledgeBase/0.2 (phase2d-server-evidence-ingestion)';
const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const sha256 = (value) => createHash('sha256').update(String(value || '')).digest('hex');
const stable = (value) => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);

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

function safeParsedFields(fields) {
  const value = fields && typeof fields === 'object' ? { ...fields } : {};
  if (value.normalization && typeof value.normalization === 'object') {
    const { normalized_text_object_key: ignored, ...normalization } = value.normalization;
    value.normalization = normalization;
  }
  return value;
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
    parsed_fields: safeParsedFields(candidate.parsed_fields),
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
      parsed_fields: safeParsedFields(detail.candidate.parsed_fields),
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
      // A parser correction is a Candidate-level derived artifact. The raw
      // snapshot remains immutable and is still returned separately as proof.
      normalized_text: detail.candidate.parsed_normalized_text ?? detail.raw_snapshot.normalized_text
    },
    collection_run: detail.collection_run,
    source: detail.source
  };
}

async function defaultPublishProjection(policy) {
  return importPolicies([policy], { dryRun: false });
}

function safeProjectionJob(job) {
  return job && {
    projection_job_id: job.projection_job_id,
    policy_id: job.policy_id,
    policy_version_id: job.policy_version_id,
    candidate_id: job.candidate_id,
    manifest_id: job.manifest_id || null,
    job_state: job.job_state,
    attempts: job.attempts,
    last_error: job.last_error || null,
    created_at: job.created_at,
    published_at: job.published_at || null
  };
}

function projectionFromJobDetail(value) {
  return buildPublicPolicyProjection({
    candidate: value.detail.candidate,
    source: value.detail.source,
    reviewDecision: value.review_decision,
    policy: value.policy,
    policyVersion: value.policy_version,
    confirmedFields: value.review_decision.confirmed_fields,
    normalizedText: value.detail.candidate.parsed_normalized_text ?? value.detail.raw_snapshot.normalized_text,
    now: new Date(value.job.created_at)
  });
}

/** A failed public Blob projection can be retried without re-reviewing data. */
export async function processPolicyProjectionJob(projectionJobId, { repository = defaultRepositoryFactory(), publishProjection = defaultPublishProjection } = {}) {
  const initial = await repository.getProjectionJobDetail(projectionJobId);
  if (initial.job.job_state === 'published') return { execution: 'already_published', job: safeProjectionJob(initial.job), publication: null };
  await repository.markProjectionJob(projectionJobId, 'processing');
  try {
    const current = await repository.getProjectionJobDetail(projectionJobId);
    const projection = projectionFromJobDetail(current);
    if (sha256(stable(projection)) !== current.job.projection_hash) throw new Error('projection job 内容 hash 不一致，已停止写入公开投影。');
    const publication = await publishProjection(projection);
    const job = await repository.markProjectionJob(projectionJobId, 'published');
    return { execution: 'published', job: safeProjectionJob(job), publication };
  } catch (error) {
    const job = await repository.markProjectionJob(projectionJobId, 'failed', { error: error?.message || 'projection failed' });
    return { execution: 'failed', job: safeProjectionJob(job), publication: null };
  }
}

async function queueProjectionForReview(result, { repository, publishProjection, manifestId = null } = {}) {
  if (!result.policy || !result.policy_version || !result.review_decision) return null;
  const projection = buildPublicPolicyProjection({
    candidate: result.candidate,
    source: result.source,
    reviewDecision: result.review_decision,
    policy: result.policy,
    policyVersion: result.policy_version,
    confirmedFields: result.confirmed_fields,
    normalizedText: result.candidate.parsed_normalized_text ?? result.raw_snapshot.normalized_text
  });
  const job = await repository.ensureProjectionJob({
    policy_id: result.policy.policy_id,
    policy_version_id: result.policy_version.policy_version_id,
    candidate_id: result.candidate.candidate_id,
    review_decision_id: result.review_decision.review_decision_id,
    manifest_id: manifestId,
    projection_hash: sha256(stable(projection))
  });
  return processPolicyProjectionJob(job.projection_job_id, { repository, publishProjection });
}

function safeRiskQueue(value) {
  return {
    total: value.total,
    results: value.results.map((item) => ({
      candidate: adminCandidateSummary(item.candidate),
      assessment: {
        assessment_id: item.assessment.assessment_id,
        rule_version: item.assessment.rule_version,
        input_body_sha256: item.assessment.input_body_sha256,
        parser_version: item.assessment.parser_version,
        risk_level: item.assessment.risk_level,
        risk_score: item.assessment.risk_score,
        risk_reasons: item.assessment.risk_reasons,
        quality_metrics: item.assessment.quality_metrics,
        assessed_at: item.assessment.assessed_at
      },
      source: item.source,
      collection_run: item.collection_run,
      active_relation_proposal_count: item.active_relation_proposal_count
    }))
  };
}

function safeManifest(value) {
  return {
    manifest: value.manifest,
    items: value.items.map((item) => ({
      manifest_item_id: item.manifest_item_id,
      candidate: adminCandidateSummary({ ...item.candidate, source_id: item.source_id, created_at: item.created_at, updated_at: item.updated_at }),
      assessment_id: item.assessment_id,
      input_body_sha256: item.input_body_sha256,
      parser_version: item.parser_version,
      risk_rule_version: item.risk_rule_version,
      risk_level: item.risk_level,
      risk_score: item.risk_score,
      metadata_rule_version: item.metadata_rule_version,
      metadata_input_body_sha256: item.metadata_input_body_sha256,
      is_sample: item.is_sample,
      item_state: item.item_state,
      last_error: item.last_error || null
    }))
  };
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
  const publication = action === 'approve'
    ? await queueProjectionForReview(result, { repository, publishProjection })
    : null;
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

/**
 * Rebuilds only the parse result of the two already-ingested Phase 2B
 * Candidates from their preserved raw HTML. It does not fetch a URL, create a
 * Raw Snapshot, or create a Candidate. The repository stores a new immutable
 * derived-text object and an audit event while retaining the original snapshot.
 */
export async function reparsePhase2BCandidates({ repository = defaultRepositoryFactory() } = {}) {
  if (typeof repository.listCandidatesForReview !== 'function' || typeof repository.getCandidateForReview !== 'function' || typeof repository.reparseCandidate !== 'function') {
    throw new Error('Evidence Repository 不支持 Candidate 重新解析。');
  }
  const candidates = (await repository.listCandidatesForReview())
    .filter((candidate) => candidate.source_id === CHINA_TAX_POLICY_SOURCE.source_id
      && PHASE_2B_ALLOWED_DETAIL_URLS.includes(candidate.canonical_url || candidate.official_url));
  if (candidates.length !== PHASE_2B_ALLOWED_DETAIL_URLS.length) throw new Error('未找到两条 Phase 2B 白名单 Candidate，已停止重新解析。');
  if (candidates.some((candidate) => candidate.verification_state !== 'pending_review')) throw new Error('Phase 2B Candidate 必须均为 pending_review 才能重新解析。');
  const results = [];
  for (const candidate of candidates) {
    const detail = await repository.getCandidateForReview(candidate.candidate_id);
    const parsed = parseChinaTaxPolicyEvidence(detail.raw_snapshot.raw_html);
    const reparsed = await repository.reparseCandidate(candidate.candidate_id, {
      parser_version: 'chinatax-evidence-2.1.0-dom-body',
      normalized_text: parsed.normalized_text,
      parsed_fields: {
        ...detail.candidate.parsed_fields,
        title: parsed.title,
        document_no: parsed.document_no,
        issuing_authority: parsed.issuing_authority,
        publish_date: parsed.publish_date,
        effective_date: parsed.effective_date,
        expiry_date: parsed.expiry_date,
        official_url: detail.candidate.official_url,
        source_id: detail.candidate.source_id,
        snapshot_id: detail.candidate.snapshot_id
      }
    });
    results.push({
      candidate_id: reparsed.candidate.candidate_id,
      official_url: reparsed.candidate.official_url,
      title: reparsed.candidate.parsed_fields.title || null,
      normalized_text_sha256: reparsed.candidate.parsed_fields.normalization?.normalized_text_sha256 || null,
      normalized_text_length: String(reparsed.candidate.parsed_normalized_text || '').length,
      verification_state: reparsed.candidate.verification_state,
      legal_status: reparsed.candidate.legal_status
    });
  }
  return { execution: 'reparsed', reparsed_candidates: results.length, results };
}

function metadataSuggestionSummary(suggestion) {
  return {
    rule_version: suggestion.rule_version,
    input_body_sha256: suggestion.input_body_sha256,
    generated_at: suggestion.generated_at,
    tax_categories: suggestion.tax_categories,
    keywords: suggestion.keywords,
    summary: suggestion.summary
  };
}

export async function generateEvidenceCandidateMetadataSuggestion(candidateId, { repository = defaultRepositoryFactory() } = {}) {
  if (typeof repository.getCandidateForReview !== 'function' || typeof repository.saveMetadataSuggestion !== 'function') {
    throw new Error('Evidence Repository 不支持 metadata_suggestion。');
  }
  const detail = await repository.getCandidateForReview(candidateId);
  const body = detail.candidate.parsed_normalized_text ?? detail.raw_snapshot.normalized_text;
  const suggestion = suggestEvidenceMetadata({
    title: detail.candidate.parsed_fields?.title,
    normalized_text: body
  });
  const saved = await repository.saveMetadataSuggestion(candidateId, suggestion);
  return {
    execution: saved.created ? 'generated' : 'already_current',
    candidate: adminCandidateSummary(saved.candidate),
    metadata_suggestion: metadataSuggestionSummary(saved.metadata_suggestion)
  };
}

export async function generatePhase2BMetadataSuggestions({ repository = defaultRepositoryFactory() } = {}) {
  if (typeof repository.listCandidatesForReview !== 'function') throw new Error('Evidence Repository 不支持 Candidate 列表。');
  const candidates = (await repository.listCandidatesForReview())
    .filter((candidate) => candidate.source_id === CHINA_TAX_POLICY_SOURCE.source_id
      && PHASE_2B_ALLOWED_DETAIL_URLS.includes(candidate.canonical_url || candidate.official_url));
  if (candidates.length !== PHASE_2B_ALLOWED_DETAIL_URLS.length) throw new Error('未找到两条 Phase 2B 白名单 Candidate，已停止生成建议。');
  if (candidates.some((candidate) => candidate.verification_state !== 'pending_review')) throw new Error('Phase 2B Candidate 必须均为 pending_review 才能生成建议。');
  const results = [];
  for (const candidate of candidates) results.push(await generateEvidenceCandidateMetadataSuggestion(candidate.candidate_id, { repository }));
  return { execution: 'generated', suggested_candidates: results.length, results };
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

function riskQueueFilters(url) {
  const allowed = new Set(['risk_level', 'min_score', 'max_score', 'source_id', 'collection_run_id', 'tax_category', 'publish_from', 'publish_to', 'missing_field', 'conflict_type', 'reason_code', 'limit', 'offset']);
  for (const key of url.searchParams.keys()) if (!allowed.has(key)) throw new Error(`风险队列不接受筛选参数：${key}`);
  return Object.fromEntries([...url.searchParams.entries()]);
}

export async function applyLowRiskReviewManifest(manifestId, { repository = defaultRepositoryFactory(), publishProjection = defaultPublishProjection } = {}) {
  const prepared = await repository.beginReviewBatchApply(manifestId);
  if (prepared.execution !== 'ready_to_apply') return { execution: prepared.execution, manifest: safeManifest(prepared) };
  for (const item of prepared.items) {
    if (item.is_sample || item.item_state === 'published' || item.item_state === 'sample_approved') continue;
    try {
      if (item.item_state === 'failed' && item.policy_version_id) {
        const job = await repository.getProjectionJobForPolicyVersion(item.policy_version_id);
        if (!job) throw new Error('已审核项目缺少 projection job。');
        const retried = await processPolicyProjectionJob(job.projection_job_id, { repository, publishProjection });
        if (retried.execution !== 'published' && retried.execution !== 'already_published') {
          await repository.failReviewBatchManifest(manifestId, `projection job ${job.projection_job_id} 失败。`);
          return { execution: 'failed', manifest: safeManifest(await repository.getReviewBatchManifest(manifestId)), failed_item_id: item.manifest_item_id };
        }
        await repository.markReviewBatchItem(item.manifest_item_id, { item_state: 'published' });
        continue;
      }
      const approved = await repository.approveLowRiskReviewBatchItem(item.manifest_item_id);
      const projection = await queueProjectionForReview(approved.detail, { repository, publishProjection, manifestId });
      if (!projection || !['published', 'already_published'].includes(projection.execution)) {
        await repository.markReviewBatchItem(item.manifest_item_id, { item_state: 'failed', last_error: projection?.job?.last_error || 'projection failed' });
        await repository.failReviewBatchManifest(manifestId, `projection job ${projection?.job?.projection_job_id || 'unknown'} 失败。`);
        return { execution: 'failed', manifest: safeManifest(await repository.getReviewBatchManifest(manifestId)), failed_item_id: item.manifest_item_id, projection };
      }
      await repository.markReviewBatchItem(item.manifest_item_id, { item_state: 'published' });
    } catch (error) {
      await repository.blockReviewBatchManifest(manifestId, error?.message || 'manifest item validation failed');
      return { execution: 'blocked', manifest: safeManifest(await repository.getReviewBatchManifest(manifestId)), failed_item_id: item.manifest_item_id };
    }
  }
  return { execution: 'completed', manifest: safeManifest(await repository.completeReviewBatchManifest(manifestId)) };
}

export function createEvidenceAdminHandler({ repositoryFactory = defaultRepositoryFactory, fetchImpl = fetch, publishProjection = defaultPublishProjection } = {}) {
  return async function handleEvidenceAdmin(request, pathname, url) {
    if (!requireAdmin(request)) return json({ error: '仅管理员可执行此操作。' }, 401);
    const isRiskQueueRead = request.method === 'GET' && pathname === '/api/admin/evidence/risk-queue';
    if (url.search && !isRiskQueueRead) return json({ error: 'Evidence 接口不接受查询参数。' }, 400);
    if (isRiskQueueRead) return json(safeRiskQueue(await repositoryFactory().listRiskQueue(riskQueueFilters(url))));
    if (request.method === 'POST' && pathname === '/api/admin/evidence/import-phase2b') {
      const input = await requestBody(request);
      if (Object.keys(input).length !== 2 || input.apply !== true || input.confirmation !== PHASE_2D_IMPORT_CONFIRMATION) {
        return json({ error: 'Evidence 导入只接受固定 apply 与 confirmation，且不能指定 URL、文件或政策内容。' }, 400);
      }
      const result = await ingestPhase2BWhitelistOnce({ repository: repositoryFactory(), fetchImpl });
      return json({ mode: 'apply', allowlist_size: PHASE_2B_ALLOWED_DETAIL_URLS.length, ...result });
    }
    if (request.method === 'POST' && pathname === '/api/admin/evidence/reparse-phase2b') {
      const input = await requestBody(request);
      if (Object.keys(input).length !== 2 || input.apply !== true || input.confirmation !== PHASE_2D_REPARSE_CONFIRMATION) {
        return json({ error: 'Evidence 重新解析只接受固定 apply 与 confirmation，且不会接收 URL、文件或政策内容。' }, 400);
      }
      return json(await reparsePhase2BCandidates({ repository: repositoryFactory() }));
    }
    if (request.method === 'POST' && pathname === '/api/admin/evidence/suggest-phase2b-metadata') {
      const input = await requestBody(request);
      if (Object.keys(input).length !== 2 || input.apply !== true || input.confirmation !== PHASE_2D_METADATA_SUGGESTION_CONFIRMATION) {
        return json({ error: 'metadata_suggestion 只接受固定 apply 与 confirmation，且不会接收 URL、文件或政策内容。' }, 400);
      }
      return json(await generatePhase2BMetadataSuggestions({ repository: repositoryFactory() }));
    }
    if (request.method === 'GET' && pathname === '/api/admin/evidence/status') return json(await readEvidenceStatus({ repository: repositoryFactory() }));
    if (request.method === 'POST' && pathname === '/api/admin/evidence/risk-queue/manifests') {
      const input = await requestBody(request);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => key !== 'filters')) return json({ error: 'Low Risk manifest 只接受服务端筛选条件，不接受 Candidate ID 或政策内容。' }, 400);
      return json({ mode: 'dry_run_manifest', ...safeManifest(await repositoryFactory().createLowRiskReviewManifest({ filters: input.filters || {} })) });
    }
    if (request.method === 'GET' && /^\/api\/admin\/evidence\/risk-queue\/manifests\/[^/]+$/.test(pathname)) {
      return json(safeManifest(await repositoryFactory().getReviewBatchManifest(decodeURIComponent(pathname.split('/').pop()))));
    }
    if (request.method === 'POST' && /^\/api\/admin\/evidence\/risk-queue\/manifests\/[^/]+\/apply$/.test(pathname)) {
      const input = await requestBody(request);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2 || input.apply !== true || input.confirmation !== LOW_RISK_BATCH_CONFIRMATION_PHRASE) {
        return json({ error: 'Low Risk 批量确认只接受固定 apply 与确认短语，且不接受 Candidate ID、正文或 legal_status。' }, 400);
      }
      const manifestId = decodeURIComponent(pathname.split('/')[6]);
      return json(await applyLowRiskReviewManifest(manifestId, { repository: repositoryFactory(), publishProjection }));
    }
    if (request.method === 'GET' && pathname === '/api/admin/evidence/candidates') {
      const candidates = await repositoryFactory().listCandidatesForReview();
      return json({ candidates: candidates.map(adminCandidateSummary) });
    }
    if (request.method === 'GET' && /^\/api\/admin\/evidence\/candidates\/[^/]+$/.test(pathname)) {
      const candidateId = decodeURIComponent(pathname.split('/')[5]);
      return json({ detail: adminReviewDetail(await repositoryFactory().getCandidateForReview(candidateId)) });
    }
    if (request.method === 'GET' && /^\/api\/admin\/evidence\/candidates\/[^/]+\/risk-assessments$/.test(pathname)) {
      const candidateId = decodeURIComponent(pathname.split('/')[5]);
      return json({ assessments: await repositoryFactory().listCandidateRiskAssessments(candidateId) });
    }
    if (request.method === 'GET' && /^\/api\/admin\/evidence\/candidates\/[^/]+\/relation-proposals$/.test(pathname)) {
      const candidateId = decodeURIComponent(pathname.split('/')[5]);
      return json({ proposals: await repositoryFactory().listCandidateRelationProposals(candidateId) });
    }
    if (request.method === 'POST' && /^\/api\/admin\/evidence\/candidates\/[^/]+\/relation-proposals$/.test(pathname)) {
      const candidateId = decodeURIComponent(pathname.split('/')[5]);
      const input = await requestBody(request);
      if (Object.keys(input).length) return json({ error: '关系线索生成不接受请求参数。' }, 400);
      return json(await repositoryFactory().generateCandidateRelationProposals(candidateId));
    }
    if (request.method === 'POST' && /^\/api\/admin\/evidence\/relation-proposals\/[^/]+\/review$/.test(pathname)) {
      const proposalId = decodeURIComponent(pathname.split('/')[5]);
      const input = await requestBody(request);
      const allowed = new Set(['action', 'note']);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !allowed.has(key))) return json({ error: '关系线索审核只接受 action 与 note。' }, 400);
      return json(await repositoryFactory().reviewCandidateRelationProposal(proposalId, { action: input.action, note: input.note || '' }));
    }
    if (request.method === 'POST' && /^\/api\/admin\/evidence\/candidates\/[^/]+\/suggest-metadata$/.test(pathname)) {
      const candidateId = decodeURIComponent(pathname.split('/')[5]);
      const input = await requestBody(request);
      if (Object.keys(input).length) return json({ error: '单条 metadata_suggestion 不接受请求参数。' }, 400);
      return json(await generateEvidenceCandidateMetadataSuggestion(candidateId, { repository: repositoryFactory() }));
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
