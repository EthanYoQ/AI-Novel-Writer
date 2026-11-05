import { errorCodeOf } from '../../i18n/app-errors'

/** 执行器看到作者的取消后停下时抛出；消息照常给作者看，不带错误码。 */
export class WorkflowCancelledError extends Error {}

/** 仓库里所有取消码都是 CANCELLED 或以 _CANCELLED 结尾，例如 GENERATION_WORKFLOW_CANCELLED；模型的结束原因 cancelled 也算。 */
const CANCELLATION_CODE = /^(?:[A-Z0-9]+_)*CANCELLED$/u

function isCancellationCode(code: unknown): boolean {
  return typeof code === 'string' && CANCELLATION_CODE.test(code.trim().toUpperCase())
}

/** 这次中止是不是取消本身造成的。认不出的错误一律不算，取消窗口里的真实错误才能照常记失败。 */
export function isWorkflowCancellation(error: unknown): boolean {
  if (error instanceof WorkflowCancelledError) return true
  const carried = typeof error === 'object' && error !== null ? error as { code?: unknown; failureCode?: unknown } : {}
  return [carried.code, carried.failureCode, errorCodeOf(error)].some(isCancellationCode)
}
