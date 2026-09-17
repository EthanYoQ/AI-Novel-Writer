/**
 * CharactersView — 角色管理列表视图
 */

import { useMemo, useState } from 'react'
import { Users, RefreshCw, Plus, Search } from 'lucide-react'
import { useProjectStore } from '../../../stores/project-store'
import { useCharacterStore } from '../../../stores/character-store'
import { useEditorStore } from '../../../stores/editor-store'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Input'
import { EmptyState } from '../../ui/EmptyState'
import { cn } from '../../../lib/utils'
import { useLocaleStore } from '../../../stores/locale-store'
import { useUiVersionStore, isModernShell } from '../../../stores/ui-version-store'
import { openRailLandingPage } from '../../layout/v2/rail-routing'
import { getCharacterRoleLabels, normalizeCharacterRole, type CharacterRole } from '../../../shared/character-role'
import { CharacterCardImportButton } from '../../characters/CharacterCardImportButton'

/**
 * 角色分区的固定顺序：主角 → 反派 → 配角 → 龙套。
 * 与 shared/character-role.ts 的枚举同序；将来若新增定位层级，这里要一起改。
 */
const ZONE_ORDER: readonly CharacterRole[] = ['protagonist', 'antagonist', 'supporting', 'minor']

/**
 * 分区内按姓名排序用。
 *
 * 中文走拼音、英文走字母，都交给 Intl.Collator('zh-CN')：多音字（单 / 重 / 区 / 解）
 * 只有系统词库判得准，手工维护「首字母 → 拼音表」一定会错。
 * numeric 让「角色2」排在「角色10」前面。
 */
const NAME_COLLATOR = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

