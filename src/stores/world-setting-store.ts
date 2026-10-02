/**
 * world-setting-store — 世界观设定条目与分类的渲染层状态。
 *
 * 数据来源只有一处：主进程的 world-setting:* 通道（表 world_settings /
 * world_setting_categories）。组件不直接拼 IPC，也不自己维护第二份真相。
 *
 * 分类不是编译期常量：分类表由主进程提供，作者可自建 ——
 * 所以「哪个分类排前面」「这条设想的名字叫什么」全部以分类表为准，
 * 条目本身只存 key。排序也走分类表，否则自建分类会被排到内置分类前面。
 *
 * 项目切换防护：每次请求都带上发起时的项目路径，响应回来若项目已经换人，
 * 结果直接丢弃，绝不把上一部作品的设定渲染进新作品。
 */
import { create } from 'zustand'

import { ipc } from '../services/ipc-client'
import { useProjectStore } from './project-store'
import type {
  WorldSettingCategoryDraft,
  WorldSettingCategoryRecord,
  WorldSettingConflict,
  WorldSettingDraft,
  WorldSettingEntry,
  WorldSettingStatus,
} from '../shared/world-setting'

/** 条目目录的排列风格：两列大卡 / 四列小卡 / 单列列表。 */
export type CatalogLayout = 'grid2' | 'grid4' | 'list'
/** 条目目录的排序：最近更新 / 按名称。 */
export type CatalogSort = 'updated' | 'name'

const NAME_COLLATOR = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

/**
 * 分类优先、名称次之。
 * 分类顺序取自分类表（内置在前、自建在后），查不到的 key 排到最后 ——
 * 这种条目只可能出现在分类被删而条目残留的极端情况。
 */
function sortEntries(
  entries: WorldSettingEntry[],
  categories: readonly WorldSettingCategoryRecord[],
): WorldSettingEntry[] {
  const orderOf = (key: string): number => {
    const index = categories.findIndex(category => category.key === key)
    return index === -1 ? Number.MAX_SAFE_INTEGER : index
  }
  return [...entries].sort((a, b) => {
    const delta = orderOf(a.category) - orderOf(b.category)
    if (delta !== 0) return delta
    return NAME_COLLATOR.compare(a.name, b.name)
  })
}

/** 通道成功时返回条目本身，失败时返回 AppFailure（带 success:false）。 */
function isEntry(value: unknown): value is WorldSettingEntry {
  return Boolean(value) && typeof value === 'object' && 'id' in (value as object) && 'name' in (value as object)
}

function isCategory(value: unknown): value is WorldSettingCategoryRecord {
  return Boolean(value) && typeof value === 'object' && 'key' in (value as object) && 'zhCN' in (value as object)
}

function isEntryList(value: unknown): value is WorldSettingEntry[] {
  return Array.isArray(value)
}

function failureMessage(value: unknown, fallback: string): string {
  if (value && typeof value === 'object' && 'error' in value) {
    const message = (value as { error?: unknown }).error
    if (typeof message === 'string' && message) return message
  }
  return fallback
}

interface WorldSettingState {
  entries: WorldSettingEntry[]
  /** 分类表（含作者自建）。侧栏、下拉、AI 归类判据都读它。 */
  categories: WorldSettingCategoryRecord[]
  /** 当前数据属于哪个项目；与 currentProject.path 不一致时界面不展示。 */
  dataProjectPath: string | null
  loadingProjectPath: string | null
  lastError: string | null
  selectedId: number | null
  /**
   * 当前正在看的分类（分类表里的 key）。
   * 先生定的信息架构：**侧栏负责选分类**，正文栏负责看该分类下的条目目录，
   * 点进条目才进入编辑。
   */
  activeCategory: string
  /** 正文栏是否切到「待确认」队列。 */
  showPendingQueue: boolean
  /**
   * 条目目录的排列风格（先生要的三态切换）。
   * 放在 store 而不是组件里：切到别的分类再回来，手感保持不变。
   */
  catalogLayout: CatalogLayout
  /** 条目目录的排序方式。 */
  catalogSort: CatalogSort

