import {
  FolderOpen,
  BookOpen,
  Users,
  Home,
  ListTree,
  Globe2,
  Bot,
  ListChecks,
  Settings,
  ScrollText,
  Cpu,
} from 'lucide-react'
import { useLayoutStore, type SidebarView, type BottomTab } from '../../stores/layout-store'
import { useWorkflowStore } from '../../stores/workflow-store'

/** 左侧侧边栏视图按钮配置（不含 Home，它单独渲染） */
const sidebarActivities: Array<{ id: SidebarView; icon: typeof FolderOpen; label: string }> = [
  { id: 'project', icon: FolderOpen, label: '项目' },
  { id: 'knowledge', icon: BookOpen, label: '小说' },
  { id: 'characters', icon: Users, label: '角色' },
]

/** 底部面板 Tab 按钮配置 */
const bottomTabs: Array<{ id: BottomTab; icon: typeof ListChecks; label: string }> = [
  { id: 'tasks', icon: ListChecks, label: '任务' },
  { id: 'log', icon: ScrollText, label: '日志' },
  { id: 'models', icon: Cpu, label: '模型' },
]

function LeftNavButton({
  icon: Icon,
  label,
  active,
  pulse,
  onClick,
  title,
}: {
  icon: typeof FolderOpen
  label: string
  active?: boolean
  pulse?: boolean
  onClick: () => void
  title?: string
}) {
  return (
    <div className="relative w-full px-1">
      <button
        onClick={onClick}
        title={title ?? label}
        className="left-nav-button"
        style={{
          color: active ? '#fff8e8' : 'rgba(255, 247, 228, 0.78)',
          background: active
            ? 'linear-gradient(180deg, rgba(138, 91, 46, 0.88), rgba(82, 50, 23, 0.88))'
            : 'transparent',
          boxShadow: active ? 'inset 3px 0 0 var(--writer-brass-400)' : 'none',
        }}
      >
        <Icon size={22} strokeWidth={active ? 2 : 1.75} />
        <span className="left-nav-label">{label}</span>
      </button>
      {pulse && (
        <span
          className="absolute top-[5px] right-[5px] w-[5px] h-[5px] rounded-full animate-pulse pointer-events-none"
          style={{ backgroundColor: 'var(--color-accent)' }}
        />
      )}
    </div>
  )
}

/**
 * 左侧工具窗口栏（LeftToolWindowBar）
 * JetBrains 风格：带文字标签的左侧主导航，全高
 */
export default function LeftToolWindowBar() {
  const sidebarView = useLayoutStore(s => s.sidebarView)
  const sidebarOpen = useLayoutStore(s => s.sidebarOpen)
  const setSidebarView = useLayoutStore(s => s.setSidebarView)
  const bottomTab = useLayoutStore(s => s.bottomTab)
  const bottomPanelOpen = useLayoutStore(s => s.bottomPanelOpen)
  const setBottomTab = useLayoutStore(s => s.setBottomTab)
  const openRightPanel = useLayoutStore(s => s.openRightPanel)
  const openSettings = useLayoutStore(s => s.openSettings)
  const currentRun = useWorkflowStore(s => s.currentRun)

  /** Home 按钮是否激活 */
  const homeActive = sidebarOpen && sidebarView === 'home'
  const aiActive = useLayoutStore(s => s.aiPanelOpen && s.rightView === 'agent')

  return (
    <div
      className="writer-left-rail no-select flex flex-col h-full"
      style={{
        width: 'var(--width-left-bar)',
        flexShrink: 0,
      }}
    >
      {/* ===== 顶部：Home + 侧边栏视图切换 ===== */}
      <div className="flex flex-col items-center w-full pt-0.5">

        {/* Home 按钮 — 点击切换到主页视图 */}
        <LeftNavButton
          icon={Home}
          label="首页"
          active={homeActive}
          onClick={() => setSidebarView('home')}
          title="欢迎页"
        />

        {/* 分割线 */}
        <div className="writer-nav-divider w-8 my-1" style={{ height: 1 }} />

        {/* 侧边栏视图按钮 */}
        {sidebarActivities.map(({ id, icon: Icon, label }) => {
          const isActive = sidebarOpen && sidebarView === id
          return (
            <LeftNavButton
              key={id}
              icon={Icon}
              label={label}
              active={isActive}
              title={label}
              onClick={() => setSidebarView(id)}
            />
          )
        })}

        <div className="writer-nav-divider w-8 my-1" style={{ height: 1 }} />

        <LeftNavButton
          icon={ListTree}
          label="蓝图"
          active={sidebarOpen && sidebarView === 'project'}
          title="章节蓝图"
          onClick={() => setSidebarView('project')}
        />
        <LeftNavButton
          icon={Globe2}
          label="世界"
          active={sidebarOpen && sidebarView === 'knowledge'}
          title="世界观"
          onClick={() => setSidebarView('knowledge')}
        />
        <LeftNavButton
          icon={Bot}
          label="AI"
          active={aiActive}
          title="AI 写作助手"
          onClick={() => openRightPanel('agent')}
        />
      </div>

      {/* 弹性间隔 */}
      <div className="flex-1" />

      {/* ===== 底部：底部面板 Tab 控制 ===== */}
      <div className="flex flex-col items-center w-full pb-1">
        <div className="writer-nav-divider w-8 mb-1" style={{ height: 1 }} />

        {bottomTabs.map(({ id, icon: Icon, label }) => {
          const isActive = bottomPanelOpen && bottomTab === id
          const showPulse = id === 'tasks' && currentRun &&
            (currentRun.status === 'running' || currentRun.status === 'waiting')

          return (
            <LeftNavButton
              key={id}
              icon={Icon}
              label={label}
              active={isActive}
              title={label}
              pulse={!!showPulse}
              onClick={() => setBottomTab(id)}
            />
          )
        })}

        <div className="writer-nav-divider w-8 my-1" style={{ height: 1 }} />

        <LeftNavButton
          icon={Settings}
          label="设置"
          onClick={openSettings}
        />
      </div>
    </div>
  )
}
