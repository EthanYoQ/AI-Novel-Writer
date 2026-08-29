import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Save, BookOpen, RefreshCw, Plus, Trash2,
  Sparkles, PenLine, ListChecks, AlertTriangle
} from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { useLayoutStore } from '../../stores/layout-store'
import { ipc } from '../../services/ipc-client'
import { clearProjectData } from '../../services/project-clear-service'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
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
import { guardDirectoryGeneration } from '../../services/workflow-guards'
import DirectoryConfigDialog from '../dialogs/DirectoryConfigDialog'
import BatchChapterCreationDialog from '../dialogs/BatchChapterCreationDialog'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Textarea } from '../ui/Textarea'
import { Label } from '../ui/Label'
import { NativeSelect } from '../ui/NativeSelect'
import { cn } from '../../lib/utils'
import { toast } from '../ui/Toast'
import { confirm } from '../ui/Confirm'
import { globalEventBus } from '../../shared/event-bus'
import { shouldRefreshBlueprints } from './blueprint-refresh'
import { useLocaleStore } from '../../stores/locale-store'
import { useEditorStore } from '../../stores/editor-store'
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
import {
  AuthoritativeChapterSequenceError,
  readAuthoritativeNextChapter,
} from '../../services/authoritative-chapter-sequence'

const ROLES = ['建置', '铺垫', '发展', '冲突', '高潮', '转折', '收尾']

const ROLE_COLORS: Record<string, string> = {
  高潮: 'bg-red-500/20 text-[var(--color-error-text)]',
  冲突: 'bg-orange-500/20 text-[var(--color-warning-text)]',
  转折: 'bg-purple-500/20 text-[var(--color-category-review-text)]',
  建置: 'bg-blue-500/20 text-[var(--color-category-progress-text)]',
  收尾: 'bg-green-500/20 text-[var(--color-success-text)]',
}

function readDraftLedgerFromFixedTab() {
  return parseChapterCardDraftLedger(
    useEditorStore.getState().draftLedgers[CHAPTER_CARD_TAB_ID],
  )
}

function currentProjectSessionForPath(projectKey: string): ProjectSessionContext | null {
  const projectSession = projectSessionContextFromProject(
    useProjectStore.getState().currentProject,
  )
  return projectSession && sameProjectPathKey(projectSession.projectPath, projectKey)
    ? projectSession
    : null
}

function isCurrentProjectSession(projectSession: ProjectSessionContext): boolean {
  return sameProjectSessionContext(
    projectSession,
    projectSessionContextFromProject(useProjectStore.getState().currentProject),
  )
}

