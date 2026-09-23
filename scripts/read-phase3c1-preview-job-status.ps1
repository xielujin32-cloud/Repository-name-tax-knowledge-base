[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^phase3c1-preview-job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')]
  [string]$JobId
)

# This local wrapper only accepts a validated existing Preview Job identifier.
# It issues one authenticated GET and accepts no URL, ordinal, rank, candidate,
# manifest, preflight, or Apply parameters.
$ErrorActionPreference = 'Stop'
$statusUrl = "https://xielujin-tax-knowledge-base.netlify.app/api/admin/evidence/phase3c1/import-preview-jobs/$([uri]::EscapeDataString($jobId))"
$token = $null
$tokenBstr = [IntPtr]::Zero
$stage = 'token_input'

function Read-GuiSecureString {
  param([Parameter(Mandatory = $true)][string]$Prompt)

  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'Phase 3C1 Preview Job Status (read only)'
  $form.StartPosition = 'CenterScreen'
  $form.Size = New-Object System.Drawing.Size(560, 190)
  $form.FormBorderStyle = 'FixedDialog'
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false

  $label = New-Object System.Windows.Forms.Label
  $label.Text = $Prompt
  $label.AutoSize = $true
  $label.Location = New-Object System.Drawing.Point(18, 20)
  $form.Controls.Add($label)

  $tokenTextBox = New-Object System.Windows.Forms.TextBox
  $tokenTextBox.Name = 'tokenTextBox'
  $tokenTextBox.Location = New-Object System.Drawing.Point(20, 50)
  $tokenTextBox.Size = New-Object System.Drawing.Size(505, 26)
  $tokenTextBox.UseSystemPasswordChar = $true
  $tokenTextBox.ShortcutsEnabled = $true
  $form.Controls.Add($tokenTextBox)

  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = 'Read status only'
  $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $ok.Location = New-Object System.Drawing.Point(285, 95)
  $form.Controls.Add($ok)

  $cancel = New-Object System.Windows.Forms.Button
  $cancel.Text = '取消'
  $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $cancel.Location = New-Object System.Drawing.Point(425, 95)
  $form.Controls.Add($cancel)

  $form.AcceptButton = $ok
  $form.CancelButton = $cancel
  $form.Add_Shown({
    param($sender, $eventArgs)
    $sender.Activate()
    $sender.Controls['tokenTextBox'].Focus()
  })
  try {
    $result = $form.ShowDialog()
    $plainValue = $tokenTextBox.Text
    $tokenTextBox.Clear()
  } finally {
    $form.Dispose()
  }
  if ($result -ne [System.Windows.Forms.DialogResult]::OK) { throw [System.OperationCanceledException]::new('token_input_cancelled') }
  if ([string]::IsNullOrWhiteSpace($plainValue)) { throw [System.InvalidOperationException]::new('token_empty_after_secure_input') }

  $secureValue = New-Object System.Security.SecureString
  foreach ($character in $plainValue.ToCharArray()) { $secureValue.AppendChar($character) }
  $secureValue.MakeReadOnly()
  $plainValue = $null
  return $secureValue
}

function Write-SafeJson {
  param([Parameter(Mandatory = $true)]$Value)
  $Value | ConvertTo-Json -Depth 5
}

function Preview-ResultForStatus {
  param($Status)
  if ($Status -eq 'passed') { return 'PASS' }
  if ($Status -in @('blocked', 'failed')) { return 'BLOCKED' }
  return 'IN_PROGRESS'
}

