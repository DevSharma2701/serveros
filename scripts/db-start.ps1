# Starts the private development PostgreSQL cluster stored in .localdb/ on port 5433.
# It is separate from any PostgreSQL service already installed on this machine.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$data = Join-Path $root '.localdb\pgdata'
$log = Join-Path $root '.localdb\postgres.log'

$bin = $env:PG_BIN
if (-not $bin) {
  $bin = Get-ChildItem 'C:\Program Files\PostgreSQL' -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1 | ForEach-Object { Join-Path $_.FullName 'bin' }
}
if (-not $bin -or -not (Test-Path (Join-Path $bin 'pg_ctl.exe'))) {
  throw 'PostgreSQL binaries not found. Install PostgreSQL or set PG_BIN to its bin folder.'
}
if (-not (Test-Path (Join-Path $data 'PG_VERSION'))) {
  throw "No database cluster at $data. See docs/setup.md to create one."
}

& (Join-Path $bin 'pg_isready.exe') -h localhost -p 5433 | Out-Null
if ($LASTEXITCODE -eq 0) { Write-Host 'ServeOS dev database is already running on port 5433.'; exit 0 }

# Start-Process detaches the server so this script returns immediately.
Start-Process -FilePath (Join-Path $bin 'pg_ctl.exe') -WindowStyle Hidden -ArgumentList @(
  '-D', "`"$data`"", '-l', "`"$log`"", '-o', '"-p 5433 -c listen_addresses=localhost"', 'start'
)
foreach ($i in 1..30) {
  Start-Sleep -Milliseconds 500
  & (Join-Path $bin 'pg_isready.exe') -h localhost -p 5433 | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Host 'ServeOS dev database started on port 5433.'; exit 0 }
}
throw "Database did not start. Check $log"
