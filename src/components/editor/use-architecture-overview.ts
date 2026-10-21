import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { archOutlineSource, readArchCheckpoint } from '../../services/architecture-service'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { useLocaleStore } from '../../stores/locale-store'
import { ipc } from '../../services/ipc-client'
import { launchCreativeWorkflow } from '../../services/workflows/creative-workflow-launcher'
import { ARCH_STEP_NAMES, judgeArchCore, type ArchStepKey } from '../../services/architecture-step-selection'
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
import type { MainGenerationRunHandle } from '../../services/generation/generation-runtime'
import { architectureRecoveryHandle } from '../../shared/architecture-recovery-navigation'
import { DEFAULT_PLANNING_ACTION_CHAPTERS } from '../../shared/plot-outline-contract'
import type { GenerationRecoveryContext } from '../../shared/generation-owner-contract'
import type { ArchitectureConfirmFormOptions } from '../dialogs/use-architecture-confirm-form'
import { openPlanningRecoveryDraft } from '../../stores/editor-store'
import { outlineSourceChangedBlocked, planningTitle } from '../run/run-recovery'
import { outlineProgress, type OutlineProgress } from '../../shared/plot-outline-checkpoint'
import type { PlotOutlineRangeSource } from '../../shared/plot-outline-contract'
import { displayedErrorMessage } from '../../i18n/app-errors'

/** 架构四节的文档、图标与说明；名字取 ARCH_STEP_NAMES。 */
export const ARCH_FILES: Array<{
  key: ArchStepKey
  fileName: string
  iconName: string
  descZh: string
  descEn: string
}> = [
    { key: 'premise', fileName: 'premise.md', iconName: 'target', descZh: '故事钩子 · 核心冲突链 · 主角优势 · 悬念骨架', descEn: 'Story hook · core conflict · protagonist edge · suspense structure' },
    { key: 'characters', fileName: 'characters.md', iconName: 'users', descZh: '角色弧光 · 关系网络 · 矛盾交织', descEn: 'Character arcs · relationships · interlocking tensions' },
    { key: 'worldbuilding', fileName: 'worldbuilding.md', iconName: 'globe', descZh: '核心规则 · 社会结构 · 深层危机', descEn: 'Core rules · social structure · underlying crisis' },
    { key: 'synopsis', fileName: 'synopsis.md', iconName: 'map', descZh: '结构推进 · 转折节奏 · 伏笔闭环', descEn: 'Story progression · turning points · setup and payoff' },
  ]

interface GenerateIntent {
  steps?: ArchStepKey[]
  synopsisRange?: { from: number; to: number }
}

/**
 * 故事架构总览的数据与操作：四节状态、未完成候选、大纲续写与续批、角色名单修复、打开单节文档与架构生成。
 * 架构阶段用这一份。
 */
