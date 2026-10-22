import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { blueprintWritePrefill } from '../../../../services/workflows/chapter-write-launch'
import { countDraftUnits } from '../../../../shared/draft-units'
import { formatResourceUri } from '../../../../shared/project-paths'
import { toast } from '../../../ui/Toast'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useDraftStore } from '../../../../stores/draft-store'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useStageStore } from '../../../../stores/navigation/stage-store'
import { openChapterPlan, stageNavigate } from '../../../../stores/navigation/stage-navigation'
import { openDraftTab } from '../../../../stores/open-draft-tab'
import { useProjectStore } from '../../../../stores/project-store'
import { useWorkflowStore } from '../../../../stores/workflow-store'
import StageWorkspace from '../../StageWorkspace'
import { swapChapterTab } from '../chapter-tab-routing'
import { AI_REVIEW, BLUEPRINT, ORIGINAL, REVISED, SESSION, chapterProject, createChapterBackend, generationModel } from './chapter-fixture'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const original = {
  editor: useEditorStore.getState(), project: useProjectStore.getState(), drafts: useDraftStore.getState(),
  stage: useStageStore.getState(), llm: useLLMStore.getState(), workflow: useWorkflowStore.getState(),
}

let root: Root | undefined
let host: HTMLDivElement | undefined
let backend: ReturnType<typeof createChapterBackend>

async function mount() {
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = 'display:flex;flex-direction:column;height:900px;width:1028px'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<StageWorkspace library={false} focus={false} />))
}

async function loadDrafts() {
  await act(async () => { await useDraftStore.getState().loadAllDrafts(SESSION.projectPath, SESSION) })
}

async function openDraft(draftId: number) {
  await loadDrafts()
  const draft = Object.values(useDraftStore.getState().draftsByChapter).flat().find(candidate => candidate.id === draftId)!
  await act(async () => { await openDraftTab(draft, '第 3 章 · 雨夜车站', SESSION) })
}

const tabs = () => useEditorStore.getState().tabs
const activeTab = () => tabs().find(tab => tab.id === useEditorStore.getState().activeTabId)
const click = (name: string | RegExp) => act(async () => page.getByRole('button', { name, exact: typeof name === 'string' }).click())
const type = (text: string) => act(async () => useEditorStore.getState().updateTabContent(activeTab()!.id, text))
const versions = async () => {
  await act(async () => page.getByRole('button', { name: /本章版本/ }).click())
  return [...document.querySelectorAll('[role="menuitemradio"]')].map(item => item.firstElementChild?.textContent)
}

beforeEach(async () => {
  await page.viewport(1280, 900)
  backend = createChapterBackend()
  backend.install()
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ currentProject: chapterProject() })
  setActiveProjectSessionContext(SESSION)
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useStageStore.setState({ work: { session: SESSION, architecture: {}, blueprints: [{ chapterNumber: 3, title: BLUEPRINT.title }] }, chapterRequest: null, writeRequest: null, sheet: null })
  useLLMStore.setState({ models: [generationModel('grok')], defaultModelId: 'grok', loaded: true })
  useWorkflowStore.setState({ activeRuns: [], history: [], startWorkflow: vi.fn(async () => 'run') as never, addLog: vi.fn() as never })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  Reflect.deleteProperty(window, 'aiNovelAPI')
  setActiveProjectSessionContext(null)
  useEditorStore.setState(original.editor, true)
  useProjectStore.setState(original.project, true)
  useDraftStore.setState(original.drafts, true)
  useStageStore.setState(original.stage, true)
  useLLMStore.setState(original.llm, true)
  useWorkflowStore.setState(original.workflow, true)
})

