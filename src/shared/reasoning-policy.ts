import type { ModelProfile } from './ipc-channels'
import { resolveModelProfileReasoningMapping } from './provider-presets'
import type {
  CreativeStrategy,
  EffectiveReasoningEffort,
  ProviderReasoningDirective,
  ReasoningEffort,
  ReasoningPolicyResolution,
  VerifiedReasoningMapping,
} from './reasoning-types'
import { CREATIVE_STRATEGIES, REASONING_EFFORTS } from './reasoning-types'

type GenerationStage = 'drafting' | 'planning' | 'review' | 'general'

const STAGE_REQUESTS: Readonly<Record<CreativeStrategy, Readonly<Record<GenerationStage, ReasoningEffort>>>> = {
  auto: { drafting: 'low', planning: 'medium', review: 'high', general: 'low' },
  'fluent-drafting': { drafting: 'off', planning: 'low', review: 'low', general: 'low' },
  'consistency-first': { drafting: 'low', planning: 'high', review: 'high', general: 'medium' },
  'deep-planning': { drafting: 'low', planning: 'high', review: 'high', general: 'medium' },
}

const EFFORT_RANK: Readonly<Record<ReasoningEffort, number>> = {
  off: 0,
  low: 1,
  medium: 2,
  high: 3,
  max: 4,
}

function generationStage(purpose: string): GenerationStage {
  const normalized = purpose.trim().toLowerCase()
  if (/(?:review|refin|post-process|revision)/u.test(normalized)) return 'review'
  if (/(?:architect|blueprint|director|planning|plan|config|character|structured|import-inference|summary)/u.test(normalized)) {
    return 'planning'
  }
  if (/(?:draft|continuation|writing|generation|agent)/u.test(normalized)) return 'drafting'
  return 'general'
}

function providerDirective(
  mapping: VerifiedReasoningMapping,
  effective: EffectiveReasoningEffort,
): ProviderReasoningDirective | undefined {
  const value = mapping.providerValues[effective]
  if (mapping.adapter === 'openai-reasoning-effort') {
    return value === 'low' || value === 'medium' || value === 'high'
      ? { adapter: mapping.adapter, reasoningEffort: value }
      : undefined
  }
  return typeof value === 'number'
    ? { adapter: mapping.adapter, thinkingBudget: value }
    : undefined
}

function closestEffectiveEffort(
  requested: ReasoningEffort,
  mapping: VerifiedReasoningMapping,
): { effective: EffectiveReasoningEffort; status: 'mapped' | 'capped' | 'forced' } | null {
  if (requested !== 'max' && mapping.supportedEfforts.includes(requested)) {
    return { effective: requested, status: 'mapped' }
  }
  const supported = [...mapping.supportedEfforts]
    .sort((left, right) => EFFORT_RANK[left] - EFFORT_RANK[right])
  if (supported.length === 0) return null
  if (requested === 'off') return { effective: supported[0], status: 'forced' }

  const lowerOrEqual = supported.filter(effort => EFFORT_RANK[effort] <= EFFORT_RANK[requested])
  return {
    effective: lowerOrEqual.at(-1) ?? supported[0],
    status: 'capped',
  }
}

/**
 * The single reasoning-policy seam. Callers provide product intent; this
 * module owns stage selection, profile precedence, verified capability lookup,
 * provider-level capping and the user-visible resolution receipt.
 */
export function resolveReasoningPolicy(input: {
  model: ModelProfile
  creativeStrategy?: CreativeStrategy
  purpose?: string
}): ReasoningPolicyResolution {
  const strategy = CREATIVE_STRATEGIES.includes(input.creativeStrategy as CreativeStrategy)
    ? input.creativeStrategy as CreativeStrategy
    : 'auto'
  const persistedOverride = input.model.reasoningOverride
  const override = persistedOverride === 'auto'
    || REASONING_EFFORTS.includes(persistedOverride as ReasoningEffort)
    ? persistedOverride ?? 'auto'
    : 'auto'
  const source = override === 'auto' ? 'project-strategy' : 'model-override'
  const requested = override === 'auto'
    ? STAGE_REQUESTS[strategy][generationStage(input.purpose ?? 'generation')]
    : override
  const mapping = resolveModelProfileReasoningMapping(input.model)
  if (!mapping) return { requested, effective: null, status: 'unsupported', source }

  const resolved = closestEffectiveEffort(requested, mapping)
  if (!resolved) return { requested, effective: null, status: 'unsupported', source }
  const directive = providerDirective(mapping, resolved.effective)
  if (!directive) return { requested, effective: null, status: 'unsupported', source }
  return {
    requested,
    effective: resolved.effective,
    status: resolved.status,
    source,
    providerDirective: directive,
  }
}
