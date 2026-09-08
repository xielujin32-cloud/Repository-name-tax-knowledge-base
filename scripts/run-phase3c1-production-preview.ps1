[CmdletBinding()]
param()

# This wrapper deliberately has no URL, endpoint, rank, or query parameters.
# It performs exactly one GET of the server-owned Phase 3C preview endpoint.
$ErrorActionPreference = 'Stop'
$previewUrl = 'https://xielujin-tax-knowledge-base.netlify.app/api/admin/evidence/phase3c1/import-preview'
$token = $null
$tokenBstr = [IntPtr]::Zero
$stage = 'token_input'

function Read-GuiSecureString {
  param([Parameter(Mandatory = $true)][string]$Prompt)

  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'Phase 3C 只读 Production Preview'
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

  $input = New-Object System.Windows.Forms.TextBox
  $input.Location = New-Object System.Drawing.Point(20, 50)
  $input.Size = New-Object System.Drawing.Size(505, 26)
  $input.UseSystemPasswordChar = $true
  $input.ShortcutsEnabled = $true
  $form.Controls.Add($input)

  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = '执行一次只读 Preview'
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
  $form.Add_Shown({ $input.Select() })
  $result = $form.ShowDialog()
  $plainValue = $input.Text
  $input.Clear()
  $form.Dispose()
  if ($result -ne [System.Windows.Forms.DialogResult]::OK) {
    throw [System.OperationCanceledException]::new('token_input_cancelled')
  }
  if ([string]::IsNullOrWhiteSpace($plainValue)) {
    throw [System.InvalidOperationException]::new('token_empty_after_secure_input')
  }

  # Avoid ConvertTo-SecureString: this Windows PowerShell host can fail to
  # auto-load Microsoft.PowerShell.Security. The plaintext exists only long
  # enough to build the in-memory SecureString used for this single request.
  $secureValue = New-Object System.Security.SecureString
  foreach ($character in $plainValue.ToCharArray()) { $secureValue.AppendChar($character) }
  $secureValue.MakeReadOnly()
  $plainValue = $null
  return $secureValue
}

function Safe-Value {
  param($Value)
  if ($null -eq $Value) { return $null }
  $text = [string]$Value
  if ($token) { $text = $text -replace [regex]::Escape($token), '[REDACTED]' }
  return ($text -replace '[\x00-\x1F\x7F]', ' ').Trim()
}

function Selector-Counts {
  param($Selectors)
  $result = [ordered]@{}
  foreach ($name in @('.arc_cont', '.TRS_Editor', '.article-content', '.article_content', 'article')) {
    $value = $Selectors.PSObject.Properties[$name].Value
    $result[$name] = if ($null -eq $value) { 0 } else { [int]$value.count }
  }
  return $result
}

function Safe-UpstreamAttempts {
  param($Attempts)
  return @($Attempts | ForEach-Object {
    [ordered]@{
      attempt_number = $_.attempt_number
      retry_eligible = $_.retry_eligible
      wait_before_next_ms = $_.wait_before_next_ms
      http_status = $_.http_status
      content_type = Safe-Value $_.content_type
      final_url = Safe-Value $_.final_url
      html_length = $_.html_length
      html_sha256 = $_.html_sha256
      page_title = Safe-Value $_.page_title
      selector_counts = Selector-Counts $_.selector_counts
      parser_result = $_.parser_result
      parser_error_code = Safe-Value $_.parser_error_code
    }
  })
}

function Safe-SkipAudit {
  param($SkipAudit)
  return @($SkipAudit | ForEach-Object {
    [ordered]@{
      original_rank = $_.original_rank
      original_index = $_.original_index
      official_url = Safe-Value $_.official_url
      failure_stage = Safe-Value $_.failure_stage
      failure_code = Safe-Value $_.failure_code
      skip_reason = Safe-Value $_.skip_reason
      attempts = Safe-UpstreamAttempts $_.attempts
    }
  })
}

function Safe-PreviewItem {
  param($Item)
  return [ordered]@{
    ordinal = $Item.ordinal
    original_rank = $Item.original_rank
    original_index = $Item.original_index
    title = Safe-Value $Item.title
    official_url = Safe-Value $Item.official_url
    document_no = Safe-Value $Item.document_no
    document_no_provenance = [ordered]@{
      source = Safe-Value $Item.document_no_provenance.source
      confidence = Safe-Value $Item.document_no_provenance.confidence
      evidence = Safe-Value $Item.document_no_provenance.evidence
    }
    publish_date = Safe-Value $Item.publish_date
    body_hash = Safe-Value $Item.body_hash
    body_length = $Item.body_length
    parser_version = Safe-Value $Item.parser_version
    parser_result = 'PASS'
    risk = [ordered]@{
      level = Safe-Value $Item.risk_assessment.risk_level
      score = $Item.risk_assessment.risk_score
      reasons = @($Item.risk_assessment.reasons | ForEach-Object { Safe-Value $_ })
    }
    metadata = [ordered]@{
      rule_version = Safe-Value $Item.metadata_suggestion.rule_version
      suggestion_hash = Safe-Value $Item.metadata_suggestion.suggestion_hash
      tax_categories = @($Item.metadata_suggestion.tax_categories | ForEach-Object { Safe-Value $_ })
    }
    relation = [ordered]@{
      state = Safe-Value $Item.relation_proposals.state
      proposed_count = $Item.relation_proposals.proposed_count
      rule_version = Safe-Value $Item.relation_proposals.rule_version
    }
    legal_status = $null # Preview is read-only and does not carry a legal-status mutation.
    upstream_attempts = Safe-UpstreamAttempts $Item.upstream_attempts
  }
}

