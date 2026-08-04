import { describe, expect, it } from 'vitest'

import { createProviderCatalog } from '../provider-presets'

describe('provider catalog', () => {
  it('exposes xAI Grok through its documented OpenAI-compatible preset', () => {
    const xai = createProviderCatalog().find((preset) => preset.provider === 'xai')

    expect(xai).toMatchObject({
      provider: 'xai',
      displayName: 'xAI(Grok)',
      baseUrl: 'https://api.x.ai/v1',
      protocol: 'openai',
    })
    expect(xai?.models).toContainEqual(expect.objectContaining({
      name: 'grok-4.5',
      maxTokens: 8192,
      capabilities: {
        contextWindowTokens: 1_000_000,
        maxOutputTokens: 8192,
        reasoning: true,
        structuredOutput: true,
        usage: true,
      },
    }))
  })
})
