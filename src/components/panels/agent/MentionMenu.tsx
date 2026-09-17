/**
 * MentionMenu — @ 引用选择器（锚定输入框的下拉面板）
 *
 * 先生定的形态：**贴着输入框展开的下拉**，而不是居中浮层。
 * 居中浮层虽然不会被裁，但离输入框太远，不符合"就近操作"的直觉。
 *
 * 所以最终做法是两件事各归各位：
 *   · **Portal 渲染到 body** —— 解决被顶栏/滚动容器裁剪的问题；
 *   · **按输入框的屏幕坐标 fixed 定位** —— 菜单仍然紧贴输入框（下方空间不够就向上展开），
 *     左对齐、宽度固定，怎么滚都不会跟丢。
 *
 * 层级（先生要的"先选类型再进去"）：
 *   类别层（角色卡 / 世界观设定 / 架构 / 知识库…）
 *     → 世界观设定下再按**分类**（势力 / 地理 / 规则 / 神器…）
 *     → 该分类的条目
 *   角色卡与其它类别则直接列出条目。
 *
 * 搜索常驻顶部；只列已确认的世界观条目；数据未就绪时按需加载。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  FileStack,
  FileText,
  Globe2,
  Map,
  Search,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { searchMentionTargets, type MentionTarget } from '../../../services/agent/intent-router'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorldSettingStore } from '../../../stores/world-setting-store'
import { useCharacterStore } from '../../../stores/character-store'
import { getCharacterRoleLabels } from '../../../shared/character-role'
import { getWorldSettingCategoryLabels } from '../../../shared/world-setting'

const mentionTargetIcons = {
  architecture: Map,
  character: Users,
  blueprint: ClipboardCheck,
  knowledge: BookOpen,
  chapter: FileStack,
  file: FileText,
  'world-setting': Globe2,
} satisfies Record<MentionTarget['type'], LucideIcon>

/** 有下级可进的类别。 */
const DRILL_DOWN_TYPES = new Set<MentionTarget['type']>(['character', 'world-setting'])

const MENU_WIDTH = 340
/** 菜单最高高度：再高就不好盯着输入框了。 */
const MENU_MAX_HEIGHT = 320
/** 列表一次最多列这么多条，再多靠搜索。 */
const MAX_ITEMS = 60

/** 锚点：输入框在屏幕上的位置（调用方用 getBoundingClientRect 算好传进来）。 */
export interface MentionAnchor {
  left: number
  top: number
  bottom: number
  /** 视口高度：用来判断向下还是向上展开。 */
  viewportHeight: number
  /** 视口宽度：用来把菜单推回视口内，避免右边被截掉。 */
  viewportWidth?: number
}

interface Props {
  /** 输入框里 @ 后面的文字：作为菜单搜索框的初值。 */
  query: string
  onSelect: (target: MentionTarget) => void
  onClose: () => void
  /** 锚点：菜单贴着这个位置展开。缺省时退化为居中（仅供无坐标的场景兜底）。 */
  anchor?: MentionAnchor | null
  /** 直接进入某个类别（章节蓝图只引用设定，用 'world-setting'）。 */
  directTo?: MentionTarget['type']
}

type Level =
  | { kind: 'roots' }
  | { kind: 'categories' }                        // 世界观设定 → 分类层
  | { kind: 'items'; type: MentionTarget['type']; category?: string }

