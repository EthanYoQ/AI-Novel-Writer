import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  currentProjectPath: 'C:/projects/A',
  handlers: new Map<string, IpcHandler>(),
  closeProjectDatabase: vi.fn(),
  invalidateCurrentSession: vi.fn(),
  assertCurrentProjectContext: vi.fn(),
  projectCoreGet: vi.fn(),
  projectCoreUpdate: vi.fn(),
  projectClearGeneratedData: vi.fn(() => ({ cleared: [] })),
  blueprintGetAll: vi.fn(() => []),
  blueprintUpsert: vi.fn(),
  blueprintUpsertMany: vi.fn(),
  blueprintDelete: vi.fn(),
  blueprintClearAll: vi.fn(),
  characterGetAll: vi.fn(() => []),
  characterSaveAll: vi.fn(),
  characterDelete: vi.fn(),
  draftGetFull: vi.fn(() => ({
    id: 1,
    content: mocks.currentProjectPath.endsWith('/A') ? 'A content' : 'B content',
  })),
  draftGetMeta: vi.fn(),
  draftUpdateContent: vi.fn(),
  postProcessCreateRun: vi.fn(() => 'run-1'),
  postProcessGetLatestRun: vi.fn(),
  postProcessGetSteps: vi.fn(() => []),
  postProcessMarkStepOk: vi.fn(),
  postProcessMarkStepFailed: vi.fn(),
  postProcessIsAllCriticalPassed: vi.fn(() => true),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler)
    }),
  },
}))

vi.mock('../../database', () => ({
  closeProjectDatabase: mocks.closeProjectDatabase,
  getCurrentProjectPath: () => mocks.currentProjectPath,
  getProjectDb: vi.fn(),
}))

vi.mock('../../services/project-access', () => ({
  projectAccess: {
    invalidateCurrentSession: mocks.invalidateCurrentSession,
    assertCurrentProjectContext: mocks.assertCurrentProjectContext,
  },
}))

vi.mock('../../repositories/project-core-repository', () => ({
  ProjectCoreRepository: {
    get: mocks.projectCoreGet,
    update: mocks.projectCoreUpdate,
  },
}))

vi.mock('../../repositories/project-clear-repository', () => ({
  ProjectClearRepository: {
    clearGeneratedData: mocks.projectClearGeneratedData,
  },
}))

vi.mock('../../repositories/character-repository', () => ({
  CharacterRepository: {
    getAll: mocks.characterGetAll,
    saveAll: mocks.characterSaveAll,
    delete: mocks.characterDelete,
  },
}))

vi.mock('../../repositories/blueprint-repository', () => ({
  BlueprintRepository: {
    getAll: mocks.blueprintGetAll,
    upsert: mocks.blueprintUpsert,
    upsertMany: mocks.blueprintUpsertMany,
    delete: mocks.blueprintDelete,
    clearAll: mocks.blueprintClearAll,
  },
}))

vi.mock('../../repositories/post-process-repository', () => ({
  PostProcessRepository: {
    createRun: mocks.postProcessCreateRun,
    getLatestRun: mocks.postProcessGetLatestRun,
    getSteps: mocks.postProcessGetSteps,
    markStepOk: mocks.postProcessMarkStepOk,
    markStepFailed: mocks.postProcessMarkStepFailed,
    isAllCriticalPassed: mocks.postProcessIsAllCriticalPassed,
  },
}))

vi.mock('../../repositories/draft-repository', () => ({
  DraftRepository: {
    create: vi.fn(() => 1),
    listByChapter: vi.fn(() => []),
    getMeta: mocks.draftGetMeta,
    getFull: mocks.draftGetFull,
    getLatestByChapter: vi.fn(),
    getFinalizedByChapter: vi.fn(),
    getMaxFinalizedChapter: vi.fn(() => 0),
    getNextVersion: vi.fn(() => 1),
    updateStatus: vi.fn(),
    updateContent: mocks.draftUpdateContent,
    delete: vi.fn(),
  },
}))

