import { errorCodeOf } from '../../i18n/app-errors'

/**
 * 执行器看到作者的取消后停下时抛出；消息照常给作者看，不带错误码。
 * notice 为真时，消息还交代了停在哪里、保住了什么，留在已取消的那一步上。
 */
export class WorkflowCancelledError extends Error {
  constructor(message: string, readonly notice = false) {
    super(message)
  }
}

/** 仓库里所有取消码都是 CANCELLED 或以 _CANCELLED 结尾，例如 GENERATION_WORKFLOW_CANCELLED；模型的结束原因 cancelled 也算。 */
const CANCELLATION_CODE = /^(?:[A-Z0-9]+_)*CANCELLED$/u

function isCancellationCode(code: unknown): boolean {
  return typeof code === 'string' && CANCELLATION_CODE.test(code.trim().toUpperCase())
}

/**
 * 这次中止是不是取消本身造成的。认不出的错误一律不算，取消窗口里的真实错误才能照常记失败。
 * 包装层的 catch 只凭它决定能否换成 WorkflowCancelledError；取消标记已置位只能停止重试，不能改写错误。
 */
export function isWorkflowCancellation(error: unknown): boolean {
  if (error instanceof WorkflowCancelledError) return true
  const carried = typeof error === 'object' && error !== null ? error as { code?: unknown; failureCode?: unknown } : {}
  return [carried.code, carried.failureCode, errorCodeOf(error)].some(isCancellationCode)
}
