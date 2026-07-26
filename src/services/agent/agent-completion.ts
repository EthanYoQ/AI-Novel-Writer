import type { LLMResponse } from '../../shared/ipc-channels'

/**
 * The Agent has no safe continuation protocol for a non-streaming ReAct turn.
 * Never feed a partial response back into the loop as if it were a complete
 * tool call or user-facing answer.
 */
export function requireCompleteAgentResponse(
  response: Pick<LLMResponse, 'success' | 'content' | 'error' | 'finishReason'>,
): string {
  switch (response.finishReason ?? 'stop') {
    case 'stop':
      if (response.success) return response.content
      throw new Error(response.error ?? 'LLM 生成失败')
    case 'length':
      throw new Error('AI 输出达到模型最大长度，未将不完整内容写入对话或执行工具。请提高模型最大输出 Tokens 或缩短任务后重试。')
    case 'content_filter':
      throw new Error('AI 输出因内容限制而未完成，未将不完整内容写入对话或执行工具。')
    default:
      throw new Error('AI 未正常完成生成，未将不完整内容写入对话或执行工具。')
  }
}
