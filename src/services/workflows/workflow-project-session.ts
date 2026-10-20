import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { sameProjectPathKey } from '../../shared/project-session-context'
import type { WorkflowContext } from '../../stores/workflow-store'
import type { WritingLanguage } from '../../shared/writing-language'
import type { Locale } from '../../i18n/types'
import { knownAppErrorMessage } from '../../i18n/app-errors'

/**
 * 取出工作流启动时冻结的项目会话。
 *
 * 工作流中的项目 IPC 不能重新向 renderer 的 currentProject 借用租约；
 * 即使路径文字相同，重新打开同一项目也会得到不同的 leaseId。
 */
export function requireWorkflowProjectSession(context: WorkflowContext): ProjectSessionContext {
  const session = context.projectSession
  if (!session || !sameProjectPathKey(session.projectPath, context.projectPath)) {
    throw new Error(workflowUiText(
      context,
      '工作流缺少匹配的冻结项目会话，已拒绝项目数据访问',
      'The workflow is missing a matching frozen project session, so project data access was denied.',
    ))
  }
  return session
}

export function workflowWritingLanguage(context: WorkflowContext): WritingLanguage {
  return context.writingLanguage
}

export function workflowUiLocale(context: WorkflowContext): Locale {
  return context.uiLocale
}

export function workflowUiText(
  context: WorkflowContext,
  zhCNText: string,
  enUSText: string,
): string {
  return workflowUiLocale(context) === 'en-US' ? enUSText : zhCNText
}

const errorCode = /^[A-Z][A-Z0-9_]*$/u

/**
 * 主进程拒绝时只回 String(err)：多是只有中文的原文，也可能是错误码。登记过的码按界面语言说明；
 * 未登记的码原样附上供反馈定位，并挂在 code 上；其余原文只附在中文说明后面，英文界面只给英文说明。
 * 只用到界面语言：没有运行上下文的调用方传 { uiLocale }。
 */
export function workflowMainProcessError(
  context: Pick<WorkflowContext, 'uiLocale'>,
  error: unknown,
  zhCNSummary: string,
  enUSSummary: string,
): Error {
  const english = context.uiLocale === 'en-US'
  const summary = english ? enUSSummary : zhCNSummary
  const raw = typeof error === 'string' ? error.trim().replace(/^Error: /u, '') : ''
  if (!raw) return new Error(summary)
  const code = errorCode.test(raw) ? raw : undefined
  const reason = knownAppErrorMessage(context.uiLocale, raw) ?? (code || !english ? raw : undefined)
  const failure = new Error(reason ? `${summary}${english ? ' ' : '：'}${reason}` : summary)
  return code ? Object.assign(failure, { code }) : failure
}
