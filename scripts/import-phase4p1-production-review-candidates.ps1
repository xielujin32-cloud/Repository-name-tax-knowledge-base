[CmdletBinding()]
param(
  [switch]$SelfTest
)

# Local-only operator wrapper. It is deliberately fixed to the reviewed Phase 4
# P1 batch and is not a product API. It reads the protected dry-run first and
# cannot POST unless a local operator confirms the exact safe summary.
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding
$productionOrigin = 'https://xielujin-tax-knowledge-base.netlify.app'
$dryRunUrl = "$productionOrigin/api/admin/evidence/sources/chinatax/pilot-dry-run"
$importUrl = "$productionOrigin/api/admin/evidence/sources/chinatax/candidates"
$statusUrl = "$productionOrigin/api/admin/evidence/status"
$candidateListUrl = "$productionOrigin/api/admin/evidence/candidates"
$publicPoliciesUrl = "$productionOrigin/api/policies?limit=1&offset=0"
$confirmationPhrase = 'INGEST_PHASE4_STA_REVIEW_CANDIDATES'
$expectedSourceId = 'source-sta-policy-regulations'
$expectedSourceDomain = 'fgk.chinatax.gov.cn'
$expectedOfficialUrls = @(
  'https://fgk.chinatax.gov.cn/zcfgk/c100012/c5246538/content.html',
  'https://fgk.chinatax.gov.cn/zcfgk/c100012/c5247426/content.html',
  'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5252024/content.html',
  'https://fgk.chinatax.gov.cn/zcfgk/c100012/c5196798/content.html',
  'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5210453/content.html',
  'https://fgk.chinatax.gov.cn/zcfgk/c100012/c5238152/content.html',
  'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5247663/content.html',
  'https://fgk.chinatax.gov.cn/zcfgk/c100012/c5196771/content.html',
  'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5202404/content.html',
  'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5247077/content.html'
)

function Read-GuiSecureString {
  param([Parameter(Mandatory = $true)][string]$Prompt)

  $form = $null
  $tokenTextBox = $null
  $plainValue = $null
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'Phase 4 P1 Production Candidate Import'
    $form.StartPosition = 'CenterScreen'
    $form.Size = New-Object System.Drawing.Size(620, 190)
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false

    $label = New-Object System.Windows.Forms.Label
    $label.Text = $Prompt
    $label.AutoSize = $true
    $label.Location = New-Object System.Drawing.Point(18, 20)
    $form.Controls.Add($label)

    # $input is a PowerShell automatic variable. Never use it for a control.
    $tokenTextBox = New-Object System.Windows.Forms.TextBox
    $tokenTextBox.Name = 'tokenTextBox'
    $tokenTextBox.Location = New-Object System.Drawing.Point(20, 50)
    $tokenTextBox.Size = New-Object System.Drawing.Size(565, 26)
    $tokenTextBox.UseSystemPasswordChar = $true
    $tokenTextBox.ShortcutsEnabled = $true
    $form.Controls.Add($tokenTextBox)

    $ok = New-Object System.Windows.Forms.Button
    $ok.Text = '验证并查看 dry-run'
    $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $ok.Location = New-Object System.Drawing.Point(320, 95)
    $form.Controls.Add($ok)

    $cancel = New-Object System.Windows.Forms.Button
    $cancel.Text = '取消'
    $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $cancel.Location = New-Object System.Drawing.Point(465, 95)
    $form.Controls.Add($cancel)

    $form.AcceptButton = $ok
    $form.CancelButton = $cancel
    $form.Add_Shown({
      param($sender, $eventArgs)
      $sender.Activate()
      $sender.Controls['tokenTextBox'].Focus()
    })

    $result = $form.ShowDialog()
    $plainValue = [string]$tokenTextBox.Text
    if ($result -ne [System.Windows.Forms.DialogResult]::OK) {
      throw [System.OperationCanceledException]::new('token_input_cancelled')
    }
    if ([string]::IsNullOrWhiteSpace($plainValue)) {
      throw [System.InvalidOperationException]::new('token_empty_after_secure_input')
    }
    $secureValue = New-Object System.Security.SecureString
    foreach ($character in $plainValue.ToCharArray()) { $secureValue.AppendChar($character) }
    $secureValue.MakeReadOnly()
    return $secureValue
  } finally {
    if ($tokenTextBox) { $tokenTextBox.Clear() }
    if ($form) { $form.Dispose() }
    $plainValue = $null
  }
}

