import { existsSync } from 'node:fs'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { createAiNovelRpcHandler } from '../src/index.ts'
import { projectNovelStateRead } from '../src/command-rpc.ts'
import { novelProposalArgsHash, openNovelStore } from '../src/novel-store.ts'
import { openNovelProject } from '../src/novel-project.ts'
import { createPresetInstaller } from '../src/preset-installer.ts'
import { makeTestWorkspace, TEST_INITIALIZATION_IDENTITY } from './test-workspace.ts'

const signal = new AbortController().signal
const WORKSPACE_ID = '123e4567-e89b-42d3-a456-426614174111'
const UNKNOWN_WORKSPACE_ID = '123e4567-e89b-42d3-a456-426614174112'
const V2_WORKSPACE_ID = '123e4567-e89b-42d3-a456-426614174113'

function v2InitializePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceId: V2_WORKSPACE_ID,
    title: '潮汐来信',
    language: 'zh-CN',
    genre: '奇幻悬疑',
    plannedChapters: 12,
    targetWordsPerChapter: 3_000,
    creativeStrategy: 'consistency-first',
    structureMode: 'three-act',
    narrativePov: 'third-limited',
    globalGuidance: '保持冷峻而温柔的语气。',
    ...overrides,
  }
}

async function initializedV2Workspace(prefix: string): Promise<string> {
  const root = await makeTestWorkspace(prefix)
  const store = await openNovelStore(root, WorkspaceId(V2_WORKSPACE_ID))
  try {
    await store.initialize({
      workspaceId: WorkspaceId(V2_WORKSPACE_ID),
      title: '潮汐来信',
      language: 'zh-CN',
      genre: '奇幻悬疑',
      plannedChapters: 12,
      targetWordsPerChapter: 3_000,
      creativeStrategy: 'consistency-first',
      structureMode: 'three-act',
      narrativePov: 'third-limited',
      globalGuidance: '保持冷峻而温柔的语气。',
    }, signal)
  } finally {
    await store.dispose()
  }
  return root
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

describe('novel context Host RPC', () => {
  it('initializes a clean V2 workspace through the closed Host command without exposing its path', async () => {
    const root = await makeTestWorkspace('workspace-initialize-host-workspace-')
    const presetRoot = await makeTestWorkspace('workspace-initialize-host-preset-')
    const installer = createPresetInstaller(join(import.meta.dirname, '..', 'presets', 'ai-novel-writer'), presetRoot)
    const handler = createAiNovelRpcHandler(installer, {
      get: workspaceId => workspaceId === WorkspaceId(V2_WORKSPACE_ID) ? { path: root } : undefined,
    })

    const result = await handler('workspace/initialize', {
      workspaceId: V2_WORKSPACE_ID,
      title: '潮汐来信',
      language: 'zh-CN',
      genre: '奇幻悬疑',
      plannedChapters: 12,
      targetWordsPerChapter: 3_000,
      creativeStrategy: 'consistency-first',
      structureMode: 'three-act',
      narrativePov: 'third-limited',
      globalGuidance: '保持冷峻而温柔的语气。',
    }, signal)

    expect(result).toMatchObject({
      ok: true,
      value: {
        projectId: expect.any(String),
        globalRevision: 0,
        state: {
          workspaceId: WorkspaceId(V2_WORKSPACE_ID),
          globalRevision: 0,
          project: { title: '潮汐来信', revision: 0 },
        },
      },
    })
    expect(JSON.stringify(result)).not.toContain(root)
    expect(JSON.stringify(result)).not.toContain('workspacePath')
  })

  it.each([
    ['an unknown field', v2InitializePayload({ unexpected: true })],
    ['a browser workspace path', v2InitializePayload({ workspacePath: 'C:\\browser-supplied-root' })],
    ['an invalid V2 enum value', v2InitializePayload({ creativeStrategy: 'model-writes-directly' })],
    ['a missing V2 setting', (() => {
      const { globalGuidance: _globalGuidance, ...withoutGuidance } = v2InitializePayload()
      return withoutGuidance
    })()],
  ])('rejects a workspace/initialize payload with %s before opening a store', async (_caseName, payload) => {
    const root = await makeTestWorkspace('workspace-initialize-invalid-host-workspace-')
    const presetRoot = await makeTestWorkspace('workspace-initialize-invalid-host-preset-')
    const installer = createPresetInstaller(join(import.meta.dirname, '..', 'presets', 'ai-novel-writer'), presetRoot)
    const handler = createAiNovelRpcHandler(installer, { get: () => ({ path: root }) })

    const result = await handler('workspace/initialize', payload, signal)

    expect(result).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(JSON.stringify(result)).not.toContain(root)
    expect(existsSync(join(root, '.ai-novel'))).toBe(false)
  })

  it('rejects an exact workspace/initialize request for an unregistered Workspace', async () => {
    const presetRoot = await makeTestWorkspace('workspace-initialize-unknown-host-preset-')
    const installer = createPresetInstaller(join(import.meta.dirname, '..', 'presets', 'ai-novel-writer'), presetRoot)
    const handler = createAiNovelRpcHandler(installer, { get: () => undefined })

    const result = await handler('workspace/initialize', v2InitializePayload(), signal)

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'bad-request',
        message: `Unknown Workspace: ${V2_WORKSPACE_ID}`,
        details: { issues: [] },
      },
    })
  })

  it('keeps the first initialization intact when workspace/initialize is repeated', async () => {
    const root = await makeTestWorkspace('workspace-initialize-repeat-host-workspace-')
    const presetRoot = await makeTestWorkspace('workspace-initialize-repeat-host-preset-')
    const installer = createPresetInstaller(join(import.meta.dirname, '..', 'presets', 'ai-novel-writer'), presetRoot)
    const handler = createAiNovelRpcHandler(installer, { get: () => ({ path: root }) })

    await expect(handler('workspace/initialize', v2InitializePayload(), signal)).resolves.toMatchObject({
      ok: true,
      value: { globalRevision: 0, state: { project: { title: '潮汐来信', revision: 0 } } },
    })
    const repeated = await handler('workspace/initialize', v2InitializePayload({ title: '不得覆盖' }), signal)
    const state = await handler('state/read', { workspaceId: V2_WORKSPACE_ID }, signal)

    expect(repeated).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    if (!repeated.ok) expect(repeated.error.message).toBe('Novel workspace initialize request failed: ALREADY_INITIALIZED')
    expect(state).toMatchObject({ ok: true, value: { globalRevision: 0, project: { title: '潮汐来信', revision: 0 } } })
    expect(JSON.stringify(repeated)).not.toContain(root)
  })

  it('reports workspace mismatch and write lock through stable path-free initialization failures', async () => {
    const mismatchedRoot = await initializedV2Workspace('workspace-initialize-mismatch-host-workspace-')
    const lockedRoot = await makeTestWorkspace('workspace-initialize-locked-host-workspace-')
    const presetRoot = await makeTestWorkspace('workspace-initialize-failures-host-preset-')
    const installer = createPresetInstaller(join(import.meta.dirname, '..', 'presets', 'ai-novel-writer'), presetRoot)
    const mismatchedWorkspaceId = '123e4567-e89b-42d3-a456-426614174114'
    const mismatchHandler = createAiNovelRpcHandler(installer, {
      get: workspaceId => workspaceId === WorkspaceId(mismatchedWorkspaceId) ? { path: mismatchedRoot } : undefined,
    })
    const lockedStore = await openNovelStore(lockedRoot, WorkspaceId(V2_WORKSPACE_ID), { create: true })
    const lockHandler = createAiNovelRpcHandler(installer, { get: () => ({ path: lockedRoot }) })
    try {
      const mismatch = await mismatchHandler('workspace/initialize', v2InitializePayload({ workspaceId: mismatchedWorkspaceId }), signal)
      const locked = await lockHandler('workspace/initialize', v2InitializePayload(), signal)

      expect(mismatch).toMatchObject({ ok: false, error: { code: 'bad-request' } })
      expect(locked).toMatchObject({ ok: false, error: { code: 'bad-request' } })
      if (!mismatch.ok) expect(mismatch.error.message).toBe('Novel workspace initialize request failed: WORKSPACE_MISMATCH')
      if (!locked.ok) expect(locked.error.message).toBe('Novel workspace initialize request failed: WRITE_LOCKED')
      expect(JSON.stringify(mismatch)).not.toContain(mismatchedRoot)
      expect(JSON.stringify(locked)).not.toContain(lockedRoot)
    } finally {
      await lockedStore.dispose()
    }
  })

  it.each(['state/read', 'proposal/list', 'task/read', 'command/preview', 'command/commit'])(
    'returns a stable failure without a local path when %s cannot open an uninitialized store', async endpoint => {
      const root = await makeTestWorkspace('uninitialized-host-workspace-')
      const presetRoot = await makeTestWorkspace('uninitialized-host-preset-')
      const installer = createPresetInstaller(join(import.meta.dirname, '..', 'presets', 'ai-novel-writer'), presetRoot)
      const report = vi.fn()
      const handler = createAiNovelRpcHandler(installer, { get: () => ({ path: root }) }, report)
      const payload: Record<string, unknown> = { workspaceId: V2_WORKSPACE_ID }
      if (endpoint === 'task/read') payload.taskId = 'task-first-chapter'
      if (endpoint === 'command/preview' || endpoint === 'command/commit') {
        payload.command = {
          ...(endpoint === 'command/commit' ? { changeSetId: 'sidebar-project-title-1' } : {}),
          aggregate: { kind: 'project' },
          baseAggregateRevision: 0,
          baseGlobalRevision: 0,
          nextValue: {
            title: 'x', language: 'zh-CN', genre: 'y', plannedChapters: 1, targetWordsPerChapter: 1,
            creativeStrategy: 'auto', structureMode: 'episodic', narrativePov: 'first', globalGuidance: '',
            createdAt: '2026-08-18T00:00:00.000Z', updatedAt: '2026-08-18T00:00:00.000Z',
          },
        }
      }

      const result = await handler(endpoint, payload, signal)

      expect(result).toMatchObject({ ok: false, error: { code: 'bad-request' } })
      if (!result.ok) expect(result.error.message).toContain('NOT_INITIALIZED')
      expect(JSON.stringify(result)).not.toContain(root)
      expect(report).toHaveBeenCalled()
      expect(existsSync(join(root, '.ai-novel'))).toBe(false)
    })

  it('fails proposal/list when the workspace has no V2 project instead of returning an empty inbox', async () => {
    const root = await makeTestWorkspace('proposal-uninitialized-host-workspace-')
    const presetRoot = await makeTestWorkspace('proposal-uninitialized-host-preset-')
    const installer = createPresetInstaller(join(import.meta.dirname, '..', 'presets', 'ai-novel-writer'), presetRoot)
    const handler = createAiNovelRpcHandler(installer, { get: () => ({ path: root }) })

    const result = await handler('proposal/list', { workspaceId: V2_WORKSPACE_ID }, signal)

    expect(result).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(JSON.stringify(result)).not.toContain(root)
  })

  it('reads a clean V2 workspace as a path-free workspace/state/read sentinel without creating a store', async () => {
    const root = await makeTestWorkspace('workspace-state-clean-host-workspace-')
    const presetRoot = await makeTestWorkspace('workspace-state-clean-host-preset-')
    const installer = createPresetInstaller(join(import.meta.dirname, '..', 'presets', 'ai-novel-writer'), presetRoot)
    const handler = createAiNovelRpcHandler(installer, { get: () => ({ path: root }) })

    const result = await handler('workspace/state/read', { workspaceId: V2_WORKSPACE_ID }, signal)

    expect(result).toEqual({
      ok: true,
      value: { status: 'not-initialized', workspaceId: V2_WORKSPACE_ID },
    })
    expect(JSON.stringify(result)).not.toContain(root)
    expect(existsSync(join(root, '.ai-novel'))).toBe(false)
    await expect(handler('state/read', { workspaceId: V2_WORKSPACE_ID }, signal)).resolves.toEqual({
      ok: false,
      error: {
        code: 'bad-request',
        message: 'Novel state request failed: NOT_INITIALIZED',
        details: { issues: [] },
      },
    })
  })

  it('reads an initialized V2 workspace through the path-free workspace/state/read ready projection', async () => {
    const root = await initializedV2Workspace('workspace-state-ready-host-workspace-')
    const presetRoot = await makeTestWorkspace('workspace-state-ready-host-preset-')
    const installer = createPresetInstaller(join(import.meta.dirname, '..', 'presets', 'ai-novel-writer'), presetRoot)
    const handler = createAiNovelRpcHandler(installer, { get: () => ({ path: root }) })

    const result = await handler('workspace/state/read', { workspaceId: V2_WORKSPACE_ID }, signal)

    expect(result).toMatchObject({
      ok: true,
      value: {
        status: 'ready',
        workspaceId: V2_WORKSPACE_ID,
        state: {
          workspaceId: V2_WORKSPACE_ID,
          globalRevision: 0,
          project: { title: '潮汐来信', revision: 0 },
        },
      },
    })
    expect(JSON.stringify(result)).not.toContain(root)
    expect(JSON.stringify(result)).not.toContain('workspacePath')
  })

  it('keeps invalid, unknown, locked, and corrupt workspace/state/read failures out of the clean-workspace sentinel', async () => {
    const root = await makeTestWorkspace('workspace-state-errors-host-workspace-')
    const lockedRoot = await makeTestWorkspace('workspace-state-locked-host-workspace-')
    const corruptRoot = await makeTestWorkspace('workspace-state-corrupt-host-workspace-')
    const presetRoot = await makeTestWorkspace('workspace-state-errors-host-preset-')
    const installer = createPresetInstaller(join(import.meta.dirname, '..', 'presets', 'ai-novel-writer'), presetRoot)
    const invalidHandler = createAiNovelRpcHandler(installer, { get: () => ({ path: root }) })
    const unknownHandler = createAiNovelRpcHandler(installer, { get: () => undefined })
    await mkdir(join(corruptRoot, '.ai-novel'), { recursive: true })
    await writeFile(join(corruptRoot, '.ai-novel', 'novel.db'), 'not a sqlite database', 'utf8')
    const corruptHandler = createAiNovelRpcHandler(installer, { get: () => ({ path: corruptRoot }) })
    const lockedStore = await openNovelStore(lockedRoot, WorkspaceId(V2_WORKSPACE_ID), { create: true })
    const lockedHandler = createAiNovelRpcHandler(installer, { get: () => ({ path: lockedRoot }) })
    try {
      const invalid = await invalidHandler('workspace/state/read', { workspaceId: 'not-a-workspace-id' }, signal)
      const unknown = await unknownHandler('workspace/state/read', { workspaceId: V2_WORKSPACE_ID }, signal)
      const corrupt = await corruptHandler('workspace/state/read', { workspaceId: V2_WORKSPACE_ID }, signal)
      const locked = await lockedHandler('workspace/state/read', { workspaceId: V2_WORKSPACE_ID }, signal)

      expect(invalid).toMatchObject({ ok: false, error: { code: 'bad-request' } })
      expect(unknown).toMatchObject({ ok: false, error: { code: 'bad-request' } })
      expect(corrupt).toMatchObject({ ok: false, error: { code: 'bad-request' } })
      expect(locked).toMatchObject({ ok: false, error: { code: 'bad-request' } })
      if (!locked.ok) expect(locked.error.message).toBe('Novel workspace state request failed: WRITE_LOCKED')
      expect(JSON.stringify(invalid)).not.toContain(root)
      expect(JSON.stringify(unknown)).not.toContain(root)
      expect(JSON.stringify(corrupt)).not.toContain(corruptRoot)
      expect(JSON.stringify(locked)).not.toContain(lockedRoot)
    } finally {
      await lockedStore.dispose()
    }
  })

  it('reads only the previous selected final through the closed chapter/context envelope', async () => {
    const root = await initializedV2Workspace('chapter-context-host-workspace-')
    const seed = await openNovelStore(root, WorkspaceId(V2_WORKSPACE_ID), { create: false })
    try {
      const before = await seed.read(signal)
      await seed.applyChange({
        changeSetId: 'chapter-context-blueprint-1', operation: 'replace', aggregate: { kind: 'chapter', chapter: 1 },
        baseAggregateRevision: 0, baseGlobalRevision: before.globalRevision,
        nextValue: {
          chapter: 1, title: '第一封信', purpose: '建立异常。', plotBeats: [], characters: [],
          keyEvents: ['信件抵达'], suspense: '寄信人是谁？', status: 'drafting',
        },
        provenance: { origin: 'manual' },
      }, signal)
      const draftPayload = { changes: [{
        kind: 'artifact/draft', artifactId: 'host-context-draft-1', chapter: 1,
        content: '潮水退去时，信匣露出了海面。', summary: '第一章初稿。',
      }] }
      const draft = await seed.submitProposal({
        sessionId: 'host-context-session', callId: 'host-context-draft',
        argsHash: novelProposalArgsHash(draftPayload), payload: draftPayload,
      }, signal)
      await seed.applyProposal(draft.proposal.proposalId, signal)
      const finalPayload = { changes: [{
        kind: 'chapter/select-final', chapter: 1, artifactId: 'host-context-draft-1', summary: '选择第一章初稿为定稿。',
      }] }
      const final = await seed.submitProposal({
        sessionId: 'host-context-session', callId: 'host-context-final',
        argsHash: novelProposalArgsHash(finalPayload), payload: finalPayload,
      }, signal)
      await seed.applyProposal(final.proposal.proposalId, signal)
    } finally {
      await seed.dispose()
    }
    const presetRoot = await makeTestWorkspace('chapter-context-host-preset-')
    const installer = createPresetInstaller(join(import.meta.dirname, '..', 'presets', 'ai-novel-writer'), presetRoot)
    const handler = createAiNovelRpcHandler(installer, {
      get: workspaceId => workspaceId === WorkspaceId(V2_WORKSPACE_ID) ? { path: root } : undefined,
    })

    await expect(handler('chapter/context', { workspaceId: V2_WORKSPACE_ID, chapter: 2 }, signal)).resolves.toEqual({
      ok: true,
      value: {
        chapter: 2,
        previousFinal: {
          chapter: 1, artifactId: 'host-context-draft-1', content: '潮水退去时，信匣露出了海面。',
          summary: '选择第一章初稿为定稿。',
        },
      },
    })
    await expect(handler('chapter/context', { workspaceId: V2_WORKSPACE_ID, chapter: 2, path: root }, signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })

  it('previews one authoritative command as an entity diff without mutating the store', async () => {
    const root = await initializedV2Workspace('preview-host-workspace-')
    const presetRoot = await makeTestWorkspace('preview-host-preset-')
    const installer = createPresetInstaller(join(import.meta.dirname, '..', 'presets', 'ai-novel-writer'), presetRoot)
    const handler = createAiNovelRpcHandler(installer, {
      get: workspaceId => workspaceId === WorkspaceId(V2_WORKSPACE_ID) ? { path: root } : undefined,
    })
    const baseline = await openNovelStore(root, WorkspaceId(V2_WORKSPACE_ID))
    let createdAt: string
    try {
      createdAt = (await baseline.read(signal)).project.createdAt
    } finally {
      await baseline.dispose()
    }
    const nextValue = {
      title: '潮汐来信（修订）',
      language: 'zh-CN',
      genre: '奇幻悬疑',
      plannedChapters: 12,
      targetWordsPerChapter: 3_000,
      creativeStrategy: 'consistency-first',
      structureMode: 'three-act',
      narrativePov: 'third-limited',
      globalGuidance: '保持冷峻而温柔的语气。',
      createdAt,
      updatedAt: '2026-08-18T01:00:00.000Z',
    }

    const result = await handler('command/preview', {
      workspaceId: V2_WORKSPACE_ID,
      command: {
        aggregate: { kind: 'project' },
        baseAggregateRevision: 0,
        baseGlobalRevision: 0,
        nextValue,
      },
    }, signal)

    expect(result).toMatchObject({
      ok: true,
      value: {
        aggregate: { kind: 'project' },
        baseAggregateRevision: 0,
        baseGlobalRevision: 0,
        nextValue: { title: '潮汐来信（修订）' },
        changes: [
          { path: 'title', before: '潮汐来信', after: '潮汐来信（修订）' },
          { path: 'updatedAt', after: '2026-08-18T01:00:00.000Z' },
        ],
      },
    })
    if (result.ok) {
      const value = result.value as { changes: readonly { path: string; before: unknown; after: unknown }[] }
      expect(value.changes.map(change => change.path).sort()).toEqual(['title', 'updatedAt'])
    }
    const after = await openNovelStore(root, WorkspaceId(V2_WORKSPACE_ID))
    try {
      const state = await after.read(signal)
      expect(state.project.title).toBe('潮汐来信')
      expect(state.globalRevision).toBe(0)
      expect(state.changes).toEqual([])
    } finally {
      await after.dispose()
    }
  })

  it('commits one typed command and records its audit', async () => {
    const root = await initializedV2Workspace('commit-host-workspace-')
    const presetRoot = await makeTestWorkspace('commit-host-preset-')
    const installer = createPresetInstaller(join(import.meta.dirname, '..', 'presets', 'ai-novel-writer'), presetRoot)
    const handler = createAiNovelRpcHandler(installer, {
      get: workspaceId => workspaceId === WorkspaceId(V2_WORKSPACE_ID) ? { path: root } : undefined,
    })

    const result = await handler('command/commit', {
      workspaceId: V2_WORKSPACE_ID,
      command: {
        changeSetId: 'sidebar-project-title-1',
        aggregate: { kind: 'project' },
        baseAggregateRevision: 0,
        baseGlobalRevision: 0,
        nextValue: {
          title: '潮汐来信（定稿）',
          language: 'zh-CN',
          genre: '奇幻悬疑',
          plannedChapters: 12,
          targetWordsPerChapter: 3_000,
          creativeStrategy: 'consistency-first',
          structureMode: 'three-act',
          narrativePov: 'third-limited',
          globalGuidance: '保持冷峻而温柔的语气。',
          createdAt: '2026-08-18T00:00:00.000Z',
          updatedAt: '2026-08-18T02:00:00.000Z',
        },
      },
    }, signal)

    expect(result).toMatchObject({
      ok: true,
      value: {
        changeSetId: 'sidebar-project-title-1',
        aggregate: { kind: 'project' },
        aggregateRevision: 1,
        globalRevision: 1,
      },
    })
    expect(JSON.stringify(result)).not.toContain(root)
    const after = await openNovelStore(root, WorkspaceId(V2_WORKSPACE_ID))
    try {
      const state = await after.read(signal)
      expect(state.project.title).toBe('潮汐来信（定稿）')
      expect(state.changes).toEqual([expect.objectContaining({
        changeSetId: 'sidebar-project-title-1',
        status: 'committed',
        provenance: { origin: 'manual' },
      })])
    } finally {
      await after.dispose()
    }
  })

  it.each([
    {
      workspaceId: V2_WORKSPACE_ID,
      command: {
        aggregate: { kind: 'project' },
        baseAggregateRevision: 0,
        baseGlobalRevision: 0,
        nextValue: { title: 'x' },
        patch: [{ op: 'replace', path: '/title', value: 'y' }],
      },
    },
    {
      workspaceId: V2_WORKSPACE_ID,
      command: {
        aggregate: { kind: 'file', path: 'C:\\secret\\novel.db' },
        baseAggregateRevision: 0,
        baseGlobalRevision: 0,
        nextValue: {},
      },
    },
    {
      workspaceId: V2_WORKSPACE_ID,
      command: {
        aggregate: { kind: 'project' },
        baseAggregateRevision: 0,
        baseGlobalRevision: 0,
      },
    },
    {
      workspaceId: V2_WORKSPACE_ID,
      command: {
        aggregate: { kind: 'chapter', chapter: 1 },
        baseAggregateRevision: 0,
        baseGlobalRevision: 0,
        nextValue: { chapter: 2 },
      },
    },
  ])('rejects a preview or commit carrying a patch, a path, or a malformed command %#', async payload => {
    const root = await initializedV2Workspace('reject-host-workspace-')
    const presetRoot = await makeTestWorkspace('reject-host-preset-')
    const installer = createPresetInstaller(join(import.meta.dirname, '..', 'presets', 'ai-novel-writer'), presetRoot)
    const handler = createAiNovelRpcHandler(installer, { get: () => ({ path: root }) })

    await expect(handler('command/preview', payload, signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad-request' } })
    await expect(handler('command/commit', payload, signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })

  it.each([
    {
      changeSetId: 'invalid changeSetId!',
      aggregate: { kind: 'project' },
      nextValue: {
        title: 'x', language: 'zh-CN', genre: 'y', plannedChapters: 1, targetWordsPerChapter: 1,
        creativeStrategy: 'auto', structureMode: 'episodic', narrativePov: 'first', globalGuidance: '',
        createdAt: '2026-08-18T00:00:00.000Z', updatedAt: '2026-08-18T00:00:00.000Z',
      },
    },
    {
      aggregate: { kind: 'characters' },
      nextValue: {
        items: [{ characterId: 'a', name: 'A', role: '', summary: '', goal: '', currentState: '', notes: '' }],
        relationships: [],
      },
    },
    {
      aggregate: { kind: 'characters' },
      nextValue: {
        items: [
          { characterId: 'a', name: 'A', role: 'r', summary: '', goal: '', currentState: '', notes: '' },
          { characterId: 'a', name: 'B', role: 'r', summary: '', goal: '', currentState: '', notes: '' },
        ],
        relationships: [],
      },
    },
    {
      aggregate: { kind: 'characters' },
      nextValue: {
        items: [{ characterId: 'a', name: 'A', role: 'r', summary: '', goal: '', currentState: '', notes: '' }],
        relationships: [{ fromCharacterId: 'a', toCharacterId: 'ghost', relation: 'knows', notes: '' }],
      },
    },
    {
      aggregate: { kind: 'characters' },
      nextValue: {
        items: [
          { characterId: 'a', name: 'A', role: 'r', summary: '', goal: '', currentState: '', notes: '' },
          { characterId: 'b', name: 'B', role: 'r', summary: '', goal: '', currentState: '', notes: '' },
        ],
        relationships: [
          { fromCharacterId: 'a', toCharacterId: 'b', relation: 'knows', notes: '' },
          { fromCharacterId: 'a', toCharacterId: 'b', relation: 'knows', notes: '' },
        ],
      },
    },
    {
      aggregate: { kind: 'chapter', chapter: 1 },
      nextValue: {
        chapter: 1, title: 'T', purpose: 'P', plotBeats: [], characters: ['a', 'a'],
        keyEvents: [], suspense: '', status: 'planned',
      },
    },
  ])('rejects a preview or commit whose nextValue violates store validation %#', async command => {
    const root = await initializedV2Workspace('invalid-nextvalue-host-workspace-')
    const seed = await openNovelStore(root, WorkspaceId(V2_WORKSPACE_ID))
    try {
      await seed.applyChange({
        changeSetId: 'seed-character-a',
        operation: 'replace',
        aggregate: { kind: 'characters' },
        baseAggregateRevision: 0,
        baseGlobalRevision: 0,
        nextValue: {
          items: [{ characterId: 'a', name: 'A', role: 'r', summary: '', goal: '', currentState: '', notes: '' }],
          relationships: [],
        },
        provenance: { origin: 'manual' },
      }, signal)
    } finally {
      await seed.dispose()
    }
    const presetRoot = await makeTestWorkspace('invalid-nextvalue-host-preset-')
    const installer = createPresetInstaller(join(import.meta.dirname, '..', 'presets', 'ai-novel-writer'), presetRoot)
    const handler = createAiNovelRpcHandler(installer, { get: () => ({ path: root }) })
    const payload = {
      workspaceId: V2_WORKSPACE_ID,
      command: {
        baseAggregateRevision: command.aggregate.kind === 'characters' ? 1 : 0,
        baseGlobalRevision: command.aggregate.kind === 'characters' ? 1 : 0,
        ...command,
      },
    }

    await expect(handler('command/preview', payload, signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad-request' } })
    const commitPayload = {
      workspaceId: V2_WORKSPACE_ID,
      command: { changeSetId: command.changeSetId ?? 'sidebar-validation-1', ...payload.command },
    }
    await expect(handler('command/commit', commitPayload, signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })

  it('rejects a preview whose base revisions no longer match the authoritative store', async () => {
    const root = await initializedV2Workspace('stale-preview-host-workspace-')
    const presetRoot = await makeTestWorkspace('stale-preview-host-preset-')
    const installer = createPresetInstaller(join(import.meta.dirname, '..', 'presets', 'ai-novel-writer'), presetRoot)
    const handler = createAiNovelRpcHandler(installer, { get: () => ({ path: root }) })
    const seed = await openNovelStore(root, WorkspaceId(V2_WORKSPACE_ID))
    let createdAt: string
    try {
      createdAt = (await seed.read(signal)).project.createdAt
    } finally {
      await seed.dispose()
    }
    const nextValue = {
      title: '潮汐来信（修订）', language: 'zh-CN', genre: '奇幻悬疑',
      plannedChapters: 12, targetWordsPerChapter: 3_000,
      creativeStrategy: 'consistency-first', structureMode: 'three-act', narrativePov: 'third-limited',
      globalGuidance: '保持冷峻而温柔的语气。', createdAt, updatedAt: '2026-08-18T01:00:00.000Z',
    }

    await expect(handler('command/preview', {
      workspaceId: V2_WORKSPACE_ID,
      command: {
        aggregate: { kind: 'project' },
        baseAggregateRevision: 7,
        baseGlobalRevision: 0,
        nextValue,
      },
    }, signal)).resolves.toMatchObject({ ok: false, error: { code: 'bad-request' } })
    await expect(handler('command/preview', {
      workspaceId: V2_WORKSPACE_ID,
      command: {
        aggregate: { kind: 'project' },
        baseAggregateRevision: 0,
        baseGlobalRevision: 7,
        nextValue,
      },
    }, signal)).resolves.toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })

  it('rejects a preview whose chapter references a character missing from the authoritative store', async () => {
    const root = await initializedV2Workspace('ghost-chapter-host-workspace-')
    const seed = await openNovelStore(root, WorkspaceId(V2_WORKSPACE_ID))
    try {
      await seed.applyChange({
        changeSetId: 'seed-character-a',
        operation: 'replace',
        aggregate: { kind: 'characters' },
        baseAggregateRevision: 0,
        baseGlobalRevision: 0,
        nextValue: {
          items: [{ characterId: 'a', name: 'A', role: 'r', summary: '', goal: '', currentState: '', notes: '' }],
          relationships: [],
        },
        provenance: { origin: 'manual' },
      }, signal)
    } finally {
      await seed.dispose()
    }
    const presetRoot = await makeTestWorkspace('ghost-chapter-host-preset-')
    const installer = createPresetInstaller(join(import.meta.dirname, '..', 'presets', 'ai-novel-writer'), presetRoot)
    const handler = createAiNovelRpcHandler(installer, { get: () => ({ path: root }) })

    const result = await handler('command/preview', {
      workspaceId: V2_WORKSPACE_ID,
      command: {
        aggregate: { kind: 'chapter', chapter: 1 },
        baseAggregateRevision: 0,
        baseGlobalRevision: 1,
        nextValue: {
          chapter: 1, title: 'T', purpose: 'P', plotBeats: [], characters: ['ghost'],
          keyEvents: [], suspense: '', status: 'planned',
        },
      },
    }, signal)

    expect(result).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    if (!result.ok) expect(result.error.message).toContain('INVALID_CONTENT')
  })

  it('rejects a preview whose characters replacement drops a character still referenced by a chapter', async () => {
    const root = await initializedV2Workspace('dangling-characters-host-workspace-')
    const seed = await openNovelStore(root, WorkspaceId(V2_WORKSPACE_ID))
    try {
      await seed.applyChange({
        changeSetId: 'seed-character-a',
        operation: 'replace',
        aggregate: { kind: 'characters' },
        baseAggregateRevision: 0,
        baseGlobalRevision: 0,
        nextValue: {
          items: [{ characterId: 'a', name: 'A', role: 'r', summary: '', goal: '', currentState: '', notes: '' }],
          relationships: [],
        },
        provenance: { origin: 'manual' },
      }, signal)
      await seed.applyChange({
        changeSetId: 'seed-chapter-1',
        operation: 'replace',
        aggregate: { kind: 'chapter', chapter: 1 },
        baseAggregateRevision: 0,
        baseGlobalRevision: 1,
        nextValue: {
          chapter: 1, title: 'T', purpose: 'P', plotBeats: [], characters: ['a'],
          keyEvents: [], suspense: '', status: 'planned',
        },
        provenance: { origin: 'manual' },
      }, signal)
    } finally {
      await seed.dispose()
    }
    const presetRoot = await makeTestWorkspace('dangling-characters-host-preset-')
    const installer = createPresetInstaller(join(import.meta.dirname, '..', 'presets', 'ai-novel-writer'), presetRoot)
    const handler = createAiNovelRpcHandler(installer, { get: () => ({ path: root }) })

    const result = await handler('command/preview', {
      workspaceId: V2_WORKSPACE_ID,
      command: {
        aggregate: { kind: 'characters' },
        baseAggregateRevision: 1,
        baseGlobalRevision: 2,
        nextValue: { items: [], relationships: [] },
      },
    }, signal)

    expect(result).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    if (!result.ok) expect(result.error.message).toContain('INVALID_CONTENT')
  })

  it('reads authoritative V2 state through Workspace identity without exposing its local path', async () => {
    const root = await initializedV2Workspace('state-host-workspace-')
    const presetRoot = await makeTestWorkspace('state-host-preset-')
    const installer = createPresetInstaller(join(import.meta.dirname, '..', 'presets', 'ai-novel-writer'), presetRoot)
    const handler = createAiNovelRpcHandler(installer, {
      get: workspaceId => workspaceId === WorkspaceId(V2_WORKSPACE_ID) ? { path: root } : undefined,
    })

    const result = await handler('state/read', { workspaceId: V2_WORKSPACE_ID }, signal)

    expect(result).toMatchObject({
      ok: true,
      value: {
        workspaceId: WorkspaceId(V2_WORKSPACE_ID),
        globalRevision: 0,
        readOnly: false,
        project: { title: '潮汐来信', revision: 0 },
      },
    })
    expect(JSON.stringify(result)).not.toContain(root)
    expect(JSON.stringify(result)).not.toContain('workspacePath')
    expect(JSON.stringify(result)).not.toContain('archivePath')
  })

  it('re-attaches a mismatched workspace through an opaque Host request and never exposes the local path', async () => {
    const root = await initializedV2Workspace('reattach-host-workspace-')
    const presetRoot = await makeTestWorkspace('reattach-host-preset-')
    const reattachedWorkspaceId = '123e4567-e89b-42d3-a456-426614174114'
    const installer = createPresetInstaller(join(import.meta.dirname, '..', 'presets', 'ai-novel-writer'), presetRoot)
    const handler = createAiNovelRpcHandler(installer, {
      get: workspaceId => workspaceId === WorkspaceId(reattachedWorkspaceId) ? { path: root } : undefined,
    })

    const before = await handler('state/read', { workspaceId: reattachedWorkspaceId }, signal)
    expect(before).toMatchObject({
      ok: true,
      value: { readOnly: true },
    })
    const result = await handler('workspace/reattach', { workspaceId: reattachedWorkspaceId }, signal)

    expect(result).toMatchObject({
      ok: true,
      value: { mode: 'reattach', workspaceId: WorkspaceId(reattachedWorkspaceId) },
    })
    if (before.ok && result.ok) {
      expect((result.value as { projectId: string }).projectId).toBe((before.value as { projectId: string }).projectId)
    }
    expect(JSON.stringify(result)).not.toContain(root)
    await expect(handler('state/read', { workspaceId: reattachedWorkspaceId }, signal)).resolves.toMatchObject({
      ok: true,
      value: { workspaceId: WorkspaceId(reattachedWorkspaceId), readOnly: false },
    })
  })

  it('removes a migrated V1 archive location from the state/read wire projection', async () => {
    const root = await initializedV2Workspace('state-host-migration-projection-')
    const store = await openNovelStore(root, WorkspaceId(V2_WORKSPACE_ID), { create: false })
    try {
      const snapshot = await store.read(signal)
      const projected = projectNovelStateRead({
        ...snapshot,
        migration: {
          projectId: snapshot.projectId,
          fingerprint: 'a'.repeat(64),
          archivePath: 'C:\\HostOnly\\v1-archive',
          sourceCount: 5,
          chapterCount: 1,
          draftCount: 1,
          migratedAt: '2026-08-21T00:00:00.000Z',
        },
      })

      expect(projected.migration).toEqual({
        projectId: snapshot.projectId,
        fingerprint: 'a'.repeat(64),
        sourceCount: 5,
        chapterCount: 1,
        draftCount: 1,
        migratedAt: '2026-08-21T00:00:00.000Z',
      })
      expect(JSON.stringify(projected)).not.toContain('archivePath')
      expect(JSON.stringify(projected)).not.toContain('C:\\HostOnly')
    } finally {
      await store.dispose()
    }
  })

  it('returns a typed empty proposal inbox before persistent proposals exist', async () => {
    const root = await initializedV2Workspace('proposal-host-workspace-')
    const presetRoot = await makeTestWorkspace('proposal-host-preset-')
    const installer = createPresetInstaller(join(import.meta.dirname, '..', 'presets', 'ai-novel-writer'), presetRoot)
    const handler = createAiNovelRpcHandler(installer, {
      get: () => ({ path: root }),
    })

    await expect(handler('proposal/list', { workspaceId: V2_WORKSPACE_ID }, signal))
      .resolves.toEqual({ ok: true, value: { proposals: [] } })
  })

  it('projects a V2 mismatch proposal inbox read-only without migrating it before explicit recovery', async () => {
    const root = await initializedV2Workspace('legacy-v2-proposal-readonly-host-')
    const alternateWorkspaceId = '123e4567-e89b-42d3-a456-426614174116'
    const seed = await openNovelStore(root, WorkspaceId(V2_WORKSPACE_ID))
    let proposalId: string
    try {
      const before = await seed.read(signal)
      const { revision: _ignoredArchitectureRevision, ...architecture } = before.architecture
      const payload = {
        changes: [{
          changeSetId: 'legacy-v2-readonly-proposal',
          aggregate: { kind: 'architecture' },
          baseAggregateRevision: before.architecture.revision,
          baseGlobalRevision: before.globalRevision,
          nextValue: { ...architecture, premise: '旧 schema 只读展示的持久提案。' },
        }],
      }
      const submitted = await seed.submitProposal({
        sessionId: 'legacy-v2-session',
        callId: 'legacy-v2-call',
        argsHash: novelProposalArgsHash(payload),
        payload,
      }, signal)
      proposalId = submitted.proposal.proposalId
    } finally {
      await seed.dispose()
    }
    downgradeDatabaseToV2(root)
    const presetRoot = await makeTestWorkspace('legacy-v2-proposal-readonly-preset-')
    const installer = createPresetInstaller(join(import.meta.dirname, '..', 'presets', 'ai-novel-writer'), presetRoot)
    const handler = createAiNovelRpcHandler(installer, {
      get: workspaceId => workspaceId === WorkspaceId(alternateWorkspaceId) ? { path: root } : undefined,
    })

    const state = await handler('state/read', { workspaceId: alternateWorkspaceId }, signal)
    const proposals = await handler('proposal/list', { workspaceId: alternateWorkspaceId }, signal)

    expect(state).toMatchObject({ ok: true, value: { readOnly: true, storage: { userVersion: 2 } } })
    expect(proposals).toMatchObject({
      ok: true,
      value: {
        proposals: [{
          proposalId,
          status: 'pending',
          items: [{ itemOrder: 0, status: 'pending', attemptCount: 0, change: {
            changeSetId: 'legacy-v2-readonly-proposal',
            provenance: { origin: 'model', sessionId: 'legacy-v2-session', callId: 'legacy-v2-call' },
          } }],
        }],
      },
    })
    expect(JSON.stringify({ state, proposals })).not.toContain(root)
    const database = new DatabaseSync(join(root, '.ai-novel', 'novel.db'), { readOnly: true })
    try {
      expect((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2)
    } finally {
      database.close()
    }

    await expect(handler('workspace/reattach', { workspaceId: alternateWorkspaceId }, signal)).resolves.toMatchObject({
      ok: true, value: { mode: 'reattach', workspaceId: WorkspaceId(alternateWorkspaceId) },
    })
    await expect(handler('proposal/list', { workspaceId: alternateWorkspaceId }, signal)).resolves.toMatchObject({
      ok: true,
      value: { proposals: [{ proposalId, status: 'pending', items: [{ itemOrder: 0, status: 'pending' }] }] },
    })
  })

  it('applies one proposal bundle through opaque IDs only and never exposes a workspace path', async () => {
    const root = await initializedV2Workspace('proposal-apply-host-workspace-')
    const seed = await openNovelStore(root, WorkspaceId(V2_WORKSPACE_ID))
    let proposalId: string
    try {
      const before = await seed.read(signal)
      const { revision: _architectureRevision, ...architecture } = before.architecture
      const payload = {
        changes: [{
          changeSetId: 'host-proposal-architecture',
          aggregate: { kind: 'architecture' },
          baseAggregateRevision: before.architecture.revision,
          baseGlobalRevision: before.globalRevision,
          nextValue: {
            ...architecture,
            premise: 'Host 只按已保存的 item 顺序应用。',
          },
        }],
      }
      const submitted = await seed.submitProposal({
        sessionId: 'host-proposal-session', callId: 'host-proposal-call',
        argsHash: novelProposalArgsHash(payload), payload,
      }, signal)
      proposalId = submitted.proposal.proposalId
    } finally {
      await seed.dispose()
    }
    const presetRoot = await makeTestWorkspace('proposal-apply-host-preset-')
    const installer = createPresetInstaller(join(import.meta.dirname, '..', 'presets', 'ai-novel-writer'), presetRoot)
    const handler = createAiNovelRpcHandler(installer, {
      get: workspaceId => workspaceId === WorkspaceId(V2_WORKSPACE_ID) ? { path: root } : undefined,
    })

    const result = await handler('proposal/apply', { workspaceId: V2_WORKSPACE_ID, proposalId: proposalId! }, signal)
    expect(result).toMatchObject({
      ok: true,
      value: { proposal: { proposalId, status: 'applied', items: [{ status: 'applied' }] }, appliedItemIds: [expect.any(String)], }
    })
    expect(JSON.stringify(result)).not.toContain(root)
    await expect(handler('proposal/apply', { workspaceId: V2_WORKSPACE_ID, proposalId: proposalId!, path: root }, signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })

  it('reads one authoritative task by closed identity', async () => {
    const root = await initializedV2Workspace('task-host-workspace-')
    const task = {
      taskId: 'task-first-chapter',
      kind: 'chapter',
      stage: 'drafting',
      status: 'running',
      failure: '',
      resumeCursor: 'chapter:1:draft:v1',
      createdAt: '2026-08-18T00:00:00.000Z',
      updatedAt: '2026-08-18T00:00:00.000Z',
    } as const
    const store = await openNovelStore(root, WorkspaceId(V2_WORKSPACE_ID))
    try {
      await store.applyChange({
        changeSetId: 'seed-task-first-chapter',
        operation: 'replace',
        aggregate: { kind: 'task', taskId: task.taskId },
        baseAggregateRevision: 0,
        baseGlobalRevision: 0,
        nextValue: task,
        provenance: { origin: 'manual' },
      }, signal)
    } finally {
      await store.dispose()
    }
    const presetRoot = await makeTestWorkspace('task-host-preset-')
    const installer = createPresetInstaller(join(import.meta.dirname, '..', 'presets', 'ai-novel-writer'), presetRoot)
    const handler = createAiNovelRpcHandler(installer, { get: () => ({ path: root }) })

    await expect(handler('task/read', { workspaceId: V2_WORKSPACE_ID, taskId: task.taskId }, signal))
      .resolves.toEqual({ ok: true, value: { ...task, revision: 1 } })
  })

  it('reads one recognized asset by Workspace identity without returning a filesystem source', async () => {
    const root = await makeTestWorkspace('asset-host-workspace-')
    const presetRoot = await makeTestWorkspace('asset-host-preset-')
    const project = openNovelProject(root)
    await project.apply({
      ...TEST_INITIALIZATION_IDENTITY,
      kind: 'initialize', title: '潮汐来信', language: 'zh-CN', genre: '悬疑',
      plannedChapters: 2, targetWordsPerChapter: 2_000, creativeStrategy: 'auto',
    }, signal)
    const characters = `${JSON.stringify({ characters: [{
      id: 'lin', name: '林澈', role: '调查者', summary: '追查旧案', goal: '找到真相',
      relationships: [], notes: '',
    }] }, null, 2)}\n`
    const receipt = await project.apply({
      kind: 'replace', target: { kind: 'characters' }, baseRevision: 'absent',
      replacement: characters, summary: '建立人物设定',
    }, signal)
    const installer = createPresetInstaller(join(import.meta.dirname, '..', 'presets', 'ai-novel-writer'), presetRoot)
    const handler = createAiNovelRpcHandler(installer, { get: () => ({ path: root }) })

    const result = await handler('asset/read', {
      workspaceId: WORKSPACE_ID,
      target: { kind: 'characters' },
    }, signal)

    expect(result).toEqual({
      ok: true,
      value: {
        target: { kind: 'characters' },
        revision: receipt.newRevision,
        text: characters,
        bytes: Buffer.byteLength(characters),
      },
    })
    expect(JSON.stringify(result)).not.toContain(root)
    expect(JSON.stringify(result)).not.toContain('.ai-novel')
  })

  it.each([
    { workspaceId: WORKSPACE_ID, target: { kind: 'unknown' } },
    { workspaceId: WORKSPACE_ID, target: { kind: 'chapter-blueprint', chapter: 0 } },
    { workspaceId: WORKSPACE_ID, target: { kind: 'characters' }, path: 'C:\\secret' },
    { target: { kind: 'project' } },
  ])('rejects an unrecognized or path-bearing asset request %#', async payload => {
    const presetRoot = await makeTestWorkspace('asset-host-invalid-preset-')
    const installer = createPresetInstaller(join(import.meta.dirname, '..', 'presets', 'ai-novel-writer'), presetRoot)
    const handler = createAiNovelRpcHandler(installer, { get: () => undefined })

    await expect(handler('asset/read', payload, signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })

  it('resolves an opaque workspace id through the registry and never accepts a browser path', async () => {
    const root = await makeTestWorkspace('context-host-workspace-')
    const presetRoot = await makeTestWorkspace('context-host-preset-')
    await openNovelProject(root).apply({
      ...TEST_INITIALIZATION_IDENTITY,
      kind: 'initialize', title: '潮汐来信', language: 'zh-CN', genre: '悬疑',
      plannedChapters: 2, targetWordsPerChapter: 2_000, creativeStrategy: 'auto',
    }, signal)
    const installer = createPresetInstaller(join(import.meta.dirname, '..', 'presets', 'ai-novel-writer'), presetRoot)
    const handler = createAiNovelRpcHandler(installer, {
      get: workspaceId => workspaceId === WORKSPACE_ID ? { path: root } : undefined,
    })

    await expect(handler('context/read', { workspaceId: WORKSPACE_ID, chapter: 1 }, signal))
      .resolves.toMatchObject({ ok: true, value: { status: 'ready', project: { title: '潮汐来信' } } })
    await expect(handler('context/read', { workspaceId: UNKNOWN_WORKSPACE_ID, chapter: 1 }, signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad-request' } })
    await expect(handler('context/read', { workspaceId: WORKSPACE_ID, chapter: 1, path: root }, signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad-request' } })
    await expect(handler('context/read', { path: root, chapter: 1 }, signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })

  it('keeps filesystem paths out of a failed context response while reporting the Host detail', async () => {
    const root = await makeTestWorkspace('context-host-symlink-')
    const target = await makeTestWorkspace('context-host-symlink-target-')
    const presetRoot = await makeTestWorkspace('context-host-preset-')
    await openNovelProject(target).apply({
      ...TEST_INITIALIZATION_IDENTITY,
      kind: 'initialize', title: '潮汐来信', language: 'zh-CN', genre: '悬疑',
      plannedChapters: 2, targetWordsPerChapter: 2_000, creativeStrategy: 'auto',
    }, signal)
    await symlink(join(target, '.ai-novel'), join(root, '.ai-novel'), 'junction')
    const installer = createPresetInstaller(join(import.meta.dirname, '..', 'presets', 'ai-novel-writer'), presetRoot)
    const report = vi.fn()
    const handler = createAiNovelRpcHandler(installer, { get: () => ({ path: root }) }, report)

    const result = await handler('context/read', { workspaceId: WORKSPACE_ID, chapter: 1 }, signal)

    expect(result).toEqual({
      ok: false,
      error: { code: 'internal', message: 'Novel context request failed', details: {} },
    })
    expect(JSON.stringify(result)).not.toContain(root)
    expect(JSON.stringify(result)).not.toContain(target)
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining(root) }))
  })
})
