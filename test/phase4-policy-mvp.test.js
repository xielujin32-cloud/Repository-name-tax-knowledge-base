import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NetlifyDB } from '@netlify/database-dev';
import { collectChinaTaxPolicyCandidates, diagnoseChinaTaxPilotTransport, dryRunChinaTaxPolicyPilot } from '../src/chinatax-evidence-collection.js';
import { createLocalEvidenceObjectStore } from '../src/evidence-object-store.js';
import { createPostgresEvidenceRepository } from '../src/postgres-evidence-repository.js';
import { createEvidenceAdminHandler, PHASE4_STA_CANDIDATE_INGEST_CONFIRMATION, reviewEvidenceCandidate } from '../netlify/lib/evidence-ingestion.mjs';

const primaryUrl = 'https://fgk.chinatax.gov.cn/zcfgk/c100027/phase4-one/content.html';
const secondUrl = 'https://fgk.chinatax.gov.cn/zcfgk/c100027/phase4-two/content.html';
const body = '第一条 为规范增值税有关事项，纳税人应当按照本公告规定办理。'.repeat(18);
const page = (title, documentNo, content = body) => `<html><head><meta name="PubDate" content="2026-09-01"></head><body><div class="detials contentLeft"><h3>${title}</h3><h5 class="actfwzh">${documentNo}</h5><div class="article"><div class="arc_cont"><p>${content}</p></div></div></div></body></html>`;
const expectedItem = (officialUrl, title, documentNumber, content = body) => ({
  official_url: officialUrl,
  body_hash: createHash('sha256').update(content).digest('hex'),
  policy_title: title,
  document_number: documentNumber,
  publication_date: '2026-09-01'
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taxkb-phase4-mvp-'));
  const database = new NetlifyDB({ directory: path.join(root, 'database'), logger: () => {} });
  await database.start();
  await database.reset();
  await database.applyMigrations(path.join(process.cwd(), 'netlify', 'database', 'migrations'));
  const repository = createPostgresEvidenceRepository({ pool: database, objectStore: createLocalEvidenceObjectStore({ rootDirectory: path.join(root, 'objects') }) });
  return { root, database, repository };
}

async function dispose(value) {
  await value.repository.close();
  await value.database.stop();
  await rm(value.root, { recursive: true, force: true });
}

test('Phase 4 官方 STA intake 只创建 Evidence、Candidate、Risk 和关系提案，不创建 Policy 或公开投影', async () => {
  const value = await fixture();
  try {
    const pages = new Map([
      [primaryUrl, page('国家税务总局关于增值税测试事项的公告', '国家税务总局公告2026年第1号')],
      [secondUrl, page('国家税务总局关于增值税补充事项的公告', '国家税务总局公告2026年第2号')]
    ]);
    const result = await collectChinaTaxPolicyCandidates({
      repository: value.repository,
      urls: [primaryUrl, secondUrl],
      fetchImpl: async (url) => new Response(pages.get(String(url)) || '', { status: pages.has(String(url)) ? 200 : 404, headers: { 'content-type': 'text/html; charset=utf-8' } })
    });
    assert.equal(result.created.raw_snapshots, 2);
    assert.equal(result.created.candidates, 2);
    assert.equal(result.created.policies, 0);
    assert.equal(result.created.policy_versions, 0);
    assert.equal(result.created.public_projections, 0);
    const candidates = await value.repository.listCandidatesForReview({ limit: 10 });
    assert.ok(candidates.every((candidate) => candidate.verification_state === 'pending_review' && candidate.legal_status === 'pending'));
    const detail = await value.repository.getCandidateForReview(result.results[0].candidate_id);
    assert.deepEqual(detail.candidate.parsed_fields.tax_categories, ['增值税']);
    assert.deepEqual(detail.candidate.parsed_fields.region, ['全国']);
    assert.ok(detail.candidate.parsed_fields.topics.includes('增值税'));
    assert.equal(detail.candidate.parsed_fields.policy_category, 'tax_policy');
    assert.equal(detail.candidate.parsed_fields.validity_status_suggestion, 'pending_verification');
    assert.ok(detail.candidate.parsed_fields.metadata_suggestion);
    assert.equal((await value.database.query('SELECT COUNT(*)::int AS count FROM policies')).rows[0].count, 0);
    assert.equal((await value.database.query('SELECT trust_level FROM sources WHERE source_id=$1', ['source-sta-policy-regulations'])).rows[0].trust_level, 'official_primary');
    await assert.rejects(
      () => value.repository.addSource({ source_id: 'source-unregistered-official', source_name: '未注册来源', official_domain: 'example.gov.cn', source_type: 'official-policy-regulations', trust_level: 'official_primary', adapter_version: 'test', base_url: 'https://example.gov.cn/' }),
      /受信任来源注册表/
    );
  } finally { await dispose(value); }
});

test('Phase 4 official intake skips one unreadable detail without creating Evidence or Candidate for it', async () => {
  const value = await fixture();
  try {
    const result = await collectChinaTaxPolicyCandidates({
      repository: value.repository,
      urls: [primaryUrl, secondUrl],
      fetchImpl: async (url) => {
        if (String(url) === secondUrl) throw new TypeError('upstream connection terminated');
        return new Response(page('国家税务总局关于增值税测试事项的公告', '国家税务总局公告2026年第1号'), { status: 200, headers: { 'content-type': 'text/html' } });
      }
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].official_url, primaryUrl);
    assert.deepEqual(result.skipped, [{ official_url: secondUrl, outcome: 'failed', reason: 'OFFICIAL_DETAIL_READ_FAILED', risk_flags: ['OFFICIAL_DETAIL_READ_FAILED'] }]);
    assert.equal(result.failed.length, 1);
    assert.equal(result.created.raw_snapshots, 1);
    assert.equal(result.created.candidates, 1);
    assert.equal(result.created.policies, 0);
    assert.equal(result.created.policy_versions, 0);
    assert.equal(result.created.public_projections, 0);
    assert.equal((await value.database.query('SELECT COUNT(*)::int AS count FROM raw_snapshots')).rows[0].count, 1);
    assert.equal((await value.database.query('SELECT COUNT(*)::int AS count FROM candidates')).rows[0].count, 1);
  } finally { await dispose(value); }
});

test('Phase 4 pilot dry-run returns safe per-page transport and structure diagnostics without policy HTML', async () => {
  const validHtml = page('国家税务总局关于增值税测试事项的公告', '国家税务总局公告2026年第1号');
  const missingContainerHtml = '<html><head><meta name="PubDate" content="2026-09-02"></head><body><h3>网关响应页面</h3></body></html>';
  const result = await dryRunChinaTaxPolicyPilot({
    urls: [primaryUrl, secondUrl],
    fetchImpl: async (url) => new Response(
      String(url) === primaryUrl ? validHtml : missingContainerHtml,
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }
    )
  });
  assert.equal(result.candidate_count, 2);
  const ready = result.candidates.find((item) => item.official_url === primaryUrl);
  const failed = result.candidates.find((item) => item.official_url === secondUrl);
  assert.deepEqual(ready.diagnostic, {
    http_status: 200,
    status_text: null,
    final_url: primaryUrl,
    final_domain: 'fgk.chinatax.gov.cn',
    redirected: false,
    content_type: 'text/html; charset=utf-8',
    content_encoding: null,
    response_headers: {},
    response_bytes: Buffer.byteLength(validHtml, 'utf8'),
    response_sha256: createHash('sha256').update(validHtml).digest('hex'),
    short_response_fingerprint: null,
    html_title: null,
    meta_refresh_target: null,
    script_src_count: 0,
    script_src_hosts: [],
    client_side_redirect_detected: false,
    body_container: 'arc_cont',
    body_container_found: true,
    title_found: true,
    document_number_found: true,
    publication_date_found: true,
    response_classification: 'official_policy_detail',
    failure_reason: null,
    retrieval: {
      attempt_count: 1,
      retried: false,
      retry_reason: null,
      initial_response_classification: null,
      initial_response_sha256: null
    }
  });
  assert.equal(failed.dry_run_error, 'POLICY_BODY_CONTAINER_MISSING');
  assert.deepEqual(failed.diagnostic, {
    http_status: 200,
    status_text: null,
    final_url: secondUrl,
    final_domain: 'fgk.chinatax.gov.cn',
    redirected: false,
    content_type: 'text/html; charset=utf-8',
    content_encoding: null,
    response_headers: {},
    response_bytes: Buffer.byteLength(missingContainerHtml, 'utf8'),
    response_sha256: createHash('sha256').update(missingContainerHtml).digest('hex'),
    short_response_fingerprint: {
      html_tag_present: true,
      head_tag_present: true,
      body_tag_present: true,
      meta_tag_count: 1,
      script_tag_count: 0,
      rendered_text_length: '网关响应页面'.length
    },
    html_title: null,
    meta_refresh_target: null,
    script_src_count: 0,
    script_src_hosts: [],
    client_side_redirect_detected: false,
    body_container: null,
    body_container_found: false,
    title_found: false,
    document_number_found: false,
    publication_date_found: false,
    response_classification: 'short_html_shell_or_error_page',
    failure_reason: 'POLICY_BODY_CONTAINER_MISSING',
    retrieval: {
      attempt_count: 3,
      retried: true,
      retry_reason: 'SHORT_HTML_SHELL_OR_ERROR_PAGE',
      initial_response_classification: 'short_html_shell_or_error_page',
      initial_response_sha256: createHash('sha256').update(missingContainerHtml).digest('hex')
    }
  });
  assert.deepEqual(result.transport_comparison, {
    ready: {
      count: 1,
      response_bytes: { min: Buffer.byteLength(validHtml, 'utf8'), max: Buffer.byteLength(validHtml, 'utf8') },
      classifications: { official_policy_detail: 1 },
      content_types: { 'text/html; charset=utf-8': 1 },
      content_encodings: { unknown: 1 }
    },
    failed_or_skipped: {
      count: 1,
      response_bytes: { min: Buffer.byteLength(missingContainerHtml, 'utf8'), max: Buffer.byteLength(missingContainerHtml, 'utf8') },
      classifications: { short_html_shell_or_error_page: 1 },
      content_types: { 'text/html; charset=utf-8': 1 },
      content_encodings: { unknown: 1 }
    }
  });
  assert.doesNotMatch(JSON.stringify(result), /raw_html|normalized_text_object_key|cookie|authorization/i);
});

