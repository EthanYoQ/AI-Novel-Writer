import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ProjectData } from '../../../../shared/ipc-channels'
import { parseHumanConfirmedReviewSnapshot } from '../../../../shared/human-confirmed-review'
import { globalEventBus } from '../../../../shared/event-bus'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useDraftStore } from '../../../../stores/draft-store'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useStageStore } from '../../../../stores/navigation/stage-store'
import { openChapterPlan } from '../../../../stores/navigation/stage-navigation'
import { useProjectStore } from '../../../../stores/project-store'
import { useWorkflowStore } from '../../../../stores/workflow-store'
import { openDraftTab } from '../../../../stores/open-draft-tab'
import { toast } from '../../../ui/Toast'
import { commandLabel } from '../../shortcut-keys'
import StageSpine from '../../StageSpine'
import StageWorkspace from '../../StageWorkspace'
import { useStageView } from '../../use-stage-work'
import { BLUEPRINT, ORIGINAL, REVISED, SESSION, chapterProject, createChapterBackend, generationModel } from './chapter-fixture'

const workflows = vi.hoisted(() => ({
  createChapterWorkflow: vi.fn(),
  createReviewOnlyWorkflow: vi.fn(),
  createRefineOnlyWorkflow: vi.fn(),
  createRefineFromReviewWorkflow: vi.fn(),
  createFinalizeWorkflow: vi.fn(),
  createRepairFinalizeWorkflow: vi.fn(),
}))
// 用以 /src 开头的路径：检出路径含空格时（本机 Vibe Coding Project），浏览器模式匹配不到相对路径的模拟。
vi.mock('/src/services/workflows/chapter-workflow.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../services/workflows/chapter-workflow')>()
  for (const [name, spy] of Object.entries(workflows)) spy.mockImplementation(actual[name as keyof typeof workflows] as never)
  return { ...actual, ...workflows }
})

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const original = {
  editor: useEditorStore.getState(), project: useProjectStore.getState(), drafts: useDraftStore.getState(),
  stage: useStageStore.getState(), llm: useLLMStore.getState(), workflow: useWorkflowStore.getState(),
}

let root: Root | undefined
let host: HTMLDivElement | undefined
let backend: ReturnType<typeof createChapterBackend>
let startWorkflow: ReturnType<typeof vi.fn>

async function mount() {
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = 'display:flex;flex-direction:column;height:900px;width:1028px'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<StageWorkspace library={false} focus={false} />))
}

/** 按流程脊的方式载入这一章的稿，再打开它的单章视图。 */
async function openDraft(draftId: number) {
  await act(async () => { await useDraftStore.getState().loadAllDrafts(SESSION.projectPath, SESSION) })
  const draft = Object.values(useDraftStore.getState().draftsByChapter).flat().find(candidate => candidate.id === draftId)!
  await act(async () => { await openDraftTab(draft, '第 3 章 · 雨夜车站', SESSION) })
}

const activeTab = () => useEditorStore.getState().tabs.find(tab => tab.id === useEditorStore.getState().activeTabId)
const click = (name: string | RegExp) => act(async () => page.getByRole('button', { name, exact: typeof name === 'string' }).click())
/** 勾选框藏在纸墨的方框后面，作者点的是整行标签。 */
const toggle = (name: RegExp) => act(async () => page.getByRole('checkbox', { name }).element().closest('label')!.click())
/** 工作流定义里能比较的字段：类型与标题。 */
const started = () => startWorkflow.mock.calls.map(([definition]) => ({ type: definition.type, title: definition.title }))

beforeEach(async () => {
  await page.viewport(1280, 900)
  backend = createChapterBackend()
  backend.install()
  for (const spy of Object.values(workflows)) spy.mockClear()
  startWorkflow = vi.fn(async () => 'chapter-run')
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ currentProject: chapterProject() })
  setActiveProjectSessionContext(SESSION)
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useStageStore.setState({ work: { session: SESSION, architecture: {}, blueprints: [{ chapterNumber: 3, title: BLUEPRINT.title }] }, spineFacts: SESSION, chapterRequest: null, writeRequest: null, sheet: null })
  useLLMStore.setState({ models: [generationModel('glm'), generationModel('grok')], defaultModelId: 'grok', loaded: true })
  useWorkflowStore.setState({ activeRuns: [], history: [], startWorkflow: startWorkflow as never, addLog: vi.fn() as never, getResourceConflict: (() => null) as never })
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

