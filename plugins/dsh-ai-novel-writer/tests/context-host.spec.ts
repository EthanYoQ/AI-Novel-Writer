import { existsSync } from 'node:fs'
import { symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { createAiNovelRpcHandler } from '../src/index.ts'
import { openNovelStore } from '../src/novel-store.ts'
import { openNovelProject } from '../src/novel-project.ts'
import { createPresetInstaller } from '../src/preset-installer.ts'
import { makeTestWorkspace, TEST_INITIALIZATION_IDENTITY } from './test-workspace.ts'

const signal = new AbortController().signal
const WORKSPACE_ID = '123e4567-e89b-42d3-a456-426614174111'
const UNKNOWN_WORKSPACE_ID = '123e4567-e89b-42d3-a456-426614174112'
const V2_WORKSPACE_ID = '123e4567-e89b-42d3-a456-426614174113'

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

describe('novel context Host RPC', () => {
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