import { registerDatabaseController } from '../db-controller'

function currentSession() {
  return {
    projectId: `project-${mocks.currentProjectPath.split('/').at(-1)}`,
    leaseId: `lease-${mocks.currentProjectPath.split('/').at(-1)}`,
    projectPath: mocks.currentProjectPath,
  }
}

function rawHandler(channel: string): IpcHandler {
  const registered = mocks.handlers.get(channel)
  if (!registered) throw new Error(`Missing IPC handler: ${channel}`)
  return registered
}

function handler(channel: string): IpcHandler {
  const registered = rawHandler(channel)
  return async (event, ...args) => registered(event, ...args, currentSession())
}

function blueprint() {
  return {
    chapterNumber: 1,
    title: '第一章',
    role: '发展',
    purpose: '',
    keyEvents: '',
    characters: [],
    suspenseHook: '',
    userGuidance: '',
    notes: '',
    notesUpdatedAt: '',
  }
}

beforeAll(() => {
  registerDatabaseController()
})

beforeEach(() => {
  mocks.currentProjectPath = 'C:/projects/A'
  vi.clearAllMocks()
  mocks.assertCurrentProjectContext.mockImplementation((context: {
    projectPath?: string
  } | undefined, currentProjectPath: string) => {
    if (!context?.projectPath) throw new Error('缺少项目会话上下文，已拒绝操作')
    if (context.projectPath !== currentProjectPath) {
      throw new Error('项目会话与当前数据库不匹配，已拒绝操作')
    }
    return { rootPath: currentProjectPath }
  })
})