describe('单章视图的主按钮随五种状态变化', () => {
  it('待写：主按钮是写作此章，按本章蓝图启动写作工作流', async () => {
    await mount()
    await act(async () => openChapterPlan(3, BLUEPRINT.title, SESSION))
    await expect.element(page.getByRole('heading', { name: '本章蓝图' })).toBeVisible()
    await click('写作此章')
    await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce())
    const [chapterInfo] = workflows.createChapterWorkflow.mock.calls[0]
    expect({ number: chapterInfo.chapterNumber, title: chapterInfo.title, purpose: chapterInfo.purpose, characters: chapterInfo.characters })
      .toEqual({ number: 3, title: '雨夜车站', purpose: BLUEPRINT.purpose, characters: ['林舟', '老周'] })
    expect(started()[0].type).toBe('chapter_creation')
  })

  it('草稿：主按钮是 AI 审稿，按勾选的检查维度对当前正文启动审稿', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    await mount()
    await openDraft(draft.id)
    await expect.element(page.getByRole('button', { name: 'AI 审稿', exact: true })).toBeVisible()
    await click('检查维度')
    await toggle(/角色状态/)
    await click('AI 审稿')
    await vi.waitFor(() => expect(workflows.createReviewOnlyWorkflow).toHaveBeenCalledOnce())
    const [params] = workflows.createReviewOnlyWorkflow.mock.calls[0]
    expect({ draftContent: params.draftContent, reviewFocus: params.reviewFocus, source: params.sourceDraft.id })
      .toEqual({ draftContent: ORIGINAL, reviewFocus: '剧情连贯性、剧情合理性、前后章节串联', source: draft.id })
    expect(started()).toHaveLength(1)
  })

  it('草稿：提示里的保存快捷键按平台写，Windows 上是 Ctrl S 而不是 ⌘S', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    await mount()
    await openDraft(draft.id)
    await expect.element(page.getByText(/^可以直接改正文/)).toHaveTextContent(`可以直接改正文，${commandLabel('s')} 保存`)
  })

  it('已审稿：勾选数与「按 N 项意见修稿」同步；点它先确认清单，再按这份清单与本次模型修稿', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    backend.addReview(draft)
    await mount()
    await openDraft(draft.id)
    await expect.element(page.getByRole('button', { name: '按 2 项意见修稿' })).toBeVisible()
    await expect.element(page.getByText('2 / 3')).toBeVisible()
    await toggle(/本章必现/)
    await expect.element(page.getByRole('button', { name: '按 3 项意见修稿' })).toBeVisible()
    await expect.element(page.getByText('3 / 3')).toBeVisible()

    await click('修稿选项')
    await act(async () => page.getByRole('combobox', { name: /本次修稿模型/ }).selectOptions('glm'))
    await click('按 3 项意见修稿')
    await vi.waitFor(() => expect(workflows.createRefineFromReviewWorkflow).toHaveBeenCalledOnce())
    const [created] = backend.writes('db:review-create')
    const confirmed = parseHumanConfirmedReviewSnapshot((created[0] as { content: string }).content)!
    expect(confirmed.items.filter(item => item.decision === 'apply').map(item => item.category)).toEqual(['前后矛盾', '节奏', '本章必现'])
    const [params] = workflows.createRefineFromReviewWorkflow.mock.calls[0]
    expect({ reviewSourceId: params.reviewSourceId, model: params.generationModelId, content: params.draftContent })
      .toEqual({ reviewSourceId: backend.state.reviews.at(-1)!.id, model: 'glm', content: ORIGINAL })
  })

  it('「修稿」在分工模型里另有指定时，不打开修稿选项直接修稿也用它', async () => {
    useLLMStore.setState({ stageModelIds: { refinement: 'glm' } })
    const draft = backend.addDraft({ status: 'draft' })
    backend.addReview(draft)
    await mount()
    await openDraft(draft.id)
    await click('按 2 项意见修稿')
    await vi.waitFor(() => expect(workflows.createRefineFromReviewWorkflow).toHaveBeenCalledOnce())
    expect(workflows.createRefineFromReviewWorkflow.mock.calls[0][0].generationModelId).toBe('glm')
  })

  it('「修稿」另有指定时，修稿选项里预选它；作者换成别的模型就按换的修稿', async () => {
    useLLMStore.setState({ stageModelIds: { refinement: 'glm' } })
    const draft = backend.addDraft({ status: 'draft' })
    backend.addReview(draft)
    await mount()
    await openDraft(draft.id)
    await click('修稿选项')
    await expect.element(page.getByRole('combobox', { name: /本次修稿模型/ })).toHaveValue('glm')
    await act(async () => page.getByRole('combobox', { name: /本次修稿模型/ }).selectOptions('grok'))
    await click('按 2 项意见修稿')
    await vi.waitFor(() => expect(workflows.createRefineFromReviewWorkflow).toHaveBeenCalledOnce())
    expect(workflows.createRefineFromReviewWorkflow.mock.calls[0][0].generationModelId).toBe('grok')
  })

  it.each([
    ['用默认模型', 'grok', 'grok'],
    ['默认模型不可用时用第一个生成模型', null, 'glm'],
  ])('「修稿」没有另外指定时照旧%s', async (_label, defaultModelId, expected) => {
    useLLMStore.setState({ defaultModelId })
    const draft = backend.addDraft({ status: 'draft' })
    backend.addReview(draft)
    await mount()
    await openDraft(draft.id)
    await click('按 2 项意见修稿')
    await vi.waitFor(() => expect(workflows.createRefineFromReviewWorkflow).toHaveBeenCalledOnce())
    expect(workflows.createRefineFromReviewWorkflow.mock.calls[0][0].generationModelId).toBe(expected)
  })

  it('重新审稿后按意见修稿：确认的清单只带新审稿复验周期里的意见，不沿用上一份审稿的', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    const first = backend.addReview(draft)
    const finding = (findingId: string) => ({ findingId, reviewItemIndex: 0, category: '前后矛盾', kind: 'literary' as const, status: 'unverified' as const })
    backend.state.cycles.set(first.id, { ...backend.state.cycles.get(first.id)!, findings: [finding('first-cycle-finding')] })
    await mount()
    await openDraft(draft.id)
    await expect.element(page.getByRole('button', { name: '按 2 项意见修稿' })).toBeVisible()

    // 第二次审稿留下新的审稿与它自己的复验周期；审稿工作流结束后单章视图重读这一稿的审稿。
    const second = backend.addReview(draft)
    backend.state.cycles.set(second.id, { ...backend.state.cycles.get(second.id)!, findings: [finding('second-cycle-finding')] })
    await act(async () => globalEventBus.emit('WORKFLOW_COMPLETE', { type: 'review', projectPath: SESSION.projectPath, projectSession: SESSION, runId: 'second-review' }))
    await vi.waitFor(() => expect(backend.writes('db:review-cycle-get').some(([reviewId]) => Number(reviewId) === second.id)).toBe(true))
    await expect.element(page.getByRole('button', { name: '按 2 项意见修稿' })).toBeVisible()
    await click('按 2 项意见修稿')

    await vi.waitFor(() => expect(backend.writes('db:review-create')).toHaveLength(1))
    const confirmed = parseHumanConfirmedReviewSnapshot((backend.writes('db:review-create')[0][0] as { content: string }).content)!
    expect({ sourceReviewId: confirmed.sourceReviewId, cycleId: confirmed.cycleId, findingIds: confirmed.items.flatMap(item => item.findingId ?? []) })
      .toEqual({ sourceReviewId: second.id, cycleId: `cycle-${second.id}`, findingIds: ['second-cycle-finding'] })
  })

  it('已审稿：每条意见都选「不修改此项」时，主按钮变成确认不修改，确认后弃修决定写进审稿记录', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    const review = backend.addReview(draft)
    backend.state.cycles.set(review.id, {
      ...backend.state.cycles.get(review.id)!,
      findings: [0, 1, 2].map(index => ({ findingId: `finding-${index}`, reviewItemIndex: index, category: '', kind: 'literary' as const, status: 'unverified' as const })),
    })
    await mount()
    await openDraft(draft.id)
    await expect.element(page.getByRole('button', { name: '按 2 项意见修稿' })).toBeVisible()
    for (let left = 3; left > 0; left--) await act(async () => page.getByRole('button', { name: '不修改此项' }).first().click())
    await expect.element(page.getByText('0 / 3')).toBeVisible()
    await click('确认不修改')
    await vi.waitFor(() => expect(backend.writes('db:review-create')).toHaveLength(1))
    const [created] = backend.writes('db:review-create')
    const confirmed = parseHumanConfirmedReviewSnapshot((created[0] as { content: string }).content)!
    expect(confirmed.items.filter(item => item.severity !== 'pass').map(item => [item.category, item.decision]))
      .toEqual([['前后矛盾', 'waive'], ['节奏', 'waive'], ['本章必现', 'waive']])
    expect(workflows.createRefineFromReviewWorkflow).not.toHaveBeenCalled()
    await expect.element(page.getByText('已确认不修改，可以在「更多」里定稿')).toBeVisible()
  })

  it('已审稿：修稿启动读稿期间把意见都改成不修改，「确认不修改」点不了，不会多写一份确认清单', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    const review = backend.addReview(draft)
    backend.state.cycles.set(review.id, {
      ...backend.state.cycles.get(review.id)!,
      findings: [0, 1, 2].map(index => ({ findingId: `finding-${index}`, reviewItemIndex: index, category: '', kind: 'literary' as const, status: 'unverified' as const })),
    })
    await mount()
    await openDraft(draft.id)
    const answer = backend.invoke.getMockImplementation()!
    let release = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const held = vi.fn()
    backend.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'db:draft-get-full' && backend.writes('db:review-create').length === 1 && held.mock.calls.length === 0) {
        held()
        await gate
      }
      return answer(channel, ...args)
    })
    await click('按 2 项意见修稿')
    await vi.waitFor(() => expect(held).toHaveBeenCalledOnce())
    expect(backend.writes('db:review-create')).toHaveLength(1)
    for (let left = 2; left > 0; left--) await act(async () => page.getByRole('button', { name: '不修改此项' }).first().click())
    await expect.element(page.getByRole('button', { name: '确认不修改', exact: true })).toBeDisabled()
    await act(async () => { release(); await new Promise(resolve => setTimeout(resolve, 100)) })
    expect(backend.writes('db:review-create')).toHaveLength(1)
  })

  it('人工意见进入修稿输入：添加我的意见后，它在确认的清单里并被纳入', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    backend.addReview(draft)
    await mount()
    await openDraft(draft.id)
    await click('添加我的意见')
    await act(async () => page.getByRole('textbox', { name: '审稿问题' }).fill('结尾要停在林舟回头之前。'))
    await click('按 3 项意见修稿')
    await vi.waitFor(() => expect(workflows.createRefineFromReviewWorkflow).toHaveBeenCalledOnce())
    const [params] = workflows.createRefineFromReviewWorkflow.mock.calls[0]
    const confirmed = parseHumanConfirmedReviewSnapshot(params.confirmedReviewContent)!
    expect(confirmed.items.filter(item => item.origin === 'author').map(item => [item.description, item.decision]))
      .toEqual([['结尾要停在林舟回头之前。', 'apply']])
  })

  it('有待合并修稿：直接摆出合并视图，完成合并提交选择的正文并启动合并后复验', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    backend.addReview(draft)
    const revision = backend.addRevision(draft)
    await mount()
    await openDraft(draft.id)
    await expect.element(page.getByRole('button', { name: '完成合并' })).toBeVisible()
    await click('全部用修稿')
    await click('完成合并')
    await vi.waitFor(() => expect(workflows.createReviewOnlyWorkflow).toHaveBeenCalledOnce())
    const [merge] = backend.writes('db:revision-merge')
    expect(merge[0]).toMatchObject({ revisionId: revision.id, targetDraftId: draft.id, expectedDraftContent: ORIGINAL, mergedContent: REVISED })
    const [recheck] = workflows.createReviewOnlyWorkflow.mock.calls[0]
    expect({ cycle: recheck.reviewCycleId, hash: recheck.expectedMergedHash, content: recheck.draftContent })
      .toEqual({ cycle: 'cycle-1', hash: 'b'.repeat(64), content: REVISED })
    await expect.element(page.getByRole('button', { name: '定稿', exact: true })).toBeVisible()
    expect(activeTab()?.content).toBe(REVISED)
  })

  it('合并后自动复验成功：写明复验完成几项，审稿报告打开的是原审稿与逐项复验结果', async () => {
    const draft = backend.addDraft({ status: 'revised' })
    const review = backend.addReview(draft)
    backend.addRecheck(draft, review, ['resolved', 'unresolved', 'resolved'])
    await mount()
    await openDraft(draft.id)
    await expect.element(page.getByText('复验完成：2 / 3 项意见已解决')).toBeVisible()
    await click('更多操作')
    await act(async () => page.getByRole('menuitem', { name: '审稿报告' }).click())
    const sheet = page.getByRole('complementary', { name: /审稿/ })
    await expect.element(sheet.getByText('第 2 章写明母亲在他出生前离开。').first()).toBeVisible()
    expect(sheet.getByText('复验：已解决').elements()).toHaveLength(2)
    expect(sheet.getByText('复验：未解决').elements()).toHaveLength(1)
  })

  it('已修稿：主按钮是定稿，确认后以当前正文（含未保存修改）提交定稿', async () => {
    const draft = backend.addDraft({ status: 'revised' })
    await mount()
    await openDraft(draft.id)
    await act(async () => useEditorStore.getState().updateTabContent(activeTab()!.id, `${ORIGINAL}\n\n他回头了。`))
    await click('定稿')
    await expect.element(page.getByRole('dialog', { name: '定稿第 3 章？' })).toBeVisible()
    await expect.element(page.getByText('还没保存的修改会一并定稿')).toBeVisible()
    await click('确认定稿')
    await vi.waitFor(() => expect(workflows.createFinalizeWorkflow).toHaveBeenCalledOnce())
    const [params] = workflows.createFinalizeWorkflow.mock.calls[0]
    expect({ content: params.draftContent, snapshot: params.snapshot.content, draftId: params.snapshot.draftId })
      .toEqual({ content: `${ORIGINAL}\n\n他回头了。`, snapshot: `${ORIGINAL}\n\n他回头了。`, draftId: draft.id })
  })

  it('定稿：正文只读，列出后处理各步；重试失败步骤只重跑失败的，单步重试只跑那一步', async () => {
    const draft = backend.addDraft({ status: 'finalized' })
    backend.state.postProcess = { steps: [
      { stepKey: 'chapter_notes', label: '章节剧情要点', ok: true },
      { stepKey: 'character_cards', label: '角色状态更新', ok: false, errorMsg: '模型长时间没有响应', attemptCount: 1 },
      { stepKey: 'kb_import', label: '导入知识库', ok: true },
    ] }
    await mount()
    await openDraft(draft.id)
    await expect.element(page.getByText('已定稿，只读')).toBeVisible()
    await expect.element(page.getByText('2 / 3 完成')).toBeVisible()
    expect(host!.querySelector('.stage-ch-prose .cm-content')?.getAttribute('contenteditable')).toBe('false')
    await click('重试失败步骤')
    await vi.waitFor(() => expect(workflows.createRepairFinalizeWorkflow).toHaveBeenCalledOnce())
    await click('重试')
    await vi.waitFor(() => expect(workflows.createRepairFinalizeWorkflow).toHaveBeenCalledTimes(2))
    expect(workflows.createRepairFinalizeWorkflow.mock.calls.map(call => [call[0], call[3]])).toEqual([[3, undefined], [3, 'character_cards']])
  })

  it.each([
    ['zh-CN', '生成期间', 'Retry'],
    ['en-US', 'while this step was running', '重试'],
  ] as const)('#484 角色状态提交时字段已被改动：步骤详情用 %s 说明原因和作者能做什么，不显示错误码', async (locale, hint, otherLanguage) => {
    const draft = backend.addDraft({ status: 'finalized' })
    backend.state.postProcess = { steps: [
      { stepKey: 'chapter_notes', label: '章节剧情要点', ok: true },
      { stepKey: 'character_cards', label: '角色状态更新', ok: false, attemptCount: 1,
        errorMsg: "Error invoking remote method 'project-session:invoke': Error: FINALIZED_CHARACTER_FIELD_CONFLICT" },
    ] }
    await act(async () => useLocaleStore.setState({ locale }))
    await mount()
    await openDraft(draft.id)
    await vi.waitFor(() => expect(host!.querySelector('.stage-ch-post-step[data-state="failed"] .stage-ch-post-detail')).not.toBeNull())
    const detail = host!.querySelector('.stage-ch-post-step[data-state="failed"] .stage-ch-post-detail')!.textContent!
    expect(detail).not.toMatch(/FINALIZED_CHARACTER|Error invoking/u)
    expect(detail).toContain(hint)
    expect(detail).not.toContain(otherLanguage)
  })

  describe('#502 只给重试有用的失败步骤摆重试', () => {
    const IPC = "Error invoking remote method 'project-session:invoke': Error: "
    /** 带重试按钮的行（按步骤名），以及卡片右上角的整卡重试按钮。 */
    const retryRows = () => [...host!.querySelectorAll('.stage-ch-post-step')]
      .filter(row => row.querySelector('button')).map(row => row.querySelector('b')!.textContent)
    const cardRetry = () => host!.querySelector('.stage-ch-post-head button')?.textContent ?? null
    async function show(steps: NonNullable<typeof backend.state.postProcess>['steps']) {
      const draft = backend.addDraft({ status: 'finalized' })
      backend.state.postProcess = { steps }
      await mount()
      await openDraft(draft.id)
      await vi.waitFor(() => expect(host!.querySelector('.stage-ch-post-step[data-state="failed"]')).not.toBeNull())
    }

    it.each(['zh-CN', 'en-US'] as const)('%s：重试结果也一样的失败，这一行和卡片上都没有重试', async locale => {
      await act(async () => useLocaleStore.setState({ locale }))
      await show([
        { stepKey: 'kb_import', label: '导入知识库', ok: true },
        { stepKey: 'chapter_notes', label: '章节剧情要点', ok: true },
        { stepKey: 'character_cards', label: '角色状态更新', ok: false, attemptCount: 1, errorMsg: `${IPC}FINALIZED_CHARACTER_FIELD_CONFLICT` },
      ])
      expect(retryRows()).toEqual([])
      expect(cardRetry()).toBeNull()
    })

    it('可以重试与不能重试的失败混在一起：只有能重试的行有重试，卡片上照常有「重试失败步骤」', async () => {
      await show([
        { stepKey: 'kb_import', label: '导入知识库', ok: false, attemptCount: 1, errorMsg: '向量服务没有响应' },
        { stepKey: 'chapter_notes', label: '章节剧情要点', ok: true },
        { stepKey: 'character_cards', label: '角色状态更新', ok: false, attemptCount: 1, errorMsg: 'FINALIZED_CHARACTER_FIELD_CONFLICT' },
      ])
      expect(retryRows()).toEqual(['导入知识库'])
      expect(cardRetry()).toBe('重试失败步骤')
    })

    it('来源冲突的说明写了什么时候可以重试：行上照常有重试', async () => {
      await show([
        { stepKey: 'chapter_notes', label: '章节剧情要点', ok: true },
        { stepKey: 'character_cards', label: '角色状态更新', ok: false, attemptCount: 1, errorMsg: 'FINALIZED_CHARACTER_SOURCE_CONFLICT' },
      ])
      expect(retryRows()).toEqual(['角色状态更新'])
      expect(cardRetry()).toBe('重试失败步骤')
    })

    it('角色状态在等章节剧情要点：要点还失败着时只有要点一行能重试，整卡重试照常显示', async () => {
      await show([
        { stepKey: 'chapter_notes', label: '章节剧情要点', ok: false, attemptCount: 1, errorMsg: 'FINALIZATION_GENERATION_INCOMPLETE' },
        { stepKey: 'character_cards', label: '角色状态更新', ok: false, attemptCount: 1, errorMsg: 'GENERATION_FINALIZATION_PREDECESSOR_REQUIRED' },
      ])
      expect(retryRows()).toEqual(['章节剧情要点'])
      expect(cardRetry()).toBe('重试失败步骤')
    })

    it('章节剧情要点已经成功后，等它的角色状态一行可以重试', async () => {
      await show([
        { stepKey: 'chapter_notes', label: '章节剧情要点', ok: true },
        { stepKey: 'character_cards', label: '角色状态更新', ok: false, attemptCount: 1, errorMsg: 'GENERATION_FINALIZATION_PREDECESSOR_REQUIRED' },
      ])
      expect(retryRows()).toEqual(['角色状态更新'])
    })

    it.each([
      ['zh-CN', '重新定稿本章', /Retry|Finalize/u],
      ['en-US', 'Finalize this chapter again', /\p{Script=Han}/u],
    ] as const)('#512 %s：定稿时在场的角色后来被删除，说明作者能做什么，不显示错误码，也不摆重试', async (locale, hint, otherLanguage) => {
      await act(async () => useLocaleStore.setState({ locale }))
      await show([
        { stepKey: 'kb_import', label: '导入知识库', ok: true },
        { stepKey: 'chapter_notes', label: '章节剧情要点', ok: true },
        { stepKey: 'character_cards', label: '角色状态更新', ok: false, attemptCount: 3, errorMsg: `${IPC}FINALIZED_CHARACTER_ID_RETIRED` },
      ])
      const detail = host!.querySelector('.stage-ch-post-step[data-state="failed"] .stage-ch-post-detail')!.textContent!
      expect(detail).not.toMatch(/FINALIZED_CHARACTER|Error invoking/u)
      expect(detail).toContain(hint)
      expect(detail).not.toMatch(otherLanguage)
      expect(retryRows()).toEqual([])
      expect(cardRetry()).toBeNull()
    })

    it('#512 章节要点在生成期间被作者改过：这一行能重试，说明写明重试会替换作者改的要点', async () => {
      await show([
        { stepKey: 'kb_import', label: '导入知识库', ok: true },
        { stepKey: 'chapter_notes', label: '章节剧情要点', ok: false, attemptCount: 3, errorMsg: `${IPC}GENERATION_FINALIZATION_NOTES_CHANGED` },
        { stepKey: 'character_cards', label: '角色状态更新', ok: false, attemptCount: 1, errorMsg: 'GENERATION_FINALIZATION_PREDECESSOR_REQUIRED' },
      ])
      expect(retryRows()).toEqual(['章节剧情要点'])
      expect(cardRetry()).toBe('重试失败步骤')
      const detail = host!.querySelector('.stage-ch-post-step[data-state="failed"] .stage-ch-post-detail')!.textContent!
      expect(detail).not.toMatch(/GENERATION_|Error invoking/u)
      expect(detail).toContain('替换')
    })

    it.each([
      ['zh-CN', '这一步来自旧版本', '3 / 3 完成'],
      ['en-US', 'earlier version', '3 / 3 done'],
    ] as const)('#512 %s：旧版本留下的步骤仍列出并说明，不摆重试，也不算进完成数', async (locale, note, count) => {
      await act(async () => useLocaleStore.setState({ locale }))
      const draft = backend.addDraft({ status: 'finalized' })
      backend.state.postProcess = { steps: [
        { stepKey: 'kb_import', label: '导入知识库', ok: true },
        { stepKey: 'chapter_notes', label: '章节剧情要点', ok: true },
        { stepKey: 'character_cards', label: '角色状态更新', ok: true },
        { stepKey: 'style_analysis', label: '文风自动学习', ok: false, attemptCount: 1, errorMsg: '模型长时间没有响应' },
      ] }
      await mount()
      await openDraft(draft.id)
      await vi.waitFor(() => expect(host!.querySelectorAll('.stage-ch-post-step')).toHaveLength(4))
      const legacy = [...host!.querySelectorAll('.stage-ch-post-step')].find(row => row.querySelector('b')!.textContent === '文风自动学习')!
      expect(legacy.getAttribute('data-state')).not.toBe('failed')
      expect(legacy.querySelector('.stage-ch-post-detail')!.textContent).toContain(note)
      expect(retryRows()).toEqual([])
      expect(cardRetry()).toBeNull()
      expect(host!.querySelector('.stage-ch-post-title small')!.textContent).toBe(count)
    })

    it('#512 旧版本留下的步骤当时成功了也一样说明它已不再运行，不算进完成数', async () => {
      const draft = backend.addDraft({ status: 'finalized' })
      backend.state.postProcess = { steps: [
        { stepKey: 'kb_import', label: '导入知识库', ok: true },
        { stepKey: 'chapter_notes', label: '章节剧情要点', ok: true },
        { stepKey: 'character_cards', label: '角色状态更新', ok: false, attemptCount: 1, errorMsg: '模型长时间没有响应' },
        { stepKey: 'style_analysis', label: '文风自动学习', ok: true },
      ] }
      await mount()
      await openDraft(draft.id)
      await vi.waitFor(() => expect(host!.querySelectorAll('.stage-ch-post-step')).toHaveLength(4))
      const legacy = [...host!.querySelectorAll('.stage-ch-post-step')].find(row => row.querySelector('b')!.textContent === '文风自动学习')!
      expect(legacy.getAttribute('data-state')).not.toBe('success')
      expect(legacy.querySelector('.stage-ch-post-detail')!.textContent).toContain('这一步来自旧版本')
      expect(host!.querySelector('.stage-ch-post-title small')!.textContent).toBe('2 / 3 完成')
      expect(retryRows()).toEqual(['角色状态更新'])
    })

    it('没登记的错误照常显示重试', async () => {
      await show([
        { stepKey: 'chapter_notes', label: '章节剧情要点', ok: true },
        { stepKey: 'character_cards', label: '角色状态更新', ok: false, attemptCount: 1, errorMsg: '模型长时间没有响应' },
      ])
      expect(retryRows()).toEqual(['角色状态更新'])
      expect(cardRetry()).toBe('重试失败步骤')
    })
  })

  it('定稿：修复前的检查还没回来时切到英文，拦下修复的提示用英文', async () => {
    const draft = backend.addDraft({ status: 'finalized' })
    backend.state.postProcess = { steps: [
      { stepKey: 'character_cards', label: '角色状态更新', ok: false, errorMsg: '模型长时间没有响应', attemptCount: 1 },
    ] }
    let finish!: (value: number) => void
    const fallback = backend.invoke.getMockImplementation()!
    backend.invoke.mockImplementation((channel: string, ...args: unknown[]) => channel === 'db:draft-get-max-finalized-chapter'
      ? new Promise<number>(resolve => { finish = resolve })
      : fallback(channel, ...args))
    const shown = vi.spyOn(toast, 'error')
    try {
      await mount()
      await openDraft(draft.id)
      await click('重试失败步骤')
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
      await act(async () => useLocaleStore.setState({ locale: 'en-US' }))
      await act(async () => finish(0))
      await vi.waitFor(() => expect(shown).toHaveBeenCalledWith('Could not run the repair.'))
      expect(workflows.createRepairFinalizeWorkflow).not.toHaveBeenCalled()
    } finally {
      shown.mockRestore()
    }
  })
})

