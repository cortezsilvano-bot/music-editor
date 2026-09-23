# Starts the Song Studio stem separation service on port 8787.
# The editor bundle is hardcoded to http://localhost:8787/api/studio/separate.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$port = if ($env:PORT) { $env:PORT } else { 8787 }
Write-Host "Song Studio separation -> http://localhost:$port" -ForegroundColor Cyan
python -m uvicorn app:app --host 127.0.0.1 --port $port