describe('版本切换器', () => {
  it('切到另一稿时有未保存修改：先问；继续编辑什么都不动，保存并切换先写入再在原位置换上那一稿', async () => {
    const v1 = backend.addDraft({ status: 'archived', version: 1 })
    const v2 = backend.addDraft({ status: 'draft', version: 2, content: REVISED })
    await mount()
    await act(async () => openChapterPlan(5, '第五章', SESSION))
    await openDraft(v2.id)
    await type(`${REVISED}\n\n新加的一段。`)
    expect(await versions()).toEqual(['草稿 v2 · 当前'])
    await act(async () => page.getByRole('menuitemcheckbox', { name: /显示已归档/ }).click())
    await act(async () => page.getByRole('menuitemradio', { name: /已归档 v1/ }).click())
    await expect.element(page.getByRole('dialog', { name: '切换前保存修改？' })).toBeVisible()
    await click('继续编辑')
    expect([activeTab()?.filePath, activeTab()?.dirty, backend.writes('db:draft-update-content')]).toEqual([formatResourceUri({ kind: 'draft', id: v2.id }), true, []])

    expect(await versions()).toEqual(['草稿 v2 · 当前', '已归档 v1'])
    await act(async () => page.getByRole('menuitemradio', { name: /已归档 v1/ }).click())
    await click('保存并切换')
    await vi.waitFor(() => expect(activeTab()?.filePath).toBe(formatResourceUri({ kind: 'draft', id: v1.id })))
    expect(backend.writes('db:draft-update-content').map(args => args.slice(0, 2))).toEqual([[v2.id, `${REVISED}\n\n新加的一段。`]])
    expect(tabs().map(tab => tab.filePath ?? tab.chapterNumber)).toEqual([5, formatResourceUri({ kind: 'draft', id: v1.id })])
    await expect.element(page.getByText('已归档，只读')).toBeVisible()
  })

  it('保存时主进程按码拒绝（这一稿已在别处定稿）：提示写明原因，不显示错误码', async () => {
    backend.addDraft({ status: 'archived', version: 1 })
    const v2 = backend.addDraft({ status: 'draft', version: 2 })
    const error = vi.spyOn(toast, 'error').mockImplementation(() => undefined)
    const answer = backend.invoke.getMockImplementation()!
    backend.invoke.mockImplementation(async (channel, ...args) => channel === 'db:draft-update-content'
      ? { success: false, error: 'Error: DRAFT_FINALIZED_READ_ONLY' }
      : answer(channel, ...args))
    await mount()
    await openDraft(v2.id)
    await type('作者打的字')
    await versions()
    await act(async () => page.getByRole('menuitemcheckbox', { name: /显示已归档/ }).click())
    await act(async () => page.getByRole('menuitemradio', { name: /已归档 v1/ }).click())
    await click('保存并切换')
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('这一章已经定稿，定稿正文是只读的，本次修改没有保存。'))
    expect(error.mock.calls.flat().join('')).not.toContain('DRAFT_')
  })

  it('放弃修改并切换：不写入，换上那一稿', async () => {
    backend.addDraft({ status: 'archived', version: 1 })
    const v2 = backend.addDraft({ status: 'draft', version: 2 })
    await mount()
    await openDraft(v2.id)
    await type('作者打的字')
    await versions()
    await act(async () => page.getByRole('menuitemcheckbox', { name: /显示已归档/ }).click())
    await act(async () => page.getByRole('menuitemradio', { name: /已归档 v1/ }).click())
    await click('放弃修改并切换')
    await vi.waitFor(() => expect(activeTab()?.draftStatus).toBe('archived'))
    expect([tabs().length, backend.writes('db:draft-update-content')]).toEqual([1, []])
  })

  it('删除这一稿：危险确认后删除，标签留在原位换成这一章剩下的那一稿，版本切换器不再列出它', async () => {
    const v1 = backend.addDraft({ status: 'draft', version: 1 })
    const v2 = backend.addDraft({ status: 'draft', version: 2, content: REVISED })
    await mount()
    await openDraft(v2.id)
    expect(await versions()).toEqual(['草稿 v2 · 当前', '草稿 v1'])
    await act(async () => page.getByRole('menuitemradio', { name: /草稿 v2/ }).click())
    await click('更多操作')
    await act(async () => page.getByRole('menuitem', { name: '删除这一稿…' }).click())
    await expect.element(page.getByRole('dialog', { name: '删除第 3 章 v2？' })).toBeVisible()
    await click('删除这一稿')
    await vi.waitFor(() => expect(activeTab()?.filePath).toBe(formatResourceUri({ kind: 'draft', id: v1.id })))
    expect(backend.writes('db:draft-delete').map(args => args[0])).toEqual([v2.id])
    expect([tabs().length, await versions()]).toEqual([1, ['草稿 v1 · 当前']])
  })
})

