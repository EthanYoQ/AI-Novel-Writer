import type { GenerationReasoningStage } from '../../shared/reasoning-types'
import type { WritingLanguage } from '../../shared/writing-language'

export const S07_TASK_BUDGET_POLICY = Object.freeze({
  version: 's07-task-budget-v1',
  // Semantic sizing supports scope planning. It is not a mathematical upper
  // bound for every provider tokenizer; physical liability remains hard-capped.
  outputEstimatorVersion: 'semantic-units-sizing-v1',
  draftUnits: Object.freeze({
    baseTokens: 512,
    tokensPerUnit: Object.freeze({
      'zh-CN': Object.freeze({ numerator: 12, denominator: 5 }),
      'en-US': Object.freeze({ numerator: 3, denominator: 2 }),
    }),
  }),
  structuredItems: Object.freeze({
    baseTokens: 512,
    tokensPerItem: Object.freeze({
      // Drafting/planning values are calibrated against the immutable chapter
      // blueprint fields and a frozen dense fixture. They size a request; they
      // do not promise that every contract-maximum payload fits one item.
      'zh-CN': Object.freeze({ drafting: 3_072, planning: 3_072, review: 512, general: 512 }),
      'en-US': Object.freeze({ drafting: 2_048, planning: 2_048, review: 384, general: 384 }),
    }),
  }),
})

export type TaskBudgetDemand =
  | {
      kind: 'draft-units'
      writingLanguage: WritingLanguage
      requestedUnits: number
      /** True only when the product can preserve each segment as an explicit candidate. */
      segmentable: boolean
    }
  | {
      kind: 'structured-items'
      writingLanguage: WritingLanguage
      requestedItems: number
    }

export type TaskBudgetCapabilitySource = 'verified-provider-preset' | 'unknown'

export interface TaskBudgetCapabilityConstraints {
  /** Provider capability proved by an exact endpoint/model preset; null means unknown. */
  modelContextWindowTokens: number | null
  /** Provider capability proved by an exact endpoint/model preset; null means unknown. */
  modelMaxOutputTokens: number | null
  modelContextSource: TaskBudgetCapabilitySource
  modelOutputSource: TaskBudgetCapabilitySource
  /** User operational limits restrict known provider capability but never prove it. */
  userContextWindowTokens: number | null
  userMaxOutputTokens: number | null
}

export type TaskBudgetLiabilityBound =
  | { mode: 'included-in-output' }
  | { mode: 'separate-bounded'; reasoningUpperBoundTokens: number }
  | {
      mode: 'total-bounded'
      /** Physical upper bound for input + output + reasoning + the safety margin. */
      totalLiabilityUpperBoundTokens: number
    }
  | { mode: 'unknown'; reasoningUpperBoundTokens?: number }

export interface TaskBudgetPlannerInput {
  stage: GenerationReasoningStage
  demand: TaskBudgetDemand
  inputEstimate: {
    upperBoundTokens: number
    estimatorVersion: string
  }
  capability: TaskBudgetCapabilityConstraints
  root: {
    maxOutputPerRequest: number
  }
  liability: TaskBudgetLiabilityBound
  safetyMarginTokens: number
}

export type TaskBudgetReasonCode =
  | 'task-demand'
  | 'output-allocation-ceiling'
  | 'input-upper-bound'
  | 'safety-margin'
  | 'model-output-cap'
  | 'user-output-cap'
  | 'root-output-cap'
  | 'protocol-reasoning-reserve'
  | 'protocol-total-bound'
  | 'model-capability-unknown'
  | 'liability-bound-unknown'
  | 'scope-split'

/** Written only by receipts persisted before ADR-0023; diagnostics still read them back. */
export type LegacyTaskBudgetReasonCode =
  | 'model-context-cap'
  | 'user-context-cap'
  | 'root-remaining-cap'
  | 'required-input-capacity-conflict'
  | 'single-item-capacity-conflict'
  | 'draft-segmentation-disabled'

export interface TaskBudgetReason {
  code: TaskBudgetReasonCode
  /** Non-sensitive numeric evidence behind this decision, when applicable. */
  valueTokens?: number
  selected: boolean
}

export type StoredTaskBudgetReason = Omit<TaskBudgetReason, 'code'> & { code: TaskBudgetReasonCode | LegacyTaskBudgetReasonCode }

