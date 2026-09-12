import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  assertGlobalDataReady: vi.fn(),
  skinSnapshot: vi.fn(),
  registerSkinController: vi.fn(),
  registerWindowController: vi.fn(),
}))

vi.mock('../services/app-data-locator', () => ({
  getGlobalDataGeneration: () => 'admitted-generation',
  assertGlobalDataReady: mocks.assertGlobalDataReady,
}))
vi.mock('../services/skin-service', () => ({
  skinService: { getStartupSnapshot: mocks.skinSnapshot },
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
    mocks.assertGlobalDataReady.mockReset()
    mocks.skinSnapshot.mockReset()
    mocks.registerSkinController.mockReset()
    mocks.registerWindowController.mockReset()
  })

  it('requires an admitted global generation and skin snapshot before registering controllers', () => {
    mocks.assertGlobalDataReady.mockImplementation(() => mocks.calls.push('global-ready'))
    mocks.skinSnapshot.mockImplementation(() => mocks.calls.push('skin-service'))
    mocks.registerSkinController.mockImplementation(() => mocks.calls.push('skin-controller'))

    registerIPCHandlers()

    expect(mocks.calls).toEqual(expect.arrayContaining(['skin-service', 'skin-controller']))
    expect(mocks.calls.indexOf('skin-service')).toBeLessThan(mocks.calls.indexOf('skin-controller'))
    expect(mocks.calls.indexOf('global-ready')).toBeLessThan(mocks.calls.indexOf('skin-service'))
    expect(mocks.skinSnapshot).toHaveBeenCalledWith('admitted-generation')
  })

  it('refuses writable controllers when the skin snapshot is unavailable', () => {
    mocks.skinSnapshot.mockImplementation(() => {
      throw new Error('skin storage is unavailable')
    })

    expect(() => registerIPCHandlers()).toThrow('skin storage is unavailable')
    expect(mocks.registerSkinController).not.toHaveBeenCalled()
    expect(mocks.registerWindowController).not.toHaveBeenCalled()
  })

  it('refuses even the skin reader when global migration has not committed', () => {
    mocks.assertGlobalDataReady.mockImplementation(() => { throw new Error('GLOBAL_DATA_NOT_READY') })
    expect(() => registerIPCHandlers()).toThrow('GLOBAL_DATA_NOT_READY')
    expect(mocks.skinSnapshot).not.toHaveBeenCalled()
    expect(mocks.registerSkinController).not.toHaveBeenCalled()
  })
})