test('Phase 4 pilot uses explicit browser-compatible official-page request headers in every runtime', async () => {
  let requestInit = null;
  await dryRunChinaTaxPolicyPilot({
    urls: [primaryUrl],
    fetchImpl: async (_url, init) => {
      requestInit = init;
      return new Response(page('国家税务总局关于增值税测试事项的公告', '国家税务总局公告2026年第1号'), {
        status: 200,
        headers: { 'content-type': 'text/html' }
      });
    }
  });
  assert.match(requestInit.headers['user-agent'], /^TaxPolicyKnowledgeBase\/0\.3/);
  assert.match(requestInit.headers.accept, /^text\/html,/);
  assert.equal(requestInit.headers['accept-language'], 'zh-CN,zh;q=0.9');
  assert.equal(requestInit.headers['cache-control'], 'no-cache, no-store, max-age=0');
  assert.equal(requestInit.headers.pragma, 'no-cache');
  assert.equal(requestInit.cache, 'no-store');
});

test('Phase 4 pilot classifies challenge and client-side redirect shells without disclosing their HTML', async () => {
  const challengeUrl = 'https://fgk.chinatax.gov.cn/zcfgk/c100027/phase4-challenge/content.html';
  const redirectUrl = 'https://fgk.chinatax.gov.cn/zcfgk/c100027/phase4-redirect/content.html';
  const result = await dryRunChinaTaxPolicyPilot({
    urls: [challengeUrl, redirectUrl],
    fetchImpl: async (url) => new Response(
      String(url) === challengeUrl
        ? '<html><title>Access Denied</title><body>Security verification required</body></html>'
        : '<html><head><meta http-equiv="refresh" content="0; url=/zcfgk/c100027/next/content.html"></head><body></body></html>',
      { status: 200, headers: { 'content-type': 'text/html', server: 'safe-test-gateway' } }
    )
  });
  const challenge = result.candidates[0].diagnostic;
  const redirect = result.candidates[1].diagnostic;
  assert.equal(challenge.response_classification, 'waf_or_challenge_page');
  assert.equal(challenge.html_title, 'Access Denied');
  assert.deepEqual(challenge.response_headers, { server: 'safe-test-gateway' });
  assert.equal(redirect.response_classification, 'client_side_redirect_page');
  assert.equal(redirect.meta_refresh_target, 'fgk.chinatax.gov.cn/zcfgk/c100027/next/content.html');
  assert.equal(redirect.client_side_redirect_detected, true);
  assert.doesNotMatch(JSON.stringify(result), /Security verification required|raw_html|authorization|cookie/i);
});

