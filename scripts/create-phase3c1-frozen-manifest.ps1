[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^phase3c1-preview-job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')]
  [string]$JobId
)

# This wrapper is intentionally limited to one existing Phase 3C1 Preview Job.
# It first reads the fixed status endpoint and only then makes one fixed POST to
# freeze that Job's already-persisted materials. It cannot create Preview Jobs,
# fetch official URLs, run preflight, or run Apply.
$ErrorActionPreference = 'Stop'
$statusUrl = "https://xielujin-tax-knowledge-base.netlify.app/api/admin/evidence/phase3c1/import-preview-jobs/$([uri]::EscapeDataString($JobId))"
$createManifestUrl = 'https://xielujin-tax-knowledge-base.netlify.app/api/admin/evidence/phase3c1/import-manifests'
$token = $null
$tokenBstr = [IntPtr]::Zero
$stage = 'token_input'

function Read-GuiSecureString {
  param([Parameter(Mandatory = $true)][string]$Prompt)

  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'Phase 3C1 Frozen Manifest'
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
  $ok.Text = '创建 Frozen Manifest'
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

function Safe-Number {
  param($Value)
  if ($null -eq $Value) { return $null }
  try { return [int]$Value } catch { return $null }
}

function Test-PreviewJobReady {
  param([Parameter(Mandatory = $true)]$Job)
  return $Job.job_state -eq 'passed' `
    -and (Safe-Number $Job.completed_count) -eq 10 `
    -and (Safe-Number $Job.total_count) -eq 10 `
    -and (Safe-Number $Job.selected_items_count) -eq 10 `
    -and (Safe-Number $Job.material_count) -eq 10 `
    -and (Safe-Number $Job.complete_material_count) -eq 10 `
    -and ([string]$Job.material_set_hash -match '^[a-f0-9]{64}$') `
    -and $Job.material_set_hash_matches_rows `
    -and $Job.material_ordinals_complete `
    -and $Job.selection_provenance_complete `
    -and $Job.protected_object_integrity_metadata_present `
    -and $Job.ready_to_create_frozen_manifest -eq 'YES' `
    -and (Safe-Number $Job.business_production_writes) -eq 0
}

function Safe-ReadinessSummary {
  param([Parameter(Mandatory = $true)]$Job)
  return [ordered]@{
    job_id = $Job.job_id
    job_state = $Job.job_state
    completed_count = $Job.completed_count
    total_count = $Job.total_count
    selected_items_count = $Job.selected_items_count
    material_count = $Job.material_count
    complete_material_count = $Job.complete_material_count
    material_set_hash_present = -not [string]::IsNullOrWhiteSpace([string]$Job.material_set_hash)
    material_set_hash_matches_rows = [bool]$Job.material_set_hash_matches_rows
    material_ordinals_complete = [bool]$Job.material_ordinals_complete
    selection_provenance_complete = [bool]$Job.selection_provenance_complete
    protected_object_integrity_metadata_present = [bool]$Job.protected_object_integrity_metadata_present
    ready_to_create_frozen_manifest = $Job.ready_to_create_frozen_manifest
    business_production_writes = if ($null -eq $Job.business_production_writes) { 0 } else { $Job.business_production_writes }
  }
}

try {
  $secureToken = Read-GuiSecureString -Prompt 'Enter administrator Token (creates one Frozen Manifest only after read-only readiness verification):'
  $tokenBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenBstr).Trim()
  if ([string]::IsNullOrWhiteSpace($token)) { throw [System.InvalidOperationException]::new('token_empty_after_secure_input') }
  if ($token.ToCharArray() | Where-Object { ([int][char]$_) -lt 32 -or ([int][char]$_) -eq 127 }) { throw [System.InvalidOperationException]::new('token_contains_control_character') }

  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $headers = @{ Authorization = "Bearer $token"; 'Cache-Control' = 'no-store' }
  $stage = 'read_preview_job_status'
  $statusResponse = Invoke-WebRequest -Method Get -Uri $statusUrl -Headers $headers -UseBasicParsing -ErrorAction Stop
  $statusBody = $statusResponse.Content | ConvertFrom-Json
  if ($null -eq $statusBody.job) { throw [System.InvalidOperationException]::new('job_status_missing_job') }
  $job = $statusBody.job
  if (-not (Test-PreviewJobReady $job)) {
    Write-SafeJson ([ordered]@{
      event = 'freeze_manifest'
      http_status = $statusResponse.StatusCode
      error = 'preview_job_not_ready'
      readiness = Safe-ReadinessSummary $job
      business_production_writes = 0
    })
    return
  }

  $stage = 'create_frozen_manifest'
  $requestBody = @{ freeze = $true; confirmation = 'FREEZE_PHASE3C1_FIRST_TEN'; source_preview_job_id = $JobId } | ConvertTo-Json -Compress
  $manifestResponse = Invoke-WebRequest -Method Post -Uri $createManifestUrl -Headers $headers -ContentType 'application/json' -Body $requestBody -UseBasicParsing -ErrorAction Stop
  $manifestBody = $manifestResponse.Content | ConvertFrom-Json
  if ($null -eq $manifestBody.manifest) { throw [System.InvalidOperationException]::new('manifest_create_missing_manifest') }
  $manifest = $manifestBody.manifest
  Write-SafeJson ([ordered]@{
    event = 'freeze_manifest'
    http_status = $manifestResponse.StatusCode
    manifest_id = $manifest.controlled_manifest_id
    source_preview_job_id = $manifest.source_preview_job_id
    created = [bool]$manifestBody.created
    manifest_hash = $manifest.manifest_hash
    item_count = @($manifestBody.items | Where-Object { $null -ne $_ }).Count
    manifest_state = $manifest.manifest_state
    preview_job_audit_writes = $job.preview_job_audit_writes
    business_production_writes = if ($null -eq $manifestBody.business_production_writes) { 0 } else { $manifestBody.business_production_writes }
  })
} catch {
  $httpResponse = $_.Exception.Response
  if ($httpResponse) {
    Write-SafeJson ([ordered]@{ event = 'freeze_manifest'; job_id = $JobId; http_status = [int]$httpResponse.StatusCode; error = 'manifest_http_error'; stage = $stage; business_production_writes = 0 })
  } elseif ($_.Exception -is [System.InvalidOperationException] -or $_.Exception -is [System.OperationCanceledException]) {
    Write-SafeJson ([ordered]@{ event = 'freeze_manifest'; job_id = $JobId; error = 'local_token_input_error'; reason = $_.Exception.Message; business_production_writes = 0 })
  } else {
    # Never serialize exception text: it can contain request headers on some hosts.
    Write-SafeJson ([ordered]@{ event = 'freeze_manifest'; job_id = $JobId; error = 'manifest_request_failed'; stage = $stage; exception_type = $_.Exception.GetType().Name; business_production_writes = 0 })
  }
} finally {
  if ($tokenBstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenBstr) }
  $token = $null
}
