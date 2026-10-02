import { describe, expect, it } from 'vitest'

import {
  createProviderCatalog,
  resolveModelProfileBudgetCapabilities,
  resolveModelProfileCapabilities,
  resolveModelProfileReasoningMapping,
} from '../provider-presets'

describe('provider catalog', () => {
  it('keeps scoped Qwen capacity on the exact CN endpoint and model', () => {
    const profile = { provider: 'siliconflow', protocol: 'openai',
      baseUrl: 'https://api.siliconflow.cn/v1', modelName: 'Qwen/Qwen3.8-27B' }
    expect(resolveModelProfileBudgetCapabilities(profile)).toMatchObject({ contextWindowTokens: 262144, maxOutputTokens: 16384 })
    expect(resolveModelProfileBudgetCapabilities({ ...profile, provider: 'custom' }))
      .toEqual(resolveModelProfileBudgetCapabilities(profile))
    for (const overrides of [{ baseUrl: 'https://api.siliconflow.com/v1' },
      { baseUrl: 'https://api.siliconflow.cn/v1?proxy=1' }, { modelName: 'Qwen/Qwen3.8-27B-other' },
      { protocol: 'gemini' }]) {
      expect(resolveModelProfileBudgetCapabilities({ ...profile, ...overrides })).toBeUndefined()
      expect(resolveModelProfileReasoningMapping({ ...profile, ...overrides })).toBeUndefined()
    }
  })

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
      reasoningMapping: {
        adapter: 'openai-reasoning-effort',
        supportedEfforts: ['low', 'medium', 'high'],
        providerValues: { low: 'low', medium: 'medium', high: 'high' },
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
      reasoning: true,
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
      reasoning: true,
      structuredOutput: true,
      usage: true,
    })

    expect(resolveModelProfileReasoningMapping(legacy)).toEqual({
      adapter: 'deepseek-v4-thinking',
      supportedEfforts: ['off', 'low', 'high', 'max'],
      providerValues: { off: 'disabled', low: 'low', high: 'high', max: 'max' },
      requestAliases: { medium: 'high' },
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
      reasoningMapping: {
        adapter: 'gemini-thinking-budget',
        supportedEfforts: ['off', 'low', 'medium', 'high'],
        providerValues: { off: 0, low: 1_024, medium: 8_192, high: 24_576 },
      },
    })
    expect(resolveModelProfileCapabilities({
      provider: 'gemini',
      protocol: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      modelName: 'gemini-2.5-flash-lite',
    })).toEqual(gemini?.models.find(model => model.name === 'gemini-2.5-flash-lite')?.capabilities)
  })

  it.each([
    ['deepseek-ai/DeepSeek-V4-Flash', 'https://www.siliconflow.com/models/deepseek-v4-flash'],
    ['deepseek-ai/DeepSeek-V4-Pro', 'https://www.siliconflow.com/models/deepseek-v4-pro'],
  ])('publishes conservative SiliconFlow budget facts and explicit reasoning mapping separately: %s', (modelName, sourceUrl) => {
    const siliconflow = createProviderCatalog().find((preset) => preset.provider === 'siliconflow')

    expect(siliconflow).toMatchObject({
      baseUrl: 'https://api.siliconflow.cn/v1',
      budgetCapabilityBaseUrls: ['https://api.siliconflow.com/v1'],
      budgetProviderAliases: ['openai'],
      protocol: 'openai',
    })
    expect(siliconflow?.models).toContainEqual({
      name: modelName,
      maxTokens: 16_384,
      reasoningMapping: {
        adapter: 'siliconflow-v4-thinking',
        supportedEfforts: ['high', 'max'],
        providerValues: { high: 'high', max: 'max' },
      },
      budgetCapabilities: {
        contextWindowTokens: 1_000_000,
        maxOutputTokens: 393_000,
        evidence: {
          sourceUrl,
          calibration: 'conservative-provider-documentation',
        },
      },
    })
    expect(siliconflow?.models.find(model => model.name === modelName)?.capabilities).toBeUndefined()
  })

  it.each(['deepseek-ai/DeepSeek-V4-Flash', 'deepseek-ai/DeepSeek-V4-Pro'])(
    'resolves the approved OpenAI-compatible SiliconFlow profile without changing its provider: %s', modelName => {
      const profile = { provider: 'openai', protocol: 'openai', baseUrl: 'https://api.siliconflow.cn/v1',
        modelName, maxTokens: 16_384 }
      expect(resolveModelProfileBudgetCapabilities(profile)).toMatchObject({
        contextWindowTokens: 1_000_000,
        maxOutputTokens: 393_000,
      })
      expect(resolveModelProfileReasoningMapping(profile)).toMatchObject({
        adapter: 'siliconflow-v4-thinking',
        supportedEfforts: ['high', 'max'],
        providerValues: { high: 'high', max: 'max' },
      })
    })

  it.each([
    { baseUrl: 'https://api.siliconflow.com/v1' },
    { baseUrl: 'http://api.siliconflow.cn/v1' },
    { baseUrl: 'https://api.siliconflow.cn/v2' },
    { baseUrl: 'https://api.siliconflow.cn/v1/chat/completions' },
    { baseUrl: 'https://api.siliconflow.cn.evil.test/v1' },
    { baseUrl: 'https://api.siliconflow.cn:8443/v1' },
    { baseUrl: 'https://user@api.siliconflow.cn/v1' },
    { baseUrl: 'https://api.siliconflow.cn/v1?route=other' },
    { baseUrl: 'https://api.siliconflow.cn/v1#other' },
    { modelName: 'deepseek-ai/DeepSeek-V4-Pro-2026' },
    { modelName: 'deepseek-ai/DeepSeek-V4-Flash-2026' },
    { protocol: 'anthropic' },
  ])('does not promote SiliconFlow budget or family matches into reasoning evidence: %j', overrides => {
    expect(resolveModelProfileReasoningMapping({ provider: 'openai', protocol: 'openai',
      baseUrl: 'https://api.siliconflow.cn/v1', modelName: 'deepseek-ai/DeepSeek-V4-Flash', ...overrides })).toBeUndefined()
  })

  it.each(['deepseek-ai/DeepSeek-V4-Flash', 'deepseek-ai/DeepSeek-V4-Pro'])(
    'normalizes the official SiliconFlow trailing slash for reasoning: %s', modelName => {
    expect(resolveModelProfileReasoningMapping({ provider: 'siliconflow', protocol: 'openai',
      baseUrl: 'https://api.siliconflow.cn/v1/', modelName }))
      .toMatchObject({ adapter: 'siliconflow-v4-thinking' })
  })

  it.each([
    'https://api.siliconflow.cn/v1',
    'https://api.siliconflow.cn/v1/',
    'https://api.siliconflow.com/v1',
  ])('resolves the exact SiliconFlow model budget on an official endpoint: %s', (baseUrl) => {
    for (const [modelName, sourceUrl] of [
      ['deepseek-ai/DeepSeek-V4-Flash', 'https://www.siliconflow.com/models/deepseek-v4-flash'],
      ['deepseek-ai/DeepSeek-V4-Pro', 'https://www.siliconflow.com/models/deepseek-v4-pro'],
    ]) {
      const profile = { provider: 'siliconflow', protocol: 'openai', baseUrl, modelName }
      expect(resolveModelProfileBudgetCapabilities(profile)).toEqual({
        contextWindowTokens: 1_000_000,
        maxOutputTokens: 393_000,
        evidence: { sourceUrl, calibration: 'conservative-provider-documentation' },
      })
      if (baseUrl === 'https://api.siliconflow.com/v1') expect(resolveModelProfileReasoningMapping(profile)).toBeUndefined()
    }
  })

  it.each([
    { baseUrl: 'https://proxy.example.test/v1', modelName: 'deepseek-ai/DeepSeek-V4-Flash' },
    { baseUrl: 'https://proxy.example.test/v1', modelName: 'deepseek-ai/DeepSeek-V4-Pro' },
    { baseUrl: 'https://api.siliconflow.cn/v1', modelName: 'deepseek-ai/DeepSeek-V4-Pro-2026' },
    { baseUrl: 'http://api.siliconflow.cn/v1', modelName: 'deepseek-ai/DeepSeek-V4-Flash' },
    { baseUrl: 'https://api.siliconflow.cn', modelName: 'deepseek-ai/DeepSeek-V4-Flash' },
    { baseUrl: 'https://api.siliconflow.cn/v1?tenant=x', modelName: 'deepseek-ai/DeepSeek-V4-Flash' },
    { baseUrl: 'https://api.siliconflow.cn/v1', modelName: 'deepseek-ai/DeepSeek-V4-Flash-Pro' },
    { baseUrl: 'https://api.siliconflow.cn/v1', modelName: 'deepseek-ai/DeepSeek-V4-Flash-2026' },
    { baseUrl: 'https://api.siliconflow.cn/v1', modelName: 'DeepSeek-V4-Flash' },
  ])('does not infer SiliconFlow budget facts for $baseUrl / $modelName', ({ baseUrl, modelName }) => {
    expect(resolveModelProfileBudgetCapabilities({
      provider: 'siliconflow',
      protocol: 'openai',
      baseUrl,
      modelName,
      capabilities: {
        contextWindowTokens: 2_000_000,
        maxOutputTokens: 999_999,
        reasoning: true,
        structuredOutput: true,
        usage: true,
      },
    })).toBeUndefined()
  })
})
