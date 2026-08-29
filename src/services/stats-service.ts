/**
 * stats-service — LLM 调用统计数据访问服务
 *
 * 封装 BottomPanel ModelsView 中的 IPC 调用。
 */

import { ipc } from './ipc-client'
import type { ProjectSessionContext } from '../shared/ipc-channels'

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
  createdAt: string
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
