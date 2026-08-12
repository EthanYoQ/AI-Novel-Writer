import type { WorkflowContext, StepCallbacks } from '../../../stores/workflow-store'
import { globalEventBus, EventPayloadMap } from '../../../shared/event-bus'
import type { LLMFinishReason, ProjectSessionContext } from '../../../shared/ipc-channels'
import type { BasePromptBuilder } from '../../prompts/prompt-builder'
import {
  createGenerationRuntime,
  type CreateGenerationRuntimeOptions,
  type GenerationRuntime,
} from '../../generation/generation-runtime'
import type {
  GenerationAttemptReceipt,
  GenerationSession,
} from '../../generation/generation-harness'
import {
  completeBoundedCompletion,
  createBoundedCompletionError,
  redactVisibleCompletionText,
  type BoundedCompletionMode,
} from '../bounded-completion'

export interface CommandExecuteParams {
  step: unknown
  context: WorkflowContext
  callbacks: StepCallbacks
}

export interface LLMCompletion {
  content: string
  finishReason: LLMFinishReason
  receipt: GenerationAttemptReceipt
}

type WorkflowLLMOptions = {
  responseFormat?: { type: string }
  purpose?: string
}

export type WorkflowGenerationIntent = 'structured' | 'text'

/**
 * Intent cost ceilings are product policy, never model profiles. The runtime
 * still plans every physical request from the frozen lease capability receipt.
 */
export const WORKFLOW_GENERATION_BUDGETS = Object.freeze({
  structured: Object.freeze({
    maxAttempts: 16,
    maxRequestedOutputTokens: 131_072,
    maxRequestedOutputTokensPerAttempt: 8192,
    deadlineMs: 10 * 60_000,
  }),
  text: Object.freeze({
    maxAttempts: 8,
    maxRequestedOutputTokens: 65_536,
    maxRequestedOutputTokensPerAttempt: 8192,
    deadlineMs: 20 * 60_000,
  }),
})

export interface WorkflowGenerationRuntimeDependencies {
  createRuntime(options: CreateGenerationRuntimeOptions): Promise<GenerationRuntime>
}

const DEFAULT_GENERATION_DEPENDENCIES: WorkflowGenerationRuntimeDependencies = {
  createRuntime: options => createGenerationRuntime(options),
}

interface ActiveGenerationExecution {
  context: WorkflowContext
  session: GenerationSession
  signal: AbortSignal
}

function observeWorkflowCancellation(context: WorkflowContext): {
  signal: AbortSignal
  dispose(): void
} {
  const controller = new AbortController()
  const timer = setInterval(() => {
    if (context.cancelled) controller.abort()
  }, 25)
  if (context.cancelled) controller.abort()
  return {
    signal: controller.signal,
    dispose: () => clearInterval(timer),
  }
}

/**
 * 工作流执行环节的抽象基类 (Command Pattern)
 * 将原本混乱的 workflow 闭包拆分为可独立测试、状态解耦的命令单元。
 */
export abstract class BaseWorkflowCommand<TResult = string> {
  private readonly generationDependencies: WorkflowGenerationRuntimeDependencies
  private activeGenerationExecution: ActiveGenerationExecution | null = null

  constructor(
    generationDependencies: WorkflowGenerationRuntimeDependencies = DEFAULT_GENERATION_DEPENDENCIES,
  ) {
    this.generationDependencies = generationDependencies
  }
  
  /** 抽象执行入口 */
  abstract execute(params: CommandExecuteParams): Promise<TResult>

