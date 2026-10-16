$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectDirectory
# Local single-user pilot only: development mode disables sign-in and grants every role.
if (-not $env:AUTH_MODE) { $env:AUTH_MODE = 'development' }
Write-Host 'Starting Credit Insurance Request Management...'
if ($env:AUTH_MODE -eq 'development') { Write-Warning 'AUTH_MODE=development: authentication is disabled. Use only on an approved device, never on a shared server.' }
Write-Host 'Open http://localhost:4173 in a browser.'
node server.js