  /**
   * 章节引用缓存：章节号 → 该章引用的设定 id 列表。
   *
   * 先生定的路线：写某一章时只带这里指明的设定，绝不按章全量加载。
   * 只缓存 id，条目正文从 entries 里现取 —— 单一真相，不会出现两份内容不一致。
   */
  chapterRefs: Record<number, number[]>

  /**
   * 待裁决的「正文 vs 设定」冲突。
   *
   * AI 能发现冲突但不知道该听哪边，所以只报告、不自动改；
   * 这里把它们缓存给界面，让作者并排对照后一键裁决 ——
   * 不必自己去设定库里逐条翻找「到底是哪一条、原文写的什么」。
   */
  conflicts: WorldSettingConflict[]
  /** 是否有一次裁决请求正在进行（防连点）。 */
  conflictsBusy: boolean

  load: (projectPath: string) => Promise<void>
  setActiveCategory: (category: string) => void
  setShowPendingQueue: (show: boolean) => void
  setCatalogLayout: (layout: CatalogLayout) => void
  setCatalogSort: (sort: CatalogSort) => void
  /** 读某一章的引用（打开蓝图页时调）。 */
  loadChapterRefs: (chapterNumber: number) => Promise<void>
  /** 把某条设定引用进某一章；来源可标 manual / ai。 */
  addChapterRef: (chapterNumber: number, settingId: number, source?: 'manual' | 'ai') => Promise<boolean>
  removeChapterRef: (chapterNumber: number, settingId: number) => Promise<boolean>
  /** 拉取待裁决冲突（侧栏入口出现前、以及裁决后刷新用）。 */
  loadConflicts: () => Promise<void>
  /**
   * 裁决冲突。
   * - 传 `ids`：只裁决这几条（逐条按钮）；
   * - 不传：裁决**全部未决**冲突（先生要的「不用一条条看」的出口），
   *   走主进程的批量通道，仓储侧用事务保证「要么全成、要么全不动」。
   */
  resolveConflicts: (
    ids: number[] | undefined,
    resolution: 'adopted-draft' | 'kept-entry',
  ) => Promise<boolean>
  /** 忽略（不是真冲突，或暂时不想处理）。 */
  ignoreConflict: (id: number) => Promise<boolean>
  /** 正文栏/侧栏共用的选中态：选中某条目即打开它的详情。 */
  select: (id: number | null) => void
  save: (draft: WorldSettingDraft) => Promise<WorldSettingEntry | null>
  remove: (id: number) => Promise<boolean>
  /** 采纳（confirmed）/ 退回（pending）。忽略候选请直接 remove。 */
  setStatus: (id: number, status: WorldSettingStatus) => Promise<WorldSettingEntry | null>
  /** 新建自建分类：key 由主进程生成。 */
  createCategory: (draft: WorldSettingCategoryDraft) => Promise<WorldSettingCategoryRecord | null>
  /** 删除自建分类；内置或仍有条目引用时会被拒绝，原因回给界面。 */
  removeCategory: (key: string) => Promise<{ removed: boolean; reason?: 'builtin' | 'in-use' }>
  /** 关项目或换项目时清空，避免残留上一部作品的设定。 */
  reset: () => void
}