function Confirm-ProductionCandidateImport {
  param([Parameter(Mandatory = $true)][int]$ReadyCount, [Parameter(Mandatory = $true)][int]$SkippedCount)
  $message = "下一步将向 Production 写入 Candidate/Evidence 审核数据，但不会公开政策。`n`n固定批次：10 条官方 URL；本次可导入 $ReadyCount 条，已明确跳过 $SkippedCount 条失败项。`n将创建 Raw Snapshot、Candidate、风险和关系提案；不会创建 Policy、Policy Version 或公开投影。`n`n是否继续执行唯一一次导入？"
  $choice = [System.Windows.Forms.MessageBox]::Show(
    $message,
    'Phase 4 P1 - 最终人工确认',
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Warning,
    [System.Windows.Forms.MessageBoxDefaultButton]::Button2
  )
  return $choice -eq [System.Windows.Forms.DialogResult]::Yes
}

function Write-SafeJson {
  param([Parameter(Mandatory = $true)]$Value)
  $Value | ConvertTo-Json -Depth 8
}

function Safe-Number {
  param($Value)
  if ($null -eq $Value) { return 0 }
  try { return [int]$Value } catch { return 0 }
}

function Short-Summary {
  param($Value)
  $text = [string]$Value
  if ($text.Length -gt 500) { return "$($text.Substring(0, 500))…" }
  return $text
}

function Safe-DryRunCandidate {
  param([Parameter(Mandatory = $true)]$Candidate)
  return [ordered]@{
    ordinal = Safe-Number $Candidate.ordinal
    title = $Candidate.policy_title
    document_number = $Candidate.document_number
    issuer = @($Candidate.issuer)
    publication_date = $Candidate.publication_date
    effective_date = $Candidate.effective_date
    official_url = $Candidate.official_url
    source_id = $Candidate.source_id
    source_domain = $Candidate.source_domain
    suggested_tax_categories = @($Candidate.suggested_tax_categories)
    pilot_topics = @($Candidate.pilot_topics)
    suggested_validity_status = $Candidate.suggested_validity_status
    official_status_hint = $Candidate.official_status_hint
    body_hash = $Candidate.body_hash
    summary = Short-Summary $Candidate.summary
    risk_flags = @($Candidate.risk_flags)
    relation_proposals = @($Candidate.relation_proposals | ForEach-Object {
      [ordered]@{ relation_type = $_.relation_type; target_reference = $_.target_reference; confidence = $_.confidence }
    })
    intake_ready = ($Candidate.intake_ready -eq $true)
    dry_run_error = $Candidate.dry_run_error
  }
}

function Test-ExactOfficialUrls {
  param([Parameter(Mandatory = $true)][object[]]$Candidates)
  $actual = @($Candidates | ForEach-Object { [string]$_.official_url } | Sort-Object -Unique)
  $expected = @($expectedOfficialUrls | Sort-Object -Unique)
  return $actual.Count -eq $expected.Count -and (@(Compare-Object -ReferenceObject $expected -DifferenceObject $actual).Count -eq 0)
}

function Get-DryRunImportDecision {
  param([Parameter(Mandatory = $true)]$DryRun)
  $candidates = @($DryRun.candidates)
  $blocked = $false
  $ready = @()
  $skipped = @()
  if ($DryRun.mode -ne 'dry-run' -or (Safe-Number $DryRun.candidate_count) -ne 10 -or $candidates.Count -ne 10) { $blocked = $true }
  if ($DryRun.source.source_id -ne $expectedSourceId -or $DryRun.source.source_domain -ne $expectedSourceDomain -or $DryRun.source.trust_level -ne 'official_primary') { $blocked = $true }
  if ((Safe-Number $DryRun.writes.business_production_writes) -ne 0 -or -not (Test-ExactOfficialUrls $candidates)) { $blocked = $true }
  foreach ($candidate in $candidates) {
    if ($candidate.source_id -ne $expectedSourceId -or $candidate.source_domain -ne $expectedSourceDomain) { $blocked = $true; continue }
    if ([string]$candidate.official_url -notmatch '^https://fgk\.chinatax\.gov\.cn/zcfgk/[^?#]+/content\.html$') { $blocked = $true; continue }
    if ($candidate.dry_run_error -or -not $candidate.intake_ready) {
      if ([string]$candidate.dry_run_error -notmatch '^(OFFICIAL_DETAIL_(READ_FAILED|TIMEOUT|HTTP_\d{3})|POLICY_BODY_CONTAINER_MISSING|PILOT_CANDIDATE_NOT_INTAKE_READY)$') { $blocked = $true; continue }
      $skipped += $candidate
      continue
    }
    if ([string]::IsNullOrWhiteSpace([string]$candidate.policy_title) -or [string]::IsNullOrWhiteSpace([string]$candidate.document_number) -or [string]::IsNullOrWhiteSpace([string]$candidate.publication_date)) { $blocked = $true; continue }
    if ([string]$candidate.body_hash -notmatch '^[a-f0-9]{64}$' -or $candidate.suggested_validity_status -ne 'pending_verification') { $blocked = $true; continue }
    if (@($candidate.risk_flags | Where-Object { [string]$_ -match '^DUPLICATE_' }).Count -gt 0) { $blocked = $true; continue }
    $ready += $candidate
  }
  if ($ready.Count -lt 9 -or $ready.Count -gt 10 -or $skipped.Count -gt 1) { $blocked = $true }
  return [pscustomobject]@{ ready = (-not $blocked); import_candidates = @($ready); skipped_candidates = @($skipped) }
}

