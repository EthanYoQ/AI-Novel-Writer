import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { sameProjectPathKey } from '../../shared/project-session-context'
import type { WorkflowContext } from '../../stores/workflow-store'
import type { WritingLanguage } from '../../shared/writing-language'
import { resolveWritingLanguage } from '../../shared/writing-language'
import type { Locale } from '../../i18n/types'

/**
 * 取出工作流启动时冻结的项目会话。
 *
 * 工作流中的项目 IPC 不能重新向 renderer 的 currentProject 借用租约；
 * 即使路径文字相同，重新打开同一项目也会得到不同的 leaseId。
 */
export function requireWorkflowProjectSession(context: WorkflowContext): ProjectSessionContext {
  const session = context.projectSession
  if (!session || !sameProjectPathKey(session.projectPath, context.projectPath)) {
    throw new Error('工作流缺少匹配的冻结项目会话，已拒绝项目数据访问')
  }
  return session
}

/** Legacy workflows without an explicit snapshot retain the historical Chinese behavior. */
export function workflowWritingLanguage(context: WorkflowContext): WritingLanguage {
  return resolveWritingLanguage(context.writingLanguage)
}

/** Legacy command contexts retain the historical Chinese interface copy. */
export function workflowUiLocale(context: WorkflowContext): Locale {
  return context.uiLocale === 'en-US' ? 'en-US' : 'zh-CN'
}

export function workflowUiText(
  context: WorkflowContext,
  zhCNText: string,
  enUSText: string,
): string {
  return workflowUiLocale(context) === 'en-US' ? enUSText : zhCNText
}
