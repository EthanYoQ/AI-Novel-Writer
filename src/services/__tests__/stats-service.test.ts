import { describe, expect, it } from 'vitest'

import type { WorkflowRun } from '../../stores/workflow-store'
import { diagnosticWorkflowForCall, type LLMCallRecord } from '../stats-service'

const call: LLMCallRecord = {
  id: 9,
  modelId: '2f491640-c201-4c6e-922b-3103e8c2c5f7',
  modelName: 'Grok 4',
  purpose: 'chapter-draft',
  promptTokens: 20,
  completionTokens: 40,
  totalTokens: 60,
  durationMs: 500,
  success: false,
  finishReason: 'content_filter',
  createdAt: '2026-08-29T10:00:00.000Z',
}

function failedRun(id: string): WorkflowRun {
  const promptBudgetReport = {
    totalUtf8Bytes: 1024,
    limitUtf8Bytes: 2048,
    reservedOutputTokens: 512,
    sections: [{ sectionName: 'continuity', utf8Bytes: 320 }],
    modelId: '2f491640-c201-4c6e-922b-3103e8c2c5f7',
    errorCode: 'PROMPT_BUDGET_EXHAUSTED' as const,
  }
  return {
    id,
    projectPath: 'C:\\novels\\safe-project',
    projectSession: null,
    writingLanguage: 'zh-CN',
    uiLocale: 'en-US',
    type: 'chapter_creation',
    title: 'Chapter 1',
    status: 'failed',
    steps: [{
      id: `${id}-step`,
      name: 'Generate draft',
      description: 'Generate',
      status: 'failed',
      failureCode: 'content_filter',
      promptBudgetReport,
      startedAt: '2026-08-29T09:59:58.500Z',
      completedAt: '2026-08-29T10:00:00.500Z',
      logs: [],
    }],
    currentStepIndex: 0,
    createdAt: '2026-08-29T09:59:58.000Z',
    completedAt: '2026-08-29T10:00:00.500Z',
    failureCode: 'content_filter',
    promptBudgetReport,
  }
}

describe('safe diagnostic workflow association', () => {
  it('uses one project-local step whose interval contains the recorded model call', () => {
    expect(diagnosticWorkflowForCall(call, [failedRun('run-1')], 'C:\\novels\\safe-project'))
      .toEqual(expect.objectContaining({
        status: 'failed',
        failureCode: 'content_filter',
        stepName: 'Generate draft',
        stepStatus: 'failed',
        stepFailureCode: 'content_filter',
        finishReason: 'content_filter',
        promptBudgetReport: expect.objectContaining({ totalUtf8Bytes: 1024 }),
      }))
  })

  it('fails closed when two workflow steps overlap the same recorded call', () => {
    expect(diagnosticWorkflowForCall(
      call,
      [failedRun('run-1'), failedRun('run-2')],
      'C:\\novels\\safe-project',
    )).toEqual({ finishReason: 'content_filter' })
  })
})
