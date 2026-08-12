import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

import {
  createModelExecutionLeaseReceipt,
  resolveModelExecutionCapabilityEvidence,
} from '../../electron/services/model-execution-lease'

import {
  QUALIFICATION_CAMPAIGN_LIMITS,
  QUALIFICATION_FIXTURE,
  QUALIFICATION_PRICE_SNAPSHOTS,
  assertQualificationSourceProvenance,
  assertQualificationOutputSchemaSafe,
  createQualificationProfilesFromMemory,
  runRealProviderGenerationQualification,
  verifyQualificationReceiptChecksum,
} from '../real-provider-generation-qualification.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function inMemoryProfiles() {
  return createQualificationProfilesFromMemory({
    configuredProfiles: [
      {
        id: 'decoy-deepseek',
        name: 'DeepSeek decoy',
        provider: 'deepseek',
        protocol: 'openai',
        modelName: 'deepseek-v4-pro',
        apiKey: 'decoy-deepseek-secret',
        baseUrl: 'https://api.deepseek.com',
        temperature: 0.6,
        maxTokens: 128_000,
        purposes: ['generation'],
      },
      {
        id: 'configured-deepseek',
        name: 'DeepSeek configured',
        provider: 'deepseek',
        protocol: 'openai',
        modelName: 'deepseek-v4-flash',
        apiKey: 'deepseek-qualification-secret',
        baseUrl: 'https://api.deepseek.com/',
        temperature: 0.6,
        maxTokens: 128_000,
        capabilities: {
          contextWindowTokens: 384_000,
          maxOutputTokens: 128_000,
          reasoning: false,
          structuredOutput: true,
          usage: true,
        },
        purposes: ['generation'],
      },
      {
        id: 'configured-grok',
        name: 'Grok configured',
        provider: 'xai',
        protocol: 'openai',
        modelName: 'old-grok-model',
        apiKey: 'grok-qualification-secret',
        baseUrl: 'https://api.x.ai/v1',
        temperature: 0.6,
        maxTokens: 32_768,
        purposes: ['generation'],
      },
    ],
    geminiApiKey: 'gemini-qualification-secret',
  })
}

