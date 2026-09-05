import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const smokeToken = 'a'.repeat(64)

const mocks = vi.hoisted(() => {
  const BrowserWindow = vi.fn(function MockBrowserWindow(this: Record<string, unknown>) {
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
  Object.assign(BrowserWindow, { getAllWindows: vi.fn(() => []) })

  return {
    BrowserWindow,
    registerIPCHandlers: vi.fn(),
    registerMCPHandlers: vi.fn(),
    runReleaseSkinSmoke: vi.fn(() => ({
      schemaVersion: 1,
      kind: 'packaged-skin-smoke',
    })),
    app: {
      commandLine: { appendSwitch: vi.fn() },
      getLocale: () => 'zh-CN',
      getVersion: () => '0.7.0',
      isPackaged: true,
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
  shell: { openExternal: vi.fn() },
}))
vi.mock('../ipc-handlers', () => ({ registerIPCHandlers: mocks.registerIPCHandlers }))
vi.mock('../mcp/mcp-ipc-bridge', () => ({ registerMCPHandlers: mocks.registerMCPHandlers }))
vi.mock('../i18n', () => ({ mainT: () => 'AI Novel Writer' }))
vi.mock('../controllers/update-controller', () => ({ registerUpdateController: vi.fn() }))
vi.mock('../services/electron-updater-adapter', () => ({ createElectronUpdaterBackend: vi.fn() }))
vi.mock('../services/github-release-update-backend', () => ({
  GITHUB_LATEST_RELEASE_PAGE: 'https://github.com/EthanYoQ/AI-Novel-Writer/releases/latest',
  createGitHubReleaseUpdateBackend: vi.fn(),
}))
vi.mock('../services/update-preferences-store', () => ({
  GlobalConfigUpdatePreferencesStore: class MockUpdatePreferencesStore {},
}))
vi.mock('../services/update-runtime', () => ({
  hasWindowsUpdateConfiguration: () => true,
  isMacUpdateReminderEnabled: () => false,
  isWindowsUpdateRuntimeEnabled: () => false,
}))
vi.mock('../services/update-startup', () => ({ startUpdateRuntime: vi.fn() }))
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
  claimReleaseSkinSmokeInvocation: vi.fn(() => ({ token: smokeToken })),
  releaseSkinSmokeWasRequested: (args: readonly string[]) => args.some(argument => argument.startsWith('--ai-novel-release-skin-smoke=')),
  runReleaseSkinSmoke: mocks.runReleaseSkinSmoke,
}))
vi.mock('../controllers/official-homepage-controller', () => ({ registerOfficialHomepageController: vi.fn() }))
vi.mock('../services/official-homepage-navigation', () => ({
  createOfficialHomepageWindowOpenHandler: () => vi.fn(),
  preventRendererNavigation: vi.fn(),
}))

describe('packaged skin smoke startup', () => {
  const originalArgv = process.argv

  beforeEach(() => {
    vi.resetModules()
    process.argv = [...originalArgv, `--ai-novel-release-skin-smoke=${smokeToken}`]
    mocks.app.exit.mockClear()
    mocks.BrowserWindow.mockClear()
    mocks.registerIPCHandlers.mockClear()
    mocks.registerMCPHandlers.mockClear()
    mocks.runReleaseSkinSmoke.mockClear()
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    process.argv = originalArgv
    vi.restoreAllMocks()
  })

  it('runs only the isolated skin qualification and exits with its JSON evidence', async () => {
    await import('../main')
    await vi.waitFor(() => expect(mocks.runReleaseSkinSmoke).toHaveBeenCalledWith(smokeToken))

    expect(mocks.app.exit).toHaveBeenCalledWith(0)
    expect(mocks.BrowserWindow).not.toHaveBeenCalled()
    expect(mocks.registerIPCHandlers).not.toHaveBeenCalled()
    expect(mocks.registerMCPHandlers).not.toHaveBeenCalled()
    expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('packaged-skin-smoke'))
  })
})
