import { access, copyFile, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceId, type WorkspaceId as WorkspaceIdType } from '@deepseek-ai/dsh-workspace'
import { openNovelStore } from '../src/novel-store.ts'
import type { NovelStore, NovelStoreInitializeRequest } from '../src/novel-store.ts'
import { makeTestWorkspace } from './test-workspace.ts'

const signal = new AbortController().signal
const WORKSPACE_ID = WorkspaceId('workspace-a')

const initialization: NovelStoreInitializeRequest = {
  workspaceId: WORKSPACE_ID,
  title: '潮汐来信',
  language: 'zh-CN',
  genre: '奇幻悬疑',
  plannedChapters: 12,
  targetWordsPerChapter: 3_000,
  creativeStrategy: 'consistency-first',
  structureMode: 'three-act',
  narrativePov: 'third-limited',
  globalGuidance: '保持冷峻而温柔的语气。',
}

async function openedStore(prefix = 'novel-store-'): Promise<{ root: string; store: NovelStore }> {
  const root = await makeTestWorkspace(prefix)
  const store = await openStore(root)
  await store.initialize(initialization, signal)
  return { root, store }
}

const openStores: NovelStore[] = []

async function openStore(root: string, workspaceId: WorkspaceIdType = WORKSPACE_ID): Promise<NovelStore> {
  const store = await openNovelStore(root, workspaceId)
  openStores.push(store)
  return store
}

