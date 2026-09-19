[CmdletBinding()]
param()

# This wrapper deliberately has no URL, endpoint, rank, or query parameters.
# It creates one server-owned Phase 3C asynchronous Preview Job, then polls only
# that returned Job's fixed status endpoint. It never creates a manifest or Apply.
$ErrorActionPreference = 'Stop'
$createJobUrl = 'https://xielujin-tax-knowledge-base.netlify.app/api/admin/evidence/phase3c1/import-preview-jobs'
$jobStatusUrlPrefix = 'https://xielujin-tax-knowledge-base.netlify.app/api/admin/evidence/phase3c1/import-preview-jobs'
$pollIntervalMs = 5000
$pollTimeoutMs = 900000
$token = $null
$tokenBstr = [IntPtr]::Zero
$stage = 'token_input'

function Read-GuiSecureString {
  param([Parameter(Mandatory = $true)][string]$Prompt)

  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'Phase 3C Production Preview Job'
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
  $ok.Text = '创建只读 Preview Job'
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
  $result = $form.ShowDialog()
  $plainValue = $tokenTextBox.Text
  $tokenTextBox.Clear()
  $form.Dispose()
  if ($result -ne [System.Windows.Forms.DialogResult]::OK) { throw [System.OperationCanceledException]::new('token_input_cancelled') }
  if ([string]::IsNullOrWhiteSpace($plainValue)) { throw [System.InvalidOperationException]::new('token_empty_after_secure_input') }

  # Avoid ConvertTo-SecureString: this Windows PowerShell host can fail to
  # auto-load Microsoft.PowerShell.Security. The plaintext exists only long
  # enough to build the in-memory SecureString used for this request sequence.
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

function Read-JsonResponse {
  param([Parameter(Mandatory = $true)]$Response)
  $stream = $Response.GetResponseStream()
  try {
    $reader = New-Object System.IO.StreamReader($stream)
    try { return ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose() }
  } finally { $stream.Dispose() }
}

function Preview-ResultForStatus {
  param($Status)
  if ($Status -eq 'passed') { return 'PASS' }
  if ($Status -in @('blocked', 'failed')) { return 'BLOCKED' }
  return 'IN_PROGRESS'
}

function Safe-JobSummary {
  param($Job)
  if ($null -eq $Job) { return $null }
  return [ordered]@{
    job_id = Safe-Value $Job.job_id
    mode = Safe-Value $Job.mode
    status = Safe-Value $Job.status
    completed_count = $Job.completed_count
    total_count = $Job.total_count
    current_ordinal = $Job.current_ordinal
    preview_result = Preview-ResultForStatus $Job.status
    failure_code = Safe-Value $Job.failure_code
    ready_to_create_frozen_manifest = Safe-Value $Job.ready_to_create_frozen_manifest
    preview_job_audit_writes = $Job.preview_job_audit_writes
    business_production_writes = if ($null -eq $Job.business_production_writes) { 0 } else { $Job.business_production_writes }
  }
}

function Write-SafeJson {
  param([Parameter(Mandatory = $true)]$Value)
  $Value | ConvertTo-Json -Depth 8
}

function Write-CreateSummary {
  param([Parameter(Mandatory = $true)][int]$HttpStatus, $Body)
  $dispatch = if ($Body) { Safe-Value $Body.dispatch } else { $null }
  $dispatchCode = if ($HttpStatus -eq 401) { 'ADMIN_UNAUTHORIZED' } elseif ($dispatch -eq 'not_scheduled') { 'DISPATCH_NOT_SCHEDULED' } elseif ($HttpStatus -lt 200 -or $HttpStatus -ge 300) { 'CREATE_JOB_HTTP_ERROR' } else { $null }
  Write-SafeJson ([ordered]@{
    event = 'create_job'
    http_status = $HttpStatus
    mode = if ($Body -and $Body.job) { Safe-Value $Body.job.mode } else { 'production_preview' }
    job_id = if ($Body -and $Body.job) { Safe-Value $Body.job.job_id } else { $null }
    job_status = if ($Body -and $Body.job) { Safe-Value $Body.job.status } else { $null }
    dispatch_status = $dispatch
    dispatch_error_code = $dispatchCode
    preview_job_audit_writes = if ($Body -and $Body.job) { $Body.job.preview_job_audit_writes } else { 0 }
    business_production_writes = if ($Body -and $Body.PSObject.Properties.Name -contains 'business_production_writes') { $Body.business_production_writes } elseif ($Body -and $Body.job) { $Body.job.business_production_writes } else { 0 }
  })
}

function Write-FinalSummary {
  param([Parameter(Mandatory = $true)]$Job, [string]$TerminalReason = $null)
  $summary = Safe-JobSummary $Job
  $summary['event'] = 'job_status'
  $summary['polling_terminal_reason'] = $TerminalReason
  Write-SafeJson $summary
}

function Get-JobStatus {
  param([Parameter(Mandatory = $true)][string]$JobId)
  $statusUrl = "$jobStatusUrlPrefix/$([uri]::EscapeDataString($JobId))"
  try {
    $response = Invoke-WebRequest -Method Get -Uri $statusUrl -Headers @{ Authorization = "Bearer $token"; 'Cache-Control' = 'no-store' } -UseBasicParsing -ErrorAction Stop
    return [ordered]@{ http_status = [int]$response.StatusCode; body = ($response.Content | ConvertFrom-Json) }
  } catch {
    $httpResponse = $_.Exception.Response
    if ($httpResponse) {
      $body = $null
      try { $body = Read-JsonResponse -Response $httpResponse } catch { $body = $null }
      return [ordered]@{ http_status = [int]$httpResponse.StatusCode; body = $body }
    }
    throw
  }
}

try {
  $secureToken = Read-GuiSecureString -Prompt '请输入管理员 Token（输入隐藏；可使用 Ctrl+V 粘贴）：'
  $tokenBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  $token = ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenBstr).Trim() -replace '[\x00-\x1F\x7F]', '')
  if ([string]::IsNullOrWhiteSpace($token)) { throw [System.InvalidOperationException]::new('token_empty_after_secure_input') }

  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $stage = 'create_preview_job'
  $createResponse = Invoke-WebRequest -Method Post -Uri $createJobUrl -Headers @{ Authorization = "Bearer $token"; 'Cache-Control' = 'no-store' } -ContentType 'application/json' -Body '{}' -UseBasicParsing -ErrorAction Stop
  $createBody = $createResponse.Content | ConvertFrom-Json
  Write-CreateSummary -HttpStatus $createResponse.StatusCode -Body $createBody

  $jobId = if ($createBody.job) { [string]$createBody.job.job_id } else { '' }
  if (($createResponse.StatusCode -ne 202 -and $createResponse.StatusCode -ne 200) -or [string]::IsNullOrWhiteSpace($jobId)) { exit 1 }

  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  while ($true) {
    $stage = 'poll_preview_job_status'
    $statusResponse = Get-JobStatus -JobId $jobId
    if ($statusResponse.http_status -ne 200 -or -not $statusResponse.body.job) {
      Write-SafeJson ([ordered]@{ event = 'job_status'; http_status = $statusResponse.http_status; job_id = Safe-Value $jobId; preview_result = 'BLOCKED'; failure_code = 'JOB_STATUS_REQUEST_FAILED'; ready_to_create_frozen_manifest = 'NO'; business_production_writes = 0 })
      exit 1
    }

    $job = $statusResponse.body.job
    if ($job.status -in @('passed', 'blocked', 'failed')) {
      Write-FinalSummary -Job $job -TerminalReason 'terminal_status'
      if ($job.status -ne 'passed') { exit 1 }
      break
    }

    if (($stopwatch.ElapsedMilliseconds + $pollIntervalMs) -gt $pollTimeoutMs) {
      Write-FinalSummary -Job $job -TerminalReason 'POLLING_TIMEOUT'
      exit 1
    }
    Start-Sleep -Milliseconds $pollIntervalMs
  }
} catch {
  $httpResponse = $_.Exception.Response
  if ($httpResponse) {
    $status = [int]$httpResponse.StatusCode
    $body = $null
    try { $body = Read-JsonResponse -Response $httpResponse } catch { $body = $null }
    Write-CreateSummary -HttpStatus $status -Body $body
  } elseif ($_.Exception -is [System.InvalidOperationException] -or $_.Exception -is [System.OperationCanceledException]) {
    Write-SafeJson ([ordered]@{ error = 'local_token_input_error'; preview_result = 'BLOCKED'; reason = Safe-Value $_.Exception.Message; business_production_writes = 0 })
  } else {
    # Never serialize exception text: it can contain request headers on some hosts.
    Write-SafeJson ([ordered]@{ error = 'request_failed'; stage = $stage; exception_type = $_.Exception.GetType().Name; preview_result = 'BLOCKED'; business_production_writes = 0 })
  }
  exit 1
} finally {
  if ($tokenBstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenBstr) }
  $token = $null
}
