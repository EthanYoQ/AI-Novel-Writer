import { describe, expect, it } from 'vitest'

import { resolveReasoningPolicy } from '../reasoning-policy'
import type { ModelProfile } from '../ipc-channels'

const geminiModel: ModelProfile = {
  id: 'gemini-3.5-flash-lite',
  name: 'Gemini 3.5 Flash Lite',
  provider: 'gemini',
  protocol: 'gemini',
  modelName: 'gemini-3.5-flash-lite',
  apiKey: 'test-key',
  baseUrl: 'https://generativelanguage.googleapis.com',
  temperature: 0.7,
  maxTokens: 65_536,
  purposes: ['generation'],
}

describe('reasoning policy', () => {
  it('maps explicit Qwen medium to an application budget and keeps off disabled', () => {
    const model: ModelProfile = { ...geminiModel, provider: 'siliconflow', protocol: 'openai',
      baseUrl: 'https://api.siliconflow.cn/v1', modelName: 'Qwen/Qwen3.8-27B' }
    expect(resolveReasoningPolicy({ model: { ...model, reasoningOverride: 'medium' }, stage: 'review' }))
      .toEqual({ requested: 'medium', effective: 'medium', status: 'mapped', source: 'model-override',
        providerDirective: { adapter: 'openai-thinking-budget', thinkingBudget: 16384 } })
    expect(resolveReasoningPolicy({ model: { ...model, reasoningOverride: 'off' } }).providerDirective)
      .toEqual({ adapter: 'openai-thinking-budget', thinkingBudget: 0 })
    for (const reasoningOverride of [undefined, 'auto', 'low', 'high', 'max'] as const) {
      expect(resolveReasoningPolicy({ model: { ...model, reasoningOverride }, stage: 'planning' }))
        .toMatchObject({ effective: null, status: 'unsupported' })
    }
  })

  const silicon: ModelProfile = { ...geminiModel, provider: 'openai', protocol: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1', modelName: 'deepseek-ai/DeepSeek-V4-Flash' }

  it.each(['openai', 'siliconflow'] as const)('maps explicit SiliconFlow choices with the %s label', provider => {
    for (const reasoningOverride of ['high', 'max'] as const) {
      expect(resolveReasoningPolicy({ model: { ...silicon, provider, reasoningOverride }, creativeStrategy: 'fluent-drafting' }))
        .toEqual({ requested: reasoningOverride, effective: reasoningOverride, status: 'mapped', source: 'model-override',
          providerDirective: { adapter: 'siliconflow-v4-thinking', reasoningEffort: reasoningOverride } })
    }
  })

  it.each([undefined, 'auto', 'off', 'low', 'medium'] as const)('does not force SiliconFlow %s into a supported effort', reasoningOverride => {
    const result = resolveReasoningPolicy({ model: { ...silicon, reasoningOverride }, creativeStrategy: 'deep-planning', stage: 'planning' })
    expect(result).toEqual({ requested: reasoningOverride && reasoningOverride !== 'auto' ? reasoningOverride : 'max',
      effective: null, status: 'unsupported', source: !reasoningOverride || reasoningOverride === 'auto' ? 'project-strategy' : 'model-override' })
  })

  it('uses the project strategy and generation purpose to request stage-specific effort', () => {
    const gemini35FlashLite = { ...geminiModel, modelName: 'gemini-3.5-flash-lite' }
    expect(resolveReasoningPolicy({
      model: gemini35FlashLite,
      creativeStrategy: 'fluent-drafting',
      stage: 'drafting',
    })).toMatchObject({
      requested: 'off',
      effective: 'off',
      status: 'mapped',
      providerDirective: { adapter: 'gemini-thinking-level', thinkingLevel: 'minimal' },
    })

    expect(resolveReasoningPolicy({
      model: gemini35FlashLite,
      creativeStrategy: 'deep-planning',
      stage: 'planning',
    })).toMatchObject({
      requested: 'max',
      effective: 'high',
      status: 'capped',
      providerDirective: { adapter: 'gemini-thinking-level', thinkingLevel: 'high' },
    })
  })

  it.each(['gemini-3.8-flash', 'gemini-3.1-pro-preview'])('sends the lowest thinking level %s accepts when thinking off is requested', (modelName) => {
    const model = { ...geminiModel, modelName }
    const forced = { requested: 'off', effective: 'low', status: 'forced', providerDirective: { adapter: 'gemini-thinking-level', thinkingLevel: 'low' } }
    expect(resolveReasoningPolicy({ model, creativeStrategy: 'fluent-drafting', stage: 'drafting' }))
      .toEqual({ ...forced, source: 'project-strategy' })
    expect(resolveReasoningPolicy({ model: { ...model, reasoningOverride: 'off' } }))
      .toEqual({ ...forced, source: 'model-override' })
  })

  it('still leaves thinking off unsent when a non-Gemini mapping has no off level', () => {
    const model: ModelProfile = { ...geminiModel, provider: 'custom', protocol: 'openai', baseUrl: 'https://example.test/v1',
      reasoningOverride: 'off', reasoningMapping: { adapter: 'openai-reasoning-effort', supportedEfforts: ['low', 'high'], providerValues: { low: 'low', high: 'high' } } }
    expect(resolveReasoningPolicy({ model })).toEqual({ requested: 'off', effective: null, status: 'unsupported', source: 'model-override' })
  })

  it('keeps the thinking budget of a saved Gemini 2.5 Flash-Lite profile that never stored a mapping', () => {
    const legacy: ModelProfile = { ...geminiModel, modelName: 'gemini-2.5-flash-lite', reasoningOverride: 'high' }
    expect(resolveReasoningPolicy({ model: legacy }).providerDirective).toEqual({ adapter: 'gemini-thinking-budget', thinkingBudget: 24_576 })
  })

  it('still honours a saved Gemini 2.5 thinking-budget mapping', () => {
    const saved: ModelProfile = { ...geminiModel, reasoningOverride: 'high', reasoningMapping: {
      adapter: 'gemini-thinking-budget', supportedEfforts: ['off', 'high'], providerValues: { off: 0, high: 24_576 } } }
    expect(resolveReasoningPolicy({ model: saved }).providerDirective).toEqual({ adapter: 'gemini-thinking-budget', thinkingBudget: 24_576 })
  })

  it('defines four distinct strategy profiles without making deep-planning drafts maximal', () => {
    const requestedProfile = (creativeStrategy: 'auto' | 'fluent-drafting' | 'consistency-first' | 'deep-planning') => (
      ['drafting', 'planning', 'review', 'general'] as const
    ).map(stage => resolveReasoningPolicy({
      model: { ...geminiModel, provider: 'custom', baseUrl: 'https://example.test' },
      creativeStrategy,
      stage,
    }).requested)

    const profiles = {
      auto: requestedProfile('auto'),
      fluent: requestedProfile('fluent-drafting'),
      consistency: requestedProfile('consistency-first'),
      deep: requestedProfile('deep-planning'),
    }

    expect(new Set(Object.values(profiles).map(profile => profile.join('|'))).size).toBe(4)
    expect(profiles.auto).toEqual(['low', 'medium', 'high', 'low'])
    expect(profiles.deep).toEqual(['low', 'max', 'high', 'medium'])
    expect(profiles.consistency).not.toEqual(profiles.deep)
  })

  it('lets the model-profile override take precedence without changing the project strategy', () => {
    const model = { ...geminiModel, reasoningOverride: 'high' as const }
    const projectStrategy = 'fluent-drafting' as const

    expect(resolveReasoningPolicy({
      model,
      creativeStrategy: projectStrategy,
      stage: 'drafting',
    })).toMatchObject({
      requested: 'high',
      effective: 'high',
      status: 'mapped',
      source: 'model-override',
    })
    expect(projectStrategy).toBe('fluent-drafting')
  })

  it('caps unavailable maximum effort and reports models whose reasoning cannot be disabled', () => {
    const grok: ModelProfile = {
      ...geminiModel,
      id: 'grok-4.5',
      provider: 'xai',
      protocol: 'openai',
      modelName: 'grok-4.5',
      baseUrl: 'https://api.x.ai/v1',
      reasoningOverride: 'max',
    }
    expect(resolveReasoningPolicy({ model: grok, stage: 'review' })).toMatchObject({
      requested: 'max',
      effective: 'high',
      status: 'capped',
      providerDirective: { adapter: 'openai-reasoning-effort', reasoningEffort: 'high' },
    })

    expect(resolveReasoningPolicy({
      model: { ...grok, reasoningOverride: 'off' },
      creativeStrategy: 'fluent-drafting',
      stage: 'drafting',
    })).toMatchObject({ requested: 'off', effective: null, status: 'unsupported' })
  })

  it('suppresses reasoning fields for unknown custom endpoints and unverified built-in models', () => {
    const custom = {
      ...geminiModel,
      provider: 'custom' as const,
      protocol: 'openai' as const,
      baseUrl: 'https://gemini-proxy.example.test/v1',
      modelName: 'gemini-2.5-flash-lite',
      reasoningOverride: 'high' as const,
    }
    expect(resolveReasoningPolicy({ model: custom, stage: 'planning' })).toEqual({
      requested: 'high',
      effective: null,
      status: 'unsupported',
      source: 'model-override',
    })

    const unverifiedDeepSeek = {
      ...geminiModel,
      provider: 'deepseek' as const,
      protocol: 'openai' as const,
      baseUrl: 'https://api.deepseek.com',
      modelName: 'deepseek-future-model',
      reasoningOverride: 'high' as const,
    }
    expect(resolveReasoningPolicy({ model: unverifiedDeepSeek, stage: 'planning' }))
      .not.toHaveProperty('providerDirective')
  })

  it('maps the exact official DeepSeek V4 profile without trusting persisted capability flags', () => {
    const legacyDeepSeek: ModelProfile = {
      ...geminiModel,
      provider: 'deepseek',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com',
      modelName: 'deepseek-v4-flash',
      capabilities: {
        contextWindowTokens: 1_000_000,
        maxOutputTokens: 384_000,
        reasoning: false,
        structuredOutput: true,
        usage: true,
      },
    }

    expect(resolveReasoningPolicy({
      model: legacyDeepSeek,
      creativeStrategy: 'fluent-drafting',
      stage: 'drafting',
    })).toMatchObject({
      requested: 'off',
      effective: 'off',
      status: 'mapped',
      providerDirective: { adapter: 'deepseek-v4-thinking', thinking: 'disabled' },
    })

    expect(resolveReasoningPolicy({
      model: legacyDeepSeek,
      creativeStrategy: 'auto',
      stage: 'drafting',
    })).toMatchObject({
      requested: 'low',
      effective: 'low',
      status: 'mapped',
      providerDirective: {
        adapter: 'deepseek-v4-thinking',
        thinking: 'enabled',
        reasoningEffort: 'low',
      },
    })

    expect(resolveReasoningPolicy({
      model: { ...legacyDeepSeek, reasoningOverride: 'medium' },
      stage: 'planning',
    })).toMatchObject({
      requested: 'medium',
      effective: 'high',
      status: 'mapped',
      providerDirective: {
        adapter: 'deepseek-v4-thinking',
        thinking: 'enabled',
        reasoningEffort: 'high',
      },
    })

    expect(resolveReasoningPolicy({
      model: { ...legacyDeepSeek, reasoningOverride: 'max' },
      stage: 'review',
    })).toMatchObject({
      requested: 'max',
      effective: 'max',
      status: 'mapped',
      providerDirective: {
        adapter: 'deepseek-v4-thinking',
        thinking: 'enabled',
        reasoningEffort: 'max',
      },
    })
  })

  it.each([
    ['siliconflow', 'https://api.siliconflow.cn/v1', 'deepseek-ai/DeepSeek-V3.2'],
    ['custom', 'https://qwen-proxy.example.test/v1', 'qwen-long'],
    ['deepseek', 'https://deepseek-proxy.example.test/v1', 'deepseek-v4-flash'],
  ] as const)('does not inject official DeepSeek V4 fields for %s/%s/%s', (
    provider,
    baseUrl,
    modelName,
  ) => {
    expect(resolveReasoningPolicy({
      model: {
        ...geminiModel,
        provider,
        protocol: 'openai',
        baseUrl,
        modelName,
        reasoningOverride: 'low',
      },
      stage: 'drafting',
    })).not.toHaveProperty('providerDirective')
  })

  it('normalizes stale persisted policy values instead of sending an unverified parameter', () => {
    const staleModel = {
      ...geminiModel,
      reasoningOverride: 'ultra-from-old-build',
    } as unknown as ModelProfile

    expect(resolveReasoningPolicy({
      model: staleModel,
      creativeStrategy: 'obsolete-strategy' as never,
      stage: 'drafting',
    })).toMatchObject({
      requested: 'low',
      effective: 'low',
      status: 'mapped',
      source: 'project-strategy',
    })
  })
})