describe('real provider generation qualification contract', () => {
  it('runs one synthetic fixture through the real Harness and StructuredExecutor without networking in dry-run', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('dry-run must never call fetch')))
    vi.stubGlobal('fetch', fetchSpy)

    const receipt = await runRealProviderGenerationQualification({
      mode: 'dry-run',
      profiles: inMemoryProfiles(),
      repositoryRoot,
    })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(receipt).toMatchObject({
      schemaVersion: 2,
      kind: 'real-provider-generation-qualification',
      mode: 'dry-run',
      qualificationScope: 'provider-adapter',
      executionSeam: 'generation-runtime-with-in-memory-adapter-lease',
      fixture: {
        id: QUALIFICATION_FIXTURE.id,
        blueprintChapterCount: 3,
        draftTargetCharacters: 5000,
      },
      campaign: {
        maxCalls: 12,
        calls: 6,
        maxRequestedOutputTokens: 98_304,
        requestedOutputTokens: 49_152,
        maxEstimatedInputTokens: 564_576,
      },
      providers: [
        {
          provider: 'deepseek',
          modelName: 'deepseek-v4-flash',
          blueprintCount: 3,
          draftCharacters: 5000,
          blueprintResponseFormat: 'json_object',
          runtimeLease: { begins: 1, closes: 1, oneLeaseAcrossAttempts: true },
        },
        {
          provider: 'xai',
          modelName: 'grok-4.5',
          blueprintCount: 3,
          draftCharacters: 5000,
          blueprintResponseFormat: 'json_object',
          runtimeLease: { begins: 1, closes: 1, oneLeaseAcrossAttempts: true },
        },
        {
          provider: 'gemini',
          modelName: 'gemini-2.5-flash-lite',
          blueprintCount: 3,
          draftCharacters: 5000,
          blueprintResponseFormat: 'json_object',
          runtimeLease: { begins: 1, closes: 1, oneLeaseAcrossAttempts: true },
        },
      ],
    })
    expect(receipt.provenance).toMatchObject({
      sourceSha: expect.stringMatching(/^[a-f0-9]{40}$/),
      fixtureHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      semanticContractHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      generationPolicyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    const currentHead = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).stdout.trim()
    expect(receipt.provenance.sourceSha).toBe(currentHead)
    expect(receipt.provenance.sourceTreeState).toMatch(/^(?:clean|dirty-dry-run)$/u)
    expect(receipt.fixture.fixtureHash).toBe(receipt.provenance.fixtureHash)
    expect(receipt).not.toHaveProperty('pricingCeiling')
    expect(receipt.campaign).not.toHaveProperty('maxAuthorizedUsd')
    expect(receipt.campaign).not.toHaveProperty('authorizedUsd')
    expect(receipt.providers.map(provider => provider.priceSnapshot))
      .toEqual(QUALIFICATION_PRICE_SNAPSHOTS)
    expect(receipt.providers.map(provider => provider.estimatedWorstCaseUsd))
      .toEqual(expect.arrayContaining([expect.any(Number)]))
    expect(new Set(receipt.providers.map(provider => provider.estimatedWorstCaseUsd)).size)
      .toBeGreaterThan(1)
    expect(receipt.checksumAlgorithm).toBe('sha256')
    expect(receipt.checksumSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(verifyQualificationReceiptChecksum(receipt)).toBe(true)
    expect(receipt.providers.every(
      provider => provider.receiptChecksumSha256.length === 64,
    )).toBe(true)
    expect(receipt.limitations).toContain('does-not-exercise-electron-ipc-main-process-lease')
  })

  it('selects only exact official targets and freezes the fixed cheap Gemini model', async () => {
    const profiles = inMemoryProfiles()
    expect(profiles.map(profile => [profile.provider, profile.protocol, profile.modelName, profile.baseUrl]))
      .toEqual([
        ['deepseek', 'openai', 'deepseek-v4-flash', 'https://api.deepseek.com'],
        ['xai', 'openai', 'grok-4.5', 'https://api.x.ai/v1'],
        ['gemini', 'gemini', 'gemini-2.5-flash-lite', 'https://generativelanguage.googleapis.com'],
      ])
    expect(profiles[0]?.id).toBe('configured-deepseek')
    expect(profiles.every(profile => Object.isFrozen(profile))).toBe(true)
    expect(profiles.every(profile => Object.isFrozen(profile.purposes))).toBe(true)

    const receipt = await runRealProviderGenerationQualification({
      mode: 'dry-run',
      profiles,
      repositoryRoot,
    })

    for (const provider of receipt.providers) {
      expect(provider.modelIdentitySha256).toMatch(/^[a-f0-9]{64}$/)
      expect(provider.endpointFingerprintSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(provider.calls).toBeGreaterThan(0)
      expect(provider.calls).toBeLessThanOrEqual(receipt.safetyBudget.maxAttempts)
      expect(provider.requestedOutputTokens)
        .toBeLessThanOrEqual(receipt.safetyBudget.maxRequestedOutputTokens)
      expect(provider.maxRequestedOutputTokensInOneAttempt)
        .toBeLessThanOrEqual(receipt.safetyBudget.maxRequestedOutputTokensPerAttempt)
      expect(provider.deadlineAt).toBeGreaterThan(provider.startedAt)
      expect(provider.promptUtf8Bytes).toBeLessThanOrEqual(provider.maxPromptUtf8Bytes)
      expect(provider.estimatedInputTokens)
        .toBe(provider.promptUtf8Bytes + provider.calls * 2048)
      expect(provider.estimatedInputTokens).toBeLessThanOrEqual(provider.maxEstimatedInputTokens)
    }
    expect(receipt.campaign.estimatedInputTokens)
      .toBe(receipt.campaign.promptUtf8Bytes + receipt.campaign.calls * 2048)
    expect(receipt.providers.map(provider => provider.capabilityEvidence)).toEqual(
      profiles.map(profile => resolveModelExecutionCapabilityEvidence(profile)),
    )
    const authoritativeReceipts = profiles.map(profile => createModelExecutionLeaseReceipt(profile, {
      leaseId: 'comparison-only',
      createdAt: 0,
      expiresAt: 1,
    }))
    expect(receipt.providers.map(provider => provider.modelIdentitySha256)).toEqual(
      authoritativeReceipts.map(provider => provider.modelRevision),
    )
    expect(receipt.providers.map(provider => provider.endpointFingerprintSha256)).toEqual(
      authoritativeReceipts.map(provider => provider.endpointFingerprint),
    )
  })

  it('uses exact per-model official price snapshots without presenting estimates as hard caps', async () => {
    expect(QUALIFICATION_PRICE_SNAPSHOTS).toEqual([
      {
        provider: 'deepseek',
        modelName: 'deepseek-v4-flash',
        sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing/',
        asOf: '2026-08-12',
        inputUsdPerMillionTokens: 0.14,
        outputUsdPerMillionTokens: 0.28,
      },
      {
        provider: 'xai',
        modelName: 'grok-4.5',
        sourceUrl: 'https://docs.x.ai/developers/models/grok-4.5',
        asOf: '2026-08-12',
        inputUsdPerMillionTokens: 2,
        outputUsdPerMillionTokens: 6,
        maximumEstimatedInputTokens: 200_000,
      },
      {
        provider: 'gemini',
        modelName: 'gemini-2.5-flash-lite',
        sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
        asOf: '2026-08-12',
        inputUsdPerMillionTokens: 0.1,
        outputUsdPerMillionTokens: 0.4,
      },
    ])

    const receipt = await runRealProviderGenerationQualification({
      mode: 'dry-run',
      profiles: inMemoryProfiles(),
      repositoryRoot,
    })
    for (const provider of receipt.providers) {
      expect(provider.priceEstimateStatus).toBe('current-snapshot')
      expect(provider.estimatedReservedUsd).toBeGreaterThan(0)
      expect(provider.estimatedWorstCaseUsd).toBeGreaterThan(provider.estimatedReservedUsd)
      expect(provider).not.toHaveProperty('maxAuthorizedUsd')
      expect(provider).not.toHaveProperty('authorizedUsd')
    }
    const xai = receipt.providers.find(provider => provider.provider === 'xai')
    expect(xai.maxEstimatedInputTokens)
      .toBeLessThanOrEqual(xai.priceSnapshot.maximumEstimatedInputTokens)
  })

  it('does not claim a dollar estimate or cap when a profile price snapshot is missing', async () => {
    const profiles = structuredClone(inMemoryProfiles())
    delete profiles[1].qualificationPriceSnapshot

    const receipt = await runRealProviderGenerationQualification({
      mode: 'dry-run',
      profiles,
      repositoryRoot,
    })
    expect(receipt.providers[1]).toMatchObject({ priceEstimateStatus: 'unavailable' })
    expect(receipt.providers[1]).not.toHaveProperty('estimatedReservedUsd')
    expect(receipt.providers[1]).not.toHaveProperty('estimatedWorstCaseUsd')
    expect(receipt.campaign.priceEstimateStatus).toBe('partial-unavailable')
    expect(receipt.campaign).not.toHaveProperty('estimatedReservedUsd')
  })

  it('expires every price estimate when its official snapshot is older than policy allows', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-20T00:00:01.000Z'))
    try {
      const receipt = await runRealProviderGenerationQualification({
        mode: 'dry-run',
        profiles: inMemoryProfiles(),
        repositoryRoot,
      })
      expect(receipt.providers.every(
        provider => provider.priceEstimateStatus === 'unavailable',
      )).toBe(true)
      expect(receipt.campaign.priceEstimateStatus).toBe('partial-unavailable')
    } finally {
      clock.mockRestore()
    }
  })

  it('rejects unofficial or ambiguous configured endpoints before qualification', () => {
    const configuredProfiles = structuredClone(inMemoryProfiles().slice(0, 2))
    configuredProfiles[0].baseUrl = 'https://proxy.example/v1'

    expect(() => createQualificationProfilesFromMemory({
      configuredProfiles,
      geminiApiKey: 'gemini-qualification-secret',
    })).toThrow(/DEEPSEEK_OFFICIAL_PROFILE_REQUIRED/u)
  })

  it('rejects exported budget and fixture overrides before any provider request', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('must fail before fetch')))
    vi.stubGlobal('fetch', fetchSpy)

    await expect(runRealProviderGenerationQualification({
      mode: 'execute',
      profiles: inMemoryProfiles(),
      repositoryRoot,
      allowBillableRequests: true,
      budget: {
        maxAttempts: 999,
        maxRequestedOutputTokens: 999_999,
        maxRequestedOutputTokensPerAttempt: 999_999,
        deadlineMs: 999_999,
      },
    })).rejects.toMatchObject({ code: 'BUDGET_OVERRIDE_FORBIDDEN' })
    await expect(runRealProviderGenerationQualification({
      mode: 'execute',
      profiles: inMemoryProfiles(),
      repositoryRoot,
      allowBillableRequests: true,
      fixture: { ...QUALIFICATION_FIXTURE, draftTargetCharacters: 500_000 },
    })).rejects.toMatchObject({ code: 'FIXTURE_OVERRIDE_FORBIDDEN' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('establishes the campaign deadline preflight before any provider fetch', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('expired preflight must block fetch')))
    vi.stubGlobal('fetch', fetchSpy)
    let reads = 0
    vi.spyOn(Date, 'now').mockImplementation(
      () => (reads++ === 0 ? 1_000 : 1_000 + QUALIFICATION_CAMPAIGN_LIMITS.deadlineMs + 1),
    )

    await expect(runRealProviderGenerationQualification({
      mode: 'dry-run',
      profiles: inMemoryProfiles(),
      repositoryRoot,
    })).rejects.toMatchObject({ code: 'CAMPAIGN_DEADLINE_EXHAUSTED' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses billable execution from a dirty product/source tree before any provider request', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('dirty tree must block fetch')))
    vi.stubGlobal('fetch', fetchSpy)

    await expect(runRealProviderGenerationQualification({
      mode: 'execute',
      profiles: inMemoryProfiles(),
      repositoryRoot,
      allowBillableRequests: true,
    })).rejects.toMatchObject({ code: 'SOURCE_TREE_DIRTY' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('invalidates execute provenance if HEAD or source cleanliness changes during qualification', () => {
    expect(() => assertQualificationSourceProvenance({
      mode: 'execute',
      initialSha: 'a'.repeat(40),
      finalSha: 'b'.repeat(40),
      initialClean: true,
      finalClean: true,
    })).toThrow(/SOURCE_TREE_CHANGED/u)
    expect(() => assertQualificationSourceProvenance({
      mode: 'execute',
      initialSha: 'a'.repeat(40),
      finalSha: 'a'.repeat(40),
      initialClean: true,
      finalClean: false,
    })).toThrow(/SOURCE_TREE_CHANGED/u)
    expect(assertQualificationSourceProvenance({
      mode: 'dry-run',
      initialSha: 'a'.repeat(40),
      finalSha: 'a'.repeat(40),
      initialClean: false,
      finalClean: false,
    })).toBe('dirty-dry-run')
  })

  it('verifies checksums and detects receipt mutation without calling it a signature', async () => {
    const receipt = await runRealProviderGenerationQualification({
      mode: 'dry-run',
      profiles: inMemoryProfiles(),
      repositoryRoot,
    })
    expect(verifyQualificationReceiptChecksum(receipt)).toBe(true)

    const mutated = structuredClone(receipt)
    mutated.campaign.calls += 1
    expect(verifyQualificationReceiptChecksum(mutated)).toBe(false)
  })

  it('fails closed when the declared output schema contains secret-bearing fields', () => {
    expect(() => assertQualificationOutputSchemaSafe({
      receipt: { apiKey: 'string' },
    })).toThrow(/UNSAFE_RECEIPT_SCHEMA/u)
  })

  it('never serializes API keys, endpoint credentials, endpoint query secrets, prompts, or generated prose', async () => {
    const receipt = await runRealProviderGenerationQualification({
      mode: 'dry-run',
      profiles: inMemoryProfiles(),
      repositoryRoot,
    })
    const serialized = JSON.stringify(receipt)

    for (const forbidden of [
      'deepseek-qualification-secret',
      'grok-qualification-secret',
      'gemini-qualification-secret',
      'decoy-deepseek-secret',
      'api.deepseek.com',
      'api.x.ai',
      'generativelanguage.googleapis.com',
      '5000字正文测试内容',
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
    expect(serialized).not.toContain('apiKey')
    expect(serialized).not.toContain('baseUrl')
  })

  it('keeps secret sources memory-only and requires explicit billable execution', () => {
    const source = readFileSync(
      path.join(repositoryRoot, 'scripts', 'real-provider-generation-qualification.mjs'),
      'utf8',
    )

    expect(source).toContain('AI_NOVEL_REAL_PROVIDER_QUALIFICATION')
    expect(source).toContain('AI_NOVEL_QUALIFICATION_GEMINI_API_KEY')
    expect(source).not.toContain('AI_NOVEL_QUALIFICATION_GEMINI_MODEL')
    expect(source).toContain('createModelExecutionLeaseReceipt')
    expect(source).not.toContain('function adapterLeaseReceipt')
    expect(source).toContain('Get-Clipboard -Raw')
    expect(source).not.toMatch(/writeFile|appendFile|createWriteStream/)
    expect(source).not.toMatch(/--(?:api-?key|key|token|secret)[= ]/i)

    const scriptPath = path.join(repositoryRoot, 'scripts', 'real-provider-generation-qualification.mjs')
    const result = spawnSync(process.execPath, [scriptPath, '--execute'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        AI_NOVEL_QUALIFICATION_GEMINI_API_KEY: 'must-not-appear-in-refusal',
        AI_NOVEL_REAL_PROVIDER_QUALIFICATION: '',
      },
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('BILLABLE_CONFIRMATION_REQUIRED')
    expect(`${result.stdout}${result.stderr}`).not.toContain('must-not-appear-in-refusal')
  })
})
