$ErrorActionPreference = 'Stop'

$workspaceRoot = Split-Path -Parent $PSScriptRoot
$nodePath = 'C:\Users\xielvjin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'

Start-Process -FilePath $nodePath -ArgumentList 'src\server.js' -WorkingDirectory $workspaceRoot -WindowStyle Hidden
