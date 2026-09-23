import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const wrapperPath = path.join(process.cwd(), 'scripts', 'read-phase3c1-frozen-manifest-integrity.ps1');

test('Phase 3C1 Frozen Manifest integrity wrapper only accepts a constrained Manifest ID and one fixed GET', async () => {
  const wrapper = await readFile(wrapperPath, 'utf8');
  assert.match(wrapper, /\[ValidatePattern\('\^controlled-import-manifest-/);
  assert.match(wrapper, /\[string\]\$ManifestId/);
  assert.match(wrapper, /\/api\/admin\/evidence\/phase3c1\/import-manifests\/\$\(\[uri\]::EscapeDataString\(\$ManifestId\)\)/);
  assert.match(wrapper, /Invoke-WebRequest -Method Get -Uri \$manifestUrl/);
  assert.doesNotMatch(wrapper, /Invoke-WebRequest -Method (Post|Put|Patch|Delete)/i);
  assert.doesNotMatch(wrapper, /Invoke-WebRequest[^\r\n]*(import-preview|preflight|\/apply|official_url)/i);
  assert.doesNotMatch(wrapper, /\[switch\]/i);
});

test('Phase 3C1 Frozen Manifest integrity wrapper hides Token and only emits safe integrity fields', async () => {
  const wrapper = await readFile(wrapperPath, 'utf8');
  assert.match(wrapper, /\$tokenTextBox\.Name = 'tokenTextBox'/);
  assert.match(wrapper, /\$sender\.Controls\['tokenTextBox'\]\.Focus\(\)/);
  assert.doesNotMatch(wrapper, /\$input\s*=\s*New-Object\s+System\.Windows\.Forms\.TextBox/);
  assert.match(wrapper, /UseSystemPasswordChar\s*=\s*\$true/);
  assert.match(wrapper, /ZeroFreeBSTR/);
  assert.doesNotMatch(wrapper, /\$env:|Env:|Read-Host/);
  assert.doesNotMatch(wrapper, /Write-\(Host|Output\).*\$token/i);
  assert.doesNotMatch(wrapper, /ConvertTo-Json.*\$token/i);
  for (const field of ['source_job_passed', 'material_set_hash_matches_rows', 'manifest_items_match_source_materials', 'complete_material_count', 'ordinal_complete', 'selection_provenance_complete', 'manifest_hash_matches_frozen_items', 'ready_for_preflight_validation', 'integrity_passed', 'ready_to_enter_preflight']) assert.match(wrapper, new RegExp(`${field}\\s*=`));
  assert.doesNotMatch(wrapper, /raw_html|normalized_text|raw_object_key|normalized_text_object_key|cookie/i);
});

test('Windows PowerShell 5.1 can parse Frozen Manifest integrity wrapper', async (t) => {
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
