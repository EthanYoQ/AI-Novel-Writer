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
  | { mode: 'unknown' }

export interface TaskBudgetPlannerInput {
  stage: GenerationReasoningStage
  demand: TaskBudgetDemand
  inputEstimate: {
    upperBoundTokens: number
    estimatorVersion: string
  }
  capability: TaskBudgetCapabilityConstraints
  root: {
    remainingTokenLiability: number
    maxOutputPerRequest: number
  }
  liability: TaskBudgetLiabilityBound
  safetyMarginTokens: number
}

export type TaskBudgetReasonCode =
  | 'task-demand'
  | 'input-upper-bound'
  | 'safety-margin'
  | 'model-context-cap'
  | 'model-output-cap'
  | 'user-context-cap'
  | 'user-output-cap'
  | 'root-output-cap'
  | 'root-remaining-cap'
  | 'protocol-reasoning-reserve'
  | 'protocol-total-bound'
  | 'model-capability-unknown'
  | 'liability-bound-unknown'
  | 'required-input-capacity-conflict'
  | 'single-item-capacity-conflict'
  | 'draft-segmentation-disabled'
  | 'scope-split'

export interface TaskBudgetReason {
  code: TaskBudgetReasonCode
  /** Non-sensitive numeric evidence behind this decision, when applicable. */
  valueTokens?: number
  selected: boolean
}

export interface TaskBudgetDecision {
  policyVersion: typeof S07_TASK_BUDGET_POLICY.version
  outputEstimatorVersion: typeof S07_TASK_BUDGET_POLICY.outputEstimatorVersion
  inputEstimatorVersion: string
  decision: 'ready' | 'split-required' | 'capacity-conflict'
  stage: GenerationReasoningStage
  writingLanguage: WritingLanguage
  demandKind: TaskBudgetDemand['kind']
  requestedQuantity: number
  selectedQuantity: number
  remainingQuantity: number
  /** Output need for the complete semantic scope before any capacity decision. */
  requestedOutputTokens: number
  /** Provider max output for this selected physical request; zero means no dispatch. */
  reservedOutputTokens: number
  reasoningUpperBoundTokens: number
  /** Total root-ledger liability to reserve before dispatch; zero means no dispatch. */
  reservationLiabilityTokens: number
  inputUpperBoundTokens: number
  reasons: readonly TaskBudgetReason[]
}

export interface GenerationBudgetDiagnostic {
  attemptId: string
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
  reasons: readonly TaskBudgetReason[]
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

function maximumQuantityFor(
  stage: GenerationReasoningStage,
  demand: TaskBudgetDemand,
  availableOutputTokens: number,
): number {
  if (demand.kind === 'draft-units') {
    const usable = availableOutputTokens - S07_TASK_BUDGET_POLICY.draftUnits.baseTokens
    if (usable <= 0) return 0
    const rate = S07_TASK_BUDGET_POLICY.draftUnits.tokensPerUnit[demand.writingLanguage]
    return Math.floor(usable * rate.denominator / rate.numerator)
  }
  const usable = availableOutputTokens - S07_TASK_BUDGET_POLICY.structuredItems.baseTokens
  if (usable <= 0) return 0
  return Math.floor(usable / S07_TASK_BUDGET_POLICY.structuredItems.tokensPerItem[demand.writingLanguage][stage])
}

function conflict(
  input: TaskBudgetPlannerInput,
  requestedQuantity: number,
  requestedOutputTokens: number,
  reasons: TaskBudgetReason[],
): TaskBudgetDecision {
  return Object.freeze({
    policyVersion: S07_TASK_BUDGET_POLICY.version,
    outputEstimatorVersion: S07_TASK_BUDGET_POLICY.outputEstimatorVersion,
    inputEstimatorVersion: input.inputEstimate.estimatorVersion,
    decision: 'capacity-conflict',
    stage: input.stage,
    writingLanguage: input.demand.writingLanguage,
    demandKind: input.demand.kind,
    requestedQuantity,
    selectedQuantity: 0,
    remainingQuantity: requestedQuantity,
    requestedOutputTokens,
    reservedOutputTokens: 0,
    reasoningUpperBoundTokens: 0,
    reservationLiabilityTokens: 0,
    inputUpperBoundTokens: input.inputEstimate.upperBoundTokens,
    reasons: Object.freeze(reasons.map(reason => Object.freeze({ ...reason }))),
  })
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
  nonNegativeInteger(input.root.remainingTokenLiability)
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
    return conflict(input, requestedQuantity, requestedOutputTokens, reasons)
  }
  if (input.liability.mode === 'unknown') {
    reasons.push({ code: 'liability-bound-unknown', selected: true })
    return conflict(input, requestedQuantity, requestedOutputTokens, reasons)
  }

