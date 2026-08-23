import { describe, expect, it, vi } from 'vitest'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'

const mockedStore = vi.hoisted(() => ({
  open: vi.fn(),
  read: vi.fn(),
  dispose: vi.fn(),
}))

vi.mock('../src/novel-store.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/novel-store.ts')>()
  return { ...actual, openNovelStore: mockedStore.open }
})

import { createNovelV2ToolDefinitions } from '../src/agent.ts'

const WORKSPACE_ID = WorkspaceId('123e4567-e89b-42d3-a456-426614174205')

describe('AI novel V2 model state privacy', () => {
  it('projects a migrated state before novel_read returns it to the model', async () => {
    const root = 'C:\\HostOnly\\model-state-workspace'
    const snapshot = {
      projectId: '123e4567-e89b-42d3-a456-426614174000', workspaceId: WORKSPACE_ID, workspacePath: root,
      globalRevision: 4, readOnly: false, storage: {}, project: {}, architecture: {}, characters: {}, chapters: [], tasks: [], changes: [], proposals: [],
      migration: {
        projectId: '123e4567-e89b-42d3-a456-426614174000', fingerprint: 'a'.repeat(64),
        archivePath: 'C:\\HostOnly\\v1-archive', sourceCount: 2, chapterCount: 1, draftCount: 1, migratedAt: '2026-08-21T00:00:00.000Z',
      },
    }
    mockedStore.open.mockResolvedValue({ read: mockedStore.read, dispose: mockedStore.dispose })
    mockedStore.read.mockResolvedValue(snapshot)
    const tools = createNovelV2ToolDefinitions({}, { resolveByPath: async path => path === root ? { id: WORKSPACE_ID, path: root } : undefined })

    const state = await tools[0].execute({ kind: 'state' }, {
      callId: 'privacy-read', name: 'novel_read', arguments: { kind: 'state' }, signal: new AbortController().signal,
      agent: { session: { id: 'session-v2', header: { cwd: root } } },
    } as never)

    expect(state).toMatchObject({ migration: { fingerprint: 'a'.repeat(64), sourceCount: 2, chapterCount: 1, draftCount: 1 } })
    expect(JSON.stringify(state)).not.toContain(root)
    expect(JSON.stringify(state)).not.toContain('workspacePath')
    expect(JSON.stringify(state)).not.toContain('archivePath')
    expect(mockedStore.dispose).toHaveBeenCalledOnce()
  })
})
