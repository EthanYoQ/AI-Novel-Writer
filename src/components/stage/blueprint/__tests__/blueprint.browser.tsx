import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { TrashedChapter } from '../../../../shared/chapter-deletion'
import type { AuthoritativeChapterSequence } from '../../../../shared/chapter-sequence'
import type { ProjectData } from '../../../../shared/ipc-channels'
import { globalEventBus } from '../../../../shared/event-bus'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { disposeProjectService, initProjectService } from '../../../../services/project-service'
import type { ChapterBlueprint } from '../../../../services/workflows/directory-workflow'
import { editorSaveHandler, useEditorStore } from '../../../../stores/editor-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useStageStore } from '../../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../../stores/project-store'
import StageBlueprint from '../StageBlueprint'

const writableOverride = vi.hoisted(() => ({ value: null as number[] | null }))
// 用以 /src 开头的路径：检出路径含空格时（本机 Vibe Coding Project），浏览器模式匹配不到相对路径的模拟。
vi.mock('/src/services/authoritative-chapter-sequence.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../services/authoritative-chapter-sequence')>()
  return {
    ...actual,
    readWritableChapters: async (...args: Parameters<typeof actual.readWritableChapters>) => {
      const chapters = await actual.readWritableChapters(...args)
      return writableOverride.value ? { ...chapters, writable: writableOverride.value } : chapters
    },
  }
})

const PROJECT_PATH = 'C:\\novels\\stage-blueprint'
const SESSION = { projectId: 'stage-blueprint', leaseId: 'stage-blueprint-lease', projectPath: PROJECT_PATH }
const originalEditor = useEditorStore.getState()
const originalProject = useProjectStore.getState()
const originalStage = useStageStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined
let stored: ChapterBlueprint[]
let nextChapter: number
let projectCore: { premise: string } | null
let invoke: ReturnType<typeof vi.fn>
let authority: AuthoritativeChapterSequence | null
let trashEntries: TrashedChapter[]
let trashListFails: boolean

function trashed(chapterNumber: number, restoreMode: TrashedChapter['restoreMode'] = 'into-gap'): TrashedChapter {
  return {
    deletionId: `del-${chapterNumber}`, draftId: chapterNumber * 10, chapterNumber, chapterTitle: '灯室', deletedAt: '2026-11-05T06:00:00.000Z',
    wordCount: 3120, versionCount: 2, cleanup: 'completed', restoreMode,
  }
}

function blueprint(chapterNumber: number, title: string): ChapterBlueprint {
  return {
    chapterNumber, title, role: '发展', purpose: '推进灯塔线索', keyEvents: '钟声提前一刻', characters: ['林岚', '守塔人'],
    suspenseHook: '', userGuidance: chapterNumber === 2 ? '节奏放慢。' : '', notes: '', notesUpdatedAt: '',
  }
}

function project(): ProjectData {
  return {
    id: 'stage-blueprint', sessionLease: 'stage-blueprint-lease', name: '灯塔', path: PROJECT_PATH,
    novelConfig: {
      genre: '悬疑', subGenre: '', targetAudience: '成人', totalChapters: 12, wordsPerChapter: 3000, plotStructure: 'three_act',
      narrativePOV: 'third_limited', coreOutline: '灯塔', worldSetting: '', goldenFinger: '', protagonistProfile: '', globalGuidance: '',
    },
    characterStates: '', createdAt: '', updatedAt: '',
  }
}

