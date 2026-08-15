export function resolveOpenAIChatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/u, '')

  if (base.endsWith('/chat/completions')) {
    return base
  }
  if (base.endsWith('/chat')) {
    return `${base}/completions`
  }
  if (/\/v\d+$/iu.test(base)) {
    return `${base}/chat/completions`
  }

  return `${base}/v1/chat/completions`
}
