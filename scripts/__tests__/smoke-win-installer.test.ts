import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Windows installer smoke contract', () => {
  it('runs the installed executable with isolated Vela data and supports an old-installer upgrade path', () => {
    const script = readFileSync('scripts/smoke-win-installer.ps1', 'utf8')

    expect(script).toContain('$PreviousInstallerPath')
    expect(script).toContain('Install-Silently')
    expect(script).toContain('smoke-win-app.ps1')
    expect(script).toContain('-VelaHome $velaHome')
    expect(script).toContain('Installer smoke changed existing global configuration')
  })

  it('exposes a release smoke gate that requires an explicit official v0.2.5 installer', () => {
    const script = readFileSync('scripts/smoke-win-v025-upgrade.ps1', 'utf8')
    const packageJson = readFileSync('package.json', 'utf8')

    expect(script).toContain('AI_NOVEL_PREVIOUS_INSTALLER')
    expect(script).toContain('AE9C88997A7DF3A48A8BEECCB0AB624BF947358CBBF702C19E70EC8460B9DFE7')
    expect(script).toContain('Get-Sha256')
    expect(script).toContain('SHA256]::Create')
    expect(script).toContain('smoke-win-installer.ps1')
    expect(packageJson).toContain('smoke:win-v025-upgrade')
  })

  it('rejects Windows application-error dialogs and Chromium fatal startup logs', () => {
    const script = readFileSync('scripts/smoke-win-app.ps1', 'utf8')

    expect(script).toContain('unknown software exception')
    expect(script).toContain("GPU process isn.t usable")
    expect(script).toContain('Get-ProcessTreeIds')
    expect(script).toContain('Win32_Process')
    expect(script).toContain('ObservationSeconds = 30')
  })
})