/** 章节蓝图编辑器 — 读写 directory.json */
export default function ChapterCardEditor({ projectKey }: { projectKey: string }) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const currentProject = useProjectStore(s => s.currentProject)
  // ✅ action 用 getState() 获取，不订阅 workflow store 高频更新
  const addLog = useWorkflowStore.getState().addLog
  const [blueprints, setBlueprints] = useState<ChapterBlueprint[]>([])
  const [selectedIdx, setSelectedIdx] = useState<number>(0)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [dirtyChapterNumbers, setDirtyChapterNumbers] = useState<Set<number>>(() => new Set())
  const blueprintsRef = useRef<ChapterBlueprint[]>([])
  const dirtyChapterNumbersRef = useRef<Set<number>>(new Set())
  const [dataProjectSession, setDataProjectSession] = useState<ProjectSessionContext | null>(null)
  const dataProjectSessionRef = useRef<ProjectSessionContext | null>(null)
  const loadRequestGateRef = useRef(new LatestRequestGate())
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

  // 蓝图生成弹窗（替代原 inline 批量面板）
  const [showBlueprintDialog, setShowBlueprintDialog] = useState(false)
  const [showBatchCreationDialog, setShowBatchCreationDialog] = useState(false)
  const [recoveringLegacyImportedText, setRecoveringLegacyImportedText] = useState(false)
  const roleLabel = (role: string) => text(role, ({
    建置: 'Setup',
    铺垫: 'Foreshadowing',
    发展: 'Development',
    冲突: 'Conflict',
    高潮: 'Climax',
    转折: 'Turning point',
    收尾: 'Resolution',
  } as Record<string, string>)[role] ?? role)

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
      const data = restored.blueprints
      if (data.length > 0) setSelectedIdx(0)
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
        sameProjectSessionContext(
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

  /** 保存当前章节蓝图 */
  const handleSaveOne = async () => {
    const projectSession = currentProjectSessionForPath(projectKey)
    if (
      !projectMatches
      || !projectSession
      || !selected
      || !sameProjectSessionContext(dataProjectSessionRef.current, projectSession)
    ) return
    const savedSnapshots = captureBlueprintSnapshots([selected])
    setSaving(true)
    try {
      await saveChapterBlueprint(selected, projectKey, projectSession)
      if (!isCurrentProjectSession(projectSession)) return
      const current = currentWorkingState(projectKey, projectSession)
      const nextDirty = reconcileSavedBlueprintSnapshots(
        current.blueprints,
        current.dirtyChapterNumbers,
        savedSnapshots,
      )
      persistProjectDraftState(projectKey, projectSession, current.blueprints, nextDirty)
    addLog('info', text(`第 ${selected.chapterNumber} 章蓝图已保存`, `Saved blueprint for Chapter ${selected.chapterNumber}`))
    } catch (err) {
      if (!isCurrentProjectSession(projectSession)) return
      const message = err instanceof Error ? err.message : String(err)
      addLog('error', text(`保存第 ${selected.chapterNumber} 章蓝图失败：${message}`, `Could not save the blueprint for Chapter ${selected.chapterNumber}.`))
      toast.error(text(`保存失败\n\n${message}`, 'Could not save the blueprint.'))
    } finally {
      if (isCurrentProjectSession(projectSession)) setSaving(false)
    }
  }

  /** 全量保存到 SQLite */
  const handleSaveAll = async () => {
    const projectSession = currentProjectSessionForPath(projectKey)
    if (
      !projectMatches
      || !projectSession
      || !sameProjectSessionContext(dataProjectSessionRef.current, projectSession)
    ) return
    const saveInput = blueprintsRef.current
    const savedSnapshots = captureBlueprintSnapshots(saveInput)
    setSaving(true)
    try {
      await saveAllBlueprints(saveInput, projectKey, projectSession)
      if (!isCurrentProjectSession(projectSession)) return
      const current = currentWorkingState(projectKey, projectSession)
      const nextDirty = reconcileSavedBlueprintSnapshots(
        current.blueprints,
        current.dirtyChapterNumbers,
        savedSnapshots,
      )
      persistProjectDraftState(projectKey, projectSession, current.blueprints, nextDirty)
      addLog('info', text(`已保存全部 ${saveInput.length} 章蓝图`, `Saved all ${saveInput.length} chapter blueprints`))
    } catch (err) {
      if (!isCurrentProjectSession(projectSession)) return
      const message = err instanceof Error ? err.message : String(err)
      addLog('error', text(`保存全部蓝图失败：${message}`, 'Could not save all chapter blueprints.'))
      toast.error(text(`保存失败\n\n${message}`, 'Could not save the blueprints.'))
    } finally {
      if (isCurrentProjectSession(projectSession)) setSaving(false)
    }
  }

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
    const existingIndex = blueprints.findIndex(blueprint => blueprint.chapterNumber === nextWriteChapter)
    if (existingIndex >= 0) {
      setSelectedIdx(existingIndex)
      return
    }
    const newBlueprint: ChapterBlueprint = {
      chapterNumber: nextWriteChapter,
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
    markChapterDirty([...blueprintsRef.current, newBlueprint], newBlueprint.chapterNumber)
    setSelectedIdx(blueprints.length)
  }

  /** 删除选中章节 */
  const handleDeleteChapter = async () => {
    const projectSession = currentProjectSessionForPath(projectKey)
    if (
      !projectMatches
      || !projectSession
      || !selected
      || !sameProjectSessionContext(dataProjectSessionRef.current, projectSession)
    ) return
    const deletedSnapshots = captureBlueprintSnapshots([selected])
    const ok = await confirm(text(
      `确认删除第 ${selected.chapterNumber} 章蓝图？\n此操作不可撤销。`,
      `Delete the blueprint for Chapter ${selected.chapterNumber}?\nThis cannot be undone.`,
    ), {
      title: text('删除章节蓝图', 'Delete chapter blueprint'),
      confirmText: text('删除', 'Delete'),
      danger: true,
    })
    if (!ok || !isCurrentProjectSession(projectSession)) return
    const result = await ipc.invokeWithProjectSession(
      projectSession,
      'db:blueprint-delete',
      selected.chapterNumber,
      projectKey,
    )
    if (!isCurrentProjectSession(projectSession)) return
    if (!result.success) {
      toast.error(text(`删除失败\n\n${result.error ?? '未知错误'}`, 'Could not delete the chapter blueprint.'))
      return
    }
    const current = currentWorkingState(projectKey, projectSession)
    const next = reconcileDeletedBlueprintSnapshots(
      current.blueprints,
      current.dirtyChapterNumbers,
      deletedSnapshots,
    )
    persistProjectDraftState(projectKey, projectSession, next.blueprints, next.dirtyChapterNumbers)
    if (isCurrentProjectSession(projectSession)) {
      setSelectedIdx(index => Math.max(0, Math.min(index, next.blueprints.length - 1)))
    }
    globalEventBus.emit('REFRESH_RESOURCE', {
      resources: ['blueprints', 'fileTree'],
      projectPath: projectKey,
      projectSession,
    })
    toast.success(text(`已删除第 ${selected.chapterNumber} 章蓝图`, `Deleted the blueprint for Chapter ${selected.chapterNumber}`))
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
    const ok = await confirm(text(
      `确认清空全部 ${blueprints.length} 章蓝图？\n此操作不可撤销，但不会删除草稿或正文章节。`,
      `Clear all ${blueprints.length} chapter blueprints?\nThis cannot be undone, but drafts and manuscript chapters will remain.`,
    ), {
      title: text('清空全部蓝图', 'Clear all blueprints'),
      confirmText: text('清空全部', 'Clear all'),
      danger: true,
    })
    if (!ok || !isCurrentProjectSession(projectSession)) return

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
    if (isCurrentProjectSession(projectSession)) setSelectedIdx(0)
    globalEventBus.emit('REFRESH_RESOURCE', {
      resources: ['blueprints', 'fileTree'],
      projectPath: projectKey,
      projectSession,
    })
    toast.success(text('已清空全部蓝图', 'All chapter blueprints cleared'))
  }

  /** 触发蓝图批量生成（来自 DirectoryConfigDialog 的确认回调） */
  const handleBatchGenerate = async (params: DirectoryWorkflowParams) => {
    const projectSession = currentProjectSessionForPath(projectKey)
    if (!projectMatches || !projectSession) throw new Error(text('项目会话已切换，未启动章节蓝图生成', 'The project changed, so blueprint generation was not started.'))
    const expectedProjectPath = projectKey

    // 前置校验：故事架构是否就绪
    const guard = await guardDirectoryGeneration(expectedProjectPath, projectSession)
    if (!isCurrentProjectSession(projectSession)) return
    if (!guard.ok) {
      // 校验失败：阻断并提示
      addLog('error', text(`前置条件未满足：${guard.message}`, 'A required precondition is not met.'))
      throw new Error(guard.message || text('章节蓝图生成前置条件未满足', 'Blueprint prerequisites are not met.'))
    }
    if (guard.message) {
      // 有警告但允许继续：弹出确认
      const yes = await confirm(text(
        `${guard.message}\n\n是否仍要继续生成？`,
        'A precondition warning was reported. Continue generating anyway?',
      ), {
        title: text('前置条件警告', 'Precondition warning'),
        confirmText: text('继续生成', 'Continue'),
      })
      if (!yes) throw new Error(text('已取消启动章节蓝图生成', 'Blueprint generation was cancelled.'))
    }

    if (!isCurrentProjectSession(projectSession)) {
      addLog('error', text('项目已切换，未启动章节蓝图生成', 'The project changed, so chapter blueprint generation was not started.'))
      throw new Error(text('项目已切换，未启动章节蓝图生成', 'The project changed, so blueprint generation was not started.'))
    }
    await launchCreativeWorkflow({ workflow: 'generate_blueprint', params }, projectSession)
    addLog('info', text('已启动章节蓝图生成', 'Chapter blueprint generation started'))
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
    // 通过 layout-store openChapterCreation 传递预填参数，替代 window.dispatchEvent
    useLayoutStore.getState().openChapterCreation({
      chapterNumber: bp.chapterNumber,
      title: bp.title,
      role: bp.role,
      purpose: bp.purpose,
      keyEvents: bp.keyEvents,
      characters: bp.characters.join('、'),
      userGuidance: bp.userGuidance || '',
    })
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

    const ok = await confirm(text(
      '仅当当前草稿和正文来自旧版“小说拆解与仿写”导入时，才继续清除。\n\n此操作会永久清除草稿、定稿、审稿和摘要等正文产物；会保留角色、故事架构、章节蓝图与知识库。若只是尚未生成下一章蓝图，请取消并先补充蓝图。',
      'Continue only if the current drafts and manuscript text came from a legacy “Novel analysis and imitation” import.\n\nThis permanently clears drafts, final manuscript text, reviews, and summaries. Characters, story architecture, chapter blueprints, and the knowledge base are kept. If the next blueprint is simply missing, cancel and add that blueprint first.',
    ), {
      title: text('清除误导入正文', 'Clear incorrectly imported text'),
      confirmText: text('清除误导入正文', 'Clear incorrectly imported text'),
      danger: true,
    })
    if (!ok || !isCurrentProjectSession(projectSession)) return

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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full gap-2" style={{ color: 'var(--color-text-muted)' }}>
        <RefreshCw size={16} className="animate-spin" /> {text('加载章节蓝图...', 'Loading chapter blueprints...')}
      </div>
    )
  }

  if (!projectMatches) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 opacity-40">
        <BookOpen size={36} />
        <span className="text-sm">{text('此标签属于另一个项目，请切回原项目后继续。', 'This tab belongs to another project. Switch back to continue.')}</span>
      </div>
    )
  }

  const visibleBlueprints = projectDataReady ? blueprints : []
  const visibleDirty = projectDataReady && dirty
  const nextWritableBlueprint = nextWriteChapter === null
    ? null
    : visibleBlueprints.find(blueprint => blueprint.chapterNumber === nextWriteChapter)
  const canRecoverLegacyImportedText = projectDataReady
    && legacyImportedTextRecoveryChapter !== null

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* 顶部工具栏 */}
      <div
        className="flex items-center justify-between gap-2 px-3 h-10 flex-shrink-0 border-b"
        style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-sidebar)' }}
      >
        <div className="flex items-center gap-1.5">
          <BookOpen size={13} style={{ color: 'var(--color-text-muted)' }} />
          <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
            {text('章节蓝图', 'Chapter blueprints')}
            {visibleBlueprints.length > 0 && (
              <span style={{ color: 'var(--color-text-muted)' }} className="ml-1 font-normal">
                {text(`(${visibleBlueprints.length} 章)`, `(${visibleBlueprints.length} chapters)`)}
              </span>
            )}
          </span>
          {visibleDirty && (
            <span className="inline-flex items-center gap-1 text-[0.7rem]" style={{ color: 'var(--color-accent)' }}>
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: 'currentColor' }}
              />
              {text('未保存', 'Unsaved')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* 写作入口 — 仅下一章可写时显示 */}
          {projectDataReady && nextWritableBlueprint && (
            <Button
              variant="ai"
              size="sm"
              onClick={() => handleWriteChapter(nextWritableBlueprint)}
            >
              <PenLine size={12} />
              {text(`写作第${nextWritableBlueprint.chapterNumber}章`, `Write Chapter ${nextWritableBlueprint.chapterNumber}`)}
            </Button>
          )}
          {projectDataReady && nextWritableBlueprint && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowBatchCreationDialog(true)}
              title={text('按连续章节蓝图启动受控批量创作任务（最高10章）', 'Start a controlled batch writing task from consecutive chapter blueprints (maximum 10 chapters).')}
            >
              <ListChecks size={12} />
              {text('批量创作', 'Batch write')}
            </Button>
          )}
          {/* AI 生成蓝图 → 弹出 DirectoryConfigDialog */}
          <Button
            variant="ai"
            size="sm"
            onClick={() => setShowBlueprintDialog(true)}
            disabled={!projectDataReady || Boolean(authorityError)}
            title={text('AI 生成章节蓝图（选择范围和模式）', 'Generate chapter blueprints with AI (choose the range and mode)')}
          >
            <Sparkles size={12} />
            {text('AI 生成蓝图', 'AI generate blueprints')}
          </Button>
          <Button variant="ghost" size="icon" onClick={() => loadBlueprints()} title={text('重新加载', 'Reload')} disabled={loading}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </Button>
          <Button variant="ghost" size="icon" onClick={handleAddChapter} disabled={!projectDataReady || nextWriteChapter === null || Boolean(authorityError)} title={text('新建章节', 'New chapter')}>
            <Plus size={14} />
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={handleClearAllBlueprints}
            disabled={saving || visibleBlueprints.length === 0 || !projectDataReady}
            title={text('清空全部章节蓝图', 'Clear all chapter blueprints')}
          >
            <Trash2 size={12} />
            {text('清空全部蓝图', 'Clear all blueprints')}
          </Button>
          {visibleDirty && (
            <Button variant="outline" size="sm" onClick={handleSaveAll} disabled={saving || !projectDataReady}>
            <Save size={12} /> {saving ? text('保存中...', 'Saving...') : text('保存全部', 'Save all')}
            </Button>
          )}
        </div>
      </div>

      {canRecoverLegacyImportedText && (
        <div
          className="flex flex-wrap items-center justify-between gap-3 border-b px-3 py-2 text-xs"
          style={{
            borderColor: 'color-mix(in srgb, var(--color-warning) 42%, var(--color-border))',
            backgroundColor: 'color-mix(in srgb, var(--color-warning) 8%, transparent)',
          }}
        >
          <div className="flex min-w-0 items-start gap-2" style={{ color: 'var(--color-text-secondary)' }}>
            <AlertTriangle size={15} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--color-warning)' }} />
            <p className="max-w-3xl leading-5">
              {text(
                `检测到后续正文但第 ${legacyImportedTextRecoveryChapter} 章尚未写作，可能是旧版“小说拆解与仿写”误导入的参考原文。系统不会自动清除任何内容；确认“清除误导入正文”后会保留角色、故事架构、章节蓝图与知识库，并可从第 ${legacyImportedTextRecoveryChapter} 章开始写作。`,
                `Later manuscript text exists while Chapter ${legacyImportedTextRecoveryChapter} has not been written. This may be reference text incorrectly imported by a legacy “Novel analysis and imitation” workflow. Nothing is cleared automatically; after you confirm “Clear incorrectly imported text”, characters, story architecture, chapter blueprints, and the knowledge base are kept, and you can start writing from Chapter ${legacyImportedTextRecoveryChapter}.`,
              )}
            </p>
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={handleClearLegacyImportedText}
            disabled={recoveringLegacyImportedText}
          >
            <Trash2 size={12} />
            {recoveringLegacyImportedText
              ? text('清除中...', 'Clearing...')
              : text('清除误导入正文', 'Clear incorrectly imported text')}
          </Button>
        </div>
      )}

      {projectDataReady && authorityError && !canRecoverLegacyImportedText && (
        <div
          className="flex items-start gap-2 border-b px-3 py-2 text-xs"
          style={{
            color: 'var(--color-warning-text)',
            borderColor: 'color-mix(in srgb, var(--color-warning) 42%, var(--color-border))',
            backgroundColor: 'color-mix(in srgb, var(--color-warning) 8%, transparent)',
          }}
        >
          <AlertTriangle size={15} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--color-warning)' }} />
          <p className="leading-5">{authorityError}</p>
        </div>
      )}

      {/* 蓝图生成配置弹窗 */}
        <DirectoryConfigDialog
        isOpen={showBlueprintDialog}
        onClose={() => setShowBlueprintDialog(false)}
        existingCount={visibleBlueprints.length}
          onConfirm={handleBatchGenerate}
        />
          <BatchChapterCreationDialog
          isOpen={showBatchCreationDialog}
          startChapterNumber={nextWritableBlueprint?.chapterNumber ?? null}
          onClose={() => setShowBatchCreationDialog(false)}
        />

      {/* 主区域：左侧列表 + 右侧编辑 */}
      <div className="flex-1 flex overflow-hidden">
        {/* 左侧章节列表 */}
        <div
          className="flex flex-col flex-shrink-0 w-[200px] border-r overflow-hidden"
          style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-sidebar)' }}
        >
          {visibleBlueprints.length === 0 ? (
            <div className="flex flex-col items-center justify-center flex-1 gap-3 opacity-40 p-4">
              <BookOpen size={28} />
              <span className="text-xs text-center">{text('暂无蓝图，点击「AI 生成」开始', 'No blueprints yet. Select “AI generate” to begin.')}</span>
            </div>
          ) : (
          <div className="flex-1 overflow-y-auto p-1">
            {visibleBlueprints.map((bp, idx) => (
              <div
                key={bp.chapterNumber}
                className={cn(
                  'group relative px-2.5 py-2 rounded-md text-xs cursor-pointer mb-0.5 transition-colors',
                  selectedIdx === idx
                    ? 'bg-[var(--color-active)] text-[var(--color-text)]'
                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-hover)]'
                )}
                onClick={() => setSelectedIdx(idx)}
              >
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[0.7rem] opacity-40 flex-shrink-0">
                    {bp.chapterNumber}
                  </span>
                  <span className="font-medium truncate flex-1">{bp.title || text('未命名', 'Untitled')}</span>
                </div>
                <div className="flex items-center gap-1 mt-0.5">
                  <span className={cn(
                    'text-[0.7rem] px-1 py-0.5 rounded',
                    ROLE_COLORS[bp.role] || 'bg-[var(--color-hover)] text-[var(--color-text-muted)]'
                  )}>
                    {roleLabel(bp.role)}
                  </span>
                  {bp.userGuidance && (
                    <span
                      className="text-[0.7rem] px-1 py-0.5 rounded"
                      style={{ backgroundColor: 'rgba(var(--accent-rgb), 0.15)', color: 'var(--color-accent)' }}
                      title={text('已有作者微操指导', 'Author guidance is available')}
                    >
                      {text('有指导', 'Guidance')}
                    </span>
                  )}
                  {bp.notes && (
                    <span
                      className="text-[0.7rem] px-1 py-0.5 rounded"
                      style={{ backgroundColor: 'rgba(34,197,94,0.15)', color: 'rgb(34,197,94)' }}
                      title={text('已生成章节要点', 'Chapter notes are available')}
                    >
                      {text('有要点', 'Notes')}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
          )}
        </div>

        {/* 右侧编辑区 */}
        <div className="flex-1 overflow-y-auto">
          {selected ? (
            <div className="max-w-2xl mx-auto px-5 py-4">
              {/* 编辑区头部 */}
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold" style={{ color: 'var(--color-text)' }}>
                  {text(
                    `第 ${selected.chapterNumber} 章：${selected.title || '未命名'}`,
                    `Chapter ${selected.chapterNumber}: ${selected.title || 'Untitled'}`,
                  )}
                </h3>
                <div className="flex items-center gap-1.5">
                  {/* 仅下一章允许写作 */}
                  {nextWritableBlueprint && selected.chapterNumber === nextWritableBlueprint.chapterNumber && (
                    <Button
                      variant="ai"
                      size="sm"
                      onClick={() => handleWriteChapter(selected)}
                      title={text('以当前蓝图信息生成草稿', 'Create a draft from this blueprint')}
                    >
                      <PenLine size={12} /> {text('写作此章', 'Write this chapter')}
                    </Button>
                  )}
                  <Button variant="destructive" size="sm" onClick={handleDeleteChapter} title={text('删除此章', 'Delete this chapter')}>
                    <Trash2 size={12} />
                    {text('删除此章', 'Delete chapter')}
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleSaveOne} disabled={saving}>
                    <Save size={12} /> {saving ? text('保存中...', 'Saving...') : text('保存', 'Save')}
                  </Button>
                </div>
              </div>

              <div className="space-y-3">
                {/* 基本信息 */}
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label>{text('章节号', 'Chapter number')}</Label>
                    <Input
                      type="number"
                      value={selected.chapterNumber}
                      readOnly
                      aria-readonly="true"
                      title={text('章节号是现有内容的稳定标识，不能在普通编辑中修改', 'The chapter number is a stable identifier and cannot be changed in ordinary editing.')}
                    />
                  </div>
                  <div className="col-span-2">
                    <Label>{text('章节标题', 'Chapter title')}</Label>
                    <Input
                      value={selected.title}
                      onChange={e => updateField('title', e.target.value)}
                      placeholder={text('引人入胜的章节标题', 'A compelling chapter title')}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>{text('章节定位', 'Chapter role')}</Label>
                    <NativeSelect value={selected.role} onChange={e => updateField('role', e.target.value)}>
                      {ROLES.map(r => <option key={r} value={r}>{roleLabel(r)}</option>)}
                    </NativeSelect>
                  </div>
                  <div>
                    <Label>{text('出场关键人（逗号分隔）', 'Key characters (comma-separated)')}</Label>
                    <Input
                      value={selected.characters.join('、')}
                      onChange={e => updateField('characters', e.target.value.split(/[,，、\s]+/).filter(Boolean))}
                      placeholder={text('如：主角、反派A', 'For example: protagonist, antagonist A')}
                    />
                  </div>
                </div>

                <div>
                  <Label>{text('主角小目标（本章最想解决的事）', 'Protagonist goal (the main thing to resolve in this chapter)')}</Label>
                  <Textarea
                    value={selected.purpose}
                    onChange={e => updateField('purpose', e.target.value)}
                    placeholder={text('本章主角最迫切要解决的一件事...', 'The most urgent thing the protagonist needs to resolve in this chapter...')}
                    rows={2}
                  />
                </div>

                <div>
                  <Label>{text('实质冲突与转折', 'Core conflict and turning point')}</Label>
                  <Textarea
                    value={selected.keyEvents}
                    onChange={e => updateField('keyEvents', e.target.value)}
                    placeholder={text('主角做了什么，遭遇了什么反转，金手指怎么用的...', 'What the protagonist does, the reversal they encounter, and how special abilities are used...')}
                    rows={4}
                  />
                </div>

                <div>
                  <Label>{text('末尾悬念钩子', 'Ending suspense hook')}</Label>
                  <Textarea
                    value={selected.suspenseHook}
                    onChange={e => updateField('suspenseHook', e.target.value)}
                    placeholder={text('一句话说明结尾留了什么悬念...', 'In one sentence, describe the suspense left at the end...')}
                    rows={2}
                  />
                </div>

                {/* 作者微操指导 — 特别标注，写稿时注入为最高优先级 */}
                <div
                  className="p-3 rounded-lg border"
                  style={{
                    borderColor: 'var(--color-accent)',
                    backgroundColor: 'rgba(var(--accent-rgb, 99 102 241), 0.06)',
                  }}
                >
                  <Label className="flex items-center gap-1.5">
                    <span>{text('作者微操指导', 'Author guidance')}</span>
                    <span
                      className="text-[0.7rem] font-normal"
                      style={{ color: 'var(--color-text-muted)' }}
                    >
                      {text('（写稿时会作为最高优先级注入 AI — 可覆盖蓝图）', '(Used as the highest-priority instruction during drafting; it can override the blueprint.)')}
                    </span>
                  </Label>
                  <Textarea
                    value={selected.userGuidance}
                    onChange={e => updateField('userGuidance', e.target.value)}
                    placeholder={text(
                      '我想在这章加入一个意外的背叛...\n让反派在这章露出破绽...\n（不填则完全按蓝图走）',
                      'Add an unexpected betrayal in this chapter...\nLet the antagonist reveal a weakness...\n(Leave blank to follow the blueprint exactly.)',
                    )}
                    rows={3}
                    style={{ marginTop: 6 }}
                  />
                </div>
                {/* 章节要点（定稿后自动生成，也可手动编辑） */}
                <div
                  className="p-3 rounded-lg border"
                  style={{
                    borderColor: 'var(--color-border)',
                    backgroundColor: 'rgba(34,197,94,0.04)',
                  }}
                >
                  <Label className="flex items-center gap-1.5">
                    <span>{text('章节要点', 'Chapter notes')}</span>
                    <span
                      className="text-[0.7rem] font-normal"
                      style={{ color: 'var(--color-text-muted)' }}
                    >
                      {selected.notesUpdatedAt
                        ? text(
                          `（定稿后自动生成 — ${new Date(selected.notesUpdatedAt).toLocaleDateString(locale)}）`,
                          `(Generated after finalization — ${new Date(selected.notesUpdatedAt).toLocaleDateString(locale)})`,
                        )
                        : text('（定稿后自动生成，也可手动填写）', '(Generated after finalization, or enter it manually.)')
                      }
                    </span>
                  </Label>
                  <Textarea
                    value={selected.notes || ''}
                    onChange={e => updateField('notes', e.target.value)}
                    placeholder={text(
                      '定稿后 AI 会自动填充本章要点（事件进展/角色变化/伏笔埋点），也可以提前手动输入给 AI 作参考',
                      'After finalization, AI fills these notes with plot progress, character changes, and foreshadowing. You can also enter them beforehand as AI reference.',
                    )}
                    rows={4}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-3 opacity-30">
              <BookOpen size={36} />
              <span className="text-sm">{text('在左侧选择一章开始编辑', 'Choose a chapter on the left to start editing')}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