function Get-Json {
  param([Parameter(Mandatory = $true)][string]$Uri, $Headers)
  $response = Invoke-WebRequest -Method Get -Uri $Uri -Headers $Headers -UseBasicParsing -ErrorAction Stop
  return [pscustomobject]@{ response = $response; body = ($response.Content | ConvertFrom-Json) }
}

function Get-StatusCounts {
  param($Headers)
  return (Get-Json -Uri $statusUrl -Headers $Headers).body.counts
}

function Get-PublicPolicyTotal {
  return (Get-Json -Uri $publicPoliciesUrl -Headers @{}).body.total
}

function Safe-ImportCandidate {
  param($DryRunCandidate, $Result, $ListedCandidate, $Trace)
  return [ordered]@{
    title = $DryRunCandidate.policy_title
    document_number = $DryRunCandidate.document_number
    issuer = @($DryRunCandidate.issuer)
    publication_date = $DryRunCandidate.publication_date
    official_url = $DryRunCandidate.official_url
    candidate_id = $Result.candidate_id
    evidence_id = $Trace.snapshot.snapshot_id
    body_hash = $Trace.snapshot.normalized_text_sha256
    verification_state = $ListedCandidate.verification_state
    legal_status = $ListedCandidate.legal_status
    validity_status_suggestion = $ListedCandidate.parsed_fields.validity_status_suggestion
    risk_level = $Result.risk_level
    relation_proposals_created = Safe-Number $Result.relation_proposals_created
    duplicate = -not [bool]$Result.candidate_created
  }
}

function Invoke-Phase4P1GuiSelfTest {
  $secureValue = $null
  try {
    $secureValue = Read-GuiSecureString -Prompt 'Self-test only: enter non-sensitive test text. No Production request will be sent.'
    Write-SafeJson ([ordered]@{
      event = 'phase4p1_production_candidate_import_self_test'
      dialog_result = 'OK'
      secure_string_returned = ($secureValue -is [System.Security.SecureString])
      test_text_entered = ($secureValue.Length -gt 0)
      production_request_sent = $false
      business_production_writes = 0
    })
  } catch [System.OperationCanceledException] {
    Write-SafeJson ([ordered]@{ event = 'phase4p1_production_candidate_import_self_test'; dialog_result = 'CANCELLED'; production_request_sent = $false; business_production_writes = 0 })
  } catch [System.InvalidOperationException] {
    Write-SafeJson ([ordered]@{ event = 'phase4p1_production_candidate_import_self_test'; dialog_result = 'EMPTY'; production_request_sent = $false; business_production_writes = 0 })
  } finally {
    if ($secureValue) { $secureValue.Dispose() }
  }
}

