import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { expect, it } from 'vitest'

const windowsIt = process.platform === 'win32' ? it : it.skip
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'"
windowsIt('qualification profile refuses overlapping roots and validates canonical completion without fallback', () => {
  const cache = resolve('.runtime/.cache'); mkdirSync(cache, { recursive: true })
  const root = mkdtempSync(join(cache, 'qualification-profile-test-'))
  const script = join(root, 'probe.ps1')
  writeFileSync(script, `
$ErrorActionPreference = 'Stop'
function Import-TestFunction($file, $names) {
  $tokens = $null; $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
  if ($errors.Count) { throw ($errors | Out-String) }
  foreach ($name in $names) {
    $node = $ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name}, $true)
    if (!$node) { throw 'Missing test function' }
    Set-Item -Path ('function:script:' + $name) -Value ([scriptblock]::Create($node.Body.Extent.Text.TrimStart('{').TrimEnd('}')))
  }
}
Import-TestFunction ${quote(resolve('scripts/smoke-win-app.ps1'))} @('New-AiNovelQualificationProfile')
Import-TestFunction ${quote(resolve('scripts/windows-in-app-update-e2e.ps1'))} @('Get-E2eCanonicalGeneration','Read-E2eRequiredJsonFile','Assert-E2eCondition')
$root = ${quote(root)}
$p = New-AiNovelQualificationProfile -Root $root
if ($p.canonical -eq $p.legacy -or $p.userData -eq $p.canonical) { throw 'roots aliased' }
foreach ($legacy in @($p.canonical, (Join-Path $p.canonical 'nested'), $root)) {
  $rejected = $false
  try { New-AiNovelQualificationProfile -Root $root -LegacySource $legacy | Out-Null } catch { $rejected = $true }
  if (!$rejected) { throw 'overlap accepted' }
}
$missing = $false
try { Get-E2eCanonicalGeneration -CanonicalHome $p.canonical | Out-Null } catch { $missing = $true }
if (!$missing) { throw 'missing receipt accepted' }
$generation = '12345678-1234-1234-1234-123456789abc'
New-Item -ItemType Directory -Path (Join-Path $p.canonical '.migration'), (Join-Path (Join-Path $p.canonical 'generations') $generation) -Force | Out-Null
$receiptPath = Join-Path $p.canonical '.migration/receipt.json'
@{version=1;generation=$generation;completed=$true;preservedUnknownCount=0;requiredObjects=@()} | ConvertTo-Json | Set-Content -LiteralPath $receiptPath
$actual = Get-E2eCanonicalGeneration -CanonicalHome $p.canonical
if ($actual -ne (Join-Path (Join-Path $p.canonical 'generations') $generation)) { throw 'wrong generation' }
foreach ($bad in @('../escape', '', '12345678-1234-1234-1234-123456789abc/other')) {
  @{version=1;generation=$bad;completed=$true;preservedUnknownCount=0;requiredObjects=@()} | ConvertTo-Json | Set-Content -LiteralPath $receiptPath
  $rejected = $false
  try { Get-E2eCanonicalGeneration -CanonicalHome $p.canonical | Out-Null } catch { $rejected = $true }
  if (!$rejected) { throw 'invalid generation accepted' }
}
Write-Output 'PROFILE_CONTRACT_OK'
`)
  expect(execFileSync('pwsh', ['-NoProfile', '-File', script], { encoding: 'utf8' })).toContain('PROFILE_CONTRACT_OK')
})
it('every packaged Electron probe binds explicit profile roots and restores Windows environment', () => {
  const win = readFileSync(resolve('scripts/smoke-win-installer.ps1'), 'utf8')
  for (const name of ['Vector', 'OfficialHomepage', 'Skin']) {
    const section = win.split('function Invoke-AiNovelPackaged' + name + 'Smoke')[1].split('\nfunction ')[0]
    expect(section).toContain('New-AiNovelQualificationProfile')
    expect(section).toContain('--user-data-dir=')
    expect(section).toContain('$env:AI_NOVEL_APP_DATA_HOME = $previousCanonicalHome')
    expect(section).toContain('$env:AI_NOVEL_LEGACY_SOURCE_HOME = $previousLegacySourceHome')
  }
  const mac = readFileSync(resolve('scripts/smoke-macos-dmg.sh'), 'utf8')
  expect(mac).toContain('mktemp -d "$repository_root/.runtime/.cache/')
  expect(mac.match(/--user-data-dir=\$chromium_profile/g)).toHaveLength(2)
  expect(mac).toContain('AI_NOVEL_LEGACY_SOURCE_HOME="$skin_home"')
  const update = readFileSync(resolve('scripts/windows-in-app-update-e2e.ps1'), 'utf8')
  expect(update).toContain('Get-E2eCanonicalGeneration -CanonicalHome $canonicalHome')
  expect(update).toContain('$legacyBeforeExplicitRestart.sha256 -eq $afterVelaHome.sha256')
})
