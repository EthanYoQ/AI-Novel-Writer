import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  confirm: vi.fn(async () => true),
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() },
}))

vi.mock('../../../../services/ipc-client', () => ({
  ipc: { invokeWithProjectSession: mocks.invoke },
}))
vi.mock('../../../ui/Confirm', () => ({ confirm: mocks.confirm }))
vi.mock('../../../ui/Toast', () => ({ toast: mocks.toast }))
vi.mock('../../../project-session-gate', () => ({
  captureProjectSession: () => ({ projectId: 'p1', projectPath: 'C:/novels/book', leaseId: 'lease-1' }),
  isProjectSessionCurrent: () => true,
  isProjectSessionPath: () => true,
}))

import { useLocaleStore } from '../../../../stores/locale-store'
import { deleteFinalizedChapter } from '../finalized-chapter-deletion'

const originalLocale = useLocaleStore.getState().locale
const input = {
  project: { id: 'p1', path: 'C:/novels/book', sessionLease: 'lease-1' },
  projectPath: 'C:/novels/book',
  draftId: 7,
  chapterNumber: 3,
  displayName: '第3章',
  tabFilePath: 'draft:7',
  surface: 'manuscript' as const,
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { useLocaleStore.setState({ locale: originalLocale }) })

describe('删除定稿失败时的说明', () => {
  it.each([
    ['zh-CN', '删除失败', '项目已切换或重新打开', '未知错误'],
    ['en-US', 'Delete failed', 'The project was switched or reopened', 'Unknown error'],
  ] as const)('%s 界面：会话失效码显示登记的说明，未登记的原文保留，没有原因时用兜底', async (locale, heading, stale, fallback) => {
    useLocaleStore.setState({ locale })
    for (const [error, detail] of [
      ['PROJECT_SESSION_STALE', stale],
      ['SOMETHING_NEW_FROM_MAIN', 'SOMETHING_NEW_FROM_MAIN'],
      [undefined, fallback],
    ] as const) {
      mocks.toast.error.mockClear()
      mocks.invoke.mockResolvedValue({ committed: false, success: false, error })
      await deleteFinalizedChapter(input)
      const [message] = mocks.toast.error.mock.calls[0] as [string]
      expect(message.startsWith(`${heading}\n\n${detail}`)).toBe(true)
      expect(message).not.toContain('PROJECT_SESSION_STALE')
    }
  })
})