  const modelContext = input.capability.modelContextWindowTokens
  const effectiveContext = Math.min(modelContext, input.capability.userContextWindowTokens ?? modelContext)
  const fixedReasoningTokens = input.liability.mode === 'separate-bounded'
    ? input.liability.reasoningUpperBoundTokens
    : 0
  const outputLimits: Array<{ code: TaskBudgetReasonCode; value: number }> = [
    { code: 'model-output-cap', value: input.capability.modelMaxOutputTokens },
    { code: 'root-output-cap', value: input.root.maxOutputPerRequest },
    { code: 'model-context-cap', value: effectiveContext
      - input.inputEstimate.upperBoundTokens - fixedReasoningTokens - input.safetyMarginTokens },
  ]
  if (input.capability.userMaxOutputTokens !== null) {
    outputLimits.push({ code: 'user-output-cap', value: input.capability.userMaxOutputTokens })
  }
  if (input.capability.userContextWindowTokens !== null) {
    reasons.push({
      code: 'user-context-cap',
      valueTokens: input.capability.userContextWindowTokens,
      selected: input.capability.userContextWindowTokens <= modelContext,
    })
  }

  let totalEnvelopeTokens: number | null = null
  if (input.liability.mode === 'separate-bounded') {
    outputLimits.push({
      code: 'root-remaining-cap',
      value: input.root.remainingTokenLiability
        - input.inputEstimate.upperBoundTokens - fixedReasoningTokens - input.safetyMarginTokens,
    })
    reasons.push({ code: 'protocol-reasoning-reserve', valueTokens: fixedReasoningTokens, selected: true })
  } else if (input.liability.mode === 'included-in-output') {
    outputLimits.push({
      code: 'root-remaining-cap',
      value: input.root.remainingTokenLiability
        - input.inputEstimate.upperBoundTokens - input.safetyMarginTokens,
    })
  } else {
    // A verified context value is a supported capacity floor, not proof of the
    // protocol's physical liability ceiling. Preserve the independent bound.
    totalEnvelopeTokens = input.liability.totalLiabilityUpperBoundTokens
    reasons.push({ code: 'protocol-total-bound', valueTokens: totalEnvelopeTokens, selected: true })
    if (input.root.remainingTokenLiability < totalEnvelopeTokens) {
      reasons.push({ code: 'root-remaining-cap', valueTokens: input.root.remainingTokenLiability, selected: true })
      return conflict(input, requestedQuantity, requestedOutputTokens, reasons)
    }
    outputLimits.push({
      code: 'root-remaining-cap',
      value: totalEnvelopeTokens - input.inputEstimate.upperBoundTokens - input.safetyMarginTokens,
    })
  }

  const availableOutputTokens = Math.min(...outputLimits.map(limit => limit.value))
  for (const limit of outputLimits) {
    reasons.push({
      code: limit.code,
      valueTokens: Math.max(0, limit.value),
      selected: limit.value === availableOutputTokens,
    })
  }
  const minimumOutputTokens = outputTokensFor(input.stage, input.demand, 1)
  if (availableOutputTokens < minimumOutputTokens) {
    reasons.push({ code: 'required-input-capacity-conflict', valueTokens: Math.max(0, availableOutputTokens), selected: true })
    if (input.demand.kind === 'structured-items' && requestedQuantity === 1) {
      reasons.push({ code: 'single-item-capacity-conflict', selected: true })
    }
    return conflict(input, requestedQuantity, requestedOutputTokens, reasons)
  }

  const selectedQuantity = Math.min(
    requestedQuantity,
    maximumQuantityFor(input.stage, input.demand, availableOutputTokens),
  )
  if (selectedQuantity < requestedQuantity
    && input.demand.kind === 'draft-units'
    && !input.demand.segmentable) {
    reasons.push({ code: 'draft-segmentation-disabled', selected: true })
    return conflict(input, requestedQuantity, requestedOutputTokens, reasons)
  }
  if (selectedQuantity <= 0) {
    reasons.push({ code: 'required-input-capacity-conflict', valueTokens: Math.max(0, availableOutputTokens), selected: true })
    return conflict(input, requestedQuantity, requestedOutputTokens, reasons)
  }

  const reservedOutputTokens = outputTokensFor(input.stage, input.demand, selectedQuantity)
  const reasoningUpperBoundTokens = totalEnvelopeTokens === null
    ? fixedReasoningTokens
    : Math.max(0, totalEnvelopeTokens
      - input.inputEstimate.upperBoundTokens - reservedOutputTokens - input.safetyMarginTokens)
  const reservationLiabilityTokens = totalEnvelopeTokens ?? (
    input.inputEstimate.upperBoundTokens
    + reservedOutputTokens
    + reasoningUpperBoundTokens
    + input.safetyMarginTokens
  )
  const decision = selectedQuantity < requestedQuantity ? 'split-required' : 'ready'
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
