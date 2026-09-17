/**
 * ProjectTree — 项目导航树（侧边栏核心视图）
 *
 * 包含：小说配置、故事架构、章节蓝图、草稿箱、正文章节、全局摘要
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import type { ReactNode } from 'react'
import { ChevronRight, ChevronDown, RefreshCw, CheckCircle2, Circle, FolderOpen, Copy, FolderTree, Trash2 } from 'lucide-react'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { useDraftStore } from '../../../stores/draft-store'
import { useEditorStore } from '../../../stores/editor-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { ipc } from '../../../services/ipc-client'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { confirm } from '../../ui/Confirm'
import { toast } from '../../ui/Toast'
import ClearProjectDataDialog from '../../dialogs/ClearProjectDataDialog'



import { LeafItem } from './SidebarShared'
import { ARCH_FILES } from './sidebar-arch-files'
import {
  confirmCurrentProjectSession,
  openArchFile,
  openBuiltinEditor,
} from './sidebar-file-openers'
import { renderIcon } from './sidebar-icons'
import { showSidebarMenu } from './sidebar-menu'
import { createProjectArchTabId } from '../../editor/arch-file-refresh-policy'
import DraftBoxGroup from './DraftBoxGroup'
import ManuscriptGroup from './ManuscriptGroup'
import { useLocaleStore } from '../../../stores/locale-store'
import { useUiVersionStore, isModernShell } from '../../../stores/ui-version-store'
import { LatestRequestGate } from '../../editor/latest-request-gate'
import { beginProjectTreeIdentityTransition } from './project-tree-refresh-policy'
import {
  captureProjectSession,
  isProjectSessionCurrent,
} from '../../project-session-gate'
import { globalEventBus } from '../../../shared/event-bus'
import { shouldRefreshBlueprints } from '../../editor/blueprint-refresh'

const ARCH_FILE_EN: Record<string, { label: string; desc: string }> = {
  premise: { label: 'Premise', desc: 'Core premise and conflict' },
  characters: { label: 'Character map', desc: 'Character arcs and relationships' },
  worldbuilding: { label: 'World building', desc: 'World rules and systems' },
  synopsis: { label: 'Plot synopsis', desc: 'Overall plot structure' },
}

/** 小说之旅的三个阶段状态：绿=已完成，橙=进行中，红=未完成。 */
type JourneyState = 'done' | 'active' | 'pending'

const JOURNEY_DOT_COLOR: Record<JourneyState, string> = {
  done: 'var(--color-success)',
  active: 'var(--color-warning)',
  pending: 'var(--color-error)',
}

/**
 * 「小说之旅」的一步：标题行左前方紧贴着的一颗三色小球，外加连到下一步的虚线。
 *
 * 三个小球自上而下连成一条轨道，暗示「把这三步从上到下走完，才能开始小说之旅」：
 *   · 绿 —— 这一阶段该有的内容已经齐了；
 *   · 橙 —— 正在做（已有进展，或对应的工作流正在跑）；
 *   · 红 —— 还没开始。
 *
 * 定位全部用绝对定位、不占布局：标题行本身带左右外边距（v2 皮肤 7px / 经典 8px）
 * 与 10px 左内边距，球就压在左内边距里、贴着整行标题，行一个字都不会被推走。
 * 「故事架构」那行的 12px 行首槽里是折叠箭头，所以球不能放进那个槽，只能贴左边距。
 * 小球带 data-journey-state、虚线带 data-journey-link，方便用例直接断言。
 */
