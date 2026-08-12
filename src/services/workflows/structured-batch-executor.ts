import {
  GenerationAttemptError,
  GenerationHarnessError,
  type GenerationAttemptReceipt,
  type GenerationSession,
  type GenerationTask,
} from '../generation/generation-harness'

export type StructuredItemKey = string | number

export interface StructuredBatchContract<TInput, TOutput> {
  buildTask(input: {
    items: readonly TInput[]
    validatedPrefix: readonly TOutput[]
  }): GenerationTask
  inputKey(input: TInput): StructuredItemKey
  outputKey(output: TOutput): StructuredItemKey
  decode(content: string): readonly TOutput[]
  validateItem(output: TOutput): string | undefined
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
}

export interface StructuredBatchReceipt {
  calls: number
  splitCount: number
  requestedTokens: number
  attempts: readonly GenerationAttemptReceipt[]
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
}): StructuredBatchExecutor<TInput, TOutput> {
  const { contract, session } = dependencies

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
      }
      const validated: TOutput[] = []

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

      const executeBatch = async (items: readonly TInput[]): Promise<void> => {
        if (input.signal?.aborted) {
          throw new ExecutionFailure({
            code: 'cancelled',
            reason: 'cancelled',
            message: '结构化生成已取消',
          })
        }
        const task = contract.buildTask({
          items: [...items],
          validatedPrefix: [...validated],
        })
        if (task.output !== 'structured-data') {
          throw new ExecutionFailure({
            code: 'invalid_output',
            reason: 'invalid_item',
            message: '结构化批次合同必须请求 structured-data 输出',
          })
        }

        const outcome = await session.complete(task, { signal: input.signal })
        attemptReceipts.push(outcome.receipt)
        receipt.calls = attemptReceipts.length
        receipt.requestedTokens += outcome.receipt.budget.requestedOutputTokens
        if (input.signal?.aborted) {
          throw new ExecutionFailure({
            code: 'cancelled',
            reason: 'cancelled',
            message: '结构化生成已取消',
          })
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

        let decoded: readonly TOutput[]
        try {
          decoded = contract.decode(outcome.content)
          if (!Array.isArray(decoded)) throw new TypeError('decoder did not return an array')
        } catch {
          throw new ExecutionFailure({
            code: 'invalid_output',
            reason: 'malformed_output',
            message: '结构化输出无法按合同解码',
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
            reason: 'missing_item',
            message: `结构化输出缺少目标项：${missingKeys.join('、')}`,
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
          attemptReceipts.push(error.receipt)
          receipt.calls = attemptReceipts.length
          receipt.requestedTokens += error.receipt.budget.requestedOutputTokens
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