describe('标签与外壳', () => {
  it('切到别的标签再回来，未保存的正文还在', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    await mount()
    await openDraft(draft.id)
    const chapterTab = activeTab()!.id
    await type('还没保存的一句')
    await act(async () => openChapterPlan(5, '第五章', SESSION))
    await act(async () => useEditorStore.getState().setActiveTab(chapterTab))
    await expect.element(page.getByText('还没保存的一句')).toBeVisible()
    expect(activeTab()?.dirty).toBe(true)
  })

  it('审稿完成时命令打开的审稿报告标签改道到单章视图：不留独立标签，审稿侧页展开', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    await mount()
    await openDraft(draft.id)
    const review = backend.addReview(draft)
    const sourcePath = formatResourceUri({ kind: 'draft', id: draft.id })
    await act(async () => useEditorStore.getState().openFile({
      id: `review-${sourcePath}-1`, name: '审稿报告：第3章', type: 'review-report', content: AI_REVIEW, filePath: sourcePath,
      reviewReport: AI_REVIEW, chapterNumber: 3, chapterDir: 'ai-novel://draft/ch3', reviewId: review.id, projectKey: SESSION.projectPath,
    }))
    await expect.element(page.getByRole('heading', { name: '审稿报告' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: '按 2 项意见修稿' })).toBeVisible()
    expect(tabs().map(tab => [tab.type, tab.filePath])).toEqual([['chapter', sourcePath]])
  })

  it('审稿报告标签改道时读这一章的稿失败：提示作者，而不是标签关了什么也没有', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    const review = backend.addReview(draft)
    const error = vi.spyOn(toast, 'error').mockImplementation(() => undefined)
    const base = backend.invoke.getMockImplementation()!
    backend.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => channel === 'db:draft-list'
      ? Promise.reject(new Error('数据库忙')) : base(channel, ...args))
    await mount()
    const sourcePath = formatResourceUri({ kind: 'draft', id: draft.id })
    await act(async () => useEditorStore.getState().openFile({
      id: `review-${sourcePath}-1`, name: '审稿报告：第3章', type: 'review-report', content: AI_REVIEW, filePath: sourcePath,
      reviewReport: AI_REVIEW, chapterNumber: 3, chapterDir: 'ai-novel://draft/ch3', reviewId: review.id, projectKey: SESSION.projectPath,
    }))
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('打开第 3 章失败：数据库忙'))
  })

  it.each([
    { case: '这一章还有别的稿', hasDraft: true },
    { case: '这一章已经没有稿', hasDraft: false },
  ])('审稿报告标签指向的稿已被删除（$case）：提示作者，并打开这一章当前的单章视图', async ({ hasDraft }) => {
    const current = hasDraft ? backend.addDraft({ status: 'draft' }) : undefined
    const warning = vi.spyOn(toast, 'warning').mockImplementation(() => undefined)
    await mount()
    const deletedPath = formatResourceUri({ kind: 'draft', id: 999 })
    await act(async () => useEditorStore.getState().openFile({
      id: `review-${deletedPath}-1`, name: '审稿报告：第3章', type: 'review-report', content: AI_REVIEW, filePath: deletedPath,
      reviewReport: AI_REVIEW, chapterNumber: 3, chapterDir: 'ai-novel://draft/ch3', reviewId: 1, projectKey: SESSION.projectPath,
    }))
    await vi.waitFor(() => expect(warning).toHaveBeenCalledWith('第 3 章这一稿已被删除，已打开这一章现在的内容。'))
    await vi.waitFor(() => expect(activeTab()).toMatchObject({ type: 'chapter', chapterNumber: 3 }))
    expect(activeTab()!.filePath).toBe(current ? formatResourceUri({ kind: 'draft', id: current.id }) : undefined)
    expect(tabs().some(tab => tab.filePath === deletedPath)).toBe(false)
    expect(useStageStore.getState().chapterRequest).toBeNull()
  })

  it.each([
    { case: '作者已点去别的标签', switchProject: false },
    { case: '作品已经换掉', switchProject: true },
  ])('读稿期间$case：已删除的稿不把作者拉回第 3 章', async ({ switchProject }) => {
    const warning = vi.spyOn(toast, 'warning').mockImplementation(() => undefined)
    warning.mockClear()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const base = backend.invoke.getMockImplementation()!
    await mount()
    backend.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'db:draft-list') await gate
      return base(channel, ...args)
    })
    const deletedPath = formatResourceUri({ kind: 'draft', id: 999 })
    await act(async () => useEditorStore.getState().openFile({
      id: `review-${deletedPath}-1`, name: '审稿报告：第3章', type: 'review-report', content: AI_REVIEW, filePath: deletedPath,
      reviewReport: AI_REVIEW, chapterNumber: 3, chapterDir: 'ai-novel://draft/ch3', reviewId: 1, projectKey: SESSION.projectPath,
    }))
    await act(async () => {
      if (switchProject) setActiveProjectSessionContext({ projectId: 'other-book', leaseId: 'other-lease', projectPath: `${SESSION.projectPath}-other` })
      else useEditorStore.getState().openFile({ id: 'elsewhere', name: '设定', type: 'config', projectKey: SESSION.projectPath })
    })
    const before = useEditorStore.getState().activeTabId
    await act(async () => { release(); await gate })

    if (switchProject) {
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(warning).not.toHaveBeenCalled()
    } else {
      await vi.waitFor(() => expect(warning).toHaveBeenCalledWith('第 3 章这一稿已被删除。'))
    }
    expect(useEditorStore.getState().activeTabId).toBe(before)
  })

  it('改道到这一章现在的稿、正在读正文时作者点去别的标签：读完不把作者拉回第 3 章', async () => {
    const current = backend.addDraft({ status: 'draft' })
    const warning = vi.spyOn(toast, 'warning').mockImplementation(() => undefined)
    warning.mockClear()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const base = backend.invoke.getMockImplementation()!
    await mount()
    backend.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'db:draft-get-full' && Number(args[0]) === current.id) await gate
      return base(channel, ...args)
    })
    const deletedPath = formatResourceUri({ kind: 'draft', id: 999 })
    await act(async () => useEditorStore.getState().openFile({
      id: `review-${deletedPath}-1`, name: '审稿报告：第3章', type: 'review-report', content: AI_REVIEW, filePath: deletedPath,
      reviewReport: AI_REVIEW, chapterNumber: 3, chapterDir: 'ai-novel://draft/ch3', reviewId: 1, projectKey: SESSION.projectPath,
    }))
    await vi.waitFor(() => expect(backend.invoke.mock.calls.some(([channel, ...args]) => channel === 'db:draft-get-full' && Number(args[0]) === current.id)).toBe(true))
    await act(async () => useEditorStore.getState().openFile({ id: 'elsewhere', name: '设定', type: 'config', projectKey: SESSION.projectPath }))
    const before = useEditorStore.getState().activeTabId
    await act(async () => { release(); await gate })

    await vi.waitFor(() => expect(warning).toHaveBeenCalled())
    expect(useEditorStore.getState().activeTabId).toBe(before)
    expect(warning.mock.calls).toEqual([['第 3 章这一稿已被删除。']])
  })

  it('读已删除的稿期间作者点开了另一章、那一章还在读：改道不顶掉作者的这次打开', async () => {
    const other = backend.addDraft({ status: 'draft', chapterNumber: 5 })
    const warning = vi.spyOn(toast, 'warning').mockImplementation(() => undefined)
    warning.mockClear()
    let releaseList!: () => void
    const listGate = new Promise<void>(resolve => { releaseList = resolve })
    let releaseBody!: () => void
    const bodyGate = new Promise<void>(resolve => { releaseBody = resolve })
    const base = backend.invoke.getMockImplementation()!
    await mount()
    backend.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'db:draft-list' && Number(args[0]) === 3) await listGate
      if (channel === 'db:draft-get-full' && Number(args[0]) === other.id) await bodyGate
      return base(channel, ...args)
    })
    const deletedPath = formatResourceUri({ kind: 'draft', id: 999 })
    await act(async () => useEditorStore.getState().openFile({
      id: `review-${deletedPath}-1`, name: '审稿报告：第3章', type: 'review-report', content: AI_REVIEW, filePath: deletedPath,
      reviewReport: AI_REVIEW, chapterNumber: 3, chapterDir: 'ai-novel://draft/ch3', reviewId: 1, projectKey: SESSION.projectPath,
    }))
    await act(async () => stageNavigate({ kind: 'chapter', chapterNumber: 5 }))
    await vi.waitFor(() => expect(backend.invoke.mock.calls.some(([channel, ...args]) => channel === 'db:draft-get-full' && Number(args[0]) === other.id)).toBe(true))
    await act(async () => { releaseList(); await listGate })
    await vi.waitFor(() => expect(warning).toHaveBeenCalled())
    await act(async () => { releaseBody(); await bodyGate })

    await vi.waitFor(() => expect(activeTab()?.chapterNumber).toBeDefined())
    expect(activeTab()?.filePath).toBe(formatResourceUri({ kind: 'draft', id: other.id }))
    expect(tabs().some(tab => tab.chapterNumber === 3)).toBe(false)
    expect(warning.mock.calls).toEqual([['第 3 章这一稿已被删除。']])
  })

  it.each([
    { case: '读稿列表', waitsOn: 'db:draft-list' },
    { case: '读替代稿正文', waitsOn: 'db:draft-get-full' },
  ])('$case期间作者切到另一个标签又切回来：回退不抢走作者选回的标签', async ({ waitsOn }) => {
    const current = backend.addDraft({ status: 'draft' })
    const warning = vi.spyOn(toast, 'warning').mockImplementation(() => undefined)
    warning.mockClear()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const gated = (channel: string, args: unknown[]) => channel === waitsOn && Number(args[0]) === (waitsOn === 'db:draft-list' ? 3 : current.id)
    const base = backend.invoke.getMockImplementation()!
    await mount()
    await act(async () => {
      useEditorStore.getState().openFile({ id: 'setting-a', name: '设定甲', type: 'config', projectKey: SESSION.projectPath })
      useEditorStore.getState().openFile({ id: 'setting-b', name: '设定乙', type: 'config', projectKey: SESSION.projectPath })
    })
    backend.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (gated(channel, args)) await gate
      return base(channel, ...args)
    })
    const deletedPath = formatResourceUri({ kind: 'draft', id: 999 })
    await act(async () => useEditorStore.getState().openFile({
      id: `review-${deletedPath}-1`, name: '审稿报告：第3章', type: 'review-report', content: AI_REVIEW, filePath: deletedPath,
      reviewReport: AI_REVIEW, chapterNumber: 3, chapterDir: 'ai-novel://draft/ch3', reviewId: 1, projectKey: SESSION.projectPath,
    }))
    await vi.waitFor(() => expect(backend.invoke.mock.calls.some(([channel, ...args]) => gated(channel, args))).toBe(true))
    const chosen = activeTab()!.id
    const selectTab = (id: string) => act(async () => page.getByRole('tab').nth(tabs().findIndex(tab => tab.id === id)).click())
    await selectTab(tabs().find(tab => tab.id !== chosen)!.id)
    expect(activeTab()?.id).not.toBe(chosen)
    await selectTab(chosen)
    expect(activeTab()?.id).toBe(chosen)
    await act(async () => { release(); await gate })

    await vi.waitFor(() => expect(warning).toHaveBeenCalled())
    expect(activeTab()?.id).toBe(chosen)
    expect(warning.mock.calls).toEqual([['第 3 章这一稿已被删除。']])
  })

  it('修稿完成时命令打开的合并标签改道到单章视图的合并视图', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    await mount()
    await openDraft(draft.id)
    const revision = backend.addRevision(draft, 'refine')
    const sourcePath = formatResourceUri({ kind: 'draft', id: draft.id })
    await act(async () => useEditorStore.getState().openFile({
      id: `diff-${sourcePath}-${revision.id}`, name: '修稿合并：第3章', type: 'diff', filePath: sourcePath, originalContent: ORIGINAL, content: REVISED,
      revisionPath: formatResourceUri({ kind: 'revision', id: revision.id }), chapterNumber: 3, chapterDir: 'ai-novel://draft/ch3', projectKey: SESSION.projectPath,
    }))
    await expect.element(page.getByRole('button', { name: '完成合并' })).toBeVisible()
    expect(tabs().map(tab => tab.type)).toEqual(['chapter'])
  })

  it('写完一章后自动打开的草稿标签顶替这一章的待写标签，留在原位置', async () => {
    await mount()
    await act(async () => openChapterPlan(3, BLUEPRINT.title, SESSION))
    await act(async () => openChapterPlan(5, '第五章', SESSION))
    const draft = backend.addDraft({ status: 'draft' })
    await loadDrafts()
    const path = formatResourceUri({ kind: 'draft', id: draft.id })
    await act(async () => useEditorStore.getState().openFile({ id: path, name: '第3章 雨夜车站 v1', type: 'chapter', filePath: path, content: ORIGINAL, savedContent: ORIGINAL, projectKey: SESSION.projectPath }))
    await vi.waitFor(() => expect(tabs().map(tab => tab.filePath ?? tab.chapterNumber)).toEqual([path, 5]))
    expect(activeTab()?.filePath).toBe(path)
  })

  it('删除正文后清理没做完：这一章的待写视图提示并可以重试清理（F-070）', async () => {
    backend.state.incompleteDeletions = [{ operationId: 'deletion-1', chapterNumber: 3, draftId: 9, chapterTitle: '雨夜车站', status: 'failed',
      manuscriptStatus: 'failed', manuscriptError: '正文文件被占用', knowledgeStatus: 'done', legacyKnowledgeAuthorization: 'not-required' }]
    await mount()
    await act(async () => openChapterPlan(3, BLUEPRINT.title, SESSION))
    await expect.element(page.getByText('删除正文后的清理没有完成')).toBeVisible()
    await expect.element(page.getByText('正文文件被占用')).toBeVisible()
    await click('重试清理')
    await vi.waitFor(() => expect(backend.writes('chapter:retry-deletion').map(args => args[0])).toEqual(['deletion-1']))
    await expect.element(page.getByText('删除正文后的清理没有完成')).not.toBeInTheDocument()
  })

  it.each([
    ['zh-CN', '删除正文后的清理没有完成', '知识库没有确认这一章的资料已删除。请稍后在这一章的页面里重试清理。', '知识库不可用：Windows 原生组件加载失败。'],
    ['en-US', 'Cleanup after deleting the manuscript is unfinished', "The knowledge base did not confirm that this chapter's entry was removed.", 'The knowledge base is unavailable because'],
  ] as const)('删除清理提示把主进程记下的错误码按界面语言说明（%s，#474）', async (locale, title, knowledgeReason, nativeReason) => {
    useLocaleStore.setState({ locale })
    backend.state.incompleteDeletions = [
      { operationId: 'deletion-1', chapterNumber: 3, draftId: 9, chapterTitle: '雨夜车站', status: 'failed',
        manuscriptStatus: 'failed', manuscriptError: 'EBUSY: resource busy or locked', knowledgeStatus: 'failed', knowledgeError: 'CHAPTER_DELETE_KNOWLEDGE_NOT_REMOVED', legacyKnowledgeAuthorization: 'not-required' },
      { operationId: 'deletion-2', chapterNumber: 3, draftId: 8, chapterTitle: '雨夜车站', status: 'failed',
        manuscriptStatus: 'completed', manuscriptError: '', knowledgeStatus: 'failed', knowledgeError: 'KNOWLEDGE_BASE_NATIVE_UNAVAILABLE', legacyKnowledgeAuthorization: 'not-required' },
    ]
    await mount()
    await act(async () => openChapterPlan(3, BLUEPRINT.title, SESSION))
    await expect.element(page.getByText(title).first()).toBeVisible()
    await expect.element(page.getByText(knowledgeReason, { exact: false })).toBeVisible()
    await expect.element(page.getByText('EBUSY: resource busy or locked', { exact: false })).toBeVisible()
    await expect.element(page.getByText(nativeReason, { exact: false })).toBeVisible()
    expect(document.body.textContent).not.toMatch(/CHAPTER_DELETE_|KNOWLEDGE_BASE_NATIVE_UNAVAILABLE/u)
  })

  it('删除正文后清理没做完、这一章另有未定稿的稿：那一稿的单章视图也提示并可以重试清理', async () => {
    backend.state.incompleteDeletions = [{ operationId: 'deletion-1', chapterNumber: 3, draftId: 9, chapterTitle: '雨夜车站', status: 'failed',
      manuscriptStatus: 'failed', manuscriptError: '正文文件被占用', knowledgeStatus: 'done', legacyKnowledgeAuthorization: 'not-required' }]
    const draft = backend.addDraft({ status: 'draft' })
    await mount()
    await openDraft(draft.id)
    await expect.element(page.getByText('删除正文后的清理没有完成')).toBeVisible()
    await click('重试清理')
    await vi.waitFor(() => expect(backend.writes('chapter:retry-deletion').map(args => args[0])).toEqual(['deletion-1']))
    await expect.element(page.getByText('删除正文后的清理没有完成')).not.toBeInTheDocument()
  })
})

