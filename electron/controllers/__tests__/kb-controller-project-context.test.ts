import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  currentProjectPath: 'C:/projects/A',
  handlers: new Map<string, IpcHandler>(),
  run: vi.fn(),
  assertCurrentProjectContext: vi.fn(),
  assertKnowledgeBaseStoragePathSupported: vi.fn(),
  projectStoragePreflightFailure: vi.fn(),
  readJsonFile: vi.fn(),
  resolveReferenceImportAuthority: vi.fn(),
  commitReferenceImportReceipt: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getLocale: vi.fn(() => 'zh-CN') },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler)
    }),
  },
}))

vi.mock('../../database', () => ({
  getCurrentProjectPath: () => mocks.currentProjectPath,
}))

vi.mock('../../services/project-access', () => ({
  projectAccess: {
    assertCurrentProjectContext: mocks.assertCurrentProjectContext,
  },
}))

vi.mock('../../services/project-storage-preflight', () => ({
  assertKnowledgeBaseStoragePathSupported: mocks.assertKnowledgeBaseStoragePathSupported,
  projectStoragePreflightFailure: mocks.projectStoragePreflightFailure,
}))

vi.mock('../../utils/config-utils', () => ({
  readJsonFile: mocks.readJsonFile,
  GLOBAL_CONFIG_PATH: 'global.json',
  DEFAULT_GLOBAL_CONFIG: {},
  MODELS_CONFIG_PATH: 'models.json',
}))

vi.mock('../../services/knowledge-base-loader', () => ({
  knowledgeBaseLoader: { run: mocks.run },
}))

vi.mock('../../repositories/import-run-repository', () => ({
  ImportRunRepository: {
    resolveReferenceImportAuthority: mocks.resolveReferenceImportAuthority,
    commitReferenceImportReceipt: mocks.commitReferenceImportReceipt,
  },
}))

vi.mock('../../i18n', () => ({
  mainText: vi.fn((_locale: string, zh: string) => zh),
}))

import { registerKBController } from '../kb-controller'

function rawHandler(channel: string): IpcHandler {
  const registered = mocks.handlers.get(channel)
  if (!registered) throw new Error(`Missing IPC handler: ${channel}`)
  return registered
}

function handler(channel: string): IpcHandler {
  const registered = rawHandler(channel)
  return async (event, ...args) => {
    const expectedProjectPath = args.at(-1)
    if (typeof expectedProjectPath !== 'string' || !/^[A-Za-z]:[\\/]/.test(expectedProjectPath)) {
      return registered(event, ...args)
    }
    return registered(event, ...args, {
      projectId: 'project-A',
      leaseId: 'lease-A',
      projectPath: mocks.currentProjectPath,
    })
  }
}

beforeAll(() => {
  registerKBController()
})

beforeEach(() => {
  mocks.currentProjectPath = 'C:/projects/A'
  vi.clearAllMocks()
  mocks.readJsonFile.mockImplementation((_path: string, fallback: unknown) => fallback)
  mocks.resolveReferenceImportAuthority.mockReturnValue({
    chapterNumber: 1,
    title: 'Chapter 1',
    content: 'frozen text',
    contentFingerprint: 'a'.repeat(64),
    stableKey: 'reference:key:1:fingerprint',
  })
  mocks.assertCurrentProjectContext.mockImplementation((context: { projectPath?: string } | undefined, currentProjectPath: string) => {
    if (!context?.projectPath) throw new Error('缺少项目会话上下文，已拒绝操作')
    if (context.projectPath !== currentProjectPath) {
      throw new Error('项目会话与当前数据库不匹配，已拒绝操作')
    }
    return { rootPath: currentProjectPath }
  })
  mocks.assertKnowledgeBaseStoragePathSupported.mockImplementation(() => undefined)
  mocks.projectStoragePreflightFailure.mockImplementation((error: unknown) => (
    error instanceof Error
    && 'code' in error
    && error.code === 'PROJECT_STORAGE_PATH_UNSUPPORTED'
      ? { success: false, errorCode: 'PROJECT_STORAGE_PATH_UNSUPPORTED', error: error.message }
      : undefined
  ))
})

