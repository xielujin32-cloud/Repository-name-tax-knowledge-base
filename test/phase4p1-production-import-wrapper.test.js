import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const wrapperPath = path.join(process.cwd(), 'scripts', 'import-phase4p1-production-review-candidates.ps1');

test('Phase 4 P1 import wrapper is fixed to exactly ten STA official URLs and one protected dry-run endpoint', async () => {
  const wrapper = await readFile(wrapperPath, 'utf8');
  const urls = wrapper.match(/https:\/\/fgk\.chinatax\.gov\.cn\/zcfgk\/[^']+\/content\.html/g) || [];
  assert.equal(new Set(urls).size, 10);
  assert.match(wrapper, /\$dryRunUrl = "\$productionOrigin\/api\/admin\/evidence\/sources\/chinatax\/pilot-dry-run"/);
  assert.match(wrapper, /\$importUrl = "\$productionOrigin\/api\/admin\/evidence\/sources\/chinatax\/candidates"/);
  assert.match(wrapper, /\$confirmationPhrase = 'INGEST_PHASE4_STA_REVIEW_CANDIDATES'/);
  assert.match(wrapper, /Get-Json -Uri \$dryRunUrl -Headers \$headers/);
  assert.equal((wrapper.match(/Invoke-WebRequest -Method Post -Uri \$importUrl/g) || []).length, 1);
  assert.doesNotMatch(wrapper, /discoverChinaTax|\/apply|import-preview|preflight/i);
});

test('Phase 4 P1 import wrapper accepts only the safe subset of the exact official ten and exposes a bounded failed item', async () => {
  const wrapper = await readFile(wrapperPath, 'utf8');
  for (const required of ['candidate_count) -ne 10', 'business_production_writes', 'Test-ExactOfficialUrls', 'official_primary', 'dry_run_error', 'intake_ready', 'DUPLICATE_', 'pending_verification', '$ready.Count -lt 9', '$skipped.Count -gt 1', 'OFFICIAL_DETAIL_']) {
    assert.ok(wrapper.includes(required), `missing dry-run gate: ${required}`);
  }
  const gate = wrapper.indexOf('if (-not $dryRunDecision.ready)');
  const safeReturn = wrapper.indexOf('return', gate);
  const post = wrapper.indexOf('Invoke-WebRequest -Method Post -Uri $importUrl');
  assert.ok(gate >= 0 && safeReturn > gate && post > safeReturn, 'dry-run failure must return before the only POST');
  assert.match(wrapper, /error = 'dry_run_not_ready'/);
  assert.match(wrapper, /import_ready_count/);
  assert.match(wrapper, /skipped_count/);
});

test('Phase 4 P1 import wrapper requires a second GUI confirmation and POSTs only the dry-run-safe frozen subset', async () => {
  const wrapper = await readFile(wrapperPath, 'utf8');
  const confirmation = wrapper.indexOf('if (-not (Confirm-ProductionCandidateImport -ReadyCount');
  const post = wrapper.indexOf('Invoke-WebRequest -Method Post -Uri $importUrl');
  assert.ok(confirmation >= 0 && post > confirmation);
  assert.match(wrapper, /下一步将向 Production 写入 Candidate\/Evidence 审核数据，但不会公开政策/);
  assert.match(wrapper, /function Get-ExpectedImportItems/);
  assert.match(wrapper, /body_hash = \[string\]\$_\.body_hash/);
  assert.match(wrapper, /policy_title = \[string\]\$_\.policy_title/);
  assert.match(wrapper, /document_number = \[string\]\$_\.document_number/);
  assert.match(wrapper, /publication_date = \[string\]\$_\.publication_date/);
  assert.match(wrapper, /\$expectedItems = Get-ExpectedImportItems -Candidates @\(\$dryRunDecision\.import_candidates\)/);
  assert.match(wrapper, /expected_items = @\(\$expectedItems\)/);
  assert.match(wrapper, /official_urls = @\(\$expectedItems \| ForEach-Object \{ \$_.official_url \}\)/);
  assert.match(wrapper, /\$expectedItems = Get-ExpectedImportItems -Candidates @\(\$dryRunDecision\.import_candidates\)/);
  assert.doesNotMatch(wrapper, /Get-ExpectedImportItems -Candidates @\(\$dryRun\.candidates\)/);
  assert.match(wrapper, /固定批次：10 条官方 URL；本次可导入 \$ReadyCount 条，已明确跳过 \$SkippedCount 条失败项/);
  assert.doesNotMatch(wrapper, /Invoke-WebRequest -Method (Put|Patch|Delete)/i);
});

test('Phase 4 P1 import wrapper clears Token and never persists, prints, or serializes credentials', async () => {
  const wrapper = await readFile(wrapperPath, 'utf8');
  assert.match(wrapper, /\$tokenTextBox\.Name = 'tokenTextBox'/);
  assert.match(wrapper, /\$sender\.Controls\['tokenTextBox'\]\.Focus\(\)/);
  assert.match(wrapper, /UseSystemPasswordChar\s*=\s*\$true/);
  assert.match(wrapper, /ZeroFreeBSTR/);
  assert.match(wrapper, /\$secureToken\.Dispose\(\)/);
  assert.doesNotMatch(wrapper, /\$env:|Env:|Read-Host/);
  assert.doesNotMatch(wrapper, /Write-(?:Host|Output).*\$token/i);
  assert.doesNotMatch(wrapper, /ConvertTo-Json.*\$token/i);
  assert.doesNotMatch(wrapper, /raw_html|normalized_text\s*:\s*|cookie|authorization\s*:/i);
});

test('Phase 4 P1 import wrapper self-test returns before all HTTP calls and emits no Production request', async () => {
  const wrapper = await readFile(wrapperPath, 'utf8');
  const selfTest = wrapper.indexOf('function Invoke-Phase4P1GuiSelfTest');
  const main = wrapper.indexOf('function Invoke-Phase4P1ProductionImport');
  const branch = wrapper.indexOf('if ($SelfTest)');
  const returnAfterBranch = wrapper.indexOf('return', branch);
  assert.ok(selfTest >= 0 && main > selfTest && branch > main && returnAfterBranch > branch);
  assert.doesNotMatch(wrapper.slice(selfTest, main), /Invoke-WebRequest/);
  assert.match(wrapper, /event = 'phase4p1_production_candidate_import_self_test'[\s\S]*?production_request_sent = \$false[\s\S]*?business_production_writes = 0/);
});

test('Windows PowerShell 5.1 can parse Phase 4 P1 import wrapper', async (t) => {
  const scriptPath = wrapperPath.replace(/'/g, "''");
  const command = [
    '$tokens = $null', '$errors = $null',
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