describe('定稿冲突与定稿进行中', () => {
  const conflict = { finalizationId: 'final-1', publicationStatus: 'published' as const }
  const markTab = (fields: { finalizationConflict?: typeof conflict; finalizationPublication?: 'pending' }) => act(async () => useEditorStore.setState(state => ({
    tabs: state.tabs.map(tab => tab.id === state.activeTabId ? { ...tab, ...fields } : tab),
  })))
  const finalizeItem = async () => {
    await click('更多操作')
    return page.getByRole('menuitem', { name: '定稿…' })
  }

  it('冲突保留时，「更多」里的定稿不可用', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    await mount()
    await openDraft(draft.id)
    await markTab({ finalizationConflict: conflict })
    await expect.element(page.getByText('已保留后续编辑')).toBeVisible()
    await expect.element(await finalizeItem()).toBeDisabled()
  })

  it('已修稿的稿在定稿进行中：主按钮不可用', async () => {
    const draft = backend.addDraft({ status: 'revised' })
    await mount()
    await openDraft(draft.id)
    await markTab({ finalizationPublication: 'pending' })
    await expect.element(page.getByRole('button', { name: '定稿', exact: true })).toBeDisabled()
  })

  it('英文界面下这一章有运行在跑：正文只读，定稿不可用（按章节资源判断，不按显示标题）', async () => {
    const draft = backend.addDraft({ status: 'revised' })
    useLocaleStore.setState({ locale: 'en-US' })
    await mount()
    await openDraft(draft.id)
    await expect.element(page.getByRole('button', { name: 'Finalize', exact: true })).toBeEnabled()
    await act(async () => useWorkflowStore.setState({ activeRuns: [{ id: 'finalize-run', type: 'chapter_creation', title: 'Finalize chapter 3',
      status: 'running', projectPath: SESSION.projectPath, resourceKeys: ['chapter:3'], steps: [], currentStepIndex: 0, logs: [] } as never] }))
    await expect.element(page.getByRole('button', { name: 'Finalize', exact: true })).toBeDisabled()
    expect(document.querySelector('.stage-ch-prose')?.getAttribute('data-readonly')).toBe('true')
  })

  it('确认框开着时冲突到达：确认定稿不可用，不启动定稿，冲突仍保留', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    await mount()
    await openDraft(draft.id)
    await act(async () => (await finalizeItem()).click())
    await expect.element(page.getByRole('dialog', { name: '定稿第 3 章？' })).toBeVisible()
    await markTab({ finalizationConflict: conflict })
    const confirm = page.getByRole('button', { name: '确认定稿' })
    await expect.element(confirm).toBeDisabled()
    await act(async () => confirm.element().dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(useWorkflowStore.getState().startWorkflow).not.toHaveBeenCalled()
    expect(activeTab()?.finalizationConflict).toEqual(conflict)
  })
})

