import { create } from 'zustand'
import {
  runAgentLoop,
  type ConfigImpactBlueprintProposal,
  type ToolCallInfo,
  type LLMMessage,
  type ToolConfirmationDecision,
} from '../services/agent/agent-engine'
import { registerBuiltinTools } from '../services/agent/tools'
import { skillRegistry, type LoadedSkill } from '../services/agent/skill-registry'
import {
  getAllMentionTargets,
  getAllSlashCommands,
  parseSlashCommand,
  parseMentions,
  mentionsToToolCalls,
} from '../services/agent/intent-router'
import { toolRegistry } from '../services/agent/tool-registry'
import type { ToolArtifact } from '../services/agent/tool-registry'
import { createAgentExecutionContext, assertAgentProjectCurrent } from '../services/agent/tools/project-context'
import type { MainGenerationRunHandle } from '../services/generation/generation-runtime'
import { AgentGenerationClient } from '../services/agent/agent-generation-client'
import type { AgentGenerationRecovery } from '../shared/agent-generation'
import { writingLanguageText } from '../shared/writing-language'
import { useLocaleStore } from './locale-store'
import { useLLMStore } from './llm-store'
import { useEditorStore } from './editor-store'
import type { Locale } from '../i18n/types'

export const AGENT_GENERATION_BUDGET = Object.freeze({
  maxAttempts: 8,
  maxRequestedOutputTokens: 65_536,
  maxRequestedOutputTokensPerAttempt: 8192,
  deadlineMs: 20 * 60_000,
})

// ===== 类型定义 =====

/** 对话模式：Planning（深度推理）/ Fast（快速执行） */
export type AgentMode = 'planning' | 'fast'

/** 单条消息 */
export interface AgentMessage {
  /** Exact durable Agent navigation; no renderer-owned candidate mirror. */
  mainGenerationHandle?: MainGenerationRunHandle
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
  /** 是否正在流式生成中 */
  streaming?: boolean
  /** Tool 调用信息（Agent 回复时） */
  toolCalls?: ToolCallInfo[]
  /** 产物列表（Agent 创建/修改的文件、触发的工作流等） */
  artifacts?: ToolArtifact[]
}

/** 单个会话 */
export interface AgentConversation {
  id: string
  /** 会话标题（取自第一条用户消息前 20 个字符） */
  title: string
  messages: AgentMessage[]
  createdAt: number
  updatedAt: number
  /** 当前会话使用的模式 */
  mode: AgentMode
  /** 当前会话使用的模型 ID（null 表示使用默认） */
  modelId: string | null
}

// ===== Store 状态接口 =====

interface AgentState {
  /** 所有会话列表（最新的排在前面） */
  conversations: AgentConversation[]
  /** 当前活跃会话 ID */
  activeConversationId: string | null
  /** 是否显示历史面板 */
  showHistory: boolean
  /** 全局默认模式 */
  defaultMode: AgentMode
  /** 当前是否正在生成（用于 UI 状态） */
  generating: boolean
  /** 当前流式请求 ID（用于取消） */
  activeRequestId: string | null
  /** Tool 系统是否已初始化 */
  toolsInitialized: boolean

  // ===== 计算属性（Getters） =====
  /** 获取当前活跃会话 */
  getActiveConversation: () => AgentConversation | null

  // ===== Actions =====
  /** 初始化 Tool 系统 */
  initializeTools: () => void
  /** 新建会话并激活 */
  createConversation: () => AgentConversation
  /** 激活指定会话 */
  selectConversation: (id: string) => void
  /** 删除指定会话 */
  deleteConversation: (id: string) => void
  /** 清空所有会话 */
  clearAll: () => void
  /** 切换历史面板 */
  toggleHistory: () => void
  /** 设置历史面板可见性 */
  setShowHistory: (show: boolean) => void
  /** 设置当前会话模式 */
  setMode: (mode: AgentMode) => void
  /** 设置当前会话使用的模型 */
  setModelId: (modelId: string | null) => void
  /** 发送消息（触发 Agent ReAct 循环） */
  sendMessage: (content: string, recoveryHandle?: MainGenerationRunHandle) => Promise<void>
  /** Explicitly recover the original Agent turn, including its durable tool calls. */
  resumeGeneration: (handle: MainGenerationRunHandle) => Promise<void>
  /** 取消当前生成 */
  cancelGeneration: () => Promise<void>
  /** 响应 Tool 确认（用于 ConfirmCard） */
  resolveToolConfirmation: (
    toolCallId: string,
    confirmed: boolean,
    options?: { blueprintProposals?: readonly ConfigImpactBlueprintProposal[] },
  ) => void
}

