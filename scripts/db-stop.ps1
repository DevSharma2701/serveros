# Stops the private development PostgreSQL cluster stored in .localdb/.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$data = Join-Path $root '.localdb\pgdata'

$bin = $env:PG_BIN
if (-not $bin) {
  $bin = Get-ChildItem 'C:\Program Files\PostgreSQL' -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1 | ForEach-Object { Join-Path $_.FullName 'bin' }
}
& (Join-Path $bin 'pg_ctl.exe') -D $data -m fast stop
