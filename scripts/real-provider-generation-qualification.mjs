/* global Buffer, process */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Safe preparation:
 *   node scripts/real-provider-generation-qualification.mjs --dry-run
 *
 * Billable execution additionally requires the exact in-process confirmation
 * environment value and a Gemini key supplied by parent environment or
 * clipboard (`--gemini-key-source=clipboard`). Credentials are never accepted
 * as command-line values and this script never writes evidence to disk.
 */
export const QUALIFICATION_FIXTURE = Object.freeze({
  id: 'three-blueprints-and-5000-character-draft-v1',
  architecture: '近未来港城中，档案修复师发现三封会改变同一宗旧案结论的信。',
  blueprintChapterNumbers: Object.freeze([1, 2, 3]),
  draftChapterNumber: 1,
  draftTargetCharacters: 5000,
})

export const QUALIFICATION_SAFETY_BUDGET = Object.freeze({
  maxAttempts: 4,
  maxRequestedOutputTokens: 32_768,
  maxRequestedOutputTokensPerAttempt: 8192,
  deadlineMs: 10 * 60_000,
})

export const QUALIFICATION_INPUT_ESTIMATE_POLICY = Object.freeze({
  method: 'utf8-byte-upper-bound-plus-fixed-protocol-overhead',
  fixedProtocolOverheadTokensPerCall: 2048,
})

export const QUALIFICATION_PROVIDER_LIMITS = Object.freeze({
  maxCalls: QUALIFICATION_SAFETY_BUDGET.maxAttempts,
  maxRequestedOutputTokens: QUALIFICATION_SAFETY_BUDGET.maxRequestedOutputTokens,
  maxRequestedOutputTokensPerAttempt:
    QUALIFICATION_SAFETY_BUDGET.maxRequestedOutputTokensPerAttempt,
  maxPromptUtf8BytesPerCall: 45_000,
  maxPromptUtf8Bytes: 180_000,
  maxEstimatedInputTokensPerCall:
    45_000 + QUALIFICATION_INPUT_ESTIMATE_POLICY.fixedProtocolOverheadTokensPerCall,
  maxEstimatedInputTokens:
    180_000
    + QUALIFICATION_SAFETY_BUDGET.maxAttempts
      * QUALIFICATION_INPUT_ESTIMATE_POLICY.fixedProtocolOverheadTokensPerCall,
  deadlineMs: QUALIFICATION_SAFETY_BUDGET.deadlineMs,
})

export const QUALIFICATION_CAMPAIGN_LIMITS = Object.freeze({
  maxCalls: 12,
  maxRequestedOutputTokens: 98_304,
  maxPromptUtf8Bytes: 540_000,
  maxEstimatedInputTokens:
    540_000
    + 12 * QUALIFICATION_INPUT_ESTIMATE_POLICY.fixedProtocolOverheadTokensPerCall,
  deadlineMs: 30 * 60_000,
})

export const QUALIFICATION_PRICE_SNAPSHOTS = Object.freeze([
  Object.freeze({
    provider: 'deepseek',
    modelName: 'deepseek-v4-flash',
    sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing/',
    asOf: '2026-08-12',
    inputUsdPerMillionTokens: 0.14,
    outputUsdPerMillionTokens: 0.28,
  }),
  Object.freeze({
    provider: 'xai',
    modelName: 'grok-4.5',
    sourceUrl: 'https://docs.x.ai/developers/models/grok-4.5',
    asOf: '2026-08-12',
    inputUsdPerMillionTokens: 2,
    outputUsdPerMillionTokens: 6,
    maximumEstimatedInputTokens: 200_000,
  }),
  Object.freeze({
    provider: 'gemini',
    modelName: 'gemini-2.5-flash-lite',
    sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
    asOf: '2026-08-12',
    inputUsdPerMillionTokens: 0.1,
    outputUsdPerMillionTokens: 0.4,
  }),
])
const QUALIFICATION_PRICE_SNAPSHOT_MAX_AGE_DAYS = 7
const QUALIFICATION_TARGETS = Object.freeze([
  Object.freeze({
    provider: 'deepseek',
    protocol: 'openai',
    modelName: 'deepseek-v4-flash',
    baseUrl: 'https://api.deepseek.com',
  }),
  Object.freeze({
    provider: 'xai',
    protocol: 'openai',
    modelName: 'grok-4.5',
    baseUrl: 'https://api.x.ai/v1',
  }),
  Object.freeze({
    provider: 'gemini',
    protocol: 'gemini',
    modelName: 'gemini-2.5-flash-lite',
    baseUrl: 'https://generativelanguage.googleapis.com',
  }),
])
const QUALIFICATION_DRAFT_CONTRACT = Object.freeze({
  chapterNumber: QUALIFICATION_FIXTURE.draftChapterNumber,
  minimumCharacters: QUALIFICATION_FIXTURE.draftTargetCharacters,
  completedOnlyWithFinishReason: 'stop',
  continuableOnlyWithFinishReason: 'length',
})
const QUALIFICATION_GENERATION_POLICY = Object.freeze({
  targets: QUALIFICATION_TARGETS,
  providerLimits: QUALIFICATION_PROVIDER_LIMITS,
  campaignLimits: QUALIFICATION_CAMPAIGN_LIMITS,
  priceSnapshotPolicy: Object.freeze({
    maxAgeDays: QUALIFICATION_PRICE_SNAPSHOT_MAX_AGE_DAYS,
    authority: 'estimate-only',
  }),
  priceSnapshots: QUALIFICATION_PRICE_SNAPSHOTS,
  inputEstimatePolicy: QUALIFICATION_INPUT_ESTIMATE_POLICY,
  physicalPlanAuthority: 'generation-harness',
  structuredCommit: 'complete-batch-only',
})
const QUALIFICATION_RECEIPT_OUTPUT_SCHEMA = Object.freeze([
  'schemaVersion', 'kind', 'mode', 'qualificationScope', 'executionSeam', 'limitations',
  'provenance', 'sourceSha', 'fixtureHash', 'semanticContractHash', 'generationPolicyHash',
  'fixture', 'id', 'blueprintChapterCount', 'draftTargetCharacters', 'safetyBudget',
  'maxAttempts', 'maxRequestedOutputTokensPerAttempt', 'deadlineMs',
  'campaign', 'startedAt', 'deadlineAt', 'maxCalls', 'calls',
  'maxRequestedOutputTokens', 'requestedOutputTokens', 'maxPromptUtf8Bytes',
  'promptUtf8Bytes', 'providers', 'provider',
  'modelName', 'modelIdentitySha256', 'endpointFingerprintSha256',
  'maxRequestedOutputTokensInOneAttempt', 'finishReasons', 'blueprintCount',
  'blueprintSha256', 'draftCharacters', 'draftSha256', 'usage', 'callsWithUsage',
  'promptTokens', 'completionTokens', 'totalTokens', 'runtimeLease', 'begins', 'closes',
  'oneLeaseAcrossAttempts', 'receiptChecksumSha256', 'checksumAlgorithm', 'checksumSha256',
  'sourceTreeState', 'priceSnapshot', 'priceEstimateStatus', 'estimatedReservedUsd',
  'estimatedWorstCaseUsd', 'sourceUrl', 'asOf', 'inputUsdPerMillionTokens',
  'outputUsdPerMillionTokens', 'capabilityEvidence', 'source', 'contextWindowTokens',
  'maximumEstimatedInputTokens',
  'maxOutputTokens', 'featureFlags', 'subjectFingerprint', 'reasoning',
  'structuredOutput', 'blueprintResponseFormat',
  'inputEstimatePolicy', 'method', 'fixedProtocolOverheadTokensPerCall',
  'maxEstimatedInputTokens', 'maxEstimatedInputTokensPerCall', 'estimatedInputTokens',
])