export default function MentionMenu({ query, onSelect, onClose, anchor, directTo }: Props) {
  const locale = useLocaleStore(state => state.locale)
  const text = useLocaleStore(state => state.text)
  const [search, setSearch] = useState(query)
  const [level, setLevel] = useState<Level>(
    directTo === 'world-setting' ? { kind: 'categories' } : { kind: 'roots' },
  )
  /**
   * 键盘 / 悬停选中的项在**当前筛选结果**里的序号。
   *
   * 它的语义是「相对于当前搜索词与层级的序号」——搜索词或层级一变就该归零。
   * 原先用 `useEffect(() => setSelectedIndex(0), [search, level])` 重置，那是
   * effect 里同步 setState，白多一次级联渲染。改为把序号连同它所属的「筛选键」
   * 一起存：筛选键与当前不符时读出来就是 0，重置天然发生，不需要 effect。
   */
  const [navigation, setNavigation] = useState({ key: '', index: 0 })
  const filterKey = `${level.kind}\u0000${level.kind === 'items' ? `${level.type}\u0000${level.category ?? ''}` : ''}\u0000${search}`
  const selectedIndex = navigation.key === filterKey ? navigation.index : 0
  const setSelectedIndex = (next: number | ((prev: number) => number)) => {
    setNavigation(prev => ({
      key: filterKey,
      index: typeof next === 'function' ? next(prev.key === filterKey ? prev.index : 0) : next,
    }))
  }
  const listRef = useRef<HTMLDivElement>(null)

  const characterEntries = useCharacterStore(s => s.characters)
  const worldEntries = useWorldSettingStore(s => s.entries)
  const worldCategories = useWorldSettingStore(s => s.categories)

  // 打开就把两个数据源拉齐：否则会先显示"没有内容"，作者以为真的没有
  const currentProject = useProjectStore(s => s.currentProject)
  const worldDataProjectPath = useWorldSettingStore(s => s.dataProjectPath)
  const characterDataProjectKey = useCharacterStore(s => s.dataProjectKey)
  const loadWorldSettings = useWorldSettingStore(s => s.load)
  const loadCharacters = useCharacterStore(s => s.load)

  useEffect(() => {
    const projectPath = currentProject?.path
    if (!projectPath) return
    if (worldDataProjectPath !== projectPath) void loadWorldSettings(projectPath)
    if (characterDataProjectKey !== projectPath) void loadCharacters(projectPath)
  }, [currentProject, worldDataProjectPath, characterDataProjectKey, loadWorldSettings, loadCharacters])

  const confirmedWorldEntries = useMemo(
    () => worldEntries.filter(entry => entry.status !== 'pending'),
    [worldEntries],
  )

  /** 当前层级要显示的项。 */
  const visibleItems = useMemo<MentionTarget[]>(() => {
    const q = search.trim().toLocaleLowerCase()
    if (level.kind === 'roots') {
      return searchMentionTargets(q, locale)
    }
    if (level.kind === 'categories') {
      // 分类层：只列出确实有条目的分类
      const usedCategories = new Set(confirmedWorldEntries.map(entry => entry.category))
      const allCategories = worldCategories
        .filter(category => usedCategories.has(category.key))
        .map(category => {
          const labels = getWorldSettingCategoryLabels(category.key, worldCategories)
          const count = confirmedWorldEntries.filter(entry => entry.category === category.key).length
          return {
            type: 'world-setting' as const,
            displayName: text(labels.zhCN, labels.enUS),
            value: category.key,
            hint: text(`${count} 条`, `${count}`),
          }
        })
      if (!q) return allCategories
      const matched = allCategories.filter(category => (
        category.displayName.toLocaleLowerCase().includes(q)
      ))
      // 章节蓝图只引用设定（directTo）：作者敲的「设定」是「世界观设定」这个大类名，
      // 不是分类名，匹配不到分类时回退显示全部分类，否则列表会被过滤成空。
      if (matched.length === 0 && directTo) return allCategories
      return matched
    }
    // 条目层
    const source = level.type === 'character'
      ? characterEntries.map(character => ({
          type: 'character' as const,
          displayName: character.name,
          value: character.name,
          hint: text(getCharacterRoleLabels(character.role).zhCN, getCharacterRoleLabels(character.role).enUS),
        }))
      : confirmedWorldEntries
        .filter(entry => !level.category || entry.category === level.category)
        .map(entry => ({
          type: 'world-setting' as const,
          displayName: entry.name,
          value: entry.name,
          hint: text(
            getWorldSettingCategoryLabels(entry.category, worldCategories).zhCN,
            getWorldSettingCategoryLabels(entry.category, worldCategories).enUS,
          ),
        }))
    if (!q) return source.slice(0, MAX_ITEMS)
    return source
      .filter(target => (
        target.displayName.toLocaleLowerCase().includes(q)
        || (target.hint ?? '').toLocaleLowerCase().includes(q)
      ))
      .slice(0, MAX_ITEMS)
  }, [level, search, locale, confirmedWorldEntries, worldCategories, characterEntries, text, directTo])

  // 不再需要「search / level 变化时 setSelectedIndex(0)」的 effect：
  // 上面的筛选键派生已经承担了这次重置。

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const enterItem = (target: MentionTarget) => {
    if (level.kind === 'roots' && target.type === 'world-setting') {
      setLevel({ kind: 'categories' })
      setSearch('')
      return
    }
    if (level.kind === 'roots' && target.type === 'character') {
      setLevel({ kind: 'items', type: 'character' })
      setSearch('')
      return
    }
    if (level.kind === 'categories') {
      setLevel({ kind: 'items', type: 'world-setting', category: target.value })
      setSearch('')
      return
    }
    onSelect(target)
  }

  const goBack = () => {
    setSearch('')
    if (level.kind === 'roots') {
      onClose()
      return
    }
    if (level.kind === 'categories') {
      // 分类层：directTo 进来的没有更上一层（本来就没有类别层）→ 直接关
      if (directTo) onClose()
      else setLevel({ kind: 'roots' })
      return
    }
    // 条目层
    if (level.type === 'world-setting') {
      // 关键修复：世界观的条目层要退回**分类层**（原先退回一个没有分类的条目层，
      // 看起来就像"点了返回没反应"）
      setLevel({ kind: 'categories' })
      return
    }
    if (directTo) onClose()
    else setLevel({ kind: 'roots' })
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelectedIndex(i => Math.min(i + 1, Math.max(visibleItems.length - 1, 0)))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelectedIndex(i => Math.max(i - 1, 0))
    } else if (event.key === 'Enter') {
      const target = visibleItems[selectedIndex]
      if (target) {
        event.preventDefault()
        enterItem(target)
      }
    } else if (event.key === 'Escape') {
      event.preventDefault()
      if (level.kind === 'roots') onClose()
      else goBack()
    }
  }

  /* 定位：贴着输入框。下方空间不足就向上展开；右边会溢出就推回视口内。 */
  const positionStyle = useMemo<React.CSSProperties>(() => {
    if (!anchor) {
      return { position: 'fixed', left: '50%', top: '18%', transform: 'translateX(-50%)', width: MENU_WIDTH }
    }
    // 先生：整体往左偏 30px（菜单挂在输入框正左缘时右侧容易被挤掉）
    const preferredLeft = anchor.left - 30
    const viewportWidth = anchor.viewportWidth ?? 0
    const left = viewportWidth > 0
      ? Math.min(Math.max(preferredLeft, 8), Math.max(viewportWidth - MENU_WIDTH - 8, 8))
      : Math.max(preferredLeft, 8)

    const spaceBelow = anchor.viewportHeight - anchor.bottom
    const openUpward = spaceBelow < MENU_MAX_HEIGHT + 24
    return openUpward
      ? {
          position: 'fixed',
          left,
          bottom: Math.max(anchor.viewportHeight - anchor.top + 6, 0),
          width: MENU_WIDTH,
          maxHeight: Math.min(MENU_MAX_HEIGHT, Math.max(anchor.top - 16, 160)),
        }
      : {
          position: 'fixed',
          left,
          top: anchor.bottom + 6,
          width: MENU_WIDTH,
          maxHeight: Math.min(MENU_MAX_HEIGHT, Math.max(spaceBelow - 16, 160)),
        }
  }, [anchor])

  const levelLabel = level.kind === 'items'
    ? (level.type === 'character'
        ? text('角色卡', 'Character cards')
        : level.category
          ? text(
              getWorldSettingCategoryLabels(level.category, worldCategories).zhCN,
              getWorldSettingCategoryLabels(level.category, worldCategories).enUS,
            )
          : text('世界观设定', 'World settings'))
    : level.kind === 'categories'
      ? text('世界观设定', 'World settings')
      : ''
  const loading = confirmedWorldEntries.length === 0 && characterEntries.length === 0

  /* 面板本体；测试与 SSR 环境没有 document / window，退回内联渲染 */
  const panel = (
    <div
      className="flex flex-col rounded-xl overflow-hidden"
      style={{
        ...positionStyle,
        zIndex: 9999,
        backgroundColor: 'var(--color-sidebar)',
        border: '1px solid var(--color-border)',
        boxShadow: '0 16px 40px -10px rgba(0,0,0,.35)',
      }}
      role="dialog"
      aria-label={text('引用内容', 'Reference content')}
    >
      {/* 搜索常驻顶部 */}
      <div
        className="flex items-center gap-2 px-3 py-2 border-b flex-shrink-0"
        style={{ borderColor: 'var(--color-border)' }}
      >
        {level.kind === 'roots' ? (
          <Search size={14} className="flex-shrink-0" style={{ color: 'var(--color-text-muted)' }} aria-hidden="true" />
        ) : (
          /* 先生：返回做成「图标 + 文字」，一眼看得懂，不会有人找不到 */
          <button
            type="button"
            className="flex-shrink-0 flex items-center gap-0.5 rounded px-1 py-0.5 text-[12px] transition-colors"
            style={{ color: 'var(--color-text-muted)' }}
            aria-label={text('返回上一级', 'Back')}
            onClick={goBack}
            onMouseEnter={event => { event.currentTarget.style.backgroundColor = 'var(--color-hover)' }}
            onMouseLeave={event => { event.currentTarget.style.backgroundColor = 'transparent' }}
          >
            <ChevronLeft size={14} />
            {text('返回', 'Back')}
          </button>
        )}
        <input
          autoFocus
          value={search}
          onChange={event => setSearch(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={level.kind === 'roots'
            ? text('搜索要引用的内容…', 'Search what to reference…')
            : text(`在「${levelLabel}」里搜索…`, `Search in “${levelLabel}”…`)}
          aria-label={text('搜索', 'Search')}
          className="flex-1 bg-transparent border-0 outline-none text-sm"
          style={{ color: 'var(--color-text)', boxShadow: 'none' }}
        />
        {level.kind !== 'roots' && (
          <span className="flex-shrink-0 text-[11px] tabular-nums" style={{ color: 'var(--color-text-muted)' }}>
            {visibleItems.length}
          </span>
        )}
      </div>

      {/* 清单：内部滚动 */}
      <div ref={listRef} className="flex-1 overflow-y-auto py-1">
        {visibleItems.length === 0 ? (
          <div className="px-4 py-5 text-center text-sm" style={{ color: 'var(--color-text-muted)' }}>
            {level.kind !== 'roots' && loading
              ? text('读取中…', 'Loading…')
              : text('没有匹配项', 'No matches')}
          </div>
        ) : (
          visibleItems.map((target, index) => {
            const TargetIcon = mentionTargetIcons[target.type]
            const canDrillDown = level.kind === 'roots'
              ? DRILL_DOWN_TYPES.has(target.type)
              : level.kind === 'categories'
            return (
              <button
                key={`${target.type}:${target.value}`}
                type="button"
                data-index={index}
                onClick={() => enterItem(target)}
                onMouseEnter={() => setSelectedIndex(index)}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors"
                style={{
                  backgroundColor: index === selectedIndex ? 'var(--color-hover)' : 'transparent',
                  color: 'var(--color-text)',
                }}
              >
                {level.kind === 'categories'
                  ? <Globe2 size={14} strokeWidth={1.8} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} aria-hidden="true" />
                  : <TargetIcon size={14} strokeWidth={1.8} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} aria-hidden="true" />}
                <span className="truncate">{target.displayName}</span>
                {target.hint && (
                  <span
                    className="ml-auto flex-shrink-0 truncate text-[11px]"
                    style={{ color: 'var(--color-text-muted)', maxWidth: 150 }}
                  >
                    {target.hint}
                  </span>
                )}
                {canDrillDown && (
                  <ChevronRight size={13} className="flex-shrink-0" style={{ color: 'var(--color-text-muted)' }} aria-hidden="true" />
                )}
              </button>
            )
          })
        )}
      </div>

      {/* 键盘提示 */}
      <div
        className="flex items-center gap-3 px-3 py-1.5 border-t flex-shrink-0 text-[11px]"
        style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}
      >
        <span>{text('方向键选择', 'Arrows to select')}</span>
        <span>Enter {text('确认', 'confirm')}</span>
        <span>Esc {text('返回', 'back')}</span>
      </div>
    </div>
  )

  if (typeof document === 'undefined') return panel

  /*
   * 点击面板外部关闭：用一个覆盖全屏的透明层接住鼠标事件，
   * 但它不参与布局（pointer-events 正常），所以不会挡到别的东西。
   */
  return createPortal(
    <div
      className="fixed inset-0"
      style={{ zIndex: 9998 }}
      onMouseDown={onClose}
    >
      <div onMouseDown={event => event.stopPropagation()}>{panel}</div>
    </div>,
    document.body,
  )
}