describe('审稿侧页与运行侧页', () => {
  const reviewHeading = () => page.getByRole('heading', { name: '审稿报告' })
  const runHeading = () => page.getByRole('heading', { name: '运行' })

  it('同一时间只开一个：作者开着运行侧页时不抢；从「更多」打开审稿报告换掉运行侧页，纸面与侧页并排不重叠', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    backend.addReview(draft)
    await mount()
    await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } }))
    await openDraft(draft.id)
    await expect.element(page.getByRole('button', { name: '按 2 项意见修稿' })).toBeVisible()
    await expect.element(runHeading()).toBeVisible()
    await expect.element(reviewHeading()).not.toBeInTheDocument()

    await click('更多操作')
    await act(async () => page.getByRole('menuitem', { name: '审稿报告' }).click())
    await expect.element(reviewHeading()).toBeVisible()
    await expect.element(runHeading()).not.toBeInTheDocument()
    const paper = host!.querySelector('.stage-ch-page')!.getBoundingClientRect()
    const sheet = host!.querySelector('.stage-ch-sheet-slot .pi-sheet')!.getBoundingClientRect()
    expect(paper.right).toBeLessThanOrEqual(sheet.left)

    await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } }))
    await expect.element(runHeading()).toBeVisible()
    await expect.element(reviewHeading()).not.toBeInTheDocument()
  })

  it('审稿完成时收起跟着工作流打开的运行侧页，展开审稿侧页', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    await mount()
    await openDraft(draft.id)
    await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } }))
    await expect.element(runHeading()).toBeVisible()
    const review = backend.addReview(draft)
    const sourcePath = formatResourceUri({ kind: 'draft', id: draft.id })
    await act(async () => useEditorStore.getState().openFile({
      id: `review-${sourcePath}-1`, name: '审稿报告：第3章', type: 'review-report', content: AI_REVIEW, filePath: sourcePath,
      reviewReport: AI_REVIEW, chapterNumber: 3, chapterDir: 'ai-novel://draft/ch3', reviewId: review.id, projectKey: SESSION.projectPath,
    }))
    await expect.element(reviewHeading()).toBeVisible()
    await expect.element(runHeading()).not.toBeInTheDocument()
  })

  it('审稿侧页属于展开它的那一稿：换到有历史审稿的已定稿章不跟过去，那里只能从「更多」打开；回到原来那章仍按已审稿展开', async () => {
    const reviewed = backend.addDraft({ status: 'draft' })
    backend.addReview(reviewed)
    const finalized = backend.addDraft({ status: 'finalized', chapterNumber: 2, content: '第二章定稿的正文。' })
    backend.addReview(finalized)
    await mount()
    await openDraft(reviewed.id)
    await expect.element(reviewHeading()).toBeVisible()
    const reviewedTab = activeTab()!.id

    await openDraft(finalized.id)
    await expect.element(page.getByText('已定稿，只读')).toBeVisible()
    await expect.element(reviewHeading()).not.toBeInTheDocument()
    await click('更多操作')
    await act(async () => page.getByRole('menuitem', { name: '审稿报告' }).click())
    await expect.element(reviewHeading()).toBeVisible()

    await act(async () => useEditorStore.getState().setActiveTab(reviewedTab))
    await expect.element(page.getByRole('button', { name: '按 2 项意见修稿' })).toBeVisible()
    await expect.element(reviewHeading()).toBeVisible()
  })

  it('打开作品落在已审稿的章：审稿侧页默认展开，随后回到作品的导航不再把它收起；运行侧页照旧收起', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    backend.addReview(draft)
    await mount()
    await openDraft(draft.id)
    await expect.element(reviewHeading()).toBeVisible()
    await act(async () => stageNavigate({ kind: 'stage' }))
    await expect.element(reviewHeading()).toBeVisible()

    await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } }))
    await expect.element(runHeading()).toBeVisible()
    await act(async () => stageNavigate({ kind: 'stage' }))
    await expect.element(runHeading()).not.toBeInTheDocument()
  })
})

