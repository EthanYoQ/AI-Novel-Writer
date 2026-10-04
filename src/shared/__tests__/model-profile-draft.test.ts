import { describe, expect, it } from 'vitest'

import { applyModelProfileSelection, createModelProfileDraft } from '../model-profile-draft'

describe('model profile drafts', () => {
  it('preserves manual fields for the same identity and clears automatic fields on endpoint or protocol changes', () => {
    const initial = createModelProfileDraft({ id: 'sources', purposes: ['generation'] })
    const endpoint = applyModelProfileSelection(initial, { modelName: 'new', baseUrl: 'https://new.test/v1' },
      { contextWindowTokens: 64000, maxOutputTokens: 12000 })
    expect(endpoint.capabilitySources).toMatchObject({ contextWindowTokens: 'endpoint', maxOutputTokens: 'endpoint', reasoning: 'unknown' })
    const manual = { ...endpoint, capabilities: { ...endpoint.capabilities!, contextWindowTokens: 32000 },
      capabilitySources: { ...endpoint.capabilitySources, contextWindowTokens: 'manual' as const } }
    const refreshed = applyModelProfileSelection(manual, { modelName: 'new' }, { contextWindowTokens: 128000 })
    expect(refreshed.capabilities?.contextWindowTokens).toBe(32000)
    expect(refreshed.capabilitySources?.contextWindowTokens).toBe('manual')
    for (const selection of [{ baseUrl: 'https://other.test/v1' }, { protocol: 'gemini' as const }]) {
      const changed = applyModelProfileSelection({ ...refreshed, reasoningMapping: {
        adapter: 'openai-reasoning-effort', supportedEfforts: ['high'], providerValues: { high: 'high' },
      } }, selection)
      expect(changed.capabilities).toBeUndefined()
      expect(changed.reasoningMapping).toBeUndefined()
      expect(changed.capabilitySources?.contextWindowTokens).toBe('unknown')
    }
  })
  it('matches selected models by endpoint while preserving the author output limit', () => {
    const draft = { ...createModelProfileDraft({ id: 'choice', purposes: ['generation'] }),
      provider: 'custom' as const, maxTokens: 2048, reasoningOverride: 'high' as const }
    const selected = applyModelProfileSelection(draft, { baseUrl: 'https://api.x.ai/v1', modelName: 'grok-4.5' })
    expect(selected).toMatchObject({ maxTokens: 2048, capabilities: { contextWindowTokens: 500000, maxOutputTokens: 8192 }, reasoningOverride: 'auto' })
    const edited = { ...selected, maxTokens: 8192, capabilities: { ...selected.capabilities!, maxOutputTokens: 1024 } }
    expect(applyModelProfileSelection(edited, { modelName: 'grok-4.5' })).toEqual(edited)
    expect(applyModelProfileSelection(edited, { modelName: 'unlisted' }))
      .toMatchObject({ modelName: 'unlisted', maxTokens: 1024, capabilities: undefined, reasoningOverride: 'auto' })
  })
  it('creates a complete SiliconFlow bge-m3 embedding profile without an API key', () => {
    const draft = createModelProfileDraft({
      id: 'new-embedding-profile',
      purposes: ['embedding'],
    })

    expect(draft).toMatchObject({
      id: 'new-embedding-profile',
      name: 'SiliconFlow BAAI/bge-m3',
      provider: 'siliconflow',
      protocol: 'openai',
      baseUrl: 'https://api.siliconflow.cn/v1',
      modelName: 'BAAI/bge-m3',
      apiKey: '',
      purposes: ['embedding'],
      capabilities: {
        contextWindowTokens: 8192,
        maxOutputTokens: 0,
        reasoning: false,
        structuredOutput: false,
        usage: true,
      },
    })
  })
})
