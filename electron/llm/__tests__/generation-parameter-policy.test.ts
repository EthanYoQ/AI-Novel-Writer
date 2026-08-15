import { describe, expect, it } from 'vitest'

import { resolveGenerationParameters } from '../generation-parameter-policy'
import type { ModelProfile } from '../../../src/shared/ipc-channels'

const openAIModel: ModelProfile = {
  id: 'openai-test',
  name: 'OpenAI test',
  provider: 'openai',
  protocol: 'openai',
  modelName: 'gpt-test',
  apiKey: 'test-key',
  baseUrl: 'https://api.openai.com/v1',
  temperature: 1,
  maxTokens: 4096,
  purposes: ['generation'],
}

describe('generation parameter policy', () => {
  it('forwards generic model settings without inventing a reasoning field', () => {
    expect(resolveGenerationParameters(openAIModel, {
      maxTokens: 512,
      responseFormat: { type: 'json_object' },
      purpose: 'chapter-draft',
      creativeStrategy: 'deep-planning',
    })).toEqual({
      temperature: 1,
      maxTokens: 512,
      responseFormat: { type: 'json_object' },
    })
  })

  const officialKimiHosts = [
    'https://api.moonshot.cn/v1',
    'https://api.moonshot.ai/v1',
  ]
  const fixedKimiModels = ['kimi-k3', 'kimi-k2.7', 'kimi-k2.6', 'kimi-k2.5']

  it.each(officialKimiHosts.flatMap(baseUrl => fixedKimiModels.map(modelName => ({ baseUrl, modelName }))))(
    'omits fixed temperature for $modelName on $baseUrl',
    ({ baseUrl, modelName }) => {
      const resolved = resolveGenerationParameters({
        ...openAIModel,
        provider: 'custom',
        baseUrl,
        modelName,
        temperature: 0.7,
      }, { maxTokens: 512 })

      expect(resolved).toEqual({ temperature: undefined, maxTokens: 512 })
    },
  )

  it('enforces the documented range for an official Kimi model without a fixed-temperature rule', () => {
    const unknownKimiModel = {
      ...openAIModel,
      provider: 'custom' as const,
      baseUrl: 'https://api.moonshot.cn/v1',
      modelName: 'kimi-future-preview',
      temperature: 0.6,
    }

    expect(resolveGenerationParameters(unknownKimiModel, { maxTokens: 512 })).toMatchObject({
      temperature: 0.6,
    })
    expect(() => resolveGenerationParameters({ ...unknownKimiModel, temperature: 1.1 }, { maxTokens: 512 }))
      .toThrow('0 到 1')
  })

  it('does not apply official Kimi rules or reasoning fields to a proxy endpoint', () => {
    expect(resolveGenerationParameters({
      ...openAIModel,
      provider: 'custom',
      baseUrl: 'https://kimi-proxy.example.test/v1',
      modelName: 'kimi-k3',
      temperature: 0.3,
      reasoningOverride: 'max',
    }, { maxTokens: 512, creativeStrategy: 'deep-planning', purpose: 'chapter-blueprint' })).toEqual({
      temperature: 0.3,
      maxTokens: 512,
    })
  })

  it.each([
    'api.moonshot.cn/v1',
    'http://api.moonshot.cn/v1',
    'ftp://api.moonshot.ai/v1',
  ])('does not apply official Kimi rules to an invalid or non-HTTPS endpoint: %s', (baseUrl) => {
    expect(resolveGenerationParameters({
      ...openAIModel,
      provider: 'custom',
      baseUrl,
      modelName: 'kimi-k3',
      temperature: 0.3,
    }, { maxTokens: 512 })).toEqual({ temperature: 0.3, maxTokens: 512 })
  })

  it('maps the profile override through an exact verified model preset', () => {
    expect(resolveGenerationParameters({
      ...openAIModel,
      id: 'grok-4.5',
      provider: 'xai',
      modelName: 'grok-4.5',
      baseUrl: 'https://api.x.ai/v1',
      reasoningOverride: 'max',
    }, { maxTokens: 512, purpose: 'chapter-draft' })).toEqual({
      temperature: 1,
      maxTokens: 512,
      reasoning: { adapter: 'openai-reasoning-effort', reasoningEffort: 'high' },
    })
  })
})
