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
  assert.match(wrapper, /param\(\s*\[switch\]\$SelfTest,\s*\[switch\]\$DiagnosticDefaultEntry,\s*\[switch\]\$TraceDefaultEntryNoHttp,\s*\[switch\]\$MockManifestGetFailureNoHttp\s*\)/);
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
  assert.match(wrapper, /function Safe-RequestId/);
  assert.match(wrapper, /x-nf-request-id/);
  assert.doesNotMatch(wrapper, /Response\.GetResponseStream|ReadToEnd/);
  for (const field of ['preflight_id', 'preflight_state', 'evidence_duplicate_free', 'expires_at', 'ready_for_apply', 'preflight_audit_writes', 'business_production_writes']) assert.match(wrapper, new RegExp(`${field}\\s*=`));
});

test('Phase 3C2 Production Preflight wrapper has a local-only self-test that reaches its real Token GUI before all HTTP paths', async () => {
  const wrapper = await readFile(wrapperPath, 'utf8');
  const selfTestBranch = wrapper.indexOf('if ($SelfTest)');
  const productionGet = wrapper.indexOf('Invoke-WebRequest -Method Get -Uri $manifestUrl');
  const productionPost = wrapper.indexOf('Invoke-WebRequest -Method Post -Uri $preflightUrl');

  assert.match(wrapper, /function Invoke-Phase3C2GuiSelfTest/);
  assert.match(wrapper, /Invoke-Phase3C2GuiSelfTest\r?\n\s*return/);
  assert.match(wrapper, /event = 'phase3c2_preflight_wrapper_self_test'/);
  assert.match(wrapper, /production_request_sent = \$false/);
  assert.match(wrapper, /business_production_writes = 0/);
  const selfTestReturn = wrapper.indexOf('  return', selfTestBranch);
  const defaultTry = wrapper.indexOf('\ntry {', selfTestBranch);
  assert.ok(selfTestReturn > selfTestBranch && defaultTry > selfTestReturn, 'self-test must return before the default production entrypoint');
  assert.ok(productionGet > selfTestBranch && productionPost > selfTestBranch, 'self-test must stop before every HTTP request');
});

test('Phase 3C2 Production Preflight wrapper default entry reaches the Token GUI call before HTTP in a zero-network probe', async (t) => {
  const wrapper = await readFile(wrapperPath, 'utf8');
  const tokenGuiCall = '  $secureToken = Read-GuiSecureString -Prompt $tokenPrompt';
  const marker = 'PHASE3C2_DEFAULT_ENTRY_REACHED_TOKEN_GUI';
  assert.equal((wrapper.match(/\$secureToken = Read-GuiSecureString -Prompt \$tokenPrompt/g) || []).length, 1, 'default entry must contain exactly one Token GUI call');
  const probe = wrapper.replace(tokenGuiCall, `  Write-Output '${marker}'\n  return`);
  assert.notEqual(probe, wrapper, 'probe must intercept the unique Token GUI call');
  const encoded = Buffer.from(probe, 'utf16le').toString('base64');
  try {
    const { stdout } = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]);
    assert.match(stdout, new RegExp(marker));
  } catch (error) {
    if (error?.code === 'EPERM') t.skip('当前测试沙箱禁止 Node 启动 powershell.exe。');
    else throw error;
  }
});

test('Phase 3C2 Production Preflight wrapper diagnostic-default-entry follows the default GUI path and returns before every HTTP request', async () => {
  const wrapper = await readFile(wrapperPath, 'utf8');
  const diagnosticStart = wrapper.indexOf('if ($DiagnosticDefaultEntry)');
  const guiCall = wrapper.indexOf('$secureToken = Read-GuiSecureString -Prompt $tokenPrompt');
  const diagnosticStop = wrapper.indexOf("stage = 'after_token_gui_before_http'");
  const bstrConversion = wrapper.indexOf('SecureStringToBSTR($secureToken)');
  const productionGet = wrapper.indexOf('Invoke-WebRequest -Method Get -Uri $manifestUrl');
  const productionPost = wrapper.indexOf('Invoke-WebRequest -Method Post -Uri $preflightUrl');

  assert.match(wrapper, /stage = 'before_token_gui'/);
  assert.match(wrapper, /Diagnostic only: enter non-sensitive test text\. No Production request will be sent\./);
  assert.match(wrapper, /stage = 'after_token_gui_before_http'/);
  assert.match(wrapper, /secure_string_returned = \(\$secureToken -is \[System\.Security\.SecureString\]\)/);
  assert.match(wrapper, /stage = 'after_token_gui_before_http'[\s\S]*?business_production_writes = 0[\s\S]*?\}\)\r?\n\s*return\r?\n\s*\}/);
  assert.ok(diagnosticStart >= 0 && guiCall > diagnosticStart, 'diagnostic must follow the default path into the real Token GUI');
  assert.ok(diagnosticStop > guiCall && bstrConversion > diagnosticStop, 'diagnostic must stop after GUI return and before Token conversion');
  assert.ok(productionGet > diagnosticStop && productionPost > diagnosticStop, 'diagnostic must stop before every HTTP request');
});

