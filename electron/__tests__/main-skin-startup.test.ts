import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const calls: string[] = []
  const windows: Array<Record<string, unknown>> = []
  const BrowserWindow = vi.fn(function MockBrowserWindow(this: Record<string, unknown>) {
    calls.push('create-window')
    windows.push(this)
    this.webContents = {
      isDestroyed: () => false,
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
    }
    this.isDestroyed = () => false
    this.setMenuBarVisibility = vi.fn()
    this.loadURL = vi.fn()
    this.loadFile = vi.fn()
  })
  Object.assign(BrowserWindow, { getAllWindows: vi.fn(() => windows) })

  return {
    calls,
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
    app: {
      commandLine: { appendSwitch: vi.fn() },
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
  ipcMain: { removeHandler: vi.fn() },
  shell: { openExternal: mocks.openExternal },
}))
vi.mock('../ipc-handlers', () => ({ registerIPCHandlers: mocks.registerIPCHandlers }))
vi.mock('../mcp/mcp-ipc-bridge', () => ({ registerMCPHandlers: mocks.registerMCPHandlers }))
vi.mock('../i18n', () => ({ mainT: () => 'AI Novel Writer' }))
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
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('registers service IPC before constructing the renderer window', async () => {
    await import('../main')
    await vi.waitFor(() => expect(mocks.calls).toContain('update-runtime'))

    expect(mocks.calls.indexOf('ipc')).toBeLessThan(mocks.calls.indexOf('create-window'))
    expect(mocks.calls.indexOf('mcp')).toBeLessThan(mocks.calls.indexOf('create-window'))
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
