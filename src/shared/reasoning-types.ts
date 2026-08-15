export const CREATIVE_STRATEGIES = [
  'auto',
  'fluent-drafting',
  'consistency-first',
  'deep-planning',
] as const

export type CreativeStrategy = typeof CREATIVE_STRATEGIES[number]

export const REASONING_EFFORTS = ['off', 'low', 'medium', 'high', 'max'] as const
export type ReasoningEffort = typeof REASONING_EFFORTS[number]
export type EffectiveReasoningEffort = Exclude<ReasoningEffort, 'max'>
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

export interface VerifiedReasoningMapping {
  adapter: ProviderReasoningDirective['adapter']
  supportedEfforts: readonly EffectiveReasoningEffort[]
  providerValues: Readonly<Partial<Record<EffectiveReasoningEffort, string | number>>>
}

export interface ReasoningPolicyResolution {
  requested: ReasoningEffort
  effective: EffectiveReasoningEffort | null
  status: ReasoningResolutionStatus
  source: 'project-strategy' | 'model-override'
  providerDirective?: ProviderReasoningDirective
}
