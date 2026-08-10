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
  it('forwards generic model settings without a workflow temperature override', () => {
    expect(resolveGenerationParameters(openAIModel, {
      maxTokens: 512,
      responseFormat: { type: 'json_object' },
      thinking: true,
    })).toEqual({
      temperature: 1,
      maxTokens: 512,
      responseFormat: { type: 'json_object' },
      thinking: true,
    })
  })

  const officialKimiHosts = [
    'https://api.moonshot.cn/v1',
    'https://api.moonshot.ai/v1',
  ]

  const fixedKimiModels = [
    { modelName: 'kimi-k3', forwardsGenericThinking: false },
    { modelName: 'kimi-k2.7', forwardsGenericThinking: false },
    { modelName: 'kimi-k2.6', forwardsGenericThinking: true },
    { modelName: 'kimi-k2.5', forwardsGenericThinking: true },
  ]

  it.each(officialKimiHosts.flatMap(baseUrl => fixedKimiModels.map(model => ({ baseUrl, ...model }))))(
    'omits fixed temperature for $modelName on $baseUrl',
    ({ baseUrl, modelName, forwardsGenericThinking }) => {
      const resolved = resolveGenerationParameters({
        ...openAIModel,
        provider: 'custom',
        baseUrl,
        modelName,
        temperature: 0.7,
      }, {
        maxTokens: 512,
        responseFormat: { type: 'json_object' },
        thinking: true,
      })

      expect(resolved.temperature).toBeUndefined()
      expect(resolved.maxTokens).toBe(512)
      expect(resolved.responseFormat).toEqual({ type: 'json_object' })
      if (forwardsGenericThinking) {
        expect(resolved.thinking).toBe(true)
      } else {
        expect(resolved).not.toHaveProperty('thinking')
      }
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

  it('does not apply official Kimi rules to a non-official proxy endpoint', () => {
    expect(resolveGenerationParameters({
      ...openAIModel,
      provider: 'custom',
      baseUrl: 'https://kimi-proxy.example.test/v1',
      modelName: 'kimi-k3',
      temperature: 0.3,
    }, {
      maxTokens: 512,
      thinking: true,
    })).toEqual({
      temperature: 0.3,
      maxTokens: 512,
      thinking: true,
    })
  })

  it('does not mistake an invalid Kimi-looking URL for an official endpoint', () => {
    expect(resolveGenerationParameters({
      ...openAIModel,
      provider: 'custom',
      baseUrl: 'api.moonshot.cn/v1',
      modelName: 'kimi-k3',
      temperature: 0.3,
    }, {
      maxTokens: 512,
      thinking: true,
    })).toEqual({
      temperature: 0.3,
      maxTokens: 512,
      thinking: true,
    })
  })

  it.each([
    'http://api.moonshot.cn/v1',
    'ftp://api.moonshot.ai/v1',
  ])('does not apply official Kimi rules to a non-HTTPS endpoint: %s', (baseUrl) => {
    expect(resolveGenerationParameters({
      ...openAIModel,
      provider: 'custom',
      baseUrl,
      modelName: 'kimi-k3',
      temperature: 0.3,
    }, {
      maxTokens: 512,
      thinking: true,
    })).toEqual({
      temperature: 0.3,
      maxTokens: 512,
      thinking: true,
    })
  })
})
