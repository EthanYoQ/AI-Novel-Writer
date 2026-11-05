import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../../../../index.css'
import '../../../../styles/paper-ink/index.css'
import type { DamagedTrashEntry, RestoreTrashedChapterResult, TrashedChapter } from '../../../../shared/chapter-deletion'
import type { ProjectData } from '../../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import TrashDialog from '../TrashDialog'
import { useChapterTrash } from '../use-chapter-trash'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROJECT_PATH = 'C:\\novels\\trash'
const SESSION = { projectId: 'trash', leaseId: 'trash-lease', projectPath: PROJECT_PATH }
const originalProject = useProjectStore.getState()

let root: Root | undefined
let host: HTMLDivElement | undefined
let entries: TrashedChapter[]
let damaged: DamagedTrashEntry[]
let restoreResult: RestoreTrashedChapterResult
let invoke: ReturnType<typeof vi.fn>

const calls = (channel: string) => invoke.mock.calls.filter(call => call[0] === channel)

function entry(chapterNumber: number, overrides: Partial<TrashedChapter> = {}): TrashedChapter {
  return {
    deletionId: `del-${chapterNumber}`, draftId: chapterNumber * 10, chapterNumber, chapterTitle: `灯塔${chapterNumber}`,
    deletedAt: '2026-11-05T06:00:00.000Z', wordCount: 3120, versionCount: 2, cleanup: 'completed', restoreMode: 'into-gap', ...overrides,
  }
}

function project(): ProjectData {
  return {
    id: 'trash', sessionLease: 'trash-lease', name: '灯塔', path: PROJECT_PATH,
    novelConfig: {
      genre: '悬疑', subGenre: '', targetAudience: '成人', totalChapters: 12, wordsPerChapter: 3000, plotStructure: 'three_act',
      narrativePOV: 'third_limited', coreOutline: '灯塔', worldSetting: '', goldenFinger: '', protagonistProfile: '', globalGuidance: '',
    },
    characterStates: '', createdAt: '', updatedAt: '',
  }
}

async function render() {
  const Harness = () => <TrashDialog open onOpenChange={() => undefined} trash={useChapterTrash()} />
  host = document.createElement('div')
  host.className = 'paper-ink'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<Harness />))
}