describe('写作此章、标签顶替与跨作品的请求', () => {
  it('写作此章（定稿后打开下一章、Ctrl K）落到这一章的单章视图并弹出写作弹层，不再落到蓝图', async () => {
    await mount()
    await act(async () => stageNavigate({ kind: 'chapter', chapterNumber: 3, write: blueprintWritePrefill(BLUEPRINT) }))
    await expect.element(page.getByRole('dialog', { name: '本次写作选项' })).toBeVisible()
    expect([activeTab()?.type, activeTab()?.chapterNumber, tabs().some(tab => tab.type === 'chapter-card')]).toEqual(['chapter', 3, false])
    expect(useStageStore.getState().writeRequest).toBeNull()
  })

  it('这一章已经有稿：打开它的单章视图，写作请求落空，不会留到蓝图页再弹出', async () => {
    backend.addDraft({ status: 'draft' })
    await mount()
    await act(async () => stageNavigate({ kind: 'chapter', chapterNumber: 3, write: blueprintWritePrefill(BLUEPRINT) }))
    await expect.element(page.getByRole('button', { name: 'AI 审稿', exact: true })).toBeVisible()
    expect(useStageStore.getState().writeRequest).toBeNull()
  })

  it('这一章还没有蓝图：单章视图提示先去蓝图规划，写作请求落空，不会等蓝图补上后在别处弹出', async () => {
    await mount()
    await act(async () => stageNavigate({ kind: 'chapter', chapterNumber: 5, write: blueprintWritePrefill({ ...BLUEPRINT, chapterNumber: 5 }) }))
    await expect.element(page.getByText('这一章还没有蓝图')).toBeVisible()
    expect([activeTab()?.type, activeTab()?.chapterNumber, useStageStore.getState().writeRequest]).toEqual(['chapter', 5, null])
  })

  it('读本章蓝图失败：写明读取失败并可重试，不当成没有蓝图，写作请求留着；重试读到后弹出写作弹层', async () => {
    const base = backend.invoke.getMockImplementation()!
    let failing = true
    backend.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => channel === 'db:blueprint-get' && failing
      ? Promise.reject(new Error('数据库忙')) : base(channel, ...args))
    await mount()
    await act(async () => stageNavigate({ kind: 'chapter', chapterNumber: 3, write: blueprintWritePrefill(BLUEPRINT) }))
    await expect.element(page.getByText('读取本章蓝图失败')).toBeVisible()
    await expect.element(page.getByText('写作此章按本章蓝图写，读到之后才能开始。')).toBeVisible()
    expect(page.getByText('这一章还没有蓝图').elements()).toHaveLength(0)
    expect(useStageStore.getState().writeRequest?.chapterNumber).toBe(3)
    failing = false
    await act(async () => page.getByRole('button', { name: '重新读取' }).click())
    await expect.element(page.getByRole('dialog', { name: '本次写作选项' })).toBeVisible()
  })

  it('没有蓝图的待写章已经开着，之后再来的写作请求也落空', async () => {
    await mount()
    await act(async () => stageNavigate({ kind: 'chapter', chapterNumber: 5 }))
    await expect.element(page.getByText('这一章还没有蓝图')).toBeVisible()
    await act(async () => stageNavigate({ kind: 'chapter', chapterNumber: 5, write: blueprintWritePrefill({ ...BLUEPRINT, chapterNumber: 5 }) }))
    await vi.waitFor(() => expect(useStageStore.getState().writeRequest).toBeNull())
  })

  it('换上另一稿期间旧标签又有了修改：旧标签留着不关', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    await mount()
    await act(async () => openChapterPlan(5, '第五章', SESSION))
    await openDraft(draft.id)
    const old = activeTab()!.id
    await act(async () => swapChapterTab(old, () => {
      useEditorStore.getState().updateTabContent(old, '切换途中打的字')
      openChapterPlan(5, '第五章', SESSION)
      return true
    }))
    expect(tabs().find(tab => tab.id === old)).toMatchObject({ content: '切换途中打的字', dirty: true })
  })

  it('审稿完成的重读请求属于发出时那次打开：换作品后清掉', async () => {
    await mount()
    await act(async () => useStageStore.setState({ chapterRequest: { session: SESSION, filePath: formatResourceUri({ kind: 'draft', id: 1 }) } }))
    await act(async () => useProjectStore.setState({ currentProject: { ...chapterProject(), sessionLease: 'reopened-lease' } }))
    expect(useStageStore.getState().chapterRequest).toBeNull()
  })

  it('审稿侧页属于打开它的那部作品：换作品或重新打开后收起，同一次打开里作品数据换新对象不收', async () => {
    await mount()
    const sheet = { kind: 'review' as const, filePath: formatResourceUri({ kind: 'draft', id: 1 }) }
    await act(async () => useStageStore.setState({ sheet }))
    await act(async () => useProjectStore.setState({ currentProject: { ...chapterProject(), novelConfig: { ...chapterProject().novelConfig, coreOutline: '后台写回' } } }))
    expect(useStageStore.getState().sheet).toEqual(sheet)
    await act(async () => useProjectStore.setState({ currentProject: { ...chapterProject(), id: 'harbor', path: 'C:\\novels\\harbor', sessionLease: 'harbor-lease' } }))
    expect(useStageStore.getState().sheet).toBeNull()
  })

  it('删除正文的确认写的是新外壳里重试清理的位置', async () => {
    const draft = backend.addDraft({ status: 'finalized' })
    await mount()
    await openDraft(draft.id)
    await click('更多操作')
    await act(async () => page.getByRole('menuitem', { name: '删除正文…' }).click())
    await expect.element(page.getByText(/清理失败时可在这一章的页面里重试/)).toBeVisible()
    await expect.element(page.getByText(/正文章节下/)).not.toBeInTheDocument()
    await click('取消')
  })
})

