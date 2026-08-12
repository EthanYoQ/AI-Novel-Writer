import { createHash, randomUUID } from 'node:crypto'

import type {
  ModelExecutionLeaseReceipt,
  ModelProfile,
} from '../../src/shared/ipc-channels'
import { resolveModelProfileCapabilities } from '../../src/shared/provider-presets'

const DEFAULT_MODEL_EXECUTION_LEASE_TTL_MS = 4 * 60 * 60 * 1_000

interface ModelExecutionLeaseRecord {
  receipt: ModelExecutionLeaseReceipt
  snapshot: ModelProfile
}

export interface ModelExecutionLeaseRegistryOptions {
  loadModel: (modelId: string) => ModelProfile | null
  createLeaseId?: () => string
  now?: () => number
  ttlMs?: number
}

export class ModelExecutionLeaseError extends Error {
  constructor(
    readonly code: 'MODEL_NOT_FOUND' | 'INVALID_OUTPUT_CAPABILITY',
    message: string,
  ) {
    super(message)
    this.name = 'ModelExecutionLeaseError'
  }
}

function cloneModelProfile(model: ModelProfile): ModelProfile {
  return structuredClone(model)
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function normalizeEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  try {
    const endpoint = new URL(trimmed)
    endpoint.hash = ''
    endpoint.search = ''
    endpoint.pathname = endpoint.pathname.replace(/\/+$/u, '') || '/'
    return endpoint.toString().replace(/\/$/u, '')
  } catch {
    return trimmed.replace(/\/+$/u, '')
  }
}

function endpointSubject(model: ModelProfile) {
  return {
    provider: model.provider,
    protocol: model.protocol,
    endpoint: normalizeEndpoint(model.baseUrl),
  }
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null
}

export function resolveModelExecutionCapabilityEvidence(
  model: ModelProfile,
): ModelExecutionLeaseReceipt['capabilityEvidence'] {
  const subjectFingerprint = sha256({
    ...endpointSubject(model),
    modelName: model.modelName,
  })
  const verified = resolveModelProfileCapabilities(model)
  const explicitContextWindow = positiveInteger(model.capabilities?.contextWindowTokens)
  const explicitOutputCap = positiveInteger(model.capabilities?.maxOutputTokens)
  const legacyOutputCap = positiveInteger(model.maxTokens)
  const operationalOutputCap = explicitOutputCap ?? legacyOutputCap
  const verifiedOutputLimit = positiveInteger(verified?.maxOutputTokens)
  const unconstrainedOutputTokens = verifiedOutputLimit && operationalOutputCap
    ? Math.min(verifiedOutputLimit, operationalOutputCap)
    : verifiedOutputLimit ?? operationalOutputCap
  const contextWindowTokens = verified?.contextWindowTokens ?? explicitContextWindow
  const maxOutputTokens = unconstrainedOutputTokens && contextWindowTokens
    ? Math.min(unconstrainedOutputTokens, contextWindowTokens)
    : unconstrainedOutputTokens
  if (!maxOutputTokens) {
    throw new ModelExecutionLeaseError('INVALID_OUTPUT_CAPABILITY', '模型输出上限无效')
  }

  const maxOutputSource = verifiedOutputLimit === maxOutputTokens
    ? 'verified-provider-preset' as const
    : explicitOutputCap
      ? 'user-operational-cap' as const
      : 'legacy-profile' as const
  return {
    source: {
      contextWindowTokens: verified
        ? 'verified-provider-preset'
        : explicitContextWindow
          ? 'user-operational-cap'
          : 'unknown',
      maxOutputTokens: maxOutputSource,
      featureFlags: verified ? 'verified-provider-preset' : 'unknown',
    },
    subjectFingerprint,
    contextWindowTokens: contextWindowTokens ?? null,
    maxOutputTokens,
    reasoning: verified?.reasoning ?? null,
    structuredOutput: verified?.structuredOutput ?? null,
    usage: verified?.usage ?? null,
  }
}

function modelRevision(model: ModelProfile): string {
  return sha256({
    id: model.id,
    ...endpointSubject(model),
    modelName: model.modelName,
    temperature: model.temperature,
    maxTokens: model.maxTokens,
    capabilities: model.capabilities ?? null,
    purposes: model.purposes,
    embeddingOptions: model.embeddingOptions ?? null,
  })
}

export interface CreateModelExecutionLeaseReceiptOptions {
  leaseId: string
  createdAt: number
  expiresAt: number
}

/**
 * Build the authoritative, secret-free execution receipt from one immutable
 * profile snapshot. The registry and in-process qualification adapter both use
 * this factory so capability planning cannot drift between execution seams.
 */
export function createModelExecutionLeaseReceipt(
  model: ModelProfile,
  options: CreateModelExecutionLeaseReceiptOptions,
): ModelExecutionLeaseReceipt {
  return {
    leaseId: options.leaseId,
    modelId: model.id,
    provider: model.provider,
    protocol: model.protocol,
    modelName: model.modelName,
    modelRevision: modelRevision(model),
    endpointFingerprint: sha256(endpointSubject(model)),
    capabilityEvidence: resolveModelExecutionCapabilityEvidence(model),
    createdAt: options.createdAt,
    expiresAt: options.expiresAt,
  }
}

/** Main-process-only store for immutable model execution snapshots. */
export class ModelExecutionLeaseRegistry {
  private readonly records = new Map<string, ModelExecutionLeaseRecord>()
  private readonly loadModel: (modelId: string) => ModelProfile | null
  private readonly createLeaseId: () => string
  private readonly now: () => number
  private readonly ttlMs: number

  constructor(options: ModelExecutionLeaseRegistryOptions) {
    this.loadModel = options.loadModel
    this.createLeaseId = options.createLeaseId ?? randomUUID
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? DEFAULT_MODEL_EXECUTION_LEASE_TTL_MS
  }

  begin(modelId: string): ModelExecutionLeaseReceipt {
    const model = this.loadModel(modelId)
    if (!model) throw new ModelExecutionLeaseError('MODEL_NOT_FOUND', '未找到模型配置')

    const createdAt = this.now()
    const receipt = createModelExecutionLeaseReceipt(model, {
      leaseId: this.createLeaseId(),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    })
    this.records.set(receipt.leaseId, {
      receipt,
      snapshot: cloneModelProfile(model),
    })
    return { ...receipt }
  }

  resolve(leaseId: string): ModelProfile {
    const record = this.records.get(leaseId)
    if (!record) throw new Error('模型执行租约无效')
    if (this.now() >= record.receipt.expiresAt) {
      this.records.delete(leaseId)
      throw new Error('模型执行租约已过期')
    }
    return cloneModelProfile(record.snapshot)
  }

  close(leaseId: string): boolean {
    return this.records.delete(leaseId)
  }
}
