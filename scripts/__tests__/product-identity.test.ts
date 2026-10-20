import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PRODUCT_NAME, PRODUCT_NAMES, resolvePackagedWindowsExecutable, resolveWindowsExecutable } from '../product-identity.mjs'

const windowsIt = process.platform === 'win32' ? it : it.skip

function runReleaseMonitorLibrary(script: string): Record<string, unknown> {
  const monitor = resolve('scripts/monitor-win-release-gate.ps1').replaceAll("'", "''")
  const output = execFileSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `. '${monitor}' -LoadMonitorLibrary\n${script}`,
  ], { encoding: 'utf8' })
  return JSON.parse(output.trim().split(/\r?\n/).at(-1)!)
}

describe('product identity used by release scripts', () => {
  it('matches the productName electron-builder packages with', () => {
    const config = readFileSync('electron-builder.json5', 'utf8')
    expect(/"productName":\s*"([^"]+)"/.exec(config)?.[1]).toBe(PRODUCT_NAME)
  })

  it('gives the PowerShell smoke library the same names in the same order', () => {
    const library = readFileSync('scripts/smoke-win-app.ps1', 'utf8')
    const expected = `return @(${PRODUCT_NAMES.map(name => `'${name}'`).join(', ')})`
    expect(library).toContain(`function Get-AiNovelProductNames {\r\n  ${expected}`)
  })

  it('finds the executable of either the current or the pre-rename package', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-novel-product-identity-'))
    try {
      const legacyOnly = join(root, 'legacy')
      mkdirSync(legacyOnly)
      writeFileSync(join(legacyOnly, 'AI小说作家.exe'), '')
      expect(resolveWindowsExecutable(legacyOnly)).toBe(join(legacyOnly, 'AI小说作家.exe'))
      writeFileSync(join(legacyOnly, '书童.exe'), '')
      expect(resolveWindowsExecutable(legacyOnly)).toBe(join(legacyOnly, '书童.exe'))
      expect(resolveWindowsExecutable(join(root, 'missing'))).toBe(join(root, 'missing', '书童.exe'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('targets the current product name when the run rebuilds over a pre-rename package', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-novel-product-identity-'))
    try {
      // 同一版本号下 win-unpacked 里还留着改名前的构建：本次构建会清掉它、产出新名 exe。
      writeFileSync(join(root, 'AI小说作家.exe'), '')
      const selected = resolvePackagedWindowsExecutable(root, { freshBuild: true })
      rmSync(join(root, 'AI小说作家.exe'))
      writeFileSync(join(root, '书童.exe'), '')
      expect(selected).toBe(join(root, '书童.exe'))
      expect(existsSync(selected)).toBe(true)
      // 复用已有产物时，仍按实际存在的文件找。
      rmSync(join(root, '书童.exe'))
      writeFileSync(join(root, 'AI小说作家.exe'), '')
      expect(resolvePackagedWindowsExecutable(root, { freshBuild: false })).toBe(join(root, 'AI小说作家.exe'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  windowsIt('lets the release gate accept the NSIS processes of both the new installer and the old uninstaller', () => {
    const result = runReleaseMonitorLibrary(`
$variants = @(Get-AiNovelGateNsisCmdProcessCheckVariants)
[pscustomobject]@{
  NewUninstaller = Test-AiNovelGateNsisUninstallerImage -ImagePath 'C:\\app\\Uninstall 书童.exe'
  OldUninstaller = Test-AiNovelGateNsisUninstallerImage -ImagePath 'C:\\app\\Uninstall AI小说作家.exe'
  OtherUninstaller = Test-AiNovelGateNsisUninstallerImage -ImagePath 'C:\\app\\Uninstall Other.exe'
  NewSetupTitle = Test-AiNovelGateNsisSetupWindowTitle -Title '书童 Setup  '
  OldSetupTitle = Test-AiNovelGateNsisSetupWindowTitle -Title 'AI小说作家 Setup'
  OtherSetupTitle = Test-AiNovelGateNsisSetupWindowTitle -Title 'Other Setup'
  OldExeInRoot = Test-AiNovelGateProductExecutableInRoot -ExecutablePath 'D:\\e2e\\installed-app\\AI小说作家.exe' -InstallRoot 'D:\\e2e\\installed-app'
  NewExeInRoot = Test-AiNovelGateProductExecutableInRoot -ExecutablePath 'D:\\e2e\\installed-app\\书童.exe' -InstallRoot 'D:\\e2e\\installed-app'
  OtherExeInRoot = Test-AiNovelGateProductExecutableInRoot -ExecutablePath 'D:\\e2e\\installed-app\\Other.exe' -InstallRoot 'D:\\e2e\\installed-app'
  CmdVariantNames = @($variants | ForEach-Object { $_.FilterFileName + '|' + $_.FilterArguments })
} | ConvertTo-Json -Compress
`)
    expect(result).toEqual({
      NewUninstaller: true,
      OldUninstaller: true,
      OtherUninstaller: false,
      NewSetupTitle: true,
      OldSetupTitle: true,
      OtherSetupTitle: false,
      OldExeInRoot: true,
      NewExeInRoot: true,
      OtherExeInRoot: false,
      CmdVariantNames: [
        'find.exe|  "书童.exe"',
        'findstr.exe|  /B /I /C:"\\"书童.exe\\""',
        'find.exe|  "AI小说作家.exe"',
        'findstr.exe|  /B /I /C:"\\"AI小说作家.exe\\""',
      ],
    })
  }, 30_000)
})
