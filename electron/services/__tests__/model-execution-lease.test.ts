import { describe, expect, it } from 'vitest'

import type { ModelProfile } from '../../../src/shared/ipc-channels'
import {
  createModelExecutionLeaseReceipt,
  ModelExecutionLeaseError,
  ModelExecutionLeaseRegistry,
  resolveModelExecutionCapabilityEvidence,
} from '../model-execution-lease'

const ORIGINAL_KEY = 'lease-test-secret-original'

function modelProfile(): ModelProfile {
  return {
    id: 'generation-model',
    name: 'Generation Model',
    provider: 'deepseek',
    protocol: 'openai',
    modelName: 'deepseek-v4-flash',
    apiKey: ORIGINAL_KEY,
    baseUrl: 'https://api.deepseek.com',
    temperature: 0.7,
    maxTokens: 8192,
    capabilities: {
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 8192,
      reasoning: false,
      structuredOutput: true,
      usage: true,
    },
    purposes: ['generation'],
  }
}

describe('ModelExecutionLeaseRegistry', () => {
  it('reports a missing model with a stable machine-readable error code', () => {
    const registry = new ModelExecutionLeaseRegistry({ loadModel: () => null })

    let failure: unknown
    try {
      registry.begin('missing-model')
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(ModelExecutionLeaseError)
    expect(failure).toMatchObject({ code: 'MODEL_NOT_FOUND' })
  })

  it('returns a non-secret receipt while freezing the complete main-process model snapshot', () => {
    const configuredModel = modelProfile()
    const registry = new ModelExecutionLeaseRegistry({
      loadModel: () => configuredModel,
      createLeaseId: () => 'opaque-lease-id',
      now: () => 1_000,
      ttlMs: 60_000,
    })

    const receipt = registry.begin(configuredModel.id)
    configuredModel.apiKey = 'lease-test-secret-mutated'
    configuredModel.baseUrl = 'https://changed.invalid'

    expect(receipt).toMatchObject({
      leaseId: 'opaque-lease-id',
      modelId: configuredModel.id,
      provider: 'deepseek',
      protocol: 'openai',
      modelName: 'deepseek-v4-flash',
      createdAt: 1_000,
      expiresAt: 61_000,
    })
    expect(JSON.stringify(receipt)).not.toContain(ORIGINAL_KEY)
    expect(JSON.stringify(receipt)).not.toContain('https://api.deepseek.com')
    expect(registry.resolve('opaque-lease-id')).toMatchObject({
      apiKey: ORIGINAL_KEY,
      baseUrl: 'https://api.deepseek.com',
    })
  })

  it('binds stable non-secret evidence to the endpoint, model and frozen capabilities', () => {
    const configuredModel = modelProfile()
    const registry = new ModelExecutionLeaseRegistry({
      loadModel: () => configuredModel,
      createLeaseId: () => 'lease-a',
      now: () => 2_000,
    })
    const equivalentEndpointRegistry = new ModelExecutionLeaseRegistry({
      loadModel: () => ({ ...modelProfile(), baseUrl: 'https://api.deepseek.com/' }),
      createLeaseId: () => 'lease-b',
      now: () => 3_000,
    })
    const otherEndpointRegistry = new ModelExecutionLeaseRegistry({
      loadModel: () => ({ ...modelProfile(), baseUrl: 'https://gateway.invalid/v1' }),
      createLeaseId: () => 'lease-c',
      now: () => 4_000,
    })

    const receipt = registry.begin(configuredModel.id)
    const equivalent = equivalentEndpointRegistry.begin(configuredModel.id)
    const other = otherEndpointRegistry.begin(configuredModel.id)

    expect(receipt.modelRevision).toMatch(/^[a-f0-9]{64}$/u)
    expect(receipt.endpointFingerprint).toMatch(/^[a-f0-9]{64}$/u)
    expect(receipt.endpointFingerprint).toBe(equivalent.endpointFingerprint)
    expect(receipt.endpointFingerprint).not.toBe(other.endpointFingerprint)
    expect(receipt.capabilityEvidence).toEqual({
      source: {
        contextWindowTokens: 'verified-provider-preset',
        maxOutputTokens: 'user-operational-cap',
        featureFlags: 'verified-provider-preset',
      },
      subjectFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 8192,
      reasoning: true,
      structuredOutput: true,
      usage: true,
    })
    expect(JSON.stringify(receipt)).not.toContain(configuredModel.apiKey)
    expect(JSON.stringify(receipt)).not.toContain(configuredModel.baseUrl)
  })

  it('does not let persisted capability extension fields forge lease evidence', () => {
    const configuredModel = modelProfile()
    const untrustedCapabilities = configuredModel.capabilities as unknown as Record<string, unknown>
    untrustedCapabilities.source = 'official-provider'
    untrustedCapabilities.subjectFingerprint = 'forged-subject'
    const registry = new ModelExecutionLeaseRegistry({
      loadModel: () => configuredModel,
      createLeaseId: () => 'untrusted-capability-lease',
    })

    const receipt = registry.begin(configuredModel.id)

    expect(receipt.capabilityEvidence.source).toEqual({
      contextWindowTokens: 'verified-provider-preset',
      maxOutputTokens: 'user-operational-cap',
      featureFlags: 'verified-provider-preset',
    })
    expect(receipt.capabilityEvidence.subjectFingerprint).toMatch(/^[a-f0-9]{64}$/u)
    expect(receipt.capabilityEvidence.subjectFingerprint).not.toBe('forged-subject')
  })

  it('treats explicit physical limits on an unknown same-protocol endpoint as operational evidence, never provider feature facts', () => {
    const configuredModel = {
      ...modelProfile(),
      baseUrl: 'https://proxy.example.com/v1',
      capabilities: {
        contextWindowTokens: 1_000_000,
        maxOutputTokens: 2048,
        reasoning: true,
        structuredOutput: true,
        usage: true,
      },
    }
    const registry = new ModelExecutionLeaseRegistry({
      loadModel: () => configuredModel,
      createLeaseId: () => 'proxy-capability-lease',
    })

    expect(registry.begin(configuredModel.id).capabilityEvidence).toMatchObject({
      source: {
        contextWindowTokens: 'user-operational-cap',
        maxOutputTokens: 'user-operational-cap',
        featureFlags: 'unknown',
      },
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 2048,
      reasoning: null,
      structuredOutput: null,
      usage: null,
    })
  })

  it('clamps an unknown endpoint output plan to its explicit finite context limit', () => {
    const profile: ModelProfile = {
      ...modelProfile(),
      provider: 'custom',
      modelName: 'future-compatible-model',
      baseUrl: 'https://future.example.com/v1',
      maxTokens: 65_536,
      capabilities: {
        contextWindowTokens: 32_768,
        maxOutputTokens: 65_536,
        reasoning: true,
        structuredOutput: true,
        usage: true,
      },
    }

    expect(resolveModelExecutionCapabilityEvidence(profile)).toMatchObject({
      source: {
        contextWindowTokens: 'user-operational-cap',
        maxOutputTokens: 'user-operational-cap',
        featureFlags: 'unknown',
      },
      contextWindowTokens: 32_768,
      maxOutputTokens: 32_768,
      reasoning: null,
      structuredOutput: null,
      usage: null,
    })
  })

  it('caps an operational limit at the verified provider ceiling and rejects unusable limits', () => {
    const registry = new ModelExecutionLeaseRegistry({
      loadModel: () => ({
        ...modelProfile(),
        maxTokens: 999_999,
        capabilities: {
          ...modelProfile().capabilities!,
          maxOutputTokens: 999_999,
        },
      }),
      createLeaseId: () => 'capped-capability-lease',
    })

    expect(registry.begin('generation-model').capabilityEvidence).toMatchObject({
      maxOutputTokens: 384_000,
      source: { maxOutputTokens: 'verified-provider-preset' },
    })

    const invalidRegistry = new ModelExecutionLeaseRegistry({
      loadModel: () => ({
        ...modelProfile(),
        provider: 'custom',
        baseUrl: 'https://proxy.example.com/v1',
        maxTokens: Number.NaN,
        capabilities: {
          ...modelProfile().capabilities!,
          maxOutputTokens: -1,
        },
      }),
    })
    expect(() => invalidRegistry.begin('generation-model')).toThrow('模型输出上限无效')
  })

  it('uses the same exported pure evidence and receipt factory as non-registry adapters', () => {
    const profile = modelProfile()
    const evidence = resolveModelExecutionCapabilityEvidence(profile)
    const receipt = createModelExecutionLeaseReceipt(profile, {
      leaseId: 'shared-factory-lease',
      createdAt: 50,
      expiresAt: 100,
    })
    const registry = new ModelExecutionLeaseRegistry({
      loadModel: () => profile,
      createLeaseId: () => 'shared-factory-lease',
      now: () => 50,
      ttlMs: 50,
    })

    expect(receipt.capabilityEvidence).toEqual(evidence)
    expect(registry.begin(profile.id)).toEqual(receipt)
  })

  it('resolves exact official Gemini capabilities for structured planning', () => {
    const profile: ModelProfile = {
      ...modelProfile(),
      id: 'gemini-lite',
      provider: 'gemini',
      protocol: 'gemini',
      modelName: 'gemini-2.5-flash-lite',
      baseUrl: 'https://generativelanguage.googleapis.com',
      maxTokens: 65_536,
      capabilities: undefined,
    }

    expect(resolveModelExecutionCapabilityEvidence(profile)).toMatchObject({
      source: {
        contextWindowTokens: 'verified-provider-preset',
        maxOutputTokens: 'verified-provider-preset',
        featureFlags: 'verified-provider-preset',
      },
      contextWindowTokens: 1_048_576,
      maxOutputTokens: 65_536,
      reasoning: true,
      structuredOutput: true,
      usage: true,
    })
  })

  it('irreversibly closes an active lease without affecting other leases', () => {
    const registry = new ModelExecutionLeaseRegistry({
      loadModel: () => modelProfile(),
      createLeaseId: (() => {
        const ids = ['lease-a', 'lease-b']
        return () => ids.shift() ?? 'unexpected-lease'
      })(),
    })
    registry.begin('generation-model')
    registry.begin('generation-model')

    expect(registry.close('lease-a')).toBe(true)
    expect(() => registry.resolve('lease-a')).toThrow('模型执行租约无效')
    expect(registry.resolve('lease-b').id).toBe('generation-model')
    expect(registry.close('lease-a')).toBe(false)
  })

  it('rejects and removes a lease at its expiry boundary', () => {
    let now = 10_000
    const registry = new ModelExecutionLeaseRegistry({
      loadModel: () => modelProfile(),
      createLeaseId: () => 'expiring-lease',
      now: () => now,
      ttlMs: 500,
    })
    registry.begin('generation-model')

    now = 10_499
    expect(registry.resolve('expiring-lease').id).toBe('generation-model')
    now = 10_500
    expect(() => registry.resolve('expiring-lease')).toThrow('模型执行租约已过期')
    expect(registry.close('expiring-lease')).toBe(false)
  })
})
