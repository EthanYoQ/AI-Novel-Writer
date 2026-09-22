/**
 * WorldSettingSidebarPanel — 世界观设定的侧栏（**分类选择器**）
 *
 * 先生定的信息架构（照章节蓝图的形态）：
 *
 *     侧栏：选分类  →  正文栏：该分类的条目目录  →  点条目：编辑该条
 *
 * 分类**不是写死的八类**：分类表由主进程提供（内置八条 + 作者自建），
 * 这里只负责列出来、让作者切换，并提供「新建分类」入口。
 *
 * 自建分类的删除放在条目悬停出现的小按钮上：内置分类不给删除入口，
 * 里面还有条目的分类由主进程拒绝，界面按原因给提示。
 */
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Compass, Inbox, Plus, RefreshCw, Search, Trash2 } from 'lucide-react'

import WorldSettingConflictDialog from '../../editor/WorldSettingConflictDialog'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Input'
import { Label } from '../../ui/Label'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/Dialog'
import PageHead from '../../ui/PageHead'
import PendingDot from '../../ui/PendingDot'
import { confirm } from '../../ui/Confirm'
import { toast } from '../../ui/Toast'
import { cn } from '../../../lib/utils'
import { useProjectStore } from '../../../stores/project-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { isMagazine, useUiVersionStore } from '../../../stores/ui-version-store'
import { useWorldSettingStore } from '../../../stores/world-setting-store'
import { usePendingUnread } from '../../../stores/pending-badge-store'
import { getWorldSettingCategoryLabels } from '../../../shared/world-setting'
import type { WorldSettingCategoryRecord, WorldSettingEntry } from '../../../shared/world-setting'
import { openBuiltinEditor } from './sidebar-file-openers'

/** 正文栏里世界观设定页的稳定 id：同一个页面只留一个标签。 */
export const WORLD_SETTING_TAB_ID = 'world-setting-editor'

