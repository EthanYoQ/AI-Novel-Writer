param(
  [string]$PreviousInstallerPath = $env:AI_NOVEL_PREVIOUS_INSTALLER,
  [string]$PreviousPortableZipPath = $env:AI_NOVEL_PREVIOUS_PORTABLE_ZIP,
  [int]$ObservationSeconds = 30
)

$ErrorActionPreference = 'Stop'
$expectedV025InstallerSha256 = 'AE9C88997A7DF3A48A8BEECCB0AB624BF947358CBBF702C19E70EC8460B9DFE7'
$expectedV025PortableSha256 = '22B38B7337A456882BF130CCB898F17616FFFB85D6C8B8B3D0EE431409F18531'

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

if (
  [string]::IsNullOrWhiteSpace($PreviousInstallerPath) -and
  [string]::IsNullOrWhiteSpace($PreviousPortableZipPath)
) {
  throw 'Set AI_NOVEL_PREVIOUS_PORTABLE_ZIP (preferred) or AI_NOVEL_PREVIOUS_INSTALLER to an official v0.2.5 asset.'
}

$smokeParameters = @{
  ObservationSeconds = $ObservationSeconds
  RequireCompleteV025Fixture = $true
}
if (-not [string]::IsNullOrWhiteSpace($PreviousPortableZipPath)) {
  $portableZip = (Resolve-Path -LiteralPath $PreviousPortableZipPath).Path
  if ((Get-Sha256 $portableZip) -ne $expectedV025PortableSha256) {
    throw 'The previous portable ZIP is not the verified official v0.2.5 asset.'
  }
  $smokeParameters.PreviousPortableZipPath = $portableZip
}
else {
  $installer = (Resolve-Path -LiteralPath $PreviousInstallerPath).Path
  if ((Get-Sha256 $installer) -ne $expectedV025InstallerSha256) {
    throw 'The previous installer is not the verified official v0.2.5 installer asset.'
  }
  $smokeParameters.PreviousInstallerPath = $installer
}
& (Join-Path $PSScriptRoot 'smoke-win-installer.ps1') @smokeParameters
