import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ModelProfile, ProjectData } from '../../../shared/ipc-channels'
import { parseHumanConfirmedReviewSnapshot } from '../../../shared/human-confirmed-review'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import ReviewReport from '../ReviewReport'

const PROJECT_PATH = 'C:\\novels\\confirmed-review'
const PROJECT_SESSION = Object.freeze({
  projectId: 'confirmed-review-project',
  leaseId: 'confirmed-review-lease',
  projectPath: PROJECT_PATH,
})
const RAW_AI_REPORT = JSON.stringify({
  summary: '原始 AI 总结应保持原样，且不能直接成为修稿指令。',
  items: [
    {
      category: '连续性',
      severity: 'error',
      description: '角色离开港口后又在同一场景出现。',
      quote: '他仍站在港口的灯塔下。',
      stableFactKey: 'fact:1234567890abcdef',
      sourceChapter: 7,
    },
    {
      category: '节奏',
      severity: 'warning',
      description: '场景切换过于突然。',
    },
    {
      category: '措辞',
      severity: 'pass',
      description: '语言表达自然。',
    },
  ],
})
const REVIEW_SOURCE_DRAFT = Object.freeze({
  id: 1,
  chapterNumber: 1,
  version: 1,
  status: 'draft' as const,
  content: '这是尚未合并的原始草稿正文。',
})

const originalLLMState = useLLMStore.getState()
const originalLocaleState = useLocaleStore.getState()
const originalProjectState = useProjectStore.getState()
const originalWorkflowState = useWorkflowStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined
let invoke: ReturnType<typeof vi.fn>
let startWorkflow: ReturnType<typeof vi.fn>
let setDefaultModel: ReturnType<typeof vi.fn>

function project(writingLanguage: 'zh-CN' | 'en-US' = 'zh-CN'): ProjectData {
  return {
    id: PROJECT_SESSION.projectId,
    sessionLease: PROJECT_SESSION.leaseId,
    name: '人工确认审稿测试项目',
    path: PROJECT_PATH,
    novelConfig: {
      genre: '奇幻',
      subGenre: '',
      targetAudience: '全龄',
      totalChapters: 5,
      wordsPerChapter: 3000,
      plotStructure: 'three_act',
      narrativePOV: 'third_limited',
      coreOutline: '完整的故事构想',
      worldSetting: '',
      goldenFinger: '',
      protagonistProfile: '',
      globalGuidance: '',
      writingLanguage,
    },
    characterStates: '',
    createdAt: '',
    updatedAt: '',
  }
}

function model(overrides: Partial<ModelProfile>): ModelProfile {
  return {
    id: 'generation-model',
    name: 'Generation model',
    provider: 'custom',
    protocol: 'openai',
    modelName: 'generation-model',
    apiKey: 'test-only-key',
    baseUrl: 'https://models.example/v1',
    temperature: 0.7,
    maxTokens: 4096,
    purposes: ['generation'],
    ...overrides,
  }
}

function installIpc(confirmationId: number, currentDraftContent: string = REVIEW_SOURCE_DRAFT.content) {
  let draftContent = currentDraftContent
  let latestReview: {
    id: number
    baseDraftId: number
    reviewIndex: number
    contentId: number
    createdAt: string
    content: string
  } | null = null
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'db:draft-get-meta') {
      return {
        id: 1,
        chapterNumber: 1,
        chapterTitle: '雨夜启程',
        version: 1,
        status: 'draft',
        source: 'write',
      }
    }
    if (channel === 'db:draft-get-full') return { id: 1, content: draftContent }
    if (channel === 'db:review-next-index') return 2
    if (channel === 'db:review-create') return { success: true, id: confirmationId }
    if (channel === 'db:review-get-full') {
      return {
        id: 41,
        baseDraftId: 1,
        reviewIndex: 1,
        contentId: 100,
        createdAt: '2026-08-28T00:00:00.000Z',
        content: RAW_AI_REPORT,
        sourceDraft: REVIEW_SOURCE_DRAFT,
      }
    }
    if (channel === 'db:review-get-latest') return latestReview
    throw new Error(`Unexpected IPC channel: ${channel}`)
  })
  Object.defineProperty(window, 'velaAPI', {
    configurable: true,
    value: {
      invoke,
      on: vi.fn(() => () => {}),
      once: vi.fn(),
      send: vi.fn(),
      setZoomLevel: vi.fn(),
      setZoomFactor: vi.fn(),
      getZoomLevel: vi.fn(() => 0),
    },
  })
  return {
    setDraftContent(content: string) {
      draftContent = content
    },
    setLatestReview(content: string) {
      latestReview = {
        id: confirmationId,
        baseDraftId: 1,
        reviewIndex: 2,
        contentId: 101,
        createdAt: '2026-08-29T00:00:00.000Z',
        content,
      }
    },
  }
}