export default function WorldSettingSidebarPanel() {
  const currentProject = useProjectStore(s => s.currentProject)
  const entries = useWorldSettingStore(s => s.entries)
  const categories = useWorldSettingStore(s => s.categories)
  const dataProjectPath = useWorldSettingStore(s => s.dataProjectPath)
  const loadingProjectPath = useWorldSettingStore(s => s.loadingProjectPath)
  const lastError = useWorldSettingStore(s => s.lastError)
  const activeCategory = useWorldSettingStore(s => s.activeCategory)
  const showPendingQueue = useWorldSettingStore(s => s.showPendingQueue)
  const load = useWorldSettingStore(s => s.load)
  const setActiveCategory = useWorldSettingStore(s => s.setActiveCategory)
  const setShowPendingQueue = useWorldSettingStore(s => s.setShowPendingQueue)
  const select = useWorldSettingStore(s => s.select)
  const createCategory = useWorldSettingStore(s => s.createCategory)
  const removeCategory = useWorldSettingStore(s => s.removeCategory)
  const conflicts = useWorldSettingStore(s => s.conflicts)
  const conflictsBusy = useWorldSettingStore(s => s.conflictsBusy)
  const loadConflicts = useWorldSettingStore(s => s.loadConflicts)
  const resolveConflicts = useWorldSettingStore(s => s.resolveConflicts)
  const ignoreConflict = useWorldSettingStore(s => s.ignoreConflict)
  const text = useLocaleStore(s => s.text)
  const uiVersion = useUiVersionStore(s => s.uiVersion)
  /**
   * v3「时尚杂志」下，分类条目的选中态改用**语义类** `ws-category-item-on`
   * （样式在 `mag-pages.css` §8·C）。原因是原来那套「内联 --color-active」
   * 在 v3 里被先生判为「完全不对」：
   *   · 内联的背景压过样式表 —— v3 想给它当前栏目色（设定栏是松绿）也压不动；
   *   · 且未选中的条目会因 Tailwind 类名里的 `bg-[` 子串被误伤成实心色块。
   * v2 一个字都不动：它仍走自己的 Tailwind 类与内联样式（铁律三·分家）。
   */
  const magSelection = isMagazine(uiVersion)

  const [searchQuery, setSearchQuery] = useState('')
  const [showNewCategory, setShowNewCategory] = useState(false)
  const [conflictDialogOpen, setConflictDialogOpen] = useState(false)
  const [newCategoryName, setNewCategoryName] = useState('')
  const [newCategoryDesc, setNewCategoryDesc] = useState('')
  const [categoryBusy, setCategoryBusy] = useState(false)

  const projectPath = currentProject?.path ?? ''
  // 面板一出现就把条目与分类读进来；换作品时重读（store 内部另有一道项目一致性防护）。
  useEffect(() => {
    if (projectPath) void load(projectPath)
  }, [projectPath, load])

  // 冲突队列也一并读：入口要在面板一打开就反映现状，不能等作者点进去才知道有冲突。
  useEffect(() => {
    if (projectPath) void loadConflicts()
  }, [projectPath, loadConflicts])

  // 数据还没跟上当前作品时一律按空列表统计，避免闪现上一部作品的数字。
  const dataReady = Boolean(projectPath) && dataProjectPath === projectPath
  // 必须包 useMemo：`dataReady ? entries : []` 里的空数组字面量每次渲染都是新引用，
  // 会让下面几个依赖它的 useMemo 每渲染一次就失效重算。
  const visibleEntries = useMemo(() => (dataReady ? entries : []), [dataReady, entries])

  /**
   * 每个分类的条目数：侧栏的职责就是让作者知道「哪一栏已经有东西了」。
   * **待确认候选也计入**：它们在分类栏目里是看得见的（带「待确认」标记），
   * 数字却不加，作者会看到「栏目里有条目、侧栏写 0」的矛盾。
   * 「还没采纳」这件事由「待确认」那一行单独表达，不靠分类数字隐瞒。
   */
  const countByCategory = useMemo(() => {
    const counts = new Map<string, number>()
    for (const entry of visibleEntries) {
      counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1)
    }
    return counts
  }, [visibleEntries])

  /** 待确认候选数：决定侧栏那一行入口出不出现。 */
  const pendingCount = useMemo(
    () => visibleEntries.filter(entry => entry.status === 'pending').length,
    [visibleEntries],
  )

  /**
   * 「有新的等着确认」的小红点（先生 2026-09-21）：
   *   「有新的待确认的角色，候选，设定等内容的时候，可以在待确认、候选、待选等地方
   *     做个小红点？类似未读消息？」
   *
   * 口径见 pending-badge-store：只有**没见过的 id** 才亮，作者点开入口即消点。
   * 两个队列各记一份 —— 待确认候选与待裁决冲突是两件事，别让一个的红点盖住另一个。
   */
  const pendingIds = useMemo(
    () => visibleEntries
      .filter(entry => entry.status === 'pending')
      .map(entry => String(entry.id)),
    [visibleEntries],
  )
  const { unread: hasUnreadPending, markSeen: markPendingSeen } = usePendingUnread(
    projectPath || null,
    'world-setting-pending',
    pendingIds,
  )
  const conflictIds = useMemo(() => conflicts.map(conflict => String(conflict.id)), [conflicts])
  const { unread: hasUnreadConflicts, markSeen: markConflictsSeen } = usePendingUnread(
    projectPath || null,
    'setting-conflicts',
    conflictIds,
  )

  const openCategory = (categoryKey: string) => {
    // 换分类即清空条目选中 —— 正文栏随之回到「该分类的目录」视图。
    setActiveCategory(categoryKey)
    openBuiltinEditor(WORLD_SETTING_TAB_ID, text('设定集', 'World building'), 'world-setting')
  }

  const openPendingQueue = () => {
    // 打开即「看过了」：红点与「他确实看见了」是同一个动作（见 pending-badge-store）。
    markPendingSeen()
    setShowPendingQueue(true)
    openBuiltinEditor(WORLD_SETTING_TAB_ID, text('设定集', 'World building'), 'world-setting')
  }

  /** 分类名（含自建分类）—— 搜索结果里要标出这条属于哪一栏。 */
  const categoryNameOf = (key: string): string => {
    const labels = getWorldSettingCategoryLabels(key, categories)
    return text(labels.zhCN, labels.enUS)
  }

  /**
   * 搜索命中：跨分类匹配名称、别名、摘要与标签（与角色列表的搜索同一套手感）。
   * **待确认候选同样可搜**：它们既然出现在分类栏目里，搜不到就等于「看得见却找不着」。
   */
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase()
  const matchedEntries = useMemo(() => {
    if (!normalizedQuery) return [] as WorldSettingEntry[]
    return visibleEntries.filter((entry) => {
      const haystack = [entry.name, entry.summary, ...entry.aliases, ...entry.tags]
        .join(' ')
        .toLocaleLowerCase()
      return haystack.includes(normalizedQuery)
    })
  }, [visibleEntries, normalizedQuery])

  /** 点搜索结果：先切到它所属的分类，再选中它（顺序不能反 —— 换分类会清空选中）。 */
  const openEntry = (entry: WorldSettingEntry) => {
    setActiveCategory(entry.category)
    select(entry.id)
    openBuiltinEditor(WORLD_SETTING_TAB_ID, text('设定集', 'World building'), 'world-setting')
  }

  const handleCreateCategory = async () => {
    const name = newCategoryName.trim()
    if (!name || categoryBusy) return
    setCategoryBusy(true)
    const created = await createCategory({ zhCN: name, descriptionZhCN: newCategoryDesc.trim() })
    setCategoryBusy(false)
    if (!created) {
      toast.error(text('新建分类失败，请重试', 'Could not create the category. Please try again.'))
      return
    }
    toast.success(text('分类已创建', 'Category created'))
    setShowNewCategory(false)
    setNewCategoryName('')
    setNewCategoryDesc('')
    // 建完直接跳到新分类，作者可以马上往里加条目。
    openBuiltinEditor(WORLD_SETTING_TAB_ID, text('设定集', 'World building'), 'world-setting')
  }

  const handleRemoveCategory = async (category: WorldSettingCategoryRecord) => {
    const ok = await confirm(
      text(
        `删除分类「${category.zhCN}」？分类下必须没有条目才能删除。`,
        `Delete the category “${category.enUS}”? It must be empty first.`,
      ),
      { title: text('删除设定分类', 'Delete category') },
    )
    if (!ok) return
    const result = await removeCategory(category.key)
    if (result.removed) {
      toast.success(text('分类已删除', 'Category deleted'))
      return
    }
    if (result.reason === 'in-use') {
      toast.error(text('该分类下还有条目，请先移走或删除它们。', 'This category still has entries. Move or delete them first.'))
      return
    }
    toast.error(text('该分类无法删除。', 'That category cannot be deleted.'))
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 顶部操作栏 */}
      <div className="flex items-center justify-between px-3 h-9 flex-shrink-0 border-b border-[var(--color-border)]">
        <span className="text-xs font-medium text-[var(--color-text)] flex items-center gap-1">
          <Compass size={13} />
          {text(`设定分类（${categories.length}）`, `Categories (${categories.length})`)}
        </span>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => { if (projectPath) void load(projectPath) }}
            disabled={!projectPath || loadingProjectPath === projectPath}
            title={text('刷新', 'Refresh')}
          >
            <RefreshCw size={14} strokeWidth={2} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => setShowNewCategory(true)}
            disabled={!dataReady}
            title={text('新建分类', 'New category')}
          >
            <Plus size={14} strokeWidth={2} />
          </Button>
        </div>
      </div>

      {/* 搜索：位置与规格对齐角色列表（先生：两栏手感要一致） */}
      <div className="relative px-2 py-1.5 border-b border-[var(--color-border)]">
        <Search size={12} className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
        <Input
          value={searchQuery}
          onChange={event => setSearchQuery(event.target.value)}
          aria-label={text('搜索设定条目', 'Search entries')}
          placeholder={text('搜索设定条目', 'Search entries')}
          className="h-7 pl-7 text-xs"
        />
      </div>

      {/* 分类列表 */}
      <div className="flex-1 overflow-y-auto p-1">
        {/* 待确认队列入口：有候选时才出现（先生认可的形态：不打扰，但不漏） */}
        {pendingCount > 0 && (
          <div
            className={cn(
              'ws-category-item relative flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md text-xs cursor-pointer mb-1',
              showPendingQueue
                ? (magSelection ? 'ws-category-item-on' : 'bg-[var(--color-active)]')
                : 'hover:bg-[var(--color-hover)]',
            )}
            onClick={openPendingQueue}
            title={hasUnreadPending
              ? text('有新的设定候选等着你确认', 'New setting candidates are waiting for your review')
              : text('有待确认的设定候选', 'Setting candidates pending review')}
          >
            <span className="text-sm font-semibold text-[var(--color-text)] flex items-center gap-1.5">
              <Inbox size={13} />
              {text('待确认', 'Pending')}
            </span>
            <span className="flex-shrink-0 text-[0.68rem] tabular-nums" style={{ color: 'var(--color-accent)' }}>
              {pendingCount}
            </span>
            {hasUnreadPending && <PendingDot />}
          </div>
        )}

        {/* 冲突裁决入口：有冲突时才出现。
            先生要的就是「不用自己苦哈哈去找」—— 定稿后 AI 报了冲突，
            入口立刻在这里冒出来，点开就是并排对照 + 一键裁决。 */}
        {conflicts.length > 0 && (
          <div
            className="ws-category-item relative flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md text-xs cursor-pointer mb-1 hover:bg-[var(--color-hover)]"
            onClick={() => {
              markConflictsSeen()
              void loadConflicts()
              setConflictDialogOpen(true)
            }}
            title={hasUnreadConflicts
              ? text('有新的设定冲突等着你裁决', 'New setting conflicts are waiting')
              : text('有待裁决的设定冲突', 'Setting conflicts pending')}
          >
            <span className="text-sm font-semibold flex items-center gap-1.5" style={{ color: 'var(--color-text)' }}>
              <AlertTriangle size={13} />
              {text('待裁决冲突', 'Setting conflicts')}
            </span>
            <span className="flex-shrink-0 text-[0.68rem] tabular-nums" style={{ color: 'var(--color-accent)' }}>
              {conflicts.length}
            </span>
            {hasUnreadConflicts && <PendingDot />}
          </div>
        )}

        {/* 搜索结果：有搜索词时就地取代分类列表（跨分类查条目） */}
        {normalizedQuery && (
          matchedEntries.length === 0
            ? (
              <div className="px-3 py-5 text-center text-xs opacity-50">
                {text('没有匹配的设定条目', 'No matching entries')}
              </div>
            )
            : matchedEntries.map(entry => (
              <div
                key={entry.id}
                className="px-2.5 py-1 rounded-md text-xs cursor-pointer mb-0.5 hover:bg-[var(--color-hover)]"
                onClick={() => openEntry(entry)}
                title={entry.summary || entry.name}
              >
                <span className="text-sm font-semibold text-[var(--color-text)] truncate block">
                  {entry.name}
                </span>
                <span className="text-[0.68rem] block truncate" style={{ color: 'var(--color-text-muted)' }}>
                  {categoryNameOf(entry.category)}
                </span>
              </div>
            ))
        )}

        {/* 分类列表：搜索时收起，让结果独占面板 */}
        {!normalizedQuery && categories.map((category) => {
          const count = countByCategory.get(category.key) ?? 0
          const isActiveCategory = activeCategory === category.key && !showPendingQueue
          return (
            <div
              key={category.key}
              className={cn(
                'ws-category-item group flex items-center justify-between gap-2 px-2.5 py-1 rounded-md text-xs cursor-pointer mb-0.5',
                isActiveCategory
                  ? (magSelection ? 'ws-category-item-on' : '')
                  : 'hover:bg-[var(--color-hover)]',
              )}
              /*
                选中态：v2 走内联样式（底纹 --color-active 在 v2 下是纯白，
                压在纸色侧栏上几乎看不出，所以再补一道朱砂左缘 —— 项目里
                .archive-nav-row.on 就是这套「书签」语言；内联写死可以绕开
                @layer 层叠与变量作用域的坑，保证一定生效）。
                v3 交给 `ws-category-item-on` 那条 CSS —— **不能再给内联样式**：
                内联压过样式表，会把 mag 层的当前栏目色顶掉（这正是先生
                第十五轮说「完全不对」的那一半原因）。
              */
              style={isActiveCategory && !magSelection
                ? {
                    backgroundColor: 'var(--color-active)',
                    boxShadow: 'inset 2px 0 0 var(--color-accent, #A93226)',
                  }
                : undefined}
              onClick={() => openCategory(category.key)}
              title={text(category.descriptionZhCN || category.zhCN, category.descriptionEnUS || category.enUS)}
            >
              <span className="text-sm font-semibold truncate text-[var(--color-text)]">
                {text(category.zhCN, category.enUS)}
              </span>
              <span className="flex items-center gap-1.5 flex-shrink-0">
                {/* 自建分类给删除入口（内置的不给）；平时藏着，悬停才现身 */}
                {!category.builtin && (
                  <button
                    type="button"
                    className="ws-cat-remove"
                    title={text('删除该分类', 'Delete this category')}
                    aria-label={text('删除该分类', 'Delete this category')}
                    onClick={(event) => {
                      event.stopPropagation()
                      void handleRemoveCategory(category)
                    }}
                  >
                    <Trash2 size={11} />
                  </button>
                )}
                <span className="text-[0.68rem] tabular-nums" style={{ color: 'var(--color-text-muted)' }}>
                  {count > 0 ? count : ''}
                </span>
              </span>
            </div>
          )
        })}

        {lastError && (
          <div className="px-3 py-4 text-xs" style={{ color: 'var(--color-error-text)' }}>
            {lastError}
          </div>
        )}
      </div>

      {/* 开发中说明 */}
      <div className="wss-foot">
        {text(
          '开发中：条目与分类可自由增删改，@ 助手已接入，AI 生成与蓝图引用随后。',
          'Under construction: entries and categories are editable and @ assistant works; AI generation and blueprint references are next.',
        )}
      </div>

      {/* 新建分类 */}
      <Dialog open={showNewCategory} onOpenChange={setShowNewCategory}>
        <DialogContent
          className="max-w-[480px]"
          /* 先生：分类名与「这一栏放什么」填到一半，误点蒙版关掉就得重写。 */
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <DialogHeader className="app-dialog-head">
            <DialogTitle className="sr-only">{text('新建设定分类', 'New setting category')}</DialogTitle>
            <PageHead
              kicker={text('WORLD · 新建分类', 'WORLD · NEW CATEGORY')}
              title={text('新建设定分类', 'New setting category')}
              description={text(
                '分类名随你定。说明这一栏放什么 —— AI 生成与定稿归纳时，正是靠它判断该把新条目归到哪一类。',
                'Name the category freely. The description tells the AI what belongs here when generating or rounding up entries.',
              )}
            />
          </DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">{text('分类名', 'Name')}</Label>
              <Input
                value={newCategoryName}
                onChange={event => setNewCategoryName(event.target.value)}
                placeholder={text('例如：法宝、丹药、门派谱系', 'e.g. Artifacts, Pills, Lineages')}
                aria-label={text('分类名', 'Category name')}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">{text('这一栏放什么（给 AI 的判据）', 'What belongs here (the AI’s criterion)')}</Label>
              <Input
                value={newCategoryDesc}
                onChange={event => setNewCategoryDesc(event.target.value)}
                placeholder={text('例如：各类法器、法宝、灵器的名称与来历', 'e.g. Named artifacts, their powers and origins')}
                aria-label={text('分类说明', 'Category description')}
              />
            </div>
          </div>
          <DialogFooter>
            <button className="btn ghost sm" type="button" onClick={() => setShowNewCategory(false)} disabled={categoryBusy}>
              {text('取消', 'Cancel')}
            </button>
            <button
              className="btn primary sm"
              type="button"
              onClick={() => { void handleCreateCategory() }}
              disabled={categoryBusy || !newCategoryName.trim()}
            >
              <Plus size={11} /> {text('创建分类', 'Create category')}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 冲突裁决：定稿后 AI 发现「正文与设定打架」，作者在这里一键处理。 */}
      <WorldSettingConflictDialog
        open={conflictDialogOpen}
        conflicts={conflicts}
        busy={conflictsBusy}
        onClose={() => setConflictDialogOpen(false)}
        onResolve={(ids, resolution) => {
          void (async () => {
            const ok = await resolveConflicts(ids, resolution)
            if (!ok) toast.error(text('裁决失败，请重试', 'Could not record your decision. Please try again.'))
          })()
        }}
        onIgnore={(id) => {
          void (async () => {
            const ok = await ignoreConflict(id)
            if (!ok) toast.error(text('操作失败，请重试', 'That did not work. Please try again.'))
          })()
        }}
      />
    </div>
  )
}