describe('knowledge-base controller project context guard', () => {
  it('requires active import-run authority before reference text reaches the knowledge base', async () => {
    const importReferenceText = vi.fn(async () => ({ success: true, docId: 'reference-doc' }))
    mocks.run.mockImplementation(async (operation: (kb: {
      importReferenceText: typeof importReferenceText
    }) => unknown) => operation({ importReferenceText }))
    const authority = { owner: 'renderer-a', epoch: 3 }

    await expect(rawHandler('kb:import-reference-text')(
      {}, 1, 'Chapter 1.txt', 'run-1', authority, {
        projectId: 'project-A',
        leaseId: 'lease-A',
        projectPath: mocks.currentProjectPath,
      },
    )).resolves.toEqual({ success: true, docId: 'reference-doc' })

    expect(mocks.resolveReferenceImportAuthority).toHaveBeenCalledWith(
      'run-1', authority, 1,
    )
    expect(importReferenceText).toHaveBeenCalledWith(
      'frozen text', 'Chapter 1.txt', 'reference:key:1:fingerprint',
      1, 'run-1', authority, 'C:/projects/A', 'openai', expect.any(Object),
    )
    expect(mocks.commitReferenceImportReceipt).toHaveBeenCalledWith(
      'run-1', authority, 1, 'reference-doc',
    )
  })

  it('rejects a matching project path that omits its session context', async () => {
    await expect(rawHandler('kb:clear-all')({}, 'C:/projects/A'))
      .rejects.toThrow(/项目会话/)
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it.each([
    ['kb:import-document', ['book.txt']],
    ['kb:import-folder', ['folder']],
    ['kb:import-text', ['text', 'book.txt']],
    ['kb:search', ['query', 5]],
    ['kb:search-with-scope', ['query', 1, 3, 5]],
    ['kb:list-documents', []],
    ['kb:remove-document', ['doc-1']],
    ['kb:clear-all', []],
    ['kb:stats', []],
    ['kb:get-vectorless-count', []],
    ['kb:get-vector-rebuild-status', []],
    ['kb:backfill-vectors', []],
  ])('rejects stale and missing project identity for %s', async (channel, args) => {
    mocks.currentProjectPath = 'C:/projects/B'

    await expect(handler(channel)({}, ...args, 'C:/projects/A'))
      .rejects.toThrow(/项目上下文已切换/)
    await expect(rawHandler(channel)({}, ...args))
      .rejects.toThrow(/缺少项目(?:上下文|会话)/)
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('reports no rebuild action and makes no knowledge-base call without a usable embedding configuration', async () => {
    await expect(handler('kb:get-vector-rebuild-status')({}, 'C:/projects/A')).resolves.toEqual({
      embeddingConfigured: false,
      canRebuild: false,
      totalChunks: 0,
      vectorlessCount: 0,
      activeVectorDimension: 0,
    })
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('keeps a deep existing project open but rejects knowledge-base work with a typed relocation error', async () => {
    mocks.assertKnowledgeBaseStoragePathSupported.mockImplementationOnce(() => {
      throw Object.assign(new Error('请将整个项目文件夹移动到更靠近磁盘根目录的位置'), {
        code: 'PROJECT_STORAGE_PATH_UNSUPPORTED',
      })
    })

    await expect(handler('kb:import-text')({}, 'text', 'book.txt', 'C:/projects/A')).resolves.toEqual({
      success: false,
      errorCode: 'PROJECT_STORAGE_PATH_UNSUPPORTED',
      error: '请将整个项目文件夹移动到更靠近磁盘根目录的位置',
    })
    expect(mocks.run).not.toHaveBeenCalled()
    expect(mocks.readJsonFile).not.toHaveBeenCalled()
  })

  it('returns a provider-free rebuild status when a usable embedding configuration exists', async () => {
    mocks.readJsonFile.mockImplementation((filePath: string, fallback: unknown) => {
      if (filePath === 'global.json') return { defaultEmbeddingModelId: 'embedding-model' }
      if (filePath === 'models.json') {
        return [{
          id: 'embedding-model',
          protocol: 'openai',
          baseUrl: 'https://embedding.example/v1',
          apiKey: 'configured-key',
          modelName: 'embedding-model',
        }]
      }
      return fallback
    })
    mocks.run.mockImplementation(async (operation: (kb: {
      getKnowledgeStats: () => Promise<{ totalChunks: number; vectorDimension: number }>
      getVectorlessCount: () => Promise<{ count: number }>
    }) => unknown) => operation({
      getKnowledgeStats: async () => ({ totalChunks: 12, vectorDimension: 768 }),
      getVectorlessCount: async () => ({ count: 0 }),
    }))

    await expect(handler('kb:get-vector-rebuild-status')({}, 'C:/projects/A')).resolves.toEqual({
      embeddingConfigured: true,
      canRebuild: true,
      totalChunks: 12,
      vectorlessCount: 0,
      activeVectorDimension: 768,
    })
  })

  it('does not clear project B when a confirmation opened for project A resolves later', async () => {
    // The renderer freezes A before showing the confirmation. By the time the
    // user accepts, the main-process database is already bound to B.
    const confirmedProjectPath = 'C:/projects/A'
    mocks.currentProjectPath = 'C:/projects/B'

    await expect(handler('kb:clear-all')({}, confirmedProjectPath))
      .rejects.toThrow(/项目上下文已切换/)
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('waits for a delayed knowledge-base removal before reporting success', async () => {
    let resolveRemoval!: (success: boolean) => void
    const removeDocument = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveRemoval = resolve
    }))
    mocks.run.mockImplementation(async (operation: (kb: {
      removeDocument: typeof removeDocument
    }) => unknown) => operation({ removeDocument }))

    const removal = handler('kb:remove-document')({}, 'doc-1', 'C:/projects/A')
    let settled = false
    void removal.then(
      () => { settled = true },
      () => { settled = true },
    )
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(removeDocument).toHaveBeenCalledWith('doc-1', 'C:/projects/A')
    expect(settled).toBe(false)

    resolveRemoval(true)
    await expect(removal).resolves.toEqual({ success: true })
  })

  it('returns an explicit public failure when knowledge-base removal returns false', async () => {
    const removeDocument = vi.fn(async () => false)
    mocks.run.mockImplementation(async (operation: (kb: {
      removeDocument: typeof removeDocument
    }) => unknown) => operation({ removeDocument }))

    const result = await handler('kb:remove-document')({}, 'doc-1', 'C:/projects/A')
    const nestedSuccess = (result as { success?: unknown }).success
    if (nestedSuccess instanceof Promise) await nestedSuccess.catch(() => undefined)

    expect(result).toEqual({
      success: false,
      error: '删除知识库文档失败',
    })
  })

  it('converts a rejected knowledge-base removal into a public failure result', async () => {
    const removeDocument = vi.fn(async () => {
      throw new Error('native vector delete rejected')
    })
    mocks.run.mockImplementation(async (operation: (kb: {
      removeDocument: typeof removeDocument
    }) => unknown) => operation({ removeDocument }))

    const result = await handler('kb:remove-document')({}, 'doc-1', 'C:/projects/A')
    const nestedSuccess = (result as { success?: unknown }).success
    if (nestedSuccess instanceof Promise) await nestedSuccess.catch(() => undefined)

    expect(result).toEqual({
      success: false,
      error: '删除知识库文档失败',
    })
  })
})
