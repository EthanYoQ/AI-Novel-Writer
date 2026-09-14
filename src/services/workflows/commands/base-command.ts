import type { WorkflowContext, StepCallbacks } from '../../../stores/workflow-store'
import { globalEventBus, EventPayloadMap } from '../../../shared/event-bus'
import type { LLMFinishReason, ProjectSessionContext } from '../../../shared/ipc-channels'
import type { BasePromptBuilder } from '../../prompts/prompt-builder'
import {
  createGenerationRuntime,
  type CreateGenerationRuntimeOptions,
  type GenerationRuntime,
} from '../../generation/generation-runtime'
import {
  GenerationAttemptError,
  type GenerationAttemptReceipt,
  type GenerationSession,
  type GenerationTask,
  type PromptBudgetPolicy,
} from '../../generation/generation-harness'
import type { GenerationReasoningStage } from '../../../shared/reasoning-types'
import {
  completeBoundedCompletion,
  createBoundedCompletionError,
  redactVisibleCompletionText,
  type BoundedCompletionMode,
} from '../bounded-completion'
import { workflowUiText, workflowWritingLanguage } from '../workflow-project-session'
import type { WritingSkillStage } from '../../../shared/writing-skills'
import { ipc } from '../../ipc-client'
import type { VisibleCompositionReceipt } from '../../../shared/generation-owner-contract'
import { composeVisibleContinuation } from '../../../shared/visible-continuation'
import { createWorkflowMainGenerationRuntime, type WorkflowMainGenerationSelection, type WorkflowMainGenerationRequest, type WorkflowMainGenerationRuntime } from '../workflow-main-generation'
export type { WorkflowMainGenerationSelection } from '../workflow-main-generation'

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
  reasoningStage?: GenerationReasoningStage
  promptBudget?: PromptBudgetPolicy
  /** Explicit workflow-writing stage. Reasoning strategy never selects a writing skill. */
  writingSkillStage?: WritingSkillStage
}

export function injectWritingSkillIntoTask(
  task: GenerationTask,
  context: WorkflowContext,
  stage: WritingSkillStage,
): { task: GenerationTask; skillName?: string } {
  const skill = context.writingSkills?.[stage]
  if (!skill) return { task }
  const userMessageIndex = task.messages.findIndex(message => message.role === 'user')
  if (userMessageIndex < 0) return { task }
  const writingLanguage = workflowWritingLanguage(context)
  const block = writingLanguage === 'en-US'
    ? `[Supplemental writing skill: ${skill.name}]\nThis guidance may improve craft, but author facts, the project writing language, and the output contract below always take priority.\n${skill.content}`
    : `【补充写作 Skill：${skill.name}】\n以下内容只能补充创作方法；作者事实、项目写作语言和后续输出合同始终优先。\n${skill.content}`
  const messages = task.messages.map((message, index) => index === userMessageIndex
    ? { ...message, content: `${block}\n\n${message.content}` }
    : message)
  const promptBudget = {
    limitUtf8Bytes: task.promptBudget?.limitUtf8Bytes
      ?? new TextEncoder().encode(messages.map(message => message.content).join('')).byteLength,
    sections: [
      {
        sectionName: 'writing-skill',
        displayName: skill.name,
        messageIndex: userMessageIndex,
        finalText: block,
      },
      ...(task.promptBudget?.sections ?? []),
    ],
  }
  return {
    task: { ...task, messages, promptBudget },
    skillName: skill.name,
  }
}

export function injectWritingSkillIntoSession(
  session: GenerationSession,
  context: WorkflowContext,
  stage: WritingSkillStage,
): GenerationSession {
  return {
    budget: session.budget,
    complete: (task, options) => session.complete(
      injectWritingSkillIntoTask(task, context, stage).task,
      options,
    ),
  }
}

export type WorkflowGenerationIntent = 'structured' | 'text' | 'character-architecture'

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
  'character-architecture': Object.freeze({
    // Worst recoverable path: manifest replacements, bounded detail batches,
    // and one syntax-only repair on a slow provider.
    maxAttempts: 12,
    maxRequestedOutputTokens: 98_304,
    maxRequestedOutputTokensPerAttempt: 8192,
    deadlineMs: 20 * 60_000,
  }),
})

