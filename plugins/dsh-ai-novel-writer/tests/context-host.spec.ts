import { symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createAiNovelRpcHandler } from '../src/index.ts'
import { openNovelProject } from '../src/novel-project.ts'
import { createPresetInstaller } from '../src/preset-installer.ts'
import { makeTestWorkspace, TEST_INITIALIZATION_IDENTITY } from './test-workspace.ts'

const signal = new AbortController().signal
const WORKSPACE_ID = '123e4567-e89b-42d3-a456-426614174111'
const UNKNOWN_WORKSPACE_ID = '123e4567-e89b-42d3-a456-426614174112'

describe('novel context Host RPC', () => {
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
