import { describe, expect, it } from 'vitest'

import { createProviderCatalog, resolveModelProfileCapabilities } from '../provider-presets'

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
        contextWindowTokens: 500_000,
        maxOutputTokens: 8192,
        reasoning: true,
        structuredOutput: true,
        usage: true,
      },
    }))
  })

  it('resolves provider facts only for an exact official provider, protocol, endpoint and model', () => {
    const legacy = {
      provider: 'deepseek',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com/',
      modelName: 'deepseek-v4-flash',
      maxTokens: 100_000,
      capabilities: null,
    }

    expect(resolveModelProfileCapabilities(legacy)).toEqual({
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 384_000,
      reasoning: false,
      structuredOutput: true,
      usage: true,
    })

    expect(resolveModelProfileCapabilities({
      ...legacy,
      baseUrl: 'https://proxy.example.com/v1',
    })).toBeUndefined()

    expect(resolveModelProfileCapabilities({
      ...legacy,
      protocol: 'gemini',
    })).toBeUndefined()

    expect(resolveModelProfileCapabilities({
      ...legacy,
      baseUrl: 'https://api.deepseek.com?tenant=other',
    })).toBeUndefined()

    const explicit = {
      contextWindowTokens: 32_768,
      maxOutputTokens: 2048,
      reasoning: true,
      structuredOutput: false,
      usage: false,
    }
    expect(resolveModelProfileCapabilities({ ...legacy, capabilities: explicit })).toEqual({
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 384_000,
      reasoning: false,
      structuredOutput: true,
      usage: true,
    })
  })

  it('publishes Gemini 2.5 Flash-Lite as one exact official capability fact', () => {
    const gemini = createProviderCatalog().find((preset) => preset.provider === 'gemini')

    expect(gemini).toMatchObject({
      baseUrl: 'https://generativelanguage.googleapis.com',
      protocol: 'gemini',
    })
    expect(gemini?.models).toContainEqual({
      name: 'gemini-2.5-flash-lite',
      maxTokens: 65_536,
      capabilities: {
        contextWindowTokens: 1_048_576,
        maxOutputTokens: 65_536,
        reasoning: true,
        structuredOutput: true,
        usage: true,
      },
    })
    expect(resolveModelProfileCapabilities({
      provider: 'gemini',
      protocol: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      modelName: 'gemini-2.5-flash-lite',
    })).toEqual(gemini?.models.find(model => model.name === 'gemini-2.5-flash-lite')?.capabilities)
  })
})