function Safe-Failure {
  param($Failure)
  if ($null -eq $Failure) { return $null }
  return [ordered]@{
    failed_ordinal = $Failure.failed_ordinal
    failure_stage = Safe-Value $Failure.failure_stage
    failure_code = Safe-Value $Failure.failure_code
    successfully_processed_count = $Failure.successfully_processed_count
    official_url = Safe-Value $Failure.official_url
    http_status = $Failure.http_status
    content_type = Safe-Value $Failure.content_type
    final_url = Safe-Value $Failure.final_url
    html_character_length = $Failure.html_character_length
    html_utf8_byte_length = $Failure.html_utf8_byte_length
    html_sha256 = Safe-Value $Failure.html_sha256
    page_title = Safe-Value $Failure.page_title
    selector_counts = Selector-Counts $Failure.selectors
    parser_error_code = Safe-Value $Failure.parser_error_code
    upstream_attempts = Safe-UpstreamAttempts $Failure.upstream_attempts
  }
}

function Read-JsonResponse {
  param([Parameter(Mandatory = $true)]$Response)
  $stream = $Response.GetResponseStream()
  try {
    $reader = New-Object System.IO.StreamReader($stream)
    try { return ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose() }
  } finally { $stream.Dispose() }
}

function Write-SafePreviewSummary {
  param([Parameter(Mandatory = $true)]$HttpStatus, [Parameter(Mandatory = $true)]$Body)
  $preview = $Body.preview
  $items = @($preview.items | ForEach-Object { Safe-PreviewItem $_ })
  $skipAudit = Safe-SkipAudit $preview.skip_audit
  $fallbackItem = @($items | Where-Object { $_.original_rank -ne $_.ordinal } | Select-Object -Last 1)
  [ordered]@{
    http_status = [int]$HttpStatus
    mode = Safe-Value $Body.mode
    preview_result = if ($Body.mode -eq 'read_only_preview' -and $items.Count -eq 10) { 'PASS' } else { 'BLOCKED' }
    items_count = $items.Count
    original_rank_index = @($items | ForEach-Object { [ordered]@{ ordinal = $_.ordinal; original_rank = $_.original_rank; original_index = $_.original_index } })
    skip_audit = $skipAudit
    fallback_item = if ($fallbackItem.Count) { [ordered]@{ title = $fallbackItem[0].title; document_no = $fallbackItem[0].document_no; official_url = $fallbackItem[0].official_url } } else { $null }
    items = $items
    legal_status = 'not_modified_by_read_only_preview'
    ready_to_create_frozen_manifest = if ($Body.mode -eq 'read_only_preview' -and $items.Count -eq 10) { 'YES' } else { 'NO' }
    production_writes = if ($Body.PSObject.Properties.Name -contains 'production_writes') { $Body.production_writes } else { 0 }
  } | ConvertTo-Json -Depth 12
}

try {
  $secureToken = Read-GuiSecureString -Prompt '请输入管理员 Token（输入隐藏；可使用 Ctrl+V 粘贴）：'
  $tokenBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  $token = ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenBstr).Trim() -replace '[\x00-\x1F\x7F]', '')
  if ([string]::IsNullOrWhiteSpace($token)) { throw [System.InvalidOperationException]::new('token_empty_after_secure_input') }

  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $stage = 'single_read_only_preview_request'
  $response = Invoke-WebRequest -Method Get -Uri $previewUrl -Headers @{ Authorization = "Bearer $token"; 'Cache-Control' = 'no-store' } -UseBasicParsing -ErrorAction Stop
  $body = $response.Content | ConvertFrom-Json
  $stage = 'safe_summary'
  Write-SafePreviewSummary -HttpStatus $response.StatusCode -Body $body
  if ($body.mode -ne 'read_only_preview' -or @($body.preview.items).Count -ne 10) { exit 1 }
}
catch {
  $httpResponse = $_.Exception.Response
  if ($httpResponse) {
    $status = [int]$httpResponse.StatusCode
    $body = $null
    try { $body = Read-JsonResponse -Response $httpResponse } catch { $body = $null }
    [ordered]@{
      http_status = $status
      mode = $null
      preview_result = 'BLOCKED'
      failure = Safe-Failure $body.failure
      ready_to_create_frozen_manifest = 'NO'
      production_writes = if ($body -and $body.PSObject.Properties.Name -contains 'production_writes') { $body.production_writes } else { 0 }
    } | ConvertTo-Json -Depth 12
  } elseif ($_.Exception -is [System.InvalidOperationException] -or $_.Exception -is [System.OperationCanceledException]) {
    [ordered]@{ error = 'local_token_input_error'; preview_result = 'BLOCKED'; reason = Safe-Value $_.Exception.Message; production_writes = 0 } | ConvertTo-Json -Compress
  } else {
    # Never serialize exception text: it can contain request headers on some hosts.
    [ordered]@{ error = 'request_failed'; stage = $stage; exception_type = $_.Exception.GetType().Name; preview_result = 'BLOCKED'; production_writes = 0 } | ConvertTo-Json -Compress
  }
  exit 1
}
finally {
  if ($tokenBstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenBstr) }
  $token = $null
}
