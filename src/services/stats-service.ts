/**
 * stats-service — LLM 调用统计数据访问服务
 *
 * 封装 BottomPanel ModelsView 中的 IPC 调用。
 */

import { ipc } from './ipc-client'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import type { LLMFinishReason } from '../shared/ipc-channels'
import { sameProjectPathKey } from '../shared/project-session-context'
import type { WorkflowRun } from '../stores/workflow-store'
import type { SafeDiagnosticWorkflow } from './safe-call-diagnostic'

/** LLM 调用统计 */
export interface LLMStats {
  totalCalls: number
  successfulCalls: number
  failedCalls: number
  knownUsageCalls: number
  totalTokens: number | null
  totalPromptTokens: number | null
  totalCompletionTokens: number | null
}

/** LLM 调用记录 */
export interface LLMCallRecord {
  id: number
  modelId?: string
  modelName: string
  purpose: string
  promptTokens: number | null
  completionTokens: number | null
  totalTokens: number | null
  durationMs: number
  success: boolean
  finishReason?: LLMFinishReason | null
  createdAt: string
}

const SQLITE_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/u

function callCompletionRange(createdAt: string): [number, number] | null {
  const sqlite = SQLITE_TIMESTAMP.exec(createdAt)
  if (sqlite) {
    const start = Date.parse(`${sqlite[1]}T${sqlite[2]}Z`)
    return Number.isFinite(start) ? [start, start + 999] : null
  }
  const timestamp = Date.parse(createdAt)
  return Number.isFinite(timestamp) ? [timestamp, timestamp] : null
}

function timestamp(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Relate a persisted model call to workflow state only when one step can own
 * its complete request interval. Ambiguous concurrent runs deliberately keep
 * workflow fields unknown.
 */
export function diagnosticWorkflowForCall(
  call: LLMCallRecord,
  runs: readonly WorkflowRun[],
  projectPath: string,
): SafeDiagnosticWorkflow {
  const diagnostic: SafeDiagnosticWorkflow = call.finishReason
    ? { finishReason: call.finishReason }
    : {}
  const completionRange = callCompletionRange(call.createdAt)
  if (!completionRange || !Number.isFinite(call.durationMs) || call.durationMs < 0) return diagnostic

  const [earliestCompletion, latestCompletion] = completionRange
  const candidates = runs.flatMap(run => {
    if (!sameProjectPathKey(run.projectPath, projectPath)) return []
    return run.steps.flatMap(step => {
      const stepStart = timestamp(step.startedAt)
      if (stepStart === null) return []
      const stepEnd = timestamp(step.completedAt) ?? timestamp(run.completedAt) ?? Number.POSITIVE_INFINITY
      const possibleCompletionStart = Math.max(earliestCompletion, stepStart + call.durationMs)
      const possibleCompletionEnd = Math.min(latestCompletion, stepEnd)
      return possibleCompletionStart <= possibleCompletionEnd ? [{ run, step }] : []
    })
  })
  if (candidates.length !== 1) return diagnostic

  const { run, step } = candidates[0]
  return {
    ...diagnostic,
    status: run.status,
    failureCode: run.failureCode,
    stepName: step.name,
    stepStatus: step.status,
    stepFailureCode: step.failureCode,
    promptBudgetReport: step.promptBudgetReport ?? run.promptBudgetReport,
  }
}

/** 获取 LLM 调用统计 */
export async function getLLMStats(projectSession: ProjectSessionContext): Promise<LLMStats> {
  return ipc.invokeWithProjectSession(
    projectSession,
    'db:get-llm-stats',
    projectSession.projectPath,
  )
}

/** 获取最近 LLM 调用记录 */
export async function getLLMHistory(
  projectSession: ProjectSessionContext,
  limit = 30,
): Promise<LLMCallRecord[]> {
  return (await ipc.invokeWithProjectSession(
    projectSession,
    'db:get-llm-history',
    limit,
    projectSession.projectPath,
  )) as unknown as LLMCallRecord[]
}

/** 同时加载统计和历史（常用组合） */
export async function loadLLMData(
  projectSession: ProjectSessionContext,
  limit = 30,
): Promise<{ stats: LLMStats; history: LLMCallRecord[] }> {
  const [stats, history] = await Promise.all([
    getLLMStats(projectSession),
    getLLMHistory(projectSession, limit),
  ])
  return { stats, history }
}
