import type { ModelProfile } from './ipc-channels'
import { resolveModelProfileReasoningMapping } from './provider-presets'
import type {
  CreativeStrategy,
  EffectiveReasoningEffort,
  GenerationReasoningStage,
  ProviderReasoningDirective,
  ReasoningEffort,
  ReasoningPolicyResolution,
  VerifiedReasoningMapping,
} from './reasoning-types'
import { CREATIVE_STRATEGIES, REASONING_EFFORTS } from './reasoning-types'

const STAGE_REQUESTS: Readonly<Record<CreativeStrategy, Readonly<Record<GenerationReasoningStage, ReasoningEffort>>>> = {
  auto: { drafting: 'low', planning: 'medium', review: 'high', general: 'low' },
  'fluent-drafting': { drafting: 'off', planning: 'low', review: 'low', general: 'low' },
  'consistency-first': { drafting: 'low', planning: 'high', review: 'high', general: 'medium' },
  'deep-planning': { drafting: 'low', planning: 'max', review: 'high', general: 'medium' },
}

const EFFORT_RANK: Readonly<Record<ReasoningEffort, number>> = {
  off: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
}

function providerDirective(
  mapping: VerifiedReasoningMapping,
  effective: EffectiveReasoningEffort,
): ProviderReasoningDirective | undefined {
  const value = mapping.providerValues[effective]
  if (mapping.adapter === 'siliconflow-v4-thinking') {
    return (effective === 'high' || effective === 'max') && value === effective
      ? { adapter: mapping.adapter, reasoningEffort: effective }
      : undefined
  }
  if (mapping.adapter === 'openai-reasoning-effort') {
    return typeof value === 'string' && value.trim().length > 0
      ? { adapter: mapping.adapter, reasoningEffort: value }
      : undefined
  }
  if (mapping.adapter === 'deepseek-v4-thinking') {
    if (effective === 'off' && value === 'disabled') {
      return { adapter: mapping.adapter, thinking: 'disabled' }
    }
    if (effective !== 'off' && value === 'enabled') return { adapter: mapping.adapter, thinking: 'enabled' }
    return effective !== 'off' && (value === 'low' || value === 'high' || value === 'max')
      ? {
          adapter: mapping.adapter,
          thinking: 'enabled',
          reasoningEffort: value,
        }
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
  const documentedAlias = mapping.requestAliases?.[requested]
  if (documentedAlias && mapping.supportedEfforts.includes(documentedAlias)) {
    return { effective: documentedAlias, status: 'mapped' }
  }
  if (mapping.supportedEfforts.includes(requested)) {
    return { effective: requested, status: 'mapped' }
  }
  const supported = [...mapping.supportedEfforts]
    .sort((left, right) => EFFORT_RANK[left] - EFFORT_RANK[right])
  if (supported.length === 0) return null
  if (requested === 'off') return null

  const lowerOrEqual = supported.filter(effort => EFFORT_RANK[effort] <= EFFORT_RANK[requested])
  return {
    effective: lowerOrEqual.at(-1) ?? supported[0],
    status: 'capped',
  }
}

/**
 * The single reasoning-policy seam. Callers provide product intent; this
 * module owns profile precedence, verified capability lookup,
 * provider-level capping and the user-visible resolution receipt.
 */
export function resolveReasoningPolicy(input: {
  model: ModelProfile
  creativeStrategy?: CreativeStrategy
  stage?: GenerationReasoningStage
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
    ? STAGE_REQUESTS[strategy][input.stage ?? 'general']
    : override
  const mapping = resolveModelProfileReasoningMapping(input.model)
  if (!mapping) return { requested, effective: null, status: 'unsupported', source }
  // This scoped Qwen integration must not silently promote or cap other efforts.
  if (!input.model.reasoningMapping && input.model.modelName === 'Qwen/Qwen3.8-27B'
    && (source !== 'model-override' || requested !== 'medium')) {
    return { requested, effective: null, status: 'unsupported', source }
  }
  // Only explicit, documented SiliconFlow choices are supported. Preserve
  // automatic requests and never force off/low/medium up to high.
  if (!input.model.reasoningMapping && mapping.adapter === 'siliconflow-v4-thinking'
    && (source !== 'model-override' || requested !== 'high' && requested !== 'max')) {
    return { requested, effective: null, status: 'unsupported', source }
  }

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
