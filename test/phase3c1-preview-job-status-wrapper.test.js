import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const wrapperPath = path.join(process.cwd(), 'scripts', 'read-phase3c1-preview-job-status.ps1');

test('Phase 3C1 existing Job status wrapper 只接受受限 Job ID 且不接受其他目标参数', async () => {
  const wrapper = await readFile(wrapperPath, 'utf8');
  assert.match(wrapper, /\[ValidatePattern\('\^phase3c1-preview-job-/);
  assert.match(wrapper, /\[string\]\$JobId/);
  assert.match(wrapper, /Invoke-WebRequest -Method Get -Uri \$statusUrl/);
  assert.doesNotMatch(wrapper, /Invoke-WebRequest -Method (Post|Put|Patch|Delete)/i);
  assert.doesNotMatch(wrapper, /Invoke-WebRequest[^\r\n]*(import-manifest|preflight|\/apply)/i);
  assert.doesNotMatch(wrapper, /\[switch\]|\[string\].*(Url|Ordinal|Rank|Candidate|Manifest|Preflight|Apply)/i);
});

test('Phase 3C1 existing Job status wrapper 安全处理 Token 与 GUI scope', async () => {
  const wrapper = await readFile(wrapperPath, 'utf8');
  assert.match(wrapper, /\$tokenTextBox\.Name = 'tokenTextBox'/);
  assert.match(wrapper, /\$sender\.Controls\['tokenTextBox'\]\.Focus\(\)/);
  assert.doesNotMatch(wrapper, /\$input\s*=\s*New-Object\s+System\.Windows\.Forms\.TextBox/);
  assert.match(wrapper, /UseSystemPasswordChar\s*=\s*\$true/);
  assert.match(wrapper, /SecurityProtocol\s*=\s*\[Net\.SecurityProtocolType\]::Tls12/);
  assert.match(wrapper, /ZeroFreeBSTR/);
  assert.doesNotMatch(wrapper, /\$env:|Env:|Read-Host/);
  assert.doesNotMatch(wrapper, /Write-\(Host|Output\).*\$token/i);
  assert.doesNotMatch(wrapper, /ConvertTo-Json.*\$token/i);
  for (const field of ['job_state', 'preview_result', 'material_count', 'complete_material_count', 'material_set_hash', 'selection_provenance_complete', 'protected_object_integrity_metadata_present']) assert.match(wrapper, new RegExp(`${field}\\s*=`));
});

test('Windows PowerShell 5.1 能解析 existing Job status wrapper', async (t) => {
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