export interface TaskBudgetDecision {
  policyVersion: typeof S07_TASK_BUDGET_POLICY.version
  outputEstimatorVersion: typeof S07_TASK_BUDGET_POLICY.outputEstimatorVersion
  inputEstimatorVersion: string
  decision: 'ready' | 'split-required'
  stage: GenerationReasoningStage
  writingLanguage: WritingLanguage
  demandKind: TaskBudgetDemand['kind']
  requestedQuantity: number
  selectedQuantity: number
  remainingQuantity: number
  /** Output need for the complete semantic scope before any capacity decision. */
  requestedOutputTokens: number
  /** Provider max output for this selected physical request. */
  reservedOutputTokens: number
  reasoningUpperBoundTokens: number
  reservationLiabilityTokens: number
  inputUpperBoundTokens: number
  reasons: readonly TaskBudgetReason[]
}

export interface GenerationBudgetDiagnostic {
  attemptId: string
  /** 账本按根列出全部请求；读回某次运行的结果时按它筛出本运行的请求。主进程总会填。 */
  runId?: string
  plannerVersion?: string
  requestedOutputTokens: number
  /** Full root-ledger reservation, including input/output/reasoning/safety. */
  reservedTokens: number
  actual: {
    input: number | null
    completion: number | null
    reasoning: number | null
    total: number | null
  } | null
  actualState: 'settled' | 'unknown' | 'reserved' | 'not-dispatched'
  finishReason?: string | null
  failureCode?: string | null
  reasons: readonly StoredTaskBudgetReason[]
}

function fail(): never {
  throw new Error('TASK_BUDGET_INPUT_INVALID')
}

function positiveInteger(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) fail()
}

function nonNegativeInteger(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail()
}

function optionalPositiveInteger(value: unknown): asserts value is number | null {
  if (value !== null) positiveInteger(value)
}

function demandQuantity(demand: TaskBudgetDemand): number {
  return demand.kind === 'draft-units' ? demand.requestedUnits : demand.requestedItems
}

function outputTokensFor(
  stage: GenerationReasoningStage,
  demand: TaskBudgetDemand,
  quantity: number,
): number {
  if (quantity === 0) return 0
  if (demand.kind === 'draft-units') {
    const rate = S07_TASK_BUDGET_POLICY.draftUnits.tokensPerUnit[demand.writingLanguage]
    return S07_TASK_BUDGET_POLICY.draftUnits.baseTokens
      + Math.ceil(quantity * rate.numerator / rate.denominator)
  }
  return S07_TASK_BUDGET_POLICY.structuredItems.baseTokens
    + quantity * S07_TASK_BUDGET_POLICY.structuredItems.tokensPerItem[demand.writingLanguage][stage]
}

function maximumItemsFor(
  stage: GenerationReasoningStage,
  demand: Extract<TaskBudgetDemand, { kind: 'structured-items' }>,
  availableOutputTokens: number,
): number {
  const usable = availableOutputTokens - S07_TASK_BUDGET_POLICY.structuredItems.baseTokens
  if (usable <= 0) return 0
  return Math.floor(usable / S07_TASK_BUDGET_POLICY.structuredItems.tokensPerItem[demand.writingLanguage][stage])
}

/**
 * Pure S07 planning seam. It proposes one physical reservation; the persistent
 * main owner remains solely responsible for reserving, dispatching and settling.
 */
