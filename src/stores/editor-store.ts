import { create } from 'zustand'

import type { DraftStatus } from '../shared/draft-status'

export interface EditorTabSaveSnapshot {
  content: string
  contentRevision: number
}

/** 编辑器 Tab 数据 */
export interface EditorTab {
  id: string
  name: string
  type: 'chapter' | 'outline' | 'character' | 'config' | 'diff' | 'chapter-card' | 'world-building' | 'arch-file' | 'version-history' | 'review-report'
  filePath?: string
  content?: string
  /** 架构文档已持久化的基准内容，用于跨 Tab/项目切换后恢复脏状态。 */
  savedContent?: string
  /** diff 视图的原始内容 */
  originalContent?: string
  dirty?: boolean
  /** 固定 Tab，不可关闭 */
  pinned?: boolean
  /** 修稿文件路径（三栏合并用） */
  revisionPath?: string
  /** 审稿报告内容（供「根据意见修稿」使用） */
  reviewReport?: string
  /** 草稿所属章节号 */
  chapterNumber?: number
  /** 数据库草稿标识，用于定稿事件精确定位已打开的虚拟草稿。 */
  draftId?: number
  /** 数据库草稿状态；定稿或归档状态必须只读。 */
  draftStatus?: DraftStatus
  /** 内容变更代次，用于阻止异步保存响应覆盖保存期间的新输入。 */
  contentRevision?: number
  /** 伪协议资源所属项目；用于隔离同一路径在不同项目中的编辑草稿。 */
  projectKey?: string
  /** 打开/定稿时冻结的项目会话租约；同一路径重开不能复用旧 tab 的完成事件。 */
  projectSessionLease?: string
  /** 已提交定稿的稳定身份，供发布重试和冲突提示关联。 */
  finalizationId?: string
  /** 实体稿发布投影状态；pending 表示数据库已定稿但文件待发布。 */
  finalizationPublication?: 'pending' | 'published'
  /** 完成事件落后于本地编辑时保留的显式冲突信息。 */
  finalizationConflict?: {
    finalizationId: string
    publicationStatus: 'pending' | 'published'
  }
  /** 草稿所在章节目录 */
  chapterDir?: string
  /** 审稿报告存放路径 */
  reportPath?: string
}

interface EditorState {
  /** 打开的 Tab 列表 */
  tabs: EditorTab[]
  /** 当前活跃的 Tab ID */
  activeTabId: string | null
  /**
   * 编辑器后台草稿账本。
   *
   * 账本是技术状态，不是用户文件，不能混入可关闭的 tabs。
   */
  draftLedgers: Record<string, string>

  // ===== Actions =====
  /** 打开文件（如果已打开则激活） */
  openFile: (tab: EditorTab) => void
  /** 写入后台草稿账本。 */
  setDraftLedger: (key: string, content: string) => void
  /** 同步某项目可见内置编辑器的未保存状态。 */
  setProjectEditorDirty: (
    type: Extract<EditorTab['type'], 'character' | 'config' | 'chapter-card'>,
    projectKey: string,
    dirty: boolean,
  ) => void
  /** 关闭 Tab */
  closeTab: (tabId: string) => void
  /** 激活 Tab */
  setActiveTab: (tabId: string) => void
  /**
   * 更新 Tab 内容（标记 dirty）
   * 仅在「用户修改」时调用，会亮起未保存指示灯。
   */
  updateTabContent: (tabId: string, content: string) => void
  /**
   * 静默同步 Tab 内容（不标记 dirty，也不清除 dirty）
   * 用于「AI 生成完成后刷新」、「打开文件刷新」等非用户编辑场景。
   */
  syncTabContent: (tabId: string, content: string) => void
  /**
   * 标记 Tab 已保存（清除 dirty 标记）
   * 在保存成功后调用，使警示灯、Tab 圆点消失。
   */
  markTabSaved: (tabId: string, savedContent?: string) => void
  /** 按保存开始时的快照结算；期间有新输入时只更新已保存基准。 */
  settleTabSave: (tabId: string, snapshot: EditorTabSaveSnapshot) => void
  /** 清空所有 Tab */
  clearTabs: () => void
  /** 只清理指定项目的 Tab 与后台草稿，保留其他项目的未保存内容。 */
  clearProjectTabs: (projectKey: string) => void
}