beforeEach(async () => {
  // 前面用例留下的提示条叠在小视口的对话框上会挡住按钮，给足高度。
  await page.viewport(1280, 900)
  entries =[entry(3), entry(5, { cleanup: 'failed', versionCount: 1, wordCount: 1200 })]
  damaged = [{ deletionId: 'del-broken', error: 'CHAPTER_TRASH_ENTRY_INVALID' }]
  restoreResult = { success: true, outcome: 'restored', chapterNumber: 3, draftId: 30, finalizationId: 'fin-3', publicationStatus: 'published' }
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ currentProject: project() })
  setActiveProjectSessionContext(SESSION)
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'chapter:trash-list') return { success: true, entries, damaged }
    if (channel === 'chapter:trash-restore') {
      if (restoreResult.success) entries = entries.filter(item => item.deletionId !== (args[0] as { deletionId: string }).deletionId)
      return restoreResult
    }
    if (channel === 'chapter:trash-purge') {
      const request = args[0] as { deletionIds?: string[]; all?: true }
      const purged = request.all ? [...entries.map(item => item.deletionId), ...damaged.map(item => item.deletionId)] : request.deletionIds ?? []
      entries = entries.filter(item => !purged.includes(item.deletionId))
      damaged = damaged.filter(item => !purged.includes(item.deletionId))
      return { success: true, purged, alreadyGone: [] }
    }
    if (channel === 'chapter:retry-deletion') {
      entries = entries.map(item => item.deletionId === args[0] ? { ...item, cleanup: 'completed' } : item)
      return { success: true, committed: true }
    }
    if (channel === 'db:draft-list-all') return []
    throw new Error(`unexpected IPC ${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', {
    configurable: true,
    value: { invoke, on: vi.fn(() => () => {}), once: vi.fn(), send: vi.fn(), setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn(() => 0) },
  })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  Reflect.deleteProperty(window, 'aiNovelAPI')
  setActiveProjectSessionContext(null)
  useProjectStore.setState(originalProject)
})

const dialog = () => page.getByRole('dialog', { name: /^回收站/ })
const item = (text: string) => [...document.querySelectorAll<HTMLElement>('.stage-trash-item')].find(node => node.textContent?.includes(text))!

describe('回收站对话框（#564）', () => {
  it('每项写出章号、标题、删除时间、字数、版本数与清理进度；读不全的一项单独列出，不挡其余各项', async () => {
    await render()
    await expect.element(dialog()).toHaveAccessibleName('回收站（3）')
    const third = item('第 3 章')
    expect(third.textContent).toContain('灯塔3')
    expect(third.textContent).toMatch(/删除于 .*2026.* · 3,120 字 · 2 个版本/)
    expect(third.textContent).not.toContain('还没清理完')
    expect(third.querySelector('button')?.textContent).toBe('恢复')

    const fifth = item('第 5 章')
    expect(fifth.textContent).toContain('1,200 字 · 1 个版本')
    expect(fifth.textContent).toContain('实体稿或知识库还没清理完')
    expect([...fifth.querySelectorAll('button')].map(button => button.textContent)).toEqual(['重试清理', '恢复', '彻底删除…'])

    const broken = item('有一项读不全')
    expect(broken.textContent).toContain('回收站里这一项的记录不完整，没法恢复')
    expect(broken.textContent).not.toContain('CHAPTER_TRASH_ENTRY_INVALID')
    await expect.element(dialog()).toHaveTextContent('回收站里的章节会随作品备份和导出一起带走')
    await expect.element(dialog().getByRole('button', { name: '清空回收站…' })).toBeEnabled()
  })

  it('恢复按列表给的方式发请求，成功后说明恢复了什么并提醒软件外改过的 txt 留着，回收站随即重读', async () => {
    await render()
    await expect.element(dialog()).toHaveAccessibleName('回收站（3）')
    const lists = calls('chapter:trash-list').length
    await act(async () => item('第 3 章').querySelector('button')!.click())
    await vi.waitFor(() => expect(calls('chapter:trash-restore')).toHaveLength(1))
    expect(calls('chapter:trash-restore')[0][1]).toEqual({ deletionId: 'del-3', draftId: 30, expectedMode: 'into-gap' })
    await expect.element(page.getByText(/已恢复第 3 章，正文和全部版本都回来了/)).toBeVisible()
    await expect.element(page.getByText(/在软件外改过这一章的 txt，那份文件当时留着没删/)).toBeVisible()
    await vi.waitFor(() => expect(calls('chapter:trash-list').length).toBeGreaterThan(lists))
    await expect.element(dialog()).toHaveAccessibleName('回收站（2）')
  })

  it('恢复被拒（批次没写完）：写明正文还在、为什么不能放回、去哪里结束批量，不露错误码', async () => {
    restoreResult = { success: false, error: 'CHAPTER_RESTORE_BATCH_UNFINISHED' }
    await render()
    await expect.element(dialog()).toHaveAccessibleName('回收站（3）')
    await act(async () => item('第 3 章').querySelector('button')!.click())
    await expect.element(page.getByText(/回收站里的正文还在。这一章属于一次还没写完的批量创作/)).toBeVisible()
    expect(document.body.textContent).not.toContain('CHAPTER_RESTORE_BATCH_UNFINISHED')
    await expect.element(dialog()).toHaveAccessibleName('回收站（3）')
  })

  it('重试清理续跑这次删除的清理，完成后这一项不再标清理未完成', async () => {
    await render()
    await expect.element(dialog()).toHaveAccessibleName('回收站（3）')
    await act(async () => dialog().getByRole('button', { name: '重试清理' }).click())
    await vi.waitFor(() => expect(calls('chapter:retry-deletion')).toHaveLength(1))
    expect(calls('chapter:retry-deletion')[0][1]).toBe('del-5')
    await vi.waitFor(() => expect(item('第 5 章').textContent).not.toContain('还没清理完'))
  })

  it('彻底删除先危险确认，取消不删；确认后只删这一项', async () => {
    await render()
    await expect.element(dialog()).toHaveAccessibleName('回收站（3）')
    await act(async () => (item('第 3 章').querySelectorAll('button')[1] as HTMLButtonElement).click())
    const confirm = page.getByRole('dialog', { name: '彻底删除第 3 章「灯塔3」？' })
    await expect.element(confirm).toHaveTextContent('彻底删除后，回收站里第 3 章的正文和版本无法再恢复。其他章节不受影响。')
    await act(async () => confirm.getByRole('button', { name: '取消' }).click())
    expect(calls('chapter:trash-purge')).toHaveLength(0)

    await act(async () => (item('第 3 章').querySelectorAll('button')[1] as HTMLButtonElement).click())
    await act(async () => page.getByRole('dialog', { name: '彻底删除第 3 章「灯塔3」？' }).getByRole('button', { name: '彻底删除' }).click())
    await vi.waitFor(() => expect(calls('chapter:trash-purge')).toHaveLength(1))
    expect(calls('chapter:trash-purge')[0][1]).toEqual({ deletionIds: ['del-3'] })
    await expect.element(dialog()).toHaveAccessibleName('回收站（2）')
  })

  it('清理没完成的项彻底删除时，确认框说明项目文件夹或知识库里可能还留着它', async () => {
    await render()
    await expect.element(dialog()).toHaveAccessibleName('回收站（3）')
    await act(async () => dialog().getByRole('button', { name: '彻底删除…' }).nth(1).click())
    await expect.element(page.getByRole('dialog', { name: '彻底删除第 5 章「灯塔5」？' })).toHaveTextContent('这一项的清理还没完成，项目文件夹或知识库里可能还留着它')
  })

  it('清空回收站连读不全的项一起删', async () => {
    await render()
    await expect.element(dialog()).toHaveAccessibleName('回收站（3）')
    await act(async () => dialog().getByRole('button', { name: '清空回收站…' }).click())
    const confirm = page.getByRole('dialog', { name: '清空回收站？' })
    await expect.element(confirm).toHaveTextContent('回收站里 3 项的正文和版本都会彻底删除，无法再恢复')
    await act(async () => confirm.getByRole('button', { name: '清空回收站' }).click())
    await vi.waitFor(() => expect(calls('chapter:trash-purge')[0]?.[1]).toEqual({ all: true }))
    await expect.element(dialog()).toHaveAccessibleName('回收站（0）')
    await expect.element(dialog()).toHaveTextContent('回收站是空的')
  })

  it('英文界面：标题、按钮与说明都是英文', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    await render()
    const trash = page.getByRole('dialog', { name: 'Trash (3)' })
    await expect.element(trash).toBeVisible()
    expect(item('Chapter 3').textContent).toMatch(/Deleted .* · 3,120 words · 2 versions/)
    await expect.element(trash.getByRole('button', { name: 'Retry cleanup' })).toBeVisible()
    await expect.element(trash.getByRole('button', { name: 'Empty trash…' })).toBeVisible()
    expect(item('An item could not be read').textContent).toContain('The record for this trash item is incomplete')
  })
})
