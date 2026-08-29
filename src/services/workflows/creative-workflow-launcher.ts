import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../shared/project-session-context'
import { randomUUID } from '../../utils/id'
import { useProjectStore } from '../../stores/project-store'
import {
  useWorkflowStore,
  workflowResourceConflictMessage,
  type WorkflowDefinition,
  type WorkflowStatus,
} from '../../stores/workflow-store'
import { useLocaleStore } from '../../stores/locale-store'
import { ipc } from '../ipc-client'
import {
  guardArchitectureGeneration,
  guardChapterWriting,
  guardDirectoryGeneration,
  type GuardResult,
} from '../workflow-guards'
import { createArchitectureWorkflow, type ArchitectureWorkflowParams } from './architecture-workflow'
import { createChapterWorkflow } from './chapter-workflow'
import { createDirectoryWorkflow, type DirectoryWorkflowParams } from './directory-workflow'
import { normalizeChapterWordsTarget } from './chapter-creation-parameters'

export type CreativeWorkflowName =
  | 'generate_draft'
  | 'review'
  | 'refine'
  | 'finalize'
  | 'generate_blueprint'
  | 'generate_architecture'

export type CreativeIntent =
  | { workflow: 'generate_draft'; chapterNumber: number }
  | { workflow: 'generate_architecture'; selectedSteps?: ArchitectureWorkflowParams['selectedSteps']; stepGuidance?: Record<string, string> }
  | { workflow: 'generate_blueprint'; params?: DirectoryWorkflowParams }
  | { workflow: 'review' | 'refine' | 'finalize'; chapterNumber: number }

export interface CreativeWorkflowLaunchReceipt {
  readonly accepted: true
  readonly workflow: CreativeWorkflowName
  readonly projectPath: string
  readonly projectSession: ProjectSessionContext
  readonly runId: string
  readonly status: WorkflowStatus
}

/**
 * A renderer-owned model choice may accompany an Agent-originated draft run.
 * It is intentionally not part of CreativeIntent, which is built from LLM
 * tool arguments.
 */
export interface CreativeWorkflowLaunchOptions {
  readonly generationModelId?: string
}

function requireGuardAccepted(result: GuardResult): void {
  if (!result.ok) throw new Error(result.message ?? '创作工作流前置条件未满足')
}

async function guardIntent(
  intent: CreativeIntent,
  projectSession: ProjectSessionContext,
): Promise<void> {
  if (intent.workflow === 'generate_architecture') {
    requireGuardAccepted(guardArchitectureGeneration(projectSession.projectPath, projectSession))
    return
  }
  if (intent.workflow === 'generate_blueprint') {
    requireGuardAccepted(await guardDirectoryGeneration(projectSession.projectPath, projectSession))
    return
  }
  if (intent.workflow === 'generate_draft') {
    requireGuardAccepted(await guardChapterWriting(intent.chapterNumber, projectSession.projectPath, projectSession))
  }
}

function currentProjectFor(projectSession: ProjectSessionContext) {
  const project = useProjectStore.getState().currentProject
  if (!project || !sameProjectSessionContext(projectSession, projectSessionContextFromProject(project))) {
    throw new Error('当前项目会话已切换，工作流未启动')
  }
  return project
}

async function definitionFor(
  intent: CreativeIntent,
  projectSession: ProjectSessionContext,
  generationModelId?: string,
): Promise<WorkflowDefinition> {
  const project = currentProjectFor(projectSession)

  if (intent.workflow === 'generate_architecture') {
    return createArchitectureWorkflow({
      projectPath: project.path,
      projectSession,
      selectedSteps: intent.selectedSteps,
      stepGuidance: intent.stepGuidance,
    })
  }
  if (intent.workflow === 'generate_blueprint') {
    return createDirectoryWorkflow(intent.params ?? { mode: 'full' }, project.path, projectSession)
  }
  if (intent.workflow === 'generate_draft') {
    if (!Number.isInteger(intent.chapterNumber) || intent.chapterNumber < 1) {
      throw new Error('写稿需要有效的 chapter_number（从 1 开始）')
    }
    const blueprint = await ipc.invokeWithProjectSession(
      projectSession,
      'db:blueprint-get',
      intent.chapterNumber,
      project.path,
    )
    currentProjectFor(projectSession)
    if (!blueprint) {
      throw new Error(`第 ${intent.chapterNumber} 章蓝图不存在；请先运行 generate_blueprint 工作流`)
    }
    return createChapterWorkflow({
      projectPath: project.path,
      chapterNumber: blueprint.chapterNumber,
      title: blueprint.title,
      role: blueprint.role,
      purpose: blueprint.purpose,
      characters: blueprint.characters,
      keyEvents: blueprint.keyEvents,
      suspenseHook: blueprint.suspenseHook,
      userGuidance: blueprint.userGuidance,
      wordsTarget: normalizeChapterWordsTarget(project.novelConfig.wordsPerChapter),
    }, projectSession, { generationModelId })
  }

  throw new Error(`${intent.workflow} 需要明确的草稿 ID 和不可变正文快照；请先打开目标草稿后从编辑器启动`)
}

/** The sole seam for turning a creative intent into an observable workflow run. */
export async function launchCreativeWorkflow(
  intent: CreativeIntent,
  projectSession: ProjectSessionContext,
  options: CreativeWorkflowLaunchOptions = {},
): Promise<CreativeWorkflowLaunchReceipt> {
  const generationModelId = options.generationModelId?.trim() || undefined
  currentProjectFor(projectSession)
  await guardIntent(intent, projectSession)
  currentProjectFor(projectSession)
  const definition = await definitionFor(
    intent,
    Object.freeze({ ...projectSession }),
    generationModelId,
  )
  currentProjectFor(projectSession)

  const conflict = useWorkflowStore.getState().getResourceConflict(definition)
  if (conflict) {
    throw new Error(workflowResourceConflictMessage(useLocaleStore.getState().locale, conflict.title))
  }

  const runId = randomUUID()
  const completion = useWorkflowStore.getState().startWorkflow({ ...definition, runId })
  void completion.catch((error) => {
    useWorkflowStore.getState().addLog('error', `[失败] 工作流启动后异常：${String(error)}`)
  })

  const state = useWorkflowStore.getState()
  const registered = state.activeRuns.find(run => run.id === runId)
    ?? state.history.find(run => run.id === runId)
  if (!registered || registered.status === 'failed') {
    throw new Error(registered?.error ?? '工作流未能注册到任务中心，已拒绝报告启动成功')
  }

  return Object.freeze({
    accepted: true,
    workflow: intent.workflow,
    projectPath: registered.projectPath,
    projectSession: Object.freeze({ ...projectSession }),
    runId: registered.id,
    status: registered.status,
  })
}

export const CreativeWorkflowLauncher = Object.freeze({ launch: launchCreativeWorkflow })
