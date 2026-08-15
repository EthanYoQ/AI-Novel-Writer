import { describe, expect, it } from 'vitest'

import { resolveReasoningPolicy } from '../reasoning-policy'
import type { ModelProfile } from '../ipc-channels'

const geminiFlashLite: ModelProfile = {
  id: 'gemini-flash-lite',
  name: 'Gemini 2.5 Flash Lite',
  provider: 'gemini',
  protocol: 'gemini',
  modelName: 'gemini-2.5-flash-lite',
  apiKey: 'test-key',
  baseUrl: 'https://generativelanguage.googleapis.com',
  temperature: 0.7,
  maxTokens: 65_536,
  purposes: ['generation'],
}

describe('reasoning policy', () => {
  it('uses the project strategy and generation purpose to request stage-specific effort', () => {
    expect(resolveReasoningPolicy({
      model: geminiFlashLite,
      creativeStrategy: 'fluent-drafting',
      stage: 'drafting',
    })).toMatchObject({
      requested: 'off',
      effective: 'off',
      status: 'mapped',
      providerDirective: { adapter: 'gemini-thinking-budget', thinkingBudget: 0 },
    })

    expect(resolveReasoningPolicy({
      model: geminiFlashLite,
      creativeStrategy: 'deep-planning',
      stage: 'planning',
    })).toMatchObject({
      requested: 'max',
      effective: 'high',
      status: 'capped',
      providerDirective: { adapter: 'gemini-thinking-budget', thinkingBudget: 24_576 },
    })
  })

  it('defines four distinct strategy profiles without making deep-planning drafts maximal', () => {
    const requestedProfile = (creativeStrategy: 'auto' | 'fluent-drafting' | 'consistency-first' | 'deep-planning') => (
      ['drafting', 'planning', 'review', 'general'] as const
    ).map(stage => resolveReasoningPolicy({
      model: { ...geminiFlashLite, provider: 'custom', baseUrl: 'https://example.test' },
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
    const model = { ...geminiFlashLite, reasoningOverride: 'high' as const }
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
      ...geminiFlashLite,
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
    })).toMatchObject({ requested: 'off', effective: 'low', status: 'forced' })
  })

  it('suppresses reasoning fields for unknown custom endpoints and unverified built-in models', () => {
    const custom = {
      ...geminiFlashLite,
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

    const deepSeek = {
      ...geminiFlashLite,
      provider: 'deepseek' as const,
      protocol: 'openai' as const,
      baseUrl: 'https://api.deepseek.com',
      modelName: 'deepseek-v4-flash',
      reasoningOverride: 'high' as const,
    }
    expect(resolveReasoningPolicy({ model: deepSeek, stage: 'planning' }))
      .not.toHaveProperty('providerDirective')
  })

  it('normalizes stale persisted policy values instead of sending an unverified parameter', () => {
    const staleModel = {
      ...geminiFlashLite,
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