const BILLABLE_CONFIRMATION = 'I_ACCEPT_BILLABLE_REQUESTS'
const GEMINI_KEY_ENV = 'AI_NOVEL_QUALIFICATION_GEMINI_API_KEY'
const productRuntimeCache = new Map()

class QualificationFailure extends Error {
  constructor(code) {
    super(`Real provider qualification failed: ${code}`)
    this.name = 'QualificationFailure'
    this.code = code
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value) {
  return createHash('sha256').update(
    typeof value === 'string' ? value : canonicalJson(value),
  ).digest('hex')
}

export function verifyQualificationReceiptChecksum(receipt) {
  if (!receipt || typeof receipt !== 'object') return false
  const { checksumSha256, ...receiptCore } = receipt
  return typeof checksumSha256 === 'string'
    && /^[a-f0-9]{64}$/u.test(checksumSha256)
    && checksumSha256 === sha256(receiptCore)
}

const FORBIDDEN_RECEIPT_FIELDS = new Set([
  'apikey', 'baseurl', 'prompt', 'content', 'messages', 'rawoutput', 'generatedprose',
  'secret', 'authorization', 'credential', 'credentials', 'headers', 'request', 'response',
  'requestbody', 'responsebody', 'body', 'prose', 'text', 'endpoint', 'url',
])

export function assertQualificationOutputSchemaSafe(
  schema = QUALIFICATION_RECEIPT_OUTPUT_SCHEMA,
) {
  const visit = value => {
    if (typeof value === 'string') {
      if (FORBIDDEN_RECEIPT_FIELDS.has(value.toLocaleLowerCase('en-US'))) {
        throw new QualificationFailure('UNSAFE_RECEIPT_SCHEMA')
      }
      return
    }
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (value && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        if (FORBIDDEN_RECEIPT_FIELDS.has(key.toLocaleLowerCase('en-US'))) {
          throw new QualificationFailure('UNSAFE_RECEIPT_SCHEMA')
        }
        visit(nested)
      }
    }
  }
  visit(schema)
}

function assertReceiptMatchesOutputSchema(receipt) {
  const declaredFields = new Set(QUALIFICATION_RECEIPT_OUTPUT_SCHEMA)
  const visit = value => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (!value || typeof value !== 'object') return
    for (const [key, nested] of Object.entries(value)) {
      if (!declaredFields.has(key)) {
        throw new QualificationFailure('UNDECLARED_RECEIPT_FIELD')
      }
      visit(nested)
    }
  }
  visit(receipt)
}

function cloneProfile(profile) {
  return structuredClone(profile)
}

function freezeProfile(profile) {
  const clone = cloneProfile(profile)
  if (clone.capabilities) Object.freeze(clone.capabilities)
  if (clone.qualificationPriceSnapshot) Object.freeze(clone.qualificationPriceSnapshot)
  if (clone.embeddingOptions) Object.freeze(clone.embeddingOptions)
  if (Array.isArray(clone.purposes)) Object.freeze(clone.purposes)
  return Object.freeze(clone)
}

function normalizeEndpoint(value) {
  let endpoint = String(value || '').trim().replace(/\/+$/u, '')
  try {
    const parsed = new URL(endpoint)
    if (
      parsed.protocol !== 'https:'
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) return null
    parsed.pathname = parsed.pathname.replace(/\/+$/u, '') || '/'
    endpoint = parsed.toString().replace(/\/+$/u, '')
  } catch {
    return null
  }
  return endpoint
}

function normalizedEndpointSubject(profile) {
  return {
    provider: profile.provider,
    protocol: profile.protocol,
    endpoint: normalizeEndpoint(profile.baseUrl),
  }
}

function nonSecretModelIdentity(profile) {
  return {
    id: profile.id,
    ...normalizedEndpointSubject(profile),
    modelName: String(profile.modelName || '').trim(),
    temperature: profile.temperature,
    maxTokens: profile.maxTokens,
    capabilities: profile.capabilities ?? null,
  }
}

function secretMarkersForProfile(profile) {
  const markers = [String(profile.apiKey || '').trim()]
  try {
    const endpoint = new URL(String(profile.baseUrl || ''))
    markers.push(endpoint.username, endpoint.password)
    for (const value of endpoint.searchParams.values()) markers.push(value)
  } catch {
    // A malformed endpoint has no reliably extractable credential fields.
  }
  return markers.filter(marker => marker.length >= 4)
}

function assertSecretFree(value, secretMarkers) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  if (secretMarkers.some(marker => serialized.includes(marker))) {
    throw new QualificationFailure('SECRET_SCAN_FAILED')
  }
  if (/"(?:apiKey|baseUrl|prompt|content)"\s*:/iu.test(serialized)) {
    throw new QualificationFailure('UNSAFE_RECEIPT_FIELD')
  }
}

function requireProfile(profile, label) {
  if (!profile || typeof profile !== 'object') throw new QualificationFailure(`MISSING_${label}`)
  if (!String(profile.apiKey || '').trim()) throw new QualificationFailure(`MISSING_${label}_KEY`)
  if (!String(profile.modelName || '').trim()) throw new QualificationFailure(`MISSING_${label}_MODEL`)
  if (!String(profile.baseUrl || '').trim()) throw new QualificationFailure(`MISSING_${label}_ENDPOINT`)
  return profile
}

function matchesOfficialTarget(profile, target, { matchModel = true } = {}) {
  return profile?.provider === target.provider
    && profile?.protocol === target.protocol
    && (!matchModel || String(profile?.modelName || '').trim() === target.modelName)
    && normalizeEndpoint(profile?.baseUrl) === target.baseUrl
}

function matchesOfficialOpenAiCompatibleCredentialSource(profile, target) {
  return (profile?.provider === target.provider || profile?.provider === 'custom')
    && profile?.protocol === target.protocol
    && normalizeEndpoint(profile?.baseUrl) === target.baseUrl
}

