import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { PHASE_2B_PRODUCTION_IMPORT_URL, executePhase2BProductionImport, parseArguments } from '../scripts/import-phase2b-production.mjs';

const execFile = promisify(execFileCallback);

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

test('Windows PowerShell 包装器使用安全输入，并只在当前子进程环境中传递 Token', async () => {
  const wrapper = await readFile(path.join(process.cwd(), 'scripts', 'import-phase2b-production.ps1'), 'utf8');
  assert.match(wrapper, /Read-Host[\s\S]*-AsSecureString/);
  assert.match(wrapper, /import-phase2b-production\.mjs'\) --from-env/);
  assert.match(wrapper, /Remove-Item Env:NETLIFY_TAXKB_ADMIN_TOKEN/);
  assert.match(wrapper, /ZeroFreeBSTR/);
  assert.doesNotMatch(wrapper, /Read-Host[\s\S]*-AsPlainText/);
});

test('Windows PowerShell 5.1 能实际解析生产导入包装器', async (t) => {
  const scriptPath = path.join(process.cwd(), 'scripts', 'import-phase2b-production.ps1').replace(/'/g, "''");
  const command = [
    '$tokens = $null',
    '$errors = $null',
    `[System.Management.Automation.Language.Parser]::ParseFile('${scriptPath}', [ref]$tokens, [ref]$errors) | Out-Null`,
    'if ($errors.Count -gt 0) { $errors | ForEach-Object { $_.Message }; exit 1 }',
    'if ($PSVersionTable.PSVersion.Major -ne 5) { exit 2 }'
  ].join('; ');
  try {
    await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]);
  } catch (error) {
    // Some restricted test sandboxes prohibit Node from spawning any child
    // process. Normal Windows hosts still execute the real parser above.
    if (error?.code === 'EPERM') t.skip('当前测试沙箱禁止 Node 启动 powershell.exe。');
    else throw error;
  }
});
