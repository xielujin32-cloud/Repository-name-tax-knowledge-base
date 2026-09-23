import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const wrapperPath = path.join(process.cwd(), 'scripts', 'create-phase3c1-frozen-manifest.ps1');

test('Phase 3C1 Frozen Manifest wrapper 只接受受限 Job ID，并固定 status 与 manifest endpoints', async () => {
  const wrapper = await readFile(wrapperPath, 'utf8');
  assert.match(wrapper, /\[ValidatePattern\('\^phase3c1-preview-job-/);
  assert.match(wrapper, /\[string\]\$JobId/);
  assert.match(wrapper, /\$statusUrl = "https:\/\/xielujin-tax-knowledge-base\.netlify\.app\/api\/admin\/evidence\/phase3c1\/import-preview-jobs\//);
  assert.match(wrapper, /\$createManifestUrl = 'https:\/\/xielujin-tax-knowledge-base\.netlify\.app\/api\/admin\/evidence\/phase3c1\/import-manifests'/);
  assert.match(wrapper, /Invoke-WebRequest -Method Get -Uri \$statusUrl/);
  assert.match(wrapper, /Invoke-WebRequest -Method Post -Uri \$createManifestUrl/);
  assert.doesNotMatch(wrapper, /Invoke-WebRequest -Method (Put|Patch|Delete)/i);
  assert.doesNotMatch(wrapper, /Invoke-WebRequest -Method Post -Uri \$statusUrl/i);
  assert.doesNotMatch(wrapper, /Invoke-WebRequest[^\r\n]*(preflight|\/apply|import-preview-jobs)/i);
});

test('Phase 3C1 Frozen Manifest wrapper 先 fail-closed 核验所有 Job materials 条件，再发送一次固定 POST', async () => {
  const wrapper = await readFile(wrapperPath, 'utf8');
  for (const field of ['job_state', 'completed_count', 'total_count', 'selected_items_count', 'material_count', 'complete_material_count', 'material_set_hash_matches_rows', 'material_ordinals_complete', 'selection_provenance_complete', 'protected_object_integrity_metadata_present', 'ready_to_create_frozen_manifest', 'business_production_writes']) assert.match(wrapper, new RegExp(field));
  assert.match(wrapper, /if \(-not \(Test-PreviewJobReady \$job\)\)/);
  assert.match(wrapper, /error = 'preview_job_not_ready'/);
  assert.match(wrapper, /return\s*\r?\n\s*}\s*\r?\n\s*\r?\n\s*\$stage = 'create_frozen_manifest'/);
  assert.match(wrapper, /freeze = \$true/);
  assert.match(wrapper, /confirmation = 'FREEZE_PHASE3C1_FIRST_TEN'/);
  assert.match(wrapper, /source_preview_job_id = \$JobId/);
  assert.equal((wrapper.match(/Invoke-WebRequest -Method Post -Uri \$createManifestUrl/g) || []).length, 1, 'wrapper must issue at most one manifest POST');
  assert.match(wrapper, /created = \[bool\]\$manifestBody\.created/);
  assert.match(wrapper, /manifest_id = \$manifest\.controlled_manifest_id/);
  assert.match(wrapper, /source_preview_job_id = \$manifest\.source_preview_job_id/);
});

test('Phase 3C1 Frozen Manifest wrapper hides and clears Token without persisting or printing it', async () => {
  const wrapper = await readFile(wrapperPath, 'utf8');
  assert.match(wrapper, /\$tokenTextBox\.Name = 'tokenTextBox'/);
  assert.match(wrapper, /\$sender\.Controls\['tokenTextBox'\]\.Focus\(\)/);
  assert.match(wrapper, /UseSystemPasswordChar\s*=\s*\$true/);
  assert.match(wrapper, /token_input_cancelled/);
  assert.match(wrapper, /token_empty_after_secure_input/);
  assert.match(wrapper, /ZeroFreeBSTR/);
  assert.doesNotMatch(wrapper, /\$env:|Env:|Read-Host/);
  assert.doesNotMatch(wrapper, /Write-\(Host|Output\).*\$token/i);
  assert.doesNotMatch(wrapper, /ConvertTo-Json.*\$token/i);
});

test('Windows PowerShell 5.1 can parse Frozen Manifest wrapper', async (t) => {
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
