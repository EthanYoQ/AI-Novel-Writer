export const CREATIVE_STRATEGIES = [
  'auto',
  'fluent-drafting',
  'consistency-first',
  'deep-planning',
] as const

export type CreativeStrategy = typeof CREATIVE_STRATEGIES[number]

/** Controlled semantic stage used by product callers; never inferred from a diagnostic name. */
export type GenerationReasoningStage = 'drafting' | 'planning' | 'review' | 'general'

export const REASONING_EFFORTS = ['off', 'low', 'medium', 'high', 'max'] as const
export type ReasoningEffort = typeof REASONING_EFFORTS[number]
export type EffectiveReasoningEffort = ReasoningEffort
export type ReasoningOverride = 'auto' | ReasoningEffort

export type ReasoningResolutionStatus = 'mapped' | 'capped' | 'forced' | 'unsupported'

export type ProviderReasoningDirective =
  | {
      adapter: 'openai-reasoning-effort'
      reasoningEffort: 'low' | 'medium' | 'high'
    }
  | {
      adapter: 'gemini-thinking-budget'
      thinkingBudget: number
    }
  | {
      adapter: 'deepseek-v4-thinking'
      thinking: 'disabled'
    }
  | {
      adapter: 'deepseek-v4-thinking'
      thinking: 'enabled'
      reasoningEffort: 'high' | 'max'
    }

export interface VerifiedReasoningMapping {
  adapter: ProviderReasoningDirective['adapter']
  supportedEfforts: readonly EffectiveReasoningEffort[]
  providerValues: Readonly<Partial<Record<EffectiveReasoningEffort, string | number>>>
  /** Documented compatibility aliases from a requested product effort to the provider's actual effort. */
  requestAliases?: Readonly<Partial<Record<ReasoningEffort, EffectiveReasoningEffort>>>
}

export interface ReasoningPolicyResolution {
  requested: ReasoningEffort
  effective: EffectiveReasoningEffort | null
  status: ReasoningResolutionStatus
  source: 'project-strategy' | 'model-override'
  providerDirective?: ProviderReasoningDirective
}
