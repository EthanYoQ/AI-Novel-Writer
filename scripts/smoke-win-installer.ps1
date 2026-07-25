param(
  [string]$InstallerPath,
  [string]$PreviousInstallerPath,
  [int]$ObservationSeconds = 30
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($InstallerPath)) {
  $packageJson = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
  $InstallerPath = Join-Path $root ("release\{0}\ai-novel-writer-setup-{0}.exe" -f [string]$packageJson.version)
}

$resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
$smokeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('ai-novel-installer-smoke-' + [guid]::NewGuid().ToString('N'))
$installRoot = Join-Path $smokeRoot 'installed-app'
$velaHome = Join-Path $smokeRoot 'vela-home'
$globalConfig = Join-Path $velaHome 'config.json'
$uninstaller = Join-Path $installRoot 'Uninstall AI小说作家.exe'

function Install-Silently([string]$Path) {
  $process = Start-Process -FilePath $Path -ArgumentList @('/S', "/D=$installRoot") -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Installer failed with code $($process.ExitCode): $Path" }
}

try {
  New-Item -ItemType Directory -Path $velaHome -Force | Out-Null
  @{ theme = 'light'; locale = 'zh-CN'; proxy = @{ enabled = $false; type = 'http'; host = ''; port = 7890 } } |
    ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $globalConfig -Encoding utf8

  if (-not [string]::IsNullOrWhiteSpace($PreviousInstallerPath)) {
    Install-Silently (Resolve-Path -LiteralPath $PreviousInstallerPath).Path
  }
  Install-Silently $resolvedInstaller

  $exePath = Join-Path $installRoot 'AI小说作家.exe'
  if (-not (Test-Path -LiteralPath $exePath)) { throw "Installed application is missing: $exePath" }
  & (Join-Path $PSScriptRoot 'smoke-win-app.ps1') -ExePath $exePath -ObservationSeconds $ObservationSeconds -VelaHome $velaHome

  $config = Get-Content -LiteralPath $globalConfig -Raw | ConvertFrom-Json
  if ($config.theme -ne 'light' -or $config.locale -ne 'zh-CN' -or $config.proxy.port -ne 7890) {
    throw 'Installer smoke changed existing global configuration instead of preserving it.'
  }
  Write-Host "Windows installer smoke test passed: $resolvedInstaller"
}
finally {
  if (Test-Path -LiteralPath $uninstaller) {
    $uninstall = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
    if ($uninstall.ExitCode -ne 0) { Write-Warning "Installer smoke uninstaller exited with code $($uninstall.ExitCode)" }
  }
  if (Test-Path -LiteralPath $smokeRoot) {
    Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
