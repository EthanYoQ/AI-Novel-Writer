param(
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$packageJsonPath = Join-Path $root "package.json"
$packageJson = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
$version = [string]$packageJson.version

function Get-Sha256Hash {
  param([Parameter(Mandatory = $true)][string]$Path)
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
      $bytes = $sha256.ComputeHash($stream)
      return (($bytes | ForEach-Object { $_.ToString("x2") }) -join "").ToUpperInvariant()
    }
    finally {
      $sha256.Dispose()
    }
  }
  finally {
    $stream.Dispose()
  }
}

Push-Location $root
try {
  if (-not $SkipBuild) {
    npm run build:win-dir
  }

  $releaseDir = Join-Path $root "release\$version"
  $sourceDir = Join-Path $releaseDir "win-unpacked"
  $packageDir = Join-Path $releaseDir "AI小说作家"
  $zipPath = Join-Path $releaseDir "AI小说作家-$version-windows-x64.zip"
  $exePath = Join-Path $sourceDir "AI小说作家.exe"

  if (-not (Test-Path -LiteralPath $sourceDir)) {
    throw "缺少打包目录：$sourceDir"
  }

  if (-not (Test-Path -LiteralPath $exePath)) {
    throw "缺少启动器：$exePath"
  }

  if (Test-Path -LiteralPath $packageDir) {
    Remove-Item -LiteralPath $packageDir -Recurse -Force
  }
  if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
  }

  New-Item -ItemType Directory -Path $packageDir | Out-Null
  Get-ChildItem -LiteralPath $sourceDir -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $packageDir -Recurse -Force
  }

  Compress-Archive -LiteralPath $packageDir -DestinationPath $zipPath -CompressionLevel Optimal

  $hash = Get-Sha256Hash -Path $zipPath
  $sizeMb = [math]::Round((Get-Item -LiteralPath $zipPath).Length / 1MB, 2)

  Write-Host "Windows zip package created:"
  Write-Host "  $zipPath"
  Write-Host "  Size: $sizeMb MB"
  Write-Host "  SHA256: $hash"
  Write-Host "  Launcher: AI小说作家\AI小说作家.exe"
}
finally {
  Pop-Location
}