export interface WorkflowGenerationRuntimeDependencies {
  createRuntime(options: CreateGenerationRuntimeOptions, main?: WorkflowMainGenerationRequest): Promise<GenerationRuntime>
}

const DEFAULT_GENERATION_DEPENDENCIES: WorkflowGenerationRuntimeDependencies = {
  createRuntime: (options, main) => main ? createWorkflowMainGenerationRuntime(main) : createGenerationRuntime(options),
}

interface ActiveGenerationExecution {
  context: WorkflowContext
  session: GenerationSession
  signal: AbortSignal
  loggedWritingSkillStages: Set<WritingSkillStage>
  runtime: GenerationRuntime
  mainOwned: boolean
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
    selection?: WorkflowMainGenerationSelection,
  ): Promise<T> {
    if (this.activeGenerationExecution) {
      throw new Error('同一个工作流命令不能并发或嵌套启动生成运行时。')
    }
    this.assertNotCancelled(params.context)
    const cancellation = observeWorkflowCancellation(params.context)
    try {
      const generationModelId = params.context.generationModelId?.trim() || undefined
      const runtime = await this.generationDependencies.createRuntime({
        budget: WORKFLOW_GENERATION_BUDGETS[intent],
        ...(generationModelId ? { modelId: generationModelId } : {}),
      }, selection ? { context: params.context, callbacks: params.callbacks, selection } : undefined)
      return await runtime.execute(async ({ session }) => {
        this.activeGenerationExecution = {
          context: params.context,
          session,
          signal: cancellation.signal,
          loggedWritingSkillStages: new Set(),
          runtime,
          mainOwned: (runtime as Partial<WorkflowMainGenerationRuntime>).mainOwned === true,
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

  /** After a verified formal batch commit, freeze a new stage under the same root. */
  protected async advanceMainGenerationRun(selection: WorkflowMainGenerationSelection): Promise<void> {
    const execution = this.requireGenerationExecution()
    const runtime = execution.runtime as Partial<WorkflowMainGenerationRuntime>
    if (!execution.mainOwned || !runtime.advance) throw new Error('GENERATION_WORKFLOW_ADVANCE_UNAVAILABLE')
    await runtime.advance(selection)
  }

  protected async readMainVisibleComposition(): Promise<VisibleCompositionReceipt | null> {
    const execution = this.requireGenerationExecution()
    const handle = execution.context.mainGenerationRunHandle
    if (!execution.mainOwned || !handle) throw new Error('GENERATION_COMPOSITION_HANDLE_REQUIRED')
    return ipc.invokeWithProjectSession(execution.context.projectSession, 'generation:read-visible-composition', handle)
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
    options: WorkflowLLMOptions | undefined,
    context: WorkflowContext,
  ): Promise<string> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const completion = await this.callLLMResult(prompt, systemPrompt, callbacks, options, context)
    callbacks.log(text(
      `  有界生成初始响应：finishReason=${completion.finishReason}`,
      `  Initial bounded response: finishReason=${completion.finishReason}`,
    ))
    let continuationCount = 0
    return completeBoundedCompletion({
      initial: completion,
      mode: continuation.mode,
      maxContinuations: continuation.maxContinuations,
      originalPrompt: prompt,
      writingLanguage: workflowWritingLanguage(context),
      uiLocale: context.uiLocale ?? 'zh-CN',
      promptBudget: {
        contextWindowTokens: completion.receipt.capabilities.contextWindowTokens,
        maxOutputTokens: completion.receipt.budget.requestedOutputTokens,
        systemPromptChars: systemPrompt.length,
      },
      preserveCompleteStructuredPrompt: continuation.mode === 'replace-structured-output'
        && options?.promptBudget !== undefined,
      isCancelled: () => context.cancelled,
      redactVisibleText: text => this.stripThinkingTags(text),
      requestContinuation: async continuationPrompt => {
        continuationCount += 1
        callbacks.log(text(
          `  自动续写第 ${continuationCount} 轮请求已发起`,
          `  Automatic continuation request ${continuationCount} started`,
        ))
        const next = await this.callLLMResult(
          continuationPrompt,
          systemPrompt,
          callbacks,
          options,
          context,
        )
        callbacks.log(text(
          `  自动续写第 ${continuationCount} 轮响应：finishReason=${next.finishReason}`,
          `  Automatic continuation response ${continuationCount}: finishReason=${next.finishReason}`,
        ))
        return next
      },
    })
  }

  /**
   * 追加型文本续写助手：以 seedText（可为空）为基线，在单个模型租约内反复
   * 请求直到 stop 或自动续写耗尽。seedText 非空时等价于「断点续写」——
   * 不重发已有内容，只让模型从种子末尾自然追加。自动续写耗尽、无进展或
   * 机械不完整等仍可能产出可见文本的失败，会在抛出前调用
   * onPartialAvailable(mergedText)，供调用方把已完成部分落盘后让用户从
   * 断点手动续写。
   */
  protected async callLLMWithAppendContinuation(
    options: {
      taskPrompt: string
      systemPrompt: string
      callbacks: StepCallbacks
      context: WorkflowContext
      llmOptions?: WorkflowLLMOptions
      /** 已完成可见文本种子；为空时先发起一次全新请求。 */
      seedText?: string
      /** 自动续写轮数上限（0–7）。 */
      maxContinuations: number
      /** 部分结果回调：在失败抛出前携带当前合并文本。 */
      onPartialAvailable?: (mergedText: string) => void
      /** 进度日志用的任务描述。 */
      taskLabel?: string
    },
  ): Promise<string> {
    const uiText = (zhCNText: string, enUSText: string) => workflowUiText(options.context, zhCNText, enUSText)
    const seed = options.seedText?.trim() || ''
    const mainOwned = this.requireGenerationExecution().mainOwned
    const prior = mainOwned ? await this.readMainVisibleComposition() : null
    if (mainOwned && seed !== (prior?.text ?? '')) throw new Error('GENERATION_COMPOSITION_SEED_MISMATCH')
    let composedText = prior?.text ?? ''
    const artifactIds = [...(prior?.artifactIds ?? [])]
    const persistComposition = async (completion: LLMCompletion) => {
      if (!mainOwned || !completion.content.trim() || !['stop', 'length'].includes(completion.finishReason)) return
      const artifact = completion.receipt.visibleArtifact
      const handle = options.context.mainGenerationRunHandle
      if (!artifact || !handle) throw new Error('GENERATION_COMPOSITION_ARTIFACT_REQUIRED')
      const next = composedText ? composeVisibleContinuation(composedText, completion.content) : completion.content.trim()
      // A repeated response remains an independent artifact and is not acknowledged as continuation progress.
      if (composedText && (next.match(/[\p{L}\p{N}]/gu)?.length ?? 0) <= (composedText.match(/[\p{L}\p{N}]/gu)?.length ?? 0)) return
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(next))
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
      const receipt = await ipc.invokeWithProjectSession(options.context.projectSession, 'generation:compose-visible', handle, [...artifactIds, artifact.artifactId], hash)
      if (receipt.text !== next || receipt.textHash !== hash) throw new Error('GENERATION_COMPOSITION_RECEIPT_MISMATCH')
      artifactIds.push(artifact.artifactId); composedText = receipt.text
    }
    let continuationCount = 0
    let initial: { content: string; finishReason: LLMFinishReason }
    let initialReceipt: LLMCompletion['receipt'] | undefined
    if (seed) {
      initial = { content: seed, finishReason: 'length' }
    } else {
      const first = await this.callLLMResult(
        options.taskPrompt,
        options.systemPrompt,
        options.callbacks,
        options.llmOptions,
        options.context,
      )
      initial = first
      initialReceipt = first.receipt
      await persistComposition(first)
    }
    const prefix = options.taskLabel ? `${options.taskLabel} ` : ''
    options.callbacks.log(uiText(
      `  ${prefix}初始响应：finishReason=${initial.finishReason}`,
      `  ${prefix}initial response: finishReason=${initial.finishReason}`,
    ))
    return completeBoundedCompletion({
      initial,
      mode: 'append-visible-text',
      maxContinuations: options.maxContinuations,
      originalPrompt: options.taskPrompt,
      writingLanguage: workflowWritingLanguage(options.context),
      uiLocale: options.context.uiLocale ?? 'zh-CN',
      promptBudget: seed
        ? undefined
        : {
            contextWindowTokens: initialReceipt?.capabilities?.contextWindowTokens,
            maxOutputTokens: initialReceipt?.budget?.requestedOutputTokens,
            systemPromptChars: options.systemPrompt.length,
          },
      isCancelled: () => options.context.cancelled,
      redactVisibleText: redactedText => this.stripThinkingTags(redactedText),
      requestContinuation: async continuationPrompt => {
        continuationCount += 1
        options.callbacks.log(uiText(
          `  自动续写第 ${continuationCount} 轮请求已发起`,
          `  Automatic continuation request ${continuationCount} started`,
        ))
        const next = await this.callLLMResult(
          continuationPrompt,
          options.systemPrompt,
          options.callbacks,
          options.llmOptions,
          options.context,
        )
        await persistComposition(next)
        options.callbacks.log(uiText(
          `  自动续写第 ${continuationCount} 轮响应：finishReason=${next.finishReason}`,
          `  Automatic continuation response ${continuationCount}: finishReason=${next.finishReason}`,
        ))
        return next
      },
      onInterrupted: mergedText => options.onPartialAvailable?.(mergedText),
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
      const writingSkillStage = options?.writingSkillStage
      const baseTask: GenerationTask = {
        purpose: options?.purpose ?? 'workflow',
        reasoningStage: options?.reasoningStage,
        output: options?.responseFormat ? 'structured-data' : 'visible-text',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        ...(options?.promptBudget ? { promptBudget: options.promptBudget } : {}),
      }
      const injection = writingSkillStage && context
        ? injectWritingSkillIntoTask(baseTask, context, writingSkillStage)
        : { task: baseTask }
      if (injection.skillName && writingSkillStage && !execution.loggedWritingSkillStages.has(writingSkillStage)) {
        execution.loggedWritingSkillStages.add(writingSkillStage)
        callbacks.log(workflowUiText(
          execution.context,
          `本次 ${writingSkillStage} 阶段使用已冻结写作 Skill：${injection.skillName}`,
          `Using the workflow-start-frozen writing skill for ${writingSkillStage}: ${injection.skillName}`,
        ))
      }
      const outcome = await execution.session.complete(injection.task, { signal: execution.signal })
      this.reportGenerationPromptBudget(callbacks, outcome.receipt)
      this.assertNotCancelled(context)
      const content = this.stripThinkingTags(outcome.content)
      if (!execution.mainOwned) callbacks.appendText(content)
      callbacks.setProgress(90)
      return {
        content,
        finishReason: outcome.finishReason,
        receipt: outcome.receipt,
      }
    } catch (error) {
      if (error instanceof GenerationAttemptError) {
        this.reportGenerationPromptBudget(callbacks, error.receipt)
      }
      if (context?.cancelled || (
        typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === 'CANCELLED'
      )) {
        throw new Error(context
          ? workflowUiText(context, '工作流已取消', 'Workflow was cancelled.')
          : 'Workflow was cancelled.')
      }
      throw error
    }
  }

  protected reportGenerationPromptBudget(
    callbacks: StepCallbacks,
    receipt: GenerationAttemptReceipt,
  ): void {
    if (receipt.promptBudget) callbacks.setPromptBudgetReport?.(receipt.promptBudget)
  }

  protected createIncompleteCompletionError(finishReason: LLMFinishReason): Error {
    return createBoundedCompletionError(
      finishReason,
      this.activeGenerationExecution?.context.uiLocale ?? 'zh-CN',
    )
  }

  /**
   * 使用 Builder 的 systemRole + prompt 一键调用 LLM
   * 角色定位由模板自带，command 不再需要硬编码 system message
   */
  protected async callLLMWithBuilder(
    builder: BasePromptBuilder,
    callbacks: StepCallbacks,
    options?: WorkflowLLMOptions,
    context?: WorkflowContext
  ): Promise<string> {
    return this.callLLM(builder.build(), builder.getSystemRole(), callbacks, options, context)
  }

  protected async callLLMResultWithBuilder(
    builder: BasePromptBuilder,
    callbacks: StepCallbacks,
    options?: WorkflowLLMOptions,
    context?: WorkflowContext,
  ): Promise<LLMCompletion> {
    return this.callLLMResult(builder.build(), builder.getSystemRole(), callbacks, options, context)
  }

  /** 在所有异步边界与落盘前复查取消，避免已取消请求继续污染项目。 */
  protected assertNotCancelled(context?: WorkflowContext): void {
    if (context?.cancelled) {
      throw new Error(workflowUiText(context, '工作流已取消', 'Workflow was cancelled.'))
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