export const useWorldSettingStore = create<WorldSettingState>()((set, get) => ({
  entries: [],
  categories: [],
  dataProjectPath: null,
  loadingProjectPath: null,
  lastError: null,
  selectedId: null,
  activeCategory: 'world',
  showPendingQueue: false,
  catalogLayout: 'grid2',
  catalogSort: 'updated',
  chapterRefs: {},
  conflicts: [],
  conflictsBusy: false,

  load: async (projectPath) => {
    if (!projectPath) return
    set({ loadingProjectPath: projectPath, lastError: null })
    try {
      // 条目与分类一起取：分类表决定侧栏结构与条目归类，缺了它界面就只剩内置八类。
      const [entryResult, categoryResult] = await Promise.all([
        ipc.invoke('world-setting:list', projectPath),
        ipc.invoke('world-setting:list-categories', projectPath),
      ])
      // 读取期间可能已经切了作品：旧结果一律丢弃。
      if (useProjectStore.getState().currentProject?.path !== projectPath) return
      const categories = Array.isArray(categoryResult)
        ? (categoryResult as unknown[]).filter(isCategory)
        : []
      if (isEntryList(entryResult)) {
        set((state) => ({
          entries: sortEntries(entryResult, categories),
          categories,
          dataProjectPath: projectPath,
          loadingProjectPath: null,
          // 当前分类若已不存在（作者删了它），退回分类表的第一条。
          activeCategory: categories.some(category => category.key === state.activeCategory)
            ? state.activeCategory
            : (categories[0]?.key ?? 'world'),
        }))
        return
      }
      set({
        entries: [],
        categories,
        lastError: failureMessage(entryResult, '世界观设定读取失败'),
        loadingProjectPath: null,
      })
    } catch (error) {
      if (useProjectStore.getState().currentProject?.path !== projectPath) return
      set({ entries: [], lastError: String(error), loadingProjectPath: null })
    }
  },

  select: (id) => set({ selectedId: id }),

  /** 换分类时清掉条目选中：分类目录与条目详情是两个视图，不能同时成立。 */
  setActiveCategory: (category) => set({ activeCategory: category, selectedId: null, showPendingQueue: false }),

  setShowPendingQueue: (show) => set({ showPendingQueue: show, selectedId: null }),

  setCatalogLayout: (layout) => set({ catalogLayout: layout }),

  setCatalogSort: (sort) => set({ catalogSort: sort }),

  loadChapterRefs: async (chapterNumber) => {
    const projectPath = useProjectStore.getState().currentProject?.path
    if (!projectPath || !Number.isInteger(chapterNumber)) return
    try {
      const result = await ipc.invoke('world-setting:list-chapter-refs', chapterNumber, projectPath)
      if (useProjectStore.getState().currentProject?.path !== projectPath) return
      if (!Array.isArray(result)) return
      const ids = result
        .map(item => (item && typeof item === 'object' && 'settingId' in item ? Number(item.settingId) : NaN))
        .filter(id => Number.isInteger(id))
      set(state => ({ chapterRefs: { ...state.chapterRefs, [chapterNumber]: ids } }))
    } catch {
      // 读取失败就保持原样：引用区显示为空比抛错打断创作要好
    }
  },

  addChapterRef: async (chapterNumber, settingId, source = 'manual') => {    const projectPath = useProjectStore.getState().currentProject?.path
    if (!projectPath) return false
    try {
      const result = await ipc.invoke('world-setting:add-chapter-ref', chapterNumber, settingId, source, projectPath)
      if (useProjectStore.getState().currentProject?.path !== projectPath) return false
      if (!result || typeof result !== 'object' || !('ok' in result) || !result.ok) return false
      set((state) => {
        const current = state.chapterRefs[chapterNumber] ?? []
        return current.includes(settingId)
          ? state
          : { chapterRefs: { ...state.chapterRefs, [chapterNumber]: [...current, settingId] } }
      })
      return true
    } catch {
      return false
    }
  },

  removeChapterRef: async (chapterNumber, settingId) => {
    const projectPath = useProjectStore.getState().currentProject?.path
    if (!projectPath) return false
    try {
      const result = await ipc.invoke('world-setting:remove-chapter-ref', chapterNumber, settingId, projectPath)
      if (useProjectStore.getState().currentProject?.path !== projectPath) return false
      if (!result || typeof result !== 'object' || !('removed' in result) || !result.removed) return false
      set((state) => ({
        chapterRefs: {
          ...state.chapterRefs,
          [chapterNumber]: (state.chapterRefs[chapterNumber] ?? []).filter(id => id !== settingId),
        },
      }))
      return true
    } catch {
      return false
    }
  },

  // ===== 冲突裁决 =====

  loadConflicts: async () => {
    const projectPath = useProjectStore.getState().currentProject?.path
    if (!projectPath) return
    try {
      const result = await ipc.invoke('world-setting:list-conflicts', projectPath)
      if (useProjectStore.getState().currentProject?.path !== projectPath) return
      set({ conflicts: Array.isArray(result) ? (result as WorldSettingConflict[]) : [] })
    } catch {
      // 读不到就保持原样：冲突队列是辅助功能，不该打断创作
    }
  },

  resolveConflicts: async (ids, resolution) => {
    const projectPath = useProjectStore.getState().currentProject?.path
    if (!projectPath) return false
    set({ conflictsBusy: true })
    try {
      const done = async (): Promise<boolean> => {
        if (useProjectStore.getState().currentProject?.path !== projectPath) return false
        // 裁决后刷新：采纳正文会改条目内容，冲突也要从队列消失。
        set((state) => ({
          conflicts: ids
            ? state.conflicts.filter(item => !ids.includes(item.id))
            : [],
        }))
        await get().load(projectPath)
        await get().loadConflicts()
        return true
      }
      if (ids && ids.length === 1) {
        const result = await ipc.invoke('world-setting:resolve-conflict', ids[0], resolution, projectPath)
        const ok = Boolean(result && typeof result === 'object' && 'resolved' in result && result.resolved)
        return ok ? await done() : false
      }
      if (ids && ids.length > 1) {
        // 多选逐条走单条通道：条数少（界面上就是那几条），不必为它再开一条批量语义。
        for (const id of ids) {
          const result = await ipc.invoke('world-setting:resolve-conflict', id, resolution, projectPath)
          if (!result || typeof result !== 'object' || !('resolved' in result) || !result.resolved) return false
        }
        return await done()
      }
      // 不传 ids = 全部未决：走主进程批量通道（全有或全无，事务保证一致性）
      const result = await ipc.invoke('world-setting:resolve-all-conflicts', resolution, projectPath)
      const failedIds = result && typeof result === 'object' && Array.isArray((result as { failedIds?: unknown }).failedIds)
        ? (result as { failedIds: unknown[] }).failedIds.filter((id): id is number => typeof id === 'number')
        : null
      // 全失败 / 部分失败都不得当成成功；只有 failedIds 为空（全有或全无 = 全成功）才算数。
      if (failedIds === null || failedIds.length > 0) {
        set({
          lastError: failedIds === null
            ? '批量裁决失败，已全部回滚'
            : `批量裁决失败：${failedIds.length} 条冲突未处理，已全部回滚`,
        })
        return false
      }
      return await done()
    } catch {
      return false
    } finally {
      set({ conflictsBusy: false })
    }
  },

  ignoreConflict: async (id) => {
    const projectPath = useProjectStore.getState().currentProject?.path
    if (!projectPath) return false
    set({ conflictsBusy: true })
    try {
      const result = await ipc.invoke('world-setting:ignore-conflict', id, projectPath)
      if (useProjectStore.getState().currentProject?.path !== projectPath) return false
      const ok = Boolean(result && typeof result === 'object' && 'ignored' in result && result.ignored)
      if (!ok) return false
      set((state) => ({ conflicts: state.conflicts.filter(item => item.id !== id) }))
      return true
    } catch {
      return false
    } finally {
      set({ conflictsBusy: false })
    }
  },

  save: async (draft) => {
    const projectPath = useProjectStore.getState().currentProject?.path
    if (!projectPath) return null
    try {
      const result = await ipc.invoke('world-setting:save', draft, projectPath)
      if (useProjectStore.getState().currentProject?.path !== projectPath) return null
      if (!isEntry(result)) {
        set({ lastError: failureMessage(result, '世界观设定保存失败') })
        return null
      }
      set((state) => {
        const rest = state.entries.filter(entry => entry.id !== result.id)
        return {
          entries: sortEntries([...rest, result], state.categories),
          dataProjectPath: projectPath,
          selectedId: result.id,
          lastError: null,
        }
      })
      return result
    } catch (error) {
      set({ lastError: String(error) })
      return null
    }
  },

  remove: async (id) => {
    const projectPath = useProjectStore.getState().currentProject?.path
    if (!projectPath) return false
    try {
      const result = await ipc.invoke('world-setting:delete', id, projectPath)
      if (useProjectStore.getState().currentProject?.path !== projectPath) return false
      if (!result || typeof result !== 'object' || !('deleted' in result) || !result.deleted) {
        set({ lastError: failureMessage(result, '世界观设定删除失败') })
        return false
      }
      set((state) => ({
        entries: state.entries.filter(entry => entry.id !== id),
        selectedId: state.selectedId === id ? null : state.selectedId,
        lastError: null,
      }))
      return true
    } catch (error) {
      set({ lastError: String(error) })
      return false
    }
  },

  setStatus: async (id, status) => {
    const projectPath = useProjectStore.getState().currentProject?.path
    if (!projectPath) return null
    try {
      const result = await ipc.invoke('world-setting:set-status', id, status, projectPath)
      if (useProjectStore.getState().currentProject?.path !== projectPath) return null
      if (!isEntry(result)) {
        set({ lastError: failureMessage(result, '条目状态修改失败') })
        return null
      }
      set((state) => ({
        entries: sortEntries([...state.entries.filter(entry => entry.id !== result.id), result], state.categories),
        lastError: null,
      }))
      return result
    } catch (error) {
      set({ lastError: String(error) })
      return null
    }
  },

  createCategory: async (draft) => {
    const projectPath = useProjectStore.getState().currentProject?.path
    if (!projectPath) return null
    try {
      const result = await ipc.invoke('world-setting:create-category', draft, projectPath)
      if (useProjectStore.getState().currentProject?.path !== projectPath) return null
      if (!isCategory(result)) {
        set({ lastError: failureMessage(result, '新建设定分类失败') })
        return null
      }
      set((state) => ({
        // 新建的分类排在末尾：它不在返回结果里（主进程只回一条），按 sortOrder 插入即可。
        categories: [...state.categories.filter(category => category.key !== result.key), result]
          .sort((a, b) => a.sortOrder - b.sortOrder || NAME_COLLATOR.compare(a.key, b.key)),
        activeCategory: result.key,
        selectedId: null,
        showPendingQueue: false,
        lastError: null,
      }))
      return result
    } catch (error) {
      set({ lastError: String(error) })
      return null
    }
  },

  removeCategory: async (key) => {
    const projectPath = useProjectStore.getState().currentProject?.path
    if (!projectPath) return { removed: false }
    try {
      const result = await ipc.invoke('world-setting:remove-category', key, projectPath)
      if (useProjectStore.getState().currentProject?.path !== projectPath) return { removed: false }
      if (!result || typeof result !== 'object' || !('removed' in result)) {
        set({ lastError: failureMessage(result, '删除设定分类失败') })
        return { removed: false }
      }
      if (result.removed) {
        set((state) => {
          const categories = state.categories.filter(category => category.key !== key)
          return {
            categories,
            // 删掉的正是当前分类时，退回第一条，别让正文栏停在空分类上。
            activeCategory: state.activeCategory === key
              ? (categories[0]?.key ?? 'world')
              : state.activeCategory,
            lastError: null,
          }
        })
      }
      return result as { removed: boolean; reason?: 'builtin' | 'in-use' }
    } catch (error) {
      set({ lastError: String(error) })
      return { removed: false }
    }
  },

  /**
   * 项目关闭 / 解除绑定时必须调用（否则会造成跨项目事实泄漏）。
   *
   * 为什么关键：AI 侧有 4 个消费点直接读这个 store（AI 工具的 search_world_settings /
   * read_world_setting、生成世界观设定的命令、以及 agent-store 解析 @ 提及），
   * 且它们都不校验 dataProjectPath。如果切项目后 store 仍留着上一部作品的条目，
   * AI 就会把**作品 A 的设定当成作品 B 的既定事实**；反之若从未加载过，
   * 又会谎报「设定库没有任何条目」。所以这里必须连引用清干净。
   *
   * chapterRefs 尤其要清：各项目 SQLite 库的 id 都从 1 开始，
   * 残留的章节引用会把旧作品的 id 映射到新项目的同 id 条目上（必然碰撞）。
   */
  reset: () => set({
    entries: [],
    categories: [],
    chapterRefs: {},
    dataProjectPath: null,
    loadingProjectPath: null,
    lastError: null,
    selectedId: null,
    activeCategory: 'world',
    showPendingQueue: false,
  }),
}))
