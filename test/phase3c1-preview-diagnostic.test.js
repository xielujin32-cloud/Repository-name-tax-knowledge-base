import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiHandler } from '../netlify/functions/api.mjs';
import { createEvidenceAdminHandler } from '../netlify/lib/evidence-ingestion.mjs';
import { PHASE3C1_FIXED_IMPORT_URLS, diagnosePhase3C1ImportPreview, diagnosePhase3C1OrdinalTenUpstreamStability, preparePhase3C1ImportPreview } from '../src/phase3c1-controlled-import.js';

const body = (index) => `为明确个人所得税征管事项，现将第${index}项安排公告如下。纳税人应当按照规定办理申报并保留资料。${'本公告明确适用对象、申报要求、资料留存和监督管理安排。'.repeat(20)}`;
const policyHtml = (index) => `<!doctype html><html><head><title>国家税务总局政策法规库</title><meta name="PubDate" content="2020-01-${String(index).padStart(2, '0')}"></head><body><div class="detials contentLeft"><h3>国家税务总局关于第${index}项个人所得税征管事项的公告</h3><h5 class="actfwzh">国税发〔2020〕${index}号</h5><div class="article"><div class="arc_cont"><p>${body(index)}</p></div></div></div></body></html>`;

function fakeFetch(url, options) {
  const index = PHASE3C1_FIXED_IMPORT_URLS.indexOf(String(url)) + 1;
  assert.ok(index, 'diagnostic must never fetch an injected URL');
  assert.equal(options.headers['user-agent'], 'TaxPolicyKnowledgeBase/0.3 (phase3c1-controlled-preview)');
  assert.equal(Object.hasOwn(options.headers, 'authorization'), false);
  assert.equal(Object.hasOwn(options.headers, 'cookie'), false);
  return Promise.resolve(new Response(policyHtml(index), { status: 200, headers: { 'content-type': 'text/html; charset=UTF-8' } }));
}

