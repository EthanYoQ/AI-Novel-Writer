import { create } from 'zustand'
import { buildAgentSystemPrompt } from '../services/agent/context-builder'
import {
  cleanAgentVisibleText,
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
  type MentionTarget,
  getAllSlashCommands,
  parseSlashCommand,
  parseMentions,
  mentionsToToolCalls,
} from '../services/agent/intent-router'
import { toolRegistry } from '../services/agent/tool-registry'
import type { ToolArtifact } from '../services/agent/tool-registry'
import { createAgentExecutionContext } from '../services/agent/tools/project-context'
import { createGenerationRuntime } from '../services/generation/generation-runtime'
import { writingLanguageText } from '../shared/writing-language'
import { sameProjectPathKey } from '../shared/project-session-context'
import { useLocaleStore } from './locale-store'
import { useProjectStore } from './project-store'
import { useWorldSettingStore } from './world-setting-store'
import type { Locale } from '../i18n/types'

export const AGENT_GENERATION_BUDGET = Object.freeze({
  maxAttempts: 8,
  maxRequestedOutputTokens: 65_536,
  maxRequestedOutputTokensPerAttempt: 8192,
  deadlineMs: 20 * 60_000,
})

// ===== @ 引用预取的硬闸门 =====
//
// @ 预取是直通提示词的一条路径，如果不设限，作者手打多个 @ 就能把整份架构、
// 整章正文原样拼进去 —— 上下文会当场击穿。这三个上限是**独立于工具自身**的兜底，
// 因为工具（如 read_architecture / read_drafts）返回的是全文，自己不做截断。

/** 单条 @ 引用预取结果的字符上限（与 ReAct 循环里的工具结果上限保持一致）。 */
const PREFETCH_ENTRY_MAX_CHARS = 3000

/** 一轮对话内 @ 预取的总字节上限：超出后不再取更多，并如实告知模型与作者。 */
const PREFETCH_TOTAL_MAX_UTF8_BYTES = 16 * 1024

/** 一轮对话内 @ 引用的最大条数：超出部分不预取。 */
const PREFETCH_MAX_ENTRIES = 8

/**
 * 按 UTF-8 字节截断，尽量不截断在字符中间（避免产生半个汉字）。
 * 返回实际写入的字节数，供调用方累计总量。
 */
function truncateUtf8(text: string, maxBytes: number): { text: string; bytes: number } {
  const encoder = new TextEncoder()
  const total = encoder.encode(text).byteLength
  if (total <= maxBytes) return { text, bytes: total }

  let kept = text
  while (kept.length > 0) {
    kept = kept.slice(0, -1)
    const bytes = encoder.encode(kept).byteLength
    if (bytes <= maxBytes) return { text: kept, bytes }
  }
  return { text: '', bytes: 0 }
}

// ===== 类型定义 =====

/** 对话模式：Planning（深度推理）/ Fast（快速执行） */
export type AgentMode = 'planning' | 'fast'

/** 单条消息 */
export interface AgentMessage {
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

/** 一轮对话内 @ 引用清单的条数上限（先生定的铁律：不允许重复 @ 同样内容）。 */
export const PENDING_MENTION_MAX_ENTRIES = 12

/** 引用清单的去重键：类别 + 值。同名但不同类别（如角色「青云」与设定「青云」）算两条。 */
function pendingMentionKey(target: { type: string; value: string }): string {
  return `${target.type}:${target.value}`
}

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
  /**
   * 待发送的引用清单。
   *
   * 先生定的交互：**@ 是「攒引用」，不是「发消息」** ——
   * 作者可以连续 @ 主角、配角、某条设定，凑齐了再自己决定何时发送。
   * 引用只在按下发送那一刻才拼进消息。
   */
  pendingMentions: MentionTarget[]
  addPendingMention: (target: MentionTarget) => void
  removePendingMention: (value: string) => void
  clearPendingMentions: () => void
  /** 设置当前会话模式 */
  setMode: (mode: AgentMode) => void
  /** 设置当前会话使用的模型 */
  setModelId: (modelId: string | null) => void
  /** 发送消息（触发 Agent ReAct 循环） */
  sendMessage: (content: string) => Promise<void>
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

/**
 * 等待作者点击「确认 / 拒绝」的上限。
 * 超时按「未回应」处理（等同拒绝），让 ReAct 循环带着明确说明继续，
 * 而不是把整个生成悬挂在那里。给足 5 分钟，避免作者正在阅读提案时被打断。
 */
const TOOL_CONFIRM_TIMEOUT_MS = 5 * 60_000

/** 存储待确认的 Tool 回调 */
const pendingConfirmations = new Map<string, {
  resolve: (decision: boolean | ToolConfirmationDecision) => void
}>()

/** 当前活跃的 AbortController（用于取消 ReAct 循环） */
let activeAbortController: AbortController | null = null
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

