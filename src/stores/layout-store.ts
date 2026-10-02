import { create } from 'zustand'

/** 左侧活动栏的视图类型 */
/**
 * 侧栏视图。
 *
 * `world` 是「世界」栏目自己的视图：它原先借用 `knowledge`，靠 activeRailItem 分流，
 * 可底部面板（任务/日志/模型）打开时会把 activeRailItem 抢走，侧栏就掉回知识库面板。
 * 栏目各归各的视图，这段耦合就断了。
 */
export type SidebarView = 'home' | 'project' | 'knowledge' | 'characters' | 'settings' | 'world'

/** 下方工具窗口 Tab */
export type BottomTab = 'tasks' | 'log' | 'models'

/** 右侧面板视图类型 */
export type RightView = 'agent' | 'ai-output'

/** 左侧主导航当前视觉激活项 */
export type LeftRailItem = SidebarView | 'blueprint' | 'world' | 'plot-tree' | BottomTab

/** 设置弹窗分类 */
export type SettingsSection = 'llm' | 'embedding' | 'proxy' | 'editor' | 'prompts' | 'skills' | 'about'

/** 章节创建对话框的预填参数 */
export type ChapterCreationPrefill = Record<string, unknown> | null

interface LayoutState {
  // ===== 侧边栏 =====
  sidebarOpen: boolean
  sidebarView: SidebarView
  sidebarWidth: number
  activeRailItem: LeftRailItem

  // ===== AI 对话面板 =====
  aiPanelOpen: boolean
  aiPanelWidth: number
  /** 右侧面板当前视图：Agent 对话 / AI 输出 */
  rightView: RightView

  // ===== 底部面板 =====
  bottomPanelOpen: boolean
  bottomTab: BottomTab
  bottomPanelHeight: number

  /**
   * 沉浸写作（demo 的 toggleFocus）：收拢目录侧栏与助手，只留顶栏、书脊与纸面。
   */
  focusMode: boolean

  // ===== 全局弹窗状态（替代 window.dispatchEvent 事件总线）=====
  /** 设置弹窗是否打开 */
  settingsOpen: boolean
  /** 设置弹窗打开时默认定位的分类 */
  settingsSection: SettingsSection
  /** 新建项目对话框是否打开 */
  newProjectOpen: boolean
  /** 导出对话框是否打开 */
  exportOpen: boolean
  /** 导入小说对话框是否打开 */
  importNovelOpen: boolean
  /** 章节创建对话框是否打开 */
  chapterCreationOpen: boolean
  /** 章节创建对话框的预填参数 */
  chapterCreationPrefill: ChapterCreationPrefill

  // ===== Actions =====
  toggleSidebar: () => void
  setSidebarView: (view: SidebarView, activeRailItem?: LeftRailItem) => void
  setSidebarWidth: (width: number) => void
  toggleAIPanel: () => void
  setAIPanelOpen: (open: boolean) => void
  setAIPanelWidth: (width: number) => void
  setRightView: (view: RightView) => void
  /** 打开右侧面板并切换到指定视图 */
  openRightPanel: (view: RightView) => void
  toggleBottomPanel: () => void
  setBottomTab: (tab: BottomTab) => void
  setBottomPanelHeight: (height: number) => void
  openBottomTab: (tab: BottomTab) => void
  toggleFocusMode: () => void
  /**
   * 让侧栏语境跟随中央页面（对齐 demo clickTab：高亮永远显示当前页面所属栏目）。
   * 与 setSidebarView 的区别是不做「同按钮再点一次即折叠」的处理 —— 它只同步，不切换开关。
   */
  syncRailForPage: (view: SidebarView, railItem: LeftRailItem) => void

  // ===== 全局弹窗 Actions =====
  openSettings: (section?: SettingsSection, activeRailItem?: LeftRailItem) => void
  closeSettings: () => void
  openNewProject: () => void
  closeNewProject: () => void
  openExport: () => void
  closeExport: () => void
  openImportNovel: () => void
  closeImportNovel: () => void
  openChapterCreation: (prefill?: ChapterCreationPrefill) => void
  closeChapterCreation: () => void
}