const BACKGROUND_LEDGER_BY_EDITOR_TYPE: Partial<Record<EditorTab['type'], string>> = {
  character: 'character-editor-drafts',
  config: 'config',
  'chapter-card': 'chapter-card-editor',
}
const PROJECT_SCOPED_BUILTIN_TYPES = new Set<EditorTab['type']>([
  'character',
  'config',
  'chapter-card',
  'world-building',
  'chapter',
  'review-report',
  'version-history',
  'diff',
])

export function createProjectScopedEditorTabId(
  baseId: string,
  type: EditorTab['type'],
  projectKey?: string,
): string {
  if (!projectKey || !PROJECT_SCOPED_BUILTIN_TYPES.has(type)) return baseId
  return `${baseId}:${encodeURIComponent(projectKey)}`
}

function hasBackgroundProjectDraft(
  draftLedgers: Record<string, string>,
  tab: EditorTab,
): boolean {
  const ledgerKey = BACKGROUND_LEDGER_BY_EDITOR_TYPE[tab.type]
  if (!ledgerKey || !tab.projectKey) return false
  const content = draftLedgers[ledgerKey]
  if (!content) return false
  try {
    const parsed = JSON.parse(content) as { projects?: Array<{ projectKey?: unknown }> }
    return Array.isArray(parsed.projects)
      && parsed.projects.some(project => project.projectKey === tab.projectKey)
  } catch {
    return false
  }
}