function JourneyStep({
  state,
  label,
  connect,
  tourId,
  children,
}: {
  state: JourneyState
  label: string
  /** 是否向下画连接虚线；最后一步不画。 */
  connect: boolean
  /** 新手引导的指向标记（data-tour），让引导能把这一步框出来。 */
  tourId?: string
  children: ReactNode
}) {
  const text = useLocaleStore(s => s.text)
  const isV2 = useUiVersionStore(s => isModernShell(s.uiVersion))
  // .tree-item 的实际盒模型：现代外壳 height 31px / margin 0 7px；经典 height 28px / margin 1px 8px。
  // 这里的数值必须与 CSS 保持一致（杂志版也只改字号与圆角，不改行高）。
  const rowHeight = isV2 ? 31 : 28
  const rowInset = isV2 ? 7 : 8
  const dotSize = 7
  const dotLeft = rowInset + 2
  const dotTop = Math.round((rowHeight - dotSize) / 2)
  const lineLeft = dotLeft + Math.floor(dotSize / 2)
  const stateLabel = state === 'done'
    ? text('已完成', 'Complete')
    : state === 'active'
      ? text('进行中', 'In progress')
      : text('未完成', 'Not started')
  return (
    // 定位基准用内联样式：Tailwind 的 .relative 依赖样式表加载，而这里的球与虚线
    // 必须无条件相对本行定位，否则会跑到侧栏外面去（连线也就看不见了）。
    <div style={{ position: 'relative' }} data-tour={tourId}>
      {connect && (
        <span
          aria-hidden
          data-journey-link
          style={{
            position: 'absolute',
            left: lineLeft,
            top: dotTop + dotSize + 2,
            // 负值把虚线带过容器底部，正好接到下一步小球的上沿。
            bottom: -dotTop,
            width: 1,
            // 用重复渐变画虚线：dash 长度与间隔可控，颜色取比边框更深的弱化文字色，
            // 在浅米纸底上也能看清（纯 border dashed 在 v2 底下几乎看不见）。
            background: 'repeating-linear-gradient(to bottom, var(--color-text-muted, #8F8876) 0 3px, transparent 3px 7px)',
            opacity: 0.5,
          }}
        />
      )}
      <span
        aria-hidden
        data-journey-state={state}
        title={`${label} · ${stateLabel}`}
        style={{
          position: 'absolute',
          left: dotLeft,
          top: dotTop,
          width: dotSize,
          height: dotSize,
          borderRadius: '50%',
          background: JOURNEY_DOT_COLOR[state],
          // 让小球压在虚线上时中间留一圈底色，看起来是「节点串在线上」。
          boxShadow: '0 0 0 2px var(--color-sidebar, var(--color-bg))',
          zIndex: 1,
        }}
      />
      {children}
    </div>
  )
}

