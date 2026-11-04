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

describe('删除定稿章前的确认说明（#564）', () => {
  it.each([
    ['zh-CN', 'manuscript', ['删除后无法恢复', '如果这一章后面还有已定稿的章，删除后既补写不了这一章，也无法继续写后面的章节', '只想改写这一章，请取消，在这一章点「重新打开修改」']],
    ['zh-CN', 'draft', ['删除后无法恢复', '如果这一章后面还有已定稿的章，删除后既补写不了这一章，也无法继续写后面的章节', '只想改写这一章，请取消，在这一章点「重新打开修改」']],
    ['en-US', 'manuscript', ['This cannot be undone', 'If later chapters are already finalized, you will not be able to rewrite this chapter or keep writing later ones', 'To rewrite only this chapter, cancel and choose “Reopen to edit” on this chapter']],
    ['en-US', 'draft', ['This cannot be undone', 'If later chapters are already finalized, you will not be able to rewrite this chapter or keep writing later ones', 'To rewrite only this chapter, cancel and choose “Reopen to edit” on this chapter']],
  ] as const)('%s 界面的 %s 入口：写明删后无法恢复、后面有定稿会写不下去、只想改写用重新打开修改；取消后不删', async (locale, surface, phrases) => {
    useLocaleStore.setState({ locale })
    mocks.confirm.mockResolvedValueOnce(false)
    await deleteFinalizedChapter({ ...input, surface })
    const [message] = mocks.confirm.mock.calls[0] as unknown as [string]
    for (const phrase of phrases) expect(message).toContain(phrase)
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})
