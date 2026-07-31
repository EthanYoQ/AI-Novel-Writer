export class EmbeddingResponseValidationError extends Error {
  readonly code = 'EMBEDDING_RESPONSE_INVALID' as const

  constructor(provider: 'OpenAI' | 'Gemini', details: string) {
    super(`${provider} Embedding 响应无效：${details}`)
    this.name = 'EmbeddingResponseValidationError'
  }
}
