import type { ModelProfile } from '../../src/shared/ipc-channels'

export function resolveOpenAIChatCompletionsUrl(baseUrl: string, provider: ModelProfile['provider']): string {
  const endpoint = new URL(baseUrl.trim())
  const configuredPath = endpoint.pathname.replace(/\/+$/u, '')

  if (configuredPath.endsWith('/chat/completions')) {
    endpoint.pathname = configuredPath
  } else if (configuredPath.endsWith('/chat')) {
    endpoint.pathname = `${configuredPath}/completions`
  } else if (!configuredPath || provider === 'novelai') {
    endpoint.pathname = `${configuredPath}/v1/chat/completions`
  } else {
    endpoint.pathname = `${configuredPath}/chat/completions`
  }

  return endpoint.toString()
}