describe('纸面', () => {
  it('段落首行缩进两字只是显示：正文内容不变，作者自己用 em 空格缩进的段落不再叠加', async () => {
    const indented = ['雨从傍晚开始就没有停过。', '  最后一班列车晚点了十七分钟。'].join('\n\n')
    const draft = backend.addDraft({ status: 'draft', content: indented })
    await mount()
    await openDraft(draft.id)
    await expect.element(page.getByText('雨从傍晚开始就没有停过。')).toBeVisible()
    const lines = [...host!.querySelectorAll<HTMLElement>('.stage-ch-prose .cm-line')]
    expect(lines.map(line => [line.textContent, getComputedStyle(line).textIndent])).toEqual([
      ['雨从傍晚开始就没有停过。', '36px'],
      ['', '0px'],
      ['  最后一班列车晚点了十七分钟。', '0px'],
    ])
    expect(activeTab()?.content).toBe(indented)
  })

  it('分节线与 # 标题行不缩进，只有正文段落缩进两字', async () => {
    const content = ['# 第三章 雾钟', '雨从傍晚开始就没有停过。', '---', '最后一班列车晚点了十七分钟。', '***', '* * *', '## 尾声', '车门在身后合上。'].join('\n\n')
    const draft = backend.addDraft({ status: 'draft', content })
    await mount()
    await openDraft(draft.id)
    await expect.element(page.getByText('雨从傍晚开始就没有停过。')).toBeVisible()
    const lines = [...host!.querySelectorAll<HTMLElement>('.stage-ch-prose .cm-line')].filter(line => line.textContent)
    expect(lines.map(line => getComputedStyle(line).textIndent)).toEqual(['0px', '36px', '0px', '36px', '0px', '0px', '0px', '36px'])
    expect(activeTab()?.content).toBe(content)
  })

  it('正文里 Tab 插入两个 em 空格；先按 Esc 再按 Tab 或 Shift+Tab 移出编辑区，不插空格；Esc 后按了别的键，Tab 又插空格', async () => {
    const draft = backend.addDraft({ status: 'draft', content: '雨从傍晚开始就没有停过。' })
    await mount()
    await openDraft(draft.id)
    await expect.element(page.getByText('雨从傍晚开始就没有停过。')).toBeVisible()
    const prose = host!.querySelector<HTMLElement>('.stage-ch-prose .cm-content')!
    const inEditor = () => prose.contains(document.activeElement)
    await userEvent.click(page.getByText('雨从傍晚开始就没有停过。'))
    await userEvent.keyboard('{End}{Tab}')
    expect(activeTab()?.content).toBe('雨从傍晚开始就没有停过。\u2003\u2003')

    await userEvent.keyboard('{Escape}')
    await new Promise(resolve => setTimeout(resolve, 2500))
    await userEvent.keyboard('{Tab}')
    const outAfterPause = !inEditor()
    await userEvent.click(page.getByText('雨从傍晚开始就没有停过。'))
    await userEvent.keyboard('{End}{Escape}{Shift>}{Tab}{/Shift}')
    const outBackward = !inEditor()
    await userEvent.click(page.getByText('雨从傍晚开始就没有停过。'))
    await userEvent.keyboard('{End}{Escape}{ArrowLeft}{Tab}')
    expect([outAfterPause, outBackward, inEditor()]).toEqual([true, true, true])
    expect(activeTab()?.content).toBe('雨从傍晚开始就没有停过。\u2003\u2003\u2003\u2003')
  })

  it('刚打完字立刻按 Esc 再按 Tab，焦点照样移出编辑区，不插空格', async () => {
    const draft = backend.addDraft({ status: 'draft', content: '雨从傍晚开始就没有停过。' })
    await mount()
    await openDraft(draft.id)
    await expect.element(page.getByText('雨从傍晚开始就没有停过。')).toBeVisible()
    const prose = host!.querySelector<HTMLElement>('.stage-ch-prose .cm-content')!
    await userEvent.click(page.getByText('雨从傍晚开始就没有停过。'))
    await userEvent.keyboard('{End}abc{Escape}{Tab}')
    expect(prose.contains(document.activeElement)).toBe(false)
    expect(activeTab()?.content).toBe('雨从傍晚开始就没有停过。abc')
  })

  it('中文分节符整行不缩进；以破折号开头的对白、以符号开头的正文仍缩进', async () => {
    const breaks = ['＊＊＊', '※※※', '◇ ◇ ◇', '◇◆◇', '○●○', '———', '——————', '·····', '～～～', '~ ~ ~', '＊　＊　＊']
    const prose = ['——他说，钟声提前了。', '※注：钟声提前了一刻。', '○', '——', '◇雾从海面升起。']
    const content = [...breaks, ...prose].join('\n\n')
    const draft = backend.addDraft({ status: 'draft', content })
    await mount()
    await openDraft(draft.id)
    await expect.element(page.getByText('——他说，钟声提前了。')).toBeVisible()
    const lines = [...host!.querySelectorAll<HTMLElement>('.stage-ch-prose .cm-line')].filter(line => line.textContent)
    expect(lines.map(line => [line.textContent, getComputedStyle(line).textIndent])).toEqual([
      ...breaks.map(line => [line, '0px']),
      ...prose.map(line => [line, '36px']),
    ])
    expect(activeTab()?.content).toBe(content)
  })

  it('沉浸写作：纸面全出血，底部写出字数与设定里的每章目标字数及进度', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    host = document.createElement('div')
    host.className = 'paper-ink stage-shell'
    host.dataset.focus = 'true'
    host.style.cssText = 'display:flex;flex-direction:column;height:900px;width:1280px'
    document.body.append(host)
    root = createRoot(host)
    useStageStore.setState({ focus: true })
    await act(async () => root!.render(<StageWorkspace library={false} focus />))
    await openDraft(draft.id)
    await expect.element(page.getByText(`${countDraftUnits(ORIGINAL)} / 3,000 字`)).toBeVisible()
    await expect.element(page.getByRole('progressbar', { name: '本章目标字数进度' })).toHaveAttribute('aria-valuemax', '3000')
    const panel = getComputedStyle(host!.querySelector('.stage-panel')!)
    expect([panel.marginTop, panel.marginLeft, panel.borderTopLeftRadius, panel.boxShadow]).toEqual(['0px', '0px', '0px', 'none'])
  })
})
