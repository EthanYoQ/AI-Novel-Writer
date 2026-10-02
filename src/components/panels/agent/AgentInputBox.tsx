import { useRef, useState, useEffect, useCallback } from 'react'
import {
  Plus,
  ChevronDown,
  ArrowRight,
  Square,
  Image,
  AtSign,
  Workflow,
  X,
} from 'lucide-react'
import { useAgentStore, type AgentMode } from '../../../stores/agent-store'
import { useLLMStore } from '../../../stores/llm-store'
import type { ModelProfile } from '../../../shared/ipc-channels'
import { useOutsideClick } from '../../../hooks/useOutsideClick'
import SlashCommandMenu from './SlashCommandMenu'
import MentionMenu, { type MentionAnchor } from './MentionMenu'
import type { SlashCommand, MentionTarget } from '../../../services/agent/intent-router'
import { useLocaleStore } from '../../../stores/locale-store'

/** 输入框最大高度（px），超出后框内滚动 */
const MAX_HEIGHT = 200

/**
 * Agent 输入框组件（参考 agent1.html 第 69-155 行）
 * 卡片式圆角容器，底部工具栏含模式/模型/发送
 */
export default function AgentInputBox() {
  const text = useLocaleStore(s => s.text)
  const [inputText, setInputText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const {
    generating, sendMessage, cancelGeneration, getActiveConversation, setMode, setModelId,
    pendingMentions, addPendingMention, removePendingMention, clearPendingMentions,
  } = useAgentStore()
  const models = useLLMStore(s => s.models)
  const defaultModelId = useLLMStore(s => s.defaultModelId)

  // 过滤出非仅限 embedding 专用的模型
  const chatModels = models.filter(m => !(m.purposes.length === 1 && m.purposes[0] === 'embedding'))

  const activeConv = getActiveConversation()
  const currentMode = activeConv?.mode ?? 'planning'
  const currentModelId = activeConv?.modelId ?? defaultModelId

  // 找到当前模型信息
  const currentModel = models.find(m => m.id === currentModelId)

  // 下拉菜单状态
  const [showContextMenu, setShowContextMenu] = useState(false)
  const [showModeMenu, setShowModeMenu] = useState(false)
  const [showModelMenu, setShowModelMenu] = useState(false)

  // / 命令和 @ 提及菜单状态
  const [showSlashMenu, setShowSlashMenu] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const [showMentionMenu, setShowMentionMenu] = useState(false)
  /** 输入框在屏幕上的位置：@ 菜单贴着它展开。 */
  const [mentionAnchor, setMentionAnchor] = useState<MentionAnchor | null>(null)
  const [mentionQuery, setMentionQuery] = useState('')

  // 检测输入是否触发 / 或 @ 菜单
  const handleInputChange = useCallback((value: string) => {
    setInputText(value)

    // 检测 / 命令
    if (value.startsWith('/')) {
      const q = value.slice(1).split(' ')[0] ?? ''
      setSlashQuery(q)
      setShowSlashMenu(true)
      setShowMentionMenu(false)
    } else {
      setShowSlashMenu(false)
    }

    // 检测 @ 提及（在光标位置前面找 @）
    const lastAt = value.lastIndexOf('@')
    if (lastAt >= 0) {
      const afterAt = value.slice(lastAt + 1)
      // 如果 @ 后面没有空格，视为正在输入提及
      if (!afterAt.includes(' ')) {
        // 记下输入框位置：菜单要贴着它展开（先生：就近才符合操作逻辑）
        const rect = textareaRef.current?.getBoundingClientRect()
        if (rect && typeof window !== 'undefined') {
          setMentionAnchor({
            left: rect.left,
            top: rect.top,
            bottom: rect.bottom,
            viewportHeight: window.innerHeight,
            viewportWidth: window.innerWidth,
          })
        }
        setMentionQuery(afterAt)
        setShowMentionMenu(true)
        setShowSlashMenu(false)
      } else {
        setShowMentionMenu(false)
      }
    } else {
      setShowMentionMenu(false)
    }
  }, [])

  // 选择 / 命令
  const handleSlashSelect = useCallback((cmd: SlashCommand) => {
    setShowSlashMenu(false)
    if (cmd.source === 'skill') {
      // Skill 命令：替换为 /skill-name 后面可以加参数
      setInputText(`/${cmd.name} `)
    } else {
      // 内置命令：直接发送
      setInputText('')
      sendMessage(`/${cmd.name}`)
    }
    textareaRef.current?.focus()
  }, [sendMessage])

  // 选择 @ 提及
  const handleMentionSelect = useCallback((target: MentionTarget) => {
    setShowMentionMenu(false)
    /**
     * 先生：@ **只是把内容攒进引用清单**，不写进正文、更不触发对话 ——
     * 作者可以连着 @ 主角、配角、几条设定，凑齐了再一起发送。
     */
    addPendingMention(target)
    textareaRef.current?.focus()
  }, [addPendingMention])

  const contextRef = useRef<HTMLDivElement>(null)
  const modeRef = useRef<HTMLDivElement>(null)
  const modelRef = useRef<HTMLDivElement>(null)

  // 调整文本框高度的通用函数
  const adjustHeight = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    // 先重置为 0px，让 scrollHeight 正确反映内容高度，避免 flex 布局拉伸导致计算出很大的初始高度
    ta.style.height = '0px'
    const next = Math.min(Math.max(ta.scrollHeight, 36), MAX_HEIGHT)
    ta.style.height = next + 'px'
    // 超出最大高度时框内滚动，否则隐藏滚动条
    ta.style.overflowY = ta.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden'
  }, [])

  // 监听尺寸变化以重新计算高度，避免刚挂载时宽度未稳定导致的 placeholder 异常换行撑起高度
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) {
      adjustHeight()
      return
    }
    const ro = new ResizeObserver(() => {
      adjustHeight()
    })
    ro.observe(ta)
    
    // 初始化调用一次即可
    adjustHeight()

    return () => ro.disconnect()
  }, [adjustHeight])

  // 内容变化时重新调整高度
  useEffect(() => {
    adjustHeight()
  }, [inputText, adjustHeight])

  // 点击外部关闭下拉（用 useOutsideClick 统一管理三个 ref）
  useOutsideClick(contextRef, () => setShowContextMenu(false), showContextMenu)
  useOutsideClick(modeRef, () => setShowModeMenu(false), showModeMenu)
  useOutsideClick(modelRef, () => setShowModelMenu(false), showModelMenu)

  /** 发送或停止 */
  const handleSendOrStop = useCallback(async () => {
    if (generating) {
      await cancelGeneration()
      return
    }
    if (!inputText.trim() && pendingMentions.length === 0) return
    const text = inputText
    // 引用只在**发送这一刻**拼进消息（先生：@ 是攒引用，不是发消息）。
    // 拼成 `@名字 …` 后仍走既有的 mention 预取机制，所以上下文照旧自动带进来。
    const mentionPrefix = pendingMentions.map(item => `@${item.displayName}`).join(' ')
    setInputText('')
    clearPendingMentions()
    await sendMessage(mentionPrefix ? `${mentionPrefix} ${text}`.trim() : text)
  }, [generating, inputText, pendingMentions, sendMessage, cancelGeneration, clearPendingMentions])

  /** 键盘事件：Enter 发送，Shift+Enter 换行 */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // / 或 @ 菜单打开时，由菜单组件处理键盘事件
    if (showSlashMenu || showMentionMenu) {
      if (['ArrowUp', 'ArrowDown', 'Enter'].includes(e.key)) {
        return // 让菜单组件通过 window 事件处理
      }
      if (e.key === 'Escape') {
        setShowSlashMenu(false)
        setShowMentionMenu(false)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSendOrStop()
    }
  }

  // 只有引用、没有文字也允许发送：作者可能只想把这几条内容交给 AI
  const canSend = !generating && (inputText.trim().length > 0 || pendingMentions.length > 0)

  return (
    <div
      className="agent-input relative flex flex-col gap-0 p-1.5"
      style={{
        /* 三个变量只在 v2 被重绑成 demo 的输入框外观（见 v2-panels.css）；
           经典界面下退回产品原值，v1 逐像素不变。 */
        backgroundColor: 'var(--agent-input-bg, var(--color-hover))',
        border: '1px solid var(--agent-input-border, var(--color-border))',
        borderRadius: 'var(--agent-input-radius, var(--radius-md))',
      }}
    >
      {/* / 命令菜单 */}
      {showSlashMenu && (
        <SlashCommandMenu
          query={slashQuery}
          onSelect={handleSlashSelect}
          onClose={() => setShowSlashMenu(false)}
        />
      )}

      {/* @ 提及菜单 */}
      {/* 已引用内容（先生：@ 可以连续攒多条，逐个可移除） */}
      {pendingMentions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 px-1 pb-1">
          {pendingMentions.map(item => (
            <span
              key={item.value}
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px]"
              style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-text-secondary)' }}
              title={item.hint ?? item.displayName}
            >
              @{item.displayName}
              <button
                type="button"
                className="cursor-pointer opacity-60 hover:opacity-100"
                aria-label={text('移除引用', 'Remove reference')}
                onClick={() => removePendingMention(item.value)}
              >
                <X size={9} />
              </button>
            </span>
          ))}
        </div>
      )}

      {showMentionMenu && (
        <MentionMenu
          query={mentionQuery}
          onSelect={handleMentionSelect}
          onClose={() => setShowMentionMenu(false)}
          anchor={mentionAnchor}
        />
      )}

      {/* 上下文菜单（+ 按钮弹出） */}
      {showContextMenu && (
        <div
          className="absolute bottom-[calc(100%+8px)] left-0 z-50 py-1 rounded-lg shadow-lg"
          style={{
            width: 180,
            backgroundColor: 'var(--color-sidebar)',
            border: '1px solid var(--color-border)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
          }}
        >
          <div className="text-[0.7rem] px-3 pb-1 pt-1" style={{ color: 'var(--color-text-muted)' }}>
            {text('添加上下文', 'Add context')}
          </div>
          <ContextMenuItem icon={<Image size={13} />} label={text('媒体文件', 'Media file')} onClick={() => setShowContextMenu(false)} disabled />
          <ContextMenuItem icon={<AtSign size={13} />} label={text('@提及', '@ mention')} onClick={() => {
            setShowContextMenu(false)
            // 插入 @ 字符并触发 MentionMenu
            setInputText(prev => prev + '@')
            handleInputChange(inputText + '@')
            textareaRef.current?.focus()
          }} />
          <ContextMenuItem icon={<Workflow size={13} />} label={text('工作流命令', 'Workflow command')} onClick={() => {
            setShowContextMenu(false)
            // 插入 / 字符并触发 SlashCommandMenu
            setInputText('/')
            handleInputChange('/')
            textareaRef.current?.focus()
          }} />
        </div>
      )}

      {/* 输入区域 */}
      <div className="relative w-full">
          <textarea
            ref={textareaRef}
            value={inputText}
            onChange={e => handleInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={text('输入消息，@ 提及，/ 使用工作流...', 'Type a message, @ mention, or / use a workflow...')}
            rows={1}
            className="w-full resize-none outline-none bg-transparent text-xs leading-relaxed px-2 py-2"
            style={{
              color: 'var(--color-text)',
              minHeight: 36,
              maxHeight: MAX_HEIGHT,
              overflowY: 'hidden',
              display: 'block',
            }}
          />
        {/* 占位文字颜色已通过 tailwind placeholder 设置 */}
      </div>

      {/* 底部工具栏 */}
      <div className="flex items-center justify-between gap-1 px-1 mt-0.5">

        {/* 左侧工具按钮组 */}
        <div className="flex items-center gap-0.5 min-w-0 flex-1">

          {/* + 添加上下文 */}
          <div ref={contextRef}>
            <ToolbarIconBtn
              title={text('添加上下文', 'Add context')}
              onClick={() => {
                setShowModeMenu(false)
                setShowModelMenu(false)
                setShowContextMenu(v => !v)
              }}
            >
              <Plus size={14} />
            </ToolbarIconBtn>
          </div>

          {/* 模式选择 */}
          <div ref={modeRef} className="relative">
            <button
              onClick={() => {
                setShowContextMenu(false)
                setShowModelMenu(false)
                setShowModeMenu(v => !v)
              }}
              className="flex items-center gap-0.5 py-1 pl-1 pr-1.5 rounded-md text-xs transition-colors"
              style={{
                color: 'var(--color-text-secondary)',
                opacity: 0.75,
              }}
              onMouseEnter={e => {
                e.currentTarget.style.backgroundColor = 'var(--color-hover)'
                e.currentTarget.style.opacity = '1'
              }}
              onMouseLeave={e => {
                e.currentTarget.style.backgroundColor = 'transparent'
                e.currentTarget.style.opacity = '0.75'
              }}
            >
              <ChevronDown size={13} strokeWidth={1.5} />
              <span className="select-none">{currentMode === 'planning' ? text('深度', 'Deep') : text('快速', 'Fast')}</span>
            </button>

            {/* 模式选择下拉 */}
            {showModeMenu && (
              <div
                className="absolute bottom-full left-0 mb-1 z-50 py-1 rounded-lg shadow-lg"
                style={{
                  width: 240,
                  backgroundColor: 'var(--color-sidebar)',
                  border: '1px solid var(--color-border)',
                  boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
                }}
              >
                <div className="text-[0.7rem] px-3 py-1" style={{ color: 'var(--color-text-muted)' }}>
                  {text('对话模式', 'Conversation mode')}
                </div>
                <ModeMenuItem
                  mode="planning"
                  currentMode={currentMode}
                  label={text('深度模式', 'Deep mode')}
                  desc={text('先规划后执行，适合深度研究、复杂任务和协同创作', 'Plan before acting for research, complex tasks, and collaborative writing')}
                  onClick={() => { setMode('planning'); setShowModeMenu(false) }}
                />
                <ModeMenuItem
                  mode="fast"
                  currentMode={currentMode}
                  label={text('快速模式', 'Fast mode')}
                  desc={text('直接执行，适合简单快速任务', 'Act directly for simple, quick tasks')}
                  onClick={() => { setMode('fast'); setShowModeMenu(false) }}
                />
              </div>
            )}
          </div>

          {/* 模型选择 */}
          <div ref={modelRef} className="relative min-w-0">
            <button
              onClick={() => {
                setShowContextMenu(false)
                setShowModeMenu(false)
                setShowModelMenu(v => !v)
              }}
              className="flex items-center gap-0.5 py-1 pl-0.5 pr-1.5 rounded-md text-xs min-w-0 transition-colors"
              style={{
                color: 'var(--color-text-secondary)',
                opacity: 0.75,
                maxWidth: 140,
              }}
              onMouseEnter={e => {
                e.currentTarget.style.backgroundColor = 'var(--color-hover)'
                e.currentTarget.style.opacity = '1'
              }}
              onMouseLeave={e => {
                e.currentTarget.style.backgroundColor = 'transparent'
                e.currentTarget.style.opacity = '0.75'
              }}
            >
              <ChevronDown size={13} strokeWidth={1.5} className="flex-shrink-0" />
              <span className="truncate select-none">
                {currentModel?.name ?? (chatModels.length === 0 ? text('未配置模型', 'No model configured') : text('选择模型', 'Select model'))}
              </span>
            </button>

            {/* 模型选择下拉 */}
            {showModelMenu && (
              <div
                className="absolute bottom-full left-0 mb-1 z-50 py-1 rounded-lg shadow-lg"
                style={{
                  width: 220,
                  backgroundColor: 'var(--color-sidebar)',
                  border: '1px solid var(--color-border)',
                  boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
                  maxHeight: 280,
                  overflowY: 'auto',
                }}
              >
                <div className="text-[0.7rem] px-3 py-1" style={{ color: 'var(--color-text-muted)' }}>
                  {text('选择模型', 'Select model')}
                </div>
                {chatModels.length === 0 ? (
                  <div className="px-3 py-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                    {text('请先在设置中配置模型', 'Configure a model in Settings first')}
                  </div>
                ) : (
                  chatModels.map(model => (
                    <ModelMenuItem
                      key={model.id}
                      model={model}
                      isActive={model.id === currentModelId}
                      onClick={() => {
                        setModelId(model.id)
                        setShowModelMenu(false)
                      }}
                    />
                  ))
                )}
              </div>
            )}
          </div>
        </div>

        {/* 右侧：发送/停止 */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={handleSendOrStop}
            disabled={!generating && !canSend}
            className="btn primary sm flex items-center justify-center transition-all duration-150"
            style={{
              /* 外形交给 demo 的 .btn.primary.sm（朱砂底 / 25px 高 / 7px 圆角），
                 这里只留禁用态与停止态的可读性处理 */
              /* 先生：发送按钮下移 2px，与左侧控件在视觉基线上对齐 */
              marginTop: 2,
              minWidth: 32,
              ...(generating ? { background: 'var(--ink2)' } : {}),
              cursor: !generating && !canSend ? 'not-allowed' : 'pointer',
              opacity: !generating && !canSend ? 0.5 : 1,
            }}
            title={generating ? text('停止生成', 'Stop generation') : text('发送消息', 'Send message')}
          >
            {generating ? (
              <Square size={10} fill="currentColor" />
            ) : (
              <ArrowRight size={13} strokeWidth={2.5} />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

// ===== 子组件 =====

/** 工具栏图标按钮 */
function ToolbarIconBtn({
  children,
  title,
  onClick,
}: {
  children: React.ReactNode
  title: string
  onClick?: () => void
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="flex items-center justify-center p-1 rounded-full transition-colors"
      style={{ color: 'var(--color-text-secondary)', opacity: 0.75 }}
      onMouseEnter={e => {
        e.currentTarget.style.backgroundColor = 'var(--color-hover)'
        e.currentTarget.style.opacity = '1'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.backgroundColor = 'transparent'
        e.currentTarget.style.opacity = '0.75'
      }}
    >
      {children}
    </button>
  )
}

/** 上下文菜单项 */
function ContextMenuItem({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  const text = useLocaleStore(s => s.text)
  return (
    <button
      onClick={!disabled ? onClick : undefined}
      disabled={disabled}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors"
      style={{
        color: disabled ? 'var(--color-text-muted)' : 'var(--color-text)',
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
      onMouseEnter={e => {
        if (!disabled) e.currentTarget.style.backgroundColor = 'var(--color-hover)'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.backgroundColor = 'transparent'
      }}
    >
      <span style={{ color: 'var(--color-text-secondary)' }}>{icon}</span>
      {label}
      {disabled && <span className="ml-auto text-[0.7rem] opacity-40">{text('即将', 'Soon')}</span>}
    </button>
  )
}

/** 模式菜单项 */
function ModeMenuItem({
  mode,
  currentMode,
  label,
  desc,
  onClick,
}: {
  mode: AgentMode
  currentMode: AgentMode
  label: string
  desc: string
  onClick: () => void
}) {
  const isActive = mode === currentMode

  return (
    <button
      onClick={onClick}
      className="w-full flex flex-col items-start gap-0.5 px-3 py-2 text-left text-xs transition-colors rounded-md mx-1"
      style={{
        width: 'calc(100% - 8px)',
        backgroundColor: isActive ? 'var(--color-hover)' : 'transparent',
      }}
      onMouseEnter={e => {
        if (!isActive) e.currentTarget.style.backgroundColor = 'var(--color-hover)'
      }}
      onMouseLeave={e => {
        if (!isActive) e.currentTarget.style.backgroundColor = 'transparent'
      }}
    >
      <div className="font-medium" style={{ color: 'var(--color-text)' }}>{label}</div>
      <div className="text-left leading-relaxed" style={{ color: 'var(--color-text-muted)', fontSize: "0.75rem" }}>{desc}</div>
    </button>
  )
}

/** 模型菜单项 */
function ModelMenuItem({
  model,
  isActive,
  onClick,
}: {
  model: ModelProfile
  isActive: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center justify-between px-3 py-1.5 text-xs transition-colors"
      style={{
        backgroundColor: isActive ? 'var(--color-hover)' : 'transparent',
      }}
      onMouseEnter={e => {
        if (!isActive) e.currentTarget.style.backgroundColor = 'var(--color-hover)'
      }}
      onMouseLeave={e => {
        if (!isActive) e.currentTarget.style.backgroundColor = 'transparent'
      }}
    >
      <span
        className="font-medium truncate"
        style={{ color: 'var(--color-text)' }}
      >
        {model.name}
      </span>
      {model.provider && (
        <span
          className="ml-2 text-[0.7rem] px-1.5 py-0.5 rounded-full flex-shrink-0"
          style={{
            backgroundColor: 'var(--color-border)',
            color: 'var(--color-text-muted)',
          }}
        >
          {model.provider}
        </span>
      )}
    </button>
  )
}