test('Phase 4 P1 transport diagnostic keeps a fixed sequence and exposes only safe order-sensitive response summaries', async () => {
  const targetUrl = 'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5247077/content.html';
  const shortShell = '<html><head></head><body>temporary gateway shell</body></html>';
  const seen = [];
  const result = await diagnoseChinaTaxPilotTransport({
    delayMs: 0,
    waitImpl: async () => {},
    fetchImpl: async (url) => {
      seen.push(String(url));
      return new Response(String(url) === targetUrl ? shortShell : page('国家税务总局关于增值税测试事项的公告', '国家税务总局公告2026年第1号'), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'transfer-encoding': 'chunked', server: 'safe-test-gateway' }
      });
    }
  });
  assert.equal(result.mode, 'read_only_transport_diagnostic');
  assert.equal(result.fixed_url_count, 10);
  assert.equal(result.request_count, 9);
  assert.equal(seen.length, 9);
  assert.deepEqual(result.scenarios.map((item) => [item.name, item.requests.map((request) => request.ordinal)]), [
    ['ordinal_10_alone', [10]],
    ['ordinal_10_retry_after_fixed_delay', [10, 10]],
    ['ordinal_10_first_then_1', [10, 1]],
    ['ordinal_1_then_10', [1, 10]],
    ['ordinal_9_then_10', [9, 10]]
  ]);
  const targetRequests = result.scenarios.flatMap((item) => item.requests).filter((item) => item.ordinal === 10);
  assert.equal(targetRequests.length, 6);
  assert.ok(targetRequests.every((item) => item.parse_succeeded === false && item.diagnostic.response_classification === 'short_html_shell_or_error_page'));
  assert.equal(result.target_response_hashes.length, 1);
  assert.equal(result.target_response_hash_stable, true);
  assert.equal(result.writes.business_production_writes, 0);
  const encoded = JSON.stringify(result);
  assert.doesNotMatch(encoded, /temporary gateway shell|raw_html|normalized_text|cookie|authorization/i);
  assert.equal(result.scenarios[0].requests[0].diagnostic.response_headers['transfer-encoding'], 'chunked');
});

test('Phase 4 pilot retries one transient short official shell and remains fail-closed if the retry is also incomplete', async () => {
  const shortShell = '<html><body>temporary gateway page</body></html>';
  let calls = 0;
  const recovered = await dryRunChinaTaxPolicyPilot({
    urls: [primaryUrl],
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return new Response(calls === 1 ? shortShell : page('国家税务总局关于增值税测试事项的公告', '国家税务总局公告2026年第1号'), {
        status: 200,
        headers: { 'content-type': 'text/html' }
      });
    }
  });
  assert.equal(calls, 2);
  assert.equal(recovered.import_ready_count, 1);
  assert.deepEqual(recovered.candidates[0].diagnostic.retrieval, {
    attempt_count: 2,
    retried: true,
    retry_reason: 'SHORT_HTML_SHELL_OR_ERROR_PAGE',
    initial_response_classification: 'short_html_shell_or_error_page',
    initial_response_sha256: createHash('sha256').update(shortShell).digest('hex')
  });

  calls = 0;
  const stillIncomplete = await dryRunChinaTaxPolicyPilot({
    urls: [primaryUrl],
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return new Response(shortShell, { status: 200, headers: { 'content-type': 'text/html' } });
    }
  });
  assert.equal(calls, 2);
  assert.equal(stillIncomplete.import_ready_count, 0);
  assert.equal(stillIncomplete.writes.business_production_writes, 0);
  assert.equal(stillIncomplete.candidates[0].dry_run_error, 'POLICY_BODY_CONTAINER_MISSING');
  assert.deepEqual(stillIncomplete.candidates[0].diagnostic.retrieval, {
    attempt_count: 2,
    retried: true,
    retry_reason: 'SHORT_HTML_SHELL_OR_ERROR_PAGE',
    initial_response_classification: 'short_html_shell_or_error_page',
    initial_response_sha256: createHash('sha256').update(shortShell).digest('hex')
  });
});

test('Phase 4 default transport recovery permits a complete third response but never accepts either short shell', async () => {
  const shortShell = '<html><body>temporary gateway page</body></html>';
  let calls = 0;
  const recovered = await dryRunChinaTaxPolicyPilot({
    urls: [primaryUrl],
    fetchImpl: async () => {
      calls += 1;
      return new Response(calls < 3 ? shortShell : page('国家税务总局关于增值税测试事项的公告', '国家税务总局公告2026年第1号'), {
        status: 200,
        headers: { 'content-type': 'text/html' }
      });
    }
  });
  assert.equal(calls, 3);
  assert.equal(recovered.import_ready_count, 1);
  assert.equal(recovered.candidates[0].diagnostic.retrieval.attempt_count, 3);
  assert.equal(recovered.candidates[0].diagnostic.retrieval.retried, true);
  assert.equal(recovered.writes.business_production_writes, 0);
});

