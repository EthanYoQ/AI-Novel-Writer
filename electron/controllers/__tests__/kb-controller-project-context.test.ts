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
  getRun: vi.fn(),
  knowledgeDocumentChapters: vi.fn(() => new Map<string, number>()),
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
    get: mocks.getRun,
  },
}))

vi.mock('../../repositories/finalization-repository', () => ({
  FinalizationRepository: { knowledgeDocumentChapters: mocks.knowledgeDocumentChapters },
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
    if (!context?.projectPath) throw new Error('PROJECT_SESSION_REQUIRED')
    if (context.projectPath !== currentProjectPath) {
      throw new Error('PROJECT_SESSION_DATABASE_MISMATCH')
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
  it('marks documents that a finalization linked as finalized chapters, leaving imported copies unmarked', async () => {
    const listDocuments = vi.fn(async () => [
      { id: 'chapter-doc', fileName: '第2章 旧照片.txt', importedAt: '', chunkCount: 4, filePath: 'knowledge-copy:chapter-doc' },
      { id: 'notes-doc', fileName: '人物小传.txt', importedAt: '', chunkCount: 2, filePath: 'knowledge-copy:notes-doc' },
    ])
    mocks.run.mockImplementation(async (operation: (kb: { listDocuments: typeof listDocuments }) => unknown) => operation({ listDocuments }))
    mocks.knowledgeDocumentChapters.mockReturnValue(new Map([['chapter-doc', 2]]))

    await expect(handler('kb:list-documents')({}, 'C:/projects/A')).resolves.toEqual([
      { id: 'chapter-doc', fileName: '第2章 旧照片.txt', importedAt: '', chunkCount: 4, filePath: 'knowledge-copy:chapter-doc', finalizedChapter: 2 },
      { id: 'notes-doc', fileName: '人物小传.txt', importedAt: '', chunkCount: 2, filePath: 'knowledge-copy:notes-doc' },
    ])
  })

  it('requires active import-run authority before reference text reaches the knowledge base', async () => {
    const importReferenceText = vi.fn<(
      text: string, fileName: string, ...args: unknown[]
    ) => Promise<{ success: boolean; docId: string }>>()
      .mockResolvedValue({ success: true, docId: 'reference-doc' })
    mocks.run.mockImplementation(async (operation: (kb: {
      importReferenceText: typeof importReferenceText
    }) => unknown) => operation({ importReferenceText }))
    const authority = { owner: 'renderer-a', epoch: 3 }

    await expect(rawHandler('kb:import-reference-text')(
      {}, 1, 'run-1', authority, {
        projectId: 'project-A',
        leaseId: 'lease-A',
        projectPath: mocks.currentProjectPath,
      },
    )).resolves.toEqual({ success: true, docId: 'reference-doc' })

    expect(mocks.resolveReferenceImportAuthority).toHaveBeenCalledWith(
      'run-1', authority, 1,
    )
    expect(importReferenceText).toHaveBeenCalledWith(
      'frozen text', '第1章 Chapter 1.txt', 'reference:key:1:fingerprint',
      1, 'run-1', authority, 'C:/projects/A', 'openai', expect.any(Object),
    )
    expect(mocks.commitReferenceImportReceipt).toHaveBeenCalledWith(
      'run-1', authority, 1, 'reference-doc',
    )
  })

  it('derives a stable, control-free bounded KB label from a long main-owned title', async () => {
    const title = `Persisted\u0000title\n${'x'.repeat(500)}`
    mocks.resolveReferenceImportAuthority.mockReturnValue({
      chapterNumber: 1,
      title,
      content: 'frozen text',
      contentFingerprint: 'a'.repeat(64),
      stableKey: 'reference:key:1:fingerprint',
    })
    const importReferenceText = vi.fn<(
      text: string, fileName: string, ...args: unknown[]
    ) => Promise<{ success: boolean; docId: string }>>()
      .mockResolvedValue({ success: true, docId: 'reference-doc' })
    mocks.run.mockImplementation(async (operation: (kb: {
      importReferenceText: typeof importReferenceText
    }) => unknown) => operation({ importReferenceText }))
    const invoke = () => rawHandler('kb:import-reference-text')(
      {}, 1, 'run-1', { owner: 'renderer-a', epoch: 3 }, {
        projectId: 'project-A', leaseId: 'lease-A', projectPath: mocks.currentProjectPath,
      },
    )

    await expect(invoke()).resolves.toEqual({ success: true, docId: 'reference-doc' })
    await expect(invoke()).resolves.toEqual({ success: true, docId: 'reference-doc' })

    const labels = importReferenceText.mock.calls.map(call => call[1])
    expect(labels).toHaveLength(2)
    expect(labels[0]).toBe(labels[1])
    expect(Array.from(labels[0])).toHaveLength(160)
    expect(Array.from(labels[0]).every(character => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint > 0x1f && (codePoint < 0x7f || codePoint > 0x9f)
    })).toBe(true)
    expect(labels[0]).toMatch(/^第1章 Persistedtitlex/u)
    expect(labels[0]).toMatch(/\.txt$/u)
  })

  it('rejects a matching project path that omits its session context', async () => {
    await expect(rawHandler('kb:clear-all')({}, 'C:/projects/A'))
      .rejects.toThrow('PROJECT_SESSION_REQUIRED')
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it.each([
    ['kb:import-document', ['book.txt']],
    ['kb:import-folder', ['folder']],
    ['kb:import-text', ['text', 'book.txt']],
    ['kb:import-planning-text', ['text', 'planning.md']],
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
      .rejects.toThrow('PROJECT_CONTEXT_CHANGED')
    await expect(rawHandler(channel)({}, ...args))
      .rejects.toThrow(/PROJECT_(?:CONTEXT|SESSION)_REQUIRED/)
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('forces planning material imports through the FTS-only knowledge path', async () => {
    const importText = vi.fn().mockResolvedValue({ success: true, docId: 'planning-doc' })
    mocks.run.mockImplementation(async operation => operation({ importText }))

    await expect(handler('kb:import-planning-text')(
      {}, '作者设定', 'planning.md', 'C:/projects/A',
    )).resolves.toEqual({ success: true, docId: 'planning-doc' })

    expect(importText).toHaveBeenCalledWith(
      '作者设定',
      'planning.md',
      'C:/projects/A',
      'openai',
      expect.any(Object),
      { mode: 'fts-only' },
    )
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

  function useEmbeddingModel(provider: string, baseUrl: string) {
    mocks.readJsonFile.mockImplementation((filePath: string, fallback: unknown) => {
      if (filePath === 'global.json') return { defaultEmbeddingModelId: 'embedding-model' }
      if (filePath === 'models.json') return [{ id: 'embedding-model', provider, protocol: 'openai', baseUrl, apiKey: '', modelName: 'nomic-embed-text' }]
      return fallback
    })
    const backfillVectors = vi.fn(async () => ({ success: true, processed: 3, failed: 0 }))
    mocks.run.mockImplementation(async (operation: (kb: unknown) => unknown) => operation({
      getKnowledgeStats: async () => ({ totalChunks: 3, vectorDimension: 0 }),
      getVectorlessCount: async () => ({ count: 3 }),
      backfillVectors,
    }))
    return backfillVectors
  }

  it.each([
    ['ollama', 'http://192.168.1.20:11434/v1'],
    ['custom', 'http://localhost:1234/v1'],
    ['custom', 'http://127.0.0.1:1234/v1'],
    ['custom', 'http://[::1]:1234/v1'],
  ])('accepts a keyless %s embedding model at %s for the index', async (provider, baseUrl) => {
    const backfillVectors = useEmbeddingModel(provider, baseUrl)

    await expect(handler('kb:get-vector-rebuild-status')({}, 'C:/projects/A')).resolves.toMatchObject({ embeddingConfigured: true, canRebuild: true })
    await expect(handler('kb:backfill-vectors')({}, 'C:/projects/A')).resolves.toEqual({ success: true, processed: 3, failed: 0 })
    expect(backfillVectors).toHaveBeenCalledWith('C:/projects/A', 'openai', expect.objectContaining({ baseUrl, apiKey: '' }))
  })

  it.each([
    ['ollama', true],
    ['openai', false],
  ] as const)('reads a legacy %s embedding profile saved without an apiKey field', async (provider, configured) => {
    mocks.readJsonFile.mockImplementation((filePath: string, fallback: unknown) => {
      if (filePath === 'global.json') return { defaultEmbeddingModelId: 'embedding-model' }
      if (filePath === 'models.json') return [{ id: 'embedding-model', provider, protocol: 'openai', baseUrl: 'http://192.168.1.20:11434/v1', modelName: 'nomic-embed-text' }]
      return fallback
    })
    mocks.run.mockImplementation(async (operation: (kb: unknown) => unknown) => operation({
      getKnowledgeStats: async () => ({ totalChunks: 3, vectorDimension: 0 }),
      getVectorlessCount: async () => ({ count: 3 }),
    }))

    await expect(handler('kb:get-vector-rebuild-status')({}, 'C:/projects/A')).resolves.toMatchObject({ embeddingConfigured: configured })
  })

  it('still refuses a keyless cloud embedding model without contacting the provider', async () => {
    const backfillVectors = useEmbeddingModel('openai', 'https://api.openai.com/v1')

    await expect(handler('kb:get-vector-rebuild-status')({}, 'C:/projects/A')).resolves.toMatchObject({ embeddingConfigured: false, canRebuild: false })
    await expect(handler('kb:backfill-vectors')({}, 'C:/projects/A')).resolves.toMatchObject({ success: false, errorCode: 'EMBEDDING_MODEL_NOT_CONFIGURED' })
    expect(backfillVectors).not.toHaveBeenCalled()
  })

  it('does not clear project B when a confirmation opened for project A resolves later', async () => {
    // The renderer freezes A before showing the confirmation. By the time the
    // user accepts, the main-process database is already bound to B.
    const confirmedProjectPath = 'C:/projects/A'
    mocks.currentProjectPath = 'C:/projects/B'

    await expect(handler('kb:clear-all')({}, confirmedProjectPath))
      .rejects.toThrow('PROJECT_CONTEXT_CHANGED')
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

// 参照导入失败时运行卡片原样显示 result.error：主进程按导入运行的界面语言说明知识库错误码，码另放在 errorCode（#474 B3）。
describe('reference import failures', () => {
  it.each([
    ['en-US', 'EMBEDDING_RESPONSE_INVALID', 'returned an unusable result'],
    ['zh-CN', 'EMBEDDING_RESPONSE_INVALID', '返回的结果不合格'],
    ['en-US', 'KNOWLEDGE_BASE_TEXT_EMPTY', 'The material is empty'],
    ['zh-CN', 'EMBEDDING_SPACE_REINDEX_REQUIRED', '检查并重建索引'],
  ])('explains %s %s in the run language', async (locale, code, expected) => {
    mocks.getRun.mockReturnValue({ locale })
    mocks.run.mockImplementation(async (operation: (kb: { importReferenceText: () => Promise<unknown> }) => unknown) =>
      operation({ importReferenceText: async () => ({ success: false, error: code }) }))
    const result = await rawHandler('kb:import-reference-text')({}, 1, 'run-1', { owner: 'renderer-a', epoch: 3 }, {
      projectId: 'project-A', leaseId: 'lease-A', projectPath: mocks.currentProjectPath,
    }) as { success: boolean; error: string; errorCode: string }
    expect(result).toMatchObject({ success: false, errorCode: code })
    expect(result.error).toContain(expected)
    expect(result.error).not.toMatch(locale === 'en-US' ? /[A-Z]{3,}_|\p{Script=Han}/u : /[A-Z]{3,}_/u)
    expect(mocks.commitReferenceImportReceipt).not.toHaveBeenCalled()
  })
  // 参照导入的幂等收据与完整性校验码没有作者能照做的建议：给按运行语言的说明，码附在后面供反馈定位。
  it.each([
    ['en-US', 'KNOWLEDGE_BASE_REFERENCE_RECEIPT_CONFLICT', 'could not be written to the knowledge base'],
    ['zh-CN', 'KNOWLEDGE_BASE_REFERENCE_VERIFY_FAILED', '未能写入知识库'],
  ])('summarizes %s %s in the run language and keeps the code', async (locale, code, expected) => {
    mocks.getRun.mockReturnValue({ locale })
    mocks.run.mockImplementation(async (operation: (kb: { importReferenceText: () => Promise<unknown> }) => unknown) =>
      operation({ importReferenceText: async () => ({ success: false, error: code }) }))
    const result = await rawHandler('kb:import-reference-text')({}, 1, 'run-1', { owner: 'renderer-a', epoch: 3 }, {
      projectId: 'project-A', leaseId: 'lease-A', projectPath: mocks.currentProjectPath,
    }) as { success: boolean; error: string; errorCode: string }
    expect(result).toMatchObject({ success: false, errorCode: code })
    expect(result.error).toContain(expected)
    expect(result.error).toContain(code)
    if (locale === 'en-US') expect(result.error).not.toMatch(/\p{Script=Han}/u)
  })
  // 导入运行的授权与收据校验（#474 B1）：先于写入抛出的与知识库交回的码都按导入运行的语言说明。
  it('explains an expired import execution in the run language before anything is written', async () => {
    mocks.getRun.mockReturnValue({ locale: 'en-US' })
    mocks.resolveReferenceImportAuthority.mockImplementationOnce(() => { throw new Error('IMPORT_RUN_EXECUTION_STALE') })
    const result = await rawHandler('kb:import-reference-text')({}, 1, 'run-1', { owner: 'renderer-a', epoch: 3 }, {
      projectId: 'project-A', leaseId: 'lease-A', projectPath: mocks.currentProjectPath,
    })
    expect(result).toEqual({
      success: false,
      errorCode: 'IMPORT_RUN_EXECUTION_STALE',
      error: 'This import was taken over by another window, or it paused after going unresponsive, so this window can no longer write to it. Resume the import from the import dialog.',
    })
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('explains an import-run code returned by the knowledge base in the run language', async () => {
    mocks.getRun.mockReturnValue({ locale: 'zh-CN' })
    mocks.run.mockImplementation(async (operation: (kb: { importReferenceText: () => Promise<unknown> }) => unknown) =>
      operation({ importReferenceText: async () => ({ success: false, error: 'IMPORT_RUN_REFERENCE_UNBOUND' }) }))
    const result = await rawHandler('kb:import-reference-text')({}, 1, 'run-1', { owner: 'renderer-a', epoch: 3 }, {
      projectId: 'project-A', leaseId: 'lease-A', projectPath: mocks.currentProjectPath,
    })
    expect(result).toEqual({
      success: false,
      errorCode: 'IMPORT_RUN_REFERENCE_UNBOUND',
      error: '导入没能继续：校验没有通过（IMPORT_RUN_REFERENCE_UNBOUND）。请重试；如果仍然出现，请把这段说明反馈给我们。',
    })
  })
})
