import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const wrapperPath = path.join(process.cwd(), 'scripts', 'run-phase3c1-production-preview.ps1');

test('Phase 3C Production Preview 本机 wrapper 固定为单次只读 GET，不接受注入参数', async () => {
  const wrapper = await readFile(wrapperPath, 'utf8');
  assert.match(wrapper, /^param\(\)/m);
  assert.match(wrapper, /\$previewUrl = 'https:\/\/xielujin-tax-knowledge-base\.netlify\.app\/api\/admin\/evidence\/phase3c1\/import-preview'/);
  assert.match(wrapper, /Invoke-WebRequest -Method Get -Uri \$previewUrl/);
  assert.doesNotMatch(wrapper, /\[switch\]|\[string\].*Url|\[string\].*Ordinal|\[string\].*Rank|\[string\].*Delay/i);
  assert.doesNotMatch(wrapper, /import-manifest|preflight|\/apply|import-phase2b-production/i);
  assert.doesNotMatch(wrapper, /-Method (Post|Put|Patch|Delete)/i);
});

test('Phase 3C Production Preview wrapper 使用隐藏 GUI Token 输入，且不使用环境变量或 Read-Host', async () => {
  const wrapper = await readFile(wrapperPath, 'utf8');
  assert.match(wrapper, /function Read-GuiSecureString/);
  assert.match(wrapper, /System\.Windows\.Forms\.TextBox/);
  assert.match(wrapper, /UseSystemPasswordChar\s*=\s*\$true/);
  assert.match(wrapper, /SecureStringToBSTR/);
  assert.match(wrapper, /ZeroFreeBSTR/);
  assert.doesNotMatch(wrapper, /Read-Host/);
  assert.doesNotMatch(wrapper, /\$env:|Env:/);
});

test('Phase 3C Production Preview wrapper 只构造安全摘要并在 BLOCKED 时停止', async () => {
  const wrapper = await readFile(wrapperPath, 'utf8');
  for (const required of ['preview_result', 'items_count', 'original_rank_index', 'skip_audit', 'fallback_item', 'ready_to_create_frozen_manifest', 'production_writes', 'Safe-Failure', 'Safe-PreviewItem']) {
    assert.match(wrapper, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(wrapper, /preview_result = 'BLOCKED'/);
  assert.match(wrapper, /exit 1/);
  assert.doesNotMatch(wrapper, /Write-(Host|Output).*\$token/i);
  assert.doesNotMatch(wrapper, /ConvertTo-Json.*\$token/i);
  assert.match(wrapper, /Never serialize exception text/);
  assert.doesNotMatch(wrapper, /\.Content\s*\|\s*Write-|Write-.*\.Content/i);
});

test('Windows PowerShell 5.1 能解析 Phase 3C Preview wrapper', async (t) => {
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
