param(
  [Parameter(Mandatory = $true)]
  [string]$BackupFile,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z][A-Za-z0-9_]{0,62}$')]
  [string]$TargetDatabaseName,

  [switch]$ConfirmRestore
)

$ErrorActionPreference = "Stop"
if (-not $ConfirmRestore) {
  throw "Restore is blocked by default. Re-run with -ConfirmRestore after checking the exact target database."
}
if ($TargetDatabaseName -in @("postgres", "template0", "template1")) {
  throw "Refusing to restore into a PostgreSQL system database."
}

$resolvedBackup = [System.IO.Path]::GetFullPath($BackupFile)
if (-not (Test-Path -LiteralPath $resolvedBackup -PathType Leaf)) {
  throw "Backup file does not exist: $resolvedBackup"
}
if ([System.IO.Path]::GetExtension($resolvedBackup) -ne ".dump") {
  throw "Backup file must use the .dump extension."
}
$checksumFile = "$resolvedBackup.sha256"
if (-not (Test-Path -LiteralPath $checksumFile -PathType Leaf)) {
  throw "Backup checksum is required before restore: $checksumFile"
}
$expectedChecksum = (Get-Content -LiteralPath $checksumFile -Encoding ascii -Raw).Trim().ToLowerInvariant()
if ($expectedChecksum -notmatch '^[0-9a-f]{64}$') {
  throw "Backup checksum file is invalid: $checksumFile"
}
$actualChecksum = (Get-FileHash -LiteralPath $resolvedBackup -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualChecksum -ne $expectedChecksum) {
  throw "Backup checksum mismatch; restore refused."
}

$containerId = (docker compose ps -q postgres).Trim()
if (-not $containerId) {
  throw "The docker compose postgres service is not running."
}

$databaseExists = (docker compose exec -T postgres psql -U tongzhouxing -d postgres -Atqc "select 1 from pg_database where datname = '$TargetDatabaseName'").Trim()
if ($databaseExists -ne "1") {
  throw "Target database does not exist: $TargetDatabaseName. Create an empty database explicitly before restoring."
}
$tableCountText = (docker compose exec -T postgres psql -U tongzhouxing -d $TargetDatabaseName -Atqc "select count(*) from pg_tables where schemaname = 'public'").Trim()
$tableCount = [int]$tableCountText
if ($tableCount -ne 0) {
  throw "Refusing to overwrite target database '$TargetDatabaseName': it already contains $tableCount public table(s)."
}

$containerFile = "/tmp/tzx-restore-$([Guid]::NewGuid().ToString('N')).dump"
try {
  docker cp $resolvedBackup "${containerId}:$containerFile"
  if ($LASTEXITCODE -ne 0) { throw "docker cp failed with exit code $LASTEXITCODE" }
  docker compose exec -T postgres pg_restore -U tongzhouxing -d $TargetDatabaseName --exit-on-error --no-owner --no-privileges $containerFile
  if ($LASTEXITCODE -ne 0) { throw "pg_restore failed with exit code $LASTEXITCODE" }
} finally {
  docker compose exec -T postgres rm -f $containerFile | Out-Null
}

Write-Output "Restore completed into empty database: $TargetDatabaseName"
