import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const mocks = vi.hoisted(() => {
  const calls: string[] = []
  const windows: Array<Record<string, unknown>> = []
  const BrowserWindow = vi.fn(function MockBrowserWindow(this: Record<string, unknown>) {
    calls.push('create-window')
    windows.push(this)
    this.id = windows.length
    this.webContents = {
      isDestroyed: () => false,
      isLoadingMainFrame: () => false,
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
    }
    this.isDestroyed = () => false
    this.on = vi.fn()
    this.setMenuBarVisibility = vi.fn()
    this.loadURL = vi.fn()
    this.loadFile = vi.fn()
  })
  Object.assign(BrowserWindow, { getAllWindows: vi.fn(() => windows) })

  return {
    calls,
    userData: '',
    appData: '',
    windows,
    BrowserWindow,
    registerIPCHandlers: vi.fn(() => calls.push('ipc')),
    registerMCPHandlers: vi.fn(() => calls.push('mcp')),
    startUpdateRuntime: vi.fn((options: unknown) => {
      void options
      calls.push('update-runtime')
    }),
    createGitHubReleaseUpdateBackend: vi.fn(),
    isMacUpdateReminderEnabled: vi.fn(() => false),
    openExternal: vi.fn(async () => undefined),
    initializeSkin: vi.fn(() => calls.push('skin')),
    skinSnapshot: vi.fn((generation: string) => ({ globalGeneration: generation, skinRevision: 0, backgroundSkin: 'classic' })),
    app: {
      commandLine: { appendSwitch: vi.fn(), getSwitchValue: vi.fn(() => '') },
      getPath: vi.fn((name: string) => name === 'appData' ? mocks.appData : mocks.userData),
      setPath: vi.fn(),
      getLocale: () => 'zh-CN',
      getVersion: () => '0.7.0',
      isPackaged: false,
      requestSingleInstanceLock: vi.fn(() => true),
      on: vi.fn(),
      whenReady: vi.fn(() => Promise.resolve()),
      quit: vi.fn(),
      exit: vi.fn(),
      dock: { setIcon: vi.fn() },
    },
  }
})

vi.mock('electron', () => ({
  app: mocks.app,
  BrowserWindow: mocks.BrowserWindow,
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() },
  shell: { openExternal: mocks.openExternal },
}))
vi.mock('../ipc-handlers', () => ({ registerIPCHandlers: mocks.registerIPCHandlers }))
vi.mock('../services/skin-service', () => ({ skinService: { initialize: mocks.initializeSkin, getStartupSnapshot: mocks.skinSnapshot } }))
vi.mock('../mcp/mcp-ipc-bridge', () => ({ registerMCPHandlers: mocks.registerMCPHandlers }))
vi.mock('../controllers/update-controller', () => ({ registerUpdateController: vi.fn() }))
vi.mock('../services/electron-updater-adapter', () => ({ createElectronUpdaterBackend: vi.fn() }))
vi.mock('../services/github-release-update-backend', () => ({
  GITHUB_LATEST_RELEASE_PAGE: 'https://github.com/EthanYoQ/AI-Novel-Writer/releases/latest',
  createGitHubReleaseUpdateBackend: mocks.createGitHubReleaseUpdateBackend,
}))
vi.mock('../services/update-preferences-store', () => ({
  GlobalConfigUpdatePreferencesStore: class MockUpdatePreferencesStore {},
}))
vi.mock('../services/update-runtime', () => ({
  hasWindowsUpdateConfiguration: () => true,
  isMacUpdateReminderEnabled: mocks.isMacUpdateReminderEnabled,
  isWindowsUpdateRuntimeEnabled: () => false,
}))
vi.mock('../services/update-startup', () => ({ startUpdateRuntime: mocks.startUpdateRuntime }))
vi.mock('../services/release-vector-smoke', () => ({
  claimReleaseVectorSmokeInvocation: vi.fn(),
  releaseVectorSmokeWasRequested: () => false,
  runReleaseVectorSmoke: vi.fn(),
}))
vi.mock('../services/release-official-homepage-smoke', () => ({
  claimReleaseOfficialHomepageSmokeInvocation: vi.fn(),
  releaseOfficialHomepageSmokeWasRequested: () => false,
  runReleaseOfficialHomepageSmoke: vi.fn(),
}))
vi.mock('../services/release-skin-smoke', () => ({
  claimReleaseSkinSmokeInvocation: vi.fn(),
  releaseSkinSmokeWasRequested: () => false,
  runReleaseSkinSmoke: vi.fn(),
}))
vi.mock('../controllers/official-homepage-controller', () => ({ registerOfficialHomepageController: vi.fn() }))
vi.mock('../services/official-homepage-navigation', () => ({
  createOfficialHomepageWindowOpenHandler: () => vi.fn(),
  preventRendererNavigation: vi.fn(),
}))

