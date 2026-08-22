import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { useWorkflowStore, type WorkflowRun } from '../../../stores/workflow-store'
import AIOutputPanel from '../AIOutputPanel'

const originalWorkflowState = useWorkflowStore.getState()

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
