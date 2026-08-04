$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectDirectory
Write-Host 'Starting Credit Insurance Request Management...'
Write-Host 'Open http://localhost:4173 in a browser.'
node server.js
