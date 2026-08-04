import { getProjectDb } from '../database'

export class LLMHistoryRepository {
  /** 记录一次 LLM 调用 */
  static logCall(call: {
    modelId: string
    modelName: string
    purpose: string
    promptTokens: number | null
    completionTokens: number | null
    totalTokens: number | null
    durationMs: number
    success: boolean
    errorMessage?: string
  }): void {
    const db = getProjectDb()
    if (!db) return

    db.prepare(`
      INSERT INTO llm_calls (model_id, model_name, purpose, prompt_tokens, completion_tokens, total_tokens, duration_ms, success, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      call.modelId, call.modelName, call.purpose,
      call.promptTokens, call.completionTokens, call.totalTokens,
      call.durationMs, call.success ? 1 : 0, call.errorMessage ?? ''
    )
  }

  /** 获取调用统计 */
  static getStats(): {
    totalCalls: number
    successfulCalls: number
    failedCalls: number
    knownUsageCalls: number
    totalTokens: number | null
    totalPromptTokens: number | null
    totalCompletionTokens: number | null
  } {
    const db = getProjectDb()
    if (!db) return {
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      knownUsageCalls: 0,
      totalTokens: null,
      totalPromptTokens: null,
      totalCompletionTokens: null,
    }

    const row = db.prepare(`
      SELECT
        COUNT(*) as totalCalls,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successfulCalls,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failedCalls,
        SUM(CASE WHEN total_tokens IS NOT NULL THEN 1 ELSE 0 END) as knownUsageCalls,
        SUM(total_tokens) as totalTokens,
        SUM(prompt_tokens) as totalPromptTokens,
        SUM(completion_tokens) as totalCompletionTokens
      FROM llm_calls
    `).get() as {
      totalCalls: number
      successfulCalls: number | null
      failedCalls: number | null
      knownUsageCalls: number | null
      totalTokens: number | null
      totalPromptTokens: number | null
      totalCompletionTokens: number | null
    }

    return {
      ...row,
      successfulCalls: row.successfulCalls ?? 0,
      failedCalls: row.failedCalls ?? 0,
      knownUsageCalls: row.knownUsageCalls ?? 0,
    }
  }

  /** 获取最近 LLM 调用记录 */
  static getHistory(limit: number = 50): unknown[] {
    const db = getProjectDb()
    if (!db) return []
    return db.prepare(`
      SELECT id, model_name as modelName, purpose,
        prompt_tokens as promptTokens, completion_tokens as completionTokens,
        total_tokens as totalTokens, duration_ms as durationMs,
        success, created_at as createdAt
      FROM llm_calls ORDER BY id DESC LIMIT ?
    `).all(limit)
  }
}