function confirmationCreateParams() {
  const call = invoke.mock.calls.find(([channel]) => channel === 'db:review-create')
  if (!call) throw new Error('Expected the confirmed review snapshot to be persisted')
  return call[1] as {
    baseDraftId: number
    reviewIndex: number
    content: string
    expectedSource: typeof REVIEW_SOURCE_DRAFT
  }
}

function selectedModel(): HTMLSelectElement {
  const select = document.getElementById('review-revision-model')
  if (!(select instanceof HTMLSelectElement)) throw new Error('Missing review revision model selector')
  return select
}

async function renderReport(reportText = RAW_AI_REPORT) {
  await act(async () => {
    root?.render(
      <ReviewReport
        projectKey={PROJECT_PATH}
        reportText={reportText}
        draftPath="vela://draft/1"
        chapterNumber={1}
        chapterDir="vela://draft/ch1"
        reviewId={41}
      />,
    )
  })
}

async function changeSelect(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function fillTextarea(selector: string, value: string, index = 0) {
  const candidates = document.querySelectorAll<HTMLTextAreaElement>(selector)
  const textarea = candidates.item(index)
  if (!textarea) throw new Error(`Missing textarea: ${selector} at index ${index}`)
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set
    setter?.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  startWorkflow = vi.fn(async () => 'confirmed-review-run')
  setDefaultModel = vi.fn(async () => true)
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ currentProject: project() })
  setActiveProjectSessionContext(PROJECT_SESSION)
  useLLMStore.setState({
    models: [
      model({ id: 'glm', name: 'GLM', modelName: 'GLM-4-Flash' }),
      model({ id: 'grok', name: 'Grok', modelName: 'grok-4' }),
      model({ id: 'embedding', name: 'Embedding only', purposes: ['embedding'] }),
    ],
    defaultModelId: 'glm',
    defaultEmbeddingModelId: 'embedding',
    activeRequests: new Map(),
    loaded: true,
    setDefaultModel: setDefaultModel as never,
  })
  useWorkflowStore.setState({
    activeRuns: [],
    history: [],
    globalLogs: [],
    waitingRuns: {},
    currentRun: null,
    waitingForConfirm: false,
    waitingAfterStepIndex: -1,
    startWorkflow: startWorkflow as never,
    addLog: vi.fn() as never,
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  Reflect.deleteProperty(window, 'velaAPI')
  setActiveProjectSessionContext(null)
  useLLMStore.setState(originalLLMState)
  useLocaleStore.setState(originalLocaleState)
  useProjectStore.setState(originalProjectState)
  useWorkflowStore.setState(originalWorkflowState)
})

