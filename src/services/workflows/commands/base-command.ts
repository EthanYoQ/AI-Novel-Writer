import type { WorkflowContext, StepCallbacks } from '../../../stores/workflow-store'
import { useLLMStore } from '../../../stores/llm-store'
import { globalEventBus, EventPayloadMap } from '../../../shared/event-bus'
import type { LLMFinishReason, ProjectSessionContext } from '../../../shared/ipc-channels'
import type { BasePromptBuilder } from '../../prompts/prompt-builder'

export interface CommandExecuteParams {
  step: unknown
  context: WorkflowContext
  callbacks: StepCallbacks
}

export interface LLMCompletion {
  content: string
  finishReason: LLMFinishReason
}

/**
 * 工作流执行环节的抽象基类 (Command Pattern)
 * 将原本混乱的 workflow 闭包拆分为可独立测试、状态解耦的命令单元。
 */
export abstract class BaseWorkflowCommand<TResult = string> {
  
  /** 抽象执行入口 */
  abstract execute(params: CommandExecuteParams): Promise<TResult>

  /** 获取 LLM 大模型连接代理（支持取消） */
  protected async callLLM(
    prompt: string, 
    systemPrompt: string, 
    callbacks: StepCallbacks,
    options?: { responseFormat?: { type: string }; thinking?: boolean; maxTokens?: number; temperature?: number },
    context?: WorkflowContext
  ): Promise<string> {
    const completion = await this.callLLMResult(prompt, systemPrompt, callbacks, options, context)
    if (completion.finishReason !== 'stop') {
      throw this.createIncompleteCompletionError(completion.finishReason)
    }
    return completion.content
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
    options?: { responseFormat?: { type: string }; thinking?: boolean; maxTokens?: number; temperature?: number },
    context?: WorkflowContext,
  ): Promise<LLMCompletion> {
    this.assertNotCancelled(context)
    const llmStore = useLLMStore.getState()
    if (!llmStore.defaultModelId) throw new Error('未配置默认 AI 模型')

    callbacks.setProgress(10)

    return new Promise<LLMCompletion>((resolve, reject) => {
      let fullContent = ''
      let streamRequestId = ''

      // 取消监听：轮询 context.cancelled，主动中断 LLM 流
      let cancelCheckTimer: ReturnType<typeof setInterval> | null = null
      if (context) {
        cancelCheckTimer = setInterval(() => {
          if (context.cancelled && streamRequestId) {
            clearInterval(cancelCheckTimer!)
            cancelCheckTimer = null
            llmStore.cancelGeneration(streamRequestId).catch(() => {})
            reject(new Error('工作流已取消'))
          }
        }, 200)
      }

      const cleanup = () => {
        if (cancelCheckTimer) {
          clearInterval(cancelCheckTimer)
          cancelCheckTimer = null
        }
      }

      llmStore.generateStream(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ],
        {
          onChunk: (chunk) => {
            // 取消后不再追加输出
            if (context?.cancelled) return
            fullContent += chunk
            callbacks.appendText(chunk)
          },
          onDone: (text, _usage, finishReason) => {
            cleanup()
            // 取消后不 resolve，让 reject 生效
            if (context?.cancelled) {
              reject(new Error('工作流已取消'))
              return
            }
            callbacks.setProgress(90)
            const raw = text || fullContent
            const cleaned = this.stripThinkingTags(raw)
            resolve({ content: cleaned, finishReason: finishReason ?? 'stop' })
          },
          onError: (err) => {
            cleanup()
            reject(new Error(err || '流式生成失败'))
          }
        },
        undefined,
        options
      ).then(reqId => {
        streamRequestId = reqId
        // 如果在 generateStream 返回前已经取消
        if (context?.cancelled) {
          llmStore.cancelGeneration(reqId).catch(() => {})
          cleanup()
          reject(new Error('工作流已取消'))
        }
      }).catch(err => {
        cleanup()
        reject(err)
      })
    })
  }

  protected createIncompleteCompletionError(finishReason: LLMFinishReason): Error {
    switch (finishReason) {
      case 'length':
        return new Error('AI 输出达到模型最大长度，结果不完整。请提高模型最大输出 Tokens 或缩短本次任务后重试。')
      case 'content_filter':
        return new Error('AI 输出因内容限制而未完成，结果未被保存。')
      case 'cancelled':
        return new Error('AI 生成已取消，结果未被保存。')
      default:
        return new Error('AI 未正常完成生成，结果未被保存。')
    }
  }

  /**
   * 使用 Builder 的 systemRole + prompt 一键调用 LLM
   * 角色定位由模板自带，command 不再需要硬编码 system message
   */
  protected async callLLMWithBuilder(
    builder: BasePromptBuilder,
    callbacks: StepCallbacks,
    options?: { responseFormat?: { type: string }; thinking?: boolean; maxTokens?: number; temperature?: number },
    context?: WorkflowContext
  ): Promise<string> {
    return this.callLLM(builder.build(), builder.getSystemRole(), callbacks, options, context)
  }

  protected async callLLMResultWithBuilder(
    builder: BasePromptBuilder,
    callbacks: StepCallbacks,
    options?: { responseFormat?: { type: string }; thinking?: boolean; maxTokens?: number; temperature?: number },
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
    return text
      .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
      .replace(/^\s*[\s\S]{0,300}<\/think>\s*/i, '')
      .replace(/<\/?think>/gi, '')
      .trim()
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