test('Phase 4 protected import retries only before its atomic pre-write gate and does not persist an incomplete retry', async () => {
  const value = await fixture();
  try {
    const shortShell = '<html><body>temporary gateway page</body></html>';
    const expected = expectedItem(primaryUrl, '国家税务总局关于增值税测试事项的公告', '国家税务总局公告2026年第1号');
    let calls = 0;
    await assert.rejects(
      () => collectChinaTaxPolicyCandidates({
        repository: value.repository,
        urls: [primaryUrl],
        expectedItems: [expected],
        retryDelayMs: 0,
        fetchImpl: async () => {
          calls += 1;
          return new Response(shortShell, { status: 200, headers: { 'content-type': 'text/html' } });
        }
      }),
      (error) => error?.code === 'PREWRITE_POLICY_BODY_CONTAINER_MISSING'
    );
    assert.equal(calls, 2);
    for (const table of ['raw_snapshots', 'candidates', 'collection_runs', 'candidate_risk_assessments', 'candidate_relation_proposals']) {
      assert.equal((await value.database.query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0].count, 0);
    }
    assert.equal((await value.database.query('SELECT COUNT(*)::int AS count FROM policies')).rows[0].count, 0);
  } finally { await dispose(value); }
});

test('Phase 4 protected intake attests all 9 expected items before any Candidate or Evidence write', async () => {
  const value = await fixture();
  try {
    const pilot = Array.from({ length: 9 }, (_, index) => {
      const ordinal = index + 1;
      const officialUrl = `https://fgk.chinatax.gov.cn/zcfgk/c100027/phase4-attested-${ordinal}/content.html`;
      const title = `国家税务总局关于增值税测试事项${ordinal}的公告`;
      const documentNumber = `国家税务总局公告2026年第${ordinal}号`;
      const content = `${body}${ordinal}`;
      return { officialUrl, title, documentNumber, content };
    });
    const pages = new Map(pilot.map((item) => [item.officialUrl, page(item.title, item.documentNumber, item.content)]));
    const result = await collectChinaTaxPolicyCandidates({
      repository: value.repository,
      urls: pilot.map((item) => item.officialUrl),
      expectedItems: pilot.map((item) => expectedItem(item.officialUrl, item.title, item.documentNumber, item.content)),
      fetchImpl: async (url) => new Response(pages.get(String(url)), { status: 200, headers: { 'content-type': 'text/html' } })
    });
    assert.equal(result.results.length, 9);
    assert.equal(result.created.raw_snapshots, 9);
    assert.equal(result.created.candidates, 9);
    assert.equal(result.created.policies, 0);
    assert.equal(result.created.policy_versions, 0);
    assert.equal(result.created.public_projections, 0);
  } finally { await dispose(value); }
});

test('Phase 4 protected candidate route returns a safe 409 and zero writes when a pre-write hash changes', async () => {
  const value = await fixture();
  const previous = process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
  process.env.NETLIFY_TAXKB_ADMIN_TOKEN = 'phase4-prewrite-token';
  try {
    const handler = createEvidenceAdminHandler({
      repositoryFactory: () => value.repository,
      fetchImpl: async () => new Response(page('国家税务总局关于增值税测试事项的公告', '国家税务总局公告2026年第1号'), { status: 200, headers: { 'content-type': 'text/html' } })
    });
    const response = await handler(new Request('https://taxkb.test/api/admin/evidence/sources/chinatax/candidates', {
      method: 'POST',
      headers: { authorization: 'Bearer phase4-prewrite-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        apply: true,
        confirmation: PHASE4_STA_CANDIDATE_INGEST_CONFIRMATION,
        official_urls: [primaryUrl],
        expected_items: [{ ...expectedItem(primaryUrl, '国家税务总局关于增值税测试事项的公告', '国家税务总局公告2026年第1号'), body_hash: 'f'.repeat(64) }]
      })
    }), '/api/admin/evidence/sources/chinatax/candidates', new URL('https://taxkb.test/api/admin/evidence/sources/chinatax/candidates'));
    assert.equal(response.status, 409);
    const rejected = await response.json();
    assert.equal(rejected.error, 'phase4p1_prewrite_validation_failed');
    assert.equal(rejected.code, 'PREWRITE_BODY_HASH_MISMATCH');
    assert.equal(rejected.business_production_writes, 0);
    assert.equal(rejected.partial_write_detected, false);
    assert.equal(rejected.mismatch.ordinal, 1);
    assert.equal(rejected.mismatch.official_url, primaryUrl);
    assert.equal(rejected.mismatch.mismatch_reason, 'BODY_HASH_MISMATCH');
    assert.equal(rejected.mismatch.expected.body_hash, 'f'.repeat(64));
    assert.equal(rejected.mismatch.actual.policy_title, '国家税务总局关于增值税测试事项的公告');
    assert.equal(rejected.mismatch.actual.document_number, '国家税务总局公告2026年第1号');
    assert.equal(rejected.mismatch.actual.publication_date, '2026-09-01');
    for (const table of ['collection_runs', 'raw_snapshots', 'candidates', 'candidate_risk_assessments', 'candidate_relation_proposals']) {
      const { rows } = await value.database.query(`SELECT COUNT(*)::int AS count FROM ${table}`);
      assert.equal(rows[0].count, 0, `${table} must stay empty after a rejected request`);
    }
    const diagnosticResponse = await handler(new Request('https://taxkb.test/api/admin/evidence/sources/chinatax/pilot-intake-status', {
      headers: { authorization: 'Bearer phase4-prewrite-token' }
    }), '/api/admin/evidence/sources/chinatax/pilot-intake-status', new URL('https://taxkb.test/api/admin/evidence/sources/chinatax/pilot-intake-status'));
    assert.equal(diagnosticResponse.status, 200);
    const diagnostic = await diagnosticResponse.json();
    assert.equal(diagnostic.mode, 'read_only_pilot_intake_status');
    assert.equal(diagnostic.raw_snapshot_writes, 0);
    assert.equal(diagnostic.evidence_writes, 0);
    assert.equal(diagnostic.candidate_writes, 0);
    assert.equal(diagnostic.risk_writes, 0);
    assert.equal(diagnostic.relation_writes, 0);
    assert.equal(diagnostic.total_business_writes, 0);
    assert.equal(diagnostic.partial_write_detected, false);
    assert.equal(diagnostic.business_production_writes, 0);
    assert.equal(/raw_html|normalized_text|authorization|cookie/i.test(JSON.stringify(diagnostic)), false);
  } finally {
    if (previous === undefined) delete process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
    else process.env.NETLIFY_TAXKB_ADMIN_TOKEN = previous;
    await dispose(value);
  }
});

