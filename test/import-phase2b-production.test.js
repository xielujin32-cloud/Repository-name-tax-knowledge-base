import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PHASE_2B_PRODUCTION_IMPORT_URL, executePhase2BProductionImport, parseArguments } from '../scripts/import-phase2b-production.mjs';

test('本机 Phase 2B 工具固定生产入口和请求正文，不接受自定义参数', async () => {
  assert.deepEqual(parseArguments([]), { tokenSource: 'prompt' });
  assert.deepEqual(parseArguments(['--from-env']), { tokenSource: 'environment' });
  assert.throws(() => parseArguments(['--url', 'https://example.invalid']), /不接受 URL/);

  const temporaryToken = `temporary-test-${randomUUID()}`;
  let request;
  const result = await executePhase2BProductionImport({
    token: temporaryToken,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return Response.json({ execution: 'completed', allowlist_size: 2, source_id: 'source-chinatax-policy-regulations', collection_run_id: 'collection-run-test', snapshots_created: 2, candidates_created: 2, candidates_skipped: 0 });
    }
  });
  assert.equal(request.url, PHASE_2B_PRODUCTION_IMPORT_URL);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.authorization, `Bearer ${temporaryToken}`);
  assert.deepEqual(JSON.parse(request.options.body), { apply: true, confirmation: 'INGEST_PHASE2B_STA_TWO_URLS' });
  assert.deepEqual(result, { execution: 'completed', allowlist_size: 2, source_id: 'source-chinatax-policy-regulations', collection_run_id: 'collection-run-test', snapshots_created: 2, candidates_created: 2, candidates_skipped: 0 });
});

test('本机 Phase 2B 工具只显示安全摘要，拒绝输出上游错误正文', async () => {
  const temporaryToken = `temporary-test-${randomUUID()}`;
  await assert.rejects(
    () => executePhase2BProductionImport({ token: temporaryToken, fetchImpl: async () => new Response(`upstream-${temporaryToken}`, { status: 500 }) }),
    (error) => error.message === '导入未完成（HTTP 500）。' && !error.message.includes(temporaryToken)
  );
  await assert.rejects(
    () => executePhase2BProductionImport({ token: temporaryToken, fetchImpl: async () => { throw new Error(`network-${temporaryToken}`); } }),
    (error) => error.message === '导入网络请求未完成。' && !error.message.includes(temporaryToken)
  );
});