  /**
   * One command execute owns one immutable model lease, one attempt/token
   * budget and one cancellation signal. Nested helpers consume this scope and
   * cannot reopen or reselect a model.
   */
  protected async executeWithGenerationRuntime<T>(
    intent: WorkflowGenerationIntent,
    params: CommandExecuteParams,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.activeGenerationExecution) {
      throw new Error('同一个工作流命令不能并发或嵌套启动生成运行时。')
    }
    this.assertNotCancelled(params.context)
    const cancellation = observeWorkflowCancellation(params.context)
    try {
      const runtime = await this.generationDependencies.createRuntime({
        budget: WORKFLOW_GENERATION_BUDGETS[intent],
      })
      return await runtime.execute(async ({ session }) => {
        this.activeGenerationExecution = {
          context: params.context,
          session,
          signal: cancellation.signal,
        }
        try {
          this.assertNotCancelled(params.context)
          return await operation()
        } finally {
          this.activeGenerationExecution = null
        }
      })
    } finally {
      cancellation.dispose()
      this.activeGenerationExecution = null
    }
  }

  /** Structured orchestrators may consume the same session; they cannot replace its budget. */
  protected requireGenerationExecution(): Readonly<ActiveGenerationExecution> {
    if (!this.activeGenerationExecution) {
      throw new Error('生成调用必须位于命令执行期 GenerationRuntime 内。')
    }
    return this.activeGenerationExecution
  }

  /** 获取 LLM 大模型连接代理（支持取消） */
  protected async callLLM(
    prompt: string, 
    systemPrompt: string, 
    callbacks: StepCallbacks,
    options?: WorkflowLLMOptions,
    context?: WorkflowContext
  ): Promise<string> {
    const completion = await this.callLLMResult(prompt, systemPrompt, callbacks, options, context)
    if (completion.finishReason !== 'stop') {
      throw this.createIncompleteCompletionError(completion.finishReason)
    }
    return completion.content
  }

  /**
   * Explicit continuation seam for commands whose product contract permits a
   * bounded retry. Ordinary callLLM callers remain single-shot and fail-closed.
   */
  protected async callLLMWithBoundedCompletion(
    prompt: string,
    systemPrompt: string,
    callbacks: StepCallbacks,
    continuation: { mode: BoundedCompletionMode; maxContinuations: number },
    options?: WorkflowLLMOptions,
    context?: WorkflowContext,
  ): Promise<string> {
    const completion = await this.callLLMResult(prompt, systemPrompt, callbacks, options, context)
    return completeBoundedCompletion({
      initial: completion,
      mode: continuation.mode,
      maxContinuations: continuation.maxContinuations,
      originalPrompt: prompt,
      promptBudget: {
        contextWindowTokens: completion.receipt.capabilities.contextWindowTokens,
        maxOutputTokens: completion.receipt.budget.requestedOutputTokens,
        systemPromptChars: systemPrompt.length,
      },
      isCancelled: () => context?.cancelled === true,
      redactVisibleText: text => this.stripThinkingTags(text),
      requestContinuation: continuationPrompt => this.callLLMResult(
        continuationPrompt,
        systemPrompt,
        callbacks,
        options,
        context,
      ),
    })
  }

  /**
   * Returns partial text together with the provider end state. Commands that
   * have a bounded continuation policy (draft generation) may consume a
   * `length` result; all other workflow commands should use callLLM instead.
   */
  protected async callLLMResult(
    prompt: string,
    systemPrompt: string,
    callbacks: StepCallbacks,
    options?: WorkflowLLMOptions,
    context?: WorkflowContext,
  ): Promise<LLMCompletion> {
    this.assertNotCancelled(context)
    const execution = this.requireGenerationExecution()
    if (context && execution.context !== context) {
      throw new Error('生成调用上下文与当前命令执行期不一致。')
    }
    callbacks.setProgress(10)
    try {
      const outcome = await execution.session.complete({
        purpose: options?.purpose ?? 'workflow',
        output: options?.responseFormat ? 'structured-data' : 'visible-text',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
      }, { signal: execution.signal })
      this.assertNotCancelled(context)
      const content = this.stripThinkingTags(outcome.content)
      callbacks.appendText(content)
      callbacks.setProgress(90)
      return {
        content,
        finishReason: outcome.finishReason,
        receipt: outcome.receipt,
      }
    } catch (error) {
      if (context?.cancelled || (
        typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === 'CANCELLED'
      )) {
        throw new Error('工作流已取消')
      }
      throw error
    }
  }

  protected createIncompleteCompletionError(finishReason: LLMFinishReason): Error {
    return createBoundedCompletionError(finishReason)
  }

  /**
   * 使用 Builder 的 systemRole + prompt 一键调用 LLM
   * 角色定位由模板自带，command 不再需要硬编码 system message
   */
  protected async callLLMWithBuilder(
    builder: BasePromptBuilder,
    callbacks: StepCallbacks,
    options?: { responseFormat?: { type: string }; purpose?: string },
    context?: WorkflowContext
  ): Promise<string> {
    return this.callLLM(builder.build(), builder.getSystemRole(), callbacks, options, context)
  }

  protected async callLLMResultWithBuilder(
    builder: BasePromptBuilder,
    callbacks: StepCallbacks,
    options?: { responseFormat?: { type: string }; purpose?: string },
    context?: WorkflowContext,
  ): Promise<LLMCompletion> {
    return this.callLLMResult(builder.build(), builder.getSystemRole(), callbacks, options, context)
  }

  /** 在所有异步边界与落盘前复查取消，避免已取消请求继续污染项目。 */
  protected assertNotCancelled(context?: WorkflowContext): void {
    if (context?.cancelled) {
      throw new Error('工作流已取消')
    }
  }

  /**
   * 去除 DeepSeek 等模型的 <think> 标签，保证落盘纯净
   */
  protected stripThinkingTags(text: string): string {
    return redactVisibleCompletionText(text)
  }

  /**
   * 全局容错 JSON 解析器
   * 自动剥离 Markdown ```json 代码块并处理尾随逗号等常见大模型幻觉
   */
  protected parseJSON<T>(text: string): T {
    try {
      // 1. 剥离 Markdown 块
      let cleanText = text.replace(/```json?\n?/gi, '').replace(/```\n?/gi, '').trim()
      // 2. 如果存在前序引导语，截取第一把括号到最后一把括号
      const firstBrace = cleanText.indexOf('{')
      const firstBracket = cleanText.indexOf('[')
      const lastBrace = cleanText.lastIndexOf('}')
      const lastBracket = cleanText.lastIndexOf(']')

      if (firstBrace !== -1 && lastBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
        cleanText = cleanText.substring(firstBrace, lastBrace + 1)
      } else if (firstBracket !== -1 && lastBracket !== -1) {
        cleanText = cleanText.substring(firstBracket, lastBracket + 1)
      }
      
      return JSON.parse(cleanText) as T
    } catch {
      throw new Error(`AI 返回的数据格式乱码，无法解析为有效层级结构。尝试解析内容末端: ${text.slice(-100)}`)
    }
  }

  /**
   * 解耦的事件驱动：通知 UI 层去更新资产树，而无需去 import Zustand Store
   */
  protected notifyRefresh(
    resources: EventPayloadMap['REFRESH_RESOURCE']['resources'],
    projectPath: string,
    projectSession: ProjectSessionContext,
  ) {
    globalEventBus.emit('REFRESH_RESOURCE', { resources, projectPath, projectSession })
  }
}