async function request(handler, pathname, { method = 'GET', token = '' } = {}) {
  const response = await handler(new Request(`https://taxkb.example${pathname}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} }));
  return { response, body: await response.json() };
}

test('Phase 3C Production preview diagnostic is admin-only, fixed-URL-only, and does not disclose HTML or secrets', async () => {
  const previous = process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
  process.env.NETLIFY_TAXKB_ADMIN_TOKEN = 'phase3c1-diagnostic-token';
  let repositoryFactoryCalls = 0;
  try {
    const handler = createApiHandler({ evidenceAdminHandler: createEvidenceAdminHandler({
      repositoryFactory: () => { repositoryFactoryCalls += 1; throw new Error('diagnostic must not create a repository'); },
      fetchImpl: fakeFetch
    }) });
    assert.equal((await request(handler, '/api/admin/evidence/phase3c1/import-preview-diagnostics')).response.status, 401);
    const injected = await request(handler, '/api/admin/evidence/phase3c1/import-preview-diagnostics?url=https://attacker.invalid/', { token: process.env.NETLIFY_TAXKB_ADMIN_TOKEN });
    assert.equal(injected.response.status, 400);
    const visible = await request(handler, '/api/admin/evidence/phase3c1/import-preview-diagnostics', { token: process.env.NETLIFY_TAXKB_ADMIN_TOKEN });
    assert.equal(visible.response.status, 200);
    assert.equal(repositoryFactoryCalls, 0, 'GET diagnostics must not open a database repository');
    assert.equal(visible.body.mode, 'read_only_diagnostic');
    assert.equal(visible.body.items.length, 10);
    assert.equal(visible.body.fetch_environment.method, 'GET (fetch default)');
    assert.equal(visible.body.fetch_environment.redirect, 'follow (fetch default)');
    assert.equal(visible.body.fetch_environment.authorization.configured, false);
    assert.equal(visible.body.fetch_environment.cookie.configured, false);
    const first = visible.body.items[0];
    assert.equal(first.http_status, 200); assert.equal(first.response_ok, true);
    assert.equal(first.selectors['.arc_cont'].count, 1); assert.equal(first.parse.result, 'PASS');
    const serialized = JSON.stringify(visible.body);
    assert.equal(serialized.includes(body(1)), false);
    assert.equal(serialized.includes('phase3c1-diagnostic-token'), false);
    assert.equal(serialized.includes('Authorization:'), false);
    assert.equal(serialized.includes('Cookie:'), false);
  } finally {
    if (previous === undefined) delete process.env.NETLIFY_TAXKB_ADMIN_TOKEN; else process.env.NETLIFY_TAXKB_ADMIN_TOKEN = previous;
  }
});

test('Phase 3C diagnostic and official preview share the same upstream request and parser behavior', async () => {
  const calls = [];
  const fetchWithCapture = async (url, options) => {
    calls.push({ url: String(url), userAgent: options.headers['user-agent'], hasAccept: Object.hasOwn(options.headers, 'accept'), hasCookie: Object.hasOwn(options.headers, 'cookie') });
    return fakeFetch(url, options);
  };
  const preview = await preparePhase3C1ImportPreview({ fetchImpl: fetchWithCapture, now: '2026-09-07T00:00:00.000Z' });
  const diagnostic = await diagnosePhase3C1ImportPreview({ fetchImpl: fetchWithCapture });
  assert.equal(preview.items.length, 10); assert.equal(diagnostic.items.length, 10);
  assert.deepEqual(calls.slice(0, 10), calls.slice(10), 'both paths must make identical upstream requests');
  assert.ok(diagnostic.items.every((item) => item.parse.result === 'PASS'));
  const missingContainer = async () => new Response('<html><head><title>verification</title></head><body>Access Denied</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  const failed = await diagnosePhase3C1ImportPreview({ fetchImpl: missingContainer });
  assert.ok(failed.items.every((item) => item.parse.error_code === 'POLICY_BODY_CONTAINER_MISSING'));
  assert.ok(failed.items.every((item) => item.waf_signals.access_denied_or_forbidden));
});

test('Phase 3C ordinal 10 stability diagnostic is fixed, capped at three requests, and discloses only safe metadata', async () => {
  const previous = process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
  process.env.NETLIFY_TAXKB_ADMIN_TOKEN = 'phase3c1-ordinal-ten-token';
  const fixedUrl = PHASE3C1_FIXED_IMPORT_URLS.at(-1);
  const upstreamHtml = '<!doctype html><html><head><meta http-equiv="refresh" content="0"><title>short</title></head><body><script>window.location="/challenge"</script><form></form></body></html>TOP_SECRET_POLICY_TEXT';
  const calls = [];
  const fetchOrdinalTen = async (url, options) => {
    calls.push({ url: String(url), headers: options.headers });
    assert.equal(String(url), fixedUrl);
    return new Response(upstreamHtml, {
      status: 200,
      headers: {
        'content-type': 'text/html', server: 'test-cdn', via: 'test-via', 'cache-control': 'no-store', 'x-cache': 'MISS', 'set-cookie': 'session=TOP_SECRET_COOKIE', 'x-secret-header': 'TOP_SECRET_HEADER'
      }
    });
  };
  let repositoryFactoryCalls = 0;
  try {
    const handler = createApiHandler({ evidenceAdminHandler: createEvidenceAdminHandler({
      repositoryFactory: () => { repositoryFactoryCalls += 1; throw new Error('stability diagnostic must not create a repository'); },
      fetchImpl: fetchOrdinalTen
    }) });
    const path = '/api/admin/evidence/phase3c1/import-preview-diagnostics/ordinal-10-stability';
    assert.equal((await request(handler, path)).response.status, 401);
    const injected = await request(handler, `${path}?ordinal=1&url=https://attacker.invalid/`, { token: process.env.NETLIFY_TAXKB_ADMIN_TOKEN });
    assert.equal(injected.response.status, 400);
    assert.equal(calls.length, 0);
    assert.equal((await request(handler, path, { method: 'POST', token: process.env.NETLIFY_TAXKB_ADMIN_TOKEN })).response.status, 404);
    assert.equal(calls.length, 0);
    const response = await request(handler, path, { token: process.env.NETLIFY_TAXKB_ADMIN_TOKEN });
    assert.equal(response.response.status, 200);
    assert.equal(repositoryFactoryCalls, 0);
    assert.equal(response.body.fixed_ordinal, 10);
    assert.equal(response.body.maximum_attempts, 3);
    assert.equal(response.body.attempts.length, 3);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.url === fixedUrl));
    assert.ok(response.body.attempts.every((item) => item.parse.error_code === 'POLICY_BODY_CONTAINER_MISSING'));
    assert.ok(response.body.attempts.every((item) => item.short_response_structure.analyzed));
    assert.ok(response.body.attempts.every((item) => item.short_response_structure.meta_refresh && item.short_response_structure.location_script && item.short_response_structure.form));
    assert.ok(response.body.attempts.every((item) => item.response_headers.server === 'test-cdn' && item.response_headers['x-cache'] === 'MISS'));
    const serialized = JSON.stringify(response.body);
    assert.equal(serialized.includes('TOP_SECRET_POLICY_TEXT'), false);
    assert.equal(serialized.includes('TOP_SECRET_COOKIE'), false);
    assert.equal(serialized.includes('TOP_SECRET_HEADER'), false);
    assert.equal(serialized.includes('phase3c1-ordinal-ten-token'), false);
    const direct = await diagnosePhase3C1OrdinalTenUpstreamStability({ fetchImpl: fetchOrdinalTen });
    assert.equal(direct.attempts.length, 3);
    assert.ok(direct.attempts.every((item) => item.official_url === fixedUrl));
  } finally {
    if (previous === undefined) delete process.env.NETLIFY_TAXKB_ADMIN_TOKEN; else process.env.NETLIFY_TAXKB_ADMIN_TOKEN = previous;
  }
});