/** 单章视图旁边摆上真实的流程脊，两边读的是同一份作品数据。 */
async function mountWithSpine() {
  const SpineBeside = () => {
    const view = useStageView()
    return <StageSpine stages={view.stages} chapters={view.chapters} location={view.location} onStage={() => {}} onChapter={() => {}} onResource={() => {}} onSettings={() => {}} />
  }
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = 'display:flex;height:900px;width:1280px'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<><SpineBeside /><StageWorkspace library={false} focus={false} /></>))
}

/** 流程脊上第 3 章那一行。 */
const spineRow = () => page.getByRole('list', { name: '章节' }).getByRole('button', { name: /雨夜车站/ })

describe('流程脊与单章视图同一个阶段', () => {
  it('草稿上有审稿：流程脊写待修稿，单章视图的主按钮是按意见修稿', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    backend.addReview(draft)
    await mountWithSpine()
    await openDraft(draft.id)
    await expect.element(page.getByRole('button', { name: '按 2 项意见修稿' })).toBeVisible()
    await expect.element(spineRow()).toHaveTextContent('待修稿')
  })

  it('审稿后直接修稿并合并：两边都到定稿这一步，不再要求按旧意见修稿', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    backend.addReview(draft)
    backend.addRevision(draft, 'refine')
    await mountWithSpine()
    await openDraft(draft.id)
    await click('全部用修稿')
    await click('完成合并')
    await expect.element(page.getByRole('button', { name: '定稿', exact: true })).toBeVisible()
    await expect.element(page.getByRole('button', { name: /项意见修稿$/ })).not.toBeInTheDocument()
    await expect.element(spineRow()).toHaveTextContent('待定稿')
  })

  it('修稿生成后正文又改过：修稿不能合并，不占主流程；审稿入口还在，过期修稿可以丢弃', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    backend.addReview(draft)
    const revision = backend.addRevision(draft)
    draft.content = `${ORIGINAL}\n\n作者后来补的一段。`
    await mountWithSpine()
    await openDraft(draft.id)
    await expect.element(page.getByRole('button', { name: '按 2 项意见修稿' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: '重新审稿' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: '完成合并' })).not.toBeInTheDocument()
    await expect.element(spineRow()).toHaveTextContent('待修稿')
    await expect.element(page.getByText('有 1 份修稿不能再合并')).toBeVisible()
    await expect.element(page.getByText('修稿生成之后正文又改过，合并会覆盖这些修改。可以查看修稿手动摘取，或丢弃后重新修稿。')).toBeVisible()
    await click('丢弃…')
    await click('丢弃修稿')
    await expect.element(page.getByText('有 1 份修稿不能再合并')).not.toBeInTheDocument()
    expect(backend.writes('db:revision-mark-discarded').map(args => args[0])).toEqual([revision.id])
  })

  it('旧修稿没有记下生成时的源稿：同样不能合并，提示说的是没有源稿记录，不说正文改过', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    backend.addRevision(draft).source = null
    await mountWithSpine()
    await openDraft(draft.id)
    await expect.element(page.getByText('有 1 份修稿不能再合并')).toBeVisible()
    await expect.element(page.getByText('较早的修稿没有记下生成时依据的正文，无法确认合并会不会覆盖之后的修改。可以查看修稿手动摘取，或丢弃后重新修稿。')).toBeVisible()
    await expect.element(page.getByRole('button', { name: '完成合并' })).not.toBeInTheDocument()
  })

  it('有两份能合并的修稿：合并视图摆的是最新的一份', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    backend.addRevision(draft, 'refine')
    const newer = backend.addRevision(draft, 'refine')
    await mountWithSpine()
    await openDraft(draft.id)
    await expect.element(spineRow()).toHaveTextContent('待合并')
    await click('全部用修稿')
    await click('完成合并')
    await vi.waitFor(() => expect(backend.writes('db:revision-merge').map(args => (args[0] as { revisionId: number }).revisionId)).toEqual([newer.id]))
  })

  it('审稿记录读出来之前不摆主按钮：不会先闪一下 AI 审稿', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    backend.addReview(draft)
    const answer = backend.invoke.getMockImplementation()!
    backend.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'db:review-list') await new Promise(resolve => setTimeout(resolve, 150))
      return answer(channel, ...args)
    })
    await mount()
    const seen = new Set<string>()
    const observer = new MutationObserver(() => host!.querySelectorAll('.stage-ch-actions .pi-btn').forEach(button => seen.add(button.textContent ?? '')))
    observer.observe(host!, { subtree: true, childList: true, characterData: true })
    await openDraft(draft.id)
    await expect.element(page.getByRole('button', { name: '按 2 项意见修稿' })).toBeVisible()
    observer.disconnect()
    expect([...seen].filter(label => label.includes('AI 审稿') || label.includes('定稿'))).toEqual([])
  })
})

