import { create } from 'zustand'

/** 书房（home）或作品（project）。 */
export type SidebarView = 'home' | 'project'

/** 设置页的分区。 */
export type SettingsSection = 'appearance' | 'llm' | 'embedding' | 'stage-models' | 'proxy' | 'prompts' | 'skills' | 'backup' | 'about'

/** 写作此章的参数（取自蓝图），章号由 chapter 意图给出。 */
export type ChapterWritePrefill = {
  title: string
  role: string
  purpose: string
  keyEvents: string
  characters: string
  userGuidance: string
}

/** 布局字段：书房与作品之间的切换（sidebarView）、设置页与全局对话框的开关。 */
export interface LayoutFields {
  sidebarView: SidebarView
  /** 设置页是否打开 */
  settingsOpen: boolean
  /** 设置页当前的分区：打开时由入口指定，作者点左侧分区时更新。 */
  settingsSection: SettingsSection
  /** 新建作品对话框是否打开 */
  newProjectOpen: boolean
  /** 导出对话框是否打开 */
  exportOpen: boolean
  /** 导入小说对话框是否打开 */
  importNovelOpen: boolean
}

interface LayoutState extends LayoutFields {
  setSidebarView: (view: SidebarView) => void
  closeSettings: () => void
  openNewProject: () => void
  closeNewProject: () => void
  openExport: () => void
  closeExport: () => void
  openImportNovel: () => void
  closeImportNovel: () => void
}

export const useLayoutStore = create<LayoutState>()((set) => ({
  sidebarView: 'project',
  settingsOpen: false,
  settingsSection: 'llm',
  newProjectOpen: false,
  exportOpen: false,
  importNovelOpen: false,

  setSidebarView: (view) => set({ sidebarView: view }),
  closeSettings: () => set({ settingsOpen: false }),
  openNewProject: () => set({ newProjectOpen: true }),
  closeNewProject: () => set({ newProjectOpen: false }),
  openExport: () => set({ exportOpen: true }),
  closeExport: () => set({ exportOpen: false }),
  openImportNovel: () => set({ importNovelOpen: true }),
  closeImportNovel: () => set({ importNovelOpen: false }),
}))
