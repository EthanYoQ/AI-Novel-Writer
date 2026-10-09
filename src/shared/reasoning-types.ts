export const CREATIVE_STRATEGIES = [
  'auto',
  'fluent-drafting',
  'consistency-first',
  'deep-planning',
] as const

export type CreativeStrategy = typeof CREATIVE_STRATEGIES[number]

/** Controlled semantic stage used by product callers; never inferred from a diagnostic name. */
export type GenerationReasoningStage = 'drafting' | 'planning' | 'review' | 'general'

export const REASONING_EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ReasoningEffort = typeof REASONING_EFFORTS[number]
export type EffectiveReasoningEffort = ReasoningEffort
export type ReasoningOverride = 'auto' | ReasoningEffort

export type ReasoningResolutionStatus = 'mapped' | 'capped' | 'forced' | 'unsupported'

export type ProviderReasoningDirective =
  | {
      adapter: 'siliconflow-v4-thinking'
      reasoningEffort: 'high' | 'max'
    }
  | {
      adapter: 'openai-reasoning-effort'
      reasoningEffort: string
    }
  | {
      adapter: 'gemini-thinking-budget'
      thinkingBudget: number
    }
  | {
      adapter: 'openai-thinking-budget'
      /** Zero disables thinking; positive values budget thinking separately from the answer. */
      thinkingBudget: number
    }
  | {
      adapter: 'deepseek-v4-thinking'
      thinking: 'disabled'
    }
  | {
      adapter: 'deepseek-v4-thinking'
      thinking: 'enabled'
      reasoningEffort?: 'low' | 'high' | 'max'
    }

export interface VerifiedReasoningMapping {
  adapter: ProviderReasoningDirective['adapter']
  supportedEfforts: readonly EffectiveReasoningEffort[]
  providerValues: Readonly<Partial<Record<EffectiveReasoningEffort, string | number>>>
  /** Documented compatibility aliases from a requested product effort to the provider's actual effort. */
  requestAliases?: Readonly<Partial<Record<ReasoningEffort, EffectiveReasoningEffort>>>
}

/** Validate the existing finite adapter shape, including manually supplied mappings. */
export function isReasoningMapping(value: unknown): value is VerifiedReasoningMapping {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const mapping = value as VerifiedReasoningMapping
  if (!['openai-reasoning-effort', 'openai-thinking-budget', 'deepseek-v4-thinking', 'siliconflow-v4-thinking', 'gemini-thinking-budget'].includes(mapping.adapter)
    || !Array.isArray(mapping.supportedEfforts) || !mapping.supportedEfforts.length
    || mapping.supportedEfforts.length > REASONING_EFFORTS.length
    || new Set(mapping.supportedEfforts).size !== mapping.supportedEfforts.length
    || !mapping.providerValues || typeof mapping.providerValues !== 'object' || Array.isArray(mapping.providerValues)) return false
  if (Object.keys(mapping).some(key => !['adapter', 'supportedEfforts', 'providerValues', 'requestAliases'].includes(key))) return false
  if (Object.keys(mapping.providerValues).some(key => !mapping.supportedEfforts.includes(key as ReasoningEffort))) return false
  for (const effort of mapping.supportedEfforts as readonly ReasoningEffort[]) {
    if (!REASONING_EFFORTS.includes(effort)) return false
    const wire = mapping.providerValues[effort]
    if (mapping.adapter === 'openai-reasoning-effort') {
      if (typeof wire !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(wire)) return false
      if (effort === 'off' && !['off', 'none', 'disabled'].includes(wire)) return false
    } else if (mapping.adapter === 'gemini-thinking-budget' || mapping.adapter === 'openai-thinking-budget') {
      if (typeof wire !== 'number' || !Number.isSafeInteger(wire) || wire < 0 || effort === 'off' && wire !== 0) return false
      if (mapping.adapter === 'openai-thinking-budget' && effort !== 'off' && wire === 0) return false
    } else if (mapping.adapter === 'deepseek-v4-thinking') {
      if (typeof wire !== 'string' || (effort === 'off' ? wire !== 'disabled' : !['enabled', 'low', 'high', 'max'].includes(wire))) return false
    } else if (!['high', 'max'].includes(effort) || wire !== effort) return false
  }
  if (mapping.requestAliases !== undefined) {
    if (!mapping.requestAliases || typeof mapping.requestAliases !== 'object' || Array.isArray(mapping.requestAliases)) return false
    for (const [request, effective] of Object.entries(mapping.requestAliases)) {
      if (!REASONING_EFFORTS.includes(request as ReasoningEffort)
        || !mapping.supportedEfforts.includes(effective)
        || request === 'off' && effective !== 'off') return false
    }
  }
  return true
}

export interface ReasoningPolicyResolution {
  requested: ReasoningEffort
  effective: EffectiveReasoningEffort | null
  status: ReasoningResolutionStatus
  source: 'project-strategy' | 'model-override'
  providerDirective?: ProviderReasoningDirective
}
