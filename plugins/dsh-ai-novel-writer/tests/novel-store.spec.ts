import { access, copyFile, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceId, type WorkspaceId as WorkspaceIdType } from '@deepseek-ai/dsh-workspace'
import { openNovelStore, recoverNovelStoreBinding } from '../src/novel-store.ts'
import type { NovelProposalRequest, NovelStore, NovelStoreInitializeRequest } from '../src/novel-store.ts'
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

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function proposalRequest(payload: unknown): NovelProposalRequest {
  return {
    sessionId: 'clone-receipt-session',
    callId: 'clone-receipt-call',
    argsHash: createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex'),
    payload,
  }
}

function downgradeDatabaseToV2(root: string): void {
  const database = new DatabaseSync(join(root, '.ai-novel', 'novel.db'))
  try {
    database.exec('DROP TABLE chapter_finals')
    database.exec('ALTER TABLE artifacts DROP COLUMN summary')
    database.exec('DROP TABLE proposal_items')
    database.exec('ALTER TABLE proposals DROP COLUMN parent_proposal_id')
    database.exec('ALTER TABLE proposals DROP COLUMN parent_item_id')
    database.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run()
    database.exec('PRAGMA user_version = 2')
  } finally {
    database.close()
  }
}

async function holdExternalExclusiveWriteLock(databasePath: string): Promise<ChildProcessWithoutNullStreams> {
  const script = `
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(process.env.AI_NOVEL_LOCK_DATABASE)
db.exec('PRAGMA foreign_keys = ON')
db.exec('PRAGMA journal_mode = DELETE')
db.exec('PRAGMA synchronous = FULL')
db.exec('PRAGMA locking_mode = EXCLUSIVE')
db.exec('BEGIN IMMEDIATE')
process.stdout.write('locked\\n')
process.stdin.resume()
process.stdin.once('end', () => {
  db.exec('ROLLBACK')
  db.close()
})
`
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
    env: { ...process.env, AI_NOVEL_LOCK_DATABASE: databasePath },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  await new Promise<void>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const fail = (error: Error): void => {
      child.stdout.removeAllListeners('data')
      child.stderr.removeAllListeners('data')
      child.removeAllListeners('error')
      child.removeAllListeners('exit')
      reject(error)
    }
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
      if (stdout.includes('locked\n')) resolve()
    })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', error => { fail(error) })
    child.once('exit', code => { fail(new Error(`external SQLite lock process exited before locking (${code}): ${stderr}`)) })
  })
  return child
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
        userVersion: 4,
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

  it('fails closed when a second OS process holds the database write lock, then recovers after release', async () => {
    await store.dispose()
    const child = await holdExternalExclusiveWriteLock(join(root, '.ai-novel', 'novel.db'))
    try {
      await expect(openNovelStore(root, WORKSPACE_ID)).rejects.toMatchObject({ code: 'WRITE_LOCKED' })
    } finally {
      child.stdin.end()
      await once(child, 'exit')
    }
    const reopened = await openStore(root)
    expect((await reopened.read(signal)).readOnly).toBe(false)
    await reopened.dispose()
  })

  it('requires an explicit re-attach before a moved workspace can write without changing the project identity', async () => {
    const movedWorkspace = WorkspaceId('123e4567-e89b-42d3-a456-426614174202')
    const before = await store.read(signal)
    await store.dispose()

    const detached = await openStore(root, movedWorkspace)
    expect((await detached.read(signal)).readOnly).toBe(true)
    await detached.dispose()

    await expect(recoverNovelStoreBinding(root, movedWorkspace, 'reattach', signal)).resolves.toEqual({
      mode: 'reattach',
      projectId: before.projectId,
      workspaceId: movedWorkspace,
    })

    const reattached = await openStore(root, movedWorkspace)
    const rebound = await reattached.read(signal)
    expect(rebound).toMatchObject({
      projectId: before.projectId,
      workspaceId: movedWorkspace,
      workspacePath: root,
      readOnly: false,
      project: before.project,
      changes: before.changes,
    })
    const { revision: _ignoredProjectRevision, ...projectValue } = rebound.project
    await expect(reattached.applyChange({
      changeSetId: 'reattached-project-write',
      operation: 'replace',
      aggregate: { kind: 'project' },
      baseAggregateRevision: rebound.project.revision,
      baseGlobalRevision: rebound.globalRevision,
      nextValue: { ...projectValue, title: '重新绑定后的潮汐来信' },
      provenance: { origin: 'manual' },
    }, signal)).resolves.toMatchObject({ globalRevision: rebound.globalRevision + 1 })
    await reattached.dispose()
  })

  it('recovers an explicitly re-attached V2 mismatched binding into V3 without losing its content', async () => {
    const movedWorkspace = WorkspaceId('123e4567-e89b-42d3-a456-426614174204')
    const before = await store.read(signal)
    const { revision: _ignoredProjectRevision, ...projectValue } = before.project
    await store.applyChange({
      changeSetId: 'v2-reattach-content',
      operation: 'replace',
      aggregate: { kind: 'project' },
      baseAggregateRevision: before.project.revision,
      baseGlobalRevision: before.globalRevision,
      nextValue: { ...projectValue, title: 'V2 重绑定后仍保留的标题' },
      provenance: { origin: 'manual' },
    }, signal)
    const source = await store.read(signal)
    await store.dispose()
    downgradeDatabaseToV2(root)

    const detached = await openStore(root, movedWorkspace)
    expect(await detached.read(signal)).toMatchObject({
      projectId: source.projectId,
      workspaceId: WORKSPACE_ID,
      readOnly: true,
      storage: { userVersion: 2 },
      project: source.project,
      changes: source.changes,
    })
    const { revision: _ignoredDetachedProjectRevision, ...detachedProjectValue } = source.project
    await expect(detached.applyChange({
      changeSetId: 'v2-read-only-reattach-write',
      operation: 'replace',
      aggregate: { kind: 'project' },
      baseAggregateRevision: source.project.revision,
      baseGlobalRevision: source.globalRevision,
      nextValue: detachedProjectValue,
      provenance: { origin: 'manual' },
    }, signal)).rejects.toMatchObject({ code: 'WORKSPACE_MISMATCH' })
    await detached.dispose()
    await expect(recoverNovelStoreBinding(root, movedWorkspace, 'reattach', signal)).resolves.toEqual({
      mode: 'reattach', projectId: source.projectId, workspaceId: movedWorkspace,
    })
    const recovered = await openStore(root, movedWorkspace)
    expect(await recovered.read(signal)).toMatchObject({
      projectId: source.projectId,
      workspaceId: movedWorkspace,
      readOnly: false,
      storage: { userVersion: 4 },
      project: source.project,
      changes: source.changes,
    })
    await recovered.dispose()
  })

  it('recovers an explicitly cloned V2 mismatched binding into V3 with a new project identity and retained content', async () => {
    const clonedWorkspace = WorkspaceId('123e4567-e89b-42d3-a456-426614174205')
    const before = await store.read(signal)
    const { revision: _ignoredProjectRevision, ...projectValue } = before.project
    await store.applyChange({
      changeSetId: 'v2-clone-content',
      operation: 'replace',
      aggregate: { kind: 'project' },
      baseAggregateRevision: before.project.revision,
      baseGlobalRevision: before.globalRevision,
      nextValue: { ...projectValue, title: 'V2 克隆后仍保留的标题' },
      provenance: { origin: 'manual' },
    }, signal)
    const source = await store.read(signal)
    await store.dispose()
    downgradeDatabaseToV2(root)

    const detached = await openStore(root, clonedWorkspace)
    expect(await detached.read(signal)).toMatchObject({
      projectId: source.projectId,
      workspaceId: WORKSPACE_ID,
      readOnly: true,
      storage: { userVersion: 2 },
      project: source.project,
      changes: source.changes,
    })
    const { revision: _ignoredDetachedProjectRevision, ...detachedProjectValue } = source.project
    await expect(detached.applyChange({
      changeSetId: 'v2-read-only-clone-write',
      operation: 'replace',
      aggregate: { kind: 'project' },
      baseAggregateRevision: source.project.revision,
      baseGlobalRevision: source.globalRevision,
      nextValue: detachedProjectValue,
      provenance: { origin: 'manual' },
    }, signal)).rejects.toMatchObject({ code: 'WORKSPACE_MISMATCH' })
    await detached.dispose()
    const clone = await recoverNovelStoreBinding(root, clonedWorkspace, 'clone', signal)
    expect(clone).toMatchObject({ mode: 'clone', workspaceId: clonedWorkspace })
    expect(clone.projectId).not.toBe(source.projectId)
    const recovered = await openStore(root, clonedWorkspace)
    expect(await recovered.read(signal)).toMatchObject({
      projectId: clone.projectId,
      workspaceId: clonedWorkspace,
      readOnly: false,
      storage: { userVersion: 4 },
      project: source.project,
      changes: source.changes,
    })
    await recovered.dispose()
  })

  it('keeps a copied database read-only until an explicit clone re-ids its project identity', async () => {
    const copiedRoot = await makeTestWorkspace('novel-store-copied-db-')
    const copiedWorkspace = WorkspaceId('123e4567-e89b-42d3-a456-426614174203')
    const beforeChange = await store.read(signal)
    const { revision: _ignoredProjectRevision, ...projectValue } = beforeChange.project
    await store.applyChange({
      changeSetId: 'copied-project-change',
      operation: 'replace',
      aggregate: { kind: 'project' },
      baseAggregateRevision: beforeChange.project.revision,
      baseGlobalRevision: beforeChange.globalRevision,
      nextValue: { ...projectValue, title: '复制前已保存的潮汐来信' },
      provenance: { origin: 'manual' },
    }, signal)
    const beforeProposal = await store.read(signal)
    const { revision: _ignoredArchitectureRevision, ...architectureValue } = beforeProposal.architecture
    const appliedProposal = await store.submitProposal(proposalRequest({
      changes: [{
        changeSetId: 'copied-applied-proposal',
        aggregate: { kind: 'architecture' },
        baseAggregateRevision: beforeProposal.architecture.revision,
        baseGlobalRevision: beforeProposal.globalRevision,
        nextValue: { ...architectureValue, premise: '克隆后收据必须属于新项目。' },
      }],
    }), signal)
    await store.applyProposal(appliedProposal.proposal.proposalId, signal)
    const original = await store.read(signal)
    const originalReceipt = original.proposals[0]?.items[0]?.receipt
    expect(originalReceipt !== undefined && 'projectId' in originalReceipt ? originalReceipt.projectId : undefined).toBe(original.projectId)
    await store.dispose()
    await mkdir(join(copiedRoot, '.ai-novel'), { recursive: true })
    await copyFile(join(root, '.ai-novel', '.gitignore'), join(copiedRoot, '.ai-novel', '.gitignore'))
    await copyFile(join(root, '.ai-novel', 'novel.db'), join(copiedRoot, '.ai-novel', 'novel.db'))

    const detachedCopy = await openStore(copiedRoot, copiedWorkspace)
    expect((await detachedCopy.read(signal)).readOnly).toBe(true)
    await detachedCopy.dispose()

    const clone = await recoverNovelStoreBinding(copiedRoot, copiedWorkspace, 'clone', signal)
    expect(clone).toMatchObject({ mode: 'clone', workspaceId: copiedWorkspace })
    expect(clone.projectId).not.toBe(original.projectId)

    const clonedStore = await openStore(copiedRoot, copiedWorkspace)
    const cloned = await clonedStore.read(signal)
    expect(cloned).toMatchObject({
      projectId: clone.projectId,
      workspaceId: copiedWorkspace,
      readOnly: false,
    })
    expect({
      globalRevision: cloned.globalRevision,
      project: cloned.project,
      architecture: cloned.architecture,
      characters: cloned.characters,
      chapters: cloned.chapters,
      tasks: cloned.tasks,
      changes: cloned.changes,
      migration: cloned.migration,
    }).toEqual({
      globalRevision: original.globalRevision,
      project: original.project,
      architecture: original.architecture,
      characters: original.characters,
      chapters: original.chapters,
      tasks: original.tasks,
      changes: original.changes,
      migration: original.migration,
    })
    const clonedReceiptProjectIds = cloned.proposals.flatMap(proposal => proposal.items.flatMap(item =>
      item.receipt !== undefined && 'projectId' in item.receipt ? [item.receipt.projectId] : []))
    expect(clonedReceiptProjectIds).toEqual([clone.projectId])
    expect(clonedReceiptProjectIds).not.toContain(original.projectId)
    await clonedStore.dispose()

    const originalStore = await openStore(root, WORKSPACE_ID)
    const unchangedOriginal = await originalStore.read(signal)
    expect(unchangedOriginal.projectId).toBe(original.projectId)
    const unchangedOriginalReceipt = unchangedOriginal.proposals[0]?.items[0]?.receipt
    expect(unchangedOriginalReceipt !== undefined && 'projectId' in unchangedOriginalReceipt
      ? unchangedOriginalReceipt.projectId : undefined).toBe(original.projectId)
    await originalStore.dispose()
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
