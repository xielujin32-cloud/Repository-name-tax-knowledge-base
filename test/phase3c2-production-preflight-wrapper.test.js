import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const wrapperPath = path.join(process.cwd(), 'scripts', 'run-phase3c2-production-preflight.ps1');
const manifestId = 'controlled-import-manifest-429737d3-f068-4620-acc2-9031f1d938df';
const manifestHash = '0c028eed96110e993abe23e089f442e0654eaa5b95d52aec1d3ce2c7e5285cd4';

test('Phase 3C2 Production Preflight wrapper has no client target input and fixes its Manifest and hash', async () => {
  const wrapper = await readFile(wrapperPath, 'utf8');
  assert.match(wrapper, new RegExp(`\\$manifestId = '${manifestId}'`));
  assert.match(wrapper, new RegExp(`\\$manifestHash = '${manifestHash}'`));
  assert.match(wrapper, /param\(\)/);
  assert.match(wrapper, /Invoke-WebRequest -Method Get -Uri \$manifestUrl/);
  assert.match(wrapper, /Invoke-WebRequest -Method Post -Uri \$preflightUrl/);
  assert.equal((wrapper.match(/Invoke-WebRequest -Method Post/g) || []).length, 1, 'normal path permits exactly one Preflight POST');
  assert.doesNotMatch(wrapper, /Invoke-WebRequest -Method (Put|Patch|Delete)/i);
  assert.doesNotMatch(wrapper, /Invoke-WebRequest[^\r\n]*(import-preview|\/apply|import-manifests'\s*-Method\s+Post)/i);
});

test('Phase 3C2 Production Preflight wrapper fail-closes before POST when manifest integrity is not ready', async () => {
  const wrapper = await readFile(wrapperPath, 'utf8');
  const readinessChecks = ['manifest_state -eq \'frozen\'', 'manifest_hash -eq $manifestHash', 'source_job_passed -eq $true', 'material_set_hash_matches_rows -eq $true', 'manifest_items_match_source_materials -eq $true', 'complete_material_count) -eq 10', 'ordinal_complete -eq $true', 'selection_provenance_complete -eq $true', 'protected_object_integrity_metadata_present -eq $true', 'manifest_hash_matches_frozen_items -eq $true', 'ready_for_preflight_validation -eq $true', 'business_production_writes) -eq 0'];
  for (const check of readinessChecks) assert.match(wrapper, new RegExp(check.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const gateIndex = wrapper.indexOf('if (-not (Test-ManifestPreflightReady');
  const postIndex = wrapper.indexOf('Invoke-WebRequest -Method Post -Uri $preflightUrl');
  assert.ok(gateIndex >= 0 && postIndex > gateIndex, 'failed integrity gate must stop before the sole POST');
  assert.match(wrapper, /error = 'frozen_manifest_not_ready_for_preflight'/);
});

test('Phase 3C2 Production Preflight wrapper fixes check/hash and does not leak Token or invoke Apply', async () => {
  const wrapper = await readFile(wrapperPath, 'utf8');
  assert.match(wrapper, /\$requestBody = @\{ check = \$true; manifest_hash = \$manifestHash \} \| ConvertTo-Json -Compress/);
  assert.match(wrapper, /\$tokenTextBox\.Name = 'tokenTextBox'/);
  assert.match(wrapper, /\$sender\.Controls\['tokenTextBox'\]\.Focus\(\)/);
  assert.doesNotMatch(wrapper, /\$input\s*=\s*New-Object\s+System\.Windows\.Forms\.TextBox/);
  assert.match(wrapper, /UseSystemPasswordChar\s*=\s*\$true/);
  assert.match(wrapper, /ZeroFreeBSTR/);
  assert.doesNotMatch(wrapper, /\$env:|Env:|Read-Host/);
  assert.doesNotMatch(wrapper, /Write-\(Host|Output\).*\$token/i);
  assert.doesNotMatch(wrapper, /ConvertTo-Json.*\$token/i);
  assert.doesNotMatch(wrapper, /raw_html|normalized_text|raw_object_key|normalized_text_object_key|cookie/i);
  for (const field of ['preflight_id', 'preflight_state', 'evidence_duplicate_free', 'expires_at', 'ready_for_apply', 'preflight_audit_writes', 'business_production_writes']) assert.match(wrapper, new RegExp(`${field}\\s*=`));
});

test('Windows PowerShell 5.1 can parse Phase 3C2 Production Preflight wrapper', async (t) => {
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
