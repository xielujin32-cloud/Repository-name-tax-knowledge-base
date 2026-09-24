[CmdletBinding()]
param()

# This wrapper is intentionally fixed to the verified Phase 3C1 Frozen Manifest.
# It reads that Manifest once, then can send one fixed Preflight POST. It cannot
# fetch official URLs, create a Preview Job/Manifest, or invoke Apply.
$ErrorActionPreference = 'Stop'
$manifestId = 'controlled-import-manifest-429737d3-f068-4620-acc2-9031f1d938df'
$manifestHash = '0c028eed96110e993abe23e089f442e0654eaa5b95d52aec1d3ce2c7e5285cd4'
$manifestUrl = "https://xielujin-tax-knowledge-base.netlify.app/api/admin/evidence/phase3c1/import-manifests/$([uri]::EscapeDataString($manifestId))"
$preflightUrl = "$manifestUrl/preflights"
$token = $null
$tokenBstr = [IntPtr]::Zero
$stage = 'token_input'

function Read-GuiSecureString {
  param([Parameter(Mandatory = $true)][string]$Prompt)

  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'Phase 3C2 Production Preflight'
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
  $ok.Text = 'Run Preflight only'
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

function Safe-RequestId {
  param($Response)
  if ($null -eq $Response) { return $null }
  try {
    $requestId = [string]$Response.Headers['x-nf-request-id']
    if ([string]::IsNullOrWhiteSpace($requestId)) { $requestId = [string]$Response.Headers['x-request-id'] }
    $requestId = $requestId.Trim()
    if ($requestId -match '^[A-Za-z0-9._:-]{1,200}$') { return $requestId }
  } catch { }
  return $null
}

function Safe-IntegritySummary {
  param([Parameter(Mandatory = $true)]$Integrity)
  return [ordered]@{
    source_job_passed = ($Integrity.source_job_passed -eq $true)
    material_set_hash_matches_rows = ($Integrity.material_set_hash_matches_rows -eq $true)
    manifest_items_match_source_materials = ($Integrity.manifest_items_match_source_materials -eq $true)
    material_count = Safe-Number $Integrity.material_count
    complete_material_count = Safe-Number $Integrity.complete_material_count
    ordinal_complete = ($Integrity.ordinal_complete -eq $true)
    selection_provenance_complete = ($Integrity.selection_provenance_complete -eq $true)
    protected_object_integrity_metadata_present = ($Integrity.protected_object_integrity_metadata_present -eq $true)
    manifest_hash_matches_frozen_items = ($Integrity.manifest_hash_matches_frozen_items -eq $true)
    ready_for_preflight_validation = ($Integrity.ready_for_preflight_validation -eq $true)
  }
}

function Test-ManifestPreflightReady {
  param([Parameter(Mandatory = $true)]$Manifest, [Parameter(Mandatory = $true)]$Integrity, [Parameter(Mandatory = $true)]$ResponseBody)
  return $Manifest.controlled_manifest_id -eq $manifestId `
    -and $Manifest.manifest_state -eq 'frozen' `
    -and $Manifest.manifest_hash -eq $manifestHash `
    -and $Integrity.source_job_passed -eq $true `
    -and $Integrity.material_set_hash_matches_rows -eq $true `
    -and $Integrity.manifest_items_match_source_materials -eq $true `
    -and (Safe-Number $Integrity.material_count) -eq 10 `
    -and (Safe-Number $Integrity.complete_material_count) -eq 10 `
    -and $Integrity.ordinal_complete -eq $true `
    -and $Integrity.selection_provenance_complete -eq $true `
    -and $Integrity.protected_object_integrity_metadata_present -eq $true `
    -and $Integrity.manifest_hash_matches_frozen_items -eq $true `
    -and $Integrity.ready_for_preflight_validation -eq $true `
    -and (Safe-Number $ResponseBody.business_production_writes) -eq 0
}

function Safe-ReadinessSummary {
  param([Parameter(Mandatory = $true)]$Manifest, [Parameter(Mandatory = $true)]$Integrity, [Parameter(Mandatory = $true)]$ResponseBody)
  return [ordered]@{
    manifest_id = $Manifest.controlled_manifest_id
    manifest_state = $Manifest.manifest_state
    manifest_hash_matches_expected = ($Manifest.manifest_hash -eq $manifestHash)
    integrity = $Integrity
    integrity_passed = (Test-ManifestPreflightReady -Manifest $Manifest -Integrity $Integrity -ResponseBody $ResponseBody)
    business_production_writes = if ($null -eq $ResponseBody.business_production_writes) { $null } else { $ResponseBody.business_production_writes }
  }
}

try {
  $secureToken = Read-GuiSecureString -Prompt 'Enter administrator Token (runs one Preflight only after Frozen Manifest integrity verification):'
  $tokenBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenBstr).Trim()
  if ([string]::IsNullOrWhiteSpace($token)) { throw [System.InvalidOperationException]::new('token_empty_after_secure_input') }
  if ($token.ToCharArray() | Where-Object { ([int][char]$_) -lt 32 -or ([int][char]$_) -eq 127 }) { throw [System.InvalidOperationException]::new('token_contains_control_character') }

  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $headers = @{ Authorization = "Bearer $token"; 'Cache-Control' = 'no-store' }
  $stage = 'read_frozen_manifest_integrity'
  $manifestResponse = Invoke-WebRequest -Method Get -Uri $manifestUrl -Headers $headers -UseBasicParsing -ErrorAction Stop
  $manifestBody = $manifestResponse.Content | ConvertFrom-Json
  if ($null -eq $manifestBody.manifest -or $null -eq $manifestBody.integrity) { throw [System.InvalidOperationException]::new('manifest_integrity_response_incomplete') }
  $manifest = $manifestBody.manifest
  $integrity = Safe-IntegritySummary $manifestBody.integrity
  if (-not (Test-ManifestPreflightReady -Manifest $manifest -Integrity $integrity -ResponseBody $manifestBody)) {
    Write-SafeJson ([ordered]@{
      event = 'phase3c2_production_preflight'
      http_status = $manifestResponse.StatusCode
      error = 'frozen_manifest_not_ready_for_preflight'
      readiness = Safe-ReadinessSummary -Manifest $manifest -Integrity $integrity -ResponseBody $manifestBody
      business_production_writes = 0
    })
    return
  }

  $stage = 'create_preflight'
  $requestBody = @{ check = $true; manifest_hash = $manifestHash } | ConvertTo-Json -Compress
  $preflightResponse = Invoke-WebRequest -Method Post -Uri $preflightUrl -Headers $headers -ContentType 'application/json' -Body $requestBody -UseBasicParsing -ErrorAction Stop
  $preflightBody = $preflightResponse.Content | ConvertFrom-Json
  if ($null -eq $preflightBody.preflight) { throw [System.InvalidOperationException]::new('preflight_response_missing_preflight') }
  $preflight = $preflightBody.preflight
  $readyForApply = $preflight.preflight_state -eq 'ready' -and $preflightBody.evidence_duplicate_free -eq $true
  Write-SafeJson ([ordered]@{
    event = 'phase3c2_production_preflight'
    http_status = $preflightResponse.StatusCode
    manifest_id = $manifestId
    manifest_hash = $manifestHash
    preflight_id = $preflight.preflight_id
    preflight_state = $preflight.preflight_state
    created = ($preflightBody.created -eq $true)
    validation = $preflightBody.validation
    evidence_duplicate_free = ($preflightBody.evidence_duplicate_free -eq $true)
    expires_at = $preflight.expires_at
    ready_for_apply = if ($readyForApply) { 'YES' } else { 'NO' }
    preflight_audit_writes = if ($preflightBody.created -eq $true) { 1 } else { 0 }
    business_production_writes = 0
  })
} catch {
  $httpResponse = $_.Exception.Response
  if ($httpResponse) {
    Write-SafeJson ([ordered]@{ event = 'phase3c2_production_preflight'; manifest_id = $manifestId; manifest_hash = $manifestHash; http_status = [int]$httpResponse.StatusCode; netlify_request_id = Safe-RequestId $httpResponse; error = 'preflight_http_error'; stage = $stage; business_production_writes = 0 })
  } elseif ($_.Exception -is [System.InvalidOperationException] -or $_.Exception -is [System.OperationCanceledException]) {
    Write-SafeJson ([ordered]@{ event = 'phase3c2_production_preflight'; manifest_id = $manifestId; manifest_hash = $manifestHash; error = 'local_token_input_error'; reason = $_.Exception.Message; business_production_writes = 0 })
  } else {
    # Never serialize exception text: it can contain request headers on some hosts.
    Write-SafeJson ([ordered]@{ event = 'phase3c2_production_preflight'; manifest_id = $manifestId; manifest_hash = $manifestHash; error = 'preflight_request_failed'; stage = $stage; exception_type = $_.Exception.GetType().Name; business_production_writes = 0 })
  }
} finally {
  if ($tokenBstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenBstr) }
  $token = $null
}
