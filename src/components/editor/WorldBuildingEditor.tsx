import { useState, useEffect, useCallback, useRef } from 'react'
import { Sparkles, CheckCircle2, Circle, RefreshCw, BookOpen, AlertTriangle, FolderTree } from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import { useLocaleStore } from '../../stores/locale-store'
import { renderIcon } from '../panels/sidebar/sidebar-icons'

import ArchitectureConfirmDialog from '../dialogs/ArchitectureConfirmDialog'

import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import PagePlate from '../layout/v2/magazine/PagePlate'
import { PlateChecks, PlateFigure } from '../layout/v2/magazine/PlateFigures'
import { ipc } from '../../services/ipc-client'

import { launchCreativeWorkflow } from '../../services/workflows/creative-workflow-launcher'
import { globalEventBus } from '../../shared/event-bus'
import {
  createProjectArchTabId,
  shouldRefreshArchOnWorkflowComplete,
  shouldSyncProjectArchTab,
} from './arch-file-refresh-policy'
import { LatestRequestGate } from './latest-request-gate'
import {
  canExplicitlyRepairCharacterRoster,
  getCharacterRosterRepairPresentation,
} from './character-roster-repair-state'
import { useCharacterRosterRepair } from './use-character-roster-repair'
import {
  captureProjectSession,
  isProjectSessionCurrent,
  isProjectSessionPath,
} from '../project-session-gate'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { sameProjectSessionContext } from '../../shared/project-session-context'
import {
  hasVisiblePartialSynopsisMarker,
  isRecoverableSynopsisCheckpoint,
  isUsableSynopsisCheckpoint,
} from '../../services/workflows/commands/architecture.command'

type ArchStepKey = 'premise' | 'characters' | 'worldbuilding' | 'synopsis'

const ARCH_FILES: Array<{
  key: ArchStepKey
  fileName: string
  labelZh: string
  labelEn: string
  iconName: string
  descZh: string
  descEn: string
}> = [
    { key: 'premise', fileName: 'premise.md', labelZh: '故事前提', labelEn: 'Story premise', iconName: 'target', descZh: '故事钩子 · 核心冲突链 · 主角优势 · 悬念骨架', descEn: 'Story hook · core conflict · protagonist edge · suspense structure' },
    { key: 'characters', fileName: 'characters.md', labelZh: '角色图谱', labelEn: 'Character map', iconName: 'users', descZh: '角色弧光 · 关系网络 · 矛盾交织', descEn: 'Character arcs · relationships · interlocking tensions' },
    { key: 'worldbuilding', fileName: 'worldbuilding.md', labelZh: '世界观', labelEn: 'Worldbuilding', iconName: 'globe', descZh: '核心规则 · 社会结构 · 深层危机', descEn: 'Core rules · social structure · underlying crisis' },
    { key: 'synopsis', fileName: 'synopsis.md', labelZh: '情节大纲', labelEn: 'Plot outline', iconName: 'map', descZh: '结构推进 · 转折节奏 · 伏笔闭环', descEn: 'Story progression · turning points · setup and payoff' },
  ]

/** 续批按钮默认的每批章数上限（可在弹窗内调整，避免一次请求剩余全部章节）。 */
const CONTINUATION_BATCH_SPAN = 20