function Safe-JobSummary {
  param([Parameter(Mandatory = $true)]$Job, [Parameter(Mandatory = $true)][int]$HttpStatus)
  $selectedCount = @($Job.selected_items | Where-Object { $null -ne $_ }).Count
  $skipCount = @($Job.skip_audit | Where-Object { $null -ne $_ }).Count
  $failureOrdinal = $Job.current_ordinal
  if ($Job.safe_failure -and $null -ne $Job.safe_failure.failed_ordinal) { $failureOrdinal = $Job.safe_failure.failed_ordinal }
  return [ordered]@{
    event = 'read_existing_preview_job_status'
    http_status = $HttpStatus
    job_id = $Job.job_id
    job_state = $Job.job_state
    status = $Job.status
    completed_count = $Job.completed_count
    total_count = $Job.total_count
    current_ordinal = $Job.current_ordinal
    preview_result = if ($Job.preview_result) { $Job.preview_result } else { Preview-ResultForStatus $Job.status }
    failure_code = $Job.failure_code
    failure_ordinal = $failureOrdinal
    ready_to_create_frozen_manifest = $Job.ready_to_create_frozen_manifest
    preview_job_audit_writes = $Job.preview_job_audit_writes
    business_production_writes = if ($null -eq $Job.business_production_writes) { 0 } else { $Job.business_production_writes }
    selected_items_count = $selectedCount
    selected_items_match_completed_count = ($selectedCount -eq [int]$Job.completed_count)
    material_count = $Job.material_count
    complete_material_count = $Job.complete_material_count
    material_set_hash = $Job.material_set_hash
    material_set_hash_matches_rows = $Job.material_set_hash_matches_rows
    material_ordinals_complete = $Job.material_ordinals_complete
    selection_provenance_complete = $Job.selection_provenance_complete
    protected_object_integrity_metadata_present = $Job.protected_object_integrity_metadata_present
    skip_audit_count = $skipCount
    circuit_breaker_triggered = ($Job.failure_code -eq 'UPSTREAM_INCOMPLETE_RESPONSE_STREAK')
  }
}

try {
  $secureToken = Read-GuiSecureString -Prompt 'Enter administrator Token (read existing Job only; hidden input):'
  $tokenBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenBstr).Trim()
  $tokenContainsControlCharacter = $false
  foreach ($character in $token.ToCharArray()) {
    $characterCode = [int][char]$character
    if ($characterCode -lt 32 -or $characterCode -eq 127) { $tokenContainsControlCharacter = $true; break }
  }
  if ($tokenContainsControlCharacter) { throw [System.InvalidOperationException]::new('token_contains_control_character') }
  if ([string]::IsNullOrWhiteSpace($token)) { throw [System.InvalidOperationException]::new('token_empty_after_secure_input') }

  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $stage = 'read_existing_preview_job_status'
  $response = Invoke-WebRequest -Method Get -Uri $statusUrl -Headers @{ Authorization = "Bearer $token"; 'Cache-Control' = 'no-store' } -UseBasicParsing -ErrorAction Stop
  $body = $response.Content | ConvertFrom-Json
  if ($null -eq $body.job) { throw [System.InvalidOperationException]::new('job_status_missing_job') }
  Write-SafeJson (Safe-JobSummary -Job $body.job -HttpStatus $response.StatusCode)
} catch {
  $httpResponse = $_.Exception.Response
  if ($httpResponse) {
    Write-SafeJson ([ordered]@{ event = 'read_existing_preview_job_status'; job_id = $jobId; http_status = [int]$httpResponse.StatusCode; error = 'job_status_http_error'; business_production_writes = 0 })
  } elseif ($_.Exception -is [System.InvalidOperationException] -or $_.Exception -is [System.OperationCanceledException]) {
    Write-SafeJson ([ordered]@{ event = 'read_existing_preview_job_status'; job_id = $jobId; error = 'local_token_input_error'; reason = $_.Exception.Message; business_production_writes = 0 })
  } else {
    # Never serialize exception text: it can contain request headers on some hosts.
    Write-SafeJson ([ordered]@{ event = 'read_existing_preview_job_status'; job_id = $jobId; error = 'job_status_request_failed'; stage = $stage; exception_type = $_.Exception.GetType().Name; business_production_writes = 0 })
  }
} finally {
  if ($tokenBstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenBstr) }
  $token = $null
}
