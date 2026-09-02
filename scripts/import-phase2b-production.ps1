[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$token = $null
$tokenBstr = [IntPtr]::Zero
$exitCode = 1

try {
  # Read-Host -AsSecureString supports pasting in Windows PowerShell without
  # echoing the value or adding it to PSReadLine command history.
  $secureToken = Read-Host -Prompt '请输入管理员 Token（输入不显示）' -AsSecureString
  $tokenBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenBstr)
  if ([string]::IsNullOrWhiteSpace($token)) {
    throw '管理员 Token 不能为空。'
  }

  # Scope the plaintext value to this PowerShell process and the one Node child
  # process only. The Node script clears its own reference on exit.
  $env:NETLIFY_TAXKB_ADMIN_TOKEN = $token
  & node (Join-Path $PSScriptRoot 'import-phase2b-production.mjs') --from-env
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