function assertQualificationTargets(profiles) {
  if (!Array.isArray(profiles) || profiles.length !== QUALIFICATION_TARGETS.length) {
    throw new QualificationFailure('THREE_PROFILES_REQUIRED')
  }
  for (let index = 0; index < QUALIFICATION_TARGETS.length; index += 1) {
    const profile = requireProfile(profiles[index], `TARGET_${index + 1}`)
    if (!matchesOfficialTarget(profile, QUALIFICATION_TARGETS[index])) {
      throw new QualificationFailure('QUALIFICATION_TARGET_MISMATCH')
    }
  }
}

/**
 * Builds three frozen, in-memory execution profiles. Profiles themselves are
 * never serialized; receipts expose only fixed model labels and hashed identity.
 */
export function createQualificationProfilesFromMemory({
  configuredProfiles,
  geminiApiKey,
}) {
  const profiles = Array.isArray(configuredProfiles) ? configuredProfiles : []
  const deepSeekTarget = QUALIFICATION_TARGETS[0]
  const grokTarget = QUALIFICATION_TARGETS[1]
  const geminiTarget = QUALIFICATION_TARGETS[2]
  const deepSeek = profiles.find(profile => matchesOfficialTarget(profile, deepSeekTarget))
  const grok = profiles.find(profile => (
    matchesOfficialOpenAiCompatibleCredentialSource(profile, grokTarget)
  ))
  if (!deepSeek) throw new QualificationFailure('DEEPSEEK_OFFICIAL_PROFILE_REQUIRED')
  if (!grok) throw new QualificationFailure('GROK_OFFICIAL_PROFILE_REQUIRED')

  const frozenDeepSeek = {
    ...cloneProfile(requireProfile(deepSeek, 'DEEPSEEK_PROFILE')),
    baseUrl: deepSeekTarget.baseUrl,
    qualificationPriceSnapshot: QUALIFICATION_PRICE_SNAPSHOTS[0],
  }
  const frozenGrok = {
    ...cloneProfile(requireProfile(grok, 'GROK_PROFILE')),
    id: `${grok.id}:qualification:grok-4.5`,
    provider: grokTarget.provider,
    protocol: grokTarget.protocol,
    modelName: grokTarget.modelName,
    baseUrl: grokTarget.baseUrl,
    maxTokens: QUALIFICATION_SAFETY_BUDGET.maxRequestedOutputTokensPerAttempt,
    capabilities: {
      contextWindowTokens: null,
      maxOutputTokens: QUALIFICATION_SAFETY_BUDGET.maxRequestedOutputTokensPerAttempt,
    },
    qualificationPriceSnapshot: QUALIFICATION_PRICE_SNAPSHOTS[1],
  }
  const frozenGemini = {
    id: 'qualification:gemini',
    name: 'Gemini qualification',
    provider: 'gemini',
    protocol: 'gemini',
    modelName: geminiTarget.modelName,
    apiKey: String(geminiApiKey || '').trim(),
    baseUrl: geminiTarget.baseUrl,
    temperature: 0.6,
    maxTokens: QUALIFICATION_SAFETY_BUDGET.maxRequestedOutputTokensPerAttempt,
    capabilities: {
      contextWindowTokens: null,
      maxOutputTokens: QUALIFICATION_SAFETY_BUDGET.maxRequestedOutputTokensPerAttempt,
      reasoning: true,
      structuredOutput: true,
      usage: true,
    },
    purposes: ['generation'],
    qualificationPriceSnapshot: QUALIFICATION_PRICE_SNAPSHOTS[2],
  }
  requireProfile(frozenGemini, 'GEMINI_PROFILE')

  const qualificationProfiles = [frozenDeepSeek, frozenGrok, frozenGemini].map(freezeProfile)
  assertQualificationTargets(qualificationProfiles)
  return qualificationProfiles
}

function readTextOrNull(filePath) {
  try {
    return readFileSync(filePath, 'utf8').trim()
  } catch {
    return null
  }
}

function resolveGitDirectory(repositoryRoot) {
  const dotGitPath = path.join(repositoryRoot, '.git')
  const pointer = readTextOrNull(dotGitPath)
  if (pointer?.startsWith('gitdir:')) {
    return path.resolve(repositoryRoot, pointer.slice('gitdir:'.length).trim())
  }
  return dotGitPath
}

function resolveGitHeadSha(repositoryRoot) {
  const gitDirectory = resolveGitDirectory(repositoryRoot)
  const head = readTextOrNull(path.join(gitDirectory, 'HEAD'))
  if (!head) throw new QualificationFailure('SOURCE_SHA_UNAVAILABLE')
  if (/^[a-f0-9]{40,64}$/u.test(head)) return head
  if (!head.startsWith('ref:')) throw new QualificationFailure('SOURCE_SHA_INVALID')

  const reference = head.slice('ref:'.length).trim()
  const commonDirectoryPointer = readTextOrNull(path.join(gitDirectory, 'commondir'))
  const commonDirectory = commonDirectoryPointer
    ? path.resolve(gitDirectory, commonDirectoryPointer)
    : gitDirectory
  const looseReference = readTextOrNull(path.join(commonDirectory, reference))
    ?? readTextOrNull(path.join(gitDirectory, reference))
  if (looseReference && /^[a-f0-9]{40,64}$/u.test(looseReference)) return looseReference

  const packedReferences = readTextOrNull(path.join(commonDirectory, 'packed-refs'))
  const packedSha = packedReferences?.split(/\r?\n/u)
    .filter(line => line && !line.startsWith('#') && !line.startsWith('^'))
    .map(line => line.split(' '))
    .find(([, name]) => name === reference)?.[0]
  if (packedSha && /^[a-f0-9]{40,64}$/u.test(packedSha)) return packedSha
  throw new QualificationFailure('SOURCE_SHA_UNAVAILABLE')
}

function sanitizedChildEnvironment(environment = process.env) {
  const sanitized = Object.fromEntries(Object.entries(environment).filter(([name]) => (
    !/(?:key|token|secret|password|authorization|credential)/iu.test(name)
  )))
  // Avoid leaving a dangling GIT_CONFIG_COUNT after filtering KEY/VALUE pairs.
  // The command supplies its one required safe.directory rule explicitly.
  sanitized.GIT_CONFIG_COUNT = '0'
  sanitized.GIT_TERMINAL_PROMPT = '0'
  return sanitized
}

