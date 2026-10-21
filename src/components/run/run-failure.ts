import { useState } from 'react'
import { displayedErrorMessage } from '../../i18n/app-errors'
import { PLOT_OUTLINE_RESUME_ERROR_CODE, PLOT_OUTLINE_SOURCE_CHANGED_ERROR_CODE } from '../../services/workflows/commands/architecture.command'
import { launchCreativeWorkflow } from '../../services/workflows/creative-workflow-launcher'
import { projectSessionContextFromProject, sameProjectPathKey, sameProjectSessionContext } from '../../shared/project-session-context'
import { navigate } from '../../stores/navigation/navigation-intents'
import { useProjectStore } from '../../stores/project-store'
import type { WorkflowRun } from '../../stores/workflow-store'
import { toast } from '../ui/Toast'
import { presentWorkflowFailure, type WorkflowFailurePresentation } from '../panels/ai-output-failure-presentation'

/** 运行侧页为一次失败的运行显示的内容：标题、原因、错误码，以及能接着做什么。 */
export interface RunFailure {
  title: string
  errorCode?: string
  presentation: WorkflowFailurePresentation
  /** 情节大纲生成被截断且已完成部分已保存：可以从断点续写。 */
  canResumeOutline: boolean
  /** 情节大纲途中来源被改：同一运行不能恢复，只能到架构页从本批起始章重新生成。 */
  canRestartOutline: boolean
}

export function runFailure(run: WorkflowRun): RunFailure {
  const failedStep = run.steps.find(step => step.status === 'failed')
  const currentStep = run.steps[run.currentStepIndex] ?? run.steps[0]
  const failedWith = (code: string) => run.errorCode === code || failedStep?.errorCode === code
  return {
    title: run.title,
    errorCode: run.errorCode ?? failedStep?.errorCode,
    presentation: presentWorkflowFailure(
      run.failureCode ?? currentStep?.failureCode,
      run.error || currentStep?.error,
      run.uiLocale,
      run.type === 'chapter_creation' && run.chapterWordsTarget !== undefined && !(currentStep?.result || '').trim(),
      run.promptBudgetReport ?? currentStep?.promptBudgetReport,
      failedStep?.generationActivity ?? currentStep?.generationActivity,
    ),
    canResumeOutline: failedWith(PLOT_OUTLINE_RESUME_ERROR_CODE),
    canRestartOutline: failedWith(PLOT_OUTLINE_SOURCE_CHANGED_ERROR_CODE),
  }
}

/** 运行属于当前打开的这次项目会话；失败提示里的动作只对它生效。 */
export function isCurrentSessionRun(run: Pick<WorkflowRun, 'projectPath' | 'projectSession'>): boolean {
  const project = useProjectStore.getState().currentProject
  return sameProjectPathKey(run.projectPath, project?.path)
    && sameProjectSessionContext(run.projectSession, projectSessionContextFromProject(project))
}

export function openNovelConfigurationFor(run: WorkflowRun): void {
  if (isCurrentSessionRun(run)) navigate({ kind: 'stage', stage: 'setup' })
}

export function openArchitectureFor(run: WorkflowRun): void {
  if (isCurrentSessionRun(run)) navigate({ kind: 'stage', stage: 'architecture' })
}

/** 从断点续写情节大纲：已完成部分已存为不完整大纲，这次让模型接着末尾写。 */
export function useResumePlotOutline(run: WorkflowRun) {
  const [resuming, setResuming] = useState(false)
  const resume = async () => {
    if (resuming || !run.projectSession || !isCurrentSessionRun(run)) return
    setResuming(true)
    try {
      await launchCreativeWorkflow({ workflow: 'generate_architecture', selectedSteps: ['synopsis'], resumeSynopsis: true }, run.projectSession)
    } catch (error) {
      const detail = displayedErrorMessage(run.uiLocale, error)
      toast.error(run.uiLocale === 'en-US' ? `Failed to start the continuation: ${detail}` : `续写启动失败：${detail}`)
    } finally {
      setResuming(false)
    }
  }
  return { resuming, resume }
}
