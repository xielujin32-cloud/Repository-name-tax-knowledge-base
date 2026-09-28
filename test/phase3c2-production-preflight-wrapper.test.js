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

test('Phase 3C2 Production Preflight wrapper fixes its verified Manifest and permits only one Preflight POST', async () => {
  const wrapper = await readFile(wrapperPath, 'utf8');

  assert.match(wrapper, new RegExp(`\\$manifestId = '${manifestId}'`));
  assert.match(wrapper, new RegExp(`\\$manifestHash = '${manifestHash}'`));
  assert.match(wrapper, /param\(\s*\[switch\]\$SelfTest\s*\)/);
  assert.doesNotMatch(wrapper, /\$(?:DiagnosticDefaultEntry|TraceDefaultEntryNoHttp|MockManifestGetFailureNoHttp)/);
  assert.doesNotMatch(wrapper, /TAXKB_PHASE3C2_/);
  assert.match(wrapper, /Invoke-WebRequest -Method Get -Uri \$manifestUrl/);
  assert.match(wrapper, /Invoke-WebRequest -Method Post -Uri \$preflightUrl/);
  assert.equal((wrapper.match(/Invoke-WebRequest -Method Get/g) || []).length, 1, 'only one Manifest GET is permitted');
  assert.equal((wrapper.match(/Invoke-WebRequest -Method Post/g) || []).length, 1, 'only one Preflight POST is permitted');
  assert.doesNotMatch(wrapper, /Invoke-WebRequest -Method (Put|Patch|Delete)/i);
  assert.doesNotMatch(wrapper, /Invoke-WebRequest[^\r\n]*(?:import-preview|\/apply|import-manifests'\s*-Method\s+Post)/i);
});

test('Phase 3C2 Production Preflight wrapper has a stable explicit entry with no output before the Token GUI', async () => {
  const wrapper = await readFile(wrapperPath, 'utf8');
  const entry = wrapper.indexOf('function Invoke-Phase3C2ProductionPreflight');
  const guiCall = wrapper.indexOf('$secureToken = Read-GuiSecureString -Prompt', entry);
  const bstrConversion = wrapper.indexOf('SecureStringToBSTR($secureToken)', entry);
  const manifestGet = wrapper.indexOf('Invoke-WebRequest -Method Get -Uri $manifestUrl', entry);
  const preflightPost = wrapper.indexOf('Invoke-WebRequest -Method Post -Uri $preflightUrl', entry);
  const jsonBeforeGui = wrapper.slice(entry, guiCall).indexOf('Write-SafeJson');
  const hostBeforeGui = wrapper.slice(entry, guiCall).indexOf('Write-Host');

  assert.ok(entry >= 0 && guiCall > entry, 'the default path must use an explicit production-preflight entry function');
  assert.equal(jsonBeforeGui, -1, 'the default path must not emit JSON before showing the Token GUI');
  assert.equal(hostBeforeGui, -1, 'the default path must not emit Host diagnostics before showing the Token GUI');
  assert.ok(bstrConversion > guiCall && manifestGet > bstrConversion && preflightPost > manifestGet,
    'Token conversion, Manifest GET, and the one POST must remain after the GUI assignment');
  assert.match(wrapper, /if \(\$SelfTest\) \{\s*Invoke-Phase3C2GuiSelfTest\s*return\s*\}\s*Invoke-Phase3C2ProductionPreflight/s);
});

test('Phase 3C2 Production Preflight wrapper self-test returns before every Production request', async () => {
  const wrapper = await readFile(wrapperPath, 'utf8');
  const selfTest = wrapper.indexOf('function Invoke-Phase3C2GuiSelfTest');
  const productionEntry = wrapper.indexOf('function Invoke-Phase3C2ProductionPreflight');
  const selfTestReturn = wrapper.indexOf('return', wrapper.indexOf('if ($SelfTest)'));
  const entry = wrapper.indexOf('Invoke-Phase3C2ProductionPreflight', selfTestReturn);
  const selfTestBody = wrapper.slice(selfTest, productionEntry);

  assert.ok(selfTest >= 0 && productionEntry > selfTest && selfTestReturn > selfTest, 'self-test must be an explicit local-only branch');
  assert.ok(entry > selfTestReturn, 'the production entry must run only after the self-test early return');
  assert.doesNotMatch(selfTestBody, /Invoke-WebRequest/, 'the self-test implementation must contain no HTTP request');
  assert.match(wrapper, /event = 'phase3c2_preflight_wrapper_self_test'[\s\S]*?production_request_sent = \$false[\s\S]*?business_production_writes = 0/);
});

test('Phase 3C2 Production Preflight wrapper fail-closes before POST when Frozen Manifest integrity is not ready', async () => {
  const wrapper = await readFile(wrapperPath, 'utf8');
  const readinessChecks = [
    "manifest_state -eq 'frozen'",
    'manifest_hash -eq $manifestHash',
    'source_job_passed -eq $true',
    'material_set_hash_matches_rows -eq $true',
    'manifest_items_match_source_materials -eq $true',
    'material_count) -eq 10',
    'complete_material_count) -eq 10',
    'ordinal_complete -eq $true',
    'selection_provenance_complete -eq $true',
    'protected_object_integrity_metadata_present -eq $true',
    'manifest_hash_matches_frozen_items -eq $true',
    'ready_for_preflight_validation -eq $true',
    'business_production_writes) -eq 0'
  ];
  for (const check of readinessChecks) {
    assert.ok(wrapper.includes(check), `required frozen-integrity check missing: ${check}`);
  }

  const gate = wrapper.indexOf('if (-not (Test-ManifestPreflightReady');
  const safeReturn = wrapper.indexOf('return', gate);
  const post = wrapper.indexOf('Invoke-WebRequest -Method Post -Uri $preflightUrl');
  assert.ok(gate >= 0 && safeReturn > gate && post > safeReturn, 'failed integrity must return before the sole POST');
  assert.match(wrapper, /error = 'frozen_manifest_not_ready_for_preflight'/);
});

test('Phase 3C2 Production Preflight wrapper keeps Token handling local and never invokes Apply', async () => {
  const wrapper = await readFile(wrapperPath, 'utf8');

  assert.match(wrapper, /\$requestBody = @\{ check = \$true; manifest_hash = \$manifestHash \} \| ConvertTo-Json -Compress/);
  assert.match(wrapper, /\$tokenTextBox\.Name = 'tokenTextBox'/);
  assert.match(wrapper, /\$sender\.Controls\['tokenTextBox'\]\.Focus\(\)/);
  assert.match(wrapper, /UseSystemPasswordChar\s*=\s*\$true/);
  assert.match(wrapper, /ZeroFreeBSTR/);
  assert.match(wrapper, /\$secureToken\.Dispose\(\)/);
  assert.match(wrapper, /\$headers = @\{ Authorization = "Bearer \$token";/);
  assert.doesNotMatch(wrapper, /\$input\s*=\s*New-Object\s+System\.Windows\.Forms\.TextBox/);
  assert.doesNotMatch(wrapper, /\$env:|Env:|Read-Host/);
  assert.doesNotMatch(wrapper, /Write-(?:Host|Output).*\$token/i);
  assert.doesNotMatch(wrapper, /ConvertTo-Json.*\$token/i);
  assert.doesNotMatch(wrapper, /raw_html|normalized_text|raw_object_key|normalized_text_object_key|cookie/i);
  assert.doesNotMatch(wrapper, /(?:\/apply|Apply-Phase|Invoke-.*Apply)/i);
});

test('Phase 3C2 Production Preflight wrapper classifies only known Token-input errors at the Token-input stage', async () => {
  const wrapper = await readFile(wrapperPath, 'utf8');

  assert.match(wrapper, /\$tokenInputErrorCodes = @\('token_input_cancelled', 'token_empty_after_secure_input', 'token_contains_control_character'\)/);
  assert.match(wrapper, /\$stage -eq 'token_input'[\s\S]*?\$tokenInputErrorCodes -contains \$_.Exception\.Message/);
  assert.match(wrapper, /error = 'preflight_request_failed'[\s\S]*?stage = \$stage[\s\S]*?exception_type = \$_.Exception\.GetType\(\)\.Name/);
});

test('Windows PowerShell 5.1 can parse the stable Phase 3C2 Production Preflight wrapper', async (t) => {
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
