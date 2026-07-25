import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { LEGACY_VECTOR_MIGRATION_BLOCKED, LegacyVectorMigrationBlockedError } from '../../services/knowledge-base-migration-error'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  locale: 'zh-CN',
  handlers: new Map<string, IpcHandler>(),
  run: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getLocale: () => mocks.locale },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler)
    }),
  },
}))

vi.mock('../../database', () => ({ getCurrentProjectPath: () => 'C:/projects/A' }))
vi.mock('../../services/project-access', () => ({
  projectAccess: { assertCurrentProjectContext: () => ({ rootPath: 'C:/projects/A' }) },
}))
vi.mock('../../utils/config-utils', () => ({
  readJsonFile: vi.fn((_path: string, fallback: unknown) => fallback),
  GLOBAL_CONFIG_PATH: 'global.json',
  DEFAULT_GLOBAL_CONFIG: {},
  MODELS_CONFIG_PATH: 'models.json',
}))
vi.mock('../../services/knowledge-base-loader', () => ({ knowledgeBaseLoader: { run: mocks.run } }))
vi.mock('../../i18n', () => ({
  mainText: (locale: string, zh: string, en: string) => locale === 'en-US' ? en : zh,
}))

import { registerKBController } from '../kb-controller'

function handler(channel: string): IpcHandler {
  const registered = mocks.handlers.get(channel)
  if (!registered) throw new Error(`Missing IPC handler: ${channel}`)
  return async (event, ...args) => registered(event, ...args, {
    projectId: 'project-A',
    leaseId: 'lease-A',
    projectPath: 'C:/projects/A',
  })
}

beforeAll(() => {
  registerKBController()
})

beforeEach(() => {
  mocks.locale = 'zh-CN'
  vi.clearAllMocks()
})

describe('knowledge-base controller migration barrier', () => {
  it.each([
    ['zh-CN', '旧版知识库数据需要先修复后才能继续。请修正项目中的 vectors.json，然后重试。'],
    ['en-US', 'Legacy knowledge-base data must be repaired before continuing. Fix vectors.json in the project, then try again.'],
  ])('maps blocked search to a localized success:false result for %s', async (locale, expectedError) => {
    mocks.locale = locale
    mocks.run.mockImplementation(async (operation: (kb: { searchKnowledgeFTS: () => Promise<never> }) => unknown) => (
      await operation({
        searchKnowledgeFTS: async () => { throw new LegacyVectorMigrationBlockedError('internal Chinese migration detail') },
      })
    ))

    await expect(handler('kb:search')({}, 'query', 5, 'C:/projects/A')).resolves.toEqual({
      success: false,
      errorCode: LEGACY_VECTOR_MIGRATION_BLOCKED,
      error: expectedError,
    })
  })

  it('replaces a returned blocked import failure with the localized public message', async () => {
    mocks.locale = 'en-US'
    mocks.run.mockImplementation(async (operation: (kb: { importText: () => Promise<unknown> }) => unknown) => (
      await operation({
        importText: async () => ({
          success: false,
          errorCode: LEGACY_VECTOR_MIGRATION_BLOCKED,
          error: 'internal Chinese migration detail',
        }),
      })
    ))

    await expect(handler('kb:import-text')({}, 'text', 'chapter.txt', 'C:/projects/A')).resolves.toEqual({
      success: false,
      errorCode: LEGACY_VECTOR_MIGRATION_BLOCKED,
      error: 'Legacy knowledge-base data must be repaired before continuing. Fix vectors.json in the project, then try again.',
    })
  })

  it('preserves the migration barrier when async document removal rejects', async () => {
    mocks.run.mockImplementation(async (operation: (kb: { removeDocument: () => Promise<never> }) => unknown) => (
      await operation({
        removeDocument: async () => { throw new LegacyVectorMigrationBlockedError('internal migration detail') },
      })
    ))

    await expect(handler('kb:remove-document')({}, 'doc-1', 'C:/projects/A')).resolves.toEqual({
      success: false,
      errorCode: LEGACY_VECTOR_MIGRATION_BLOCKED,
      error: '旧版知识库数据需要先修复后才能继续。请修正项目中的 vectors.json，然后重试。',
    })
  })
})