export default function ProjectTree() {
  const currentProject = useProjectStore(s => s.currentProject)
  const projectSessionEpoch = useProjectStore(s => s.projectSessionEpoch)
  const text = useLocaleStore(s => s.text)

  // refreshFileTree / loadAllDrafts 在 refreshAll 内通过 getState() 调用
  // 只订阅 activeRuns
  const activeRuns = useWorkflowStore(s => s.activeRuns)
  /** 某类工作流是否正在跑 —— 用来把对应阶段点亮成橙色「进行中」。 */
  const isTypeRunning = useWorkflowStore(s => s.isTypeRunning)
  // 精确订阅，避免 loadAllDrafts 执行后引用变化触发 useCallback/useEffect 循环
  const draftsByChapter = useDraftStore(s => s.draftsByChapter)

  // 存储各架构文件是否有实际内容（已生成）
  const [archStatus, setArchStatus] = useState<Record<string, boolean>>({})
  // 章节蓝图数量
  const [blueprintCount, setBlueprintCount] = useState<number>(-1)
  const [refreshing, setRefreshing] = useState(false)
  const [clearDialogOpen, setClearDialogOpen] = useState(false)
  const refreshRequestGate = useRef(new LatestRequestGate())

  /** 统一刷新：文件树 + 架构状态 + 草稿列表 + 蓝图数量 */
  // 用 getState() 获取最新的 action，不作为依赖项，避免重建导致 useEffect 循环
  const refreshAll = useCallback(async () => {
    const projectState = useProjectStore.getState()
    const projectSession = captureProjectSession(projectState.currentProject)
    const projectPath = projectSession?.projectPath
    const expectedProjectSessionEpoch = projectState.projectSessionEpoch
    if (!projectPath || !projectSession) {
      refreshRequestGate.current.begin()
      return
    }
    const requestId = refreshRequestGate.current.begin()
    setRefreshing(true)
    try {
      // 通过服务层获取架构状态和蓝图数量（避免直接进行进程通信）
      const { checkArchStatus, getBlueprintCount } = await import('../../../services/architecture-service')
      const [, , status, count] = await Promise.all([
        useProjectStore.getState().refreshFileTree(projectPath, expectedProjectSessionEpoch, projectSession),
        useDraftStore.getState().loadAllDrafts(projectPath, projectSession),
        checkArchStatus(projectSession),
        getBlueprintCount(projectSession),
      ])
      if (
        !refreshRequestGate.current.isLatest(requestId)
        || !isProjectSessionCurrent(projectSession)
        || useProjectStore.getState().projectSessionEpoch !== expectedProjectSessionEpoch
      ) return
      setArchStatus(status)
      setBlueprintCount(count)
    } catch (error) {
      if (
        refreshRequestGate.current.isLatest(requestId)
        && isProjectSessionCurrent(projectSession)
        && useProjectStore.getState().projectSessionEpoch === expectedProjectSessionEpoch
      ) {
        toast.error(text(
          `项目资源刷新失败：${String(error)}`,
          `Could not refresh project resources: ${String(error)}`,
        ))
      }
    } finally {
      if (refreshRequestGate.current.isLatest(requestId)) setRefreshing(false)
    }
  }, [text])

  // 项目切换时刷新
  useEffect(() => {
    const transition = beginProjectTreeIdentityTransition(
      refreshRequestGate.current,
      currentProject?.path,
      projectSessionEpoch,
    )
    if (!transition.hasProject) {
      queueMicrotask(() => {
        if (
          refreshRequestGate.current.isLatest(transition.requestId)
          && !useProjectStore.getState().currentProject
        ) {
          setArchStatus({})
          setBlueprintCount(-1)
          setRefreshing(false)
          setClearDialogOpen(false)
        }
      })
      return
    }
    const projectPath = currentProject!.path
    queueMicrotask(() => {
      if (
        !refreshRequestGate.current.isLatest(transition.requestId)
        || useProjectStore.getState().currentProject?.path !== projectPath
        || useProjectStore.getState().projectSessionEpoch !== transition.projectSessionEpoch
      ) return
      void refreshAll()
    })
  }, [currentProject?.path, projectSessionEpoch, refreshAll]) // eslint-disable-line react-hooks/exhaustive-deps -- currentProject 对象引用变化不每次都需重跑

  useEffect(() => globalEventBus.on('ARCH_FILE_UPDATED', (payload) => {
    if (!isProjectSessionCurrent(payload.projectSession)) return
    void refreshAll()
  }), [refreshAll])

  useEffect(() => globalEventBus.on('REFRESH_RESOURCE', (payload) => {
    if (!isProjectSessionCurrent(payload.projectSession)) return
    if (!shouldRefreshBlueprints(payload.resources)) return
    void refreshAll()
  }), [refreshAll])

  // 工作流步骤状态或整体状态变化时刷新侧边栏（适配多任务）
  // 合并为单一 effect + 防抖，避免一次步骤完成同时触发多次刷新
  const workflowKey = activeRuns.map(r => `${r.id}:${r.status}|${r.steps.map(s => s.status).join(',')}`).join(';')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!currentProject) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      refreshAll()
    }, 80)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
    // 依赖 path 字符串而非 currentProject 对象引用
    //    避免 updateNovelConfig 改变对象引用后触发不必要的 refreshAll
  }, [workflowKey, currentProject?.path, refreshAll]) // eslint-disable-line react-hooks/exhaustive-deps -- currentProject 对象引用变化不触发，仅 path 变化需响应

  if (!currentProject) {
    return (
      <div className="writer-project-tree h-full">
        <EmptyState
          icon={<span className="text-4xl opacity-60" style={{ color: 'var(--color-text-muted)' }}><FolderOpen size={36} /></span>}
          message={text('未打开项目', 'No project open')}
          className="p-4 pb-[15vh]"
          opacity={1}
        >
          <span
            className="text-xs text-center mt-0.5"
            style={{ color: 'var(--color-text-muted)' }}
          >
            {text('新建或打开一个小说项目开始创作', 'Create or open a novel project to begin.')}
          </span>
          {/* 操作按钮 */}
          <div className="flex flex-col gap-2 mt-3 w-full">
            <Button
              variant="default"
              className="w-full"
              onClick={() => useLayoutStore.getState().openNewProject()}
            >
              {text('新建项目', 'New project')}
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={async () => {
                const folder = await ipc.invoke('dialog:select-folder')
                if (folder) {
                  useProjectStore.getState().openProject(folder)
                }
              }}
            >
              {text('打开项目', 'Open project')}
            </Button>
          </div>
        </EmptyState>
      </div>
    )
  }

  const p = currentProject.path
  // 改为彻底的数据驱动：从内存的全部草稿中提取 status='finalized' 的草稿
  const manuscriptFiles = Object.values(draftsByChapter)
    .map(drafts => drafts.find(d => d.status === 'finalized'))
    .filter(Boolean)
    .sort((a, b) => a!.chapterNumber - b!.chapterNumber)
    .map(draft => ({
      path: `vela://manuscript/${draft!.id}`, // 诸如 vela://manuscript/42
      name: `chapter_${draft!.chapterNumber}.md`, // 提供格式化的伪文件名供组件适配解析
      isDir: false,
      chapterTitle: draft!.chapterTitle,
    }))

  // 小说配置是否已完成（核心大纲非空视为已完成）
  const nc = currentProject.novelConfig
  const configDone = !!(nc.coreOutline?.trim() || nc.protagonistProfile?.trim())

  // 故事架构进度
  const archDone = ARCH_FILES.filter(f => archStatus[f.key]).length

  /**
   * 「小说之旅」三步的状态：配置 → 架构 → 蓝图。
   *
   * 判定只看内容有没有做出来，再加上「对应工作流是否正在跑」：
   * 内容齐了是绿，有进展或在跑是橙，什么都没有是红。
   * 三步都绿，作者就有了开写所需的全部底稿。
   */
  const journeyText = text(
    '把这三步从上到下走完，就可以开始小说之旅了',
    'Finish these three steps from top to bottom to begin your novel journey',
  )
  const newProjectSetupRunning = isTypeRunning('new_project_setup')
  const configRunning = newProjectSetupRunning || isTypeRunning('config_generation')
  const archRunning = newProjectSetupRunning || isTypeRunning('architecture_generation')
  const blueprintRunning = newProjectSetupRunning || isTypeRunning('directory')
  // 配置：核心大纲 / 主角设定 / 世界观 / 金手指 / 全局指导里有任意一项填过，就算开了个头。
  const configStarted = Boolean(
    nc.coreOutline?.trim()
    || nc.protagonistProfile?.trim()
    || nc.worldSetting?.trim()
    || nc.goldenFinger?.trim()
    || nc.globalGuidance?.trim(),
  )
  const configState: JourneyState = configDone
    ? 'done'
    : (configStarted || configRunning) ? 'active' : 'pending'
  const archState: JourneyState = archDone >= ARCH_FILES.length
    ? 'done'
    : (archDone > 0 || archRunning) ? 'active' : 'pending'
  const totalChapters = Math.max(0, Number(nc.totalChapters) || 0)
  const blueprintState: JourneyState = totalChapters > 0 && blueprintCount >= totalChapters
    ? 'done'
    : (blueprintCount > 0 || blueprintRunning) ? 'active' : 'pending'
  const clearDisabled = activeRuns.length > 0
  const openConfigEditor = () => useEditorStore.getState().openFile({
    id: 'config',
    name: text('小说配置', 'Novel configuration'),
    type: 'config',
    projectKey: currentProject.path,
  })

  return (
    <div className="writer-project-tree min-h-full text-sm py-1">
      {/* 项目名 + 刷新 */}
      <div className="flex items-center justify-between gap-1 px-3 py-1.5 mb-0.5">
        <span className="font-semibold text-xs truncate" style={{ color: 'var(--color-text)' }}>
          {currentProject.name}
        </span>
        <div className="flex flex-shrink-0 items-center gap-0.5">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setClearDialogOpen(true)}
            disabled={clearDisabled}
            title={clearDisabled
              ? text('工作流运行中，暂不能清除', 'A workflow is running. Project data cannot be cleared yet.')
              : text('清除项目生成内容', 'Clear generated project data')}
          >
            <Trash2 size={12} />
            {text('清除全部', 'Clear all')}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => { void refreshAll() }}
            title={text('刷新', 'Refresh')}
            disabled={refreshing}
          >
            <RefreshCw size={12} />
          </Button>
        </div>
      </div>

      <ClearProjectDataDialog
        open={clearDialogOpen}
        onClose={() => setClearDialogOpen(false)}
        onCleared={refreshAll}
      />

      {/* ===== 小说之旅：配置 → 架构 → 蓝图，三色小球自上而下连成一条轨道 ===== */}
      <div title={journeyText}>
      {/* 1. 小说配置 */}
      <JourneyStep state={configState} label={text('小说配置', 'Novel configuration')} connect tourId="journey-config">
      <LeafItem
        iconName="book-open"
        label={text('小说配置', 'Novel configuration')}
        emphasize
        desc={text('基础参数与写作要求', 'Core parameters and writing guidance')}
        badge={configDone ? text('已完成', 'Complete') : text('待配置', 'Pending')}
        badgeDone={configDone}
        onClick={openConfigEditor}
        onContextMenu={e => showSidebarMenu([
          {
            key: 'open',
            label: text('打开小说配置', 'Open novel configuration'),
            icon: <FolderOpen size={13} />,
            onClick: openConfigEditor,
          },
        ], e)}
      />
      </JourneyStep>

      {/* 2. 故事架构 — 点击标题行打开编辑器，子文件仍可单独点开 */}
      <JourneyStep state={archState} label={text('故事架构', 'Story architecture')} connect tourId="journey-arch">
      <WorldBuildingGroup archStatus={archStatus} archDone={archDone} onCleared={refreshAll} />
      </JourneyStep>

      {/* 3. 章节蓝图 — 点击打开编辑器页 */}
      <JourneyStep state={blueprintState} label={text('章节蓝图', 'Chapter blueprints')} connect={false} tourId="journey-blueprint">
      <LeafItem
        iconName="layout-list"
        label={text('章节蓝图', 'Chapter blueprints')}
        emphasize
        desc={text('AI 生成的章节目录，可编辑', 'Editable AI-generated chapter plans')}
        badge={blueprintCount > 0 ? text(`${blueprintCount}/${nc.totalChapters} 章`, `${blueprintCount}/${nc.totalChapters} chapters`) : text('待生成', 'Pending')}
        badgeColor={
          blueprintCount >= nc.totalChapters
            ? 'var(--color-success-text)'
            : blueprintCount > 0
              ? 'var(--color-warning-text, #7A5414)'
              : undefined
        }
        badgeDone={blueprintCount >= nc.totalChapters}
        onClick={() => openBuiltinEditor('chapter-card-editor', text('章节蓝图', 'Chapter blueprints'), 'chapter-card')}
        onContextMenu={e => showSidebarMenu([
          {
            key: 'open',
            label: text('打开章节蓝图', 'Open chapter blueprints'),
            icon: <FolderOpen size={13} />,
            onClick: () => openBuiltinEditor('chapter-card-editor', text('章节蓝图', 'Chapter blueprints'), 'chapter-card'),
          },
        ], e)}
      />
      </JourneyStep>
      </div>

      <LeafItem
        iconName="git-branch"
        label={text('伏笔', 'Foreshadowing')}
        desc={text('规划埋设/回收章节，自动注入写作并提示逾期', 'Plan setup/payoff chapters, inject active threads, and flag overdue ones')}
        onClick={() => openBuiltinEditor('narrative-thread-editor', text('伏笔', 'Foreshadowing'), 'narrative-thread')}
      />

      {/* 4. 草稿箱 — 独立分区，按章节分组展示草稿 */}
      <DraftBoxGroup draftsByChapter={draftsByChapter} />

      {/* 5. 正文章节 — 仅显示已定稿 */}
      <ManuscriptGroup files={manuscriptFiles} projectPath={p} />
    </div>
  )
}


