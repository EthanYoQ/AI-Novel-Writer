import { expect, it } from 'vitest'
import { runFailure } from '../run-failure'
import { PLOT_OUTLINE_RESUME_ERROR_CODE, PLOT_OUTLINE_SOURCE_CHANGED_ERROR_CODE } from '../../../services/workflows/commands/architecture.command'
import type { WorkflowRun } from '../../../stores/workflow-store'

const failedOutline = (errorCode: string, error: string) => ({
  id: '运行', title: '生成故事架构', type: 'generate_architecture', status: 'failed', uiLocale: 'zh-CN', writingLanguage: 'zh-CN',
  projectPath: 'C:/projects/失乐园', projectSession: null, currentStepIndex: 0, error, errorCode,
  steps: [{ id: 'synopsis', name: '情节大纲', description: '', status: 'failed', logs: [], error, errorCode }],
}) as unknown as WorkflowRun

it('来源在途中变了的大纲失败：给出去架构页重新生成的入口，不提供必然被拒的断点续写', () => {
  const failure = runFailure(failedOutline(PLOT_OUTLINE_SOURCE_CHANGED_ERROR_CODE, '生成途中模型设置被修改……'))
  expect(failure.presentation.reason).toBe('生成途中模型设置被修改……')
  expect(failure.canRestartOutline).toBe(true)
  expect(failure.canResumeOutline).toBe(false)
})

it('输出长度中断的大纲失败仍走断点续写', () => {
  const failure = runFailure(failedOutline(PLOT_OUTLINE_RESUME_ERROR_CODE, '输出被截断'))
  expect(failure.canResumeOutline).toBe(true)
  expect(failure.canRestartOutline).toBe(false)
})