export const useEditorStore = create<EditorState>()((set, get) => ({
  tabs: [],
  activeTabId: null,
  draftLedgers: {},

  openFile: (tab) => {
    const projectScopedTab = {
      ...tab,
      id: createProjectScopedEditorTabId(tab.id, tab.type, tab.projectKey),
    }
    const tabWithDraftState = hasBackgroundProjectDraft(get().draftLedgers, projectScopedTab)
      ? { ...projectScopedTab, dirty: true }
      : projectScopedTab
    // diff 类型每次内容不同，只按 id 精确匹配（不走 filePath 去重）
    // 其他类型（含 review-report）按 filePath + type 去重
    const idOnly = tab.type === 'diff'
    const existing = get().tabs.find((t) =>
      t.id === tabWithDraftState.id ||
      (!idOnly
        && tabWithDraftState.filePath !== undefined
        && t.filePath === tabWithDraftState.filePath
        && t.type === tabWithDraftState.type
        && t.projectKey === tabWithDraftState.projectKey)
    )
    if (existing) {
      // diff / review-report 每次内容不同，强制更新内容后激活
      if (tabWithDraftState.type === 'diff' || tabWithDraftState.type === 'review-report') {
        set((s) => ({
          tabs: s.tabs.map((t) => t.id === existing.id ? { ...t, ...tabWithDraftState, id: tabWithDraftState.id } : t),
          activeTabId: tabWithDraftState.id,
        }))
      } else {
        // 其他类型 Tab：已打开，更新名称并直接激活
        set((s) => ({
          tabs: s.tabs.map((t) => t.id === existing.id
            ? {
                ...t,
                name: tabWithDraftState.name,
                ...(tabWithDraftState.draftId === undefined
                  ? {}
                  : { draftId: tabWithDraftState.draftId }),
                ...(tabWithDraftState.chapterNumber === undefined
                  ? {}
                  : { chapterNumber: tabWithDraftState.chapterNumber }),
                ...(tabWithDraftState.draftStatus === undefined
                  ? {}
                  : { draftStatus: tabWithDraftState.draftStatus }),
              }
            : t),
          activeTabId: existing.id,
        }))
      }
    } else {
      // 新开 Tab
      set((s) => ({
        tabs: [...s.tabs, tabWithDraftState],
        activeTabId: tabWithDraftState.id,
      }))
    }
  },

  setDraftLedger: (key, content) => {
    set((state) => ({
      draftLedgers: {
        ...state.draftLedgers,
        [key]: content,
      },
    }))
  },

  setProjectEditorDirty: (type, projectKey, dirty) => {
    set((state) => ({
      tabs: state.tabs.map(tab => (
        tab.type === type && tab.projectKey === projectKey
          ? { ...tab, dirty }
          : tab
      )),
    }))
  },

  closeTab: (tabId) => {
    const { tabs, activeTabId } = get()
    // pinned Tab 不可关闭
    const target = tabs.find((t) => t.id === tabId)
    if (target?.pinned) return
    const newTabs = tabs.filter((t) => t.id !== tabId)
    set({
      tabs: newTabs,
      activeTabId: activeTabId === tabId
        ? (newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null)
        : activeTabId,
    })
  },

  setActiveTab: (tabId) => {
    set({ activeTabId: tabId })
  },

  updateTabContent: (tabId, content) => {
    set((s) => ({
      tabs: s.tabs.map((t) => t.id === tabId
        ? {
            ...t,
            content,
            contentRevision: (t.contentRevision ?? 0) + 1,
            dirty: true,
          }
        : t),
    }))
  },

  // 静默刷新内容（不改变 dirty 标记，用于 AI 生成后刷新、打开文件同步等场景）
  syncTabContent: (tabId, content) => {
    set((s) => ({
      tabs: s.tabs.map((t) => t.id === tabId
        ? {
            ...t,
            content,
            contentRevision: content === t.content
              ? (t.contentRevision ?? 0)
              : (t.contentRevision ?? 0) + 1,
          }
        : t),
    }))
  },

  // 标记 Tab 已保存 —— 清除 dirty 标记，使标题栏警示灯和 Tab 圆点消失
  markTabSaved: (tabId, savedContent) => {
    set((s) => ({
      tabs: s.tabs.map((t) => t.id === tabId
        ? {
            ...t,
            dirty: false,
            ...(savedContent === undefined ? {} : { savedContent }),
          }
        : t),
    }))
  },

  settleTabSave: (tabId, snapshot) => {
    set((state) => ({
      tabs: state.tabs.map(tab => {
        if (tab.id !== tabId) return tab
        const snapshotStillCurrent = (
          (tab.contentRevision ?? 0) === snapshot.contentRevision
          && tab.content === snapshot.content
        )
        return {
          ...tab,
          savedContent: snapshot.content,
          dirty: !snapshotStillCurrent,
        }
      }),
    }))
  },

  clearTabs: () => {
    set({ tabs: [], activeTabId: null })
  },

  clearProjectTabs: (projectKey) => {
    set((state) => {
      const tabs = state.tabs.filter(tab => tab.projectKey !== projectKey)
      const draftLedgers = Object.fromEntries(
        Object.entries(state.draftLedgers).map(([key, content]) => {
          try {
            const parsed = JSON.parse(content) as {
              version?: unknown
              projects?: Array<{ projectKey?: unknown }>
            }
            if (parsed.version !== 1 || !Array.isArray(parsed.projects)) return [key, content]
            return [key, JSON.stringify({
              ...parsed,
              projects: parsed.projects.filter(project => project.projectKey !== projectKey),
            })]
          } catch {
            return [key, content]
          }
        }),
      )
      const activeTabId = state.activeTabId && tabs.some(tab => tab.id === state.activeTabId)
        ? state.activeTabId
        : (tabs.at(-1)?.id ?? null)
      return { tabs, activeTabId, draftLedgers }
    })
  },
}))
