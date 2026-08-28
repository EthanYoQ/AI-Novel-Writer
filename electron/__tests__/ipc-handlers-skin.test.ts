import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  ensureVelaHome: vi.fn(),
  initializeSkinService: vi.fn(),
  registerSkinController: vi.fn(),
  registerWindowController: vi.fn(),
}))

vi.mock('../utils/config-utils', () => ({
  VELA_HOME: 'C:\\vela-app-data',
  ensureVelaHome: mocks.ensureVelaHome,
}))
vi.mock('../services/skin-service', () => ({
  skinService: { initialize: mocks.initializeSkinService },
}))
vi.mock('../controllers/skin-controller', () => ({
  registerSkinController: mocks.registerSkinController,
}))
vi.mock('../controllers/window-controller', () => ({
  registerWindowController: mocks.registerWindowController,
}))
vi.mock('../controllers/config-controller', () => ({ registerConfigController: vi.fn() }))
vi.mock('../controllers/project-controller', () => ({ registerProjectController: vi.fn() }))
vi.mock('../controllers/fs-controller', () => ({ registerFSController: vi.fn() }))
vi.mock('../controllers/llm-controller', () => ({ registerLLMController: vi.fn() }))
vi.mock('../controllers/db-controller', () => ({ registerDatabaseController: vi.fn() }))
vi.mock('../controllers/kb-controller', () => ({ registerKBController: vi.fn() }))
vi.mock('../controllers/import-controller', () => ({ registerImportController: vi.fn() }))
vi.mock('../controllers/official-homepage-controller', () => ({ registerOfficialHomepageController: vi.fn() }))
vi.mock('../controllers/model-provider-resource-controller', () => ({ registerModelProviderResourceController: vi.fn() }))
vi.mock('../controllers/finalization-controller', () => ({ registerFinalizationController: vi.fn() }))
vi.mock('../controllers/chapter-lifecycle-controller', () => ({ registerChapterLifecycleController: vi.fn() }))
vi.mock('../controllers/external-file-grant-controller', () => ({ registerExternalFileGrantController: vi.fn() }))
vi.mock('../controllers/app-data-controller', () => ({ registerAppDataController: vi.fn() }))

import { registerIPCHandlers } from '../ipc-handlers'

describe('skin IPC registration', () => {
  beforeEach(() => {
    mocks.calls.splice(0)
    mocks.ensureVelaHome.mockReset()
    mocks.initializeSkinService.mockReset()
    mocks.registerSkinController.mockReset()
    mocks.registerWindowController.mockReset()
  })

  it('initializes the skin service before registering its controller', () => {
    mocks.initializeSkinService.mockImplementation(() => mocks.calls.push('skin-service'))
    mocks.registerSkinController.mockImplementation(() => mocks.calls.push('skin-controller'))

    registerIPCHandlers()

    expect(mocks.calls).toEqual(expect.arrayContaining(['skin-service', 'skin-controller']))
    expect(mocks.calls.indexOf('skin-service')).toBeLessThan(mocks.calls.indexOf('skin-controller'))
  })

  it('keeps registering IPC when skin storage initialization fails', () => {
    mocks.initializeSkinService.mockImplementation(() => {
      throw new Error('skin storage is unavailable')
    })

    expect(() => registerIPCHandlers()).not.toThrow()
    expect(mocks.registerSkinController).toHaveBeenCalledOnce()
    expect(mocks.registerWindowController).toHaveBeenCalledOnce()
  })
})
