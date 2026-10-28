const CONTEXT_LENGTH_MESSAGES = [
  // OpenAI 兼容协议（DeepSeek 实测）
  /maximum context length is \d+ tokens/iu,
  // 硅基流动（实测）：提示词超长，或最大输出本身超过上下文
  /input tokens \(\d+\) has exceeded max_seq_len/iu,
  /max_tokens \(\d+\) have exceeded max_seq_len/iu,
  // Gemini；没有 key，未实测。
  /input token count \(\d+\) exceeds the maximum number of tokens/iu,
]

export async function providerFailureCode(response: Response, signal: AbortSignal): Promise<'LLM_CONTEXT_LENGTH_EXCEEDED' | 'LLM_REQUEST_FAILED'> {
  if (response.status !== 400) {
    void response.body?.cancel().catch(() => {})
    return 'LLM_REQUEST_FAILED'
  }
  let body = ''
  try { body = await response.text() }
  catch (error) {
    if (signal.aborted) throw error
  }
  return CONTEXT_LENGTH_MESSAGES.some(pattern => pattern.test(body)) ? 'LLM_CONTEXT_LENGTH_EXCEEDED' : 'LLM_REQUEST_FAILED'
}
