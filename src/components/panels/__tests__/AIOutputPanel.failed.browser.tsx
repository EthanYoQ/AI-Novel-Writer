import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { useWorkflowStore, type WorkflowRun } from '../../../stores/workflow-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useEditorStore } from '../../../stores/editor-store'
import AIOutputPanel from '../AIOutputPanel'
import type { PromptBudgetReport } from '../../../services/generation/generation-harness'

const originalWorkflowState = useWorkflowStore.getState()
const originalLocaleState = useLocaleStore.getState()
const originalProjectState = useProjectStore.getState()
const originalEditorState = useEditorStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined

function failedChapterDraft(): WorkflowRun {
  return {
    id: 'failed-chapter-draft',
    projectPath: 'C:\\novels\\failed-chapter-draft',
    projectSession: {
      projectId: 'failed-chapter-draft',
      leaseId: 'failed-chapter-draft-lease',
      projectPath: 'C:\\novels\\failed-chapter-draft',
    },
    writingLanguage: 'zh-CN',
    uiLocale: 'zh-CN',
    type: 'chapter_creation',
    title: '写稿 - 第 1 章：初入魔窟',
    status: 'failed',
    currentStepIndex: 0,
    createdAt: '2026-08-22T12:00:00.000Z',
    completedAt: '2026-08-22T12:00:02.000Z',
    error: 'AI 输出因内容限制而未完成，结果未被保存。',
    failureCode: 'content_filter',
    steps: [{
      id: 'chapter-draft-step',
      name: '写稿',
      description: '根据章节蓝图生成正文',
      status: 'failed',
      error: 'AI 输出因内容限制而未完成，结果未被保存。',
      failureCode: 'content_filter',
      logs: [],
    }],
  }
}

function promptBudgetReport(sectionName: string): PromptBudgetReport {
  return {
    totalUtf8Bytes: 13_000,
    limitUtf8Bytes: 12_000,
    reservedOutputTokens: 8_192,
    sections: [
      { sectionName, utf8Bytes: 12_000 },
      { sectionName: 'prompt-overhead', utf8Bytes: 1_000 },
    ],
    modelId: 'model-a',
    errorCode: 'PROMPT_BUDGET_EXHAUSTED',
  }
}

function failedPromptBudget(
  locale: 'zh-CN' | 'en-US',
  sectionName = 'global-guidance',
): WorkflowRun {
  return {
    id: `failed-prompt-budget-${locale}`,
    projectPath: 'C:\\novels\\prompt-budget',
    projectSession: {
      projectId: 'prompt-budget',
      leaseId: 'prompt-budget-lease',
      projectPath: 'C:\\novels\\prompt-budget',
    },
    writingLanguage: locale,
    uiLocale: locale,
    type: 'architecture_generation',
    title: locale === 'zh-CN' ? '角色图谱生成' : 'Character graph generation',
    status: 'failed',
    currentStepIndex: 0,
    createdAt: '2026-08-28T12:00:00.000Z',
    completedAt: '2026-08-28T12:00:01.000Z',
    error: locale === 'zh-CN'
      ? '总占用 13000 UTF-8 字节，上限 12000 字节；主要占用：全局指导。'
      : 'Total usage is 13000 UTF-8 bytes with a 12000-byte limit; top contributor: Global guidance.',
    failureCode: 'prompt_budget_exhausted',
    promptBudgetReport: promptBudgetReport(sectionName),
    steps: [{
      id: 'character-manifest',
      name: locale === 'zh-CN' ? '角色图谱' : 'Character graph',
      description: '',
      status: 'failed',
      error: locale === 'zh-CN'
        ? '总占用 13000 UTF-8 字节，上限 12000 字节；主要占用：全局指导。'
        : 'Total usage is 13000 UTF-8 bytes with a 12000-byte limit; top contributor: Global guidance.',
      failureCode: 'prompt_budget_exhausted',
      promptBudgetReport: promptBudgetReport(sectionName),
      logs: [],
    }],
  }
}

beforeEach(() => {
  useWorkflowStore.setState({
    activeRuns: [],
    history: [failedChapterDraft()],
    globalLogs: [],
    waitingRuns: {},
    currentRun: null,
    waitingForConfirm: false,
    waitingAfterStepIndex: -1,
  })
  useProjectStore.setState({
    currentProject: {
      id: 'prompt-budget',
      name: 'Prompt budget',
      path: 'C:\\novels\\prompt-budget',
      sessionLease: 'prompt-budget-lease',
      novelConfig: {},
    } as never,
  })
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  useWorkflowStore.setState(originalWorkflowState)
  useLocaleStore.setState(originalLocaleState)
  useProjectStore.setState(originalProjectState)
  useEditorStore.setState(originalEditorState)
})

