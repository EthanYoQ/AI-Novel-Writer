/**
 * 服务商以提示词超长拒绝请求时的 400 错误体。书童发送前不按自己的估算拒绝（ADR-0023），
 * 超长只能由服务商判定；这里把它和其他请求失败分开，界面才能指向模型设置的上下文窗口。
 * 样本见 __tests__/provider-context-length.test.ts。
 */
const CONTEXT_LENGTH_MESSAGES = [
  // OpenAI 兼容协议；DeepSeek 官方 2026-10-25 实测。
  /maximum context length is \d+ tokens/iu,
  // 硅基流动 2026-10-25 实测。
  /input tokens \(\d+\) has exceeded max_seq_len/iu,
  // Gemini；没有 key，未实测。
  /input token count \(\d+\) exceeds the maximum number of tokens/iu,
]

const FAILURE_BODY_LIMIT = 64 * 1024

export async function providerFailureCode(response: Response): Promise<'LLM_CONTEXT_LENGTH_EXCEEDED' | 'LLM_REQUEST_FAILED'> {
  let body = ''
  try { body = (await response.text()).slice(0, FAILURE_BODY_LIMIT) }
  catch { void response.body?.cancel().catch(() => {}) }
  return response.status === 400 && CONTEXT_LENGTH_MESSAGES.some(pattern => pattern.test(body))
    ? 'LLM_CONTEXT_LENGTH_EXCEEDED' : 'LLM_REQUEST_FAILED'
}
