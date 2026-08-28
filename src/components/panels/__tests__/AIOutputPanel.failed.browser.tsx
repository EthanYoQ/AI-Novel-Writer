import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { useWorkflowStore, type WorkflowRun } from '../../../stores/workflow-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useEditorStore } from '../../../stores/editor-store'
import AIOutputPanel from '../AIOutputPanel'

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

function failedPromptBudget(locale: 'zh-CN' | 'en-US'): WorkflowRun {
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
    steps: [{
      id: 'character-manifest',
      name: locale === 'zh-CN' ? '角色图谱' : 'Character graph',
      description: '',
      status: 'failed',
      error: locale === 'zh-CN'
        ? '总占用 13000 UTF-8 字节，上限 12000 字节；主要占用：全局指导。'
        : 'Total usage is 13000 UTF-8 bytes with a 12000-byte limit; top contributor: Global guidance.',
      failureCode: 'prompt_budget_exhausted',
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
})
