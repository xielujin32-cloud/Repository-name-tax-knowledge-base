[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^controlled-import-manifest-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')]
  [string]$ManifestId
)

# This local wrapper accepts only one existing Frozen Manifest identifier. It
# issues one authenticated GET only; it cannot create a Job or Manifest, fetch
# official URLs, run Preview/Preflight/Apply, or send a non-GET request.
$ErrorActionPreference = 'Stop'
$manifestUrl = "https://xielujin-tax-knowledge-base.netlify.app/api/admin/evidence/phase3c1/import-manifests/$([uri]::EscapeDataString($ManifestId))"
$token = $null
$tokenBstr = [IntPtr]::Zero
$stage = 'token_input'

function Read-GuiSecureString {
  param([Parameter(Mandatory = $true)][string]$Prompt)

  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'Phase 3C1 Frozen Manifest Integrity (read only)'
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
  $ok.Text = 'Read integrity only'
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

function Safe-IntegritySummary {
  param([Parameter(Mandatory = $true)]$Integrity)
  return [ordered]@{
    source_job_passed = ($Integrity.source_job_passed -eq $true)
    material_set_hash = if ([string]$Integrity.material_set_hash -match '^[a-f0-9]{64}$') { [string]$Integrity.material_set_hash } else { $null }
    material_set_hash_matches_rows = ($Integrity.material_set_hash_matches_rows -eq $true)
    manifest_items_match_source_materials = ($Integrity.manifest_items_match_source_materials -eq $true)
    material_count = Safe-Number $Integrity.material_count
    complete_material_count = Safe-Number $Integrity.complete_material_count
    ordinal_complete = ($Integrity.ordinal_complete -eq $true)
    selection_provenance_complete = ($Integrity.selection_provenance_complete -eq $true)
    protected_object_integrity_metadata_present = ($Integrity.protected_object_integrity_metadata_present -eq $true)
    computed_manifest_hash = if ([string]$Integrity.computed_manifest_hash -match '^[a-f0-9]{64}$') { [string]$Integrity.computed_manifest_hash } else { $null }
    manifest_hash_matches_frozen_items = ($Integrity.manifest_hash_matches_frozen_items -eq $true)
    ready_for_preflight_validation = ($Integrity.ready_for_preflight_validation -eq $true)
  }
}

function Test-IntegrityPassed {
  param([Parameter(Mandatory = $true)]$Manifest, [Parameter(Mandatory = $true)]$Integrity)
  return $Manifest.manifest_state -eq 'frozen' `
    -and $Integrity.source_job_passed -eq $true `
    -and ([string]$Integrity.material_set_hash -match '^[a-f0-9]{64}$') `
    -and $Integrity.material_set_hash_matches_rows -eq $true `
    -and $Integrity.manifest_items_match_source_materials -eq $true `
    -and (Safe-Number $Integrity.material_count) -eq 10 `
    -and (Safe-Number $Integrity.complete_material_count) -eq 10 `
    -and $Integrity.ordinal_complete -eq $true `
    -and $Integrity.selection_provenance_complete -eq $true `
    -and $Integrity.protected_object_integrity_metadata_present -eq $true `
    -and $Integrity.manifest_hash_matches_frozen_items -eq $true `
    -and $Integrity.ready_for_preflight_validation -eq $true
}

try {
  $secureToken = Read-GuiSecureString -Prompt 'Enter administrator Token (reads one existing Frozen Manifest integrity summary only):'
  $tokenBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenBstr).Trim()
  if ([string]::IsNullOrWhiteSpace($token)) { throw [System.InvalidOperationException]::new('token_empty_after_secure_input') }
  if ($token.ToCharArray() | Where-Object { ([int][char]$_) -lt 32 -or ([int][char]$_) -eq 127 }) { throw [System.InvalidOperationException]::new('token_contains_control_character') }

  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $stage = 'read_frozen_manifest_integrity'
  $response = Invoke-WebRequest -Method Get -Uri $manifestUrl -Headers @{ Authorization = "Bearer $token"; 'Cache-Control' = 'no-store' } -UseBasicParsing -ErrorAction Stop
  $body = $response.Content | ConvertFrom-Json
  if ($null -eq $body.manifest -or $null -eq $body.integrity) { throw [System.InvalidOperationException]::new('manifest_integrity_response_incomplete') }

  $manifest = $body.manifest
  $integrity = Safe-IntegritySummary $body.integrity
  $integrityPassed = Test-IntegrityPassed -Manifest $manifest -Integrity $integrity
  Write-SafeJson ([ordered]@{
    event = 'read_frozen_manifest_integrity'
    http_status = $response.StatusCode
    manifest_id = $manifest.controlled_manifest_id
    manifest_state = $manifest.manifest_state
    source_preview_job_id = $manifest.source_preview_job_id
    manifest_hash = $manifest.manifest_hash
    item_count = @($body.items | Where-Object { $null -ne $_ }).Count
    integrity = $integrity
    integrity_passed = $integrityPassed
    ready_to_enter_preflight = if ($integrityPassed) { 'YES' } else { 'NO' }
    error = if ($integrityPassed) { $null } else { 'manifest_integrity_failed' }
    business_production_writes = if ($null -eq $body.business_production_writes) { 0 } else { $body.business_production_writes }
  })
} catch {
  $httpResponse = $_.Exception.Response
  if ($httpResponse) {
    Write-SafeJson ([ordered]@{ event = 'read_frozen_manifest_integrity'; manifest_id = $ManifestId; http_status = [int]$httpResponse.StatusCode; error = 'manifest_integrity_http_error'; business_production_writes = 0 })
  } elseif ($_.Exception -is [System.InvalidOperationException] -or $_.Exception -is [System.OperationCanceledException]) {
    Write-SafeJson ([ordered]@{ event = 'read_frozen_manifest_integrity'; manifest_id = $ManifestId; error = 'local_token_input_error'; reason = $_.Exception.Message; business_production_writes = 0 })
  } else {
    # Never serialize exception text: it can contain request headers on some hosts.
    Write-SafeJson ([ordered]@{ event = 'read_frozen_manifest_integrity'; manifest_id = $ManifestId; error = 'manifest_integrity_request_failed'; stage = $stage; exception_type = $_.Exception.GetType().Name; business_production_writes = 0 })
  }
} finally {
  if ($tokenBstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenBstr) }
  $token = $null
}
