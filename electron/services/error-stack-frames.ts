/**
 * 只取异常的调用栈帧，用于主进程诊断日志。
 *
 * V8 的 stack 以 `${name}: ${message}` 开头，消息可能多行，其中的行也可能以 `at ` 开头，
 * 所以不能按行首筛栈帧。这里先去掉与 Error.prototype.toString 一致的头部，
 * 剩下的才是栈帧；头部对不上（例如读过 stack 之后又改了 message）就不记栈，
 * 宁可少一条诊断也不把正文写进日志。
 */
export function errorStackFrames(error: Error, limit: number): string | undefined {
  let header: string, stack: unknown
  try {
    header = Error.prototype.toString.call(error)
    stack = error.stack
  } catch {
    return undefined
  }
  if (typeof stack !== 'string' || !stack.startsWith(`${header}\n`)) return undefined
  return stack.slice(header.length + 1).split('\n').slice(0, limit).join('\n')
}