test('Phase 4 protected intake rejects any hash, URL set, or missing hash before all business writes', async () => {
  const cases = [
    {
      name: 'hash mismatch',
      urls: [primaryUrl, secondUrl],
      expectedItems: [
        { ...expectedItem(primaryUrl, '国家税务总局关于增值税测试事项的公告', '国家税务总局公告2026年第1号'), body_hash: '0'.repeat(64) },
        expectedItem(secondUrl, '国家税务总局关于增值税补充事项的公告', '国家税务总局公告2026年第2号')
      ],
      code: 'PREWRITE_BODY_HASH_MISMATCH'
    },
    {
      name: 'URL set mismatch',
      urls: [primaryUrl, secondUrl],
      expectedItems: [
        expectedItem(primaryUrl, '国家税务总局关于增值税测试事项的公告', '国家税务总局公告2026年第1号'),
        expectedItem('https://fgk.chinatax.gov.cn/zcfgk/c100027/phase4-third/content.html', '国家税务总局关于增值税补充事项的公告', '国家税务总局公告2026年第2号')
      ],
      code: 'PREWRITE_URL_SET_MISMATCH'
    },
    {
      name: 'missing expected hash',
      urls: [primaryUrl, secondUrl],
      expectedItems: [
        { ...expectedItem(primaryUrl, '国家税务总局关于增值税测试事项的公告', '国家税务总局公告2026年第1号'), body_hash: '' },
        expectedItem(secondUrl, '国家税务总局关于增值税补充事项的公告', '国家税务总局公告2026年第2号')
      ],
      code: 'PREWRITE_EXPECTED_BODY_HASH_MISSING'
    }
  ];
  for (const scenario of cases) {
    const value = await fixture();
    try {
      await assert.rejects(
        () => collectChinaTaxPolicyCandidates({
          repository: value.repository,
          urls: scenario.urls,
          expectedItems: scenario.expectedItems,
          fetchImpl: async () => new Response(page('国家税务总局关于增值税测试事项的公告', '国家税务总局公告2026年第1号'), { status: 200, headers: { 'content-type': 'text/html' } })
        }),
        (error) => error?.code === scenario.code,
        scenario.name
      );
      for (const table of ['collection_runs', 'raw_snapshots', 'candidates', 'candidate_risk_assessments', 'candidate_relation_proposals', 'policies', 'policy_versions']) {
        const { rows } = await value.database.query(`SELECT COUNT(*)::int AS count FROM ${table}`);
        assert.equal(rows[0].count, 0, `${scenario.name}: ${table} must stay empty`);
      }
    } finally { await dispose(value); }
  }
});

test('Phase 4 P1 atomic intake rejects a first-item or tenth-item consistency mismatch with zero writes', async () => {
  for (const mismatchOrdinal of [1, 10]) {
    const value = await fixture();
    try {
      const pilot = Array.from({ length: 10 }, (_, index) => {
        const ordinal = index + 1;
        const officialUrl = `https://fgk.chinatax.gov.cn/zcfgk/c100027/phase4-atomic-${ordinal}/content.html`;
        const title = `国家税务总局关于原子导入测试${ordinal}的公告`;
        const documentNumber = `国家税务总局公告2026年第${ordinal}号`;
        const content = `${body}${ordinal}`;
        return { officialUrl, title, documentNumber, content };
      });
      const pages = new Map(pilot.map((item) => [item.officialUrl, page(item.title, item.documentNumber, item.content)]));
      const expected = pilot.map((item) => expectedItem(item.officialUrl, item.title, item.documentNumber, item.content));
      expected[mismatchOrdinal - 1] = { ...expected[mismatchOrdinal - 1], body_hash: 'a'.repeat(64) };
      await assert.rejects(
        () => collectChinaTaxPolicyCandidates({
          repository: value.repository,
          urls: pilot.map((item) => item.officialUrl),
          expectedItems: expected,
          fetchImpl: async (url) => new Response(pages.get(String(url)), { status: 200, headers: { 'content-type': 'text/html' } })
        }),
        (error) => error?.code === 'PREWRITE_BODY_HASH_MISMATCH' && error?.mismatch?.ordinal === mismatchOrdinal
      );
      for (const table of ['collection_runs', 'raw_snapshots', 'candidates', 'candidate_risk_assessments', 'candidate_relation_proposals', 'policies', 'policy_versions']) {
        const { rows } = await value.database.query(`SELECT COUNT(*)::int AS count FROM ${table}`);
        assert.equal(rows[0].count, 0, `ordinal ${mismatchOrdinal}: ${table} must stay empty`);
      }
    } finally { await dispose(value); }
  }
});

test('Phase 4 P1 protected intake rejects a parse failure or duplicate URL before any write', async () => {
  for (const scenario of ['parse_failure', 'duplicate_url']) {
    const value = await fixture();
    try {
      const urls = scenario === 'duplicate_url' ? [primaryUrl, primaryUrl] : [primaryUrl, secondUrl];
      const expectedItems = scenario === 'duplicate_url'
        ? [expectedItem(primaryUrl, '国家税务总局关于增值税测试事项的公告', '国家税务总局公告2026年第1号')]
        : [
            expectedItem(primaryUrl, '国家税务总局关于增值税测试事项的公告', '国家税务总局公告2026年第1号'),
            expectedItem(secondUrl, '国家税务总局关于增值税补充事项的公告', '国家税务总局公告2026年第2号')
          ];
      await assert.rejects(
        () => collectChinaTaxPolicyCandidates({
          repository: value.repository,
          urls,
          expectedItems,
          fetchImpl: async (url) => {
            if (scenario === 'parse_failure' && String(url) === secondUrl) return new Response('<html><body>no supported article container</body></html>', { status: 200 });
            return new Response(page('国家税务总局关于增值税测试事项的公告', '国家税务总局公告2026年第1号'), { status: 200, headers: { 'content-type': 'text/html' } });
          }
        }),
        (error) => scenario === 'parse_failure'
          ? error?.code === 'PREWRITE_POLICY_BODY_CONTAINER_MISSING'
          : /互不重复/.test(String(error?.message || ''))
      );
      for (const table of ['collection_runs', 'raw_snapshots', 'candidates', 'candidate_risk_assessments', 'candidate_relation_proposals', 'policies', 'policy_versions']) {
        const { rows } = await value.database.query(`SELECT COUNT(*)::int AS count FROM ${table}`);
        assert.equal(rows[0].count, 0, `${scenario}: ${table} must stay empty`);
      }
    } finally { await dispose(value); }
  }
});