function Invoke-Phase4P1ProductionImport {
  $secureToken = $null
  $token = $null
  $tokenBstr = [IntPtr]::Zero
  $stage = 'token_input'
  $productionPostSent = $false
  try {
    # Do not emit output before the GUI. The token is never placed in an env var.
    $secureToken = Read-GuiSecureString -Prompt 'Enter administrator Token to run the Phase 4 P1 dry-run:'
    $tokenBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenBstr).Trim()
    if ([string]::IsNullOrWhiteSpace($token)) { throw [System.InvalidOperationException]::new('token_empty_after_secure_input') }
    if ($token.ToCharArray() | Where-Object { ([int][char]$_) -lt 32 -or ([int][char]$_) -eq 127 }) { throw [System.InvalidOperationException]::new('token_contains_control_character') }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $headers = @{ Authorization = "Bearer $token"; 'Cache-Control' = 'no-store' }

    $stage = 'dry_run'
    $dryRunResponse = Get-Json -Uri $dryRunUrl -Headers $headers
    $dryRun = $dryRunResponse.body
    $dryRunDecision = Get-DryRunImportDecision $dryRun
    $dryRunSummary = [ordered]@{
      event = 'phase4p1_production_dry_run'
      http_status = [int]$dryRunResponse.response.StatusCode
      dry_run_ready = $dryRunDecision.ready
      candidate_count = Safe-Number $dryRun.candidate_count
      import_ready_count = @($dryRunDecision.import_candidates).Count
      skipped_count = @($dryRunDecision.skipped_candidates).Count
      failed_count = @($dryRunDecision.skipped_candidates).Count
      import_ready_official_urls = @($dryRunDecision.import_candidates | ForEach-Object { $_.official_url })
      source = [ordered]@{ source_id = $dryRun.source.source_id; source_name = $dryRun.source.source_name; source_domain = $dryRun.source.source_domain; trust_level = $dryRun.source.trust_level }
      candidates = @($dryRun.candidates | ForEach-Object { Safe-DryRunCandidate $_ })
      business_production_writes = Safe-Number $dryRun.writes.business_production_writes
    }
    Write-SafeJson $dryRunSummary
    if (-not $dryRunDecision.ready) {
      Write-SafeJson ([ordered]@{ event = 'phase4p1_production_import'; error = 'dry_run_not_ready'; stage = $stage; production_post_sent = $false; business_production_writes = 0 })
      return
    }

    $stage = 'read_baseline'
    $beforeCounts = Get-StatusCounts -Headers $headers
    $beforePublicPolicies = Get-PublicPolicyTotal
    $stage = 'human_confirmation'
    if (-not (Confirm-ProductionCandidateImport -ReadyCount @($dryRunDecision.import_candidates).Count -SkippedCount @($dryRunDecision.skipped_candidates).Count)) {
      Write-SafeJson ([ordered]@{ event = 'phase4p1_production_import'; execution = 'cancelled_by_operator'; production_post_sent = $false; business_production_writes = 0 })
      return
    }

    $stage = 'candidate_evidence_import'
    $requestBody = @{ apply = $true; confirmation = $confirmationPhrase; official_urls = @($dryRunDecision.import_candidates | ForEach-Object { $_.official_url }) } | ConvertTo-Json -Compress
    $productionPostSent = $true
    $importResponse = Invoke-WebRequest -Method Post -Uri $importUrl -Headers $headers -ContentType 'application/json' -Body $requestBody -UseBasicParsing -ErrorAction Stop
    $import = $importResponse.Content | ConvertFrom-Json
    if ($import.mode -ne 'review_candidate_intake' -or @($import.results).Count -gt @($dryRunDecision.import_candidates).Count) { throw [System.InvalidOperationException]::new('import_response_incomplete') }
    if ((Safe-Number $import.created.policies) -ne 0 -or (Safe-Number $import.created.policy_versions) -ne 0 -or (Safe-Number $import.created.public_projections) -ne 0) { throw [System.InvalidOperationException]::new('import_response_public_write_detected') }

    $stage = 'read_only_acceptance'
    $afterCounts = Get-StatusCounts -Headers $headers
    $afterPublicPolicies = Get-PublicPolicyTotal
    $candidateList = (Get-Json -Uri $candidateListUrl -Headers $headers).body.candidates
    $dryRunByUrl = @{}
    foreach ($candidate in @($dryRun.candidates)) { $dryRunByUrl[[string]$candidate.official_url] = $candidate }
    $listedById = @{}
    foreach ($candidate in @($candidateList)) { $listedById[[string]$candidate.candidate_id] = $candidate }
    $accepted = @()
    foreach ($result in @($import.results)) {
      $officialUrl = [string]$result.official_url
      $dryRunCandidate = $dryRunByUrl[$officialUrl]
      $listedCandidate = $listedById[[string]$result.candidate_id]
      if ($null -eq $dryRunCandidate -or $null -eq $listedCandidate) { throw [System.InvalidOperationException]::new('post_import_candidate_missing') }
      if ($listedCandidate.verification_state -ne 'pending_review' -or $listedCandidate.legal_status -ne 'pending' -or $listedCandidate.parsed_fields.validity_status_suggestion -ne 'pending_verification') { throw [System.InvalidOperationException]::new('post_import_candidate_state_not_pending') }
      $traceUrl = "$productionOrigin/api/admin/evidence/candidates/$([uri]::EscapeDataString([string]$result.candidate_id))/trace"
      $trace = (Get-Json -Uri $traceUrl -Headers $headers).body.trace
      if ($trace.snapshot.official_url -ne $officialUrl -or $trace.snapshot.normalized_text_sha256 -ne $dryRunCandidate.body_hash) { throw [System.InvalidOperationException]::new('post_import_evidence_trace_mismatch') }
      $accepted += Safe-ImportCandidate -DryRunCandidate $dryRunCandidate -Result $result -ListedCandidate $listedCandidate -Trace $trace
    }
    $created = $import.created
    $auditDelta = (Safe-Number $afterCounts.audit_events) - (Safe-Number $beforeCounts.audit_events)
    Write-SafeJson ([ordered]@{
      event = 'phase4p1_production_candidate_evidence_import'
      http_status = [int]$importResponse.StatusCode
      execution = 'completed'
      candidates = $accepted
      writes = [ordered]@{
        raw_snapshots_created = (Safe-Number $afterCounts.raw_snapshots) - (Safe-Number $beforeCounts.raw_snapshots)
        evidence_created = (Safe-Number $afterCounts.raw_snapshots) - (Safe-Number $beforeCounts.raw_snapshots)
        candidates_created = (Safe-Number $afterCounts.candidates) - (Safe-Number $beforeCounts.candidates)
        risk_created = Safe-Number $created.risk_assessments
        relation_created = Safe-Number $created.relation_proposals
        audit_created = $auditDelta
        duplicate = @($import.results | Where-Object { -not $_.candidate_created }).Count
        skipped = @($dryRunDecision.skipped_candidates).Count + @($import.skipped).Count
        failed = @($dryRunDecision.skipped_candidates).Count + @($import.failed).Count
      }
      safety = [ordered]@{
        policy_created = (Safe-Number $afterCounts.policies) - (Safe-Number $beforeCounts.policies)
        policy_version_created = (Safe-Number $afterCounts.policy_versions) - (Safe-Number $beforeCounts.policy_versions)
        public_projection_created = Safe-Number $created.public_projections
        automatic_level3 = $false
        automatic_legal_effect_determination = $false
        public_policy_total_before = Safe-Number $beforePublicPolicies
        public_policy_total_after = Safe-Number $afterPublicPolicies
        public_policy_result_changed = ((Safe-Number $beforePublicPolicies) -ne (Safe-Number $afterPublicPolicies))
      }
      business_production_writes = [ordered]@{ candidate_evidence_writes = (Safe-Number $afterCounts.raw_snapshots) - (Safe-Number $beforeCounts.raw_snapshots); public_policy_writes = 0 }
    })
  } catch {
    $httpResponse = $_.Exception.Response
    $tokenInputCodes = @('token_input_cancelled', 'token_empty_after_secure_input', 'token_contains_control_character')
    if ($stage -eq 'token_input' -and $tokenInputCodes -contains $_.Exception.Message) {
      Write-SafeJson ([ordered]@{ event = 'phase4p1_production_candidate_evidence_import'; error = 'local_token_input_error'; reason = $_.Exception.Message; production_post_sent = $false; business_production_writes = 0 })
    } elseif ($httpResponse) {
      Write-SafeJson ([ordered]@{ event = 'phase4p1_production_candidate_evidence_import'; error = 'import_http_error'; stage = $stage; http_status = [int]$httpResponse.StatusCode; production_post_sent = $productionPostSent; business_production_writes = $(if ($productionPostSent) { 'unknown_after_post' } else { 0 }) })
    } else {
      # Do not include exception.Message: HTTP implementations can include headers.
      Write-SafeJson ([ordered]@{ event = 'phase4p1_production_candidate_evidence_import'; error = 'import_request_failed'; stage = $stage; exception_type = $_.Exception.GetType().Name; production_post_sent = $productionPostSent; business_production_writes = $(if ($productionPostSent) { 'unknown_after_post' } else { 0 }) })
    }
  } finally {
    if ($tokenBstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenBstr) }
    if ($secureToken) { $secureToken.Dispose() }
    $token = $null
  }
}

if ($SelfTest) {
  Invoke-Phase4P1GuiSelfTest
  return
}
Invoke-Phase4P1ProductionImport
