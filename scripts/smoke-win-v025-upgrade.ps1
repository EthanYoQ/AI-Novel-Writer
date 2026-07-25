param(
  [string]$PreviousInstallerPath = $env:AI_NOVEL_PREVIOUS_INSTALLER,
  [int]$ObservationSeconds = 30
)

$ErrorActionPreference = 'Stop'
$expectedV025InstallerSha256 = 'AE9C88997A7DF3A48A8BEECCB0AB624BF947358CBBF702C19E70EC8460B9DFE7'

function Get-Sha256([string]$Path) {
  $hasher = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    return -join ($hasher.ComputeHash($stream) | ForEach-Object { $_.ToString('X2') })
  }
  finally {
    $stream.Dispose()
    $hasher.Dispose()
  }
}

if ([string]::IsNullOrWhiteSpace($PreviousInstallerPath)) {
  throw 'Set AI_NOVEL_PREVIOUS_INSTALLER to the official v0.2.5 installer before running the v0.2.5 upgrade smoke test.'
}

$installer = (Resolve-Path -LiteralPath $PreviousInstallerPath).Path
if ((Get-Sha256 $installer) -ne $expectedV025InstallerSha256) {
  throw 'The previous installer is not the verified official v0.2.5 installer asset.'
}
& (Join-Path $PSScriptRoot 'smoke-win-installer.ps1') -PreviousInstallerPath $installer -ObservationSeconds $ObservationSeconds
