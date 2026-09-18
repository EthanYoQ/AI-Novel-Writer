import { describe, expect, it } from 'vitest'

import {
  resolveGenerationCapabilityConstraints,
  resolveGenerationParameters,
} from '../generation-parameter-policy'
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
  it('separates a verified provider limit from a larger user operational cap', () => {
    const constraints = resolveGenerationCapabilityConstraints({
      ...openAIModel,
      id: 'grok-4.5',
      provider: 'xai',
      modelName: 'grok-4.5',
      baseUrl: 'https://api.x.ai/v1',
      maxTokens: 131_072,
      capabilities: {
        contextWindowTokens: 131_072,
        maxOutputTokens: 131_072,
        reasoning: true,
        structuredOutput: true,
        usage: true,
      },
    })

    expect(constraints).toEqual({
      modelContextWindowTokens: 500_000,
      modelMaxOutputTokens: 8_192,
      modelContextSource: 'verified-provider-preset',
      modelOutputSource: 'verified-provider-preset',
      userContextWindowTokens: 131_072,
      userMaxOutputTokens: 131_072,
    })
  })

  it('does not infer capability from a model name on an unverified endpoint', () => {
    expect(resolveGenerationCapabilityConstraints({
      ...openAIModel,
      provider: 'custom',
      modelName: 'grok-4.5',
      baseUrl: 'https://proxy.example.test/v1',
      maxTokens: 131_072,
      capabilities: {
        contextWindowTokens: 131_072,
        maxOutputTokens: 131_072,
        reasoning: true,
        structuredOutput: true,
        usage: true,
      },
    })).toEqual({
      modelContextWindowTokens: null,
      modelMaxOutputTokens: null,
      modelContextSource: 'unknown',
      modelOutputSource: 'unknown',
      userContextWindowTokens: 131_072,
      userMaxOutputTokens: 131_072,
    })
  })

  it('keeps SiliconFlow provider evidence separate from the smaller user cap', () => {
    expect(resolveGenerationCapabilityConstraints({
      ...openAIModel,
      provider: 'siliconflow',
      modelName: 'deepseek-ai/DeepSeek-V4-Flash',
      baseUrl: 'https://api.siliconflow.com/v1',
      maxTokens: 16_384,
      capabilities: {
        contextWindowTokens: 65_536,
        maxOutputTokens: 16_384,
        reasoning: false,
        structuredOutput: false,
        usage: false,
      },
    })).toEqual({
      modelContextWindowTokens: 1_000_000,
      modelMaxOutputTokens: 393_000,
      modelContextSource: 'verified-provider-preset',
      modelOutputSource: 'verified-provider-preset',
      userContextWindowTokens: 65_536,
      userMaxOutputTokens: 16_384,
    })
  })

  it('recognizes the approved OpenAI-compatible profile by exact SiliconFlow endpoint and slug', () => {
    expect(resolveGenerationCapabilityConstraints({
      ...openAIModel,
      provider: 'openai',
      modelName: 'deepseek-ai/DeepSeek-V4-Flash',
      baseUrl: 'https://api.siliconflow.cn/v1',
      maxTokens: 16_384,
    })).toMatchObject({
      modelContextWindowTokens: 1_000_000,
      modelMaxOutputTokens: 393_000,
      modelContextSource: 'verified-provider-preset',
      modelOutputSource: 'verified-provider-preset',
      userMaxOutputTokens: 16_384,
    })
  })

  it('forwards generic model settings without inventing a reasoning field', () => {
    expect(resolveGenerationParameters(openAIModel, {
      maxTokens: 512,
      responseFormat: { type: 'json_object' },
      reasoningStage: 'drafting',
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
    }, { maxTokens: 512, creativeStrategy: 'deep-planning', reasoningStage: 'planning' })).toEqual({
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
    }, { maxTokens: 512, reasoningStage: 'drafting' })).toEqual({
      temperature: 1,
      maxTokens: 512,
      reasoning: { adapter: 'openai-reasoning-effort', reasoningEffort: 'high' },
    })
  })
})
