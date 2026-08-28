import {
  GenerationAttemptError,
  GenerationHarnessError,
  type GenerationAttemptReceipt,
  type GenerationSession,
  type GenerationTask,
} from '../generation/generation-harness'
import { structuredContractDiagnostic } from '../../shared/structured-contract-diagnostic'
import type { WritingLanguage } from '../../shared/writing-language'
import {
  buildStructuredSyntaxRepairTask,
  isRepairableDirectJsonSyntaxFailure,
  MAX_STRUCTURED_REPAIR_CANDIDATE_UTF8_BYTES,
  MAX_STRUCTURED_REPAIR_CONTRACT_UTF8_BYTES,
  preservesStructuredJsonEvidence,
  structuredRepairUtf8Bytes,
} from './structured-syntax-repair'

export type StructuredItemKey = string | number

export interface StructuredBatchContract<TInput, TOutput> {
  buildTask(input: {
    items: readonly TInput[]
    validatedPrefix: readonly TOutput[]
  }): GenerationTask
  /** Rebuilds one output-limited item from bounded domain facts; never receives partial output. */
  buildCompactSingleTask?(input: {
    item: TInput
    validatedPrefix: readonly TOutput[]
  }): GenerationTask
  inputKey(input: TInput): StructuredItemKey
  outputKey(output: TOutput): StructuredItemKey
  decode(content: string): readonly TOutput[]
  validateItem(output: TOutput): string | undefined
  /**
   * Optional immutable, compact syntax-only repair evidence. It must carry
   * every output field and exact coverage rule, but never the large source
   * prose used to generate values.
   */
  syntaxRepairContract?(input: { items: readonly TInput[] }): string
}

export type StructuredGenerationFailureReason =
  | 'server_error'
  | 'authentication'
  | 'safety'
  | 'cancelled'
  | 'deadline'
  | 'unknown'

export interface StructuredBatchLimits {
  /** Product/contract boundary for one semantic batch; never a model capability. */
  maxBatchItems: number
  /** Total compact single-item attempts; each input key may consume at most one. */
  maxCompactSingleFallbacks?: number
}

export interface StructuredBatchReceipt {
  calls: number
  splitCount: number
  requestedTokens: number
  attempts: readonly GenerationAttemptReceipt[]
  compactSingleFallbackCount?: number
}

export interface StructuredBatchFailure {
  code: 'generation_failed' | 'invalid_output' | 'limit_exceeded' | 'cancelled' | 'deadline'
  message: string
  reason?: StructuredGenerationFailureReason
    | 'missing_item'
    | 'duplicate_item'
    | 'unexpected_item'
    | 'invalid_item'
    | 'malformed_output'
    | 'output_limit'
    | 'max_calls'
    | 'max_requested_tokens'
    | 'invalid_limit'
  diagnostic?: { code: string; path: string; field: string }
}

export type StructuredBatchResult<TOutput> =
  | {
      ok: true
      items: readonly TOutput[]
      receipt: StructuredBatchReceipt
    }
  | {
      ok: false
      failure: StructuredBatchFailure
      receipt: StructuredBatchReceipt
    }

export interface StructuredBatchExecutor<TInput, TOutput> {
  execute(input: {
    items: readonly TInput[]
    limits: StructuredBatchLimits
    signal?: AbortSignal
  }): Promise<StructuredBatchResult<TOutput>>
}

