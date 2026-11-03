import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ReplacementImpact } from '../../../../shared/chapter-reopen'
import { globalEventBus } from '../../../../shared/event-bus'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useDraftStore } from '../../../../stores/draft-store'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useStageStore } from '../../../../stores/navigation/stage-store'
import { navigate } from '../../../../stores/navigation/navigation-intents'
import { useProjectStore } from '../../../../stores/project-store'
import { useWorkflowStore } from '../../../../stores/workflow-store'
import { openDraftTab } from '../../../../stores/open-draft-tab'
import { toast } from '../../../ui/Toast'
import StageWorkspace from '../../StageWorkspace'
import { BLUEPRINT, ORIGINAL, REVISED, SESSION, chapterProject, createChapterBackend, generationModel, reopenOf } from './chapter-fixture'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const original = {
  editor: useEditorStore.getState(), project: useProjectStore.getState(), drafts: useDraftStore.getState(),
  stage: useStageStore.getState(), llm: useLLMStore.getState(), workflow: useWorkflowStore.getState(),
}
const SEEN_KEY = `pagekin:replacement-impact-seen:${SESSION.projectId}`

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

async function unmount() {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
}

async function openDraft(draftId: number) {
  await act(async () => { await useDraftStore.getState().loadAllDrafts(SESSION.projectPath, SESSION) })
  const draft = Object.values(useDraftStore.getState().draftsByChapter).flat().find(candidate => candidate.id === draftId)!
  await act(async () => { await openDraftTab(draft, `第 ${draft.chapterNumber} 章`, SESSION) })
}

const activeTab = () => useEditorStore.getState().tabs.find(tab => tab.id === useEditorStore.getState().activeTabId)
const click = (name: string | RegExp) => act(async () => page.getByRole('button', { name, exact: typeof name === 'string' }).click())
const menuItems = () => [...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent?.trim())
const refresh = () => act(async () => globalEventBus.emit('REFRESH_RESOURCE', { resources: ['drafts'], projectPath: SESSION.projectPath, projectSession: SESSION }))

/** 第 3 章被替换：第 4、6–8 章写于替换之前，第 9 章只有蓝图，两个角色的状态来自后续章，一条线索确认没能改挂。 */
const impactOnThree = (finalizationId: string): ReplacementImpact => ({
  chapterNumber: 3, finalizationId, laterChapters: [4, 6, 7, 8], blueprintOnlyChapters: [9], characters: ['林舟', '老周'],
  unmovedConfirmations: [{ threadTitle: '匿名信', evidence: '他想起母亲说过，这座车站在三十年前就该拆了。' }],
})

beforeEach(async () => {
  await page.viewport(1280, 900)
  localStorage.removeItem(SEEN_KEY)
  backend = createChapterBackend()
  backend.install()
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ currentProject: chapterProject() })
  setActiveProjectSessionContext(SESSION)
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useStageStore.setState({ work: { session: SESSION, architecture: {}, blueprints: [{ chapterNumber: 3, title: BLUEPRINT.title }] }, spineFacts: SESSION, chapterRequest: null, writeRequest: null, sheet: null })
  useLLMStore.setState({ models: [generationModel('glm')], defaultModelId: 'glm', loaded: true })
  useWorkflowStore.setState({ activeRuns: [], history: [], startWorkflow: vi.fn(async () => 'chapter-run') as never, addLog: vi.fn() as never, getResourceConflict: (() => null) as never })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await unmount()
  localStorage.removeItem(SEEN_KEY)
  Reflect.deleteProperty(window, 'aiNovelAPI')
  setActiveProjectSessionContext(null)
  useEditorStore.setState(original.editor, true)
  useProjectStore.setState(original.project, true)
  useDraftStore.setState(original.drafts, true)
  useStageStore.setState(original.stage, true)
  useLLMStore.setState(original.llm, true)
  useWorkflowStore.setState(original.workflow, true)
})

