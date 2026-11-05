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
  const zh = ['移到回收站，可以随时恢复', '后面的章节', '可能要跟着改', '「重新打开修改」']
  const en = ['move to the trash and can be restored', 'Later chapters', 'may need changes', '“Reopen to edit”']
  it.each([
    ['zh-CN', 'manuscript', zh],
    ['zh-CN', 'draft', zh],
    ['en-US', 'manuscript', en],
    ['en-US', 'draft', en],
  ] as const)('%s 界面的 %s 入口：短短几行写明进回收站可恢复、后面章节可能要改、只想修改用重新打开修改，不再说无法恢复或要点待更新；取消后不删', async (locale, surface, phrases) => {
    useLocaleStore.setState({ locale })
    mocks.confirm.mockResolvedValueOnce(false)
    await deleteFinalizedChapter({ ...input, surface })
    const [message] = mocks.confirm.mock.calls[0] as unknown as [string]
    for (const phrase of phrases) expect(message).toContain(phrase)
    expect(message.split('\n')).toHaveLength(4)
    expect(message).not.toMatch(/投影|定稿事实|无法恢复|待更新|projection|finalized fact|cannot be undone|out of date/)
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})

describe('删除定稿章成功后的说明（#564）', () => {
  it.each([
    ['zh-CN', ['「第3章」', '移到回收站', '可以随时恢复']],
    ['en-US', ['“第3章”', 'to the trash', 'restore it']],
  ] as const)('%s 界面：提示移到了回收站、可以恢复', async (locale, phrases) => {
    useLocaleStore.setState({ locale })
    mocks.invoke.mockResolvedValue({ committed: true, success: true, operation: { legacyKnowledgeAuthorization: 'not_required' } })
    await deleteFinalizedChapter(input)
    const [message] = mocks.toast.success.mock.calls[0] as unknown as [string]
    for (const phrase of phrases) expect(message).toContain(phrase)
  })
})