export function planTaskBudget(input: TaskBudgetPlannerInput): TaskBudgetDecision {
  if (!input || !['drafting', 'planning', 'review', 'general'].includes(input.stage)
    || !input.demand || !['draft-units', 'structured-items'].includes(input.demand.kind)
    || !['zh-CN', 'en-US'].includes(input.demand.writingLanguage)
    || typeof input.inputEstimate?.estimatorVersion !== 'string'
    || !input.inputEstimate.estimatorVersion.trim()) fail()
  const requestedQuantity = demandQuantity(input.demand)
  positiveInteger(requestedQuantity)
  nonNegativeInteger(input.inputEstimate.upperBoundTokens)
  positiveInteger(input.root.maxOutputPerRequest)
  nonNegativeInteger(input.safetyMarginTokens)
  optionalPositiveInteger(input.capability.modelContextWindowTokens)
  optionalPositiveInteger(input.capability.modelMaxOutputTokens)
  optionalPositiveInteger(input.capability.userContextWindowTokens)
  optionalPositiveInteger(input.capability.userMaxOutputTokens)
  if (!['verified-provider-preset', 'unknown'].includes(input.capability.modelContextSource)
    || !['verified-provider-preset', 'unknown'].includes(input.capability.modelOutputSource)) fail()
  if (input.capability.modelContextWindowTokens === null
    !== (input.capability.modelContextSource === 'unknown')
    || input.capability.modelMaxOutputTokens === null
      !== (input.capability.modelOutputSource === 'unknown')) fail()
  if (input.liability.mode === 'separate-bounded') {
    nonNegativeInteger(input.liability.reasoningUpperBoundTokens)
  } else if (input.liability.mode === 'unknown') {
    nonNegativeInteger(input.liability.reasoningUpperBoundTokens ?? 0)
  } else if (input.liability.mode === 'total-bounded') {
    positiveInteger(input.liability.totalLiabilityUpperBoundTokens)
  }

  const requestedOutputTokens = outputTokensFor(input.stage, input.demand, requestedQuantity)
  const reasons: TaskBudgetReason[] = [
    { code: 'task-demand', valueTokens: requestedOutputTokens, selected: true },
    { code: 'input-upper-bound', valueTokens: input.inputEstimate.upperBoundTokens, selected: true },
    { code: 'safety-margin', valueTokens: input.safetyMarginTokens, selected: true },
  ]
  if (input.capability.modelContextWindowTokens === null || input.capability.modelMaxOutputTokens === null) {
    reasons.push({ code: 'model-capability-unknown', selected: true })
  }
  if (input.liability.mode === 'unknown') {
    reasons.push({ code: 'liability-bound-unknown', selected: true })
  }

  // 上下文容量由服务商判定（ADR-0023）。
  const fixedReasoningTokens = input.liability.mode === 'separate-bounded' || input.liability.mode === 'unknown'
    ? input.liability.reasoningUpperBoundTokens ?? 0
    : 0
  const outputLimits: Array<{ code: TaskBudgetReasonCode; value: number }> = [
    ...(input.capability.modelMaxOutputTokens === null ? [] : [{ code: 'model-output-cap' as const, value: input.capability.modelMaxOutputTokens }]),
    { code: 'root-output-cap', value: input.root.maxOutputPerRequest },
    ...(input.capability.userMaxOutputTokens === null ? [] : [{ code: 'user-output-cap' as const, value: input.capability.userMaxOutputTokens }]),
  ]
  const totalEnvelopeTokens = input.liability.mode === 'total-bounded' ? input.liability.totalLiabilityUpperBoundTokens : null
  if (totalEnvelopeTokens !== null) {
    reasons.push({ code: 'protocol-total-bound', valueTokens: totalEnvelopeTokens, selected: true })
  } else if (fixedReasoningTokens > 0 || input.liability.mode === 'separate-bounded') {
    reasons.push({ code: 'protocol-reasoning-reserve', valueTokens: fixedReasoningTokens, selected: true })
  }

  const availableOutputTokens = Math.min(...outputLimits.map(limit => limit.value))
  for (const limit of outputLimits) {
    reasons.push({ code: limit.code, valueTokens: limit.value, selected: limit.value === availableOutputTokens })
  }

  const selectedQuantity = input.demand.kind === 'draft-units' ? requestedQuantity
    : Math.min(requestedQuantity, Math.max(1, maximumItemsFor(input.stage, input.demand, availableOutputTokens)))
  const decision = selectedQuantity < requestedQuantity ? 'split-required' : 'ready'
  const reservedOutputTokens = decision === 'ready'
    ? availableOutputTokens : Math.min(availableOutputTokens, outputTokensFor(input.stage, input.demand, selectedQuantity))
  if (decision === 'ready') reasons.push({ code: 'output-allocation-ceiling', valueTokens: reservedOutputTokens, selected: true })
  const reasoningUpperBoundTokens = totalEnvelopeTokens === null
    ? fixedReasoningTokens
    : Math.max(0, totalEnvelopeTokens
      - input.inputEstimate.upperBoundTokens - reservedOutputTokens - input.safetyMarginTokens)
  const reservationLiabilityTokens = input.inputEstimate.upperBoundTokens
    + reservedOutputTokens + reasoningUpperBoundTokens + input.safetyMarginTokens
  if (decision === 'split-required') reasons.push({ code: 'scope-split', valueTokens: reservedOutputTokens, selected: true })
  return Object.freeze({
    policyVersion: S07_TASK_BUDGET_POLICY.version,
    outputEstimatorVersion: S07_TASK_BUDGET_POLICY.outputEstimatorVersion,
    inputEstimatorVersion: input.inputEstimate.estimatorVersion,
    decision,
    stage: input.stage,
    writingLanguage: input.demand.writingLanguage,
    demandKind: input.demand.kind,
    requestedQuantity,
    selectedQuantity,
    remainingQuantity: requestedQuantity - selectedQuantity,
    requestedOutputTokens,
    reservedOutputTokens,
    reasoningUpperBoundTokens,
    reservationLiabilityTokens,
    inputUpperBoundTokens: input.inputEstimate.upperBoundTokens,
    reasons: Object.freeze(reasons.map(reason => Object.freeze({ ...reason }))),
  })
}