  // 引用清单初始为空：@ 只是往这里加，不触发任何对话
  pendingMentions: [],

  addPendingMention: (target) => set((state) => {
    // 铁律：同一轮对话里不允许重复 @ 同样内容 —— 重复 @ 不该叠加成多份上下文。
    // 按「类别 + 值」判重，同名但不同类别的内容仍是两条。
    const key = pendingMentionKey(target)
    if (state.pendingMentions.some(item => pendingMentionKey(item) === key)) return state
    // 容量闸门：引用清单本身也不能无限增长（发送时会全部拼成 @ 前缀）。
    if (state.pendingMentions.length >= PENDING_MENTION_MAX_ENTRIES) return state
    return { pendingMentions: [...state.pendingMentions, target] }
  }),
  removePendingMention: (value) => set((state) => ({
    pendingMentions: state.pendingMentions.filter(item => item.value !== value),
  })),
  clearPendingMentions: () => set({ pendingMentions: [] }),

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

  sendMessage: async (content) => {
    if (!content.trim() || get().generating) return
    const requestLocale = useLocaleStore.getState().locale
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
    let conv = get().getActiveConversation()
    if (!conv) {
      conv = get().createConversation()
    }
    const convId = conv.id
    const modelId = conv.modelId ?? undefined
    const executionContext = createAgentExecutionContext(modelId, requestLocale)
    const runtimeProject = executionContext.projectSession
      ? {
          projectSession: executionContext.projectSession,
          creativeStrategy: useProjectStore.getState().currentProject?.novelConfig.creativeStrategy ?? 'auto',
        }
      : {}
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
    const assistantMsg: AgentMessage = {
      id: genId(),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      streaming: true,
      toolCalls: [],
      artifacts: [],
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
              messages: [...c.messages, userMsg, assistantMsg],
              updatedAt: Date.now(),
            }
          : c
      ),
    }))
    activeRequestUiLocale = requestLocale

    // 辅助函数：更新助手消息
    const updateAssistantMsg = (updater: (msg: AgentMessage) => AgentMessage) => {
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

    try {
      const currentConv = get().conversations.find(c => c.id === convId)!

      // 系统提示词、@ 引用预取和随后 ReAct 循环必须共享同一个项目 lease。
      const systemPrompt = await buildAgentSystemPrompt(currentConv.mode, executionContext)

      // ===== P1-5: @ 提及预取 =====
      let enrichedUserMessage = content.trim()
      /**
       * 世界观设定条目也参与 @ 解析：作者写「@青云宗 这场戏怎么处理」时，
       * 那一条设定要被预取进来（走 search_world_settings）。
       * 只认 confirmed 条目 —— pending 候选不进上下文，这是先生定的闸门。
       *
       * 归属闸门：这些动态目标来自 store，而 store 只在侧栏 / @ 菜单挂载时加载，
       * 切项目后并不会自动刷新。若它属于别的项目，就绝不能进入 @ 目标表 ——
       * 否则作者在 B 里打一个 A 才有的名字，AI 会拿到 A 的设定当作 B 的事实。
       */
      const worldSettingStore = useWorldSettingStore.getState()
      const worldSettingsBelongToCurrentProject = worldSettingStore.dataProjectPath === null
        || (executionContext.projectSession !== null
          && sameProjectPathKey(
            worldSettingStore.dataProjectPath,
            executionContext.projectSession.projectPath,
          ))
      const worldSettingTargets = worldSettingsBelongToCurrentProject
        ? worldSettingStore.entries
            .filter(entry => entry.status !== 'pending')
            .map(entry => ({
              type: 'world-setting' as const,
              displayName: entry.name,
              value: entry.name,
            }))
        : []
      const mentions = parseMentions(enrichedUserMessage, requestLocale, worldSettingTargets)
      if (mentions.length > 0) {
        // mentionsToToolCalls 内部已按「工具名 + 参数」去重：
        // 同一轮里重复 @ 同一份内容只会预取一次（先生定的铁律）。
        const prefetchCalls = mentionsToToolCalls(mentions)
        const prefetchResults: string[] = []
        let usedBytes = 0
        let truncatedEntries = 0
        let skippedEntries = 0

        for (const call of prefetchCalls) {
          if (prefetchResults.length >= PREFETCH_MAX_ENTRIES) {
            skippedEntries = prefetchCalls.length - prefetchResults.length
            break
          }
          const tool = toolRegistry.get(call.toolName)
          if (!tool) continue
          try {
            const result = await tool.execute(call.args, executionContext)
            if (!result.success || !result.content) continue

            // 单条截断：工具返回的可能是整章正文，不能原样塞进提示词。
            const source = `${modelText('[预加载上下文', '[Prefetched context')} @${call.toolName}]\n${result.content}`
            const remaining = PREFETCH_TOTAL_MAX_UTF8_BYTES - usedBytes
            if (remaining <= 0) {
              skippedEntries = prefetchCalls.length - prefetchResults.length
              break
            }
            const entryLimit = Math.min(PREFETCH_ENTRY_MAX_CHARS, remaining)
            const { text: kept, bytes } = truncateUtf8(source, entryLimit)
            usedBytes += bytes
            if (kept.length < source.length) truncatedEntries += 1
            prefetchResults.push(kept)
          } catch {
            // 预取失败不阻塞主流程
          }
        }

        if (prefetchResults.length > 0) {
          const notices: string[] = []
          if (truncatedEntries > 0) {
            notices.push(modelText(
              `（有 ${truncatedEntries} 条引用的内容过长，已截断）`,
              `(${truncatedEntries} reference(s) were truncated because the content was too long)`,
            ))
          }
          if (skippedEntries > 0) {
            notices.push(modelText(
              `（另有 ${skippedEntries} 条引用因超出本轮上下文上限而未加载，需要时请单独询问）`,
              `(${skippedEntries} more reference(s) were not loaded because this turn's context limit was reached; ask separately if needed)`,
            ))
          }
          enrichedUserMessage = `${enrichedUserMessage}\n\n---\n${modelText(
            '以下是用户 @ 引用的上下文数据（已自动获取，同一轮内重复引用只取一次）：',
            'The following context was requested with @ and fetched automatically (duplicates within one turn are fetched once):',
          )}\n\n${prefetchResults.join('\n\n---\n\n')}${notices.length > 0 ? `\n\n${notices.join('\n')}` : ''}`
        }
      }

      // 构造历史消息（取最近 16 条非流式消息）
      const historyMessages: LLMMessage[] = currentConv.messages
        .filter(m => !m.streaming && m.role !== 'system')
        .slice(-16)
        .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))

      // AbortController 用于取消（P1-7: 提升到模块级变量以便 cancelGeneration 访问）
      const abortController = new AbortController()
      activeAbortController = abortController
      set({ activeRequestId: assistantMsg.id })

      // 整个 ReAct 循环只冻结一个模型租约和一份调用/token/deadline预算。
      const runtime = await createGenerationRuntime({
        ...(modelId ? { modelId } : {}),
        ...runtimeProject,
        budget: AGENT_GENERATION_BUDGET,
      })
      await runtime.execute(async ({ session }) => runAgentLoop(
        systemPrompt,
        historyMessages,
        enrichedUserMessage,
        modelId,
        async (messages) => {
          const outcome = await session.complete({
            purpose: 'agent',
            reasoningStage: 'general',
            output: 'visible-text',
            messages: messages.map(message => ({
              role: message.role,
              content: message.content,
            })),
          }, { signal: abortController.signal })
          if (outcome.status !== 'completed') {
            switch (outcome.finishReason) {
              case 'length':
                throw new Error(text(
                  'AI 输出达到模型最大长度，未将不完整内容写入对话或执行工具。请提高模型最大输出 Tokens 或缩短任务后重试。',
                  'The AI response reached the model output limit. Incomplete content was not added to the conversation and no tool was run. Increase the model output-token limit or shorten the task, then try again.',
                ))
              case 'content_filter':
                throw new Error(text(
                  'AI 输出因内容限制而未完成，未将不完整内容写入对话或执行工具。',
                  'The AI response was stopped by a content restriction. Incomplete content was not added to the conversation and no tool was run.',
                ))
              default:
                throw new Error(text(
                  'AI 未正常完成生成，未将不完整内容写入对话或执行工具。',
                  'The AI did not complete the response normally. Incomplete content was not added to the conversation and no tool was run.',
                ))
            }
          }
          return outcome.content
        },
        {
          onTextChunk: (chunk) => {
            const cleaned = cleanAgentVisibleText(chunk)
            if (!cleaned) return
            updateAssistantMsg(m => ({
              ...m,
              content: m.content + cleaned,
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
            // 更新 UI 显示确认状态
            updateAssistantMsg(m => ({
              ...m,
              toolCalls: (m.toolCalls ?? []).map(tc =>
                tc.id === toolCall.id ? { ...tc, status: 'waiting_confirm' as const } : tc
              ),
            }))

            // 返回 Promise，等待用户通过 resolveToolConfirmation 响应。
            //
            // ⚠️ 必须有超时兜底：这段等待在 executeToolWithTimeout 之外，harness 的
            // deadline 只覆盖 session.complete，所以它原本**没有任何时间上限**。
            // 确认卡片弹出后，作者若切走视角、关掉对话或干脆离开，ReAct 循环、
            // generating 状态与模型租约就会一直挂着（租约要等主进程 TTL 才回收）。
            // 超时后按「用户未回应」处理：拒绝该操作并让循环带着明确说明继续。
            return new Promise<boolean | ToolConfirmationDecision>((resolve) => {
              const timer = setTimeout(() => {
                pendingConfirmations.delete(toolCall.id)
                resolve(false)
              }, TOOL_CONFIRM_TIMEOUT_MS)
              pendingConfirmations.set(toolCall.id, {
                resolve: (decision) => {
                  clearTimeout(timer)
                  resolve(decision)
                },
              })
            })
          },
          onDone: (fullText, toolCalls, artifacts) => {
            activeAbortController = null
            activeRequestUiLocale = null
            const cleanedText = cleanAgentVisibleText(fullText)
            updateAssistantMsg(m => ({
              ...m,
              content: cleanedText,
              streaming: false,
              toolCalls,
              artifacts: artifacts.length > 0 ? artifacts : undefined,
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
            activeAbortController = null
            activeRequestUiLocale = null
            updateAssistantMsg(m => ({
              ...m,
              content: text('生成失败，请重试。', 'Generation failed. Please try again.'),
              streaming: false,
            }))
            set({ generating: false, activeRequestId: null })
          },
        },
        abortController.signal,
        executionContext,
      ))
    } catch {
      activeAbortController = null
      activeRequestUiLocale = null
      updateAssistantMsg(m => ({
        ...m,
        content: text('生成失败，请重试。', 'Generation failed. Please try again.'),
        streaming: false,
      }))
      set({ generating: false, activeRequestId: null })
    }
  },

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
