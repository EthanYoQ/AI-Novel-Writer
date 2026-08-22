import { useProjectStore } from '../../../stores/project-store'
import type { AgentExecutionContext } from '../tool-registry'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import {
  projectSessionContextFromProject,
  sameProjectSessionContext,
} from '../../../shared/project-session-context'

export const PROJECT_CHANGED_ERROR = '当前项目已切换，本次工具结果已丢弃'

export function createAgentExecutionContext(selectedModelId?: string | null): AgentExecutionContext {
  const frozenModelId = selectedModelId?.trim() || null
  return Object.freeze({
    projectSession: projectSessionContextFromProject(useProjectStore.getState().currentProject),
    selectedModelId: frozenModelId,
  })
}

export function requireAgentProjectSession(
  context?: AgentExecutionContext,
): ProjectSessionContext {
  const session = context?.projectSession
  if (!session) throw new Error('缺少冻结项目会话，已拒绝工具项目访问')
  return session
}

/** Resolve the project only after proving it is the frozen agent session. */
export function requireAgentProject(
  context?: AgentExecutionContext,
): { project: NonNullable<ReturnType<typeof useProjectStore.getState>['currentProject']>; projectSession: ProjectSessionContext } {
  const projectSession = requireAgentProjectSession(context)
  const project = useProjectStore.getState().currentProject
  if (!project || !sameProjectSessionContext(projectSession, projectSessionContextFromProject(project))) {
    throw new Error(PROJECT_CHANGED_ERROR)
  }
  return { project, projectSession }
}

export function isAgentProjectCurrent(context?: AgentExecutionContext): boolean {
  const session = context?.projectSession
  return !!session && sameProjectSessionContext(
    session,
    projectSessionContextFromProject(useProjectStore.getState().currentProject),
  )
}

export function assertAgentProjectCurrent(context?: AgentExecutionContext): void {
  if (!isAgentProjectCurrent(context)) {
    throw new Error(PROJECT_CHANGED_ERROR)
  }
}
