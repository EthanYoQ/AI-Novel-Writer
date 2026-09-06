import { Plus, MoreHorizontal, X, Server, Sparkles, ChevronRight, History } from 'lucide-react'
import { useAgentStore } from '../../../stores/agent-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { useMCPStore } from '../../../stores/mcp-store'
import { skillRegistry, type LoadedSkill } from '../../../services/agent/skill-registry'
import { useRef, useState } from 'react'
import { confirm } from '../../ui/Confirm'
import { IconBtn } from '../../ui/IconBtn'
import { MenuItem } from '../../ui/MenuItem'
import { useOutsideClick } from '../../../hooks/useOutsideClick'
import { useLocaleStore } from '../../../stores/locale-store'

/**
 * Agent 面板顶部工具栏
 */
export default function AgentHeader() {
  const text = useLocaleStore(s => s.text)
  const { createConversation, toggleHistory, showHistory, getActiveConversation } = useAgentStore()
  const toggleAIPanel = useLayoutStore(s => s.toggleAIPanel)
  const [showMore, setShowMore] = useState(false)
  const [subView, setSubView] = useState<'main' | 'mcp' | 'skills'>('main')
  const moreRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭更多菜单
  useOutsideClick(moreRef, () => { setShowMore(false); setSubView('main') }, showMore)

  // MCP 状态
  const { servers: mcpServers, tools: mcpTools } = useMCPStore()
  const connectedCount = mcpServers.filter(s => s.status === 'connected').length

  // Skill 列表（每次渲染重新读取，避免异步加载完成后仍展示旧列表）
  const skills = skillRegistry.listAll()

  /** 新建会话 */
  const handleNew = () => {
    createConversation()
  }

  /** 关闭 AI 面板 */
  const handleClose = () => {
    toggleAIPanel()
  }

  // 当前会话为空（无消息）时禁止新建
  const activeConv = getActiveConversation()
  const isCurrentEmpty = !activeConv || activeConv.messages.filter(m => m.role !== 'system').length === 0

  return (
    <div
      className="no-select flex items-center justify-between gap-1.5 px-2 flex-shrink-0"
      style={{
        height: 'var(--height-panel-header)',
        borderBottom: '1px solid var(--color-border)',
      }}
    >
      {/* 标题 */}
      <div
        className="flex min-w-0 items-center overflow-hidden text-ellipsis whitespace-nowrap gap-1"
        style={{ color: 'var(--color-text-secondary)', fontSize: '0.75rem', fontWeight: 500 }}
      >
        {text('AI 写作助手', 'AI Writing Assistant')}
      </div>

      {/* 右侧工具按钮组 */}
      <div className="flex items-center gap-1.5 px-0.5 flex-shrink-0">

        {/* 新建对话按钮 */}
        <IconBtn
          title={isCurrentEmpty ? text('当前对话为空，请先发送消息', 'The current conversation is empty') : text('新建对话', 'New conversation')}
          disabled={isCurrentEmpty}
          onClick={handleNew}
          size={18}
        >
          <Plus size={13} strokeWidth={1.5} />
        </IconBtn>

        {/* 历史记录按钮 */}
        <IconBtn
          title={text('历史对话', 'Conversation history')}
          onClick={toggleHistory}
          active={showHistory}
          size={18}
        >
          <History size={15} strokeWidth={1.5} />
        </IconBtn>

        {/* 更多菜单 */}
        <div className="relative" ref={moreRef}>
          <IconBtn
            title={text('更多选项', 'More options')}
            onClick={() => { setShowMore(v => !v); setSubView('main') }}
            active={showMore}
            size={18}
          >
            <MoreHorizontal size={15} strokeWidth={1.5} />
          </IconBtn>

          {/* 更多菜单下拉 */}
          {showMore && (
            <div
              className="absolute right-0 top-full mt-1 z-50 py-1 rounded-lg shadow-lg"
              style={{
                width: subView === 'main' ? 200 : 260,
                backgroundColor: 'var(--color-sidebar)',
                border: '1px solid var(--color-border)',
                boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
              }}
            >
              {/* ===== 主菜单视图 ===== */}
              {subView === 'main' && (
                <>
                  <MenuItem
                    label={text('MCP 服务器', 'MCP servers')}
                    icon={<Server size={13} />}
                    shortcut={connectedCount > 0 ? text(`${connectedCount} 在线`, `${connectedCount} online`) : ''}
                    onClick={() => setSubView('mcp')}
                  />
                  <MenuItem
                    label={text('技能列表', 'Skills')}
                    icon={<Sparkles size={13} />}
                    shortcut={skills.length > 0 ? text(`${skills.length} 个`, `${skills.length}`) : ''}
                    onClick={() => setSubView('skills')}
                  />
                  <div style={{ height: 1, backgroundColor: 'var(--color-border)', margin: '4px 0' }} />
                  <MenuItem
                    label={text('清空所有对话', 'Clear all conversations')}
                    danger
                    onClick={async () => {
                      setShowMore(false)
                      const ok = await confirm(text('确定要清空所有对话记录？\n此操作不可撤销。', 'Clear all conversation history?\nThis cannot be undone.'), {
                        title: text('清空对话记录', 'Clear conversation history'),
                        confirmText: text('确认清空', 'Clear all'),
                        danger: true,
                      })
                      if (ok) useAgentStore.getState().clearAll()
                    }}
                  />
                </>
              )}

              {/* ===== MCP 子视图 ===== */}
              {subView === 'mcp' && (
                <MCPSubView
                  servers={mcpServers}
                  toolCount={mcpTools.length}
                  onBack={() => setSubView('main')}
                />
              )}

              {/* ===== Skill 子视图 ===== */}
              {subView === 'skills' && (
                <SkillSubView
                  skills={skills}
                  onBack={() => setSubView('main')}
                />
              )}
            </div>
          )}
        </div>

        {/* 关闭面板按钮 */}
        <IconBtn title={text('关闭 Agent 面板', 'Close Agent panel')} onClick={handleClose} size={18}>
          <X size={15} strokeWidth={1.5} />
        </IconBtn>
      </div>
    </div>
  )
}

