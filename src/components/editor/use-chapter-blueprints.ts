import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { navigate } from '../../stores/navigation/navigation-intents'
import { ipc } from '../../services/ipc-client'
import { clearProjectData } from '../../services/project-clear-service'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { pluralEn } from '../../shared/plural-en'
import {
  projectSessionContextFromProject,
  sameProjectPathKey,
  sameProjectSessionContext,
} from '../../shared/project-session-context'
import {
  loadDirectoryBlueprints,
  saveChapterBlueprint,
  saveAllBlueprints,
  type ChapterBlueprint,
  type DirectoryWorkflowParams,
} from '../../services/workflows/directory-workflow'
import { launchCreativeWorkflow } from '../../services/workflows/creative-workflow-launcher'
import { blueprintWritePrefill } from '../../services/workflows/chapter-write-launch'
import { guardDirectoryGeneration } from '../../services/workflow-guards'
import { toast } from '../ui/Toast'
import { globalEventBus, type EventPayloadMap } from '../../shared/event-bus'
import { shouldRefreshBlueprints } from './blueprint-refresh'
import { useLocaleStore } from '../../stores/locale-store'
import { registerEditorExitSaveHandler, useEditorStore } from '../../stores/editor-store'
import type { GenerationRecoveryContext } from '../../shared/generation-owner-contract'
import {
  CHAPTER_CARD_TAB_ID,
  captureBlueprintSnapshots,
  getChapterCardProjectDraft,
  parseChapterCardDraftLedger,
  persistChapterCardDraftLedger,
  refreshChapterCardDraftFromRemote,
  reconcileClearedBlueprintSnapshots,
  reconcileDeletedBlueprintSnapshots,
  reconcileSavedBlueprintSnapshots,
  updateEditableChapterBlueprintField,
  updateChapterCardProjectDraft,
  type DraftState,
  type EditableChapterBlueprintField,
} from './chapter-card-draft-ledger'
import { LatestRequestGate } from './latest-request-gate'
import type { SaveOutcome } from './save-feedback'
import {
  AuthoritativeChapterSequenceError,
  readAuthoritativeNextChapter,
} from '../../services/authoritative-chapter-sequence'

function readDraftLedgerFromFixedTab() {
  return parseChapterCardDraftLedger(
    useEditorStore.getState().draftLedgers[CHAPTER_CARD_TAB_ID],
  )
}

export function currentProjectSessionForPath(projectKey: string): ProjectSessionContext | null {
  const projectSession = projectSessionContextFromProject(
    useProjectStore.getState().currentProject,
  )
  return projectSession && sameProjectPathKey(projectSession.projectPath, projectKey)
    ? projectSession
    : null
}

export function isCurrentProjectSession(projectSession: ProjectSessionContext): boolean {
  return sameProjectSessionContext(
    projectSession,
    projectSessionContextFromProject(useProjectStore.getState().currentProject),
  )
}

/**
 * 章节蓝图的数据：读写蓝图表、未保存修改的草稿账本（顶栏保存状态与 ⌘S 都认它）、权威下一章、蓝图恢复候选。
 * 蓝图阶段用它；删除、清空、生成前警告的确认由页面负责。
 */