describe('重新打开已定稿的章', () => {
  it('定稿章有「重新打开修改」：先说明会怎样，确认后复制定稿为重开稿，标签换成它，横幅写明 AI 审稿不查后续章', async () => {
    const final = backend.addDraft({ status: 'finalized' })
    await mount()
    await openDraft(final.id)

    await click('重新打开修改')
    const dialog = page.getByRole('dialog', { name: '重新打开第 3 章？' })
    await expect.element(dialog.getByText('后面的章节不会跟着改。')).toBeVisible()
    await act(async () => dialog.getByRole('button', { name: '重新打开', exact: true }).click())

    await vi.waitFor(() => expect(backend.writes('chapter:reopen')).toEqual([[{ chapterNumber: 3 }, SESSION.projectPath, SESSION]]))
    const reopened = backend.state.drafts.find(draft => draft.id !== final.id)!
    await vi.waitFor(() => expect(activeTab()?.draftId).toBe(reopened.id))
    expect(useEditorStore.getState().tabs.map(tab => tab.draftId)).toEqual([reopened.id])
    expect(activeTab()?.content).toBe(ORIGINAL)
    await expect.element(page.getByText('正在修改已定稿的第 3 章')).toBeVisible()
    await expect.element(page.getByText(/AI 审稿不检查与后续章节的一致性/)).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'AI 审稿', exact: true })).toBeVisible()
  })

  it('取消重新打开不新建任何稿', async () => {
    const final = backend.addDraft({ status: 'finalized' })
    await mount()
    await openDraft(final.id)
    await click('重新打开修改')
    await act(async () => page.getByRole('dialog', { name: '重新打开第 3 章？' }).getByRole('button', { name: '取消' }).click())
    expect(backend.writes('chapter:reopen')).toEqual([])
    expect(activeTab()?.draftId).toBe(final.id)
  })

  it('已有一份重开稿时，定稿页的按钮直接打开那一份，不再问', async () => {
    const final = backend.addDraft({ status: 'finalized' })
    const reopened = backend.addDraft({ status: 'revised', version: 2, content: REVISED, createdAt: '2026-10-13 20:30:00', ...reopenOf(final) })
    await mount()
    await openDraft(final.id)
    await click('打开重开稿')
    await vi.waitFor(() => expect(activeTab()?.draftId).toBe(reopened.id))
    expect(backend.writes('chapter:reopen')).toEqual([])
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('重新打开被拒（本章属于没写完的批量写作）：说明原因，标签留在定稿', async () => {
    const final = backend.addDraft({ status: 'finalized' })
    const plain = backend.invoke.getMockImplementation()!
    backend.invoke.mockImplementation(async (channel, ...args) => channel === 'chapter:reopen'
      ? { success: false, error: 'CHAPTER_REOPEN_BATCH_UNFINISHED' }
      : plain(channel, ...args))
    const shown = vi.spyOn(toast, 'error')
    await mount()
    await openDraft(final.id)
    await click('重新打开修改')
    await act(async () => page.getByRole('dialog', { name: '重新打开第 3 章？' }).getByRole('button', { name: '重新打开', exact: true }).click())
    await vi.waitFor(() => expect(shown).toHaveBeenCalledWith(expect.stringContaining('这一章属于一次还没写完的批量写作')))
    expect(activeTab()?.draftId).toBe(final.id)
  })

  it('重开稿的「更多」里是「放弃修改…」而不是删除这一稿；确认后删掉重开稿，标签回到原定稿', async () => {
    const final = backend.addDraft({ status: 'finalized' })
    const reopened = backend.addDraft({ status: 'draft', version: 2, content: REVISED, createdAt: '2026-10-13 20:30:00', ...reopenOf(final) })
    await mount()
    await openDraft(reopened.id)
    await click('更多操作')
    expect(menuItems()).toContain('放弃修改…')
    expect(menuItems()).not.toContain('删除这一稿…')
    await act(async () => page.getByRole('menuitem', { name: '放弃修改…' }).click())
    const confirm = page.getByRole('dialog', { name: '放弃对第 3 章的修改？' })
    await expect.element(confirm.getByText(/第 3 章回到原定稿/)).toBeVisible()
    await act(async () => confirm.getByRole('button', { name: '放弃修改', exact: true }).click())

    await vi.waitFor(() => expect(backend.writes('db:draft-delete').map(([id]) => id)).toEqual([reopened.id]))
    await vi.waitFor(() => expect(activeTab()?.draftId).toBe(final.id))
    await expect.element(page.getByText('已定稿，只读')).toBeVisible()
  })

  it('定稿之前留下的旧稿不能直接定稿顶替：说明一句，可以用这一稿重新打开本章', async () => {
    const older = backend.addDraft({ status: 'revised', version: 1, content: REVISED })
    backend.addDraft({ status: 'finalized', version: 2, createdAt: '2026-10-13 20:30:00' })
    await mount()
    await openDraft(older.id)

    await expect.element(page.getByText('这一稿不能直接定稿')).toBeVisible()
    expect(page.getByRole('button', { name: '定稿', exact: true }).element()).toHaveProperty('disabled', true)

    await click('以这一稿重新打开')
    await vi.waitFor(() => expect(backend.writes('chapter:reopen').map(([request]) => request)).toEqual([{ chapterNumber: 3, initialDraftId: older.id }]))
    const reopened = backend.state.drafts.at(-1)!
    await vi.waitFor(() => expect(activeTab()?.draftId).toBe(reopened.id))
    expect(activeTab()?.content).toBe(REVISED)
    await expect.element(page.getByText('正在修改已定稿的第 3 章')).toBeVisible()
  })

  it('以这一稿重新打开前先保存还没保存的修改，重开稿带着这些修改', async () => {
    const older = backend.addDraft({ status: 'revised', version: 1, content: REVISED })
    backend.addDraft({ status: 'finalized', version: 2, createdAt: '2026-10-13 20:30:00' })
    await mount()
    await openDraft(older.id)
    const edited = `${REVISED}

新加的一段。`
    await act(async () => useEditorStore.getState().updateTabContent(activeTab()!.id, edited))

    await click('以这一稿重新打开')

    await vi.waitFor(() => expect(backend.writes('chapter:reopen')).toHaveLength(1))
    expect(backend.writes('db:draft-update-content').map(args => args.slice(0, 2))).toEqual([[older.id, edited]])
    const reopened = backend.state.drafts.at(-1)!
    await vi.waitFor(() => expect(activeTab()?.draftId).toBe(reopened.id))
    expect(activeTab()?.content).toBe(edited)
  })

  it('来源已过期的重开稿（重开的定稿已不是当前定稿）是普通草稿：没有重开横幅，照常是删除这一稿，也不能直接定稿', async () => {
    const final = backend.addDraft({ status: 'finalized' })
    const reopened = backend.addDraft({ status: 'draft', version: 2, content: REVISED, createdAt: '2026-10-13 20:30:00', ...reopenOf(final), dependenciesStale: true })
    await mount()
    await openDraft(reopened.id)
    await expect.element(page.getByRole('button', { name: 'AI 审稿', exact: true })).toBeVisible()
    expect(document.body.textContent).not.toContain('正在修改已定稿的第 3 章')
    await click('更多操作')
    expect(menuItems()).toContain('删除这一稿…')
    expect(menuItems()).not.toContain('放弃修改…')
    expect(page.getByRole('menuitem', { name: '定稿…' }).element()).toHaveProperty('disabled', true)
    expect(document.body.textContent).toContain('这一稿不能直接定稿')
  })
})