// ===== 故事架构折叠组 =====

function WorldBuildingGroup({
  archStatus,
  archDone,
  onCleared,
}: {
  archStatus: Record<string, boolean>
  archDone: number
  onCleared: () => void | Promise<void>
}) {
  const [open, setOpen] = useState(true)
  const text = useLocaleStore(s => s.text)

  const allDone = archDone === ARCH_FILES.length

  return (
    <div>
      {/* 组标题行 — 点击打开故事架构编辑器，双击展开/折叠子文件 */}
      <div
        className="tree-item gap-1.5 cursor-pointer select-none"
        style={{ paddingLeft: 10 }}
        onClick={() => openBuiltinEditor('world-building-editor', text('故事架构', 'Story architecture'), 'world-building')}
        title={text('打开故事架构编辑器（可生成架构文档）', 'Open the story architecture editor')}
      >
        <span
          style={{ width: 12, flexShrink: 0, display: 'flex', alignItems: 'center', cursor: 'pointer' }}
          onClick={(e) => { e.stopPropagation(); setOpen(v => !v) }}
        >
          {open
            ? <ChevronDown size={12} style={{ color: 'var(--color-text-muted)' }} />
            : <ChevronRight size={12} style={{ color: 'var(--color-text-muted)' }} />
          }
        </span>
        <FolderTree size={14} style={{ color: 'var(--color-text-muted)' }} />
        {/* 先生：主标题 14.5px / 字重 550（之前 15px+600 太黑太粗） */}
        <span className="text-[14px] flex-1 min-w-0 truncate" style={{ color: 'var(--color-text)', fontWeight: 550 }}>{text('故事架构', 'Story architecture')}</span>
        {/* 进度徽章 */}
        <span
          className="text-[0.7rem] flex-shrink-0 ml-1"
          style={{
            color: allDone
              ? 'var(--color-success-text)'
              : archDone > 0
                ? 'var(--color-warning-text, #7A5414)'
                : 'var(--color-text-muted)'
          }}
        >
          {archDone}/{ARCH_FILES.length}
        </span>
      </div>

      {/* 子文件列表（点击直接在 Markdown 编辑器打开） */}
      {open && (
        <div>
          {ARCH_FILES.map(f => {
            const isGenerated = archStatus[f.key]
            const filePath = `vela://core/${f.key}`
            return (
              <ArchFileRow
                key={f.key}
                f={f}
                filePath={filePath}
                isGenerated={isGenerated}
                onCleared={onCleared}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

/** 单个架构文件行 */
function ArchFileRow({
  f,
  filePath,
  isGenerated,
  onCleared,
}: {
  f: { key: string; iconName: string; label: string; desc: string }
  filePath: string
  isGenerated: boolean
  onCleared: () => void | Promise<void>
}) {
  const text = useLocaleStore(s => s.text)
  const english = ARCH_FILE_EN[f.key] ?? { label: f.label, desc: f.desc }
  const label = text(f.label, english.label)
  const isCharacterProjection = f.key === 'characters'
  const clearArchFile = async () => {
    if (isCharacterProjection) return
    const projectSession = await confirmCurrentProjectSession(
      useProjectStore.getState().currentProject,
      () => confirm(text(`确认清空「${f.label}」内容？\n此操作会删除该项故事架构文本，不影响其他架构项、蓝图或正文。`, `Clear “${english.label}”?\nThis removes only this architecture section and preserves the other sections, blueprints, and manuscript.`), {
        title: text('清空故事架构项', 'Clear architecture section'),
        confirmText: text('清空', 'Clear'),
        danger: true,
      }),
    )
    if (!projectSession) return
    const projectKey = projectSession.projectPath

    const { writeCoreContent } = await import('../../../services/vela-protocol')
    const success = await writeCoreContent(filePath, '', projectSession)
    if (!isProjectSessionCurrent(projectSession)) return
    if (!success) {
      toast.error(text(`清空「${f.label}」失败`, `Could not clear “${english.label}”`))
      return
    }

    const store = useEditorStore.getState()
    const tabId = createProjectArchTabId(projectKey, filePath)
    store.syncTabContent(tabId, '')
    store.markTabSaved(tabId, '')
    await onCleared()
    if (!isProjectSessionCurrent(projectSession)) return
    toast.success(text(`已清空「${f.label}」`, `Cleared “${english.label}”`))
  }

  return (
    <div
      className="tree-item gap-1.5 cursor-pointer select-none"
      style={{ paddingLeft: 26 }}
      onClick={() => openArchFile(filePath, label)}
      onContextMenu={e => showSidebarMenu([
        {
          key: 'open',
          label: text('打开文件', 'Open file'),
          icon: <FolderOpen size={13} />,
          onClick: () => openArchFile(filePath, label),
        },
        { key: 'div1', type: 'divider' as const },
        {
          key: 'copy-path',
          label: text('复制文件路径', 'Copy file path'),
          icon: <Copy size={13} />,
          onClick: () => navigator.clipboard.writeText(filePath).catch(() => { }),
        },
        ...(isCharacterProjection ? [] : [
          { key: 'div2', type: 'divider' as const },
          {
            key: 'delete',
            label: text(`清空${f.label}`, `Clear ${english.label}`),
            icon: <Trash2 size={13} />,
            danger: true,
            disabled: !isGenerated,
            onClick: clearArchFile,
          },
        ]),
      ], e)}
      title={text(f.desc, english.desc)}
    >
      {isGenerated
        ? <CheckCircle2 size={10} style={{ flexShrink: 0, color: 'var(--color-success)' }} />
        : <Circle size={6} style={{ flexShrink: 0, fill: 'transparent', stroke: 'var(--color-text-muted)' }} />
      }
      <span className="flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>{renderIcon(f.iconName, 13)}</span>
      <span
        className="text-sm flex-1 truncate"
        style={{ color: isGenerated ? 'var(--color-text)' : 'var(--color-text-secondary)' }}
      >
        {label}
      </span>
      {!isGenerated && (
        <span className="text-[0.7rem] flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
          {text('待生成', 'Pending')}
        </span>
      )}
      {isGenerated && !isCharacterProjection && (
        <button
          type="button"
          className="opacity-70 hover:opacity-100 rounded p-0.5"
          title={text(`清空${f.label}`, `Clear ${english.label}`)}
          onClick={(e) => {
            e.stopPropagation()
            clearArchFile()
          }}
          style={{ color: 'var(--color-text-muted)' }}
        >
          <Trash2 size={11} />
        </button>
      )}
    </div>
  )
}
