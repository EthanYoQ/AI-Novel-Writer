import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(file: string) {
  return readFileSync(resolve(process.cwd(), file), 'utf8')
}

describe('Electron main window chrome contract', () => {
  it('uses the custom writer title bar instead of the native system title bar', () => {
    const main = source('electron/main.ts')

    expect(main).toMatch(/frame:\s*false/)
    expect(main).not.toMatch(/titleBarStyle:\s*'hiddenInset'/)
  })

  it('uses the narrow Windows GPU-process workaround without weakening the renderer sandbox', () => {
    const main = source('electron/main.ts')

    expect(main).toContain("app.commandLine.appendSwitch('disable-gpu-sandbox')")
    expect(main).not.toContain("appendSwitch('no-sandbox')")
    expect(main).not.toContain("appendSwitch('in-process-gpu')")
    expect(main).toContain('nodeIntegration: false')
    expect(main).toContain('contextIsolation: true')
  })

  it('registers window control IPC for frameless minimize maximize and close buttons', () => {
    const ipcHandlers = source('electron/ipc-handlers.ts')
    const ipcChannels = source('src/shared/ipc-channels.ts')
    const titleBar = source('src/components/layout/TitleBar.tsx')

    expect(ipcHandlers).toContain('registerWindowController')
    for (const channel of ['window:minimize', 'window:toggle-maximize', 'window:close']) {
      expect(ipcChannels).toContain(`'${channel}'`)
      expect(titleBar).toContain(`'${channel}'`)
    }
    expect(titleBar).not.toContain('最小化窗口由系统标题栏控制')
  })

  it('keeps the official homepage as a fixed trusted intent and prevents renderer navigation', () => {
    const main = source('electron/main.ts')
    const ipcHandlers = source('electron/ipc-handlers.ts')
    const ipcChannels = source('src/shared/ipc-channels.ts')

    expect(ipcHandlers).toContain('registerOfficialHomepageController')
    expect(ipcChannels).toContain("'official-homepage:open'")
    expect(main).toContain('setWindowOpenHandler(createOfficialHomepageWindowOpenHandler')
    expect(main).toContain("on('will-navigate', preventRendererNavigation)")
  })

  it('runs the packaged vector qualification through the real Electron main process without opening a window', () => {
    const main = source('electron/main.ts')

    expect(main).toContain("from './services/release-vector-smoke'")
    expect(main).toContain('releaseVectorSmokeWasRequested(process.argv)')
    expect(main).toContain('claimReleaseVectorSmokeInvocation(process.argv, process.env)')
    expect(main).toContain('runReleaseVectorSmoke(releaseVectorSmokeInvocation.token)')
    expect(main).toContain("process.stdout.write(`${JSON.stringify(evidence)}\\n`)")
    expect(main).toContain('app.exit(0)')
    expect(main).toContain('app.exit(1)')
    expect(main).toContain('[AI Novel release smoke] stage=${stage}')
    expect(main).toContain('Packaged vector smoke timed out after 90 seconds')
  })

  it('runs the packaged official-homepage qualification through a hidden local preload window', () => {
    const main = source('electron/main.ts')

    expect(main).toContain("from './services/release-official-homepage-smoke'")
    expect(main).toContain('releaseOfficialHomepageSmokeWasRequested(process.argv)')
    expect(main).toContain('claimReleaseOfficialHomepageSmokeInvocation(process.argv, process.env)')
    expect(main).toContain('runPackagedOfficialHomepageSmoke(releaseHomepageSmokeInvocation.token)')
    expect(main).toContain("'release-homepage-smoke.html'")
    expect(main).toContain('show: false')
    expect(main).toContain('contextIsolation: true')
    expect(main).toContain('const requestedSmokeModeCount = Number(releaseVectorSmokeRequested)')
    expect(main).toContain('requestedSmokeModeCount !== 1 || invocationCount !== 1')
  })

  it('runs the packaged skin qualification only with its own dual-gated invocation', () => {
    const main = source('electron/main.ts')

    expect(main).toContain("from './services/release-skin-smoke'")
    expect(main).toContain('releaseSkinSmokeWasRequested(process.argv)')
    expect(main).toContain('claimReleaseSkinSmokeInvocation(process.argv, process.env)')
    expect(main).toContain('runReleaseSkinSmoke(releaseSkinSmokeInvocation!.token)')
    expect(main).toContain('Packaged skin smoke timed out after 90 seconds')
  })
})