export function useArchitectureOverview(projectKey: string) {
  const currentProject = useProjectStore(s => s.currentProject)
  const text = useLocaleStore(s => s.text)
  const projectMatches = currentProject?.path === projectKey
  const latestArchitectureTerminalRunId = useWorkflowStore(state => (
    state.history.find(run => run.type === 'architecture_generation' && run.projectPath === projectKey)?.id ?? null
  ))
  /** 前提、世界观、大纲三节；角色名单一节随名单快照另算，不必等名单读完再读一遍这三节。 */
  const [coreStatus, setCoreStatus] = useState<Record<string, boolean>>({})
  const [planningRecovery, setPlanningRecovery] = useState<GenerationRecoveryContext | null>(null)
  const [coreWordCounts, setCoreWordCounts] = useState<Record<string, number>>({})
  const [contents, setContents] = useState<Record<string, string>>({})
  const [synopsisProgress, setSynopsisProgress] = useState<OutlineProgress>({ kind: 'empty' })
  const [synopsisRecoveryFailed, setSynopsisRecoveryFailed] = useState(false)
  const [synopsisSource, setSynopsisSource] = useState<PlotOutlineRangeSource>({ synopsis: '', totalChapters: 0, writingLanguage: 'zh-CN' })
  const [synopsisBusy, setSynopsisBusy] = useState(false)
  const [synopsisCandidate, setSynopsisCandidate] = useState('')
  const [showSynopsisCandidate, setShowSynopsisCandidate] = useState(false)
  const [synopsisHandle, setSynopsisHandle] = useState<MainGenerationRunHandle | null>(null)
  const [worldHandle, setWorldHandle] = useState<MainGenerationRunHandle | null>(null)
  const [worldBuildingCandidate, setWorldBuildingCandidate] = useState('')
  const [worldBuildingBusy, setWorldBuildingBusy] = useState(false)
  const [showWorldBuildingCandidate, setShowWorldBuildingCandidate] = useState(false)
  const [loading, setLoading] = useState(true)
  /** 第一次读三节结束（含失败）后置真且不再复位；读取失败时 loading 照旧停在加载态。 */
  const [coreReadEnded, setCoreReadEnded] = useState(false)
  /** 三节与名单都第一次读完后锁住：名单的 settled 换作品时会复位，这里不跟着复位。 */
  const [firstReadEnded, setFirstReadEnded] = useState(false)
  /** 生成对话框由哪个入口打开、预选哪几节；null 为关闭。每个入口整体替换，取消后不残留到下一次打开。 */
  const [generateIntent, setGenerateIntent] = useState<GenerateIntent | null>(null)
  const lastCompletedArchitectureRunRef = useRef<string | null>(null)
  const archStatusRequestGate = useRef(new LatestRequestGate())
  const {
    snapshot: rosterSnapshot,
    repairError: rosterRepairError,
    isRepairing: extracting,
    settled: rosterSettled,
    refresh: loadCharacterRosterStatus,
    migrate: handleRepairCharacterRoster,
  } = useCharacterRosterRepair({ projectKey, enabled: projectMatches })

  /** 加载各架构文件状态（通过 Service 层获取，不直接调 IPC） */
  const loadStatus = useCallback(async () => {
    await Promise.resolve()
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) {
      archStatusRequestGate.current.begin()
      setCoreStatus({})
      setCoreWordCounts({})
      setContents({})
      setSynopsisProgress({ kind: 'empty' })
      setSynopsisRecoveryFailed(false)
      setSynopsisSource({ synopsis: '', totalChapters: 0, writingLanguage: 'zh-CN' })
      setSynopsisCandidate('')
      setSynopsisHandle(null)
      setWorldHandle(null)
      setShowSynopsisCandidate(false)
      setWorldBuildingCandidate('')
      setShowWorldBuildingCandidate(false)
      setLoading(false)
      setCoreReadEnded(true)
      return
    }
    const projectPath = projectSession.projectPath
    const requestId = archStatusRequestGate.current.begin()
    setLoading(true)
    const core = await ipc.invokeWithProjectSession(
      projectSession,
      'db:project-core-get',
      projectPath,
    ).catch((error: unknown) => {
      if (archStatusRequestGate.current.isLatest(requestId)) setCoreReadEnded(true)
      throw error
    })
    let progress: OutlineProgress
    let recoveryFailed = false
    let recoveredWorldBuildingCandidate = ''
    let recoveredSynopsisCandidate = ''
    let confirmedWorldHandle: MainGenerationRunHandle | null = null
    let confirmedSynopsisHandle: MainGenerationRunHandle | null = null
    let recoveredPlanning: GenerationRecoveryContext | null = null
    const outlineSource = archOutlineSource(core, currentProject?.novelConfig)
    const { synopsis: dbSynopsis, totalChapters, writingLanguage } = outlineSource
    try {
      const partial = await readArchCheckpoint(projectSession)
      recoveredWorldBuildingCandidate = partial?.world_building_incomplete === true && typeof partial.world_building_partial_result === 'string'
        ? partial.world_building_partial_result : ''
      recoveredSynopsisCandidate = partial?.synopsis_incomplete === true && typeof partial.synopsis_result === 'string'
        ? partial.synopsis_result : ''
      // A failed main read must not hide the independently readable legacy candidate.
      for (const kind of ['worldbuilding', 'synopsis'] as const) {
        const handle = architectureRecoveryHandle(partial, kind, projectSession.projectId)
        if (!handle) continue
        try {
          if (kind === 'synopsis') {
            const context = await ipc.invokeWithProjectSession(projectSession, 'generation:read-context', { handle }).catch(() => null)
            if (context?.plotOutlineRecovery) {
              recoveredPlanning = context
              recoveredSynopsisCandidate = context.plotOutlineRecovery.draft
              confirmedSynopsisHandle = handle
              continue
            }
          }
          const composition = await ipc.invokeWithProjectSession(projectSession, 'generation:read-visible-composition', handle)
          if (composition?.algorithm !== 'visible-append-v1' || !composition.text) continue
          if (kind === 'worldbuilding') {
            recoveredWorldBuildingCandidate = composition.text
            confirmedWorldHandle = handle
          } else {
            recoveredSynopsisCandidate = composition.text
            confirmedSynopsisHandle = handle
          }
        } catch { /* Preserve the readable mirror; it does not authorize continuation. */ }
      }
      progress = outlineProgress(dbSynopsis, partial, writingLanguage, totalChapters)
      recoveryFailed = progress.kind === 'unresumable'
    } catch {
      progress = outlineProgress(dbSynopsis, undefined, writingLanguage, totalChapters)
      recoveryFailed = progress.kind === 'unresumable'
      recoveredWorldBuildingCandidate = ''
    }
    const status: Record<string, boolean> = judgeArchCore(core, progress.kind).hasContent
    const counts: Record<string, number> = {
      premise: status.premise ? (core?.premise?.length ?? 0) : 0,
      worldbuilding: status.worldbuilding ? (core?.worldbuilding?.length ?? 0) : 0,
      synopsis: status.synopsis ? (core?.synopsis?.length ?? 0) : 0,
    }
    if (
      !archStatusRequestGate.current.isLatest(requestId)
      || !isProjectSessionCurrent(projectSession)
    ) return
    setCoreStatus(status)
    setCoreWordCounts(counts)
    setContents({ premise: core?.premise ?? '', worldbuilding: core?.worldbuilding ?? '', synopsis: core?.synopsis ?? '' })
    setSynopsisProgress(progress)
    setSynopsisRecoveryFailed(recoveryFailed && Boolean(status.synopsis))
    setSynopsisSource(outlineSource)
    setSynopsisCandidate(recoveredSynopsisCandidate)
    setSynopsisHandle(confirmedSynopsisHandle)
    setPlanningRecovery(recoveredPlanning)
    setWorldHandle(confirmedWorldHandle)
    if (!recoveredSynopsisCandidate) setShowSynopsisCandidate(false)
    setWorldBuildingCandidate(recoveredWorldBuildingCandidate)
    if (!recoveredWorldBuildingCandidate) setShowWorldBuildingCandidate(false)
    setLoading(false)
    setCoreReadEnded(true)
  }, [currentProject, projectKey, projectMatches])

  if (!firstReadEnded && coreReadEnded && (!projectMatches || rosterSettled)) setFirstReadEnded(true)

  /** 每节是否已有内容（不论长短）；是否已确认看 confirmed。 */
  const archStatus = useMemo<Record<string, boolean>>(() => ({
    ...coreStatus,
    characters: rosterSnapshot?.status === 'ready',
  }), [coreStatus, rosterSnapshot])
  /**
   * 每节是否已确认：架构页徽标、页头计数、主按钮与生成对话框的默认勾选共用；前提、世界观、大纲的判定见 judgeArchCore。
   * 角色名单要名单就绪且不需要修复。
   */
  const rosterPresentation = getCharacterRosterRepairPresentation(
    rosterSnapshot,
    text,
    rosterRepairError,
  )
  const rosterReady = rosterPresentation?.kind === 'ready'
  const confirmed = useMemo<Record<ArchStepKey, boolean>>(() => ({
    ...judgeArchCore(contents, synopsisProgress.kind).confirmed,
    characters: rosterReady,
  }), [contents, rosterReady, synopsisProgress])
  const wordCounts = useMemo<Record<string, number>>(() => ({
    ...coreWordCounts,
    characters: rosterSnapshot?.status === 'ready' ? rosterSnapshot.renderedMarkdown.length : 0,
  }), [coreWordCounts, rosterSnapshot])

  useEffect(() => {
    const timer = setTimeout(() => { void loadStatus() }, 0)
    return () => clearTimeout(timer)
  }, [latestArchitectureTerminalRunId, loadStatus])

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
    const filePath = `ai-novel://core/${f.key}`
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
        // 角色名单的文档是名单的只读全文，与名单页标签区分开。
        name: f.key === 'characters' ? text('角色名单全文', 'Cast as text') : text(...ARCH_STEP_NAMES[f.key]),
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
    targetUnits?: number,
  ) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) throw new Error(text('项目会话已切换，未启动架构生成', 'The project session changed, so architecture generation was not started.'))
    if (!isProjectSessionCurrent(projectSession)) throw new Error(text('项目会话已切换，未启动架构生成', 'The project session changed, so architecture generation was not started.'))
    await launchCreativeWorkflow({
      workflow: 'generate_architecture',
      selectedSteps,
      stepGuidance,
      synopsisRange,
      targetUnits,
    }, projectSession)
  }

  /** 从上次输出长度中断的检查点继续生成情节大纲（断点续写当前批） */
  const handleResumeSynopsis = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    if (!isProjectSessionCurrent(projectSession) || synopsisBusy || !synopsisHandle || loading) return
    setSynopsisBusy(true)
    try {
      await launchCreativeWorkflow({
        workflow: 'generate_architecture',
        selectedSteps: ['synopsis'],
        resumeSynopsis: true,
        expectedRecoveryHandle: synopsisHandle,
      }, projectSession)
    } catch (error) {
      const detail = displayedErrorMessage(useLocaleStore.getState().locale, error)
      const { toast } = await import('../ui/Toast')
      toast.error(text(`续写启动失败：${detail}`, `Failed to start the continuation: ${detail}`))
    } finally {
      setSynopsisBusy(false)
    }
  }

  /** 从本项目保存的未完成候选继续生成世界观。 */
  const handleResumeWorldBuilding = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    if (!isProjectSessionCurrent(projectSession) || worldBuildingBusy || !worldBuildingCandidate || !worldHandle || loading) return
    setWorldBuildingBusy(true)
    try {
      await launchCreativeWorkflow({
        workflow: 'generate_architecture',
        selectedSteps: ['worldbuilding'],
        resumeWorldBuilding: true,
        expectedRecoveryHandle: worldHandle,
      }, projectSession)
    } catch (error) {
      const detail = displayedErrorMessage(useLocaleStore.getState().locale, error)
      const { toast } = await import('../ui/Toast')
      toast.error(text(`续写启动失败：${detail}`, `Failed to start the continuation: ${detail}`))
    } finally {
      setWorldBuildingBusy(false)
    }
  }

  const copyCandidate = async (candidate: string) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches
      || !projectSession
      || !isProjectSessionPath(projectSession, projectKey)
      || !isProjectSessionCurrent(projectSession)
      || !candidate
    ) return
    try {
      await navigator.clipboard.writeText(candidate)
      const { toast } = await import('../ui/Toast')
      toast.success(text('未完成候选已复制', 'Incomplete candidate copied.'))
    } catch (error) {
      const detail = displayedErrorMessage(useLocaleStore.getState().locale, error)
      const { toast } = await import('../ui/Toast')
      toast.error(text(`复制失败：${detail}`, `Copy failed: ${detail}`))
    }
  }

  /** 续批入口：打开生成弹窗并预填下一批范围（从 coveredTo+1 起，默认带本批上限，
   * 上限可在弹窗内调整）。避免一次请求剩余全部章节再次触发超长输出。 */
  const handleContinueOutlineBatch = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    if (!isProjectSessionCurrent(projectSession)) return
    if (synopsisProgress.kind !== 'partial') return
    const { coveredTo, total } = synopsisProgress
    const from = coveredTo + 1
    setGenerateIntent({
      steps: ['synopsis'],
      synopsisRange: { from, to: Math.min(total, from + DEFAULT_PLANNING_ACTION_CHAPTERS - 1) },
    })
  }

  /** 普通生成入口；steps 是「AI 生成此节」那一节，不携带续批预填。 */
  const openGenerateDialog = (steps?: ArchStepKey[]) => setGenerateIntent({ steps })

  /**
   * 恢复稿因来源已变不能写回时，本批的章节范围：作者从它的起始章重新生成；能写回或没有恢复稿时为 null。
   * 这里的恢复稿只在检查点记着本批未完成时读取，即正式大纲没有写入这一批；候选生成完、正式保存被拒也一样要重新生成。
   */
  const outlineRestartRange = planningRecovery && outlineSourceChangedBlocked(planningRecovery) ? planningRecovery.plotOutline?.range ?? null : null
  const openOutlineRestart = () => {
    if (outlineRestartRange) setGenerateIntent({ steps: ['synopsis'], synopsisRange: { from: outlineRestartRange.from, to: outlineRestartRange.to } })
  }

  /** 情节大纲有可编辑的恢复稿时打开它。 */
  const openRecoveryDraft = () => {
    if (!planningRecovery) return
    const session = captureProjectSession(currentProject)
    if (session && isProjectSessionCurrent(session)) openPlanningRecoveryDraft(planningRecovery, projectKey, planningTitle(planningRecovery, useLocaleStore.getState().locale))
  }

  return {
    projectMatches,
    /** 三节正文与名单都读完之前为真；名单读不到时也算读完，按没有名单显示。 */
    loading: loading || (projectMatches && !rosterSettled),
    /** 第一次读状态已结束（成功或失败）：之前各节还没有真实状态；之后刷新、或读取失败停在加载态时都为真。 */
    firstReadEnded,
    archStatus,
    confirmed,
    wordCounts,
    /** 故事前提、世界观、情节大纲的正式内容；角色名单以角色卡为准，不在这里。 */
    contents,
    planningRecovery,
    synopsis: {
      progress: synopsisProgress,
      /** 正文末尾带分批说明、主进程却已不能紧接续写（多半手改过）：续写按钮用不了，只能在对话框里选范围。 */
      recoveryFailed: synopsisRecoveryFailed,
      busy: synopsisBusy,
      candidate: synopsisCandidate,
      candidateShown: showSynopsisCandidate,
      setCandidateShown: setShowSynopsisCandidate,
      handle: synopsisHandle,
    },
    worldBuilding: {
      busy: worldBuildingBusy,
      candidate: worldBuildingCandidate,
      candidateShown: showWorldBuildingCandidate,
      setCandidateShown: setShowWorldBuildingCandidate,
      handle: worldHandle,
    },
    roster: {
      presentation: rosterPresentation,
      canRepair: canExplicitlyRepairCharacterRoster(rosterPresentation),
      repairing: extracting,
      repair: handleRepairCharacterRoster,
      refresh: loadCharacterRosterStatus,
    },
    /** 生成对话框直接展开这一份：开关、入口预选、大纲进度与提交。 */
    generateDialog: {
      isOpen: generateIntent !== null,
      onClose: () => setGenerateIntent(null),
      archStatus,
      confirmed,
      initialSelectedSteps: generateIntent?.steps,
      initialSynopsisRange: generateIntent?.synopsisRange ?? null,
      synopsisSource,
      onConfirm: handleConfirm,
    } satisfies ArchitectureConfirmFormOptions,
    loadStatus,
    openArchFile,
    handleConfirm,
    handleResumeSynopsis,
    handleResumeWorldBuilding,
    copyCandidate,
    handleContinueOutlineBatch,
    openGenerateDialog,
    openRecoveryDraft,
    outlineRestartRange,
    openOutlineRestart,
  }
}

export type ArchitectureOverview = ReturnType<typeof useArchitectureOverview>