export function createStructuredBatchExecutor<TInput, TOutput>(dependencies: {
  contract: StructuredBatchContract<TInput, TOutput>
  session: Pick<GenerationSession, 'complete'>
  writingLanguage?: WritingLanguage
}): StructuredBatchExecutor<TInput, TOutput> {
  const { contract, session, writingLanguage = 'zh-CN' } = dependencies

  class ExecutionFailure extends Error {
    constructor(readonly failure: StructuredBatchFailure) {
      super(failure.message)
    }
  }

  return {
    async execute(input) {
      const attemptReceipts: GenerationAttemptReceipt[] = []
      const receipt: StructuredBatchReceipt = {
        calls: 0,
        splitCount: 0,
        requestedTokens: 0,
        attempts: attemptReceipts,
        compactSingleFallbackCount: 0,
      }
      const validated: TOutput[] = []
      let repairUsed = false
      const compactFallbackKeys = new Set<StructuredItemKey>()
      const recordAttempt = (attempt: GenerationAttemptReceipt): void => {
        attemptReceipts.push(attempt)
        receipt.calls = attemptReceipts.length
        receipt.requestedTokens += attempt.budget.requestedOutputTokens
      }

      if (!Number.isInteger(input.limits.maxBatchItems) || input.limits.maxBatchItems < 1) {
        return {
          ok: false,
          failure: {
            code: 'limit_exceeded',
            reason: 'invalid_limit',
            message: '结构化批次上限必须是正整数',
          },
          receipt,
        }
      }
      const maxCompactSingleFallbacks = input.limits.maxCompactSingleFallbacks ?? 0
      if (!Number.isInteger(maxCompactSingleFallbacks) || maxCompactSingleFallbacks < 0) {
        return {
          ok: false,
          failure: {
            code: 'limit_exceeded',
            reason: 'invalid_limit',
            message: '紧凑单项重建上限必须是非负整数',
          },
          receipt,
        }
      }

      const executeBatch = async (items: readonly TInput[]): Promise<void> => {
        if (input.signal?.aborted) {
          throw new ExecutionFailure({
            code: 'cancelled',
            reason: 'cancelled',
            message: '结构化生成已取消',
          })
        }
        const task = {
          ...contract.buildTask({
            items: [...items],
            validatedPrefix: [...validated],
          }),
          reasoningStage: 'planning' as const,
        }
        if (task.output !== 'structured-data') {
          throw new ExecutionFailure({
            code: 'invalid_output',
            reason: 'invalid_item',
            message: '结构化批次合同必须请求 structured-data 输出',
          })
        }

        let outcome = await session.complete(task, { signal: input.signal })
        recordAttempt(outcome.receipt)
        if (input.signal?.aborted) {
          throw new ExecutionFailure({
            code: 'cancelled',
            reason: 'cancelled',
            message: '结构化生成已取消',
          })
        }
        const singleItemKey = items.length === 1 ? contract.inputKey(items[0]!) : undefined
        if (
          outcome.status === 'incomplete'
          && outcome.finishReason === 'length'
          && items.length === 1
          && singleItemKey !== undefined
          && contract.buildCompactSingleTask
          && !compactFallbackKeys.has(singleItemKey)
          && compactFallbackKeys.size < maxCompactSingleFallbacks
        ) {
          compactFallbackKeys.add(singleItemKey)
          receipt.compactSingleFallbackCount = compactFallbackKeys.size
          let compactTask: GenerationTask
          try {
            compactTask = {
              ...contract.buildCompactSingleTask({
                item: items[0]!,
                validatedPrefix: [...validated],
              }),
              reasoningStage: 'planning',
            }
          } catch {
            throw new ExecutionFailure({
              code: 'invalid_output',
              reason: 'invalid_item',
              message: '紧凑单项任务构建失败',
            })
          }
          if (compactTask.output !== 'structured-data') {
            throw new ExecutionFailure({
              code: 'invalid_output',
              reason: 'invalid_item',
              message: '紧凑单项任务必须请求 structured-data 输出',
            })
          }
          outcome = await session.complete(
            compactTask,
            { signal: input.signal },
          )
          recordAttempt(outcome.receipt)
          if (input.signal?.aborted) {
            throw new ExecutionFailure({
              code: 'cancelled',
              reason: 'cancelled',
              message: '结构化生成已取消',
            })
          }
        }
        if (outcome.status === 'incomplete') {
          if (outcome.finishReason !== 'length') {
            const reason: StructuredGenerationFailureReason = outcome.finishReason === 'content_filter'
              ? 'safety'
              : outcome.finishReason === 'cancelled'
                ? 'cancelled'
                : outcome.finishReason === 'error'
                  ? 'server_error'
                  : 'unknown'
            throw new ExecutionFailure({
              code: reason === 'cancelled' ? 'cancelled' : 'generation_failed',
              reason,
              message: `结构化生成未正常完成：${outcome.finishReason}`,
            })
          }
          if (items.length <= 1) {
            throw new ExecutionFailure({
              code: 'limit_exceeded',
              reason: 'output_limit',
              message: '单项结构化输出达到模型输出上限，无法继续拆分',
            })
          }
          const midpoint = Math.floor(items.length / 2)
          receipt.splitCount += 1
          await executeBatch(items.slice(0, midpoint))
          await executeBatch(items.slice(midpoint))
          return
        }

        let candidateContent = outcome.content
        let syntaxRepairApplied = false
        if (isRepairableDirectJsonSyntaxFailure(candidateContent)) {
          const originalContract = task.messages
            .map(message => `[${message.role}]\n${message.content}`)
            .join('\n\n')
          let repairContract: string
          try {
            repairContract = contract.syntaxRepairContract?.({ items: [...items] }) ?? originalContract
          } catch {
            throw new ExecutionFailure({
              code: 'invalid_output',
              reason: 'malformed_output',
              message: '结构化语法修复合同构建失败',
            })
          }
          if (
            repairUsed
            || structuredRepairUtf8Bytes(repairContract) > MAX_STRUCTURED_REPAIR_CONTRACT_UTF8_BYTES
            || structuredRepairUtf8Bytes(candidateContent) > MAX_STRUCTURED_REPAIR_CANDIDATE_UTF8_BYTES
          ) {
            throw new ExecutionFailure({
              code: 'invalid_output',
              reason: 'malformed_output',
              message: repairUsed
                ? '结构化输出无法按合同解码，且本次执行已使用过唯一一次语法修复'
                : '结构化输出语法修复证据超过安全字节上限，已拒绝不完整证据修复',
            })
          }
          repairUsed = true
          syntaxRepairApplied = true
          const repaired = await session.complete(
            buildStructuredSyntaxRepairTask(task, repairContract, outcome.content, writingLanguage),
            { signal: input.signal },
          )
          recordAttempt(repaired.receipt)
          if (input.signal?.aborted || repaired.finishReason === 'cancelled') {
            throw new ExecutionFailure({
              code: 'cancelled',
              reason: 'cancelled',
              message: '结构化语法修复已取消',
            })
          }
          if (repaired.status === 'incomplete') {
            if (repaired.finishReason === 'length') {
              throw new ExecutionFailure({
                code: 'limit_exceeded',
                reason: 'output_limit',
                message: '结构化语法修复达到模型输出上限',
              })
            }
            const repairReason: StructuredGenerationFailureReason = repaired.finishReason === 'content_filter'
              ? 'safety'
              : repaired.finishReason === 'error'
                ? 'server_error'
                : 'unknown'
            throw new ExecutionFailure({
              code: 'generation_failed',
              reason: repairReason,
              message: `结构化语法修复未正常完成：${repaired.finishReason}`,
            })
          }
          if (!preservesStructuredJsonEvidence(candidateContent, repaired.content)) {
            throw new ExecutionFailure({
              code: 'invalid_output',
              reason: 'malformed_output',
              message: '结构化语法修复改变了候选中的非结构证据，已拒绝补造或改写事实',
            })
          }
          candidateContent = repaired.content
        }
        let decoded: readonly TOutput[]
        try {
          decoded = contract.decode(candidateContent)
          if (!Array.isArray(decoded)) throw new TypeError('decoder did not return an array')
        } catch (error) {
          const diagnostic = structuredContractDiagnostic(error)
          throw new ExecutionFailure({
            code: 'invalid_output',
            reason: diagnostic
              ? 'invalid_item'
              : syntaxRepairApplied
              ? 'malformed_output'
              : 'invalid_item',
            message: diagnostic
              ? diagnostic.message
              : syntaxRepairApplied
              ? '结构化输出经一次语法修复后仍无法按合同解码'
              : '结构化输出无法按合同解码',
            ...(diagnostic
              ? { diagnostic: { code: diagnostic.code, path: diagnostic.path, field: diagnostic.field } }
              : {}),
          })
        }
        for (const output of decoded) {
          let error: string | undefined
          try {
            error = contract.validateItem(output)
          } catch {
            throw new ExecutionFailure({
              code: 'invalid_output',
              reason: 'invalid_item',
              message: '结构化输出项不符合合同',
            })
          }
          if (error) {
            throw new ExecutionFailure({
              code: 'invalid_output',
              reason: 'invalid_item',
              message: error,
            })
          }
        }
        const decodedKeys = decoded.map(output => contract.outputKey(output))
        const duplicateKeys = decodedKeys.filter((key, index) => decodedKeys.indexOf(key) !== index)
        if (duplicateKeys.length > 0) {
          throw new ExecutionFailure({
            code: 'invalid_output',
            reason: 'duplicate_item',
            message: `结构化输出包含重复目标项：${[...new Set(duplicateKeys)].join('、')}`,
          })
        }
        const outputKeys = new Set(decodedKeys)
        const expectedKeys = items.map(item => contract.inputKey(item))
        const expectedKeySet = new Set(expectedKeys)
        const unexpectedKeys = decodedKeys.filter(key => !expectedKeySet.has(key))
        if (unexpectedKeys.length > 0) {
          throw new ExecutionFailure({
            code: 'invalid_output',
            reason: 'unexpected_item',
            message: `结构化输出包含批次范围外目标项：${[...new Set(unexpectedKeys)].join('、')}`,
          })
        }
        const missingKeys = expectedKeys
          .filter(key => !outputKeys.has(key))
        if (missingKeys.length > 0) {
          throw new ExecutionFailure({
            code: 'invalid_output',
            reason: syntaxRepairApplied ? 'malformed_output' : 'missing_item',
            message: syntaxRepairApplied
              ? `结构化语法修复结果缺少目标项：${missingKeys.join('、')}`
              : `结构化输出缺少目标项：${missingKeys.join('、')}`,
          })
        }
        const outputByKey = new Map(
          decoded.map(output => [contract.outputKey(output), output] as const),
        )
        validated.push(...expectedKeys.map(key => outputByKey.get(key)!))
      }

      try {
        const maxBatchItems = input.limits.maxBatchItems
        for (let offset = 0; offset < input.items.length; offset += maxBatchItems) {
          await executeBatch(input.items.slice(offset, offset + maxBatchItems))
        }
        return { ok: true, items: validated, receipt }
      } catch (error) {
        let failure: StructuredBatchFailure
        if (error instanceof ExecutionFailure) {
          failure = error.failure
        } else if (error instanceof GenerationAttemptError) {
          recordAttempt(error.receipt)
          if (error.code === 'CANCELLED') {
            failure = { code: 'cancelled', reason: 'cancelled', message: error.message }
          } else if (error.code === 'DEADLINE_EXHAUSTED') {
            failure = { code: 'deadline', reason: 'deadline', message: error.message }
          } else {
            failure = { code: 'generation_failed', reason: 'server_error', message: error.message }
          }
        } else if (error instanceof GenerationHarnessError) {
          if (error.code === 'ATTEMPT_BUDGET_EXHAUSTED') {
            failure = { code: 'limit_exceeded', reason: 'max_calls', message: error.message }
          } else if (error.code === 'REQUESTED_TOKEN_BUDGET_EXHAUSTED') {
            failure = { code: 'limit_exceeded', reason: 'max_requested_tokens', message: error.message }
          } else if (error.code === 'DEADLINE_EXHAUSTED') {
            failure = { code: 'deadline', reason: 'deadline', message: error.message }
          } else if (error.code === 'CANCELLED') {
            failure = { code: 'cancelled', reason: 'cancelled', message: error.message }
          } else {
            failure = { code: 'generation_failed', reason: 'unknown', message: error.message }
          }
        } else {
          failure = { code: 'generation_failed', reason: 'server_error', message: '结构化生成失败' }
        }
        return { ok: false, failure, receipt }
      }
    },
  }
}