test('Phase 4 P1 atomic database conflict rolls back the whole protected batch without a new run or Candidate', async () => {
  const value = await fixture();
  try {
    const title = '国家税务总局关于增值税测试事项的公告';
    const documentNumber = '国家税务总局公告2026年第1号';
    const html = page(title, documentNumber);
    await collectChinaTaxPolicyCandidates({
      repository: value.repository,
      urls: [primaryUrl],
      fetchImpl: async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
    });
    const before = {};
    for (const table of ['collection_runs', 'raw_snapshots', 'candidates', 'candidate_risk_assessments', 'candidate_relation_proposals', 'policies', 'policy_versions']) {
      before[table] = (await value.database.query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0].count;
    }
    await assert.rejects(
      () => collectChinaTaxPolicyCandidates({
        repository: value.repository,
        urls: [primaryUrl],
        expectedItems: [expectedItem(primaryUrl, title, documentNumber)],
        fetchImpl: async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
      }),
      (error) => error?.code === 'PILOT_EXISTING_EVIDENCE_CONFLICT'
    );
    for (const [table, count] of Object.entries(before)) {
      assert.equal((await value.database.query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0].count, count, `${table} must not gain a partial record`);
    }
  } finally { await dispose(value); }
});

test('Phase 4 P1 recovery dry-run scopes objects to pilot runs and excludes same-URL legacy Evidence', async () => {
  const value = await fixture();
  try {
    const source = await value.repository.addSource({
      source_id: 'source-sta-policy-regulations', source_name: '国家税务总局政策法规库', official_domain: 'fgk.chinatax.gov.cn',
      source_type: 'official-policy-regulations', trust_level: 'official_primary', adapter_version: 'test', base_url: 'https://fgk.chinatax.gov.cn/'
    });
    const legacyRun = await value.repository.createCollectionRun({ source_id: source.source_id, mode: 'phase2d-production-whitelist' });
    const legacySnapshot = await value.repository.recordRawSnapshot({ source_id: source.source_id, collection_run_id: legacyRun.collection_run_id, official_url: primaryUrl, raw_content: '<article>legacy evidence</article>', normalized_text: `${body} legacy`, parser_version: 'test', parse_result: {} });
    await value.repository.createCandidate({ snapshot_id: legacySnapshot.snapshot_id, parsed_fields: { title: 'legacy', document_no: '国家税务总局公告2025年第1号', document_no_source: 'structured_field', document_no_confidence: 'high' } });
    await value.repository.finishCollectionRun(legacyRun.collection_run_id, 'completed');

    const pilotRun = await value.repository.createCollectionRun({ source_id: source.source_id, mode: 'mvp-official-candidate-intake' });
    const pilotSnapshot = await value.repository.recordRawSnapshot({ source_id: source.source_id, collection_run_id: pilotRun.collection_run_id, official_url: primaryUrl, raw_content: '<article>failed pilot evidence</article>', normalized_text: `${body} failed pilot`, parser_version: 'test', parse_result: {} });
    const pilotCandidate = await value.repository.createCandidate({ snapshot_id: pilotSnapshot.snapshot_id, parsed_fields: { title: 'pilot', document_no: '国家税务总局公告2026年第1号', document_no_source: 'structured_field', document_no_confidence: 'high' } });
    await value.repository.finishCollectionRun(pilotRun.collection_run_id, 'failed');

    const diagnostic = await value.repository.getOfficialIntakeDiagnostics({ sourceId: source.source_id, officialUrls: [primaryUrl] });
    assert.equal(diagnostic.raw_snapshot_writes, 1);
    assert.equal(diagnostic.candidate_writes, 1);
    assert.equal(diagnostic.non_pilot_matching_records.raw_snapshots, 1);
    assert.equal(diagnostic.non_pilot_matching_records.candidates, 1);
    assert.equal(diagnostic.recovery_dry_run.execution, 'dry_run');
    assert.equal(diagnostic.recovery_dry_run.mutation_allowed, false);
    assert.deepEqual(diagnostic.recovery_dry_run.items.map((item) => item.candidate_id), [pilotCandidate.candidate.candidate_id]);
    assert.equal(diagnostic.recovery_dry_run.items[0].snapshot_id, pilotSnapshot.snapshot_id);
    assert.equal(diagnostic.recovery_dry_run.items[0].recovery_eligible, true);
    assert.equal(diagnostic.recovery_dry_run.items[0].official_url, primaryUrl);
  } finally { await dispose(value); }
});