function installIpc() {
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'db:blueprint-get-all') return stored
    if (channel === 'db:draft-authority-sequence') return authority ?? {
      status: 'continuous', lastChapterNumber: nextChapter - 1, nextChapterNumber: nextChapter, gaps: [], duplicateChapterNumbers: [], authorityFingerprint: 'a'.repeat(64),
    }
    if (channel === 'generation:find-blueprint-recovery') return null
    if (channel === 'db:consistency-exemption-list') return []
    if (channel === 'chapter:trash-list') {
      if (trashListFails) throw new Error('trash list unavailable')
      return { success: true, entries: trashEntries, damaged: [] }
    }
    if (channel === 'chapter:trash-restore') {
      trashEntries = []
      authority = null
      return { success: true, outcome: 'restored', chapterNumber: 3, draftId: 30, finalizationId: 'fin-3', publicationStatus: 'published' }
    }
    if (channel === 'db:draft-list-all') return []
    if (channel === 'db:blueprint-clear-all') {
      stored = []
      return { success: true }
    }
    if (channel === 'db:blueprint-delete') {
      stored = stored.filter(item => item.chapterNumber !== args[0])
      return { success: true }
    }
    if (channel === 'db:blueprint-upsert' || channel === 'db:blueprint-upsert-many') return { success: true }
    if (channel === 'fs:list-dir') return []
    if (channel === 'config:get') return { blueprintTargetUnits: 800 }
    if (channel === 'config:set') return { success: true }
    if (channel === 'generation:list-directory-progress') return { progress: [], diagnostics: [] }
    if (channel === 'db:blueprint-character-sync-list-pending') return []
    if (channel === 'db:project-core-get') return projectCore
    if (channel === 'db:character-get-all') return [{ id: 1 }]
    throw new Error(`unexpected IPC ${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', {
    configurable: true,
    value: { invoke, on: vi.fn(() => () => {}), once: vi.fn(), send: vi.fn(), setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn(() => 0) },
  })
}

const calls = (channel: string) => invoke.mock.calls.filter(call => call[0] === channel)

async function renderPage(initialChapterNumber?: number) {
  await act(async () => root?.render(<div className="paper-ink"><StageBlueprint projectKey={PROJECT_PATH} initialChapterNumber={initialChapterNumber} /></div>))
  await expect.element(page.getByRole('complementary', { name: '章节规划' })).toBeVisible()
}

/** 后台生成提交一段蓝图、定稿、删除或清空之后，蓝图页都会收到这条刷新。 */
async function refreshBlueprints() {
  const before = calls('db:blueprint-get-all').length
  await act(async () => globalEventBus.emit('REFRESH_RESOURCE', { resources: ['blueprints'], projectPath: PROJECT_PATH,
    projectSession: SESSION }))
  await vi.waitFor(() => expect(calls('db:blueprint-get-all').length).toBeGreaterThan(before))
  await vi.waitFor(() => expect(calls('db:draft-authority-sequence').length).toBe(calls('db:blueprint-get-all').length))
}

beforeEach(async () => {
  await page.viewport(1280, 900)
  // 视口变化的 resize 事件可能晚于渲染才到，浮层收到 resize 会关闭：先等它派发完。
  await vi.waitFor(() => expect([window.innerWidth, window.innerHeight]).toEqual([1280, 900]))
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  stored = [blueprint(1, '旧港'), blueprint(2, '北堤'), blueprint(3, '灯室')]
  nextChapter = 2
  projectCore = null
  authority = null
  trashEntries = []
  trashListFails = false
  writableOverride.value = null
  useLocaleStore.setState({ locale: 'zh-CN' })
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useProjectStore.setState({ currentProject: project() })
  useStageStore.setState({ writeRequest: null, work: null })
  setActiveProjectSessionContext(SESSION)
  installIpc()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  Reflect.deleteProperty(window, 'aiNovelAPI')
  setActiveProjectSessionContext(null)
  useEditorStore.setState(originalEditor)
  useProjectStore.setState(originalProject)
  useStageStore.setState(originalStage)
})

describe('蓝图阶段', () => {
  it('打开蓝图页只向主进程要一次章节蓝图恢复稿，不逐个读取生成运行（#536）', async () => {
    await renderPage()
    await vi.waitFor(() => expect(calls('generation:find-blueprint-recovery')).toHaveLength(1))
    expect([...calls('generation:list'), ...calls('generation:read-context')]).toEqual([])
  })
  it('主按钮是写下一章的拆分按钮，点箭头只出现小弹层', async () => {
    await renderPage()
    await expect.element(page.getByRole('button', { name: '写第 2 章' })).toBeVisible()
    expect(page.getByRole('button', { name: '写第 2 章' }).element().className).toContain('pi-btn--primary')
    expect(page.getByRole('button', { name: 'AI 生成蓝图' }).element().className).toContain('pi-btn--secondary')
    await act(async () => page.getByRole('button', { name: '本次写作选项' }).click())
    await expect.element(page.getByRole('dialog', { name: '本次写作选项' })).toBeVisible()
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
  })

  it('英文界面里只有一章蓝图时写 1 chapter，不写 1 chapters', async () => {
    stored = [blueprint(1, '旧港')]
    await renderPage()
    await act(async () => useLocaleStore.setState({ locale: 'en-US' }))
    expect(document.querySelector('.stage-bp-plan-top')?.textContent).toBe('1 chapter')
  })

  it('清空全部蓝图在危险分组里，确认前不清空，确认后列表为空并出现空状态', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: '更多蓝图操作' }).click())
    const dangerGroup = page.getByRole('group', { name: '危险' })
    await act(async () => dangerGroup.getByRole('menuitem', { name: '清空全部蓝图…' }).click())
    const confirm = page.getByRole('dialog', { name: '清空全部蓝图？' })
    await expect.element(confirm).toHaveTextContent('将删除全部 3 章蓝图')
    expect(calls('db:blueprint-clear-all')).toHaveLength(0)

    await act(async () => confirm.getByRole('button', { name: '取消' }).click())
    expect(calls('db:blueprint-clear-all')).toHaveLength(0)
    await expect.element(page.getByRole('button', { name: /^1\D/ })).toBeVisible()

    await act(async () => page.getByRole('button', { name: '更多蓝图操作' }).click())
    await act(async () => page.getByRole('menuitem', { name: '清空全部蓝图…' }).click())
    await act(async () => page.getByRole('dialog', { name: '清空全部蓝图？' }).getByRole('button', { name: '清空全部' }).click())
    await vi.waitFor(() => expect(calls('db:blueprint-clear-all')).toHaveLength(1))
    await expect.element(page.getByRole('heading', { name: '还没有章节蓝图' })).toBeVisible()
    expect(page.getByRole('complementary', { name: '章节规划' }).query()).toBeNull()
  })

  it('删掉第 1 章定稿后整本照常可写：缺口章与下一章都有写作入口，批量、生成蓝图、新建章节都可用（#564）', async () => {
    authority = {
      status: 'gapped', lastChapterNumber: 2, nextChapterNumber: 3, gaps: [{ from: 1, to: 1, cause: 'deleted' }],
      duplicateChapterNumbers: [], authorityFingerprint: 'b'.repeat(64),
    }
    await renderPage()

    await expect.element(page.getByRole('button', { name: '写第 3 章' })).toBeVisible()
    const notice = page.getByText('第 1 章的正文已删除').element().closest('.pi-notice')
    expect(notice?.textContent).toContain('后面的章节都还在，照常可写')
    await vi.waitFor(() => expect(page.getByText('第 1 章的正文已删除').element().closest('.pi-notice')?.textContent).toContain('删掉的正文找不回来'))
    await expect.element(page.getByRole('button', { name: '写第 1 章' })).toBeVisible()
    expect(page.getByRole('button', { name: '清除误导入正文…' }).query()).toBeNull()
    await expect.element(page.getByRole('button', { name: '批量创作' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'AI 生成蓝图' })).toBeEnabled()
    await act(async () => page.getByRole('button', { name: '更多蓝图操作' }).click())
    await expect.element(page.getByRole('menuitem', { name: '新建章节' })).not.toHaveAttribute('aria-disabled', 'true')
  })

  it('回收站读不出来时不说删掉的正文找不回来，缺口章照常可写（#592）', async () => {
    authority = {
      status: 'gapped', lastChapterNumber: 2, nextChapterNumber: 3, gaps: [{ from: 1, to: 1, cause: 'deleted' }],
      duplicateChapterNumbers: [], authorityFingerprint: 'b'.repeat(64),
    }
    trashEntries = [trashed(1)]
    trashListFails = true
    await renderPage()

    await vi.waitFor(() => expect(calls('chapter:trash-list').length).toBeGreaterThan(0))
    const notice = page.getByText('第 1 章的正文已删除')
    await expect.element(notice).toBeVisible()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    const body = notice.element().closest('.pi-notice')?.textContent
    expect(body).toContain('后面的章节都还在，照常可写')
    expect(body).not.toContain('找不回来')
    await expect.element(page.getByRole('button', { name: '写第 1 章' })).toBeVisible()

    trashListFails = false
    await act(async () => globalEventBus.emit('CHAPTER_DELETION_UPDATED', { projectPath: PROJECT_PATH, projectSession: SESSION }))
    await expect.element(page.getByText('第 1 章已删除，正文在回收站里')).toBeVisible()
  })

  it('读到过空回收站后删了一章、重读回收站失败：不拿旧的空列表下「找不回来」的结论（#592）', async () => {
    await renderPage()
    await vi.waitFor(() => expect(calls('chapter:trash-list').length).toBeGreaterThan(0))

    authority = {
      status: 'gapped', lastChapterNumber: 2, nextChapterNumber: 3, gaps: [{ from: 1, to: 1, cause: 'deleted' }],
      duplicateChapterNumbers: [], authorityFingerprint: 'b'.repeat(64),
    }
    trashEntries = [trashed(1)]
    trashListFails = true
    const trashReads = calls('chapter:trash-list').length
    await act(async () => globalEventBus.emit('CHAPTER_DELETION_UPDATED', { projectPath: PROJECT_PATH, projectSession: SESSION }))
    await vi.waitFor(() => expect(calls('chapter:trash-list').length).toBeGreaterThan(trashReads))
    await refreshBlueprints()
    const notice = page.getByText('第 1 章的正文已删除')
    await expect.element(notice).toBeVisible()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(notice.element().closest('.pi-notice')?.textContent).not.toContain('找不回来')
    await expect.element(page.getByRole('button', { name: '写第 1 章' })).toBeVisible()
  })

  it('缺口段首章没写、后一章在回收站里：卡片指明那一章，恢复它，写作仍从段首开始（#592）', async () => {
    stored = Array.from({ length: 5 }, (_, index) => blueprint(index + 1, `第${index + 1}章`))
    authority = {
      status: 'gapped', lastChapterNumber: 4, nextChapterNumber: 5, gaps: [{ from: 2, to: 3, cause: 'deleted' }],
      duplicateChapterNumbers: [], authorityFingerprint: 'b'.repeat(64),
    }
    trashEntries = [trashed(3)]
    await renderPage()

    const notice = page.getByText('第 2～3 章已删除，第 3 章的正文在回收站里')
    await expect.element(notice).toBeVisible()
    const body = notice.element().closest('.pi-notice')?.textContent
    expect(body).toContain('点「恢复」放回这一章')
    expect(body).not.toContain('重写')
    expect(body).not.toContain('找不回来')
    await expect.element(page.getByRole('button', { name: '写第 2 章' })).toBeVisible()
    expect(page.getByRole('button', { name: '重写第 2 章' }).query()).toBeNull()
    expect(page.getByRole('button', { name: '重写第 3 章' }).query()).toBeNull()

    await act(async () => page.getByRole('button', { name: '恢复', exact: true }).click())
    await vi.waitFor(() => expect(calls('chapter:trash-restore')).toHaveLength(1))
    expect(calls('chapter:trash-restore')[0][1]).toMatchObject({ deletionId: 'del-3', expectedMode: 'into-gap' })
  })

  it('删掉的第 3 章在回收站里：「写第 13 章」「批量创作」「恢复」「重写第 3 章」同时出现，点恢复按列表给的方式放回并重读（#564）', async () => {
    stored = Array.from({ length: 13 }, (_, index) => blueprint(index + 1, `第${index + 1}章`))
    authority = {
      status: 'gapped', lastChapterNumber: 12, nextChapterNumber: 13, gaps: [{ from: 3, to: 3, cause: 'deleted' }],
      duplicateChapterNumbers: [], authorityFingerprint: 'b'.repeat(64),
    }
    trashEntries = [trashed(3)]
    await renderPage()

    const notice = page.getByText('第 3 章已删除，正文在回收站里')
    await expect.element(notice).toBeVisible()
    expect(notice.element().closest('.pi-notice')?.textContent).toContain('点「恢复」放回这一章')
    await expect.element(page.getByRole('button', { name: '写第 13 章' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: '批量创作' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: '重写第 3 章' })).toBeVisible()
    const restore = page.getByRole('button', { name: '恢复', exact: true })
    await expect.element(restore).toBeVisible()

    const sequenceReads = calls('db:draft-authority-sequence').length
    await act(async () => restore.click())
    await vi.waitFor(() => expect(calls('chapter:trash-restore')).toHaveLength(1))
    expect(calls('chapter:trash-restore')[0][1]).toEqual({ deletionId: 'del-3', draftId: 30, expectedMode: 'into-gap' })
    await vi.waitFor(() => expect(calls('db:draft-authority-sequence').length).toBeGreaterThan(sequenceReads))
    await vi.waitFor(() => expect(page.getByText('第 3 章已删除，正文在回收站里').query()).toBeNull())
  })

  it('转移来的作品，回收站这一项只能开新稿：恢复请求带 reopen-as-draft（#564）', async () => {
    authority = {
      status: 'gapped', lastChapterNumber: 2, nextChapterNumber: 3, gaps: [{ from: 1, to: 1, cause: 'deleted' }],
      duplicateChapterNumbers: [], authorityFingerprint: 'b'.repeat(64),
    }
    trashEntries = [trashed(1, 'reopen-as-draft')]
    await renderPage()
    await act(async () => page.getByRole('button', { name: '恢复', exact: true }).click())
    await vi.waitFor(() => expect(calls('chapter:trash-restore')).toHaveLength(1))
    expect(calls('chapter:trash-restore')[0][1]).toMatchObject({ deletionId: 'del-1', expectedMode: 'reopen-as-draft' })
  })

  it('英文界面：回收站里的缺口章写 Restore 与 Rewrite chapter 3（#564）', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    stored = Array.from({ length: 4 }, (_, index) => blueprint(index + 1, `第${index + 1}章`))
    authority = {
      status: 'gapped', lastChapterNumber: 3, nextChapterNumber: 4, gaps: [{ from: 3, to: 3, cause: 'deleted' }],
      duplicateChapterNumbers: [], authorityFingerprint: 'b'.repeat(64),
    }
    trashEntries = [trashed(3)]
    await act(async () => root?.render(<div className="paper-ink"><StageBlueprint projectKey={PROJECT_PATH} /></div>))
    await expect.element(page.getByText('Chapter 3 was deleted; its text is in the trash')).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Rewrite chapter 3' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Restore', exact: true })).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Write chapter 4' })).toBeVisible()
  })

  it('写作请求落在缺口章时留给那一章的单章视图，落在写不了的章时丢掉（#564）', async () => {
    authority = {
      status: 'gapped', lastChapterNumber: 2, nextChapterNumber: 3, gaps: [{ from: 1, to: 1, cause: 'deleted' }],
      duplicateChapterNumbers: [], authorityFingerprint: 'b'.repeat(64),
    }
    await renderPage()
    await expect.element(page.getByRole('button', { name: '写第 1 章' })).toBeVisible()

    await act(async () => useStageStore.setState({ writeRequest: { session: SESSION, chapterNumber: 1 } }))
    expect(useStageStore.getState().writeRequest).toMatchObject({ chapterNumber: 1 })
    await act(async () => useStageStore.setState({ writeRequest: { session: SESSION, chapterNumber: 2 } }))
    await vi.waitFor(() => expect(useStageStore.getState().writeRequest).toBeNull())
  })

  it('哪些章能写只听定稿序列给的可写章，蓝图页不另算（#564）', async () => {
    authority = {
      status: 'gapped', lastChapterNumber: 3, nextChapterNumber: 4, gaps: [{ from: 1, to: 2, cause: 'deleted' }],
      duplicateChapterNumbers: [], authorityFingerprint: 'b'.repeat(64),
    }
    writableOverride.value = [1, 2, 4]
    await renderPage()
    await expect.element(page.getByRole('button', { name: '写第 1 章' })).toBeVisible()

    await act(async () => useStageStore.setState({ writeRequest: { session: SESSION, chapterNumber: 2 } }))
    expect(useStageStore.getState().writeRequest).toMatchObject({ chapterNumber: 2 })
    await act(async () => useStageStore.setState({ writeRequest: { session: SESSION, chapterNumber: 3 } }))
    await vi.waitFor(() => expect(useStageStore.getState().writeRequest).toBeNull())
  })

  it('缺口章的蓝图也删了时，在原位置补一张空白蓝图（#564）', async () => {
    stored = [blueprint(2, '北堤'), blueprint(3, '灯室')]
    authority = {
      status: 'gapped', lastChapterNumber: 2, nextChapterNumber: 3, gaps: [{ from: 1, to: 1, cause: 'deleted' }],
      duplicateChapterNumbers: [], authorityFingerprint: 'b'.repeat(64),
    }
    await renderPage()
    expect(page.getByRole('button', { name: '写第 1 章' }).query()).toBeNull()

    await act(async () => page.getByRole('button', { name: '补上第 1 章蓝图' }).click())

    await expect.element(page.getByRole('region', { name: '第 1 章蓝图' })).toBeVisible()
    expect([...document.querySelectorAll('.stage-bp-plan-no')].map(node => node.textContent)).toEqual(['1', '2', '3'])
    expect(page.getByRole('button', { name: '写第 1 章' }).query()).toBeNull()
    expect(page.getByText(/先保存第 1 章蓝图，再写这一章/).query()).not.toBeNull()
    expect(page.getByRole('button', { name: '补上第 1 章蓝图' }).query()).toBeNull()

    await act(async () => page.getByRole('button', { name: '保存此章' }).click())
    await expect.element(page.getByRole('button', { name: '写第 1 章' })).toBeVisible()
  })

  it('缺的是连续几章时，提示按几章说，并点明只能先写段首那一章（#564）', async () => {
    authority = {
      status: 'gapped', lastChapterNumber: 3, nextChapterNumber: 4, gaps: [{ from: 1, to: 2, cause: 'unexplained' }],
      duplicateChapterNumbers: [], authorityFingerprint: 'b'.repeat(64),
    }
    await renderPage()

    const notice = page.getByText('第 1～2 章还没写，后面却已有正文').element().closest('.pi-notice')
    expect(notice?.textContent).toContain('只是缺这几章时，要从第 1 章起逐章写，前一章定稿后才能写下一章。点「写第 1 章」在原位置重写。')
    expect(notice?.textContent).not.toContain('这一章')
    await expect.element(page.getByRole('button', { name: '写第 1 章' })).toBeVisible()
    expect(page.getByRole('button', { name: '写第 2 章' }).query()).toBeNull()
  })

  it('英文界面里删掉连续几章、蓝图也没了时，提示按几章说，并点明先补段首那一章的蓝图（#564）', async () => {
    stored = [blueprint(3, '灯室')]
    authority = {
      status: 'gapped', lastChapterNumber: 3, nextChapterNumber: 4, gaps: [{ from: 1, to: 2, cause: 'deleted' }],
      duplicateChapterNumbers: [], authorityFingerprint: 'b'.repeat(64),
    }
    await renderPage()
    await act(async () => useLocaleStore.setState({ locale: 'en-US' }))

    const notice = page.getByText('Chapters 1–2 were deleted').element().closest('.pi-notice')
    expect(notice?.textContent).toContain('Write them one at a time from Chapter 1; each opens once the one before it is finalized.')
    expect(notice?.textContent).toContain('Chapter 1’s blueprint is gone too. Choose “Add chapter 1 blueprint”')
    expect(notice?.textContent).not.toContain('Its blueprint')
    await expect.element(page.getByRole('button', { name: 'Add chapter 1 blueprint' })).toBeVisible()
  })

  it('没有删除记录的缺口也能写；清除误导入正文放在次级位置，确认框说明它清的是全书（#564）', async () => {
    authority = {
      status: 'gapped', lastChapterNumber: 2, nextChapterNumber: 3, gaps: [{ from: 1, to: 1, cause: 'unexplained' }],
      duplicateChapterNumbers: [], authorityFingerprint: 'b'.repeat(64),
    }
    await renderPage()
    await expect.element(page.getByText('第 1 章还没写，后面却已有正文')).toBeVisible()
    await expect.element(page.getByRole('button', { name: '写第 1 章' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: '写第 3 章' })).toBeVisible()
    const clear = page.getByRole('button', { name: '清除误导入正文…' })
    expect(clear.element().className).toContain('pi-btn--text')

    await act(async () => clear.click())
    const confirm = page.getByRole('dialog', { name: '清除误导入正文？' })
    await expect.element(confirm).toHaveTextContent('会清空全书所有章节的正文，包括回收站里的，不只是缺的那一章')
    await expect.element(confirm).toHaveTextContent('只是删了某一章的话，请取消，从回收站恢复它')
  })

  it('同一章有两份定稿时仍停写并说明原因', async () => {
    authority = {
      status: 'invalid', lastChapterNumber: 2, gaps: [], duplicateChapterNumbers: [2], authorityFingerprint: 'b'.repeat(64),
    }
    await renderPage()
    await expect.element(page.getByText('暂时无法确定下一章')).toBeVisible()
    expect(page.getByRole('button', { name: /^写第 \d+ 章$/ }).query()).toBeNull()
    await expect.element(page.getByRole('button', { name: 'AI 生成蓝图' })).toBeDisabled()
  })

  it('删除此章在单章的危险分组里，确认后只删这一章', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: /^3\D/ }).click())
    await act(async () => page.getByRole('button', { name: '第 3 章更多操作' }).click())
    await act(async () => page.getByRole('group', { name: '危险' }).getByRole('menuitem', { name: '删除此章…' }).click())
    const confirm = page.getByRole('dialog', { name: '删除第 3 章蓝图？' })
    await expect.element(confirm).toBeVisible()
    expect(calls('db:blueprint-delete')).toHaveLength(0)
    await act(async () => confirm.getByRole('button', { name: '删除此章' }).click())
    await vi.waitFor(() => expect(calls('db:blueprint-delete').map(call => call[1])).toEqual([3]))
    await expect.element(page.getByRole('button', { name: /^3\D/ })).not.toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: /^2\D/ })).toBeVisible()
  })

  it('改字段后由外壳的保存（⌘S 同一入口）存全部，页面里不另显示未保存', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: /^2\D/ }).click())
    await act(async () => page.getByRole('textbox', { name: '章节标题' }).fill('北堤夜雨'))
    await act(async () => page.getByLabelText(/作者微操指导/).fill('节奏放慢，只写声音。'))
    expect(container?.textContent).not.toContain('未保存')

    const save = editorSaveHandler({ id: 'chapter-card-editor', type: 'chapter-card', projectKey: PROJECT_PATH })
    expect(save).not.toBeNull()
    await act(async () => { await save!() })
    const [[, saved]] = calls('db:blueprint-upsert-many')
    expect((saved as ChapterBlueprint[]).find(item => item.chapterNumber === 2)).toMatchObject({ title: '北堤夜雨', userGuidance: '节奏放慢，只写声音。' })
  })

  it('保存此章只写当前一章', async () => {
    await renderPage()
    await act(async () => page.getByRole('textbox', { name: '章节标题' }).fill('旧港潮汐'))
    await act(async () => page.getByRole('button', { name: '保存此章' }).click())
    await vi.waitFor(() => expect(calls('db:blueprint-upsert').map(call => call[1])).toMatchObject([{ chapterNumber: 1, title: '旧港潮汐' }]))
  })

  it('保存此章、删除此章、清空蓝图之后项目树不重读目录：蓝图只在数据库里', async () => {
    initProjectService()
    try {
      await renderPage()
      await act(async () => page.getByRole('textbox', { name: '章节标题' }).fill('旧港潮汐'))
      await act(async () => page.getByRole('button', { name: '保存此章' }).click())
      await vi.waitFor(() => expect(calls('db:blueprint-upsert')).toHaveLength(1))
      await act(async () => page.getByRole('button', { name: /^3\D/ }).click())
      await act(async () => page.getByRole('button', { name: '第 3 章更多操作' }).click())
      await act(async () => page.getByRole('group', { name: '危险' }).getByRole('menuitem', { name: '删除此章…' }).click())
      await act(async () => page.getByRole('dialog', { name: '删除第 3 章蓝图？' }).getByRole('button', { name: '删除此章' }).click())
      await vi.waitFor(() => expect(calls('db:blueprint-delete')).toHaveLength(1))
      await act(async () => page.getByRole('button', { name: '更多蓝图操作' }).click())
      await act(async () => page.getByRole('menuitem', { name: '清空全部蓝图…' }).click())
      await act(async () => page.getByRole('dialog', { name: '清空全部蓝图？' }).getByRole('button', { name: '清空全部' }).click())
      await vi.waitFor(() => expect(calls('db:blueprint-clear-all')).toHaveLength(1))
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)) })
      expect(calls('fs:list-dir')).toEqual([])
    } finally {
      disposeProjectService()
    }
  })

  it('保存此章与保存全部成功后通知流程脊、Ctrl P 重读蓝图；保存失败不通知', async () => {
    const refreshes: string[][] = []
    const off = globalEventBus.on('REFRESH_RESOURCE', ({ resources }) => { refreshes.push([...resources]) })
    try {
      await renderPage()
      await act(async () => page.getByRole('textbox', { name: '章节标题' }).fill('旧港潮汐'))
      await act(async () => page.getByRole('button', { name: '保存此章' }).click())
      await vi.waitFor(() => expect(refreshes).toEqual([['blueprints']]))

      const save = editorSaveHandler({ id: 'chapter-card-editor', type: 'chapter-card', projectKey: PROJECT_PATH })
      await act(async () => { await save!() })
      expect(refreshes).toEqual([['blueprints'], ['blueprints']])

      const base = invoke.getMockImplementation() as (channel: string, ...args: unknown[]) => Promise<unknown>
      invoke.mockImplementation(async (channel: string, ...args: unknown[]) => channel === 'db:blueprint-upsert'
        ? { success: false, error: '磁盘已满' } : base(channel, ...args))
      await act(async () => page.getByRole('button', { name: '保存此章' }).click())
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
      expect(refreshes).toHaveLength(2)
    } finally {
      off()
    }
  })

  it('保存此章与开始生成进行中时按钮带 aria-busy，结束后撤掉', async () => {
    await renderPage()
    const base = invoke.getMockImplementation() as (channel: string, ...args: unknown[]) => Promise<unknown>
    const gates = new Map<string, () => void>()
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'db:blueprint-upsert' || channel === 'config:set') await new Promise<void>(resolve => gates.set(channel, resolve))
      return base(channel, ...args)
    })
    await act(async () => page.getByRole('button', { name: '保存此章' }).click())
    const saving = page.getByRole('button', { name: '保存中…' })
    await expect.element(saving).toHaveAttribute('aria-busy', 'true')
    await act(async () => gates.get('db:blueprint-upsert')!())
    await expect.element(page.getByRole('button', { name: '保存此章' })).not.toHaveAttribute('aria-busy')

    await act(async () => page.getByRole('button', { name: 'AI 生成蓝图' }).click())
    const dialog = page.getByRole('dialog', { name: 'AI 生成蓝图' })
    await act(async () => dialog.getByLabelText('蓝图起始章').fill('5'))
    await act(async () => dialog.getByLabelText('蓝图结束章').fill('7'))
    await act(async () => dialog.getByRole('button', { name: '开始生成' }).click())
    await vi.waitFor(() => expect(gates.has('config:set')).toBe(true))
    await expect.element(dialog.getByRole('button', { name: '启动中…' })).toHaveAttribute('aria-busy', 'true')
    await act(async () => gates.get('config:set')!())
    await expect.element(dialog.getByRole('button', { name: '开始生成' })).not.toHaveAttribute('aria-busy')
  })

  it('英文界面里作品只有一章时生成范围写 All 1 chapter', async () => {
    useProjectStore.setState({ currentProject: { ...project(), novelConfig: { ...project().novelConfig, totalChapters: 1 } } })
    stored = [blueprint(1, '旧港')]
    await renderPage()
    await act(async () => useLocaleStore.setState({ locale: 'en-US' }))
    await act(async () => page.getByRole('button', { name: 'Generate blueprints' }).click())
    const full = await vi.waitFor(() => [...document.querySelectorAll('[role="dialog"] .stage-bp-option')].find(option => option.textContent?.startsWith('All'))!)
    expect(full.textContent).toBe('All 1 chapter')
  })

  it('出场人物可以逐个添加与移除', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: '移除 守塔人' }).click())
    await act(async () => page.getByLabelText('出场人物').fill('沈砺'))
    await act(async () => page.getByLabelText('出场人物').element().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    const save = editorSaveHandler({ id: 'chapter-card-editor', type: 'chapter-card', projectKey: PROJECT_PATH })
    await act(async () => { await save!() })
    const [[, saved]] = calls('db:blueprint-upsert-many')
    expect((saved as ChapterBlueprint[])[0].characters).toEqual(['林岚', '沈砺'])
  })

  it('出场人物重名：一次输入两遍只加一个；已有重名时移除一个只少一个', async () => {
    stored = [{ ...blueprint(1, '旧港'), characters: ['林岚', '守塔人', '守塔人'] }, blueprint(2, '北堤')]
    await renderPage()
    await act(async () => page.getByRole('button', { name: '移除 守塔人' }).first().click())
    await act(async () => page.getByLabelText('出场人物').fill('沈砺、沈砺'))
    await act(async () => page.getByLabelText('出场人物').element().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    const save = editorSaveHandler({ id: 'chapter-card-editor', type: 'chapter-card', projectKey: PROJECT_PATH })
    await act(async () => { await save!() })
    const [[, saved]] = calls('db:blueprint-upsert-many')
    expect((saved as ChapterBlueprint[])[0].characters).toEqual(['林岚', '守塔人', '沈砺'])
  })

  it('输入法组字时按回车是选词，不把拼音当人物加进来', async () => {
    await renderPage()
    const input = page.getByLabelText('出场人物')
    await act(async () => input.fill('shen'))
    await act(async () => input.element().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })))
    expect((input.element() as HTMLInputElement).value).toBe('shen')
    expect([...container!.querySelectorAll('button[aria-label^="移除 "]')].map(button => button.getAttribute('aria-label'))).toEqual(['移除 林岚', '移除 守塔人'])
  })

  it('生成蓝图选覆盖时先危险确认，取消后不启动，生成对话框回来且不当作错误', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: 'AI 生成蓝图' }).click())
    const dialog = page.getByRole('dialog', { name: 'AI 生成蓝图' })
    await expect.element(dialog).toBeVisible()
    await act(async () => dialog.getByRole('button', { name: '覆盖' }).click())
    await expect.element(dialog.getByText('已有蓝图会被覆盖，开始前再确认一次')).toBeVisible()
    await act(async () => dialog.getByRole('button', { name: '开始生成' }).click())
    const confirm = page.getByRole('dialog', { name: '覆盖已有蓝图？' })
    await expect.element(confirm).toHaveTextContent('已有的 3 章蓝图会被新蓝图替换')
    expect(calls('db:project-core-get')).toHaveLength(0)
    await act(async () => confirm.getByRole('button', { name: '取消' }).click())
    await expect.element(dialog.getByRole('button', { name: '开始生成' })).toBeVisible()
    expect(dialog.getByRole('alert').query()).toBeNull()
    expect(calls('db:project-core-get')).toHaveLength(0)
  })

  it('指定范围只补没有蓝图的章，不出现覆盖选项与覆盖提示', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: 'AI 生成蓝图' }).click())
    const dialog = page.getByRole('dialog', { name: 'AI 生成蓝图' })
    await act(async () => dialog.getByRole('button', { name: '覆盖' }).click())
    await expect.element(dialog.getByText('已有蓝图会被覆盖，开始前再确认一次')).toBeVisible()
    await act(async () => dialog.getByLabelText('蓝图起始章').fill('5'))
    await expect.element(dialog.getByText('已有蓝图会被覆盖，开始前再确认一次')).not.toBeInTheDocument()
    expect(dialog.getByRole('button', { name: '覆盖' }).query()).toBeNull()
  })

  it('指定范围后取消架构警告：对话框回来，作者填的起止章还在，不当作错误', async () => {
    projectCore = { premise: '灯塔'.repeat(40) }
    await renderPage()
    await act(async () => page.getByRole('button', { name: 'AI 生成蓝图' }).click())
    const dialog = page.getByRole('dialog', { name: 'AI 生成蓝图' })
    await act(async () => dialog.getByLabelText('蓝图起始章').fill('5'))
    await act(async () => dialog.getByLabelText('蓝图结束章').fill('7'))
    await act(async () => dialog.getByRole('button', { name: '开始生成' }).click())
    const warning = page.getByRole('dialog', { name: '架构还不完整' })
    await expect.element(warning).toBeVisible()
    await act(async () => warning.getByRole('button', { name: '取消' }).click())
    await expect.element(dialog.getByLabelText('蓝图起始章')).toHaveValue(5)
    await expect.element(dialog.getByLabelText('蓝图结束章')).toHaveValue(7)
    expect(dialog.getByRole('alert').query()).toBeNull()
  })

  it('指定范围后启动失败：对话框回来写明原因，作者填的起止章还在', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: 'AI 生成蓝图' }).click())
    const dialog = page.getByRole('dialog', { name: 'AI 生成蓝图' })
    await act(async () => dialog.getByLabelText('蓝图起始章').fill('5'))
    await act(async () => dialog.getByLabelText('蓝图结束章').fill('7'))
    await act(async () => dialog.getByRole('button', { name: '开始生成' }).click())
    await expect.element(dialog.getByRole('alert')).toHaveTextContent('「故事前提」尚未生成')
    await expect.element(dialog.getByLabelText('蓝图起始章')).toHaveValue(5)
    await expect.element(dialog.getByLabelText('蓝图结束章')).toHaveValue(7)
  })

  it('批量创作对话框从权威下一章开始，按章数显示主按钮', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: '批量创作' }).click())
    const dialog = page.getByRole('dialog', { name: '批量创作' })
    await expect.element(dialog.getByText('第 2 章', { exact: true })).toBeVisible()
    await act(async () => dialog.getByLabelText(/写几章/).fill('4'))
    await expect.element(dialog.getByRole('button', { name: '开始写 4 章' })).toBeVisible()
    await act(async () => dialog.getByRole('radio', { name: /自动定稿/ }).click())
    await expect.element(dialog.getByRole('button', { name: '继续确认自动定稿' })).toBeVisible()
  })

  it('「写几章」清空后重新输入：删掉 1 再输 3 得 3，不是 13；空着离开回到 1', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: '批量创作' }).click())
    const count = page.getByRole('dialog', { name: '批量创作' }).getByLabelText(/写几章/)
    const input = count.element() as HTMLInputElement
    await act(async () => input.focus())
    await userEvent.keyboard('{End}{Backspace}')
    await userEvent.keyboard('3')
    expect(input.value).toBe('3')
    await userEvent.keyboard('{Backspace}')
    await act(async () => input.blur())
    expect(input.value).toBe('1')
  })

  it('更多蓝图操作里新建章节：新章接在权威下一章已有蓝图之后并被选中', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: '更多蓝图操作' }).click())
    await act(async () => page.getByRole('menuitem', { name: '新建章节' }).click())
    await expect.element(page.getByRole('button', { name: /^4\D/ })).toHaveAttribute('aria-current', 'true')
    await expect.element(page.getByRole('region', { name: '第 4 章蓝图' })).toBeVisible()
  })

  it('写作请求落到这一页：可写的那一章自动弹出写作弹层，写不了的章丢掉请求', async () => {
    useStageStore.setState({ writeRequest: { session: SESSION, chapterNumber: 2 } })
    await renderPage()
    await expect.element(page.getByRole('dialog', { name: '本次写作选项' })).toBeVisible()
    expect(useStageStore.getState().writeRequest).toBeNull()

    await act(async () => root?.render(null))
    useStageStore.setState({ writeRequest: { session: SESSION, chapterNumber: 3 } })
    await renderPage()
    await vi.waitFor(() => expect(useStageStore.getState().writeRequest).toBeNull())
    expect(page.getByRole('dialog', { name: '本次写作选项' }).query()).toBeNull()
  })

  it('蓝图重新加载时页面与打开的弹层都留着，作者刚写的指导不丢', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: '本次写作选项' }).click())
    const popover = page.getByRole('dialog', { name: '本次写作选项' })
    await act(async () => popover.getByLabelText(/作者微操指导/).fill('作者刚写的指导'))
    await refreshBlueprints()
    await expect.element(popover.getByLabelText(/作者微操指导/)).toHaveValue('作者刚写的指导')
  })

  it('删除确认期间蓝图重新加载：确认框仍是作者选的那一章，删的也是它，选中不跳回', async () => {
    await renderPage(2)
    await act(async () => page.getByRole('button', { name: /^3\D/ }).click())
    await act(async () => page.getByRole('button', { name: '第 3 章更多操作' }).click())
    await act(async () => page.getByRole('group', { name: '危险' }).getByRole('menuitem', { name: '删除此章…' }).click())
    await expect.element(page.getByRole('dialog', { name: '删除第 3 章蓝图？' })).toBeVisible()
    await refreshBlueprints()
    // 确认框是模态的，页面其余部分对辅助技术隐藏，直接读选中的那一行。
    expect(container?.querySelector('.stage-bp-plan-item[aria-current] .stage-bp-plan-no')?.textContent).toBe('3')
    const confirm = page.getByRole('dialog', { name: /^删除第 \d+ 章蓝图？$/ })
    await expect.element(confirm).toHaveAccessibleName('删除第 3 章蓝图？')
    await act(async () => confirm.getByRole('button', { name: '删除此章' }).click())
    await vi.waitFor(() => expect(calls('db:blueprint-delete').map(call => call[1])).toEqual([3]))
  })

  it('删除确认期间这一章已被别处删掉：确认后不会改删别的章', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: /^3\D/ }).click())
    await act(async () => page.getByRole('button', { name: '第 3 章更多操作' }).click())
    await act(async () => page.getByRole('group', { name: '危险' }).getByRole('menuitem', { name: '删除此章…' }).click())
    stored = stored.filter(item => item.chapterNumber !== 3)
    await refreshBlueprints()
    const confirm = page.getByRole('dialog', { name: '删除第 3 章蓝图？' })
    await act(async () => confirm.getByRole('button', { name: '删除此章' }).click())
    await expect.element(confirm).not.toBeInTheDocument()
    expect(calls('db:blueprint-delete')).toEqual([])
  })

  it('下一章变了，写作弹层按新的一章重建，上一章没用掉的指导不带过去', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: '本次写作选项' }).click())
    await act(async () => page.getByRole('dialog', { name: '本次写作选项' }).getByLabelText(/作者微操指导/).fill('只给第 2 章的指导'))
    nextChapter = 3
    await refreshBlueprints()
    await expect.element(page.getByRole('button', { name: '写第 3 章' })).toBeVisible()
    await act(async () => page.getByRole('button', { name: '本次写作选项' }).click())
    await expect.element(page.getByRole('dialog', { name: '本次写作选项' }).getByLabelText(/作者微操指导/)).toHaveValue('')
  })
})
