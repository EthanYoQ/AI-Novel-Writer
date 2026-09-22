import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CharacterAvatarControllerDependencies } from '../controllers/character-avatar-controller'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
const mocks = vi.hoisted(() => ({
  avatarDependencies: undefined as CharacterAvatarControllerDependencies | undefined,
  assertCurrentProjectContext: vi.fn(),
  database: null as import('better-sqlite3').Database | null,
  projectPath: '',
  storageRoot: '',
}))

vi.mock('electron', () => ({
  app: { getLocale: () => 'zh-CN' },
  nativeImage: { createFromBuffer: vi.fn() },
}))
vi.mock('../services/app-data-locator', () => ({
  assertGlobalDataReady: vi.fn(),
  getGlobalDataGeneration: () => 'generation',
  getGlobalDataRoot: () => mocks.storageRoot,
}))
vi.mock('../services/skin-service', () => ({ skinService: { getStartupSnapshot: vi.fn() } }))
vi.mock('../services/project-access', () => ({
  projectAccess: { assertCurrentProjectContext: mocks.assertCurrentProjectContext },
}))
vi.mock('../database', () => ({
  getCurrentProjectPath: () => mocks.projectPath,
  getProjectDb: () => mocks.database,
}))
vi.mock('../services/project-data-locator', () => ({
  getProjectDataRoot: () => mocks.storageRoot,
}))
vi.mock('../controllers/character-avatar-controller', () => ({
  registerCharacterAvatarController: vi.fn((dependencies: CharacterAvatarControllerDependencies) => {
    mocks.avatarDependencies = dependencies
  }),
}))
vi.mock('../controllers/config-controller', () => ({ registerConfigController: vi.fn() }))
vi.mock('../controllers/project-controller', () => ({ registerProjectController: vi.fn() }))
vi.mock('../controllers/project-archive-controller', () => ({ registerProjectArchiveController: vi.fn() }))
vi.mock('../controllers/cloud-backup-controller', () => ({ registerCloudBackupController: vi.fn() }))
vi.mock('../controllers/fs-controller', () => ({ registerFSController: vi.fn() }))
vi.mock('../controllers/llm-controller', () => ({ registerLLMController: vi.fn() }))
vi.mock('../controllers/generation-controller', () => ({ registerGenerationController: vi.fn() }))
vi.mock('../controllers/db-controller', () => ({ registerDatabaseController: vi.fn() }))
vi.mock('../controllers/kb-controller', () => ({ registerKBController: vi.fn() }))
vi.mock('../controllers/import-controller', () => ({ registerImportController: vi.fn() }))
vi.mock('../controllers/window-controller', () => ({ registerWindowController: vi.fn() }))
vi.mock('../controllers/official-homepage-controller', () => ({ registerOfficialHomepageController: vi.fn() }))
vi.mock('../controllers/model-provider-resource-controller', () => ({ registerModelProviderResourceController: vi.fn() }))
vi.mock('../controllers/finalization-controller', () => ({ registerFinalizationController: vi.fn() }))
vi.mock('../controllers/chapter-lifecycle-controller', () => ({ registerChapterLifecycleController: vi.fn() }))
vi.mock('../controllers/external-file-grant-controller', () => ({ registerExternalFileGrantController: vi.fn() }))
vi.mock('../controllers/app-data-controller', () => ({ registerAppDataController: vi.fn() }))
vi.mock('../controllers/skin-controller', () => ({ registerSkinController: vi.fn() }))

import { registerIPCHandlers } from '../ipc-handlers'
import { M05_CHARACTER_ASSET_SQL } from '../migrations/m05-character-assets'
import { CharacterAssetService } from '../services/character-asset-service'

const roots: string[] = []
const context = { projectId: 'project-a', leaseId: 'lease-a', projectPath: 'C:\\Novel' }

beforeEach(() => {
  mocks.avatarDependencies = undefined
  mocks.assertCurrentProjectContext.mockReset()
  mocks.projectPath = context.projectPath
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-ipc-lifecycle-'))
  roots.push(root)
  mocks.storageRoot = root
  mocks.database = new Database(':memory:')
  mocks.database.exec('CREATE TABLE characters(character_id TEXT PRIMARY KEY)')
  mocks.database.exec(M05_CHARACTER_ASSET_SQL)
})

afterEach(() => {
  mocks.database?.close()
  mocks.database = null
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('character avatar production lifecycle', () => {
  it('records a crash leftover only after the current project session is validated', () => {
    const avatarDirectory = path.join(mocks.storageRoot, 'avatars')
    fs.mkdirSync(avatarDirectory)
    fs.writeFileSync(path.join(avatarDirectory, 'crash.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const scan = vi.spyOn(CharacterAssetService.prototype, 'recordReclaimableOrphans')
    registerIPCHandlers()
    const resolve = mocks.avatarDependencies!.resolveService

    mocks.assertCurrentProjectContext.mockImplementationOnce(() => { throw new Error('stale session') })
    expect(resolve({}, context)).toBeNull()
    expect(scan).not.toHaveBeenCalled()
    expect(mocks.database!.prepare('SELECT COUNT(*) AS count FROM character_avatar_unresolved').get()).toEqual({ count: 0 })

    mocks.assertCurrentProjectContext.mockReturnValue({ rootPath: context.projectPath })
    expect(resolve({}, context)).toBeInstanceOf(CharacterAssetService)
    expect(scan).toHaveBeenCalledTimes(1)
    expect(mocks.database!.prepare('SELECT disposition,source_reference FROM character_avatar_unresolved').get())
      .toEqual({ disposition: 'orphan', source_reference: 'runtime-crash' })
  })

  it('surfaces recovery scan failure after validation instead of returning a usable service', () => {
    mocks.assertCurrentProjectContext.mockReturnValue({ rootPath: context.projectPath })
    vi.spyOn(CharacterAssetService.prototype, 'recordReclaimableOrphans').mockImplementation(() => {
      throw new Error('orphan scan failed')
    })
    registerIPCHandlers()

    expect(() => mocks.avatarDependencies!.resolveService({}, context)).toThrow('orphan scan failed')
    expect(mocks.assertCurrentProjectContext).toHaveBeenCalledOnce()
  })
})