test('Risk/Level 3 门禁只公开已核验且无阻断项的政策，缺少风险审查的批准不会写公开投影', async () => {
  const value = await fixture();
  try {
    const pages = new Map([[primaryUrl, page('国家税务总局关于增值税测试事项的公告', '国家税务总局公告2026年第1号')]]);
    const collected = await collectChinaTaxPolicyCandidates({
      repository: value.repository, urls: [primaryUrl],
      fetchImpl: async (url) => new Response(pages.get(String(url)) || '', { status: 200, headers: { 'content-type': 'text/html' } })
    });
    const candidateId = collected.results[0].candidate_id;
    const detail = await value.repository.getCandidateForReview(candidateId);
    const fields = {
      title: detail.candidate.parsed_fields.title,
      document_no: detail.candidate.parsed_fields.document_no,
      issuing_authority: detail.candidate.parsed_fields.issuing_authority,
      publish_date: detail.candidate.parsed_fields.publish_date,
      effective_date: detail.candidate.parsed_fields.effective_date,
      expiry_date: detail.candidate.parsed_fields.expiry_date,
      tax_categories: detail.candidate.parsed_fields.metadata_suggestion.tax_categories.values,
      keywords: detail.candidate.parsed_fields.metadata_suggestion.keywords.values,
      summary: detail.candidate.parsed_fields.metadata_suggestion.summary.value
    };
    const published = [];
    const approved = await reviewEvidenceCandidate(candidateId, { action: 'approve', legal_status: 'effective', fields }, {
      repository: value.repository,
      publishProjection: async (projection) => { published.push(projection); return { added: 1 }; },
      reviewerId: 'level3-test'
    });
    assert.equal(approved.publication_readiness.eligible, true);
    assert.equal(approved.publication.execution, 'published');
    assert.equal(published.length, 1);
    assert.equal(published[0].verification_state, 'verified');
    assert.equal(published[0].source_trust_level, 'official_primary');
    assert.equal(published[0].evidence.normalized_text, undefined);

    const run = await value.repository.createCollectionRun({ source_id: 'source-sta-policy-regulations', mode: 'missing-risk-test' });
    const snapshot = await value.repository.recordRawSnapshot({ source_id: 'source-sta-policy-regulations', collection_run_id: run.collection_run_id, official_url: 'https://fgk.chinatax.gov.cn/zcfgk/c100027/missing-risk/content.html', raw_content: '<article>正文</article>', normalized_text: body, parser_version: 'test', parse_result: {} });
    const unassessed = await value.repository.createCandidate({ snapshot_id: snapshot.snapshot_id, parsed_fields: { ...detail.candidate.parsed_fields, title: '国家税务总局关于未评估政策的公告', document_no: '国家税务总局公告2026年第99号', snapshot_id: snapshot.snapshot_id } });
    const blocked = await reviewEvidenceCandidate(unassessed.candidate.candidate_id, { action: 'approve', legal_status: 'effective', fields: { ...fields, title: '国家税务总局关于未评估政策的公告', document_no: '国家税务总局公告2026年第99号' } }, {
      repository: value.repository, publishProjection: async () => { throw new Error('blocked Candidate must not publish'); }, reviewerId: 'level3-test'
    });
    assert.equal(blocked.publication.execution, 'blocked');
    assert.ok(blocked.publication.blockers.includes('RISK_ASSESSMENT_MISSING'));
  } finally { await dispose(value); }
});