describe('interactive Electron startup', () => {
  let fixtureRoot: string
  let legacy: string
  let canonical: string
  beforeEach(() => {
    vi.resetModules()
    mocks.calls.splice(0)
    mocks.windows.splice(0)
    mocks.registerIPCHandlers.mockClear()
    mocks.registerMCPHandlers.mockClear()
    mocks.startUpdateRuntime.mockReset()
    mocks.startUpdateRuntime.mockImplementation(() => mocks.calls.push('update-runtime'))
    mocks.isMacUpdateReminderEnabled.mockReturnValue(false)
    mocks.openExternal.mockClear()
    mocks.BrowserWindow.mockClear()
    mocks.app.requestSingleInstanceLock.mockReturnValue(true)
    mocks.initializeSkin.mockReset().mockImplementation(() => mocks.calls.push('skin'))
    mocks.skinSnapshot.mockReset().mockImplementation(generation => ({ globalGeneration: generation, skinRevision: 0, backgroundSkin: 'classic' }))
    const fixtureBase = path.resolve('.runtime/.cache/main-startup-tests')
    fs.mkdirSync(fixtureBase, { recursive: true })
    fixtureRoot = fs.mkdtempSync(path.join(fixtureBase, 'run-'))
    legacy = path.join(fixtureRoot, 'legacy'); canonical = path.join(fixtureRoot, 'canonical')
    mocks.userData = path.join(fixtureRoot, 'userData')
    mocks.appData = path.join(fixtureRoot, 'appData')
    fs.mkdirSync(legacy); fs.mkdirSync(mocks.userData)
    fs.writeFileSync(path.join(legacy, 'config.json'), '{}')
    fs.writeFileSync(path.join(mocks.userData, 'retained.json'), 'original Chromium profile')
    vi.stubEnv('AI_NOVEL_LEGACY_SOURCE_HOME', legacy)
    vi.stubEnv('AI_NOVEL_APP_DATA_HOME', canonical)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  })

  it('registers service IPC before constructing the renderer window', async () => {
    await import('../main')
    await vi.waitFor(() => expect(mocks.calls).toContain('update-runtime'))

    expect(mocks.calls.indexOf('ipc')).toBeLessThan(mocks.calls.indexOf('create-window'))
    expect(mocks.calls.indexOf('mcp')).toBeLessThan(mocks.calls.indexOf('create-window'))
    expect(mocks.calls.indexOf('skin')).toBeLessThan(mocks.calls.indexOf('ipc'))
    expect(JSON.parse(fs.readFileSync(path.join(canonical, '.migration/receipt.json'), 'utf8')).completed).toBe(true)
    expect(fs.readFileSync(path.join(legacy, 'config.json'), 'utf8')).toBe('{}')
    expect(fs.readFileSync(path.join(mocks.userData, 'retained.json'), 'utf8')).toBe('original Chromium profile')
    expect(mocks.windows[0]?.on).toHaveBeenCalledWith('close', expect.any(Function))
  })

  it('passes Electron appData to migration when no canonical override is configured', async () => {
    vi.stubEnv('AI_NOVEL_APP_DATA_HOME', '')
    await import('../main')
    await vi.waitFor(() => expect(mocks.calls).toContain('update-runtime'))
    expect(JSON.parse(fs.readFileSync(path.join(mocks.appData, 'ai-novel-writer/.migration/receipt.json'), 'utf8')).completed).toBe(true)
    expect(fs.existsSync(canonical)).toBe(false)
    expect(fs.readFileSync(path.join(mocks.userData, 'retained.json'), 'utf8')).toBe('original Chromium profile')
  })

  it('shows only a diagnostic window when source JSON is corrupt', async () => {
    fs.writeFileSync(path.join(legacy, 'config.json'), '{corrupt')
    await import('../main')
    await vi.waitFor(() => expect(mocks.BrowserWindow).toHaveBeenCalledOnce())
    expect(mocks.registerIPCHandlers).not.toHaveBeenCalled()
    expect(mocks.registerMCPHandlers).not.toHaveBeenCalled()
    expect(mocks.startUpdateRuntime).not.toHaveBeenCalled()
    expect(mocks.initializeSkin).not.toHaveBeenCalled()
    expect(fs.existsSync(canonical)).toBe(false)
    expect(fs.readFileSync(path.join(legacy, 'config.json'), 'utf8')).toBe('{corrupt')
    expect(mocks.BrowserWindow).toHaveBeenCalledWith(expect.objectContaining({ frame: true }))
  })

  it('does not grant normal IPC after a skin snapshot failure', async () => {
    mocks.skinSnapshot.mockImplementation(() => { throw new Error('SKIN_UNREADABLE') })
    await import('../main')
    await vi.waitFor(() => expect(mocks.BrowserWindow).toHaveBeenCalledOnce())
    expect(mocks.registerIPCHandlers).not.toHaveBeenCalled()
    expect(mocks.registerMCPHandlers).not.toHaveBeenCalled()
  })

  it('does not migrate or create a window without the existing single-instance lock', async () => {
    mocks.app.requestSingleInstanceLock.mockReturnValue(false)
    await import('../main')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(mocks.app.quit).toHaveBeenCalled()
    expect(mocks.BrowserWindow).not.toHaveBeenCalled()
    expect(mocks.registerIPCHandlers).not.toHaveBeenCalled()
    expect(fs.existsSync(canonical)).toBe(false)
  })

  it('keeps the already-created window available when update startup fails', async () => {
    mocks.startUpdateRuntime.mockImplementation(() => {
      mocks.calls.push('update-runtime')
      throw new Error('updater unavailable')
    })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await import('../main')
    await vi.waitFor(() => expect(mocks.calls).toContain('update-runtime'))

    expect(mocks.calls).toContain('create-window')
    expect(mocks.BrowserWindow).toHaveBeenCalledOnce()
  })

  it('wires packaged macOS reminders to metadata checks and one fixed Releases page', async () => {
    mocks.isMacUpdateReminderEnabled.mockReturnValue(true)

    await import('../main')
    await vi.waitFor(() => expect(mocks.startUpdateRuntime).toHaveBeenCalled())

    const options = mocks.startUpdateRuntime.mock.calls[0]![0] as {
      openRelease(): Promise<void>
    }
    expect(options).toMatchObject({
      updateRuntimeEnabled: true,
      updateAction: 'open-release',
      createBackend: mocks.createGitHubReleaseUpdateBackend,
    })
    await options.openRelease()
    expect(mocks.openExternal).toHaveBeenCalledWith('https://github.com/EthanYoQ/AI-Novel-Writer/releases/latest')
  })
})