// ===== MCP 子视图 =====

function MCPSubView({
  servers,
  toolCount,
  onBack,
}: {
  servers: { id: string; name: string; status: string; toolCount: number; error?: string }[]
  toolCount: number
  onBack: () => void
}) {
  const text = useLocaleStore(s => s.text)
  const connectedCount = servers.filter(s => s.status === 'connected').length

  return (
    <>
      {/* 返回按钮 */}
      <button
        onClick={onBack}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors"
        style={{ color: 'var(--color-text-secondary)' }}
        onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--color-hover)')}
        onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
      >
        <ChevronRight size={12} style={{ transform: 'rotate(180deg)' }} />
        <span className="font-medium">{text('MCP 服务器', 'MCP servers')}</span>
        <span className="ml-auto text-[0.68rem] opacity-50">
          {text(`${connectedCount}/${servers.length} 在线`, `${connectedCount}/${servers.length} online`)}
        </span>
      </button>

      <div style={{ height: 1, backgroundColor: 'var(--color-border)', margin: '2px 0' }} />

      {/* 服务器列表 */}
      {servers.length === 0 ? (
        <div className="px-3 py-3 text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>
          <div className="mb-1">{text('暂无 MCP 服务器', 'No MCP servers')}</div>
          <div className="text-[0.68rem] opacity-60">
            {text('在用户配置目录中配置 MCP 服务器', 'Configure MCP servers in your user configuration directory')}
          </div>
        </div>
      ) : (
        <div className="py-1 max-h-[200px] overflow-y-auto">
          {servers.map(server => (
            <div
              key={server.id}
              className="flex items-center gap-2 px-3 py-1.5 text-xs"
            >
              {/* 状态灯 */}
              <span
                className="flex-shrink-0 w-1.5 h-1.5 rounded-full"
                style={{
                  backgroundColor:
                    server.status === 'connected' ? 'var(--color-success)'
                    : server.status === 'connecting' ? 'var(--color-warning)'
                    : server.status === 'error' ? 'var(--color-error)'
                    : 'var(--color-text-muted)',
                }}
              />
              <span
                className="flex-1 truncate font-medium"
                style={{ color: 'var(--color-text)' }}
              >
                {server.name}
              </span>
              {server.status === 'connected' && server.toolCount > 0 && (
                <span className="text-[0.65rem] opacity-50 flex-shrink-0">
                  {server.toolCount} tools
                </span>
              )}
              {server.status === 'error' && (
                <span
                  className="text-[0.65rem] text-[var(--color-error-text)] truncate max-w-[80px]"
                  title={text('服务器连接失败', 'Server connection failed')}
                >
                  {text('错误', 'Error')}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 底部统计 */}
      {toolCount > 0 && (
        <>
          <div style={{ height: 1, backgroundColor: 'var(--color-border)', margin: '2px 0' }} />
          <div className="px-3 py-1.5 text-[0.68rem]" style={{ color: 'var(--color-text-muted)' }}>
            {text(`共 ${toolCount} 个 MCP 工具已注册`, `${toolCount} MCP tools registered`)}
          </div>
        </>
      )}
    </>
  )
}

// ===== Skill 子视图 =====

function SkillSubView({
  skills,
  onBack,
}: {
  skills: LoadedSkill[]
  onBack: () => void
}) {
  const locale = useLocaleStore(s => s.locale)
  const text = useLocaleStore(s => s.text)
  /** 来源徽章颜色 */
  const sourceBadge = (source: string) => {
    switch (source) {
      case 'builtin': return { bg: 'color-mix(in srgb, var(--color-info) 12%, transparent)', color: 'var(--color-info)', label: text('内置', 'Built-in') }
      case 'user': return { bg: 'color-mix(in srgb, var(--color-accent) 12%, transparent)', color: 'var(--color-accent)', label: text('用户', 'User') }
      case 'project': return { bg: 'color-mix(in srgb, var(--color-success) 12%, transparent)', color: 'var(--color-success-text)', label: text('项目', 'Project') }
      default: return { bg: 'var(--color-hover)', color: 'var(--color-text-muted)', label: source }
    }
  }

  return (
    <>
      {/* 返回按钮 */}
      <button
        onClick={onBack}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors"
        style={{ color: 'var(--color-text-secondary)' }}
        onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--color-hover)')}
        onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
      >
        <ChevronRight size={12} style={{ transform: 'rotate(180deg)' }} />
        <span className="font-medium">{text('技能列表', 'Skills')}</span>
        <span className="ml-auto text-[0.68rem] opacity-50">
          {text(`${skills.length} 个技能`, `${skills.length} skills`)}
        </span>
      </button>

      <div style={{ height: 1, backgroundColor: 'var(--color-border)', margin: '2px 0' }} />

      {/* Skill 列表 */}
      {skills.length === 0 ? (
        <div className="px-3 py-3 text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>
          <div className="mb-1">{text('暂无可用技能', 'No skills available')}</div>
          <div className="text-[0.68rem] opacity-60">
            {text('在用户技能目录放入 SKILL.md 文件', 'Add SKILL.md files to your user skills directory')}
          </div>
        </div>
      ) : (
        <div className="py-1 max-h-[240px] overflow-y-auto">
          {skills.map(skill => {
            const badge = sourceBadge(skill.source)
            return (
              <div
                key={skill.metadata.name}
                className="flex items-start gap-2 px-3 py-1.5 text-xs"
              >
                <Sparkles size={12} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--color-accent)' }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium truncate" style={{ color: 'var(--color-text)' }}>
                      {locale === 'en-US'
                        ? (skill.writingSkill.metadata.displayName ?? skill.metadata.name)
                        : (skill.metadata.displayName ?? skill.metadata.name)}
                    </span>
                    <span
                      className="text-[0.6rem] px-1 py-0 rounded flex-shrink-0"
                      style={{ backgroundColor: badge.bg, color: badge.color }}
                    >
                      {badge.label}
                    </span>
                  </div>
                  <div
                    className="text-[0.68rem] truncate mt-0.5"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    {locale === 'en-US'
                      ? skill.writingSkill.metadata.description
                      : skill.metadata.description}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 底部提示 */}
      <div style={{ height: 1, backgroundColor: 'var(--color-border)', margin: '2px 0' }} />
      <div className="px-3 py-1.5 text-[0.68rem]" style={{ color: 'var(--color-text-muted)' }}>
        {text('输入', 'Type')} <code className="px-0.5 rounded" style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-accent)' }}>/</code> {text('可快速调用技能', 'to quickly invoke a skill')}
      </div>
    </>
  )
}
