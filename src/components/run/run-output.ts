import { sameProjectPathKey } from '../../shared/project-session-context'
import type { WorkflowRun } from '../../stores/workflow-store'

export const ACTIVE_RUN_STATUSES: ReadonlySet<WorkflowRun['status']> = new Set(['running', 'waiting', 'paused', 'cancelling'])

/** 这部作品的运行；没打开作品时为空。 */
export function projectRuns(runs: readonly WorkflowRun[], projectPath: string | undefined): WorkflowRun[] {
  return projectPath ? runs.filter(run => sameProjectPathKey(run.projectPath, projectPath)) : []
}

/**
 * 步骤输出里最后一段 `<think>` 是思考过程，`</think>` 之后才是正文；思考还没结束时没有正文。
 * 有的命令把数组或对象当结果返回，统一转成文字。
 */
export function splitThinking(result: unknown): { raw: string; thinking: string; content: string } {
  const raw = typeof result === 'string' ? result : result ? JSON.stringify(result) : ''
  const segments = raw.split(/<think>/)
  if (segments.length === 1) return { raw, thinking: '', content: raw }
  const last = segments[segments.length - 1]
  const end = last.indexOf('</think>')
  return end === -1
    ? { raw, thinking: last, content: '' }
    : { raw, thinking: last.substring(0, end), content: last.substring(end + 8) }
}
