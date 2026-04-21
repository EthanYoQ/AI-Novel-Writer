import {
  FolderOpen, BookOpen, Users,
  Home, Zap, ScrollText, Cpu,
} from 'lucide-react'
import { useLayoutStore, type SidebarView, type BottomTab } from '../../stores/layout-store'
import { useWorkflowStore } from '../../stores/workflow-store'

/** 左侧侧边栏视图按钮配置（不含 Home，它单独渲染） */
const sidebarActivities: Array<{ id: SidebarView; icon: typeof FolderOpen; label: string }> = [
  { id: 'project', icon: FolderOpen, label: '项目结构' },
  { id: 'knowledge', icon: BookOpen, label: '知识库' },
  { id: 'characters', icon: Users, label: '角色管理' },
]

/** 底部面板 Tab 按钮配置 */
const bottomTabs: Array<{ id: BottomTab; icon: typeof Zap; label: string }> = [
  { id: 'tasks', icon: Zap, label: '任务' },
  { id: 'log', icon: ScrollText, label: '日志' },
  { id: 'models', icon: Cpu, label: '模型调用' },
]

/**
 * 左侧工具窗口栏（LeftToolWindowBar）
 * JetBrains 风格：36px 宽，全高
 */
export default function LeftToolWindowBar() {
  const sidebarView = useLayoutStore(s => s.sidebarView)
  const sidebarOpen = useLayoutStore(s => s.sidebarOpen)
  const setSidebarView = useLayoutStore(s => s.setSidebarView)
  const bottomTab = useLayoutStore(s => s.bottomTab)
  const bottomPanelOpen = useLayoutStore(s => s.bottomPanelOpen)
  const setBottomTab = useLayoutStore(s => s.setBottomTab)
  const currentRun = useWorkflowStore(s => s.currentRun)

  /** Home 按钮是否激活 */
  const homeActive = sidebarOpen && sidebarView === 'home'

  return (
    <div
      className="no-select flex flex-col h-full"
      style={{
        width: 'var(--width-left-bar)',  /* 36px */
        backgroundColor: 'var(--color-activity-bar)',
        borderRight: '1px solid var(--color-border)',
        flexShrink: 0,
      }}
    >
      {/* ===== 顶部：Home + 侧边栏视图切换 ===== */}
      <div className="flex flex-col items-center w-full pt-0.5">

        {/* Home 按钮 — 点击切换到主页视图 */}
        <button
          onClick={() => setSidebarView('home')}
          title="欢迎页"
          className="tool-btn"
          style={{
            height: 30,
            boxShadow: homeActive ? 'inset 2px 0 0 var(--color-activity-indicator)' : 'none',
            color: homeActive ? 'var(--color-activity-icon-active)' : undefined,
          }}
        >
          <Home size={16} strokeWidth={homeActive ? 2 : 1.5} />
        </button>

        {/* 分割线 */}
        <div className="w-4 my-0.5" style={{ height: 1, backgroundColor: 'var(--color-border)' }} />

        {/* 侧边栏视图按钮 */}
        {sidebarActivities.map(({ id, icon: Icon, label }) => {
          const isActive = sidebarOpen && sidebarView === id
          return (
            <button
              key={id}
              onClick={() => setSidebarView(id)}
              title={label}
              className="tool-btn"
              style={{
                boxShadow: isActive ? 'inset 2px 0 0 var(--color-activity-indicator)' : 'none',
                color: isActive ? 'var(--color-activity-icon-active)' : 'var(--color-activity-icon)',
              }}
            >
              <Icon size={17} strokeWidth={isActive ? 2 : 1.5} />
            </button>
          )
        })}
      </div>

      {/* 弹性间隔 */}
      <div className="flex-1" />

      {/* ===== 底部：底部面板 Tab 控制 ===== */}
      <div className="flex flex-col items-center w-full pb-1">
        <div className="w-4 mb-0.5" style={{ height: 1, backgroundColor: 'var(--color-border)' }} />

        {bottomTabs.map(({ id, icon: Icon, label }) => {
          const isActive = bottomPanelOpen && bottomTab === id
          const showPulse = id === 'tasks' && currentRun &&
            (currentRun.status === 'running' || currentRun.status === 'waiting')

          return (
            <div key={id} className="relative w-full">
              <button
                onClick={() => setBottomTab(id)}
                title={label}
                className="tool-btn"
                style={{
                  boxShadow: isActive ? 'inset 2px 0 0 var(--color-activity-indicator)' : 'none',
                  color: isActive ? 'var(--color-activity-icon-active)' : 'var(--color-activity-icon)',
                }}
              >
                <Icon size={15} strokeWidth={isActive ? 2 : 1.5} />
              </button>
              {showPulse && (
                <span
                  className="absolute top-[4px] right-[4px] w-[5px] h-[5px] rounded-full animate-pulse pointer-events-none"
                  style={{
                    backgroundColor: currentRun.status === 'waiting'
                      ? 'var(--color-warning)'
                      : 'var(--color-accent)',
                  }}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
