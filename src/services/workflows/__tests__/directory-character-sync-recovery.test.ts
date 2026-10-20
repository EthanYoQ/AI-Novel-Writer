import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../blueprint-character-sync', () => ({ syncBlueprintCharacterCandidates: vi.fn().mockResolvedValue(undefined) }))

import { retryAllPendingDirectoryCharacterSyncs, retryDirectoryCharacterSync } from '../directory-character-sync-recovery'

const session = { projectId: 'NovelA', leaseId: 'lease-NovelA', projectPath: 'C:/NovelA' }

function stubIpc(results: Record<string, unknown>) {
  vi.stubGlobal('window', {
    aiNovelAPI: { invoke: vi.fn((channel: string) => Promise.resolve(results[channel])), on: vi.fn(), once: vi.fn(), send: vi.fn() },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('蓝图角色同步重试的失败说明按界面语言显示（#471）', () => {
  it('英文界面：待重试的操作不存在时说明是英文', async () => {
    stubIpc({ 'db:blueprint-character-sync-get': null })

    await expect(retryDirectoryCharacterSync('op-1', 'C:/NovelA', session, 'en-US'))
      .rejects.toThrow(/^The pending blueprint character-proposal operation no longer exists\.$/u)
  })

  it('英文界面：主进程拒绝保存回执时只给英文说明，不转出主进程的中文原文', async () => {
    stubIpc({
      'db:blueprint-character-sync-list-pending': [{ operationId: 'op-1', status: 'pending' }],
      'db:blueprint-character-sync-get': { operationId: 'op-1', status: 'pending', characterSyncInput: [] },
      'db:blueprint-character-sync-complete': { success: false, error: 'Error: 项目数据库未打开' },
    })

    await expect(retryAllPendingDirectoryCharacterSyncs('C:/NovelA', session, 'en-US'))
      .rejects.toThrow(/^The blueprint character proposals were saved, but their receipt could not be stored\.$/u)
  })

  it('中文界面：在说明后附上主进程原文', async () => {
    stubIpc({
      'db:blueprint-character-sync-get': { operationId: 'op-1', status: 'pending', characterSyncInput: [] },
      'db:blueprint-character-sync-complete': { success: false, error: 'Error: 项目数据库未打开' },
    })

    await expect(retryDirectoryCharacterSync('op-1', 'C:/NovelA', session, 'zh-CN'))
      .rejects.toThrow(/^蓝图角色提议已保存，但回执未能持久化：项目数据库未打开$/u)
  })
})