describe('NovelStore SQLite core', () => {
  let root: string
  let store: NovelStore

  beforeEach(async () => {
    ({ root, store } = await openedStore())
  })

  afterEach(async () => {
    await Promise.all(openStores.map(store => store.dispose()))
    openStores.length = 0
  })

  it('initializes a bound project artifact with stable storage settings', async () => {
    const state = await store.read(signal)

    expect(state).toMatchObject({
      workspaceId: WORKSPACE_ID,
      workspacePath: root,
      globalRevision: 0,
      readOnly: false,
      storage: {
        applicationId: 0x41_4e_4f_56,
        userVersion: 2,
        foreignKeys: true,
        journalMode: 'delete',
        synchronous: 'full',
        lockingMode: 'exclusive',
      },
      project: {
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        title: initialization.title,
        creativeStrategy: initialization.creativeStrategy,
        revision: 0,
      },
      architecture: {
        premise: '',
        characterGraph: '',
        world: '',
        plotOutline: '',
        styleConstraints: '',
        referenceWorks: [],
        revision: 0,
      },
      characters: {
        items: [],
        relationships: [],
        revision: 0,
      },
      chapters: [],
      changes: [],
    })
    expect(state.projectId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(state.project.createdAt).toBe(state.project.updatedAt)

    await expect(store.initialize(initialization, signal)).rejects.toMatchObject({
      code: 'ALREADY_INITIALIZED',
    })
    await expect(readFile(join(root, '.ai-novel', '.gitignore'), 'utf8')).resolves.toContain('novel.db')
  })

  it('commits one aggregate transaction idempotently and records audit', async () => {
    const before = await store.read(signal)
    const { revision: _ignoredProjectRevision, ...projectValue } = before.project
    const change = {
      changeSetId: 'change-project-title',
      operation: 'replace',
      aggregate: { kind: 'project' },
      baseAggregateRevision: before.project.revision,
      baseGlobalRevision: before.globalRevision,
      nextValue: { ...projectValue, title: '雾中灯塔' },
      provenance: { origin: 'manual' },
    } as const

    const receipt = await store.applyChange(change, signal)
    expect(receipt).toEqual({
      changeSetId: change.changeSetId,
      projectId: before.projectId,
      aggregate: { kind: 'project' },
      aggregateRevision: 1,
      globalRevision: 1,
    })

    await expect(store.applyChange(change, signal)).resolves.toEqual(receipt)
    await expect(store.applyChange({
      ...change,
      provenance: {
        origin: 'model',
        sessionId: '123e4567-e89b-42d3-a456-426614174205',
        callId: 'model-call',
        argsHash: 'a'.repeat(64),
      },
    }, signal)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })

    const after = await store.read(signal)
    expect(after.project.title).toBe('雾中灯塔')
    expect(after.project.revision).toBe(1)
    expect(after.globalRevision).toBe(1)
    expect(after.changes).toHaveLength(1)
    expect(after.changes[0]).toMatchObject({
      changeSetId: change.changeSetId,
      operation: 'replace',
      aggregate: { kind: 'project' },
      aggregateRevision: 1,
      globalRevision: 1,
      status: 'committed',
      provenance: { origin: 'manual' },
    })
  })

  it('rejects stale, conflicting idempotent, and invalid changes without mutating state', async () => {
    const state = await store.read(signal)
    const { revision: _ignoredCurrentRevision, ...projectValue } = state.project
    const nextProject = { ...projectValue, title: '第一次修改' }
    const change = {
      changeSetId: 'change-project-once',
      operation: 'replace',
      aggregate: { kind: 'project' },
      baseAggregateRevision: state.project.revision,
      baseGlobalRevision: state.globalRevision,
      nextValue: nextProject,
      provenance: { origin: 'manual' },
    } as const
    await store.applyChange(change, signal)

    const changedState = await store.read(signal)
    await expect(store.applyChange({
      ...change,
      changeSetId: 'stale-project',
      baseAggregateRevision: 0,
      baseGlobalRevision: 0,
    }, signal)).rejects.toMatchObject({ code: 'STALE_REVISION' })

    await expect(store.applyChange({
      ...change,
      nextValue: { ...nextProject, title: '冲突重放' },
    }, signal)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })

    const { revision: _ignoredArchitectureRevision, ...architectureValue } = changedState.architecture
    await expect(store.applyChange({
      changeSetId: 'invalid-architecture',
      operation: 'replace',
      aggregate: { kind: 'architecture' },
      baseAggregateRevision: changedState.architecture.revision,
      baseGlobalRevision: changedState.globalRevision,
      nextValue: { ...architectureValue, referenceWorks: 'invalid' as unknown as readonly string[] },
      provenance: { origin: 'manual' },
    }, signal)).rejects.toMatchObject({ code: 'INVALID_CONTENT' })

    const unchanged = await store.read(signal)
    expect(unchanged.project.title).toBe('第一次修改')
    expect(unchanged.architecture.premise).toBe('')
    expect(unchanged.globalRevision).toBe(1)
    expect(unchanged.changes).toHaveLength(1)
  })

  it('reopens the same project after dispose and releases its exclusive write lock', async () => {
    const state = await store.read(signal)
    const { revision: _ignoredArchitectureRevision, ...architectureValue } = state.architecture
    await store.applyChange({
      changeSetId: 'change-architecture',
      operation: 'replace',
      aggregate: { kind: 'architecture' },
      baseAggregateRevision: state.architecture.revision,
      baseGlobalRevision: state.globalRevision,
      nextValue: {
        ...architectureValue,
        premise: '失联的灯塔守在潮汐中收到未来信件。',
        characterGraph: '灯塔守与送信人隔着时间相望。',
        world: '潮汐每十二小时改写一次记忆。',
        plotOutline: '第一封信、错位回应、真相退潮。',
        styleConstraints: '短句、冷色、海洋意象。',
        referenceWorks: ['灯塔'],
      },
      provenance: { origin: 'manual' },
    }, signal)

    const beforeDispose = await store.read(signal)
    await store.dispose()
    const reopened = await openStore(root)
    const reopenedState = await reopened.read(signal)

    expect(reopenedState).toEqual(beforeDispose)
    await reopened.dispose()
  })

  it('replaces the complete characters collection and one chapter aggregate', async () => {
    const state = await store.read(signal)
    await store.applyChange({
      changeSetId: 'change-characters',
      operation: 'replace',
      aggregate: { kind: 'characters' },
      baseAggregateRevision: state.characters.revision,
      baseGlobalRevision: state.globalRevision,
      nextValue: {
        items: [{
          characterId: 'lin-fan',
          name: '林凡',
          role: '主角',
          summary: '被潮汐选中的灯塔守。',
          goal: '找回失踪的送信人。',
          currentState: '右手残留未来潮光。',
          notes: '不轻易许诺。',
        }],
        relationships: [{
          fromCharacterId: 'lin-fan',
          toCharacterId: 'lin-fan',
          relation: '自我冲突',
          notes: '记忆与现实互相拉扯。',
        }],
      },
      provenance: { origin: 'manual' },
    }, signal)

    const withCharacters = await store.read(signal)
    expect(withCharacters.characters).toMatchObject({
      revision: 1,
      items: [{ characterId: 'lin-fan', name: '林凡' }],
      relationships: [{ relation: '自我冲突' }],
    })

    const chapterValue = {
      chapter: 1,
      title: '第一封信',
      purpose: '建立日常与第一次异常。',
      plotBeats: ['潮汐涨落', '收到信'],
      characters: ['lin-fan'],
      keyEvents: ['未来信件抵达'],
      suspense: '寄信人知道灯塔守会读信。',
      status: 'planned',
    } as const
    await expect(store.applyChange({
      changeSetId: 'change-chapter-duplicate-character',
      operation: 'replace',
      aggregate: { kind: 'chapter', chapter: 1 },
      baseAggregateRevision: 0,
      baseGlobalRevision: withCharacters.globalRevision,
      nextValue: { ...chapterValue, characters: ['lin-fan', 'lin-fan'] },
      provenance: { origin: 'manual' },
    }, signal)).rejects.toMatchObject({ code: 'INVALID_CONTENT' })

    await expect(store.applyChange({
      changeSetId: 'change-chapter-unknown-character',
      operation: 'replace',
      aggregate: { kind: 'chapter', chapter: 1 },
      baseAggregateRevision: 0,
      baseGlobalRevision: withCharacters.globalRevision,
      nextValue: { ...chapterValue, characters: ['unknown-character'] },
      provenance: { origin: 'manual' },
    }, signal)).rejects.toMatchObject({ code: 'INVALID_CONTENT' })
    await expect((await store.read(signal)).chapters).toEqual([])

    await store.applyChange({
      changeSetId: 'change-chapter-1',
      operation: 'replace',
      aggregate: { kind: 'chapter', chapter: 1 },
      baseAggregateRevision: 0,
      baseGlobalRevision: withCharacters.globalRevision,
      nextValue: chapterValue,
      provenance: { origin: 'manual' },
    }, signal)

    const taskValue = {
      taskId: 'task-first-chapter',
      kind: 'chapter',
      stage: 'drafting',
      status: 'running',
      failure: '',
      resumeCursor: 'chapter:1:draft:v1',
      createdAt: '2026-08-18T00:00:00.000Z',
      updatedAt: '2026-08-18T00:00:00.000Z',
    } as const
    const beforeTask = await store.read(signal)
    await store.applyChange({
      changeSetId: 'change-task-first-chapter',
      operation: 'replace',
      aggregate: { kind: 'task', taskId: taskValue.taskId },
      baseAggregateRevision: 0,
      baseGlobalRevision: beforeTask.globalRevision,
      nextValue: taskValue,
      provenance: { origin: 'manual' },
    }, signal)

    const withTask = await store.read(signal)
    expect(withTask.tasks).toEqual([{ ...taskValue, revision: 1 }])
    expect(withTask.globalRevision).toBe(3)

    const withChapter = await store.read(signal)
    expect(withChapter.chapters).toEqual([{ ...chapterValue, revision: 1 }])
    expect(withChapter.globalRevision).toBe(3)
    expect(withChapter.changes.map(change => change.aggregate.kind)).toEqual(['characters', 'chapter', 'task'])

    const beforeCharacterRemoval = await store.read(signal)
    await expect(store.applyChange({
      changeSetId: 'change-remove-referenced-character',
      operation: 'replace',
      aggregate: { kind: 'characters' },
      baseAggregateRevision: beforeCharacterRemoval.characters.revision,
      baseGlobalRevision: beforeCharacterRemoval.globalRevision,
      nextValue: { items: [], relationships: [] },
      provenance: { origin: 'manual' },
    }, signal)).rejects.toMatchObject({ code: 'INVALID_CONTENT' })
    const afterRejectedRemoval = await store.read(signal)
    expect(afterRejectedRemoval.characters.items).toHaveLength(1)
    expect(afterRejectedRemoval.chapters[0]?.characters).toEqual(['lin-fan'])
    expect(afterRejectedRemoval.globalRevision).toBe(beforeCharacterRemoval.globalRevision)

    await store.applyChange({
      changeSetId: 'change-character-while-cast',
      operation: 'replace',
      aggregate: { kind: 'characters' },
      baseAggregateRevision: afterRejectedRemoval.characters.revision,
      baseGlobalRevision: afterRejectedRemoval.globalRevision,
      nextValue: {
        items: [{
          ...afterRejectedRemoval.characters.items[0]!,
          currentState: '潮光已沉淀为稳定印记。',
        }],
        relationships: afterRejectedRemoval.characters.relationships,
      },
      provenance: { origin: 'manual' },
    }, signal)

    const updatedCastCharacter = await store.read(signal)
    expect(updatedCastCharacter.characters.items[0]?.currentState).toBe('潮光已沉淀为稳定印记。')
    expect(updatedCastCharacter.chapters[0]?.characters).toEqual(['lin-fan'])
  })

  it('uses one exclusive writer and keeps a mismatched workspace binding read-only', async () => {
    await expect(openNovelStore(root, WORKSPACE_ID)).rejects.toMatchObject({ code: 'WRITE_LOCKED' })

    await store.dispose()
    const otherWorkspace = await openStore(root, WorkspaceId('workspace-b'))
    const state = await otherWorkspace.read(signal)
    expect(state.readOnly).toBe(true)
    const { revision: _ignoredProjectRevision, ...projectValue } = state.project
    await expect(otherWorkspace.applyChange({
      changeSetId: 'mismatched-writer',
      operation: 'replace',
      aggregate: { kind: 'project' },
      baseAggregateRevision: state.project.revision,
      baseGlobalRevision: state.globalRevision,
      nextValue: projectValue,
      provenance: { origin: 'manual' },
    }, signal)).rejects.toMatchObject({ code: 'WORKSPACE_MISMATCH' })
    await otherWorkspace.dispose()
  })

  it('refuses to overwrite an unexpected ignore file', async () => {
    const emptyRoot = await makeTestWorkspace('novel-store-gitignore-')
    await mkdir(join(emptyRoot, '.ai-novel'), { recursive: true })
    await writeFile(join(emptyRoot, '.ai-novel', '.gitignore'), 'user-owned\n', 'utf8')

    await expect(openNovelStore(emptyRoot, WORKSPACE_ID)).rejects.toMatchObject({ code: 'INVALID_CONTENT' })
  })

  it('rejects a foreign or unversioned SQLite database', async () => {
    const foreignRoot = await makeTestWorkspace('novel-store-foreign-db-')
    await mkdir(join(foreignRoot, '.ai-novel'), { recursive: true })
    await copyFile(join(root, '.ai-novel', '.gitignore'), join(foreignRoot, '.ai-novel', '.gitignore'))
    const { DatabaseSync } = await import('node:sqlite')
    const foreign = new DatabaseSync(join(foreignRoot, '.ai-novel', 'novel.db'))
    foreign.exec('CREATE TABLE outsider (id INTEGER PRIMARY KEY) STRICT')
    foreign.close()

    await expect(openNovelStore(foreignRoot, WORKSPACE_ID)).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' })
  })

  it('does not recreate a missing ignore file when an existing database is opened', async () => {
    const ignorePath = join(root, '.ai-novel', '.gitignore')
    await store.dispose()
    await rm(ignorePath)

    await expect(openNovelStore(root, WORKSPACE_ID)).rejects.toMatchObject({ code: 'INVALID_CONTENT' })
    await expect(access(ignorePath)).rejects.toThrow()
  })

  it('recovers an empty schema created before initialization was committed', async () => {
    const interruptedRoot = await makeTestWorkspace('novel-store-interrupted-')
    const interrupted = await openStore(interruptedRoot)
    await interrupted.dispose()

    const reopened = await openStore(interruptedRoot)
    await reopened.initialize(initialization, signal)
    const state = await reopened.read(signal)
    expect(state.project.title).toBe(initialization.title)
    await reopened.dispose()
  })

  it('rejects initialization that claims a different workspace than the opened store', async () => {
    const emptyRoot = await makeTestWorkspace('novel-store-binding-')
    const emptyStore = await openStore(emptyRoot)

    await expect(emptyStore.initialize({
      ...initialization,
      workspaceId: WorkspaceId('123e4567-e89b-42d3-a456-426614174204'),
    }, signal)).rejects.toMatchObject({ code: 'WORKSPACE_MISMATCH' })
    await emptyStore.dispose()
  })

  it('rejects a project directory that escapes the workspace through a link', async () => {
    const linkedRoot = await makeTestWorkspace('novel-store-link-root-')
    const outside = await makeTestWorkspace('novel-store-link-outside-')
    await symlink(outside, join(linkedRoot, '.ai-novel'), 'junction')

    await expect(openNovelStore(linkedRoot, WORKSPACE_ID)).rejects.toMatchObject({ code: 'PATH_REJECTED' })
  })

  it('rejects a linked database file even when its target is a valid project', async () => {
    const databasePath = join(root, '.ai-novel', 'novel.db')
    const outsideDatabase = join(await makeTestWorkspace('novel-store-db-target-'), 'novel.db')
    await store.dispose()
    await copyFile(databasePath, outsideDatabase)
    await rm(databasePath)
    await symlink(outsideDatabase, databasePath, 'file')

    await expect(openNovelStore(root, WORKSPACE_ID)).rejects.toMatchObject({ code: 'PATH_REJECTED' })
  })
})