describe('database controller project context guard', () => {
  it('rejects a matching path that omits the required project session context', async () => {
    const result = await rawHandler('db:character-delete')(
      {},
      'A character',
      'C:/projects/A',
    )

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('项目会话'),
    })
    expect(mocks.characterDelete).not.toHaveBeenCalled()
  })

  it('rejects A workflow writes and post-process marks after the user switches to B', async () => {
    mocks.currentProjectPath = 'C:/projects/B'

    const archResult = await handler('db:project-core-update')(
      {},
      { premise: 'A project result' },
      'C:/projects/A',
    )
    const characterResult = await handler('db:character-save-all')(
      {},
      [{ name: 'A character' }],
      undefined,
      'C:/projects/A',
    )
    const createRunResult = await handler('db:post-process-create-run')(
      {},
      {
        triggerSourceType: 'unknown',
        triggerSourceId: 'arch_characters',
        sourceLabel: 'A architecture',
        steps: [],
      },
      'C:/projects/A',
    )
    const markResult = await handler('db:post-process-mark-step-ok')(
      {},
      'run-A',
      'extract_character_cards',
      'C:/projects/A',
    )

    expect(archResult).toMatchObject({ success: false })
    expect(characterResult).toMatchObject({ success: false })
    expect(createRunResult).toMatchObject({ success: false })
    expect(markResult).toMatchObject({ success: false })
    expect(mocks.projectCoreUpdate).not.toHaveBeenCalled()
    expect(mocks.characterSaveAll).not.toHaveBeenCalled()
    expect(mocks.postProcessCreateRun).not.toHaveBeenCalled()
    expect(mocks.postProcessMarkStepOk).not.toHaveBeenCalled()
  })

  it('requires an explicit matching project identity for project-level writes', async () => {
    const coreWithoutIdentity = await handler('db:project-core-update')(
      {},
      { premise: 'missing identity' },
    )
    const clearWithoutIdentity = await handler('db:project-clear-generated-data')(
      {},
      { generatedText: true },
    )
    const coreWithStaleIdentity = await handler('db:project-core-update')(
      {},
      { premise: 'stale identity' },
      'C:/projects/B',
    )
    const clearWithStaleIdentity = await handler('db:project-clear-generated-data')(
      {},
      { generatedText: true },
      'C:/projects/B',
    )

    expect(coreWithoutIdentity).toMatchObject({ success: false })
    expect(clearWithoutIdentity).toMatchObject({ success: false })
    expect(coreWithStaleIdentity).toMatchObject({ success: false })
    expect(clearWithStaleIdentity).toMatchObject({ success: false })
    expect(mocks.projectCoreUpdate).not.toHaveBeenCalled()
    expect(mocks.projectClearGeneratedData).not.toHaveBeenCalled()
  })

  it('allows project-level writes with the explicitly active project identity', async () => {
    await expect(handler('db:project-core-update')(
      {},
      { premise: 'same project' },
      'C:/projects/A',
    )).resolves.toEqual({ success: true })
    await expect(handler('db:project-clear-generated-data')(
      {},
      { generatedText: true },
      'C:/projects/A',
    )).resolves.toEqual({ success: true, cleared: [] })

    expect(mocks.projectCoreUpdate).toHaveBeenCalledOnce()
    expect(mocks.projectClearGeneratedData).toHaveBeenCalledOnce()
  })

  it('allows the same operations while the expected project remains open', async () => {
    const archResult = await handler('db:project-core-update')(
      {},
      { premise: 'A project result' },
      'C:/projects/A',
    )
    const characterResult = await handler('db:character-save-all')(
      {},
      [{ name: 'A character' }],
      undefined,
      'C:/projects/A',
    )
    const createRunResult = await handler('db:post-process-create-run')(
      {},
      {
        triggerSourceType: 'unknown',
        triggerSourceId: 'arch_characters',
        sourceLabel: 'A architecture',
        steps: [],
      },
      'C:/projects/A',
    )
    const markResult = await handler('db:post-process-mark-step-ok')(
      {},
      'run-A',
      'extract_character_cards',
      'C:/projects/A',
    )

    expect(archResult).toEqual({ success: true })
    expect(characterResult).toEqual({ success: true })
    expect(createRunResult).toEqual({ success: true, id: 'run-1' })
    expect(markResult).toEqual({ success: true })
    expect(mocks.projectCoreUpdate).toHaveBeenCalledOnce()
    expect(mocks.characterSaveAll).toHaveBeenCalledOnce()
    expect(mocks.postProcessCreateRun).toHaveBeenCalledOnce()
    expect(mocks.postProcessMarkStepOk).toHaveBeenCalledOnce()
  })

  it('rejects stale character and blueprint reads or writes before any repository access', async () => {
    mocks.currentProjectPath = 'C:/projects/B'

    await expect(handler('db:character-get-all')({}, 'C:/projects/A'))
      .rejects.toThrow(/项目上下文已切换/)
    const characterDelete = await handler('db:character-delete')(
      {},
      'A character',
      'C:/projects/A',
    )
    await expect(handler('db:blueprint-get-all')({}, 'C:/projects/A'))
      .rejects.toThrow(/项目上下文已切换/)
    const blueprintUpsert = await handler('db:blueprint-upsert')(
      {},
      blueprint(),
      'C:/projects/A',
    )
    const blueprintDelete = await handler('db:blueprint-delete')(
      {},
      1,
      'C:/projects/A',
    )
    const blueprintClear = await handler('db:blueprint-clear-all')(
      {},
      'C:/projects/A',
    )

    expect(characterDelete).toMatchObject({ success: false })
    expect(blueprintUpsert).toMatchObject({ success: false })
    expect(blueprintDelete).toMatchObject({ success: false })
    expect(blueprintClear).toMatchObject({ success: false })
    expect(mocks.characterGetAll).not.toHaveBeenCalled()
    expect(mocks.characterDelete).not.toHaveBeenCalled()
    expect(mocks.blueprintGetAll).not.toHaveBeenCalled()
    expect(mocks.blueprintUpsert).not.toHaveBeenCalled()
    expect(mocks.blueprintDelete).not.toHaveBeenCalled()
    expect(mocks.blueprintClearAll).not.toHaveBeenCalled()
  })

  it('allows same-project character and blueprint access with an explicit context', async () => {
    await expect(handler('db:character-get-all')({}, 'C:/projects/A')).resolves.toEqual([])
    expect(await handler('db:character-delete')({}, 'A character', 'C:/projects/A'))
      .toEqual({ success: true })
    await expect(handler('db:blueprint-get-all')({}, 'C:/projects/A')).resolves.toEqual([])
    expect(await handler('db:blueprint-upsert')(
      {},
      blueprint(),
      'C:/projects/A',
    )).toEqual({ success: true })
    expect(await handler('db:blueprint-delete')({}, 1, 'C:/projects/A'))
      .toEqual({ success: true })
    expect(await handler('db:blueprint-clear-all')({}, 'C:/projects/A'))
      .toEqual({ success: true })

    expect(mocks.characterGetAll).toHaveBeenCalledOnce()
    expect(mocks.characterDelete).toHaveBeenCalledOnce()
    expect(mocks.blueprintGetAll).toHaveBeenCalledOnce()
    expect(mocks.blueprintUpsert).toHaveBeenCalledOnce()
    expect(mocks.blueprintDelete).toHaveBeenCalledOnce()
    expect(mocks.blueprintClearAll).toHaveBeenCalledOnce()
  })

  it('keeps the same draft id isolated between project A and B and rejects a stale A write', async () => {
    await expect(handler('db:draft-get-full')({}, 1, 'C:/projects/A'))
      .resolves.toMatchObject({ id: 1, content: 'A content' })

    mocks.currentProjectPath = 'C:/projects/B'
    await expect(handler('db:draft-get-full')({}, 1, 'C:/projects/B'))
      .resolves.toMatchObject({ id: 1, content: 'B content' })
    await expect(handler('db:draft-get-full')({}, 1, 'C:/projects/A'))
      .rejects.toThrow(/项目上下文已切换/)
    const staleWrite = await handler('db:draft-update-content')(
      {},
      1,
      'A overwrite',
      11,
      'C:/projects/A',
    )

    expect(staleWrite).toMatchObject({ success: false })
    expect(mocks.draftUpdateContent).not.toHaveBeenCalled()
  })

  it('rejects content updates for finalized database drafts', async () => {
    mocks.draftGetMeta.mockReturnValueOnce({
      id: 1,
      chapterNumber: 1,
      version: 2,
      status: 'finalized',
    })

    await expect(handler('db:draft-update-content')(
      {},
      1,
      'attempted overwrite',
      19,
      'C:/projects/A',
    )).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('已定稿正文为只读内容'),
    })
    expect(mocks.draftUpdateContent).not.toHaveBeenCalled()
  })

  it('rejects draft access that omits the required project identity', async () => {
    await expect(rawHandler('db:draft-get-full')({}, 1))
      .rejects.toThrow(/缺少项目会话上下文/)
    expect(mocks.draftGetFull).not.toHaveBeenCalled()
  })

  it('closes only the explicitly matched project database', async () => {
    await expect(handler('db:close')({}, 'C:/projects/A'))
      .resolves.toEqual({ success: true })
    expect(mocks.closeProjectDatabase).toHaveBeenCalledOnce()
    expect(mocks.invalidateCurrentSession).toHaveBeenCalledOnce()

    mocks.closeProjectDatabase.mockClear()
    mocks.currentProjectPath = 'C:/projects/B'
    await expect(handler('db:close')({}, 'C:/projects/A'))
      .resolves.toMatchObject({ success: false, error: expect.stringContaining('项目上下文已切换') })
    await expect(rawHandler('db:close')({}))
      .resolves.toMatchObject({ success: false, error: expect.stringContaining('项目会话上下文') })
    expect(mocks.closeProjectDatabase).not.toHaveBeenCalled()
    expect(mocks.invalidateCurrentSession).toHaveBeenCalledOnce()
  })
})
