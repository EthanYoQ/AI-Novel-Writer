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