// ===== 工具函数 =====

/** 生成唯一 ID */
const genId = () => crypto.randomUUID()

/** 从消息内容生成会话标题 */
const generateTitle = (content: string): string => {
  const cleaned = content.replace(/\s+/g, ' ').trim()
  return cleaned.length > 24 ? cleaned.slice(0, 24) + '…' : cleaned
}

/** 生成 /help 命令的帮助文本 */
const generateHelpText = (locale: Locale): string => {
  const text = (zhCN: string, enUS: string) => locale === 'en-US' ? enUS : zhCN
  const toolCount = toolRegistry.listAll().length
  const skillCount = skillRegistry.listAll().length
  const commands = getAllSlashCommands(locale)
  const lines: string[] = [
    text('## AI小说作家 AI 助手 — 帮助', '## AI Novel Writer Assistant — Help'),
    '',
    text('### 可用命令', '### Available commands'),
    ...commands
      .filter(command => command.source === 'builtin_command')
      .map(command => `- \`/${command.name}\` — ${command.description}`),
    '',
    text('### @ 提及', '### @ mentions'),
    text(
      '输入 `@` 可引用项目上下文：故事架构、角色卡、蓝图、知识库等。',
      `Type \`@\` to reference project context: ${getAllMentionTargets(locale).map(target => target.displayName).join(', ')}.`,
    ),
    '',
    text('### 可用工具', '### Available tools'),
    text(
      `当前已加载 **${toolCount}** 个工具、**${skillCount}** 个 Skill。`,
      `Currently loaded: **${toolCount}** tools and **${skillCount}** skills.`,
    ),
    '',
    text('### Skill 命令', '### Skill commands'),
  ]
  for (const command of commands.filter(command => command.source === 'skill')) {
    lines.push(`- \`/${command.name}\` — ${command.description}`)
  }
  lines.push('', text('有任何创作问题，直接问我即可！', 'Ask me whenever you need help with your story.'))
  return lines.join('\n')
}

// ===== Tool 确认回调管理 =====
/** 存储待确认的 Tool 回调 */
const pendingConfirmations = new Map<string, {
  resolve: (decision: boolean | ToolConfirmationDecision) => void
}>()

/** 当前活跃的 AbortController（用于取消 ReAct 循环） */
let activeAbortController: AbortController | null = null
let activeGenerationClient: AgentGenerationClient | null = null
let activeRequestUiLocale: Locale | null = null

// ===== Zustand Store =====