test('Phase 3C2 Production Preflight wrapper trace-default-entry uses the real default Token flow and stops before Manifest GET', async () => {
  const wrapper = await readFile(wrapperPath, 'utf8');
  const traceStart = wrapper.indexOf("event = 'phase3c2_preflight_wrapper_default_entry_trace'");
  const normalPrompt = wrapper.indexOf("'Enter administrator Token (runs one Preflight only after Frozen Manifest integrity verification):'");
  const guiCall = wrapper.indexOf('$secureToken = Read-GuiSecureString -Prompt $tokenPrompt');
  const bstrConversion = wrapper.indexOf('SecureStringToBSTR($secureToken)');
  const validationTrace = wrapper.indexOf("stage = 'after_token_validation'");
  const beforeGetTrace = wrapper.indexOf("stage = 'before_manifest_get'");
  const manifestGet = wrapper.indexOf('Invoke-WebRequest -Method Get -Uri $manifestUrl');
  const preflightPost = wrapper.indexOf('Invoke-WebRequest -Method Post -Uri $preflightUrl');

  for (const stage of ['before_token_gui', 'after_token_gui', 'before_securestring_to_bstr', 'after_securestring_to_bstr', 'after_token_validation', 'before_manifest_get']) {
    assert.match(wrapper, new RegExp(`stage = '${stage}'`));
  }
  assert.match(wrapper, /diagnostic_default_entry = \$false/);
  assert.match(wrapper, /before_manifest_get[\s\S]*?production_request_sent = \$false[\s\S]*?\}\)\r?\n\s*return\r?\n\s*\}/);
  assert.ok(traceStart >= 0 && normalPrompt > traceStart && guiCall > normalPrompt, 'trace must preserve the normal prompt and real Token GUI call');
  assert.ok(bstrConversion > guiCall && validationTrace > bstrConversion, 'trace must cover the formal SecureString and Token validation path');
  assert.ok(beforeGetTrace > validationTrace && manifestGet > beforeGetTrace && preflightPost > manifestGet, 'trace must stop before every HTTP request');
});

test('Phase 3C2 Production Preflight wrapper can locally mock only the first Manifest GET failure after formal Token preparation', async () => {
  const wrapper = await readFile(wrapperPath, 'utf8');
  const headerBuild = wrapper.indexOf('$headers = @{ Authorization = "Bearer $token";');
  const mockBranch = wrapper.indexOf('if ($MockManifestGetFailureNoHttp)');
  const manifestGet = wrapper.indexOf('Invoke-WebRequest -Method Get -Uri $manifestUrl');
  const preflightPost = wrapper.indexOf('Invoke-WebRequest -Method Post -Uri $preflightUrl');

  assert.match(wrapper, /stage = 'before_manifest_get_mock_failure'/);
  assert.match(wrapper, /production_request_sent = \$false/);
  assert.match(wrapper, /throw \[System\.InvalidOperationException\]::new\('local_manifest_get_mock_failure'\)/);
  assert.ok(headerBuild >= 0 && mockBranch > headerBuild, 'mock must run after formal header preparation');
  assert.ok(manifestGet > mockBranch && preflightPost > manifestGet, 'mock must stop before the first HTTP request and Preflight POST');
});

test('Phase 3C2 Production Preflight wrapper only classifies known Token-input failures during token_input as local token errors', async () => {
  const wrapper = await readFile(wrapperPath, 'utf8');

  assert.match(wrapper, /\$tokenInputErrorCodes = @\('token_input_cancelled', 'token_empty_after_secure_input', 'token_contains_control_character'\)/);
  assert.match(wrapper, /\$stage -eq 'token_input'[\s\S]*?\$tokenInputErrorCodes -contains \$_.Exception\.Message/);
  assert.match(wrapper, /else \{\r?\n\s*# Never serialize exception text[\s\S]*?error = 'preflight_request_failed'; stage = \$stage; exception_type = \$_.Exception\.GetType\(\)\.Name/);
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