export default function CharactersView() {
  const [searchQuery, setSearchQuery] = useState('')
  const isV2 = useUiVersionStore(s => isModernShell(s.uiVersion))
  const currentProject = useProjectStore(s => s.currentProject)
  const characters = useCharacterStore(s => s.characters)
  const dataProjectKey = useCharacterStore(s => s.dataProjectKey)
  const loadingProjectKey = useCharacterStore(s => s.loadingProjectKey)
  const selectedName = useCharacterStore(s => s.selectedName)
  const load = useCharacterStore(s => s.load)
  const setSelectedName = useCharacterStore(s => s.setSelectedName)
  const addCharacter = useCharacterStore(s => s.addCharacter)
  const identityBusy = useCharacterStore(s => s.identityBusy)
  const lastError = useCharacterStore(s => s.lastError)
  /** 正文栏当前打开的页面；为 null 时表示停在书架这类「栏目首页」，没有可停留的页面。 */
  const activeTabId = useEditorStore(s => s.activeTabId)
  const text = useLocaleStore(s => s.text)
  const roleLabel = (role: unknown) => {
    const { zhCN, enUS } = getCharacterRoleLabels(role)
    return text(zhCN, enUS)
  }
  const dataReady = Boolean(
    currentProject
    && dataProjectKey === currentProject.path
    && loadingProjectKey === null
    && lastError === null,
  )
  const visibleCharacters = dataReady ? characters : []
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase()
  const filteredCharacters = normalizedQuery
    ? visibleCharacters.filter(character => character.name.toLocaleLowerCase().includes(normalizedQuery))
    : visibleCharacters

  /**
   * 先生：列表按「主角 → 反派 → 配角 → 龙套」分四个区，区内按姓名拼音 a→z。
   *
   * - 定位取自 character.role，经 normalizeCharacterRole 归一（未知/空值兜底为配角）；
   * - 空区不渲染，避免出现四个空标题；
   * - 搜索时先过滤再分区，所以搜「李」只在有结果的区里显示标题。
   */
  const groupedCharacters = useMemo(() => {
    const buckets = new Map<CharacterRole, typeof filteredCharacters>()
    for (const role of ZONE_ORDER) buckets.set(role, [])
    for (const character of filteredCharacters) {
      buckets.get(normalizeCharacterRole(character.role))?.push(character)
    }
    for (const list of buckets.values()) {
      list.sort((a, b) => NAME_COLLATOR.compare(a.name ?? '', b.name ?? ''))
    }
    return ZONE_ORDER
      .map(role => ({ role, items: buckets.get(role) ?? [] }))
      .filter(zone => zone.items.length > 0)
  }, [filteredCharacters])

  /**
   * 单个角色条目。分区渲染共用这一份实现 ——
   * 选中与跳转行为与原列表完全一致，本次只改排序，不碰交互。
   */
  const renderCharacterItem = (c: (typeof visibleCharacters)[number]) => (
    <div
      key={c.name}
      className={cn(
        // 先生：条目压成一行文字的高度（py-1），同样高度能放下更多角色。
        // `char-row` / `char-row-on` 是给 v3 用的**语义类名**：
        // v2 仍按原来的 Tailwind 类生效（类名只增不改，外观逐像素不变），
        // v3 则在 mag 层用自己的类名重做悬停与选中 —— 两边不再靠在 Tailwind
        // 类名上做属性选择器互相猜。
        'char-row px-2.5 py-1 rounded-md text-xs cursor-pointer mb-0.5',
        selectedName === c.name
          ? 'char-row-on bg-[var(--color-active)] text-[var(--color-text)]'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-hover)]'
      )}
      onClick={() => {
        setSelectedName(c.name)
        /**
         * 切换角色**不再**把正文栏拽到「人物档案」。
         *
         * 选中角色只改 selectedName，正文栏停在哪个页面就留在哪个页面：
         *   · 停在关系图谱 —— 图谱以 selectedName 为中心，会直接换成该角色的
         *     视角并把关系网络展开（RelationMap 的 center 就是它）；
         *   · 停在人物档案 —— 档案按新选中的角色重绘；
         *   · 停在正文 / 蓝图等其它页面 —— 保持不动，不再被强行切走。
         * 只有正文栏此刻没有可停留的页面（停在书架这类栏目首页，没有激活标签）
         * 时，才把人物档案作为落点，避免点了名字界面毫无反应。
         * 经典界面（v1）下角色编辑器本来就占着正文区，无需额外动作。
         */
        if (isV2 && !activeTabId) openRailLandingPage('characters')
      }}
    >
      {/*
        先生：定位（主角 / 反派 / 配角 / 龙套）已经由上面的分栏表达，条目里不再重复；
        「第 N 章更新」从下方挪到名字后面同一行 —— 每个条目因此只占一行文字的高度，
        同样高度能多放下不少角色。名字字号也从 12px 提到 14px（原先太小、看着吃力）。
      */}
      <div className="flex items-baseline gap-1.5 min-w-0">
        {/*
          先生：名字要看得清。除了加粗（500 → 600），还显式给主文字色 ——
          原先它继承条目的 --color-text-secondary（次级灰），在白纸底上本来就发虚，
          单靠加粗救不回来。更新注解保持次级色，形成主次对比。
        */}
        <span className="text-sm font-semibold text-[var(--color-text)] truncate">
          {c.name || text('未命名', 'Untitled')}
        </span>
        {c.currentState && (
          <span className="text-[0.65rem] opacity-45 flex-shrink-0">
            {text(`第${c.currentState.updatedAtChapter}章更新`, `Ch. ${c.currentState.updatedAtChapter}`)}
          </span>
        )}
      </div>
    </div>
  )

  // 角色数据由 ProjectService 统一加载，组件只消费 store 数据

  if (!currentProject) {
    return (
      <EmptyState 
        icon={<Users size={36} />} 
        message={text('请先打开项目', 'Open a project first')}
        className="pb-[15vh]" 
        opacity={0.4} 
      />
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 顶部操作栏 */}
      <div className="flex items-center justify-between px-3 h-9 flex-shrink-0 border-b border-[var(--color-border)]">
        <span className="text-xs font-medium text-[var(--color-text)] flex items-center gap-1">
          <Users size={13} />
          {text(`角色列表（${visibleCharacters.length}）`, `Characters (${visibleCharacters.length})`)}
        </span>
        <div className="flex items-center gap-0.5">
          <CharacterCardImportButton projectKey={currentProject.path} compact disabled={identityBusy || !dataReady} />
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => load(currentProject.path)} disabled={identityBusy || loadingProjectKey !== null} title={text('刷新列表', 'Refresh list')}>
            <RefreshCw size={14} strokeWidth={2} />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={addCharacter} disabled={identityBusy || !dataReady} title={text('新建角色', 'New character')}>
            <Plus size={14} strokeWidth={2} />
          </Button>
        </div>
      </div>
      <div className="relative px-2 py-1.5 border-b border-[var(--color-border)]">
        <Search size={12} className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
        <Input
          value={searchQuery}
          onChange={event => setSearchQuery(event.target.value)}
          aria-label={text('搜索角色', 'Search characters')}
          placeholder={text('搜索角色名称', 'Search character names')}
          className="h-7 pl-7 text-xs"
        />
      </div>
      {/* 角色列表：主角 / 反派 / 配角 / 龙套 四区，区内按姓名拼音 */}
      <div className="flex-1 overflow-y-auto p-1">
        {groupedCharacters.map(zone => (
          <div className="character-zone" key={zone.role}>
            <div className="character-zone-head">
              <span className="czh-label">{roleLabel(zone.role)}</span>
              <span className="czh-count">{zone.items.length}</span>
            </div>
            {zone.items.map(renderCharacterItem)}
          </div>
        ))}
        {visibleCharacters.length === 0 && (
          <div className="text-center py-6 opacity-50 text-xs">
            {lastError
                ? text(`角色列表读取失败：${lastError}`, 'Could not load character list.')
              : text('暂无角色', 'No characters')}
          </div>
        )}
        {visibleCharacters.length > 0 && filteredCharacters.length === 0 && (
          <div className="text-center py-6 opacity-50 text-xs">
            {text('没有匹配的角色', 'No matching characters')}
          </div>
        )}
      </div>
    </div>
  )
}