function isQualificationRuntimePath(filePath) {
  const normalized = filePath.replaceAll('\\', '/').replace(/^\.\//u, '')
  return normalized === '.vibe-owner.json' || normalized.startsWith('.runtime/')
}

function inspectQualificationSourceTree(repositoryRoot) {
  const result = spawnSync(
    'git',
    [
      '-c',
      `safe.directory=${path.resolve(repositoryRoot)}`,
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      windowsHide: true,
      env: sanitizedChildEnvironment(),
    },
  )
  if (result.status !== 0 || result.error) {
    throw new QualificationFailure('SOURCE_TREE_STATE_UNAVAILABLE')
  }
  const dirtyPaths = String(result.stdout || '')
    .split('\0')
    .filter(Boolean)
    .map(entry => (/^[ MARCUD?!]{2} /u.test(entry) ? entry.slice(3) : entry))
    .filter(filePath => !isQualificationRuntimePath(filePath))
  return Object.freeze({ clean: dirtyPaths.length === 0 })
}

export function assertQualificationSourceProvenance({
  mode,
  initialSha,
  finalSha,
  initialClean,
  finalClean,
}) {
  const stableAndClean = initialClean && finalClean && initialSha === finalSha
  if (mode === 'execute' && !stableAndClean) {
    throw new QualificationFailure('SOURCE_TREE_CHANGED')
  }
  return stableAndClean ? 'clean' : 'dirty-dry-run'
}

function promptUtf8Bytes(messages) {
  return Buffer.byteLength(canonicalJson(messages), 'utf8')
}

function estimatedSnapshotUsd(snapshot, promptTokenUpperBound, requestedOutputTokens) {
  return (
    (promptTokenUpperBound * snapshot.inputUsdPerMillionTokens)
    + (requestedOutputTokens * snapshot.outputUsdPerMillionTokens)
  ) / 1_000_000
}

function currentQualificationPriceSnapshot(
  profile,
  at,
  estimatedInputEnvelope = QUALIFICATION_PROVIDER_LIMITS.maxEstimatedInputTokens,
) {
  const expected = QUALIFICATION_PRICE_SNAPSHOTS.find(snapshot => (
    snapshot.provider === profile.provider && snapshot.modelName === profile.modelName
  ))
  const candidate = profile.qualificationPriceSnapshot
  if (!expected || !candidate || canonicalJson(candidate) !== canonicalJson(expected)) return null
  const capturedAt = Date.parse(`${candidate.asOf}T00:00:00.000Z`)
  const maximumAge = QUALIFICATION_PRICE_SNAPSHOT_MAX_AGE_DAYS * 24 * 60 * 60 * 1_000
  if (!Number.isFinite(capturedAt) || at < capturedAt || at - capturedAt > maximumAge) return null
  if (
    Number.isSafeInteger(candidate.maximumEstimatedInputTokens)
    && estimatedInputEnvelope > candidate.maximumEstimatedInputTokens
  ) return null
  return candidate
}

function roundedUsd(value) {
  return Number(value.toFixed(6))
}

/**
 * One preflight ledger exists before product runtime loading. Every physical
 * completion reserves campaign and provider capacity before its delegate can
 * call fetch. Prompt UTF-8 bytes are a conservative hard input-token estimate:
 * a UTF-8 token cannot contain less than one byte. Dollar values are optional,
 * snapshot-based estimates and never participate in authorization.
 */
function createQualificationPreflightLedger({ profiles, campaignStartedAt, now }) {
  const campaignDeadlineAt = campaignStartedAt + QUALIFICATION_CAMPAIGN_LIMITS.deadlineMs
  const campaign = {
    calls: 0,
    requestedOutputTokens: 0,
    promptUtf8Bytes: 0,
    estimatedInputTokens: 0,
  }
  const providers = new Map(profiles.map(profile => [sha256(nonSecretModelIdentity(profile)), {
    startedAt: null,
    deadlineAt: null,
    calls: 0,
    requestedOutputTokens: 0,
    promptUtf8Bytes: 0,
    estimatedInputTokens: 0,
    blueprintResponseFormat: null,
  }]))

  const stateFor = profile => {
    const state = providers.get(sha256(nonSecretModelIdentity(profile)))
    if (!state) throw new QualificationFailure('UNREGISTERED_PREFLIGHT_PROFILE')
    return state
  }

  const ensureCampaignAlive = at => {
    if (at >= campaignDeadlineAt) {
      throw new QualificationFailure('CAMPAIGN_DEADLINE_EXHAUSTED')
    }
  }

  return Object.freeze({
    campaignDeadlineAt,
    beginProvider(profile, startedAt) {
      ensureCampaignAlive(startedAt)
      const state = stateFor(profile)
      if (state.startedAt !== null) throw new QualificationFailure('PREFLIGHT_PROFILE_REOPENED')
      state.startedAt = startedAt
      state.deadlineAt = Math.min(
        startedAt + QUALIFICATION_PROVIDER_LIMITS.deadlineMs,
        campaignDeadlineAt,
      )
      return state.deadlineAt
    },
    reserve(profile, request) {
      const at = now()
      ensureCampaignAlive(at)
      const state = stateFor(profile)
      if (state.deadlineAt === null || at >= state.deadlineAt) {
        throw new QualificationFailure('PROVIDER_DEADLINE_EXHAUSTED')
      }
      const requestedOutputTokens = request?.plan?.maxOutputTokens
      if (
        !Number.isSafeInteger(requestedOutputTokens)
        || requestedOutputTokens < 1
        || requestedOutputTokens
          > QUALIFICATION_PROVIDER_LIMITS.maxRequestedOutputTokensPerAttempt
        || !Array.isArray(request.messages)
      ) {
        throw new QualificationFailure('INVALID_PREFLIGHT_REQUEST')
      }
      const requestPromptUtf8Bytes = promptUtf8Bytes(request.messages)
      const requestEstimatedInputTokens = requestPromptUtf8Bytes
        + QUALIFICATION_INPUT_ESTIMATE_POLICY.fixedProtocolOverheadTokensPerCall
      if (requestPromptUtf8Bytes > QUALIFICATION_PROVIDER_LIMITS.maxPromptUtf8BytesPerCall) {
        throw new QualificationFailure('PROMPT_PREFLIGHT_LIMIT')
      }
      if (
        requestEstimatedInputTokens
          > QUALIFICATION_PROVIDER_LIMITS.maxEstimatedInputTokensPerCall
      ) {
        throw new QualificationFailure('INPUT_ESTIMATE_PREFLIGHT_LIMIT')
      }
      const providerNext = {
        calls: state.calls + 1,
        requestedOutputTokens: state.requestedOutputTokens + requestedOutputTokens,
        promptUtf8Bytes: state.promptUtf8Bytes + requestPromptUtf8Bytes,
        estimatedInputTokens: state.estimatedInputTokens + requestEstimatedInputTokens,
      }
      const campaignNext = {
        calls: campaign.calls + 1,
        requestedOutputTokens: campaign.requestedOutputTokens + requestedOutputTokens,
        promptUtf8Bytes: campaign.promptUtf8Bytes + requestPromptUtf8Bytes,
        estimatedInputTokens: campaign.estimatedInputTokens + requestEstimatedInputTokens,
      }
      if (
        providerNext.calls > QUALIFICATION_PROVIDER_LIMITS.maxCalls
        || providerNext.requestedOutputTokens
          > QUALIFICATION_PROVIDER_LIMITS.maxRequestedOutputTokens
        || providerNext.promptUtf8Bytes > QUALIFICATION_PROVIDER_LIMITS.maxPromptUtf8Bytes
        || providerNext.estimatedInputTokens
          > QUALIFICATION_PROVIDER_LIMITS.maxEstimatedInputTokens
      ) {
        throw new QualificationFailure('PROVIDER_PREFLIGHT_BUDGET_EXHAUSTED')
      }
      if (
        campaignNext.calls > QUALIFICATION_CAMPAIGN_LIMITS.maxCalls
        || campaignNext.requestedOutputTokens
          > QUALIFICATION_CAMPAIGN_LIMITS.maxRequestedOutputTokens
        || campaignNext.promptUtf8Bytes > QUALIFICATION_CAMPAIGN_LIMITS.maxPromptUtf8Bytes
        || campaignNext.estimatedInputTokens
          > QUALIFICATION_CAMPAIGN_LIMITS.maxEstimatedInputTokens
      ) {
        throw new QualificationFailure('CAMPAIGN_PREFLIGHT_BUDGET_EXHAUSTED')
      }
      Object.assign(state, providerNext)
      Object.assign(campaign, campaignNext)
      if (request.purpose === 'qualification-blueprints') {
        const responseFormat = request.plan?.responseFormat?.type ?? null
        if (
          state.blueprintResponseFormat !== null
          && state.blueprintResponseFormat !== responseFormat
        ) {
          throw new QualificationFailure('BLUEPRINT_RESPONSE_FORMAT_DRIFT')
        }
        state.blueprintResponseFormat = responseFormat
      }
    },
    providerSnapshot(profile) {
      const state = stateFor(profile)
      const priceSnapshot = currentQualificationPriceSnapshot(profile, now())
      return {
        maxCalls: QUALIFICATION_PROVIDER_LIMITS.maxCalls,
        calls: state.calls,
        maxRequestedOutputTokens: QUALIFICATION_PROVIDER_LIMITS.maxRequestedOutputTokens,
        requestedOutputTokens: state.requestedOutputTokens,
        maxPromptUtf8Bytes: QUALIFICATION_PROVIDER_LIMITS.maxPromptUtf8Bytes,
        promptUtf8Bytes: state.promptUtf8Bytes,
        maxEstimatedInputTokens: QUALIFICATION_PROVIDER_LIMITS.maxEstimatedInputTokens,
        estimatedInputTokens: state.estimatedInputTokens,
        deadlineAt: state.deadlineAt,
        blueprintResponseFormat: state.blueprintResponseFormat,
        priceEstimateStatus: priceSnapshot ? 'current-snapshot' : 'unavailable',
        ...(priceSnapshot ? {
          priceSnapshot: { ...priceSnapshot },
          estimatedReservedUsd: roundedUsd(estimatedSnapshotUsd(
            priceSnapshot,
            state.estimatedInputTokens,
            state.requestedOutputTokens,
          )),
          estimatedWorstCaseUsd: roundedUsd(estimatedSnapshotUsd(
            priceSnapshot,
            QUALIFICATION_PROVIDER_LIMITS.maxEstimatedInputTokens,
            QUALIFICATION_PROVIDER_LIMITS.maxRequestedOutputTokens,
          )),
        } : {}),
      }
    },
    campaignSnapshot() {
      ensureCampaignAlive(now())
      const pricedProviders = profiles.map(profile => ({
        snapshot: currentQualificationPriceSnapshot(profile, now()),
        state: stateFor(profile),
      }))
      const completePriceEstimate = pricedProviders.every(entry => entry.snapshot)
      return {
        startedAt: campaignStartedAt,
        deadlineAt: campaignDeadlineAt,
        maxCalls: QUALIFICATION_CAMPAIGN_LIMITS.maxCalls,
        calls: campaign.calls,
        maxRequestedOutputTokens: QUALIFICATION_CAMPAIGN_LIMITS.maxRequestedOutputTokens,
        requestedOutputTokens: campaign.requestedOutputTokens,
        maxPromptUtf8Bytes: QUALIFICATION_CAMPAIGN_LIMITS.maxPromptUtf8Bytes,
        promptUtf8Bytes: campaign.promptUtf8Bytes,
        maxEstimatedInputTokens: QUALIFICATION_CAMPAIGN_LIMITS.maxEstimatedInputTokens,
        estimatedInputTokens: campaign.estimatedInputTokens,
        priceEstimateStatus: completePriceEstimate
          ? 'complete-current-snapshots'
          : 'partial-unavailable',
        ...(completePriceEstimate ? {
          estimatedReservedUsd: roundedUsd(pricedProviders.reduce((total, entry) => (
            total + estimatedSnapshotUsd(
              entry.snapshot,
              entry.state.estimatedInputTokens,
              entry.state.requestedOutputTokens,
            )
          ), 0)),
          estimatedWorstCaseUsd: roundedUsd(pricedProviders.reduce((total, entry) => (
            total + estimatedSnapshotUsd(
              entry.snapshot,
              QUALIFICATION_PROVIDER_LIMITS.maxEstimatedInputTokens,
              QUALIFICATION_PROVIDER_LIMITS.maxRequestedOutputTokens,
            )
          ), 0)),
        } : {}),
      }
    },
  })
}

async function loadProductRuntime(repositoryRoot) {
  const resolvedRoot = path.resolve(repositoryRoot)
  const cached = productRuntimeCache.get(resolvedRoot)
  if (cached) return cached

  const loading = (async () => {
    const { build } = await import('esbuild')
    const result = await build({
      absWorkingDir: resolvedRoot,
      stdin: {
        contents: [
          "export { createGenerationRuntime } from './src/services/generation/generation-runtime.ts'",
          "export { createStructuredBatchExecutor } from './src/services/workflows/structured-batch-executor.ts'",
          "export { LLMFactory } from './electron/llm/llm-factory.ts'",
          "export { resolveGenerationParameters } from './electron/llm/generation-parameter-policy.ts'",
          "export { createModelExecutionLeaseReceipt } from './electron/services/model-execution-lease.ts'",
          "export { parseBlueprintSemanticResponseText, validateBlueprintSemanticItem } from './src/shared/blueprint-semantic-contract.ts'",
          "export { BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST } from './src/shared/blueprint-semantic-contract.ts'",
        ].join('\n'),
        loader: 'ts',
        resolveDir: resolvedRoot,
        sourcefile: 'real-provider-generation-qualification-entry.ts',
      },
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      write: false,
      logLevel: 'silent',
    })
    const bundledSource = result.outputFiles?.[0]?.text
    if (!bundledSource) throw new QualificationFailure('PRODUCT_RUNTIME_BUILD_FAILED')
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundledSource).toString('base64')}`
    return import(moduleUrl)
  })()
  productRuntimeCache.set(resolvedRoot, loading)
  return loading
}

function dryRunCompletion(fixture) {
  return async request => {
    if (request.purpose === 'qualification-blueprints') {
      const blueprints = fixture.blueprintChapterNumbers.map(chapterNumber => ({
        chapterNumber,
        title: `测试章${chapterNumber}`,
        role: '推进主线',
        purpose: `完成第${chapterNumber}章的因果推进`,
        keyEvents: `第${chapterNumber}章完成一个可验证的因果推进。`,
        characters: ['林岚', '周砚'],
        relationships: [{ from: '林岚', to: '周砚', relation: '共同查案' }],
        suspenseHook: `第${chapterNumber}封信留下新的时间矛盾。`,
      }))
      return {
        content: JSON.stringify({ blueprints }),
        finishReason: 'stop',
        usage: { promptTokens: 100, completionTokens: 300, totalTokens: 400 },
      }
    }
    if (request.purpose === 'qualification-draft') {
      return {
        content: '文'.repeat(fixture.draftTargetCharacters),
        finishReason: 'stop',
        usage: { promptTokens: 200, completionTokens: 5000, totalTokens: 5200 },
      }
    }
    throw new QualificationFailure('UNKNOWN_DRY_RUN_TASK')
  }
}

function realProviderCompletion(productRuntime, profile) {
  const provider = productRuntime.LLMFactory.getProvider(profile)
  return request => new Promise((resolve, reject) => {
    let settled = false
    const succeed = (content, usage, finishReason) => {
      if (settled) return
      settled = true
      resolve({ content, usage, finishReason })
    }
    const fail = () => {
      if (settled) return
      settled = true
      reject(new QualificationFailure('PROVIDER_REQUEST_FAILED'))
    }
    try {
      const parameters = productRuntime.resolveGenerationParameters(profile, {
        maxTokens: request.plan.maxOutputTokens,
        responseFormat: request.plan.responseFormat,
      })
      Promise.resolve(provider.generateStream(profile, [...request.messages], {
        ...parameters,
        signal: request.signal,
        onChunk: () => {},
        onDone: succeed,
        onError: fail,
      })).catch(fail)
    } catch {
      fail()
    }
  })
}

function blueprintContract(productRuntime, fixture) {
  let activeBatchChapterNumbers = []
  return {
    buildTask: ({ items }) => {
      activeBatchChapterNumbers = [...items]
      return {
        purpose: 'qualification-blueprints',
        output: 'structured-data',
        messages: [
          {
            role: 'system',
            content: '你是严格的小说蓝图生成器，只返回 JSON。',
          },
          {
            role: 'user',
            content: `${fixture.architecture}\n请生成章节 ${items.join('、')} 的蓝图。`
              + '根对象必须是 blueprints；每项完整包含 chapterNumber、title、role、purpose、'
              + 'keyEvents、characters、relationships、suspenseHook。',
          },
        ],
      }
    },
    inputKey: chapterNumber => chapterNumber,
    outputKey: blueprint => blueprint.chapterNumber,
    decode: content => productRuntime.parseBlueprintSemanticResponseText(
      content,
      activeBatchChapterNumbers,
    ),
    validateItem: productRuntime.validateBlueprintSemanticItem,
  }
}

function draftTask(fixture, accumulatedDraft) {
  const continuation = accumulatedDraft.length > 0
  return {
    purpose: 'qualification-draft',
    output: 'visible-text',
    messages: [
      {
        role: 'system',
        content: '你是长篇小说正文生成器。正文必须连续、完整，不要解释。',
      },
      {
        role: 'user',
        content: continuation
          ? `下面正文尚未达到 ${fixture.draftTargetCharacters} 字，请无缝续写且不要重复：\n${accumulatedDraft}`
          : `${fixture.architecture}\n依据前三章蓝图，写第${fixture.draftChapterNumber}章完整正文，`
            + `不少于 ${fixture.draftTargetCharacters} 字。`,
      },
    ],
  }
}

function summarizedUsage(attempts) {
  const known = attempts.filter(attempt => attempt.usage)
  const sum = key => known.reduce((total, attempt) => {
    const value = attempt.usage?.[key]
    return typeof value === 'number' ? total + value : total
  }, 0)
  return {
    callsWithUsage: known.length,
    promptTokens: sum('promptTokens'),
    completionTokens: sum('completionTokens'),
    totalTokens: sum('totalTokens'),
  }
}

export function classifyStructuredResponseEnvelope(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return 'empty'
  if (/^```(?:json)?\s*[\s\S]*\s*```$/iu.test(trimmed)) return 'fenced-json'
  if (trimmed.startsWith('```')) return 'malformed-fence'
  if (trimmed.startsWith('{')) return 'direct-object'
  if (trimmed.startsWith('[')) return 'direct-array'
  if (trimmed.startsWith('"')) return 'json-string'
  return 'prose'
}

export function blueprintQualificationFailureCode(profile, failure, responseEnvelope = 'unrecognized') {
  const provider = new Set(['deepseek', 'xai', 'gemini']).has(profile?.provider)
    ? profile.provider.toUpperCase()
    : 'UNKNOWN'
  const code = new Set([
    'generation_failed', 'invalid_output', 'limit_exceeded', 'cancelled', 'deadline',
  ]).has(failure?.code)
    ? failure.code.toUpperCase()
    : 'UNKNOWN'
  const reason = new Set([
    'server_error', 'authentication', 'safety', 'cancelled', 'deadline', 'unknown',
    'missing_item', 'duplicate_item', 'unexpected_item', 'invalid_item',
    'malformed_output', 'output_limit', 'max_calls', 'max_requested_tokens',
    'invalid_limit',
  ]).has(failure?.reason)
    ? failure.reason.toUpperCase()
    : 'UNKNOWN'
  const envelope = new Set([
    'empty', 'direct-object', 'direct-array', 'fenced-json', 'malformed-fence',
    'json-string', 'prose', 'unrecognized',
  ]).has(responseEnvelope)
    ? responseEnvelope.toUpperCase().replaceAll('-', '_')
    : 'UNRECOGNIZED'
  return `${provider}_BLUEPRINT_${code}_${reason}_${envelope}`
}

async function qualifyOneProfile({
  mode,
  profile,
  productRuntime,
  fixture,
  preflightLedger,
  now,
}) {
  const startedAt = now()
  preflightLedger.beginProvider(profile, startedAt)
  const identity = nonSecretModelIdentity(profile)
  const adapterIdentitySha256 = sha256(identity)
  const physicalCompletion = mode === 'dry-run'
    ? dryRunCompletion(fixture)
    : realProviderCompletion(productRuntime, profile)
  let lastStructuredResponseEnvelope = 'unrecognized'
  const guardedCompletion = async request => {
    preflightLedger.reserve(profile, request)
    const result = await physicalCompletion(request)
    if (request.purpose === 'qualification-blueprints') {
      lastStructuredResponseEnvelope = classifyStructuredResponseEnvelope(result.content)
    }
    return result
  }
  const leaseId = `qualification-adapter-lease:${adapterIdentitySha256}`
  const lease = Object.freeze(productRuntime.createModelExecutionLeaseReceipt(profile, {
    leaseId,
    createdAt: startedAt,
    expiresAt: startedAt + QUALIFICATION_PROVIDER_LIMITS.deadlineMs,
  }))
  const completionLeaseIds = new Set()
  let leaseBegins = 0
  let leaseCloses = 0
  const runtimeEnvironment = {
    snapshotDefaultModelId: () => profile.id,
    beginModelExecution(modelId) {
      if (modelId !== profile.id) throw new QualificationFailure('ADAPTER_LEASE_MODEL_DRIFT')
      leaseBegins += 1
      return Promise.resolve(lease)
    },
    completeWithLease(request) {
      if (request.leaseId !== lease.leaseId) {
        return Promise.reject(new QualificationFailure('ADAPTER_LEASE_ID_DRIFT'))
      }
      completionLeaseIds.add(request.leaseId)
      return guardedCompletion(request)
    },
    closeModelExecution(leaseId) {
      if (leaseId !== lease.leaseId) {
        return Promise.reject(new QualificationFailure('ADAPTER_LEASE_ID_DRIFT'))
      }
      leaseCloses += 1
      return Promise.resolve()
    },
  }
  const runtime = await productRuntime.createGenerationRuntime(
    { budget: QUALIFICATION_SAFETY_BUDGET },
    runtimeEnvironment,
  )
  const generationResult = await runtime.execute(async ({ session }) => {
    const executor = productRuntime.createStructuredBatchExecutor({
      contract: blueprintContract(productRuntime, fixture),
      session,
    })
    const blueprintResult = await executor.execute({
      items: fixture.blueprintChapterNumbers,
      limits: {
        maxBatchItems: fixture.blueprintChapterNumbers.length,
      },
    })
    if (!blueprintResult.ok) {
      throw new QualificationFailure(blueprintQualificationFailureCode(
        profile,
        blueprintResult.failure,
        lastStructuredResponseEnvelope,
      ))
    }

    const draftAttempts = []
    let draft = ''
    let explicitlyStopped = false
    while (!explicitlyStopped || draft.length < fixture.draftTargetCharacters) {
      const outcome = await session.complete(draftTask(fixture, draft))
      draftAttempts.push(outcome.receipt)
      if (!outcome.content) throw new QualificationFailure('EMPTY_DRAFT_OUTPUT')
      draft += outcome.content
      if (outcome.status === 'completed') {
        explicitlyStopped = true
        continue
      }
      if (outcome.finishReason !== 'length') {
        throw new QualificationFailure('DRAFT_TERMINAL_EVIDENCE_FAILED')
      }
      explicitlyStopped = false
    }

    return {
      attempts: [...blueprintResult.receipt.attempts, ...draftAttempts],
      blueprints: blueprintResult.items,
      draft,
    }
  })

  const { attempts, blueprints, draft } = generationResult
  const requestedOutputTokens = attempts.reduce(
    (total, attempt) => total + attempt.budget.requestedOutputTokens,
    0,
  )
  const preflight = preflightLedger.providerSnapshot(profile)
  if (preflight.calls !== attempts.length || preflight.requestedOutputTokens !== requestedOutputTokens) {
    throw new QualificationFailure('PREFLIGHT_RECEIPT_MISMATCH')
  }
  const receiptCore = {
    provider: profile.provider,
    modelName: profile.modelName,
    modelIdentitySha256: lease.modelRevision,
    endpointFingerprintSha256: lease.endpointFingerprint,
    fixtureHash: sha256(fixture),
    startedAt,
    deadlineAt: preflight.deadlineAt,
    calls: attempts.length,
    requestedOutputTokens,
    maxPromptUtf8Bytes: preflight.maxPromptUtf8Bytes,
    promptUtf8Bytes: preflight.promptUtf8Bytes,
    maxEstimatedInputTokens: preflight.maxEstimatedInputTokens,
    estimatedInputTokens: preflight.estimatedInputTokens,
    capabilityEvidence: lease.capabilityEvidence,
    blueprintResponseFormat: preflight.blueprintResponseFormat,
    priceEstimateStatus: preflight.priceEstimateStatus,
    ...(preflight.priceSnapshot ? {
      priceSnapshot: preflight.priceSnapshot,
      estimatedReservedUsd: preflight.estimatedReservedUsd,
      estimatedWorstCaseUsd: preflight.estimatedWorstCaseUsd,
    } : {}),
    maxRequestedOutputTokensInOneAttempt: Math.max(
      0,
      ...attempts.map(attempt => attempt.budget.requestedOutputTokens),
    ),
    finishReasons: attempts.map(attempt => attempt.finishReason),
    blueprintCount: blueprints.length,
    blueprintSha256: sha256(blueprints),
    draftCharacters: draft.length,
    draftSha256: sha256(draft),
    usage: summarizedUsage(attempts),
    runtimeLease: {
      begins: leaseBegins,
      closes: leaseCloses,
      oneLeaseAcrossAttempts: completionLeaseIds.size === 1
        && completionLeaseIds.has(lease.leaseId),
    },
  }
  return {
    ...receiptCore,
    receiptChecksumSha256: sha256(receiptCore),
  }
}

/**
 * Runs profiles sequentially so the safety budget is independently enforced
 * and auditable for each provider. This function never persists profiles,
 * prompts, generated prose, endpoints, or credentials.
 */
export async function runRealProviderGenerationQualification(options = {}) {
  assertQualificationOutputSchemaSafe()
  if (Object.hasOwn(options, 'budget')) {
    throw new QualificationFailure('BUDGET_OVERRIDE_FORBIDDEN')
  }
  if (Object.hasOwn(options, 'fixture')) {
    throw new QualificationFailure('FIXTURE_OVERRIDE_FORBIDDEN')
  }
  if (Object.hasOwn(options, 'now')) {
    throw new QualificationFailure('CLOCK_OVERRIDE_FORBIDDEN')
  }
  const {
    mode = 'dry-run',
    profiles,
    repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    allowBillableRequests = false,
  } = options
  if (!['dry-run', 'execute'].includes(mode)) throw new QualificationFailure('INVALID_MODE')
  if (mode === 'execute' && allowBillableRequests !== true) {
    throw new QualificationFailure('BILLABLE_CONFIRMATION_REQUIRED')
  }

  assertQualificationTargets(profiles)
  const frozenProfiles = profiles.map(freezeProfile)
  assertQualificationTargets(frozenProfiles)
  const secretMarkers = frozenProfiles.flatMap(secretMarkersForProfile)
  const sourceSha = resolveGitHeadSha(repositoryRoot)
  const sourceTree = inspectQualificationSourceTree(repositoryRoot)
  if (mode === 'execute' && !sourceTree.clean) {
    throw new QualificationFailure('SOURCE_TREE_DIRTY')
  }
  const campaignStartedAt = Date.now()
  const preflightLedger = createQualificationPreflightLedger({
    profiles: frozenProfiles,
    campaignStartedAt,
    now: Date.now,
  })
  // The shared ledger and receipt schema both exist before loading any provider
  // adapter; every eventual fetch is behind ledger.reserve().
  const productRuntime = await loadProductRuntime(repositoryRoot)
  const providerReceipts = []
  for (const profile of frozenProfiles) {
    providerReceipts.push(await qualifyOneProfile({
      mode,
      profile,
      productRuntime,
      fixture: QUALIFICATION_FIXTURE,
      preflightLedger,
      now: Date.now,
    }))
  }

  const campaignReceipt = preflightLedger.campaignSnapshot()
  const finalSourceSha = resolveGitHeadSha(repositoryRoot)
  const finalSourceTree = inspectQualificationSourceTree(repositoryRoot)
  const sourceTreeState = assertQualificationSourceProvenance({
    mode,
    initialSha: sourceSha,
    finalSha: finalSourceSha,
    initialClean: sourceTree.clean,
    finalClean: finalSourceTree.clean,
  })

  const fixtureHash = sha256(QUALIFICATION_FIXTURE)
  const fixtureReceipt = {
    id: QUALIFICATION_FIXTURE.id,
    blueprintChapterCount: QUALIFICATION_FIXTURE.blueprintChapterNumbers.length,
    draftTargetCharacters: QUALIFICATION_FIXTURE.draftTargetCharacters,
    fixtureHash,
  }
  const receiptCore = {
    schemaVersion: 2,
    kind: 'real-provider-generation-qualification',
    mode,
    qualificationScope: 'provider-adapter',
    executionSeam: 'generation-runtime-with-in-memory-adapter-lease',
    limitations: [
      'does-not-exercise-electron-ipc-main-process-lease',
      'checksum-provides-integrity-not-authenticity',
      'dollar-values-are-snapshot-estimates-not-hard-billing-caps',
      'price-estimates-require-the-hard-input-envelope-to-fit-the-snapshot-scope',
      'input-token-estimate-is-utf8-bytes-plus-fixed-protocol-overhead',
    ],
    provenance: {
      sourceSha,
      sourceTreeState,
      fixtureHash,
      semanticContractHash: sha256({
        blueprints: productRuntime.BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST,
        draft: QUALIFICATION_DRAFT_CONTRACT,
      }),
      generationPolicyHash: sha256(QUALIFICATION_GENERATION_POLICY),
    },
    fixture: fixtureReceipt,
    safetyBudget: { ...QUALIFICATION_SAFETY_BUDGET },
    inputEstimatePolicy: { ...QUALIFICATION_INPUT_ESTIMATE_POLICY },
    campaign: campaignReceipt,
    providers: providerReceipts,
    checksumAlgorithm: 'sha256',
  }
  const receipt = {
    ...receiptCore,
    checksumSha256: sha256(receiptCore),
  }
  assertReceiptMatchesOutputSchema(receipt)
  assertSecretFree(receipt, secretMarkers)
  if (!verifyQualificationReceiptChecksum(receipt)) {
    throw new QualificationFailure('RECEIPT_CHECKSUM_FAILED')
  }
  return receipt
}

function clipboardSecret() {
  if (process.platform === 'win32') {
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'],
      { encoding: 'utf8', windowsHide: true },
    )
    if (result.status === 0) return String(result.stdout || '').trim()
    return ''
  }
  if (process.platform === 'darwin') {
    const result = spawnSync('pbpaste', [], { encoding: 'utf8' })
    if (result.status === 0) return String(result.stdout || '').trim()
  }
  return ''
}

