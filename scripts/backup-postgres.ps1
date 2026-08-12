param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z][A-Za-z0-9_]{0,62}$')]
  [string]$DatabaseName,

  [string]$OutputDirectory = ".\backups"
)

$ErrorActionPreference = "Stop"
$workspaceRoot = Split-Path -Parent $PSScriptRoot
$resolvedOutput = [System.IO.Path]::GetFullPath((Join-Path $workspaceRoot $OutputDirectory))
if (-not (Test-Path -LiteralPath $resolvedOutput)) {
  New-Item -ItemType Directory -Path $resolvedOutput | Out-Null
}
if (-not (Test-Path -LiteralPath $resolvedOutput -PathType Container)) {
  throw "Backup output is not a directory: $resolvedOutput"
}

$containerId = (docker compose ps -q postgres).Trim()
if (-not $containerId) {
  throw "The docker compose postgres service is not running."
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$fileName = "tongzhouxing-$DatabaseName-$timestamp.dump"
$hostFile = Join-Path $resolvedOutput $fileName
$containerFile = "/tmp/$fileName"
if (Test-Path -LiteralPath $hostFile) {
  throw "Refusing to overwrite an existing backup: $hostFile"
}

try {
  docker compose exec -T postgres pg_dump -U tongzhouxing -d $DatabaseName --format=custom --no-owner --no-privileges --file=$containerFile
  if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE" }
  docker cp "${containerId}:$containerFile" $hostFile
  if ($LASTEXITCODE -ne 0) { throw "docker cp failed with exit code $LASTEXITCODE" }
} finally {
  docker compose exec -T postgres rm -f $containerFile | Out-Null
}

$backup = Get-Item -LiteralPath $hostFile
if ($backup.Length -le 0) { throw "Backup file is empty: $hostFile" }
Write-Output $backup.FullName