describe('确认审稿清单的往返期间换了作品，回来的结果不碰新作品的侧页', () => {
  const HARBOR = { projectId: 'harbor', leaseId: 'harbor-lease', projectPath: 'C:\\novels\\harbor' }
  const RUN_SHEET = { kind: 'run' as const, tab: 'active' as const }

  /** 卡住确认清单读审稿原文的那次 db:review-get-full，返回放行函数。 */
  function holdReviewRead() {
    const answer = backend.invoke.getMockImplementation()!
    let release = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const held = vi.fn()
    backend.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'db:review-get-full' && held.mock.calls.length === 0) {
        held()
        await gate
      }
      return answer(channel, ...args)
    })
    return { held, release }
  }

  /** 换到另一次打开：作品与会话一起换，作者在新作品里开着运行侧页。 */
  async function switchTo(session: { projectId: string; leaseId: string; projectPath: string }, project: ProjectData) {
    setActiveProjectSessionContext(session)
    await act(async () => useProjectStore.setState({ currentProject: project }))
    await act(async () => useStageStore.setState({ sheet: RUN_SHEET }))
  }

  async function waiveAll() {
    const draft = backend.addDraft({ status: 'draft' })
    const review = backend.addReview(draft)
    backend.state.cycles.set(review.id, {
      ...backend.state.cycles.get(review.id)!,
      findings: [0, 1, 2].map(index => ({ findingId: `finding-${index}`, reviewItemIndex: index, category: '', kind: 'literary' as const, status: 'unverified' as const })),
    })
    await mount()
    await openDraft(draft.id)
    await expect.element(page.getByRole('button', { name: '按 2 项意见修稿' })).toBeVisible()
    for (let left = 3; left > 0; left--) await act(async () => page.getByRole('button', { name: '不修改此项' }).first().click())
    await expect.element(page.getByRole('button', { name: '确认不修改', exact: true })).toBeVisible()
  }

  it('确认不修改：换到另一部作品，回来后运行侧页还开着，没有换成旧稿的审稿侧页', async () => {
    await waiveAll()
    const { held, release } = holdReviewRead()
    await click('确认不修改')
    await vi.waitFor(() => expect(held).toHaveBeenCalledOnce())
    await switchTo(HARBOR, { ...chapterProject(), id: HARBOR.projectId, path: HARBOR.projectPath, sessionLease: HARBOR.leaseId })
    await act(async () => { release(); await new Promise(resolve => setTimeout(resolve, 100)) })
    expect(useStageStore.getState().sheet).toEqual(RUN_SHEET)
    expect(backend.writes('db:review-create')).toEqual([])
  })

  it('按意见修稿：重新打开同一部作品（新的会话），回来后运行侧页还开着，也没有启动修稿', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    backend.addReview(draft)
    await mount()
    await openDraft(draft.id)
    await expect.element(page.getByRole('button', { name: '按 2 项意见修稿' })).toBeVisible()
    const { held, release } = holdReviewRead()
    await click('按 2 项意见修稿')
    await vi.waitFor(() => expect(held).toHaveBeenCalledOnce())
    await switchTo({ ...SESSION, leaseId: 'reopened-lease' }, { ...chapterProject(), sessionLease: 'reopened-lease' })
    await act(async () => { release(); await new Promise(resolve => setTimeout(resolve, 100)) })
    expect(useStageStore.getState().sheet).toEqual(RUN_SHEET)
    expect(workflows.createRefineFromReviewWorkflow).not.toHaveBeenCalled()
  })

  it('没换作品、清单本身没通过（留着空白的人工意见）：侧页打开并写明原因', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    backend.addReview(draft)
    await mount()
    await openDraft(draft.id)
    await click('添加我的意见')
    await act(async () => useStageStore.setState({ sheet: RUN_SHEET }))
    await click('按 3 项意见修稿')
    await vi.waitFor(() => expect(useStageStore.getState().sheet).toEqual({ kind: 'review', filePath: activeTab()!.filePath }))
    await expect.element(page.getByText('请填写或移除空白的人工问题后再确认。')).toBeVisible()
  })
})