export const useAgentStore = create<AgentState>()((set, get) => ({
  conversations: [],
  activeConversationId: null,
  showHistory: false,
  defaultMode: 'planning',
  generating: false,
  activeRequestId: null,
  toolsInitialized: false,

  getActiveConversation: () => {
    const { conversations, activeConversationId } = get()
    return conversations.find(c => c.id === activeConversationId) ?? null
  },

  initializeTools: () => {
    if (get().toolsInitialized) return
    registerBuiltinTools()
    // 加载 Skill（内置 + 用户 + 项目级）
    skillRegistry.loadAll().catch(e => console.warn('[Agent] Skill 加载失败:', e))
    set({ toolsInitialized: true })
  },

  createConversation: () => {
    // 确保 Tool 已初始化
    get().initializeTools()

    const newConv: AgentConversation = {
      id: genId(),
      title: useLocaleStore.getState().locale === 'en-US' ? 'New conversation' : '新对话',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mode: get().defaultMode,
      // Null means “use the default once when a run starts”; the runtime then
      // freezes the selected lease across the entire ReAct loop.
      modelId: null,
    }
    set(state => ({
      conversations: [newConv, ...state.conversations],
      activeConversationId: newConv.id,
      showHistory: false,
    }))
    return newConv
  },

  selectConversation: (id) => {
    set({ activeConversationId: id, showHistory: false })
  },

  deleteConversation: (id) => {
    set(state => {
      const filtered = state.conversations.filter(c => c.id !== id)
      // 如果删除的是当前会话，激活下一条或 null
      const nextId = state.activeConversationId === id
        ? (filtered[0]?.id ?? null)
        : state.activeConversationId
      return { conversations: filtered, activeConversationId: nextId }
    })
  },

  clearAll: () => {
    set({ conversations: [], activeConversationId: null })
  },

  toggleHistory: () => {
    set(state => ({ showHistory: !state.showHistory }))
  },

  setShowHistory: (show) => {
    set({ showHistory: show })
  },

  setMode: (mode) => {
    const conv = get().getActiveConversation()
    if (!conv) {
      set({ defaultMode: mode })
      return
    }
    set(state => ({
      defaultMode: mode,
      conversations: state.conversations.map(c =>
        c.id === conv.id ? { ...c, mode } : c
      ),
    }))
  },

  setModelId: (modelId) => {
    const conv = get().getActiveConversation()
    if (!conv) return
    set(state => ({
      conversations: state.conversations.map(c =>
        c.id === conv.id ? { ...c, modelId } : c
      ),
    }))
  },

  sendMessage: async (content, recoveryHandle) => {
    if ((!content.trim() && !recoveryHandle) || get().generating) return
    let requestLocale = useLocaleStore.getState().locale
    const text = (zhCNText: string, enUSText: string) => requestLocale === 'en-US' ? enUSText : zhCNText
    let skillInvocation: { skill: LoadedSkill; input: string } | null = null

    // 确保 Tool 已初始化
    get().initializeTools()

    // ===== P0-4: / 命令拦截 =====
    const trimmedContent = content.trim()
    if (trimmedContent.startsWith('/')) {
      const { command, args } = parseSlashCommand(trimmedContent, requestLocale)
      if (command) {
        switch (command.name) {
          case 'clear': {
            const activeConv = get().getActiveConversation()
            if (activeConv) {
              set(state => ({
                conversations: state.conversations.map(c =>
                  c.id === activeConv.id ? { ...c, messages: [] } : c
                ),
              }))
            }
            return
          }
          case 'new':
            get().createConversation()
            return
          case 'help': {
            // 构造帮助信息作为系统消息
            const helpConv = get().getActiveConversation() ?? get().createConversation()
            const helpMsg: AgentMessage = {
              id: genId(), role: 'assistant', content: generateHelpText(requestLocale), createdAt: Date.now(),
            }
            set(state => ({
              conversations: state.conversations.map(c =>
                c.id === helpConv.id ? { ...c, messages: [...c.messages, helpMsg] } : c
              ),
            }))
            return
          }
          case 'status': {
            // /status → 直接将 read_project_state 的结果展示
            // 不拦截，作为普通消息让 Agent 处理（它会调用 read_project_state）
            break
          }
          default:
            // Skill 命令：把 Skill 内容注入到用户消息中
            if (command.source === 'skill' && command.skill) {
              skillInvocation = {
                skill: command.skill,
                input: args,
              }
            }
            break
        }
      }
    }

    // 确保有活跃会话（无则创建）
    let conv = recoveryHandle ? get().conversations.find(item => item.messages.some(message =>
      message.mainGenerationHandle?.rootActionId === recoveryHandle.rootActionId)) : get().getActiveConversation()
    if (!conv) {
      conv = get().createConversation()
    }
    const convId = conv.id
    const modelId = conv.modelId ?? useLLMStore.getState().defaultModelId ?? undefined
    const executionContext = createAgentExecutionContext(modelId, requestLocale)
    const editor = useEditorStore.getState()
    const activeTab = editor.tabs.find(tab => tab.id === editor.activeTabId && tab.projectKey === executionContext.projectSession?.projectPath)
    const editorContext = activeTab ? `${activeTab.name} (${activeTab.type}${activeTab.dirty ? ', unsaved' : ''})\n${(activeTab.content ?? '').slice(0, 500)}` : undefined
    const modelText = (zhCNText: string, enUSText: string) => writingLanguageText(
      executionContext.writingLanguage,
      zhCNText,
      enUSText,
    )
    if (skillInvocation) {
      const skill = skillInvocation.skill
      const displayName = executionContext.writingLanguage === 'en-US'
        ? (skill.writingSkill.metadata.displayName ?? skill.metadata.name)
        : (skill.metadata.displayName ?? skill.metadata.name)
      let skillContent = skill.localizedContent?.[executionContext.writingLanguage] ?? skill.content
      if (skillInvocation.input) {
        skillContent = skillContent
          .replace(/\$\{args\}/g, skillInvocation.input)
          .replace(/\$1/g, skillInvocation.input)
      }
      content = `${modelText('[用户使用了 Skill:', '[The user invoked Skill:')} ${displayName}]\n\n${modelText('用户输入:', 'User input:')} ${skillInvocation.input || modelText('(无额外参数)', '(no additional arguments)')}\n\n---\n\n${skillContent}`
    }

    // 构建用户消息
    const userMsg: AgentMessage = {
      id: genId(),
      role: 'user',
      content: content.trim(),
      createdAt: Date.now(),
    }

    // 构建占位助手消息（ReAct 循环中实时更新）
    const existingAssistant = recoveryHandle ? conv.messages.find(message => message.role === 'assistant'
      && message.mainGenerationHandle?.rootActionId === recoveryHandle.rootActionId) : undefined
    const assistantMsg: AgentMessage = {
      id: existingAssistant?.id ?? genId(),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      streaming: true,
      toolCalls: [],
      artifacts: existingAssistant?.artifacts ?? [],
      ...(recoveryHandle ? { mainGenerationHandle: recoveryHandle } : {}),
    }

    // 更新会话标题（取第一条用户消息）
    const isFirstMsg = conv.messages.length === 0
    const newTitle = isFirstMsg ? generateTitle(content) : conv.title

    // 把用户消息 + 空助手消息写入会话
    set(state => ({
      generating: true,
      conversations: state.conversations.map(c =>
        c.id === convId
          ? {
              ...c,
              title: newTitle,
              messages: existingAssistant ? c.messages.map(message => message.id === assistantMsg.id ? assistantMsg : message) : [...c.messages, userMsg, assistantMsg],
              updatedAt: Date.now(),
            }
          : c
      ),
    }))
    activeRequestUiLocale = requestLocale
    const abortController = new AbortController()
    activeAbortController = abortController
    set({ activeRequestId: assistantMsg.id, activeConversationId: convId })

    // 辅助函数：更新助手消息
    const updateAssistantMsg = (updater: (msg: AgentMessage) => AgentMessage) => {
      if (get().activeRequestId !== assistantMsg.id) return
      set(state => ({
        conversations: state.conversations.map(c =>
          c.id === convId
            ? {
                ...c,
                messages: c.messages.map(m =>
                  m.id === assistantMsg.id ? updater(m) : m
                ),
              }
            : c
        ),
      }))
    }

    const client = executionContext.projectSession ? new AgentGenerationClient(executionContext.projectSession, recovery => {
      set(state => ({ conversations: state.conversations.map(conversation => conversation.id === convId
        ? { ...conversation, messages: conversation.messages.map(message => message.id === assistantMsg.id
          ? { ...message, mainGenerationHandle: recovery.handle } : message) } : conversation) }))
    }) : null
    activeGenerationClient = client
    const frozenTools = toolRegistry.listAll().map(tool => ({ name: tool.name,
      description: executionContext.writingLanguage === 'en-US' ? tool.descriptionEn ?? tool.description : tool.description,
      inputSchema: { ...structuredClone(tool.inputSchema) }, requiresConfirmation: tool.requiresConfirmation,
      isReadOnly: tool.isReadOnly, source: tool.source }))
    try {
      if (!client) throw new Error('GENERATION_AGENT_PROJECT_REQUIRED')
      const currentConv = get().conversations.find(c => c.id === convId)!

      // ===== P1-5: @ 提及预取 =====
      let enrichedUserMessage = content.trim()
      const mentions = parseMentions(enrichedUserMessage, requestLocale)
      if (!recoveryHandle && mentions.length > 0) {
        const prefetchCalls = mentionsToToolCalls(mentions)
        const prefetchResults: string[] = []
        for (const call of prefetchCalls) {
          const tool = toolRegistry.get(call.toolName)
          if (tool) {
            try {
              const result = await tool.execute(call.args, executionContext)
              if (result.success && result.content) {
                prefetchResults.push(`${modelText('[预加载上下文', '[Prefetched context')} @${call.toolName}]\n${result.content}`)
              }
            } catch {
              // 预取失败不阻塞主流程
            }
          }
        }
        if (prefetchResults.length > 0) {
          enrichedUserMessage = `${enrichedUserMessage}\n\n---\n${modelText(
            '以下是用户 @ 引用的上下文数据（已自动获取）：',
            'The following context was requested with @ and fetched automatically:',
          )}\n\n${prefetchResults.join('\n\n---\n\n')}`
        }
      }

      // 构造历史消息（取最近 16 条非流式消息）
      const historyMessages: LLMMessage[] = currentConv.messages
        .filter(m => !m.streaming && m.role !== 'system' && m.id !== userMsg.id)
        .slice(-16)
        .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))

      assertAgentProjectCurrent(executionContext)
      if (abortController.signal.aborted) return
      let recovery: AgentGenerationRecovery
      if (recoveryHandle) {
        recovery = await client.read(recoveryHandle)
        requestLocale = recovery.context.input.uiLocale
        activeRequestUiLocale = requestLocale
        set(state => ({ conversations: state.conversations.map(conversation => conversation.id === convId
          ? { ...conversation, title: isFirstMsg ? generateTitle(recovery.context.input.userMessage) : conversation.title,
              messages: conversation.messages.map(message => message.id === userMsg.id
                ? { ...message, content: recovery.context.input.userMessage } : message) } : conversation) }))
        if (recovery.sourceStatus !== 'current') {
          updateAssistantMsg(message => ({ ...message, content: recovery.rounds.map(round => round.visibleText).join('') }))
          throw new Error('GENERATION_SOURCE_CHANGED')
        }
        const incomplete = recovery.rounds.some(round => round.status === 'unknown' || round.status === 'incomplete'
          || round.actions.some(action => action.status === 'unknown' || action.status === 'running'))
        if (!incomplete && (recovery.nextRound !== null || recovery.rounds.some(round => round.actions.some(action => action.status === 'pending')))) {
          recovery = await client.resume(recovery.handle)
        }
      } else {
        if (!modelId) throw new Error('GENERATION_AGENT_MODEL_REQUIRED')
        recovery = await client.begin({ uiActionNonce: assistantMsg.id, modelId, input: {
          mode: currentConv.mode, uiLocale: requestLocale, historyMessages: historyMessages as Array<{ role: 'user' | 'assistant'; content: string }>,
          userMessage: enrichedUserMessage, ...(editorContext ? { editorContext } : {}), tools: frozenTools,
        } })
      }
      if (abortController.signal.aborted) { await client.cancel(); return }
      let roundIndex = 0
      await runAgentLoop(
        '', [], recovery.context.input.userMessage, recovery.modelId,
        async () => client.round(roundIndex++),
        {
          onTextChunk: (chunk) => {
            if (!chunk) return
            updateAssistantMsg(m => ({
              ...m,
              content: m.content + chunk,
            }))
          },
          onToolCallStart: (toolCall) => {
            updateAssistantMsg(m => ({
              ...m,
              toolCalls: [...(m.toolCalls ?? []), toolCall],
            }))
          },
          onToolCallComplete: (toolCall) => {
            updateAssistantMsg(m => ({
              ...m,
              toolCalls: (m.toolCalls ?? []).map(tc =>
                tc.id === toolCall.id ? toolCall : tc
              ),
            }))
          },
          onToolCallConfirmRequired: (toolCall) => {
            if (get().activeRequestId !== assistantMsg.id || abortController.signal.aborted) return Promise.resolve(false)
            // 更新 UI 显示确认状态
            updateAssistantMsg(m => ({
              ...m,
              toolCalls: (m.toolCalls ?? []).map(tc =>
                tc.id === toolCall.id ? { ...tc, status: 'waiting_confirm' as const } : tc
              ),
            }))

            // 返回 Promise，等待用户通过 resolveToolConfirmation 响应
            return new Promise<boolean | ToolConfirmationDecision>((resolve) => {
              pendingConfirmations.set(toolCall.id, { resolve })
            })
          },
          onDone: (fullText, toolCalls, artifacts) => {
            if (get().activeRequestId !== assistantMsg.id) return
            activeAbortController = null
            activeRequestUiLocale = null
            updateAssistantMsg(m => ({
              ...m,
              content: fullText,
              streaming: false,
              toolCalls,
              artifacts: [...(existingAssistant?.artifacts ?? []), ...artifacts],
            }))
            set(state => ({
              generating: false,
              activeRequestId: null,
              conversations: state.conversations.map(c =>
                c.id === convId ? { ...c, updatedAt: Date.now() } : c
              ),
            }))
          },
          onError: () => {
            if (get().activeRequestId !== assistantMsg.id) return
            activeAbortController = null
            activeRequestUiLocale = null
            updateAssistantMsg(m => ({
              ...m,
              content: m.content ? m.content + text('\n\n生成未完成，原候选已保留。', '\n\nGeneration did not finish; the original candidate was retained.')
                : text('生成失败，请重试。', 'Generation failed. Please try again.'),
              streaming: false,
            }))
            set({ generating: false, activeRequestId: null })
          },
        },
        abortController.signal,
        Object.freeze({ ...executionContext, selectedModelId: recovery.modelId, writingLanguage: recovery.context.writingLanguage,
          uiLocale: recovery.context.input.uiLocale, agentGeneration: client }),
      )
    } catch (error) {
      if (get().activeRequestId !== assistantMsg.id) return
      activeAbortController = null
      activeRequestUiLocale = null
      updateAssistantMsg(m => ({
        ...m,
        content: (m.content ? m.content + '\n\n' : '') + (error instanceof Error && error.message === 'GENERATION_AGENT_PROJECT_REQUIRED'
          ? text('请先打开项目，再使用 AI 助手。', 'Open a project before using the AI assistant.')
          : error instanceof Error && error.message.includes('SOURCE_CHANGED')
            ? text('来源已变化，原候选已保留，未继续生成或写入。', 'The source changed. The original candidate was retained without further generation or writes.')
            : text('生成失败，请重试。', 'Generation failed. Please try again.')),
        streaming: false,
      }))
      set({ generating: false, activeRequestId: null })
    } finally {
      client?.close()
      if (activeGenerationClient === client) activeGenerationClient = null
      if (activeAbortController === abortController) activeAbortController = null
    }
  },

  resumeGeneration: async handle => { await get().sendMessage('', handle) },

  cancelGeneration: async () => {
    const cancelledUiLocale = activeRequestUiLocale ?? useLocaleStore.getState().locale
    const stoppedText = cancelledUiLocale === 'en-US'
      ? '\n\n_(Generation stopped)_'
      : '\n\n_（已停止生成）_'
    // P1-7: 触发 AbortSignal，使 ReAct 循环真正中止
    if (activeAbortController) {
      activeAbortController.abort()
      activeAbortController = null
    }

    // P1-8: 清理所有等待确认的 Promise，防止内存泄漏
    for (const [, pending] of pendingConfirmations) {
      pending.resolve(false) // 取消时默认拒绝
    }
    pendingConfirmations.clear()

    // 找到正在 streaming 的消息，关闭其状态
    set(state => ({
      generating: false,
      activeRequestId: null,
      conversations: state.conversations.map(c => ({
        ...c,
        messages: c.messages.map(m =>
          m.streaming ? { ...m, streaming: false, content: m.content + stoppedText } : m
        ),
      })),
    }))
    const client = activeGenerationClient
    if (client) {
      try { await client.cancel() } catch {
        set(state => ({ conversations: state.conversations.map(conversation => ({ ...conversation,
          messages: conversation.messages.map(message => message.mainGenerationHandle?.rootActionId === client.recovery.handle.rootActionId
            ? { ...message, content: message.content + (cancelledUiLocale === 'en-US'
              ? '\nThe stop request has not been confirmed.' : '\n停止请求尚未确认。') } : message),
        })) }))
      }
    }
  },

  resolveToolConfirmation: (toolCallId, confirmed, options) => {
    const pending = pendingConfirmations.get(toolCallId)
    if (pending) {
      pending.resolve(confirmed && options?.blueprintProposals?.length
        ? { confirmed: true, blueprintProposals: options.blueprintProposals }
        : confirmed)
      pendingConfirmations.delete(toolCallId)
    }
  },
}))