export function useChapterBlueprints({
  projectKey,
  initialChapterNumber,
  selectRequest,
}: {
  projectKey: string
  initialChapterNumber?: number
  /** 再次请求选中同一章时递增，选中才会重新生效。 */
  selectRequest?: number
}) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const currentProject = useProjectStore(s => s.currentProject)
  const [planningRecovery, setPlanningRecovery] = useState<GenerationRecoveryContext | null>(null)
  const latestDirectoryRun = useWorkflowStore(state => state.history.find(run => run.type === 'directory' && run.projectPath === projectKey)?.id)
  useEffect(() => {
    const session = currentProjectSessionForPath(projectKey)
    if (!session) return
    let current = true
    void (async () => {
      const views = await ipc.invokeWithProjectSession(session, 'generation:list')
      for (const view of views) {
        const recovery = await ipc.invokeWithProjectSession(session, 'generation:read-context', { handle: view.handle })
        if (!current || !isCurrentProjectSession(session)) return
        if (recovery.blueprintRecovery && recovery.blueprintRecovery.writeState !== 'complete') { setPlanningRecovery(recovery); return }
      }
      if (current) setPlanningRecovery(null)
    })().catch(() => {})
    return () => { current = false }
  }, [projectKey, currentProject?.sessionLease, latestDirectoryRun])
  // ✅ action 用 getState() 获取，不订阅 workflow store 高频更新
  const addLog = useWorkflowStore.getState().addLog
  const [blueprints, setBlueprints] = useState<ChapterBlueprint[]>([])
  // 选中按章号记：重新加载、删除与新增都会改变下标，章号不变；选中的章不在列表里时回到第一章。
  const [selectedChapter, setSelectedChapter] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveOutcome, setSaveOutcome] = useState<SaveOutcome>('idle')
  const [loading, setLoading] = useState(true)
  const [dirtyChapterNumbers, setDirtyChapterNumbers] = useState<Set<number>>(() => new Set())
  const blueprintsRef = useRef<ChapterBlueprint[]>([])
  const dirtyChapterNumbersRef = useRef<Set<number>>(new Set())
  const [dataProjectSession, setDataProjectSession] = useState<ProjectSessionContext | null>(null)
  const dataProjectSessionRef = useRef<ProjectSessionContext | null>(null)
  const loadRequestGateRef = useRef(new LatestRequestGate())
  const ownSaveRefresh = useRef<EventPayloadMap['REFRESH_RESOURCE'] | null>(null)
  const currentProjectSession = projectSessionContextFromProject(currentProject)
  const renderedProjectId = currentProjectSession?.projectId ?? null
  const renderedProjectLeaseId = currentProjectSession?.leaseId ?? null
  const renderedProjectPath = currentProjectSession?.projectPath ?? null
  const projectMatches = sameProjectPathKey(currentProjectSession?.projectPath, projectKey)
  const projectDataReady = Boolean(
    projectMatches
    && sameProjectSessionContext(currentProjectSession, dataProjectSession),
  )
  const dirty = dirtyChapterNumbers.size > 0
  // 下一个可写的章节号
  const [nextWriteChapter, setNextWriteChapter] = useState<number | null>(null)
  const [authorityError, setAuthorityError] = useState<string | null>(null)
  // 旧版仿写导入可能造成“前章未写、后续正文已定稿”的异常状态；该状态只能由用户确认恢复。
  const [legacyImportedTextRecoveryChapter, setLegacyImportedTextRecoveryChapter] = useState<number | null>(null)

  const [recoveringLegacyImportedText, setRecoveringLegacyImportedText] = useState(false)

  // 标签请求选中某章（含再次请求同一章）时才改选中；之后的重新加载不再改回去。
  const selectKey = initialChapterNumber === undefined ? null : `${initialChapterNumber}:${selectRequest ?? ''}`
  const [appliedSelectKey, setAppliedSelectKey] = useState<string | null>(null)
  if (initialChapterNumber !== undefined && selectKey !== appliedSelectKey) {
    setAppliedSelectKey(selectKey)
    setSelectedChapter(initialChapterNumber)
  }

  const selectedIdx = useMemo(
    () => Math.max(0, blueprints.findIndex(blueprint => blueprint.chapterNumber === selectedChapter)),
    [blueprints, selectedChapter],
  )
  const setSelectedIdx = useCallback((index: number) => {
    setSelectedChapter(blueprintsRef.current[index]?.chapterNumber ?? null)
  }, [])

  const applyVisibleDraftState = useCallback((nextBlueprints: ChapterBlueprint[], nextDirty: Set<number>) => {
    blueprintsRef.current = nextBlueprints
    dirtyChapterNumbersRef.current = nextDirty
    setBlueprints(nextBlueprints)
    setDirtyChapterNumbers(nextDirty)
  }, [])

  const persistProjectDraftState = useCallback((
    projectKey: string,
    projectSession: ProjectSessionContext,
    nextBlueprints: ChapterBlueprint[],
    nextDirty: Set<number>,
  ) => {
    if (
      !isCurrentProjectSession(projectSession)
      || !sameProjectSessionContext(dataProjectSessionRef.current, projectSession)
    ) return
    const store = useEditorStore.getState()
    const ledger = updateChapterCardProjectDraft(
      readDraftLedgerFromFixedTab(),
      projectKey,
      nextBlueprints,
      nextDirty,
    )
    persistChapterCardDraftLedger(store, ledger)
    applyVisibleDraftState(nextBlueprints, nextDirty)
  }, [applyVisibleDraftState])

  const currentWorkingState = useCallback((
    projectKey: string,
    projectSession: ProjectSessionContext,
  ): DraftState => {
    if (
      isCurrentProjectSession(projectSession)
      && sameProjectSessionContext(dataProjectSessionRef.current, projectSession)
    ) {
      return {
        blueprints: blueprintsRef.current,
        dirtyChapterNumbers: dirtyChapterNumbersRef.current,
      }
    }
    const draft = getChapterCardProjectDraft(readDraftLedgerFromFixedTab(), projectKey)
    return {
      blueprints: draft?.blueprints ?? [],
      dirtyChapterNumbers: new Set(draft?.dirtyChapterNumbers ?? []),
    }
  }, [])

  const markChapterDirty = useCallback((
    nextBlueprints: ChapterBlueprint[],
    chapterNumber: number,
  ) => {
    const projectSession = currentProjectSessionForPath(projectKey)
    if (
      !projectMatches
      || !projectSession
      || !sameProjectSessionContext(dataProjectSessionRef.current, projectSession)
    ) return
    const nextDirty = new Set(dirtyChapterNumbersRef.current)
    nextDirty.add(chapterNumber)
    setSaveOutcome('idle')
    persistProjectDraftState(projectKey, projectSession, nextBlueprints, nextDirty)
  }, [projectKey, projectMatches, persistProjectDraftState])

  const loadBlueprints = useCallback(async () => {
    const projectSession = currentProjectSessionForPath(projectKey)
    if (
      !projectMatches
      || !projectSession
      || projectSession.projectId !== renderedProjectId
      || projectSession.leaseId !== renderedProjectLeaseId
      || !sameProjectPathKey(projectSession.projectPath, renderedProjectPath)
    ) {
      loadRequestGateRef.current.begin()
      dataProjectSessionRef.current = null
      setDataProjectSession(null)
      setNextWriteChapter(null)
      setAuthorityError(null)
      setLegacyImportedTextRecoveryChapter(null)
      setSaving(false)
      applyVisibleDraftState([], new Set())
      setLoading(false)
      return
    }
    const requestId = loadRequestGateRef.current.begin()
    const isLatestProjectRequest = () => (
      loadRequestGateRef.current.isLatest(requestId)
      && isCurrentProjectSession(projectSession)
    )
    setLoading(true)
    setLegacyImportedTextRecoveryChapter(null)
    if (!sameProjectSessionContext(dataProjectSessionRef.current, projectSession)) {
      dataProjectSessionRef.current = null
      setDataProjectSession(null)
      setNextWriteChapter(null)
      setAuthorityError(null)
      setLegacyImportedTextRecoveryChapter(null)
      setSaving(false)
      applyVisibleDraftState([], new Set())
    }
    try {
      const restored = await refreshChapterCardDraftFromRemote({
        projectKey,
        loadRemote: () => loadDirectoryBlueprints(projectKey, projectSession),
        readLedger: readDraftLedgerFromFixedTab,
        isProjectCurrent: isLatestProjectRequest,
        commit: (state, restoredDraft) => {
          dataProjectSessionRef.current = projectSession
          setDataProjectSession(projectSession)
          if (restoredDraft) {
            persistProjectDraftState(
              projectKey,
              projectSession,
              state.blueprints,
              state.dirtyChapterNumbers,
            )
          } else {
            applyVisibleDraftState(state.blueprints, state.dirtyChapterNumbers)
          }
        },
      })
      // 项目可能在远端读取期间切换；旧项目结果不会进入 commit。
      if (!restored || !isLatestProjectRequest()) return
      try {
        const nextChapter = await readAuthoritativeNextChapter(projectSession, locale)
        if (!isLatestProjectRequest()) return
        setAuthorityError(null)
        setLegacyImportedTextRecoveryChapter(null)
        setNextWriteChapter(nextChapter)
      } catch (error) {
        if (!isLatestProjectRequest()) return
        const message = error instanceof Error ? error.message : String(error)
        const recoveryChapter = error instanceof AuthoritativeChapterSequenceError
          && error.sequence.firstGapChapterNumber !== undefined
          && error.sequence.lastChapterNumber > error.sequence.firstGapChapterNumber
          ? error.sequence.firstGapChapterNumber
          : null
        setAuthorityError(message)
        setLegacyImportedTextRecoveryChapter(recoveryChapter)
        setNextWriteChapter(null)
      }
    } catch (error) {
      if (isLatestProjectRequest()) {
        const message = error instanceof Error ? error.message : String(error)
        setAuthorityError(message)
        addLog('error', text('读取章节蓝图失败', 'Could not load chapter blueprints'))
      }
    } finally {
      if (isLatestProjectRequest()) setLoading(false)
    }
  }, [
    projectKey,
    projectMatches,
    renderedProjectId,
    renderedProjectLeaseId,
    renderedProjectPath,
    addLog,
    text,
    locale,
    applyVisibleDraftState,
    persistProjectDraftState,
  ])

  useEffect(() => {
    let mounted = true
    Promise.resolve().then(() => { if (mounted) loadBlueprints() })
    return () => { mounted = false }
  }, [loadBlueprints, projectKey])

  // 监听工作流完成事件，如果蓝图生成完毕则自动刷新
  useEffect(() => {
    return globalEventBus.on('WORKFLOW_COMPLETE', (payload) => {
      if (
        payload.type === 'directory'
        && sameProjectSessionContext(
          payload.projectSession,
          currentProjectSessionForPath(projectKey),
        )
      ) {
        loadBlueprints()
      }
    })
  }, [loadBlueprints, projectKey])

  // 单章或批量定稿后，重新读取连续定稿状态，避免旧版异常记录造成跳章入口。
  useEffect(() => {
    return globalEventBus.on('FINALIZE_COMPLETE', ({ projectPath, projectSession }) => {
      if (
        !sameProjectPathKey(projectPath, projectKey)
        || !sameProjectSessionContext(projectSession, currentProjectSessionForPath(projectKey))
      ) return
      loadBlueprints()
    })
  }, [projectKey, loadBlueprints])

  useEffect(() => {
    return globalEventBus.on('REFRESH_RESOURCE', (payload) => {
      if (
        payload !== ownSaveRefresh.current
        && sameProjectSessionContext(
          payload.projectSession,
          currentProjectSessionForPath(projectKey),
        )
        && shouldRefreshBlueprints(payload.resources)
      ) {
        loadBlueprints()
      }
    })
  }, [loadBlueprints, projectKey])

  const selected = projectDataReady ? blueprints[selectedIdx] ?? null : null

  /** 更新选中章节蓝图的字段 */
  const updateField = <K extends EditableChapterBlueprintField>(
    key: K,
    value: ChapterBlueprint[K],
  ) => {
    if (!selected) return
    markChapterDirty(blueprintsRef.current.map((b, i) => (
      i === selectedIdx ? updateEditableChapterBlueprintField(b, key, value) : b
    )), selected.chapterNumber)
  }

  /**
   * 保存后让流程脊的章节标题与 Ctrl P 的蓝图快照重读。本地已是保存后的内容，自己的监听认出这一条就不重读，
   * 免得编辑器闪成加载态、丢焦点与滚动。
   */
  const announceSaved = (projectSession: ProjectSessionContext) => {
    const payload: EventPayloadMap['REFRESH_RESOURCE'] = { resources: ['blueprints'], projectPath: projectKey, projectSession }
    ownSaveRefresh.current = payload
    globalEventBus.emit('REFRESH_RESOURCE', payload)
  }

  /** 保存当前章节蓝图 */
  const handleSaveOne = async (propagateFailure = false) => {
    const projectSession = currentProjectSessionForPath(projectKey)
    if (
      !projectMatches
      || !projectSession
      || !selected
      || !sameProjectSessionContext(dataProjectSessionRef.current, projectSession)
    ) return
    const savedSnapshots = captureBlueprintSnapshots([selected])
    setSaving(true)
    setSaveOutcome('idle')
    try {
      await saveChapterBlueprint(selected, projectKey, projectSession, locale)
      if (!isCurrentProjectSession(projectSession)) return
      const current = currentWorkingState(projectKey, projectSession)
      const nextDirty = reconcileSavedBlueprintSnapshots(
        current.blueprints,
        current.dirtyChapterNumbers,
        savedSnapshots,
      )
      persistProjectDraftState(projectKey, projectSession, current.blueprints, nextDirty)
      setSaveOutcome(nextDirty.size === 0 ? 'saved' : 'idle')
      announceSaved(projectSession)
      addLog('info', text(`第 ${selected.chapterNumber} 章蓝图已保存`, `Saved blueprint for Chapter ${selected.chapterNumber}`))
    } catch (err) {
      if (!isCurrentProjectSession(projectSession)) return
      const message = err instanceof Error ? err.message : String(err)
      addLog('error', text(`保存第 ${selected.chapterNumber} 章蓝图失败：${message}`, `Could not save the blueprint for Chapter ${selected.chapterNumber}.`))
      toast.error(text(`保存失败\n\n${message}`, 'Could not save the blueprint.'))
      setSaveOutcome('failed')
      if (propagateFailure) throw err
    } finally {
      if (isCurrentProjectSession(projectSession)) setSaving(false)
    }
  }

  /** 全量保存到 SQLite */
  const handleSaveAll = async (propagateFailure = false) => {
    const projectSession = currentProjectSessionForPath(projectKey)
    if (
      !projectMatches
      || !projectSession
      || !sameProjectSessionContext(dataProjectSessionRef.current, projectSession)
    ) return
    const saveInput = blueprintsRef.current
    const savedSnapshots = captureBlueprintSnapshots(saveInput)
    setSaving(true)
    setSaveOutcome('idle')
    try {
      await saveAllBlueprints(saveInput, projectKey, projectSession, locale)
      if (!isCurrentProjectSession(projectSession)) return
      const current = currentWorkingState(projectKey, projectSession)
      const nextDirty = reconcileSavedBlueprintSnapshots(
        current.blueprints,
        current.dirtyChapterNumbers,
        savedSnapshots,
      )
      persistProjectDraftState(projectKey, projectSession, current.blueprints, nextDirty)
      setSaveOutcome(nextDirty.size === 0 ? 'saved' : 'idle')
      announceSaved(projectSession)
      addLog('info', text(`已保存全部 ${saveInput.length} 章蓝图`, `Saved ${saveInput.length} chapter ${pluralEn(saveInput.length, 'blueprint')}`))
    } catch (err) {
      if (!isCurrentProjectSession(projectSession)) return
      const message = err instanceof Error ? err.message : String(err)
      addLog('error', text(`保存全部蓝图失败：${message}`, 'Could not save all chapter blueprints.'))
      toast.error(text(`保存失败\n\n${message}`, 'Could not save the blueprints.'))
      setSaveOutcome('failed')
      if (propagateFailure) throw err
    } finally {
      if (isCurrentProjectSession(projectSession)) setSaving(false)
    }
  }

  const exitSaveRef = useRef(handleSaveAll)
  useEffect(() => {
    exitSaveRef.current = handleSaveAll
  })
  useEffect(() => {
    registerEditorExitSaveHandler({
      type: 'chapter-card',
      projectKey,
      save: () => exitSaveRef.current(true),
    })
  }, [projectKey])

  /** 新建空章节 */
  const handleAddChapter = () => {
    const projectSession = currentProjectSessionForPath(projectKey)
    if (
      !projectMatches
      || !projectSession
      || !sameProjectSessionContext(dataProjectSessionRef.current, projectSession)
    ) return
    if (nextWriteChapter === null) {
      toast.warning(authorityError || text(
        '当前无法确定权威下一章，请先修复定稿章节。',
        'The authoritative next chapter is unavailable. Repair finalized chapters first.',
      ))
      return
    }
    const currentBlueprints = blueprintsRef.current
    const authoritativeBlueprintExists = currentBlueprints.some(
      blueprint => blueprint.chapterNumber === nextWriteChapter,
    )
    const chapterNumber = authoritativeBlueprintExists
      ? Math.max(nextWriteChapter, ...currentBlueprints.map(blueprint => blueprint.chapterNumber)) + 1
      : nextWriteChapter
    const newBlueprint: ChapterBlueprint = {
      chapterNumber,
      title: '',
      role: '发展',
      purpose: '',
      keyEvents: '',
      characters: [],
      suspenseHook: '',
      userGuidance: '',
      notes: '',
      notesUpdatedAt: '',
    }
    markChapterDirty([...currentBlueprints, newBlueprint], newBlueprint.chapterNumber)
    setSelectedChapter(newBlueprint.chapterNumber)
    if (authoritativeBlueprintExists) {
      toast.info(text(
        `第 ${nextWriteChapter} 章蓝图已存在，已新增第 ${chapterNumber} 章；写作入口仍为第 ${nextWriteChapter} 章。`,
        `The Chapter ${nextWriteChapter} blueprint already exists. Added Chapter ${chapterNumber}; the writing entry remains Chapter ${nextWriteChapter}.`,
      ))
    }
  }

  /** 删除指定的一章：章号在作者打开确认时就定下，确认期间重新加载或换选中都不改变删除目标。 */
  const handleDeleteChapter = async (chapterNumber: number) => {
    const projectSession = currentProjectSessionForPath(projectKey)
    const target = blueprintsRef.current.find(blueprint => blueprint.chapterNumber === chapterNumber)
    if (
      !projectMatches
      || !projectSession
      || !target
      || !sameProjectSessionContext(dataProjectSessionRef.current, projectSession)
    ) return
    const deletedSnapshots = captureBlueprintSnapshots([target])
    const result = await ipc.invokeWithProjectSession(
      projectSession,
      'db:blueprint-delete',
      target.chapterNumber,
      projectKey,
    )
    if (!isCurrentProjectSession(projectSession)) return
    if (!result.success) {
      toast.error(text(`删除失败\n\n${result.error ?? '未知错误'}`, 'Could not delete the chapter blueprint.'))
      return
    }
    const current = currentWorkingState(projectKey, projectSession)
    const deletedIndex = current.blueprints.findIndex(blueprint => blueprint.chapterNumber === target.chapterNumber)
    const next = reconcileDeletedBlueprintSnapshots(
      current.blueprints,
      current.dirtyChapterNumbers,
      deletedSnapshots,
    )
    persistProjectDraftState(projectKey, projectSession, next.blueprints, next.dirtyChapterNumbers)
    if (isCurrentProjectSession(projectSession)) {
      const neighbor = next.blueprints[Math.max(0, Math.min(deletedIndex, next.blueprints.length - 1))]?.chapterNumber ?? null
      setSelectedChapter(chapter => chapter === target.chapterNumber ? neighbor : chapter)
    }
    globalEventBus.emit('REFRESH_RESOURCE', {
      resources: ['blueprints'],
      projectPath: projectKey,
      projectSession,
    })
    toast.success(text(`已删除第 ${target.chapterNumber} 章蓝图`, `Deleted the blueprint for Chapter ${target.chapterNumber}`))
  }

  /** 清空全部章节蓝图 */
  const handleClearAllBlueprints = async () => {
    const projectSession = currentProjectSessionForPath(projectKey)
    if (
      !projectMatches
      || !projectSession
      || blueprints.length === 0
      || !sameProjectSessionContext(dataProjectSessionRef.current, projectSession)
    ) return
    const clearedSnapshots = captureBlueprintSnapshots(blueprintsRef.current)
    const result = await ipc.invokeWithProjectSession(
      projectSession,
      'db:blueprint-clear-all',
      projectKey,
    )
    if (!isCurrentProjectSession(projectSession)) return
    if (!result.success) {
      toast.error(text(`清空失败\n\n${result.error ?? '未知错误'}`, 'Could not clear the chapter blueprints.'))
      return
    }
    const current = currentWorkingState(projectKey, projectSession)
    const next = reconcileClearedBlueprintSnapshots(current.blueprints, clearedSnapshots)
    persistProjectDraftState(projectKey, projectSession, next.blueprints, next.dirtyChapterNumbers)
    if (isCurrentProjectSession(projectSession)) setSelectedChapter(null)
    globalEventBus.emit('REFRESH_RESOURCE', {
      resources: ['blueprints'],
      projectPath: projectKey,
      projectSession,
    })
    toast.success(text('已清空全部蓝图', 'All chapter blueprints cleared'))
  }

  /** 触发蓝图批量生成（来自生成对话框的确认回调）。返回是否已启动：作者取消架构警告时返回 false。 */
  const handleBatchGenerate = async (params: DirectoryWorkflowParams, confirmWarning: (message: string) => Promise<boolean>): Promise<boolean> => {
    const projectSession = currentProjectSessionForPath(projectKey)
    if (!projectMatches || !projectSession) throw new Error(text('项目会话已切换，未启动章节蓝图生成', 'The project changed, so blueprint generation was not started.'))
    const expectedProjectPath = projectKey

    // 前置校验：故事架构是否就绪
    const guard = await guardDirectoryGeneration(expectedProjectPath, projectSession)
    if (!isCurrentProjectSession(projectSession)) return false
    if (!guard.ok) {
      // 校验失败：阻断并提示
      addLog('error', text(`前置条件未满足：${guard.message}`, 'A required precondition is not met.'))
      throw new Error(guard.message || text('章节蓝图生成前置条件未满足', 'Blueprint prerequisites are not met.'))
    }
    if (guard.message) {
      // 有警告但允许继续：由界面确认
      if (!await confirmWarning(guard.message)) return false
    }

    if (!isCurrentProjectSession(projectSession)) {
      addLog('error', text('项目已切换，未启动章节蓝图生成', 'The project changed, so chapter blueprint generation was not started.'))
      throw new Error(text('项目已切换，未启动章节蓝图生成', 'The project changed, so blueprint generation was not started.'))
    }
    await launchCreativeWorkflow({ workflow: 'generate_blueprint', params }, projectSession)
    addLog('info', text('已启动章节蓝图生成', 'Chapter blueprint generation started'))
    return true
  }

  /**
   * 写作此章 — 将当前蓝图信息注入创作弹窗
   * 支持指定章节（默认为当前选中章）
   */
  const handleWriteChapter = (bp: ChapterBlueprint) => {
    const projectSession = currentProjectSessionForPath(projectKey)
    if (
      !projectSession
      || !sameProjectSessionContext(dataProjectSessionRef.current, projectSession)
    ) return
    navigate({ kind: 'chapter', chapterNumber: bp.chapterNumber, write: blueprintWritePrefill(bp) })
  }

  /**
   * 旧版“小说拆解与仿写”曾把参考原文误写为草稿和定稿；此处只给用户一个
   * 明确确认后的恢复入口，不尝试自动判定或删除任何项目内容。
   */
  const handleClearLegacyImportedText = async () => {
    const projectSession = currentProjectSessionForPath(projectKey)
    if (
      !projectMatches
      || !projectSession
      || !sameProjectSessionContext(dataProjectSessionRef.current, projectSession)
    ) return

    setRecoveringLegacyImportedText(true)
    try {
      await clearProjectData({ generatedText: true }, projectSession)
      if (!isCurrentProjectSession(projectSession)) return
      await loadBlueprints()
      if (!isCurrentProjectSession(projectSession)) return
      toast.success(text(
        '已清除误导入的正文产物；现在可从第 1 章开始写作。',
        'Incorrectly imported text was cleared. You can now start writing from Chapter 1.',
      ))
    } catch (error) {
      if (!isCurrentProjectSession(projectSession)) return
      const message = error instanceof Error ? error.message : String(error)
      toast.error(text(
        `清除误导入正文失败\n\n${message}`,
        `Could not clear incorrectly imported text.\n\n${message}`,
      ))
    } finally {
      if (isCurrentProjectSession(projectSession)) setRecoveringLegacyImportedText(false)
    }
  }

  const visibleBlueprints = projectDataReady ? blueprints : []
  const nextWritableBlueprint = nextWriteChapter === null
    ? null
    : visibleBlueprints.find(blueprint => blueprint.chapterNumber === nextWriteChapter) ?? null

  return {
    loading,
    projectMatches,
    projectDataReady,
    blueprints: visibleBlueprints,
    selectedIdx,
    setSelectedIdx,
    selected,
    dirty: projectDataReady && dirty,
    saving,
    saveOutcome,
    nextWriteChapter,
    nextWritableBlueprint,
    authorityError,
    legacyImportedTextRecoveryChapter: projectDataReady ? legacyImportedTextRecoveryChapter : null,
    recoveringLegacyImportedText,
    planningRecovery,
    reload: loadBlueprints,
    updateField,
    saveOne: handleSaveOne,
    saveAll: handleSaveAll,
    addChapter: handleAddChapter,
    deleteChapter: handleDeleteChapter,
    clearAll: handleClearAllBlueprints,
    generateBlueprints: handleBatchGenerate,
    writeChapter: handleWriteChapter,
    clearLegacyImportedText: handleClearLegacyImportedText,
  }
}