/** 故事架构编辑器 — 显示四个架构文件状态，并提供 AI 生成入口 */
export default function WorldBuildingEditor({ projectKey }: { projectKey: string }) {
  // ✅ 精确订阅，避免 novelConfig 等变化导致不必要的 loadStatus 重建
  const currentProject = useProjectStore(s => s.currentProject)
  const text = useLocaleStore(s => s.text)
  const projectMatches = currentProject?.path === projectKey
  const [archStatus, setArchStatus] = useState<Record<string, boolean>>({})
  const [wordCounts, setWordCounts] = useState<Record<string, number>>({})
  const [synopsisIncomplete, setSynopsisIncomplete] = useState(false)
  const [synopsisRecoveryFailed, setSynopsisRecoveryFailed] = useState(false)
  const [synopsisCoveredTo, setSynopsisCoveredTo] = useState<number>(0)
  const [synopsisTotalChapters, setSynopsisTotalChapters] = useState<number>(0)
  const [synopsisBusy, setSynopsisBusy] = useState(false)
  const [pendingSynopsisRange, setPendingSynopsisRange] = useState<{ from: number; to: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [showArchDialog, setShowArchDialog] = useState(false)
  const lastCompletedArchitectureRunRef = useRef<string | null>(null)
  const archStatusRequestGate = useRef(new LatestRequestGate())
  const {
    snapshot: rosterSnapshot,
    repairError: rosterRepairError,
    isRepairing: extracting,
    refresh: loadCharacterRosterStatus,
    migrate: handleRepairCharacterRoster,
  } = useCharacterRosterRepair({ projectKey, enabled: projectMatches })

  /** 加载各架构文件状态（通过 Service 层获取，不直接调 IPC） */
  const loadStatus = useCallback(async () => {
    await Promise.resolve()
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) {
      archStatusRequestGate.current.begin()
      setArchStatus({})
      setWordCounts({})
      setSynopsisIncomplete(false)
      setSynopsisRecoveryFailed(false)
      setSynopsisCoveredTo(0)
      setSynopsisTotalChapters(0)
      setLoading(false)
      return
    }
    const projectPath = projectSession.projectPath
    const requestId = archStatusRequestGate.current.begin()
    setLoading(true)
    const core = await ipc.invokeWithProjectSession(
      projectSession,
      'db:project-core-get',
      projectPath,
    )
    // 情节大纲状态：中断可断点续写；或部分覆盖可分批续写（covered_to < total）
    let interrupted = false
    let recoveryFailed = false
    let coveredTo = 0
    const dbSynopsis = core?.synopsis || ''
    const totalChapters = Number(core?.totalChapters ?? currentProject?.novelConfig?.totalChapters) || 0
    const writingLanguage = (core?.writingLanguage ?? currentProject?.novelConfig?.writingLanguage) === 'en-US'
      ? 'en-US'
      : 'zh-CN'
    const visiblyPartial = hasVisiblePartialSynopsisMarker(dbSynopsis)
    try {
      const partialResult = await ipc.invokeWithProjectSession(
        projectSession,
        'fs:read-json',
        `${projectPath}/.vela/partial_arch.json`,
        projectPath,
      )
      const partial = partialResult?.success === true
        ? (partialResult as { data?: Record<string, unknown> }).data
        : undefined
      const checkpointUsable = isUsableSynopsisCheckpoint(
        partial,
        dbSynopsis,
        writingLanguage,
        totalChapters,
      )
      interrupted = checkpointUsable && isRecoverableSynopsisCheckpoint(
        partial,
        dbSynopsis,
        writingLanguage,
        totalChapters,
      )
      recoveryFailed = visiblyPartial && !checkpointUsable
      coveredTo = checkpointUsable && Number(partial?.synopsis_covered_to) > 0
        ? Number(partial?.synopsis_covered_to)
        : 0
    } catch {
      interrupted = false
      recoveryFailed = visiblyPartial
      coveredTo = 0
    }
    const status: Record<string, boolean> = {
      premise: (core?.premise?.length ?? 0) > 50,
      characters: rosterSnapshot?.status === 'ready',
      worldbuilding: (core?.worldbuilding?.length ?? 0) > 50,
      synopsis: (core?.synopsis?.length ?? 0) > 50,
    }
    const counts: Record<string, number> = {
      premise: status.premise ? (core?.premise?.length ?? 0) : 0,
      characters: status.characters ? (rosterSnapshot?.renderedMarkdown.length ?? 0) : 0,
      worldbuilding: status.worldbuilding ? (core?.worldbuilding?.length ?? 0) : 0,
      synopsis: status.synopsis ? (core?.synopsis?.length ?? 0) : 0,
    }
    if (
      !archStatusRequestGate.current.isLatest(requestId)
      || !isProjectSessionCurrent(projectSession)
    ) return
    setArchStatus(status)
    setWordCounts(counts)
    setSynopsisIncomplete(interrupted && Boolean(status.synopsis))
    setSynopsisRecoveryFailed(recoveryFailed && Boolean(status.synopsis))
    setSynopsisCoveredTo(coveredTo)
    setSynopsisTotalChapters(totalChapters)
    setLoading(false)
    // ✅ 只依赖 path 字符串，避免 novelConfig 等变化导致 loadStatus 重建
  }, [currentProject, projectKey, projectMatches, rosterSnapshot])

  useEffect(() => {
    const timer = setTimeout(() => { void loadStatus() }, 0)
    return () => clearTimeout(timer)
  }, [loadStatus])

  // 监听 EventBus 事件，刷新后处理状态面板
  useEffect(() => {
    const eventMatchesProjectRun = (payload: {
      projectSession: ProjectSessionContext
      runId: string
    }) =>
      (() => {
        const projectSession = captureProjectSession(currentProject)
        return !!projectSession
          && isProjectSessionCurrent(projectSession)
          && sameProjectSessionContext(projectSession, payload.projectSession)
      })()
      && payload.runId.length > 0
    // 每步架构文件写完后实时刷新状态
    const unsub3 = globalEventBus.on('ARCH_FILE_UPDATED', (payload) => {
      if (!eventMatchesProjectRun(payload)) return
      loadStatus()
      loadCharacterRosterStatus()
    })
    // 整个工作流完成后也刷新一次
    const unsub4 = globalEventBus.on('WORKFLOW_COMPLETE', (payload) => {
      const projectSession = captureProjectSession(currentProject)
      if (!projectSession || !isProjectSessionCurrent(projectSession)) return
      if (!shouldRefreshArchOnWorkflowComplete(
        payload,
        projectSession,
        lastCompletedArchitectureRunRef.current,
      )) return
      lastCompletedArchitectureRunRef.current = payload.runId
      loadStatus()
      loadCharacterRosterStatus()
    })
    return () => { unsub3(); unsub4() }
  }, [currentProject, loadCharacterRosterStatus, loadStatus, projectKey])

  /** 打开单个架构文件（arch-file 类型；若 tab 已存在则刷新磁盘内容） */
  const openArchFile = async (f: typeof ARCH_FILES[number]) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    const filePath = `vela://core/${f.key}`
    const tabId = createProjectArchTabId(projectKey, filePath)
    let content = ''
    try {
      if (f.key === 'characters') {
        const roster = await loadCharacterRosterStatus()
        if (!roster) return
        content = roster.status === 'ready'
          ? roster.renderedMarkdown
          : roster.legacyMarkdown ?? ''
      } else {
        const core = (await ipc.invokeWithProjectSession(
          projectSession,
          'db:project-core-get',
          projectSession.projectPath,
        )) as Record<string, unknown> | null
        content = (core?.[f.key] as string) || ''
      }
    } catch {
      return
    }
    if (!isProjectSessionCurrent(projectSession)) return

    const { useEditorStore } = await import('../../stores/editor-store')
    if (!isProjectSessionCurrent(projectSession)) return
    const store = useEditorStore.getState()
    const existingTab = store.tabs.find(t => t.id === tabId)
    if (existingTab) {
      store.setActiveTab(tabId)
      if (shouldSyncProjectArchTab(existingTab, projectKey)) {
        store.syncTabContent(tabId, content)
        store.markTabSaved(tabId, content)
      }
    } else {
      store.openFile({
        id: tabId,
        name: text(f.labelZh, f.labelEn),
        type: 'arch-file',
        filePath,
        content,
        savedContent: content,
        projectKey,
      })
    }
  }

  /** 确认后启动架构工作流 */
  const handleConfirm = async (
    selectedSteps: ArchStepKey[],
    stepGuidance: Record<string, string>,
    synopsisRange?: { from: number; to: number },
  ) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) throw new Error(text('项目会话已切换，未启动架构生成', 'The project session changed, so architecture generation was not started.'))
    if (!isProjectSessionCurrent(projectSession)) throw new Error(text('项目会话已切换，未启动架构生成', 'The project session changed, so architecture generation was not started.'))
    await launchCreativeWorkflow({
      workflow: 'generate_architecture',
      selectedSteps,
      stepGuidance,
      synopsisRange,
    }, projectSession)
  }

  /** 从上次输出长度中断的检查点继续生成情节大纲（断点续写当前批） */
  const handleResumeSynopsis = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    if (!isProjectSessionCurrent(projectSession) || synopsisBusy) return
    setSynopsisBusy(true)
    try {
      await launchCreativeWorkflow({
        workflow: 'generate_architecture',
        selectedSteps: ['synopsis'],
        resumeSynopsis: true,
      }, projectSession)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const { toast } = await import('../ui/Toast')
      toast.error(text(`续写启动失败：${detail}`, `Failed to start the continuation: ${detail}`))
    } finally {
      setSynopsisBusy(false)
    }
  }

  /** 续批入口：打开生成弹窗并预填下一批范围（从 coveredTo+1 起，默认带本批上限，
   * 上限可在弹窗内调整）。避免一次请求剩余全部章节再次触发超长输出。 */
  const handleContinueOutlineBatch = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    if (!isProjectSessionCurrent(projectSession)) return
    const from = synopsisCoveredTo + 1
    if (from > synopsisTotalChapters || synopsisTotalChapters <= 0) return
    setPendingSynopsisRange({
      from,
      to: Math.min(synopsisTotalChapters, from + CONTINUATION_BATCH_SPAN - 1),
    })
    setShowArchDialog(true)
  }

  /** 打开普通「AI 生成架构」入口（不携带续批预填）。 */
  const openGenerateDialog = () => {
    setPendingSynopsisRange(null)
    setShowArchDialog(true)
  }

  if (!projectMatches) {
    return (
      <div className="h-full flex flex-col overflow-hidden bg-[var(--color-bg)]">
        <div
          className="flex items-center justify-between gap-2 px-3 h-9 flex-shrink-0"
          style={{
            borderBottom: '1px solid var(--color-border)',
            backgroundColor: 'var(--color-editor-bg)',
          }}
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-xs font-medium truncate text-[var(--color-text-secondary)]">
              {text('故事架构', 'Story architecture')}
            </span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto relative">
          <EmptyState icon={<BookOpen size={36} />} message={text('请先打开项目', 'Open a project to continue')} opacity={0.4} />
        </div>
      </div>
    )
  }

  const generatedCount = ARCH_FILES.filter(f => (
    archStatus[f.key] && !(f.key === 'synopsis' && synopsisRecoveryFailed)
  )).length
  const rosterPresentation = getCharacterRosterRepairPresentation(
    rosterSnapshot,
    text,
    rosterRepairError,
  )
  const canRepairRoster = canExplicitlyRepairCharacterRoster(rosterPresentation)

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* 页头统一提到内容区顶层：与其它子菜单同一位置、同一宽度（先生：整整齐齐） */}
      <div className="pagehead-strip">
        <PagePlate
          section="project"
          /* 数据图形：四份架构文件的完成度 —— 一个方格一份，生成了的填实。
             「还差哪一份没生成」是这一页最该被看见的一件事。 */
          figure={(
            <PlateFigure caption={text(
              `${generatedCount} / ${ARCH_FILES.length} 份架构已生成`,
              `${generatedCount} of ${ARCH_FILES.length} generated`,
            )}>
              <PlateChecks items={ARCH_FILES.map(file => ({
                label: text(file.labelZh, file.labelEn),
                done: Boolean(archStatus[file.key])
                  && !(file.key === 'synopsis' && synopsisRecoveryFailed),
              }))} />
            </PlateFigure>
          )}
          kicker={text('ARCHITECTURE · 故事架构', 'ARCHITECTURE')}
          title={text('故事架构', 'Story architecture')}
          description={text(
            '生成故事架构，作为正文写作的事实源，点击对应框体即可进入查看详细内容。',
            'Generate the story architecture — the source of truth for the draft. Click a card to open its details.',
          )}
          actions={(
            <div className="flex items-center gap-1.5">
              <button
                className="btn ghost sm"
                type="button"
                onClick={loadStatus}
                title={text('刷新状态', 'Refresh status')}
                /* 上游 1.1.0 的 browser 用例按可访问名「刷新状态」定位这个按钮；
                   新 UI 把可见文字收短成「刷新」，用 aria-label 保住完整可访问名 */
                aria-label={text('刷新状态', 'Refresh status')}
              >
                <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
                {text('刷新', 'Reload')}
              </button>
              {/* AI 生成架构 — 与小说配置/章节蓝图保持一致的按钮位置与规格 */}
              <button
                className="btn ai sm"
                type="button"
                onClick={openGenerateDialog}
                title={text('AI 生成故事架构（选择要生成的步骤）', 'Generate story architecture (choose steps to generate)')}
              >
                <Sparkles size={11} />
                {text('AI 生成架构', 'Generate story architecture')}
              </button>
            </div>
          )}
        >
          <FolderTree
            size={13}
            style={{
              display: 'inline-block',
              verticalAlign: 'middle',
              marginRight: 5,
              color: 'var(--color-text-muted)',
            }}
          />
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {generatedCount}/{ARCH_FILES.length} {text('已生成', 'generated')}
          </span>
        </PagePlate>
      </div>

      {/* 文件卡片列表
          先生：正文栏里各子菜单的内容宽度要统一，以「剧情线」计划清单的
          mx-auto max-w-5xl 为准 —— 所以这里也限宽居中，不再撑满整栏。
          排列方式照 demo 的故事架构页（demo 3064 行）：两列网格、12px 间距。 */}
      <div className="flex-1 overflow-y-auto mx-auto w-full max-w-5xl px-8 py-4 grid grid-cols-2 gap-3 content-start">
        {ARCH_FILES.map(f => {
          const generated = archStatus[f.key]
          const synopsisNeedsRecovery = f.key === 'synopsis' && synopsisRecoveryFailed
          const words = wordCounts[f.key] ?? 0
          const isCharacters = f.key === 'characters'
          const rosterNeedsAttention = isCharacters && rosterPresentation
            && rosterPresentation.kind !== 'ready'
            && rosterPresentation.kind !== 'empty'
          // 动态边框颜色：明确失败/异常 → 红 | 显式修复/采用 → 警告 | 已生成 → 绿
          const cardBorderColor = rosterPresentation?.kind === 'failed_with_data_preserved'
            || rosterPresentation?.kind === 'inconsistent'
            ? 'var(--color-error, #ef4444)'
            : rosterNeedsAttention
              ? 'var(--color-warning)'
            : synopsisNeedsRecovery
              ? 'var(--color-warning)'
              : generated
              ? 'var(--color-success)'
              : 'var(--color-border)'
          return (
            <div key={f.key}>
              <div
                /* 先生：框体要 demo 那种观感 —— 挂上 demo 的 .card 骨架
                   （shell.css 253 行：圆角 12px + border + box-shadow:var(--shadow)）。
                   动态的状态边框色与底色仍由内联给出，压在上面。 */
                className="card cursor-pointer transition-all h-full flex flex-col gap-2 overflow-hidden min-h-0"
                style={{
                  /* 尺寸照 demo 3068：padding 16px 18px */
                  padding: '16px 18px',
                  borderColor: cardBorderColor,
                  backgroundColor: rosterPresentation?.kind === 'failed_with_data_preserved'
                    || rosterPresentation?.kind === 'inconsistent'
                    ? 'color-mix(in srgb, var(--color-error) 4%, transparent)'
                    : 'var(--color-panel)',
                  opacity: loading ? 0.6 : 1,
                }}
                onClick={() => openArchFile(f)}
                onMouseEnter={e => (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-accent)'}
                onMouseLeave={e => (e.currentTarget as HTMLElement).style.borderColor = cardBorderColor}
                title={`${text('点击查看', 'Open')} — ${text(f.descZh, f.descEn)}`}
              >
                {/* 顶行：logo 方块 + 标题 + 状态图标
                    logo 照 demo 3069 —— 34×34、圆角 9px、黛蓝底浅金字，比原来的裸图标醒目得多 */}
                <div className="flex items-center gap-2.5">
                  <span
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 9,
                      background: 'var(--jade)',
                      color: '#EDE7D6',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flex: 'none',
                    }}
                  >
                    {renderIcon(f.iconName, 18)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate" style={{ color: 'var(--color-text)' }}>
                      {text(f.labelZh, f.labelEn)}
                    </div>
                  </div>
                  {/* 状态图标 */}
                  {generated
                    ? synopsisNeedsRecovery
                      ? <AlertTriangle size={16} style={{ flexShrink: 0, color: 'var(--color-warning)' }} />
                      : <CheckCircle2 size={16} style={{ flexShrink: 0, color: 'var(--color-success)' }} />
                    : <Circle size={16} style={{ flexShrink: 0, color: 'var(--color-text-muted)' }} />
                  }
                </div>

                {/* 描述 */}
                <div className="text-xs flex-1" style={{ color: 'var(--color-text-muted)', lineHeight: 1.65 }}>
                  {text(f.descZh, f.descEn)}
                </div>
                {isCharacters && rosterPresentation && (
                  <div
                    role="status"
                    className="text-xs leading-5"
                    style={{
                      color: rosterNeedsAttention
                        ? 'var(--color-warning-text)'
                        : 'var(--color-text-muted)',
                    }}
                  >
                    {rosterPresentation.label} · {rosterPresentation.description}
                  </div>
                )}

                {/* 状态徽标 / 字数 / 提取按钮 —— 先生：这些要老实待在框体里、落在右下角。
                    mt-auto 贴住卡底，justify-end 靠右；同一行的两张卡因此等高对齐。 */}
                <div className="flex flex-wrap items-center justify-end gap-2 mt-auto pt-1">
                  {isCharacters && rosterPresentation ? (
                    <>
                      {/* 先生：不要 v1/v2 两套格式来回切 —— 这一列的徽标一律走 v2 的钩子。
                          内联 style 的优先级高于任何 CSS 规则，留着它就会把新格式压住。 */}
                      <span
                        className="v2-status-badge text-[0.7rem] px-1.5 py-0.5 rounded"
                        data-tone={rosterNeedsAttention ? 'warning' : 'success'}
                      >
                        {rosterPresentation.label}
                      </span>
                      {generated && (
                        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                          {words.toLocaleString()} {text('字符', 'characters')}
                        </span>
                      )}
                    </>
                  ) : generated ? (
                    <>
                      {/* 上游 1.1.0：大纲分批生成后的四种真实状态 —— 检查点不可恢复 / 已存部分 / 已覆盖至第 N 章待续批 / 已生成
                          先生的规矩：不搞 v1/v2 两套格式来回切，这一列一律走 v2 的状态徽标钩子 ——
                          加粗与否、什么底色，全由钩子按语义档位给，颜色不再各写一份。 */}
                      {f.key === 'synopsis' && synopsisRecoveryFailed ? (
                        <span className="v2-status-badge text-[0.7rem] px-1.5 py-0.5 rounded" data-tone="warning">
                          {text('不完整 · 检查点不可恢复', 'Incomplete · checkpoint unavailable')}
                        </span>
                      ) : f.key === 'synopsis' && synopsisIncomplete ? (
                        <span className="v2-status-badge text-[0.7rem] px-1.5 py-0.5 rounded" data-tone="warning">
                          {text('不完整 · 已存部分', 'Incomplete · partial saved')}
                        </span>
                      ) : f.key === 'synopsis' && synopsisCoveredTo > 0 && synopsisCoveredTo < synopsisTotalChapters ? (
                        <span className="v2-status-badge text-[0.7rem] px-1.5 py-0.5 rounded" data-tone="warning">
                          {text(`已覆盖至第 ${synopsisCoveredTo} 章 · 待续批`, `Covered to ch. ${synopsisCoveredTo} · pending`)}
                        </span>
                      ) : (
                        <span className="v2-status-badge text-[0.7rem] px-1.5 py-0.5 rounded" data-tone="success">
                          {text('已生成', 'Generated')}
                        </span>
                      )}
                      <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                        {words.toLocaleString()} {text('字符', 'characters')}
                      </span>
                      {f.key === 'synopsis' && synopsisIncomplete && !loading && (
                        <Button
                          size="sm"
                          disabled={synopsisBusy}
                          className="gap-1.5 mt-0.5 bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow-sm hover:from-amber-600 hover:to-orange-600 border-none hover:shadow hover:-translate-y-[0.5px] transition-all"
                          onClick={(e) => {
                            e.stopPropagation()
                            void handleResumeSynopsis()
                          }}
                          title={text(
                            '上次生成被输出长度中断，已完成部分已保存。点击后 AI 从断点继续生成当前批次。',
                            'The previous run stopped at the output length limit and the completed part was saved. Click to continue the current batch from the break point.',
                          )}
                        >
                          {synopsisBusy
                            ? <RefreshCw size={12} className="animate-spin opacity-90" />
                            : <RefreshCw size={12} className="opacity-90" />
                          }
                          {synopsisBusy
                            ? text('续写中...', 'Resuming...')
                            : text('断点续写大纲', 'Continue outline')}
                        </Button>
                      )}
                      {f.key === 'synopsis' && !synopsisIncomplete && !synopsisRecoveryFailed
                        && synopsisCoveredTo > 0 && synopsisCoveredTo < synopsisTotalChapters && !loading && (
                        <Button
                          size="sm"
                          disabled={synopsisBusy}
                          className="gap-1.5 mt-0.5 bg-gradient-to-r from-indigo-500 to-blue-500 text-white shadow-sm hover:from-indigo-600 hover:to-blue-600 border-none hover:shadow hover:-translate-y-[0.5px] transition-all"
                          onClick={(e) => {
                            e.stopPropagation()
                            void handleContinueOutlineBatch()
                          }}
                          title={text(
                            `从第 ${synopsisCoveredTo + 1} 章起继续生成剩余章节（已确认的第 1–${synopsisCoveredTo} 章保持不变）。`,
                            `Continue generating the remaining chapters from chapter ${synopsisCoveredTo + 1} (confirmed chapters 1-${synopsisCoveredTo} stay unchanged).`,
                          )}
                        >
                          {synopsisBusy
                            ? <RefreshCw size={12} className="animate-spin opacity-90" />
                            : <RefreshCw size={12} className="opacity-90" />
                          }
                          {synopsisBusy
                            ? text('生成中...', 'Generating...')
                            : text(`续批（第 ${synopsisCoveredTo + 1} 章起）`, `Continue (ch. ${synopsisCoveredTo + 1}+)`)}
                        </Button>
                      )}
                    </>
                  ) : (
                    <span className="v2-status-badge text-[0.7rem] px-1.5 py-0.5 rounded" data-tone="accent">
                      {text('待生成', 'Not generated')}
                    </span>
                  )}
                  {/* 显式安全修复，或采用受保护的既有角色卡。 */}
                  {isCharacters && !loading && canRepairRoster && rosterPresentation?.actionLabel && (
                    <Button
                      size="sm"
                      disabled={extracting}
                      className="gap-1.5 mt-0.5 bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow-sm hover:from-amber-600 hover:to-orange-600 border-none hover:shadow hover:-translate-y-[0.5px] transition-all"
                      onClick={(e) => {
                        e.stopPropagation()
                        void handleRepairCharacterRoster()
                      }}
                      title={rosterPresentation.actionTitle}
                    >
                      {extracting
                        ? <RefreshCw size={12} className="animate-spin opacity-90" />
                        : <AlertTriangle size={12} className="opacity-90" />
                      }
                      {extracting ? text('处理中...', 'Working...') : rosterPresentation.actionLabel}
                    </Button>
                  )}
                  {/* 先生：卡片下方那行「点击查看」灰字已删 —— 整张卡都可点，
                      进页的说明统一写在页头那一句里。 */}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* AI 生成架构确认弹窗 */}
      <ArchitectureConfirmDialog
        isOpen={showArchDialog}
        onClose={() => setShowArchDialog(false)}
        archStatus={archStatus}
        initialSynopsisRange={pendingSynopsisRange}
        onConfirm={handleConfirm}
      />
    </div>
  )
}