function configuredProfilesFromDisk(environment) {
  const velaHome = String(environment.AI_NOVEL_VELA_HOME || '').trim()
    || path.join(homedir(), '.vela')
  const parsed = JSON.parse(readFileSync(path.join(velaHome, 'models.json'), 'utf8'))
  if (!Array.isArray(parsed)) throw new QualificationFailure('INVALID_MODEL_CONFIG')
  return parsed
}

function dryRunProfiles() {
  return createQualificationProfilesFromMemory({
    configuredProfiles: [
      {
        id: 'dry-run-deepseek',
        name: 'Dry-run DeepSeek',
        provider: 'deepseek',
        protocol: 'openai',
        modelName: 'deepseek-v4-flash',
        apiKey: 'dry-run-deepseek-memory-only',
        baseUrl: 'https://api.deepseek.com',
        temperature: 0.6,
        maxTokens: 8192,
        purposes: ['generation'],
      },
      {
        id: 'dry-run-grok',
        name: 'Dry-run Grok',
        provider: 'xai',
        protocol: 'openai',
        modelName: 'dry-run-grok',
        apiKey: 'dry-run-grok-memory-only',
        baseUrl: 'https://api.x.ai/v1',
        temperature: 0.6,
        maxTokens: 8192,
        purposes: ['generation'],
      },
    ],
    geminiApiKey: 'dry-run-gemini-memory-only',
  })
}

