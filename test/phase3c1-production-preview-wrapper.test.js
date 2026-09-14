import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const wrapperPath = path.join(process.cwd(), 'scripts', 'run-phase3c1-production-preview.ps1');

test('Phase 3C Production wrapper 固定创建异步 Job，不请求旧同步 Preview', async () => {
  const wrapper = await readFile(wrapperPath, 'utf8');
  assert.match(wrapper, /^param\(\)/m);
  assert.match(wrapper, /\$createJobUrl = 'https:\/\/xielujin-tax-knowledge-base\.netlify\.app\/api\/admin\/evidence\/phase3c1\/import-preview-jobs'/);
  assert.match(wrapper, /Invoke-WebRequest -Method Post -Uri \$createJobUrl/);
  assert.match(wrapper, /-ContentType 'application\/json' -Body '\{\}'/);
  assert.doesNotMatch(wrapper, /import-preview'(?!-jobs)/);
  assert.doesNotMatch(wrapper, /\[switch\]|\[string\].*Url|\[string\].*Ordinal|\[string\].*Rank|\[string\].*Delay/i);
  assert.doesNotMatch(wrapper, /import-manifest|preflight|\/apply|import-phase2b-production/i);
});

test('Phase 3C Production wrapper 固定低频轮询返回的 Job status endpoint', async () => {
  const wrapper = await readFile(wrapperPath, 'utf8');
  assert.match(wrapper, /\$pollIntervalMs = 5000/);
  assert.match(wrapper, /\$pollTimeoutMs = 900000/);
  assert.match(wrapper, /function Get-JobStatus/);
  assert.match(wrapper, /Invoke-WebRequest -Method Get -Uri \$statusUrl/);
  assert.match(wrapper, /Start-Sleep -Milliseconds \$pollIntervalMs/);
  assert.match(wrapper, /\$job\.status -in @\('passed', 'blocked', 'failed'\)/);
  assert.match(wrapper, /POLLING_TIMEOUT/);
});

test('Phase 3C Production wrapper 安全处理 create、dispatch 与终态摘要', async () => {
  const wrapper = await readFile(wrapperPath, 'utf8');
  for (const required of ['http_status', 'mode', 'job_id', 'job_status', 'dispatch_status', 'DISPATCH_NOT_SCHEDULED', 'completed_count', 'total_count', 'current_ordinal', 'preview_result', 'failure_code', 'ready_to_create_frozen_manifest', 'preview_job_audit_writes', 'business_production_writes', 'ADMIN_UNAUTHORIZED']) {
    assert.match(wrapper, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(wrapper, /if \(\$job\.status -ne 'passed'\) \{ exit 1 \}/);
  assert.doesNotMatch(wrapper, /Write-\(Host|Output\).*\$token/i);
  assert.doesNotMatch(wrapper, /ConvertTo-Json.*\$token/i);
  assert.match(wrapper, /Never serialize exception text/);
  assert.doesNotMatch(wrapper, /\.Content\s*\|\s*Write-|Write-.*\.Content/i);
});

test('Phase 3C Production wrapper 使用隐藏 GUI Token 输入，且不使用环境变量或 Read-Host', async () => {
  const wrapper = await readFile(wrapperPath, 'utf8');
  assert.match(wrapper, /function Read-GuiSecureString/);
  assert.match(wrapper, /System\.Windows\.Forms\.TextBox/);
  assert.match(wrapper, /UseSystemPasswordChar\s*=\s*\$true/);
  assert.match(wrapper, /SecureStringToBSTR/);
  assert.match(wrapper, /ZeroFreeBSTR/);
  assert.doesNotMatch(wrapper, /Read-Host/);
  assert.doesNotMatch(wrapper, /\$env:|Env:/);
});

test('Windows PowerShell 5.1 能解析 Phase 3C Preview Job wrapper', async (t) => {
  const scriptPath = wrapperPath.replace(/'/g, "''");
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
    if (error?.code === 'EPERM') t.skip('当前测试沙箱禁止 Node 启动 powershell.exe。');
    else throw error;
  }
});