describe('AIOutputPanel failed chapter draft', () => {
  it('explains a failed generation and confirms that no draft or manuscript was saved', async () => {
    await act(async () => {
      root?.render(<AIOutputPanel />)
    })

    const failedRun = Array.from(container?.querySelectorAll('button') ?? [])
      .find(button => button.textContent?.includes('第 1 章：初入魔窟'))
    expect(failedRun).toBeDefined()

    await act(async () => failedRun?.click())

    expect(container?.textContent).toContain('模型的内容安全策略拦截了这次输出。')
    expect(container?.textContent).toContain('本次未保存草稿或正文章节')
  })
})

describe('AIOutputPanel prompt budget failure', () => {
  it.each([
    ['zh-CN', '提示词预算不足', '打开小说配置'],
    ['en-US', 'Prompt budget is insufficient', 'Open novel configuration'],
  ] as const)('shows a %s actionable adjustment entry', async (locale, heading, actionLabel) => {
    useLocaleStore.setState({ locale })
    useWorkflowStore.setState({ history: [failedPromptBudget(locale)] })
    await act(async () => {
      root?.render(<AIOutputPanel />)
    })

    const failedRun = Array.from(container?.querySelectorAll('button') ?? [])
      .find(button => button.textContent?.includes(locale === 'zh-CN' ? '角色图谱生成' : 'graph generation'))
    expect(failedRun).toBeDefined()
    await act(async () => failedRun?.click())

    expect(container?.textContent).toContain(heading)
    const action = Array.from(container?.querySelectorAll('button') ?? [])
      .find(button => button.textContent?.includes(actionLabel))
    expect(action).toBeDefined()
    await act(async () => action?.click())

    expect(useEditorStore.getState().tabs).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'config', projectKey: 'C:\\novels\\prompt-budget' }),
    ]))
  })

  it.each([
    ['zh-CN', '请返回该生成步骤，缩短步骤指导后重试。', '本次被预算预检阻止的请求未发送，未产生额外模型尝试或消费。', '打开小说配置'],
    ['en-US', 'Return to that generation step, shorten its step guidance, and try again.', 'The request blocked by this budget preflight was not sent and caused no additional model attempt or consumption.', 'Open novel configuration'],
  ] as const)('shows accurate %s guidance without a configuration action for a non-configuration section', async (
    locale,
    guidance,
    persistence,
    actionLabel,
  ) => {
    useLocaleStore.setState({ locale })
    useWorkflowStore.setState({ history: [failedPromptBudget(locale, 'step-guidance')] })
    await act(async () => {
      root?.render(<AIOutputPanel />)
    })

    const failedRun = Array.from(container?.querySelectorAll('button') ?? [])
      .find(button => button.textContent?.includes(locale === 'zh-CN' ? '角色图谱生成' : 'graph generation'))
    await act(async () => failedRun?.click())

    expect(container?.textContent).toContain(guidance)
    expect(container?.textContent).toContain(persistence)
    expect(Array.from(container?.querySelectorAll('button') ?? [])
      .some(button => button.textContent?.includes(actionLabel))).toBe(false)
  })

  it('freezes the run locale and disables its project action after the current project session changes', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    useWorkflowStore.setState({ history: [failedPromptBudget('zh-CN')] })
    useProjectStore.setState({
      currentProject: {
        id: 'other-project',
        name: 'Other project',
        path: 'C:\\novels\\other-project',
        sessionLease: 'other-project-lease',
        novelConfig: {},
      } as never,
    })
    await act(async () => {
      root?.render(<AIOutputPanel />)
    })

    const failedRun = Array.from(container?.querySelectorAll('button') ?? [])
      .find(button => button.textContent?.includes('角色图谱生成'))
    await act(async () => failedRun?.click())

    expect(container?.textContent).toContain('提示词预算不足')
    expect(container?.textContent).not.toContain('Prompt budget is insufficient')
    expect(container?.textContent).toContain('此结果属于另一项目会话。请切回该项目后再打开小说配置。')
    const action = Array.from(container?.querySelectorAll('button') ?? [])
      .find(button => button.textContent?.includes('打开小说配置'))
    expect(action).toBeDisabled()

    await act(async () => action?.click())
    expect(useEditorStore.getState().tabs).toEqual([])
  })
})
