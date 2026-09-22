/**
 * CharactersView — 角色管理列表视图
 */

import { useEffect, useMemo, useState } from 'react'
import { Users, RefreshCw, Plus, Search, UserPlus } from 'lucide-react'
import { useProjectStore } from '../../../stores/project-store'
import { useCharacterStore } from '../../../stores/character-store'
import { useEditorStore } from '../../../stores/editor-store'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Input'
import { EmptyState } from '../../ui/EmptyState'
import PendingDot from '../../ui/PendingDot'
import { cn } from '../../../lib/utils'
import { useLocaleStore } from '../../../stores/locale-store'
import { useUiVersionStore, isModernShell } from '../../../stores/ui-version-store'
import { openRailLandingPage } from '../../layout/v2/rail-routing'
import { getCharacterRoleLabels, normalizeCharacterRole, type CharacterRole } from '../../../shared/character-role'
import { CharacterCardImportButton } from '../../characters/CharacterCardImportButton'
import CharacterCandidateReviewDialog from '../../characters/CharacterCandidateReviewDialog'
import { useCharacterCandidateStore } from '../../../stores/character-candidate-store'
import { usePendingUnread } from '../../../stores/pending-badge-store'
import { captureProjectSession, isProjectSessionCurrent } from '../../project-session-gate'
import { globalEventBus } from '../../../shared/event-bus'

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
   * 正文新角色的「待确认」队列。
   *
   * 定稿时模型提了名、但名单里还没有的角色会落在这里等人裁决（先生 2026-09-21
   * 定的形态）。队列挂在项目上，所以切项目要重新读一次；读取用的会话是当场
   * 冻结的，晚到的旧结果不会回填。
   */
  const [showCandidateReview, setShowCandidateReview] = useState(false)
  const candidates = useCharacterCandidateStore(s => s.candidates)
  const loadCandidates = useCharacterCandidateStore(s => s.load)
  const projectSession = useMemo(() => captureProjectSession(currentProject), [currentProject])
  /**
   * 「有新的等着确认」的小红点（先生 2026-09-21）。
   *
   * 口径见 pending-badge-store：没见过的 id 才算未读，作者点开队列即消点。
   * 点开的那一下顺手记一笔，所以红点的熄灭与「他确实看见了」是同一个动作。
   */
  const candidateIds = useMemo(() => candidates.map(candidate => String(candidate.id)), [candidates])
  const { unread: hasUnreadCandidates, markSeen: markCandidatesSeen } = usePendingUnread(
    currentProject?.path ?? null,
    'character-candidates',
    candidateIds,
  )
  useEffect(() => {
    if (!currentProject || !projectSession) return
    void loadCandidates(currentProject.path, projectSession)
  }, [currentProject, projectSession, loadCandidates])

  /**
   * 定稿跑完，自动再看一眼队列。
   *
   * 定稿是后台任务，跑完时角色页往往正开着 —— 不主动刷这一次的话，作者得切走
   * 再切回来才会发现「待确认」按钮冒了出来。先生要的是「入口给在角色页」，
   * 那就不能让他满世界找入口。
   */
  useEffect(() => {
    if (!currentProject || !projectSession) return
    return globalEventBus.on('WORKFLOW_COMPLETE', (payload) => {
      if (payload.type !== 'chapter_creation') return
      if (!isProjectSessionCurrent(projectSession)) return
      void loadCandidates(currentProject.path, projectSession)
    })
  }, [currentProject, projectSession, loadCandidates])

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
      <div className="flex items-center px-3 h-9 flex-shrink-0 border-b border-[var(--color-border)]">
        <span className="text-xs font-medium text-[var(--color-text)] flex items-center gap-0.5 min-w-0">
          <Users size={13} className="flex-shrink-0" />
          <span className="truncate">
            {text(`角色列表（${visibleCharacters.length}）`, `Characters (${visibleCharacters.length})`)}
          </span>
        </span>
        {/*
          先生 2026-09-21：「在角色页给个『待确认』入口，一键采纳即建档、忽略即丢弃。」
          队列为空时这颗按钮不出现 —— 平时它不该在那儿占位置、添噪音；
          定稿后正文里真冒出了新角色，它自己带着数字跳出来。

          先生（本轮报障）：「待选入口在角色管理栏中位置不好，挤压了角色列表这几个字。」
          于是它从右侧那颗「操作按钮组」里搬出来，**紧贴标题右侧**摆成一枚小字入口 ——
          形态照抄便利贴的「待选箱」（StickyNotesGroup 的同名按钮）：
          0.7rem 小字 + 11px 图标 + 数字，鼠标悬停才染朱砂色。
          右侧那一组（导入 / 刷新 / 新建）用 ml-auto 单独靠右，两边不再互相抢宽度。
        */}
        {candidates.length > 0 && (
          <button
            type="button"
            className="relative flex-shrink-0 flex items-center gap-0.5 rounded px-0.5 py-0.5 text-[0.7rem] ml-0.5"
            style={{ color: 'var(--color-text-secondary)' }}
            title={text(
              hasUnreadCandidates
                ? `定稿时在正文里发现、名单里还没有的 ${candidates.length} 名新角色，等你裁决（有新的）`
                : `定稿时在正文里发现、名单里还没有的 ${candidates.length} 名新角色，等你裁决`,
              hasUnreadCandidates
                ? `${candidates.length} new characters found in your finalized prose, pending your review (new)`
                : `${candidates.length} new characters found in your finalized prose, pending your review`,
            )}
            onMouseEnter={event => { event.currentTarget.style.color = 'var(--color-accent)' }}
            onMouseLeave={event => { event.currentTarget.style.color = 'var(--color-text-secondary)' }}
            onClick={() => {
              // 打开即「看过了」：红点与「他确实看见了」是同一个动作（见 pending-badge-store）。
              markCandidatesSeen()
              setShowCandidateReview(true)
            }}
          >
            <UserPlus size={11} />
            {text('待确认', 'Pending')}
            <span className="tabular-nums">{candidates.length}</span>
            {/* 红点绝对定位 —— 这一行在 v3 皮肤下只剩 1px 余量，不能再占宽度 */}
            {hasUnreadCandidates && <PendingDot />}
          </button>
        )}
        {/*
          右侧那一组：导入 / 刷新 / 新建。
          `ml-auto` 把它单独推到最右 —— 于是「入口紧贴标题」与「操作按钮靠右」
          两件事互不干扰，中间多出来的宽度全部落在 auto margin 上。
          v3「时尚杂志」皮肤把侧栏字号整体放大（标题从 64px 长到 79px），
          这一行因此很紧：三个按钮之间不再留 gap（各 24px 的图标按钮本身够宽，
          紧挨着仍好点），把省下的 4px 让给标题。
        */}
        <div className="ml-auto flex items-center gap-0">
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
      <CharacterCandidateReviewDialog
        open={showCandidateReview}
        onClose={() => setShowCandidateReview(false)}
        projectPath={currentProject.path}
        projectSession={projectSession}
      />
    </div>
  )
}