describe('重开稿定稿', () => {
  it('确认框说明会替换原定稿，并预览后面不会跟着改的章、角色和线索确认', async () => {
    const final = backend.addDraft({ status: 'finalized' })
    const reopened = backend.addDraft({ status: 'revised', version: 2, content: REVISED, createdAt: '2026-10-13 20:30:00', ...reopenOf(final) })
    backend.state.preview = { ...impactOnThree('unused'), finalizationId: null }
    await mount()
    await openDraft(reopened.id)
    const unsaved = `${REVISED}

还没保存的一句。`
    await act(async () => useEditorStore.getState().updateTabContent(activeTab()!.id, unsaved))
    await click('定稿')

    const dialog = page.getByRole('dialog', { name: '定稿第 3 章？' })
    await expect.element(dialog.getByText('替换正文。')).toBeVisible()
    await expect.element(dialog.getByText('后面的内容不会跟着改')).toBeVisible()
    await expect.element(dialog.getByText('第 4、6–8 章写于这次修改之前，第 9 章只有蓝图，可能和新内容不符，不会自动修改。')).toBeVisible()
    await expect.element(dialog.getByText('林舟、老周的当前状态来自后续章节，没有按新内容重算。')).toBeVisible()
    await expect.element(dialog.getByText('「匿名信」：他想起母亲说过，这座车站在三十年前就该拆了。')).toBeVisible()
    await expect.element(dialog.getByText('要再改，在本章点「重新打开修改」。')).toBeVisible()
    expect(backend.writes('chapter:replacement-impact-preview').map(([draftId, content]) => [draftId, content])).toEqual([[reopened.id, unsaved]])
  })

  it('关掉确认框改了正文再定稿：新预览回来之前不显示按旧正文算的影响', async () => {
    const final = backend.addDraft({ status: 'finalized' })
    const reopened = backend.addDraft({ status: 'revised', version: 2, content: REVISED, createdAt: '2026-10-13 20:30:00', ...reopenOf(final) })
    backend.state.preview = { ...impactOnThree('unused'), finalizationId: null }
    await mount()
    await openDraft(reopened.id)
    await click('定稿')
    const dialog = page.getByRole('dialog', { name: '定稿第 3 章？' })
    const oldLine = '第 4、6–8 章写于这次修改之前，第 9 章只有蓝图，可能和新内容不符，不会自动修改。'
    await expect.element(dialog.getByText(oldLine)).toBeVisible()
    await click('再看看')
    await expect.element(dialog).not.toBeInTheDocument()

    const edited = `${REVISED}

又改了一句。`
    await act(async () => useEditorStore.getState().updateTabContent(activeTab()!.id, edited))
    let release!: () => void
    backend.state.previewGate = new Promise(resolve => { release = resolve })
    backend.state.preview = { ...impactOnThree('unused'), finalizationId: null, laterChapters: [], characters: [], unmovedConfirmations: [] }
    await click('定稿')
    await expect.element(dialog.getByText('替换正文。')).toBeVisible()
    await vi.waitFor(() => expect(backend.writes('chapter:replacement-impact-preview').map(([, content]) => content)).toEqual([REVISED, edited]))
    expect(dialog.element().textContent).not.toContain(oldLine)

    await act(async () => release())
    await expect.element(dialog.getByText('第 9 章只有蓝图，可能和新内容不符，不会自动修改。')).toBeVisible()
    expect(dialog.element().textContent).not.toContain(oldLine)
  })

  it('影响预览回来之前不能确认定稿；预览读不出来时照常可以定稿', async () => {
    const final = backend.addDraft({ status: 'finalized' })
    const reopened = backend.addDraft({ status: 'revised', version: 2, content: REVISED, createdAt: '2026-10-13 20:30:00', ...reopenOf(final) })
    backend.state.preview = { ...impactOnThree('unused'), finalizationId: null }
    let release!: () => void
    backend.state.previewGate = new Promise(resolve => { release = resolve })
    await mount()
    await openDraft(reopened.id)
    await click('定稿')
    const dialog = page.getByRole('dialog', { name: '定稿第 3 章？' })
    const confirm = dialog.getByRole('button', { name: '确认定稿', exact: true })
    await expect.element(dialog.getByText('替换正文。')).toBeVisible()
    await vi.waitFor(() => expect(backend.writes('chapter:replacement-impact-preview')).toHaveLength(1))
    await expect.element(confirm).toBeDisabled()

    await act(async () => release())
    await expect.element(dialog.getByText('后面的内容不会跟着改')).toBeVisible()
    await expect.element(confirm).toBeEnabled()
    await click('再看看')

    let fail!: (error: Error) => void
    backend.state.previewGate = new Promise((_resolve, reject) => { fail = reject })
    await act(async () => useEditorStore.getState().updateTabContent(activeTab()!.id, `${REVISED}\n\n又改了一句。`))
    await click('定稿')
    await vi.waitFor(() => expect(backend.writes('chapter:replacement-impact-preview')).toHaveLength(2))
    await expect.element(confirm).toBeDisabled()
    await act(async () => fail(new Error('IPC_UNAVAILABLE')))
    await expect.element(confirm).toBeEnabled()
    expect(dialog.element().textContent).not.toContain('后面的内容不会跟着改')
  })

  it('普通草稿定稿：不预览替换影响，说明要再改就重新打开修改', async () => {
    const draft = backend.addDraft({ status: 'revised' })
    await mount()
    await openDraft(draft.id)
    await click('定稿')
    const dialog = page.getByRole('dialog', { name: '定稿第 3 章？' })
    await expect.element(dialog.getByText('写入正文。')).toBeVisible()
    await expect.element(dialog.getByText('要再改，在本章点「重新打开修改」。')).toBeVisible()
    expect(dialog.element().textContent).not.toContain('从版本历史回退')
    expect(backend.writes('chapter:replacement-impact-preview')).toEqual([])
  })
})