test('Phase 4 STA discovery 只读且 Candidate intake 需要固定确认，不会进入公开发布流程', async () => {
  const previous = process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
  process.env.NETLIFY_TAXKB_ADMIN_TOKEN = 'phase4-admin-token';
  let discoveryOptions = null;
  let intakeCalls = 0;
  const relationSteps = [];
  const handler = createEvidenceAdminHandler({
    repositoryFactory: () => ({
      relationProposalAffectedPolicyVersions: async () => { relationSteps.push('read'); return ['policy-version-a', 'policy-version-b']; },
      reviewCandidateRelationProposal: async () => { relationSteps.push('confirm'); return { execution: 'confirm', policy_relation: { policy_relation_id: 'relation-test' } }; }
    }),
    suppressPublicPolicies: async ({ policyVersionIds }) => { relationSteps.push(`suppress:${policyVersionIds.join(',')}`); return { suppressed: policyVersionIds.length, policy_ids: ['policy-a', 'policy-b'] }; },
    chinaTaxDiscoveryFactory: async (options) => {
      discoveryOptions = options;
      return { mode: 'dry-run', candidates: [{ official_url: primaryUrl, title: '安全摘要' }], writes: { raw_snapshots: 0, candidates: 0, policies: 0, netlify_blobs: 0 } };
    },
    chinaTaxCandidateCollector: async ({ urls, expectedItems }) => {
      intakeCalls += 1;
      assert.equal(expectedItems.length, urls.length);
      return { selected_count: urls.length, created: { raw_snapshots: 1, candidates: 1, policies: 0, policy_versions: 0, public_projections: 0 } };
    }
  });
  const invoke = (pathname, { method = 'GET', token = '', body: requestBody } = {}) => handler(
    new Request(`https://taxkb.example${pathname}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(requestBody ? { 'content-type': 'application/json' } : {}) },
      body: requestBody ? JSON.stringify(requestBody) : undefined
    }), new URL(`https://taxkb.example${pathname}`).pathname, new URL(`https://taxkb.example${pathname}`)
  );
  try {
    assert.equal((await invoke('/api/admin/evidence/sources/chinatax/discovery')).status, 401);
    const discovery = await invoke('/api/admin/evidence/sources/chinatax/discovery?limit=999&page_size=999&max_pages=999', { token: process.env.NETLIFY_TAXKB_ADMIN_TOKEN });
    assert.equal(discovery.status, 200);
    const discoveryBody = await discovery.json();
    assert.equal(discoveryBody.writes.candidates, 0);
    assert.equal('raw_html' in discoveryBody.candidates[0], false);
    assert.equal(discoveryOptions.limit, 100);
    assert.equal(discoveryOptions.pageSize, 20);
    assert.equal(discoveryOptions.maxPages, 5);

    const rejected = await invoke('/api/admin/evidence/sources/chinatax/candidates', {
      method: 'POST', token: process.env.NETLIFY_TAXKB_ADMIN_TOKEN, body: { apply: true, confirmation: 'wrong', official_urls: [primaryUrl], expected_items: [] }
    });
    assert.equal(rejected.status, 400);
    assert.equal(intakeCalls, 0);

    const intake = await invoke('/api/admin/evidence/sources/chinatax/candidates', {
      method: 'POST', token: process.env.NETLIFY_TAXKB_ADMIN_TOKEN,
      body: {
        apply: true,
        confirmation: PHASE4_STA_CANDIDATE_INGEST_CONFIRMATION,
        official_urls: [primaryUrl],
        expected_items: [expectedItem(primaryUrl, '国家税务总局关于增值税测试事项的公告', '国家税务总局公告2026年第1号')]
      }
    });
    const intakeBody = await intake.json();
    assert.equal(intake.status, 201);
    assert.equal(intakeCalls, 1);
    assert.equal(intakeBody.created.policies, 0);
    assert.equal(intakeBody.created.public_projections, 0);

    const relation = await invoke('/api/admin/evidence/relation-proposals/proposal-test/review', {
      method: 'POST', token: process.env.NETLIFY_TAXKB_ADMIN_TOKEN, body: { action: 'confirm', note: '人工确认关系' }
    });
    assert.equal(relation.status, 200);
    assert.deepEqual(relationSteps, ['read', 'suppress:policy-version-a,policy-version-b', 'confirm']);
    assert.equal((await relation.json()).public_visibility_suppression.suppressed, 2);
  } finally {
    if (previous === undefined) delete process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
    else process.env.NETLIFY_TAXKB_ADMIN_TOKEN = previous;
  }
});

test('Phase 4 P1 transport diagnostic is admin-only, fixed, query-free, and repository-free', async () => {
  const previous = process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
  process.env.NETLIFY_TAXKB_ADMIN_TOKEN = 'phase4-transport-token';
  let repositoryCalls = 0;
  let diagnosticCalls = 0;
  const handler = createEvidenceAdminHandler({
    repositoryFactory: () => { repositoryCalls += 1; throw new Error('transport diagnostic must not read repository'); },
    chinaTaxTransportDiagnosticFactory: async ({ fetchImpl }) => {
      diagnosticCalls += 1;
      assert.equal(typeof fetchImpl, 'function');
      return {
        mode: 'read_only_transport_diagnostic', fixed_url_count: 10,
        target: { ordinal: 10, official_url: 'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5247077/content.html' },
        scenarios: [], target_response_hashes: [], target_response_hash_stable: false, request_count: 0,
        writes: { raw_snapshots: 0, evidence: 0, candidates: 0, collection_runs: 0, risk: 0, relation: 0, policies: 0, policy_versions: 0, public_projections: 0, business_production_writes: 0 }
      };
    }
  });
  const invoke = (suffix = '', token = '') => handler(
    new Request(`https://taxkb.example/api/admin/evidence/sources/chinatax/pilot-transport-diagnostic${suffix}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }),
    '/api/admin/evidence/sources/chinatax/pilot-transport-diagnostic',
    new URL(`https://taxkb.example/api/admin/evidence/sources/chinatax/pilot-transport-diagnostic${suffix}`)
  );
  try {
    assert.equal((await invoke()).status, 401);
    const rejectedQuery = await invoke('?url=https://example.invalid/', process.env.NETLIFY_TAXKB_ADMIN_TOKEN);
    assert.equal(rejectedQuery.status, 400);
    const response = await invoke('', process.env.NETLIFY_TAXKB_ADMIN_TOKEN);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.mode, 'read_only_transport_diagnostic');
    assert.equal(body.writes.business_production_writes, 0);
    assert.equal(diagnosticCalls, 1);
    assert.equal(repositoryCalls, 0);
  } finally {
    if (previous === undefined) delete process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
    else process.env.NETLIFY_TAXKB_ADMIN_TOKEN = previous;
  }
});

test('确认版本关系后，可使用既有 Level 3 审核材料重新投影，不重抓正文或绕过关系门禁', async () => {
  const value = await fixture();
  try {
    const targetTitle = '国家税务总局关于被替代事项的公告';
    const targetDocumentNo = '国家税务总局公告2026年第2号';
    const sourceTitle = '国家税务总局关于替代事项的公告';
    const sourceDocumentNo = '国家税务总局公告2026年第3号';
    const pages = new Map([
      [secondUrl, page(targetTitle, targetDocumentNo)],
      [primaryUrl, page(sourceTitle, sourceDocumentNo, `${body}《${targetTitle}》（${targetDocumentNo}）废止。`)]
    ]);
    const collected = await collectChinaTaxPolicyCandidates({
      repository: value.repository, urls: [secondUrl, primaryUrl],
      fetchImpl: async (url) => new Response(pages.get(String(url)) || '', { status: 200, headers: { 'content-type': 'text/html' } })
    });
    const byUrl = new Map(collected.results.map((item) => [item.official_url, item.candidate_id]));
    const sourceCandidateId = byUrl.get(primaryUrl);
    const targetCandidateId = byUrl.get(secondUrl);
    const projected = [];
    const approve = async (candidateId) => {
      const detail = await value.repository.getCandidateForReview(candidateId);
      return reviewEvidenceCandidate(candidateId, {
        action: 'approve', legal_status: 'effective',
        fields: {
          title: detail.candidate.parsed_fields.title,
          document_no: detail.candidate.parsed_fields.document_no,
          issuing_authority: detail.candidate.parsed_fields.issuing_authority,
          publish_date: detail.candidate.parsed_fields.publish_date,
          effective_date: detail.candidate.parsed_fields.effective_date,
          expiry_date: detail.candidate.parsed_fields.expiry_date,
          tax_categories: detail.candidate.parsed_fields.metadata_suggestion.tax_categories.values,
          keywords: detail.candidate.parsed_fields.metadata_suggestion.keywords.values,
          summary: detail.candidate.parsed_fields.metadata_suggestion.summary.value
        }
      }, { repository: value.repository, publishProjection: async (projection) => { projected.push(projection); return { added: 1 }; }, reviewerId: 'level3-test' });
    };

    const initiallyBlocked = await approve(sourceCandidateId);
    assert.equal(initiallyBlocked.publication.execution, 'blocked');
    assert.ok(initiallyBlocked.publication.blockers.includes('RELATION_REVIEW_REQUIRED'));
    await approve(targetCandidateId);
    const proposals = await value.repository.listCandidateRelationProposals(sourceCandidateId);
    assert.ok(proposals.length >= 1);
    for (const proposal of proposals) {
      const confirmed = await value.repository.reviewCandidateRelationProposal(proposal.proposal_id, { action: 'confirm', reviewer_id: 'level3-test' });
      assert.equal(confirmed.policy_relation.relation_state, 'confirmed');
    }
    assert.equal((await value.repository.listCandidateRelationProposals(sourceCandidateId)).filter((item) => item.proposal_state === 'proposed').length, 0);

    const reprojected = await approve(sourceCandidateId);
    assert.equal(reprojected.execution, 'already_approved');
    assert.equal(reprojected.publication.execution, 'published', JSON.stringify(reprojected.publication));
    const sourceProjection = projected.find((item) => item.id === reprojected.policy.policy_id);
    assert.ok(sourceProjection.version_relations.length >= 1);
    assert.ok(sourceProjection.version_relations.every((item) => item.relation_state === 'confirmed'));
    assert.ok(sourceProjection.version_relations.every((item) => item.document_no === targetDocumentNo));
  } finally { await dispose(value); }
});
