import { useProjectStore } from '../../../stores/project-store'
import type { AgentExecutionContext } from '../tool-registry'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import type { Locale } from '../../../i18n/types'
import {
  projectSessionContextFromProject,
  sameProjectSessionContext,
} from '../../../shared/project-session-context'
import {
  DEFAULT_WRITING_LANGUAGE,
  resolveWritingLanguage,
  writingLanguageText,
} from '../../../shared/writing-language'

export const PROJECT_CHANGED_ERROR = '当前项目已切换，本次工具结果已丢弃'
export const PROJECT_CHANGED_ERROR_EN = 'The current project changed, so this tool result was discarded'
export const AGENT_TOOL_CANCELLED_ERROR = '本次工具操作已在提交前取消'
export const AGENT_TOOL_CANCELLED_ERROR_EN = 'This tool operation was cancelled before commit'

export function agentToolText(
  context: AgentExecutionContext | undefined,
  zhCN: string,
  enUS: string,
): string {
  return writingLanguageText(
    context?.writingLanguage ?? DEFAULT_WRITING_LANGUAGE,
    zhCN,
    enUS,
  )
}

export function createAgentExecutionContext(
  selectedModelId?: string | null,
  uiLocale: Locale = DEFAULT_WRITING_LANGUAGE,
): AgentExecutionContext {
  const frozenModelId = selectedModelId?.trim() || null
  const project = useProjectStore.getState().currentProject
  return Object.freeze({
    projectSession: projectSessionContextFromProject(project),
    selectedModelId: frozenModelId,
    uiLocale,
    writingLanguage: project
      ? resolveWritingLanguage(project.novelConfig.writingLanguage)
      : uiLocale,
  })
}

export function requireAgentProjectSession(
  context?: AgentExecutionContext,
): ProjectSessionContext {
  const session = context?.projectSession
  if (!session) {
    throw new Error(agentToolText(
      context,
      '缺少冻结项目会话，已拒绝工具项目访问',
      'No frozen project session is available; project tool access was denied',
    ))
  }
  return session
}

/** Resolve the project only after proving it is the frozen agent session. */
export function requireAgentProject(
  context?: AgentExecutionContext,
): { project: NonNullable<ReturnType<typeof useProjectStore.getState>['currentProject']>; projectSession: ProjectSessionContext } {
  const projectSession = requireAgentProjectSession(context)
  const project = useProjectStore.getState().currentProject
  if (!project || !sameProjectSessionContext(projectSession, projectSessionContextFromProject(project))) {
    throw new Error(agentToolText(
      context,
      PROJECT_CHANGED_ERROR,
      PROJECT_CHANGED_ERROR_EN,
    ))
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
    throw new Error(agentToolText(
      context,
      PROJECT_CHANGED_ERROR,
      PROJECT_CHANGED_ERROR_EN,
    ))
  }
}

/** Last renderer-side gate before an Agent tool starts an observable side effect. */
export function assertAgentToolActive(context?: AgentExecutionContext): void {
  if (context?.abortSignal?.aborted) {
    throw new Error(agentToolText(
      context,
      AGENT_TOOL_CANCELLED_ERROR,
      AGENT_TOOL_CANCELLED_ERROR_EN,
    ))
  }
  assertAgentProjectCurrent(context)
}
