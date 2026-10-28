import { TerminalProviderFailureError, type GenerationAttemptReceipt, type GenerationTask } from '../../../generation/generation-harness'
import type { GenerationRuntime } from '../../../generation/generation-runtime'
import type { WorkflowGenerationRuntimeDependencies } from '../base-command'

function rejectedReceipt(task: GenerationTask): GenerationAttemptReceipt {
  return {
    ...(task.purpose ? { purpose: task.purpose } : {}),
    model: { id: 'model-1', configurationRevision: 'revision-1', endpointFingerprint: 'endpoint-1' },
    capabilities: {
      contextWindowTokens: null,
      maxOutputTokens: 4096,
      reasoning: null,
      structuredOutput: true,
      usage: true,
      source: { contextWindowTokens: 'unknown', maxOutputTokens: 'legacy-profile', featureFlags: 'unknown' },
    },
    budget: Object.freeze({
      attempt: 1,
      maxAttempts: 20,
      requestedOutputTokens: 4096,
      cumulativeRequestedOutputTokens: 4096,
      maxRequestedOutputTokens: 100_000,
      maxRequestedOutputTokensPerAttempt: 4096,
      deadlineAt: Number.MAX_SAFE_INTEGER,
    }),
    finishReason: 'error',
    failureCode: 'GENERATION_CONTEXT_LENGTH_EXCEEDED',
  }
}

function reject(task: GenerationTask): never {
  throw new TerminalProviderFailureError('GENERATION_CONTEXT_LENGTH_EXCEEDED', rejectedReceipt(task))
}

/** 服务商以上下文超长拒绝 rejects 命中的请求；其余请求交给 base。 */
export function contextLengthRejectingDependencies(
  base: WorkflowGenerationRuntimeDependencies,
  rejects: (task: GenerationTask) => boolean = () => true,
): WorkflowGenerationRuntimeDependencies {
  return {
    async createRuntime(options, main): Promise<GenerationRuntime> {
      const runtime = await base.createRuntime(options, main)
      return {
        execute: operation => runtime.execute(scope => operation({ ...scope, session: {
          budget: scope.session.budget,
          complete: async (task, executionOptions) => rejects(task) ? reject(task) : scope.session.complete(task, executionOptions),
        } })),
        close: () => runtime.close(),
      }
    },
  }
}