describe('ReviewReport human-confirmed revision flow', () => {
  it('逐项目标展示完成证据，待核实不计通过且仅明确选择后纳入不可变确认', async () => {
    installIpc(42)
    const goalReview = {
      version: 1, chapterNumber: 1, coverage: 'complete',
      items: [
        { id: 'done', text: '约定周三出发', status: 'completed', description: '双方已约定', evidence: [{ quote: '约好周三出发', start: 0, end: 6 }] },
        { id: 'uncertain', text: '确认相册完成', status: 'unknown', description: '没有足够证据', evidence: [] },
        { id: 'unmet', text: '本章装好相册封面', status: 'unmet', description: '明确延期', evidence: [{ quote: '明天糊封面', start: 0, end: 5 }] },
      ],
    }
    const report = JSON.stringify({ summary: '', goalReview, items: [
      { category: '本章目标', goalId: 'done', severity: 'pass', description: '双方已约定' },
      { category: '本章目标', goalId: 'uncertain', severity: 'unknown', description: '没有足够证据' },
      { category: '本章目标', goalId: 'unmet', severity: 'error', description: '明确延期' },
    ] })
    await renderReport(report)
    expect(container!.textContent).toContain('1 待核实')
    expect(container!.textContent).toContain('1 通过')
    expect(container!.textContent).toContain('约定周三出发 — 已完成')
    expect(container!.textContent).toContain('约好周三出发')
    expect(container!.textContent).toContain('本章装好相册封面 — 未完成')
    await act(async () => {
      await page.getByRole('button', { name: '确认审稿清单', exact: true }).click()
      await vi.waitFor(() => expect(invoke.mock.calls.some(([channel]) => channel === 'db:review-create')).toBe(true))
    })
    const ignored = parseHumanConfirmedReviewSnapshot(confirmationCreateParams().content)!
    expect(ignored.items[1]).toMatchObject({ goalId: 'uncertain', severity: 'unknown', decision: 'ignore' })
    expect(ignored.goalReview).toEqual(goalReview)
    expect(ignored.items[2]).toMatchObject({ goalId: 'unmet', severity: 'error', decision: 'apply' })
    await act(async () => page.getByRole('button', { name: '编辑清单', exact: true }).click())
    await act(async () => page.getByRole('button', { name: '明确纳入修稿', exact: true }).click())
    invoke.mockClear()
    await act(async () => {
      await page.getByRole('button', { name: '重新确认审稿清单', exact: true }).click()
      await vi.waitFor(() => expect(invoke.mock.calls.some(([channel]) => channel === 'db:review-create')).toBe(true))
    })
    const applied = parseHumanConfirmedReviewSnapshot(confirmationCreateParams().content)!
    expect(applied.items[1]).toMatchObject({ goalId: 'uncertain', severity: 'unknown', decision: 'apply' })
    expect(ignored.items[1].decision).toBe('ignore')
    await renderReport(confirmationCreateParams().content)
    expect(container!.textContent).toContain('约好周三出发')
    expect(container!.textContent).toContain('确认相册完成 — 待核实')
  })

  it('preserves the raw AI report while an author edits, ignores, restores, adds, confirms, and routes a Grok revision without changing the global default', async () => {
    installIpc(91)
    await renderReport()

    expect(container?.textContent).toContain(RAW_AI_REPORT)
    expect(container?.textContent).toContain('来源：第7章')
    await act(async () => page.getByRole('button', { name: '忽略' }).nth(1).click())
    await expect.element(page.getByRole('button', { name: '恢复' })).toBeVisible()
    await act(async () => page.getByRole('button', { name: '恢复' }).click())
    await fillTextarea('textarea[aria-label="审稿问题"]', '角色离开港口后又在同一场景出现（作者已校正描述）。')
    await act(async () => page.getByRole('button', { name: '新增人工问题' }).click())
    await fillTextarea('textarea[aria-label="审稿问题"]', '第一段结尾必须保留悬念。', 2)
    await fillTextarea('#review-author-guidance', '保留第一段的悬念，不要扩写背景设定。')

    expect(container?.textContent).toContain(RAW_AI_REPORT)
    await act(async () => {
      await page.getByRole('button', { name: '确认审稿清单' }).click()
      await vi.waitFor(() => expect(invoke.mock.calls.some(([channel]) => channel === 'db:review-create')).toBe(true))
    })

    const confirmation = confirmationCreateParams()
    const snapshot = parseHumanConfirmedReviewSnapshot(confirmation.content)
    expect(confirmation).toMatchObject({ baseDraftId: 1, reviewIndex: 2 })
    expect(confirmation.expectedSource).toEqual(REVIEW_SOURCE_DRAFT)
    expect(snapshot).toMatchObject({
      sourceReviewId: 41,
      sourceDraft: REVIEW_SOURCE_DRAFT,
      authorGuidance: '保留第一段的悬念，不要扩写背景设定。',
    })
    expect(snapshot?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        description: '角色离开港口后又在同一场景出现（作者已校正描述）。',
        quote: '他仍站在港口的灯塔下。',
        stableFactKey: 'fact:1234567890abcdef',
        sourceChapter: 7,
        decision: 'apply',
        origin: 'ai',
      }),
      expect.objectContaining({
        description: '场景切换过于突然。',
        decision: 'apply',
        origin: 'ai',
      }),
      expect.objectContaining({
        description: '第一段结尾必须保留悬念。',
        decision: 'apply',
        origin: 'author',
      }),
    ]))
    expect(container?.textContent).toContain(RAW_AI_REPORT)

    await act(async () => {
      await page.getByRole('button', { name: '按确认意见修稿' }).click()
      await vi.waitFor(() => expect(selectedModel().value).toBe('glm'))
    })
    await changeSelect(selectedModel(), 'grok')
    await act(async () => {
      await page.getByRole('button', { name: '开始修稿' }).click()
      await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce())
    })
    expect(startWorkflow.mock.calls[0]?.[0]).toMatchObject({
      generationModelId: 'grok',
      projectPath: PROJECT_PATH,
    })
    expect(useLLMStore.getState().defaultModelId).toBe('glm')
    expect(setDefaultModel).not.toHaveBeenCalled()
    expect(container?.textContent).toContain(RAW_AI_REPORT)
  })

  it('rejects confirmation when the draft no longer matches the AI review generation source', async () => {
    installIpc(96, `${REVIEW_SOURCE_DRAFT.content}作者后来新增的正文。`)
    await renderReport()

    await act(async () => page.getByRole('button', { name: '确认审稿清单' }).click())

    await expect.element(page.getByRole('alert')).toHaveTextContent('源草稿已变化')
    expect(invoke.mock.calls.some(([channel]) => channel === 'db:review-create')).toBe(false)
  })

  it('rejects starting review refinement when the draft changes after confirmation', async () => {
    const ipc = installIpc(97)
    await renderReport()
    await act(async () => {
      await page.getByRole('button', { name: '确认审稿清单' }).click()
      await vi.waitFor(() => expect(invoke.mock.calls.some(([channel]) => channel === 'db:review-create')).toBe(true))
    })
    ipc.setDraftContent(`${REVIEW_SOURCE_DRAFT.content}确认后保存的新正文。`)

    await act(async () => page.getByRole('button', { name: '按确认意见修稿' }).click())
    await act(async () => page.getByRole('button', { name: '开始修稿' }).click())

    await expect.element(page.getByRole('alert')).toHaveTextContent('源草稿已变化')
    expect(startWorkflow).not.toHaveBeenCalled()
  })

  it('previews the confirmed checklist in the project writing language before starting revision', async () => {
    installIpc(94)
    useLocaleStore.setState({ locale: 'en-US' })
    useProjectStore.setState({ currentProject: project('en-US') })
    await renderReport()
    await fillTextarea('#review-author-guidance', 'Preserve the opening suspense.')

    await act(async () => {
      await page.getByRole('button', { name: 'Confirm review checklist' }).click()
      await vi.waitFor(() => expect(invoke.mock.calls.some(([channel]) => channel === 'db:review-create')).toBe(true))
    })
    await act(async () => page.getByRole('button', { name: 'Revise from confirmed checklist' }).click())

    await expect.element(page.getByText('Confirmed guidance sent to revision')).toBeVisible()
    expect(document.body.textContent).toContain('[Confirmed review items included in this revision]')
    expect(document.body.textContent).toContain('[Confirmed author guidance]')
    expect(document.body.textContent).not.toContain('【已确认纳入本次修稿的审稿项】')
    expect(document.body.textContent).not.toContain('【作者补充修稿指导】')
  })

  it('does not open a revision workflow when every item is ignored, even if author guidance is non-empty', async () => {
    installIpc(92)
    await renderReport()

    await act(async () => page.getByRole('button', { name: '忽略' }).nth(0).click())
    await act(async () => page.getByRole('button', { name: '忽略' }).nth(0).click())
    await fillTextarea('#review-author-guidance', '这条总体说明不能单独启动模型。')
    await act(async () => {
      await page.getByRole('button', { name: '确认审稿清单' }).click()
      await vi.waitFor(() => expect(invoke.mock.calls.some(([channel]) => channel === 'db:review-create')).toBe(true))
    })

    const snapshot = parseHumanConfirmedReviewSnapshot(confirmationCreateParams().content)
    expect(snapshot?.items.every(item => item.decision === 'ignore')).toBe(true)
    expect(snapshot?.authorGuidance).toBe('这条总体说明不能单独启动模型。')

    await act(async () => {
      await page.getByRole('button', { name: '按确认意见修稿' }).click()
      await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('未纳入任何审稿项'))
    })
    await expect.element(page.getByRole('alert')).toHaveTextContent('未纳入任何审稿项')
    expect(document.getElementById('review-revision-model')).toBeNull()
    expect(startWorkflow).not.toHaveBeenCalled()
    expect(container?.textContent).toContain(RAW_AI_REPORT)
  })

  it('makes a newly added author issue explicitly editable and blocks an empty entry from being silently dropped', async () => {
    installIpc(93)
    await renderReport()

    await act(async () => page.getByRole('button', { name: '新增人工问题' }).click())
    const issueFields = document.querySelectorAll<HTMLTextAreaElement>('textarea[aria-label="审稿问题"]')
    const authorIssue = issueFields.item(2)
    if (!authorIssue) throw new Error('Missing newly added author issue field')

    expect(authorIssue.placeholder).toBe('请填写需要纳入本次修稿的具体问题')
    expect(authorIssue.getAttribute('aria-invalid')).toBe('true')
    expect(container?.textContent).toContain('请填写具体问题，或移除这一项。')

    await act(async () => page.getByRole('button', { name: '确认审稿清单' }).click())
    await expect.element(page.getByRole('alert')).toHaveTextContent('请填写或移除空白的人工问题后再确认')
    expect(invoke.mock.calls.some(([channel]) => channel === 'db:review-create')).toBe(false)
  })

  it('restores persisted confirmation after leaving and returning', async () => {
    const ipc = installIpc(95)
    await renderReport()
    await fillTextarea('textarea[aria-label="审稿问题"]', '角色位置冲突（作者确认版本）。')
    await fillTextarea('#review-author-guidance', '只修复已确认的位置冲突。')

    await act(async () => {
      await page.getByRole('button', { name: '确认审稿清单' }).click()
      await vi.waitFor(() => expect(invoke.mock.calls.some(([channel]) => channel === 'db:review-create')).toBe(true))
    })
    const persistedContent = confirmationCreateParams().content
    expect(parseHumanConfirmedReviewSnapshot(persistedContent)?.sourceReviewId).toBe(41)

    await act(async () => root?.unmount())
    container?.remove()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    ipc.setLatestReview(persistedContent)
    invoke.mockClear()

    await renderReport()

    await act(async () => {
      await vi.waitFor(() => {
        expect(invoke.mock.calls.some(([channel]) => channel === 'db:review-get-latest')).toBe(true)
      })
    })
    await expect.element(page.getByRole('button', { name: '按确认意见修稿' })).toBeVisible()
    await act(async () => page.getByRole('button', { name: '编辑清单' }).click())
    expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="审稿问题"]')?.value)
      .toBe('角色位置冲突（作者确认版本）。')
    expect(document.querySelector<HTMLTextAreaElement>('#review-author-guidance')?.value)
      .toBe('只修复已确认的位置冲突。')
    expect(container?.textContent).toContain(RAW_AI_REPORT)
  })
})