export const useLayoutStore = create<LayoutState>()((set, get) => ({
  // 默认值
  sidebarOpen: true,
  sidebarView: 'project',
  sidebarWidth: 260,
  activeRailItem: 'project',

  aiPanelOpen: true,
  aiPanelWidth: 320,
  rightView: 'agent',

  /**
   * 底部面板（任务 / 日志 / 模型）默认收起。
   *
   * demo 的界面哲学是「工程设施收进设置，界面只有书与创作」；先生也要求
   * 「刷新、打开软件不要默认弹出日志、模型、任务这种后台内容」。
   * 能力一项不减：点书脊下方的任务/日志/模型随时展开。
   */
  bottomPanelOpen: false,
  bottomTab: 'tasks',
  bottomPanelHeight: 200,

  focusMode: false,

  // 全局弹窗默认关闭
  settingsOpen: false,
  settingsSection: 'llm',
  newProjectOpen: false,
  exportOpen: false,
  importNovelOpen: false,
  chapterCreationOpen: false,
  chapterCreationPrefill: null,

  // Actions
  /**
   * 沉浸写作与侧栏/助手的显隐必须互斥：任何一次显式打开都要退出沉浸态，
   * 否则 ShellV2 会一边被要求显示侧栏、一边被 focusMode 压掉，出现「点了没反应」。
   */
  toggleSidebar: () => set((s) => ({
    sidebarOpen: !s.sidebarOpen,
    focusMode: !s.sidebarOpen ? false : s.focusMode,
  })),
  setSidebarView: (view, activeRailItem) =>
    set((s) => {
      const nextRailItem = activeRailItem ?? view
      const sameButton = s.sidebarView === view && s.activeRailItem === nextRailItem
      const sidebarOpen = sameButton ? !s.sidebarOpen : true
      return {
        sidebarView: view,
        activeRailItem: nextRailItem,
        sidebarOpen,
        focusMode: sidebarOpen ? false : s.focusMode,
      }
    }),
  setSidebarWidth: (width) => set({ sidebarWidth: Math.max(200, Math.min(500, width)) }),

  toggleAIPanel: () => set((s) => ({
    aiPanelOpen: !s.aiPanelOpen,
    focusMode: !s.aiPanelOpen ? false : s.focusMode,
  })),
  setAIPanelOpen: (open) => set((s) => ({ aiPanelOpen: open, focusMode: open ? false : s.focusMode })),
  setAIPanelWidth: (width) => set({ aiPanelWidth: Math.max(260, Math.min(600, width)) }),
  setRightView: (view) => set({ rightView: view }),
  openRightPanel: (view) => set({ aiPanelOpen: true, rightView: view }),

  toggleBottomPanel: () => set((s) => ({ bottomPanelOpen: !s.bottomPanelOpen })),
  setBottomTab: (tab) =>
    set((s) => {
      const sameButton = s.bottomTab === tab && s.activeRailItem === tab
      return {
        bottomTab: tab,
        activeRailItem: tab,
        bottomPanelOpen: sameButton ? !s.bottomPanelOpen : true,
      }
    }),
  setBottomPanelHeight: (height) => set({ bottomPanelHeight: Math.max(100, Math.min(500, height)) }),
  openBottomTab: (tab) => set({ bottomPanelOpen: true, bottomTab: tab, activeRailItem: tab }),

  /**
   * 沉浸写作：收拢目录侧栏与助手；退出时把侧栏放回来（助手保持用户上次的选择）。
   * 与 demo 的 toggleFocus 一致。
   */
  toggleFocusMode: () => set((s) => (s.focusMode
    ? { focusMode: false, sidebarOpen: true }
    : { focusMode: true, sidebarOpen: false, aiPanelOpen: false })),

  syncRailForPage: (view, railItem) => {
    const current = get()
    if (current.sidebarView === view && current.activeRailItem === railItem) return
    set({ sidebarView: view, activeRailItem: railItem })
  },

  // 全局弹窗 Actions
  openSettings: (section = 'llm', activeRailItem = 'settings') =>
    set({ settingsOpen: true, settingsSection: section, activeRailItem }),
  closeSettings: () => set({ settingsOpen: false }),
  openNewProject: () => set({ newProjectOpen: true }),
  closeNewProject: () => set({ newProjectOpen: false }),
  openExport: () => set({ exportOpen: true }),
  closeExport: () => set({ exportOpen: false }),
  openImportNovel: () => set({ importNovelOpen: true }),
  closeImportNovel: () => set({ importNovelOpen: false }),
  openChapterCreation: (prefill = null) => set({ chapterCreationOpen: true, chapterCreationPrefill: prefill }),
  closeChapterCreation: () => set({ chapterCreationOpen: false, chapterCreationPrefill: null }),
}))