function parseCli(arguments_) {
  let mode = 'dry-run'
  let geminiKeySource = 'env'
  for (const argument of arguments_) {
    if (argument === '--dry-run') mode = 'dry-run'
    else if (argument === '--execute') mode = 'execute'
    else if (argument === '--gemini-key-source=env') geminiKeySource = 'env'
    else if (argument === '--gemini-key-source=clipboard') geminiKeySource = 'clipboard'
    else throw new QualificationFailure('UNSUPPORTED_ARGUMENT')
  }
  return { mode, geminiKeySource }
}

async function runCli() {
  const options = parseCli(process.argv.slice(2))
  let profiles
  let allowBillableRequests = false
  if (options.mode === 'execute') {
    allowBillableRequests = process.env.AI_NOVEL_REAL_PROVIDER_QUALIFICATION === BILLABLE_CONFIRMATION
    if (!allowBillableRequests) throw new QualificationFailure('BILLABLE_CONFIRMATION_REQUIRED')
    const geminiApiKey = options.geminiKeySource === 'clipboard'
      ? clipboardSecret()
      : String(process.env[GEMINI_KEY_ENV] || '').trim()
    profiles = createQualificationProfilesFromMemory({
      configuredProfiles: configuredProfilesFromDisk(process.env),
      geminiApiKey,
    })
  } else {
    profiles = dryRunProfiles()
  }

  const receipt = await runRealProviderGenerationQualification({
    mode: options.mode,
    profiles,
    allowBillableRequests,
  })
  process.stdout.write(`${JSON.stringify(receipt)}\n`)
}

const invokedAsMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedAsMain) {
  runCli().catch(error => {
    const code = error instanceof QualificationFailure ? error.code : 'UNEXPECTED_FAILURE'
    process.stderr.write(`Real provider qualification failed: ${code}\n`)
    process.exitCode = 1
  })
}