describe('替换后的影响提示', () => {
  it('第 3 章定稿页顶部「第 3 章已修改」列出影响；点「知道了」后不再显示，重新打开应用也不显示，再替换一次又出现', async () => {
    const final = backend.addDraft({ status: 'finalized', version: 2 })
    backend.state.impacts = [impactOnThree('finalization-a')]
    await mount()
    await openDraft(final.id)

    await expect.element(page.getByText('第 3 章已修改')).toBeVisible()
    await expect.element(page.getByText('第 4、6–8 章写于这次修改之前，第 9 章只有蓝图，可能和新内容不符，不会自动修改。')).toBeVisible()
    await expect.element(page.getByText('林舟、老周的当前状态来自后续章节，没有按新内容重算。')).toBeVisible()
    await expect.element(page.getByText('「匿名信」：他想起母亲说过，这座车站在三十年前就该拆了。')).toBeVisible()
    await click('知道了')
    await vi.waitFor(() => expect(document.body.textContent).not.toContain('第 3 章已修改'))

    await unmount()
    await mount()
    await expect.element(page.getByText('已定稿，只读')).toBeVisible()
    await vi.waitFor(() => expect(backend.writes('chapter:replacement-impacts').length).toBeGreaterThanOrEqual(2))
    expect(document.body.textContent).not.toContain('第 3 章已修改')

    backend.state.impacts = [impactOnThree('finalization-b')]
    await refresh()
    await expect.element(page.getByText('第 3 章已修改')).toBeVisible()
  })

  it('替换后没有受影响的内容时不出提示', async () => {
    const final = backend.addDraft({ status: 'finalized', version: 2 })
    await mount()
    await openDraft(final.id)
    await expect.element(page.getByText('已定稿，只读')).toBeVisible()
    await vi.waitFor(() => expect(backend.writes('chapter:replacement-impacts').length).toBeGreaterThanOrEqual(1))
    expect(document.body.textContent).not.toContain('已修改')
  })

  it('写于第 2 章修改之前的第 3 章顶部有一行提示，点它打开第 2 章；在第 2 章点了「知道了」，第 3 章的这一行也不再显示', async () => {
    const two = backend.addDraft({ status: 'finalized', chapterNumber: 2 })
    const three = backend.addDraft({ status: 'draft' })
    backend.state.impacts = [{ chapterNumber: 2, finalizationId: 'finalization-two', laterChapters: [3], blueprintOnlyChapters: [], characters: [], unmovedConfirmations: [] }]
    await mount()
    await openDraft(three.id)

    await expect.element(page.getByText('写于第 2 章修改之前')).toBeVisible()
    await expect.element(page.getByText('第 2 章后来改过，这一章可能和它不符，不会自动修改。')).toBeVisible()
    await click('打开第 2 章')
    await vi.waitFor(() => expect(activeTab()?.draftId).toBe(two.id))
    await expect.element(page.getByText('第 2 章已修改')).toBeVisible()
    await expect.element(page.getByText('第 3 章写于这次修改之前，可能和新内容不符，不会自动修改。')).toBeVisible()
    await click('知道了')

    await act(async () => navigate({ kind: 'chapter', chapterNumber: 3 }))
    await vi.waitFor(() => expect(activeTab()?.draftId).toBe(three.id))
    await expect.element(page.getByRole('button', { name: 'AI 审稿', exact: true })).toBeVisible()
    expect(document.body.textContent).not.toContain('写于第 2 章修改之前')
  })

  it('英文界面：提示、按钮与影响说明都是英文', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    const final = backend.addDraft({ status: 'finalized', version: 2 })
    backend.state.impacts = [impactOnThree('finalization-a')]
    await mount()
    await openDraft(final.id)

    await expect.element(page.getByText('Chapter 3 was changed')).toBeVisible()
    await expect.element(page.getByText('Chapters 4, 6–8 were written before this change. Chapter 9 only has a blueprint. They may not match the new text and are not changed automatically.')).toBeVisible()
    await expect.element(page.getByText('The current state of 林舟, 老周 comes from later chapters and was not recalculated from the new text.')).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Got it', exact: true })).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Reopen to edit', exact: true })).toBeVisible()
    await click('Reopen to edit')
    await expect.element(page.getByRole('dialog', { name: 'Reopen chapter 3?' })).toBeVisible()
  })
})
