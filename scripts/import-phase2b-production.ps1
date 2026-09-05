[CmdletBinding()]
param(
  [switch]$ReadOnlyConnectionTest
)

$ErrorActionPreference = 'Stop'
$token = $null
$tokenBstr = [IntPtr]::Zero
$exitCode = 1

function Read-GuiSecureString {
  param([Parameter(Mandatory = $true)][string]$Prompt)

  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $form = New-Object System.Windows.Forms.Form
  $form.Text = '生产导入凭据'
  $form.StartPosition = 'CenterScreen'
  $form.Size = New-Object System.Drawing.Size(510, 190)
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
  $input.Size = New-Object System.Drawing.Size(455, 26)
  $input.UseSystemPasswordChar = $true
  $input.ShortcutsEnabled = $true
  $form.Controls.Add($input)

  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = '继续'
  $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $ok.Location = New-Object System.Drawing.Point(265, 95)
  $form.Controls.Add($ok)

  $cancel = New-Object System.Windows.Forms.Button
  $cancel.Text = '取消'
  $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $cancel.Location = New-Object System.Drawing.Point(385, 95)
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
    throw '管理员 Token 不能为空。'
  }
  $secureValue = New-Object System.Security.SecureString
  foreach ($character in $plainValue.ToCharArray()) {
    $secureValue.AppendChar($character)
  }
  $secureValue.MakeReadOnly()
  $plainValue = $null
  return $secureValue
}

function Test-TokenForHttpHeader {
  param([Parameter(Mandatory = $true)][string]$Value)

  $metadata = [ordered]@{
    token_present = -not [string]::IsNullOrEmpty($Value)
    token_length = $Value.Length
    has_newline = $Value -match '[\r\n]'
    has_leading_or_trailing_whitespace = $Value -ne $Value.Trim()
    contains_control_character = $Value -match '[\x00-\x1F\x7F]'
    type = $Value.GetType().FullName
  }
  if (-not $metadata.token_present -or $metadata.has_newline -or $metadata.has_leading_or_trailing_whitespace -or $metadata.contains_control_character -or $Value -notmatch '^[\x21-\x7E]+$') {
    throw ('管理员 Token 不适合作为 HTTP Authorization Header。安全摘要：' + ($metadata | ConvertTo-Json -Compress))
  }
  return $metadata
}

try {
  $secureToken = Read-GuiSecureString -Prompt '请输入管理员 Token（输入隐藏；可使用 Ctrl+V 粘贴）：'
  $tokenBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenBstr)
  $tokenMetadata = Test-TokenForHttpHeader -Value $token

  # Scope the plaintext value to this PowerShell process and the one Node child
  # process only. The Node script clears its own reference on exit.
  $env:NETLIFY_TAXKB_ADMIN_TOKEN = $token
  if ($ReadOnlyConnectionTest) {
    $preflightScript = @'
const token = String(process.env.NETLIFY_TAXKB_ADMIN_TOKEN || '');
const metadata = {
  token_present: token.length > 0,
  token_length: token.length,
  has_newline: /[\r\n]/.test(token),
  has_leading_or_trailing_whitespace: token !== token.trim(),
  contains_control_character: /[\x00-\x1F\x7F]/.test(token),
  type: typeof token
};
const valid = metadata.token_present && !metadata.has_newline && !metadata.has_leading_or_trailing_whitespace && !metadata.contains_control_character && /^[\x21-\x7E]+$/.test(token);
if (!valid) {
  console.log(JSON.stringify({ phase: 'read_only_connection', token: metadata, http_status: null, authenticated: false, error: 'invalid_local_token_header' }));
  process.exitCode = 1;
} else {
  try {
    const response = await fetch('https://xielujin-tax-knowledge-base.netlify.app/api/admin/evidence/status', {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, 'cache-control': 'no-store' }
    });
    console.log(JSON.stringify({ phase: 'read_only_connection', token: metadata, http_status: response.status, authenticated: response.status === 200 }));
    process.exitCode = response.status === 200 ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify({ phase: 'read_only_connection', token: metadata, http_status: null, authenticated: false, error_name: error?.name || 'Error', error_message: String(error?.message || 'request_failed').slice(0, 240), cause_code: error?.cause?.code || null }));
    process.exitCode = 1;
  }
}
'@
    & node -e $preflightScript
  } else {
    & node (Join-Path $PSScriptRoot 'import-phase2b-production.mjs') --from-env
  }
  $exitCode = $LASTEXITCODE
}
finally {
  Remove-Item Env:NETLIFY_TAXKB_ADMIN_TOKEN -ErrorAction SilentlyContinue
  if ($tokenBstr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenBstr)
  }
  $token = $null
}

exit $exitCode
