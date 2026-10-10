# One-time setup on a new machine: creates the private development PostgreSQL cluster in
# .localdb/ (port 5433), the serveos_dev and serveos_test databases, and a .env file with
# freshly generated secrets. It never touches an existing cluster or an existing .env.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$local = Join-Path $root '.localdb'
$data = Join-Path $local 'pgdata'
$envFile = Join-Path $root '.env'

$bin = $env:PG_BIN
if (-not $bin) {
  $bin = Get-ChildItem 'C:\Program Files\PostgreSQL' -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1 | ForEach-Object { Join-Path $_.FullName 'bin' }
}
if (-not $bin -or -not (Test-Path (Join-Path $bin 'initdb.exe'))) {
  throw 'PostgreSQL binaries not found. Install PostgreSQL 15 or newer, or set PG_BIN to its bin folder.'
}
if (Test-Path (Join-Path $data 'PG_VERSION')) { throw "A database cluster already exists at $data. Nothing was changed. Use 'pnpm db:start'." }
if (Test-Path $envFile) { throw ".env already exists. Nothing was changed. Move it away first if you really want a fresh setup." }

function New-Secret([int]$bytes) {
  $buffer = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buffer)
  return ([Convert]::ToBase64String($buffer)) -replace '[+/=]', 'x'
}

New-Item -ItemType Directory -Force $local | Out-Null
$password = New-Secret 24
$pwFile = Join-Path $local 'pwfile'
[System.IO.File]::WriteAllText($pwFile, $password)

& (Join-Path $bin 'initdb.exe') -D $data -U serveos --auth=scram-sha-256 --pwfile=$pwFile -E UTF8 --locale=C | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'initdb failed.' }

& (Join-Path $PSScriptRoot 'db-start.ps1')

$env:PGPASSWORD = $password
foreach ($db in 'serveos_dev', 'serveos_test') {
  & (Join-Path $bin 'psql.exe') -h localhost -p 5433 -U serveos -d postgres -q -c "create database $db;"
  if ($LASTEXITCODE -ne 0) { throw "Could not create database $db." }
}

$url = "postgresql://serveos:$password@localhost:5433"
$content = (Get-Content (Join-Path $root '.env.example') -Raw)
$content = $content -replace '(?m)^DATABASE_URL=.*$', "DATABASE_URL=$url/serveos_dev?schema=public"
$content = $content -replace '(?m)^DIRECT_URL=.*$', "DIRECT_URL=$url/serveos_dev?schema=public"
$content = $content -replace '(?m)^TEST_DATABASE_URL=.*$', "TEST_DATABASE_URL=$url/serveos_test?schema=public"
$content = $content -replace '(?m)^JWT_ACCESS_SECRET=.*$', "JWT_ACCESS_SECRET=$(New-Secret 48)"
$content = $content -replace '(?m)^JWT_REFRESH_SECRET=.*$', "JWT_REFRESH_SECRET=$(New-Secret 48)"
$content = $content -replace '(?m)^PAYMENT_WEBHOOK_SECRET=.*$', "PAYMENT_WEBHOOK_SECRET=$(New-Secret 48)"
$content = $content -replace '(?m)^SEED_DEMO_PASSWORD=.*$', "SEED_DEMO_PASSWORD=$(New-Secret 12)"
[System.IO.File]::WriteAllText($envFile, $content)

Write-Host ''
Write-Host 'Done. Created the development database (port 5433) and .env with new secrets.'
Write-Host 'Next:  pnpm db:deploy   then   pnpm db:seed   then   pnpm db:seed:orders'
Write-Host 'The demo password for every seeded user is SEED_DEMO_PASSWORD in .env.'
