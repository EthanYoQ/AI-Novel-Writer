import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Save, BookOpen, RefreshCw, Plus, Trash2,
  Sparkles, PenLine, Check, AlertTriangle, Layers
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
import PagePlate from '../layout/v2/magazine/PagePlate'
import ChapterWorldSettingRefs from './ChapterWorldSettingRefs'
import { Input } from '../ui/Input'
import { Textarea } from '../ui/Textarea'
import { NativeSelect } from '../ui/NativeSelect'
import { cn } from '../../lib/utils'
import { toast } from '../ui/Toast'
import { confirm } from '../ui/Confirm'
import { globalEventBus } from '../../shared/event-bus'
import { shouldRefreshBlueprints } from './blueprint-refresh'
import { useLocaleStore } from '../../stores/locale-store'
import { registerEditorExitSaveHandler, useEditorStore } from '../../stores/editor-store'
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
import GripHandle from '../layout/v2/GripHandle'
import {
  AuthoritativeChapterSequenceError,
  readAuthoritativeNextChapter,
} from '../../services/authoritative-chapter-sequence'

const ROLES = ['建置', '铺垫', '发展', '冲突', '高潮', '转折', '收尾']

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

/**
 * 左栏（章节目录）的宽度。
 *
 * 章节标题长短差得很远：窄了长标题根本显示不出来，宽了又白占正文的地方。
 * 做成可拖拽之后，默认值只负责「第一次打开时不别扭」，真正的答案由作者自己拉出来。
 */
const CATALOG_WIDTH_STORAGE_KEY = 'ai-novel-writer-chapter-catalog-width'
const CATALOG_WIDTH_DEFAULT = 232
const CATALOG_WIDTH_MIN = 180
const CATALOG_WIDTH_MAX = 520

function readStoredCatalogWidth(): number {
  try {
    const raw = Number(localStorage.getItem(CATALOG_WIDTH_STORAGE_KEY))
    if (Number.isFinite(raw) && raw >= CATALOG_WIDTH_MIN && raw <= CATALOG_WIDTH_MAX) return raw
  } catch {
    // 隐私模式 / 存储被禁用：退回默认宽度即可，不影响使用。
  }
  return CATALOG_WIDTH_DEFAULT
}

/**
 * 出场人物：按顿号、逗号、分号或空白切分。
 *
 * 只用于「把作者的输入解析成名单」，**绝不能**拿它去生成输入框的显示值 ——
 * 那样作者刚敲下的分隔符会被立刻吃掉、名字还会黏成一串，这恰恰是旧实现里
 * 「什么标点都打不进去」的成因。
 */
function splitCharacterNames(value: string): string[] {
  return value.split(/[、，,;；\s]+/).filter(Boolean)
}

/** 章节蓝图编辑器 — 读写 directory.json */
export default function ChapterCardEditor({
  projectKey,
  initialChapterNumber,
}: {
  projectKey: string
  initialChapterNumber?: number
}) {
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
  /** 左栏宽度：可拖拽，并记住上次取值（与项目无关，属界面偏好）。 */
  const [catalogWidth, setCatalogWidth] = useState<number>(readStoredCatalogWidth)
  /**
   * 出场人物输入框的**原始文本**。名单本身存在 selected.characters 里，
   * 但输入框必须保留作者敲下的原文（含刚打的分隔符），否则受控值一回写
   * 就等于把刚输入的顿号擦掉 —— 旧实现正是这么做的。
   */
  const [charactersText, setCharactersText] = useState('')

  // 宽度变化就地记住：下次打开章节蓝图，仍是作者拉出来的那个宽窄。
  useEffect(() => {
    try {
      localStorage.setItem(CATALOG_WIDTH_STORAGE_KEY, String(Math.round(catalogWidth)))
    } catch {
      // 存不下就算了：宽度不可持久化不影响本次使用。
    }
  }, [catalogWidth])
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

  useEffect(() => {
    if (loading || initialChapterNumber === undefined) return
    const targetIndex = blueprintsRef.current.findIndex(
      blueprint => blueprint.chapterNumber === initialChapterNumber,
    )
    if (targetIndex >= 0) setSelectedIdx(targetIndex)
  }, [initialChapterNumber, loading])

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

  /**
   * 把名单回填到输入框，但只在「外部确实改了名单」时回填。
   *
   * 判据是：当前文本解析出来的名字序列是否与名单一致。作者正打着的原文
   * （哪怕末尾刚敲下一个顿号）解析结果与名单相同，就直接跳过 —— 否则每敲一个
   * 分隔符都会被 join('、') 的结果覆盖掉，那正是旧实现「标点打不进去」的现场。
   */
  useEffect(() => {
    const current = splitCharacterNames(charactersText)
    const next = selected?.characters ?? []
    if (current.length === next.length && current.every((name, index) => name === next[index])) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 外部名单（切章 / AI 回填 / 重载）变化时同步输入框，属受控回填
    setCharactersText(next.join('、'))
  }, [selected?.characters, selected?.chapterNumber, charactersText])

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

  const exitSaveRef = useRef(handleSaveAll)
  useEffect(() => {
    exitSaveRef.current = handleSaveAll
  })
  useEffect(() => {
    registerEditorExitSaveHandler({
      type: 'chapter-card',
      projectKey,
      save: () => exitSaveRef.current(),
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
    setSelectedIdx(currentBlueprints.length)
    if (authoritativeBlueprintExists) {
      toast.info(text(
        `第 ${nextWriteChapter} 章蓝图已存在，已新增第 ${chapterNumber} 章；写作入口仍为第 ${nextWriteChapter} 章。`,
        `The Chapter ${nextWriteChapter} blueprint already exists. Added Chapter ${chapterNumber}; the writing entry remains Chapter ${nextWriteChapter}.`,
      ))
    }
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
  // demo 3111 行的「已就绪 / 未就绪」徽标：卡面主干字段齐备即视为就绪（纯展示派生，不参与任何写入）。
  const selectedCardReady = Boolean(
    selected
    && selected.title.trim()
    && selected.purpose.trim()
    && selected.keyEvents.trim()
    && selected.suspenseHook.trim(),
  )
  /**
   * 未就绪时到底缺哪几项。
   *
   * 先生（群友反馈）：光看输入框猜不出哪些必填，徽标只写「未就绪」等于让作者自己试。
   * 这里把同一份判据原样摊开，鼠标停上去就能看到还差什么 —— 它与字段旁的
   * 「必填」标记必须说同一件事，所以共用上面那段判定。
   */
  const missingReadyFields = [
    ...(selected && !selected.title.trim() ? [text('章节标题', 'Chapter title')] : []),
    ...(selected && !selected.purpose.trim() ? [text('主角小目标', 'Protagonist goal')] : []),
    ...(selected && !selected.keyEvents.trim() ? [text('实质冲突与转折', 'Core conflict and turning point')] : []),
    ...(selected && !selected.suspenseHook.trim() ? [text('末尾悬念钩子', 'Ending suspense hook')] : []),
  ]
  // demo 里只有「下一章」可写；判断当前选中章是否就是那一章。
  const selectedIsWritable = Boolean(
    selected
    && nextWritableBlueprint
    && selected.chapterNumber === nextWritableBlueprint.chapterNumber,
  )

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* ① 工具栏 — demo 3094–3097 行 .edtool */}
      <div className="edtool">
        <div className="et-l">
          <BookOpen size={15} />
          <b>{text('章节蓝图', 'Chapter blueprints')}</b>
          <span className="v">
            {text(`${visibleBlueprints.length} 章`, `${visibleBlueprints.length} chapters`)}
          </span>
          {visibleDirty && (
            <span className="badge r" title={text('有尚未保存的修改', 'There are unsaved changes')}>
              {text('未保存', 'Unsaved')}
            </span>
          )}
        </div>
        <div className="et-r">
          {/* 写作此章 — demo 3095 行：仅下一章可写时出现 */}
          {projectDataReady && nextWritableBlueprint && (
            <button
              className="btn primary sm"
              type="button"
              onClick={() => handleWriteChapter(nextWritableBlueprint)}
              title={text('以当前蓝图信息生成草稿', 'Create a draft from this blueprint')}
            >
              <PenLine size={11} />
              {text(`写作第${nextWritableBlueprint.chapterNumber}章`, `Write Chapter ${nextWritableBlueprint.chapterNumber}`)}
            </button>
          )}
          {/* 批量写作 — demo 3096 行（先生：原「批量创作」改名，并按同排按钮的规格补上小图标） */}
          {projectDataReady && nextWritableBlueprint && (
            <button
              className="btn outline sm"
              type="button"
              onClick={() => setShowBatchCreationDialog(true)}
              title={text('按连续章节蓝图启动受控批量写作任务（最高10章）', 'Start a controlled batch writing task from consecutive chapter blueprints (maximum 10 chapters).')}
            >
              <Layers size={11} />
              {text('批量写作', 'Batch write')}
            </button>
          )}
          {/* AI 生成蓝图 — demo 3097 行（弹出 DirectoryConfigDialog） */}
          <button
            className="btn ai sm"
            type="button"
            onClick={() => setShowBlueprintDialog(true)}
            disabled={!projectDataReady || Boolean(authorityError)}
            title={text('AI 生成章节蓝图（选择范围和模式）', 'Generate chapter blueprints with AI (choose the range and mode)')}
          >
            <Sparkles size={11} />
            {text('AI生成', 'AI generate')}
          </button>
          {/* 刷新：demo 版面里没有位置，按任务要求收进 .et-r */}
          <button
            className="btn ghost sm"
            type="button"
            onClick={() => loadBlueprints()}
            disabled={loading}
            title={text('重新加载', 'Reload')}
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
            {text('刷新', 'Reload')}
          </button>
          {/* 手动添加：与「批量创作」同一规格（先生：子菜单按钮的外框与高度要统一） */}
          <button
            className="btn outline sm"
            type="button"
            onClick={handleAddChapter}
            disabled={!projectDataReady || nextWriteChapter === null || Boolean(authorityError)}
            title={text('手动新建一章蓝图', 'Add a blueprint manually')}
          >
            <Plus size={11} />
            {text('手动添加', 'Add manually')}
          </button>
          <button
            className="btn primary sm"
            type="button"
            onClick={handleClearAllBlueprints}
            disabled={saving || visibleBlueprints.length === 0 || !projectDataReady}
            title={text('清空全部章节蓝图', 'Clear all chapter blueprints')}
          >
            <Trash2 size={11} />
            {text('清空全部', 'Clear all')}
          </button>
          {/* 保存全部：先生定的规矩 —— 保存类一律虚框，实心主色只留给删除类动作
              （「清空全部」这类才是实框红底白字）。没有未保存改动时按钮仍常驻并显示「已保存」 */}
          <button
            className="btn outline sm"
            type="button"
            onClick={handleSaveAll}
            disabled={saving || !projectDataReady || !visibleDirty}
            title={visibleDirty
              ? text('保存全部修改', 'Save all changes')
              : text('没有未保存的修改', 'Nothing to save')}
          >
            <Save size={11} /> {visibleDirty ? text('保存全部', 'Save all') : text('已保存', 'Saved')}
          </button>
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

      {/* ② 主体 — demo 3098 行：左栏章节流 + 右栏章卡 */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* 左栏章节流 — demo 3099–3106 行。
            宽度交给作者拖：章节标题长短差得很远，固定 232px 既截长标题又白占正文的地方。 */}
        <div
          style={{ width: catalogWidth, flex: 'none', overflowY: 'auto', padding: '8px 5px' }}
        >
          {visibleBlueprints.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, opacity: 0.4, padding: 16, minHeight: 180 }}>
              <BookOpen size={28} />
              <span style={{ fontSize: 12, textAlign: 'center' }}>{text(
                '暂无蓝图，可用工具条上的「+ 手动添加」新建，或用「AI生成」批量创建。',
                'No blueprints yet. Use “Add manually” on the toolbar, or “AI generate” to create a batch.',
              )}</span>
            </div>
          ) : (
            visibleBlueprints.map((bp, idx) => {
              const chapterDirty = dirtyChapterNumbers.has(bp.chapterNumber)
              // demo 的 .cdot 状态点：产品的每行状态（未保存 / 有要点 / 有指导 / 未填写）落在同一条语义上。
              const cdotClass = chapterDirty ? 'dft' : bp.notes ? 'fin' : bp.userGuidance ? 'rdy' : 'new'
              const cdotTitle = chapterDirty
                ? text('有尚未保存的修改', 'There are unsaved changes')
                : bp.notes
                  ? text('已生成章节要点', 'Chapter notes are available')
                  : bp.userGuidance
                    ? text('已有作者微操指导', 'Author guidance is available')
                    : text('尚未填写卡面', 'This card is still empty')
              return (
                <div
                  key={bp.chapterNumber}
                  className={cn('tree-row', selectedIdx === idx && 'on')}
                  onClick={() => setSelectedIdx(idx)}
                  title={text(
                    `第 ${bp.chapterNumber} 章 · ${roleLabel(bp.role)}`,
                    `Chapter ${bp.chapterNumber} · ${roleLabel(bp.role)}`,
                  )}
                >
                  <span className={cn('cdot', cdotClass)} title={cdotTitle} />
                  <span style={{ fontFamily: 'var(--mono)', fontSize: '9.5px', color: 'var(--faint)', width: 16, textAlign: 'right', flex: 'none' }}>
                    {bp.chapterNumber}
                  </span>
                  <span className="tl">{bp.title || text('未命名', 'Untitled')}</span>
                  {/* 目录里只留章节名：定位（简介）收进 title 悬浮提示，不再挤在行尾 */}
                </div>
              )
            })
          )}
        </div>

        {/* 目录与章卡之间可拖拽：分隔感由手柄悬停显形承担，不再画固定竖线。 */}
        <GripHandle
          orientation="vertical"
          title={text('拖动调整目录宽度', 'Drag to resize the chapter list')}
          onDelta={delta => setCatalogWidth(previous => (
            Math.min(CATALOG_WIDTH_MAX, Math.max(CATALOG_WIDTH_MIN, previous + delta))
          ))}
        />

        {/* 右栏章卡 —— 先生：这里的标头窗口一变就跟着挪，就是因为内容容器跟标头不是同一套尺寸。
            标头是 max-w-5xl(1024) + 左右 32px，所以内容也收敛到同一套（原为 demo 的 1160/24）。 */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {/* 页头统一提到右栏内容区顶层：与其它子菜单同一位置、同一宽度（先生：整整齐齐） */}
          {selected && (
            <div className="pagehead-strip">
              <PagePlate
                section="blueprint"
                /* 期刊化读数：章号本身就是蓝图的页码 */
                metric={{
                  label: text('章', 'CH'),
                  value: String(selected.chapterNumber).padStart(2, '0'),
                }}
                kicker={text(`CHAPTER ${selected.chapterNumber} · 章卡`, `CHAPTER ${selected.chapterNumber}`)}
                title={text(
                  `第 ${selected.chapterNumber} 章：${selected.title || '未命名'}`,
                  `Chapter ${selected.chapterNumber}: ${selected.title || 'Untitled'}`,
                )}
                description={text(
                  '这一章要交代什么、谁出场、留什么钩子 —— 蓝图是正文的事实源',
                  'What this chapter must deliver: beats, cast and the hook it leaves. The blueprint is the source of truth for the draft.',
                )}
                actions={(
                  <>
                    {selectedCardReady ? (
                      <span className="badge g">
                        <Check size={9} /> {text('已就绪', 'Ready')}
                      </span>
                    ) : (
                      <span
                        className="badge gray"
                        title={missingReadyFields.length > 0
                          ? text(
                            `还缺：${missingReadyFields.join('、')}`,
                            `Still missing: ${missingReadyFields.join(', ')}`,
                          )
                          : undefined}
                      >
                        {text('未就绪', 'Not ready')}
                      </span>
                    )}
                    {/* 删除章节在 demo 版面里没有位置，按「最贴近的位置」并入页头动作组；
                        样式与其它子菜单的按钮统一到 demo 的 .btn.sm */}
                    <button
                      className="btn outline sm"
                      type="button"
                      onClick={handleDeleteChapter}
                      title={text('删除此章', 'Delete this chapter')}
                    >
                      <Trash2 size={11} />
                      {text('删除此章', 'Delete chapter')}
                    </button>
                  </>
                )}
              />
            </div>
          )}
          <div style={{ maxWidth: 1024, margin: '0 auto', padding: '0 32px 40px' }}>
            {selected ? (
              <>
                {/*
                  先生：作者在章节蓝图也要能 @，而且要跟助手那边一样的菜单。
                  放在字段最上方 —— 写蓝图时先想"这章要用到哪些设定"，最顺手。
                */}
                <ChapterWorldSettingRefs chapterNumber={selected.chapterNumber} />

                {/* 卡面字段 — demo 3112–3120 行 */}
                <div className="fld">
                  <div className="fh">
                    <span className="fk">NO.</span>
                    <span className="fn">{text('章节号', 'Chapter number')}</span>
                    <span className="req">{text('必填', 'Required')}</span>
                    <span className="hint">
                      {text(
                        '系统按定稿进度自动分配，无需手填',
                        'Assigned automatically from the finalized sequence — nothing to fill in',
                      )}
                    </span>
                  </div>
                  <Input
                    type="number"
                    value={selected.chapterNumber}
                    readOnly
                    aria-readonly="true"
                    title={text('章节号是现有内容的稳定标识，不能在普通编辑中修改', 'The chapter number is a stable identifier and cannot be changed in ordinary editing.')}
                  />
                </div>

                <div className="fld">
                  <div className="fh">
                    <span className="fn">{text('章节标题', 'Chapter title')}</span>
                    <span className="req">{text('必填', 'Required')}</span>
                  </div>
                  <Input
                    value={selected.title}
                    onChange={e => updateField('title', e.target.value)}
                    placeholder={text('引人入胜的章节标题', 'A compelling chapter title')}
                  />
                </div>

                <div className="fld">
                  <div className="fh">
                    <span className="fn">{text('章节定位', 'Chapter role')}</span>
                  </div>
                  <NativeSelect value={selected.role} onChange={e => updateField('role', e.target.value)}>
                    {ROLES.map(r => <option key={r} value={r}>{roleLabel(r)}</option>)}
                  </NativeSelect>
                </div>

                <div className="fld">
                  <div className="fh">
                    <span className="fn">{text('出场人物', 'Characters')}</span>
                    <span className="opt">{text('选填', 'Optional')}</span>
                    <span className="hint">{text('多个名字用顿号或逗号分隔', 'Separate several names with 、 or ,')}</span>
                  </div>
                  {/*
                    输入框绑定的是**作者敲下的原文**，不是名单拼出来的字符串。
                    旧实现把 value 写成名单 join 的结果、onChange 又立刻 split：于是刚打下的
                    顿号/逗号当场被 filter 掉，名字还会黏成一串，作者根本无法手动录入第二个人。
                    名单解析只负责写进 selected，原文留在 charactersText 里（见上面的同步 effect）。
                  */}
                  <Input
                    value={charactersText}
                    onChange={e => {
                      setCharactersText(e.target.value)
                      updateField('characters', splitCharacterNames(e.target.value))
                    }}
                    placeholder={text('如：主角、反派A', 'For example: protagonist, antagonist A')}
                  />
                </div>

                <div className="fld">
                  <div className="fh">
                    <span className="fn">{text('主角小目标', 'Protagonist goal')}</span>
                    <span className="req">{text('必填', 'Required')}</span>
                    <span className="hint">{text('本章最想解决的事', 'The main thing to resolve in this chapter')}</span>
                  </div>
                  <Textarea
                    value={selected.purpose}
                    onChange={e => updateField('purpose', e.target.value)}
                    placeholder={text('本章主角最迫切要解决的一件事...', 'The most urgent thing the protagonist needs to resolve in this chapter...')}
                    rows={2}
                  />
                </div>

                <div className="fld">
                  <div className="fh">
                    <span className="fn">{text('实质冲突与转折', 'Core conflict and turning point')}</span>
                    <span className="req">{text('必填', 'Required')}</span>
                  </div>
                  <Textarea
                    value={selected.keyEvents}
                    onChange={e => updateField('keyEvents', e.target.value)}
                    placeholder={text('主角做了什么，遭遇了什么反转，金手指怎么用的...', 'What the protagonist does, the reversal they encounter, and how special abilities are used...')}
                    rows={4}
                  />
                </div>

                <div className="fld">
                  <div className="fh">
                    <span className="fn">{text('末尾悬念钩子', 'Ending suspense hook')}</span>
                    <span className="req">{text('必填', 'Required')}</span>
                  </div>
                  <Textarea
                    value={selected.suspenseHook}
                    onChange={e => updateField('suspenseHook', e.target.value)}
                    placeholder={text('一句话说明结尾留了什么悬念...', 'In one sentence, describe the suspense left at the end...')}
                    rows={2}
                  />
                </div>

                {/* 作者微操指导 — 写稿时注入为最高优先级；这句强调按 demo 放进 .hint */}
                <div className="fld">
                  <div className="fh">
                    <span className="fn">{text('作者微操指导', 'Author guidance')}</span>
                    <span className="opt">{text('选填', 'Optional')}</span>
                    <span className="hint">{text('写稿时最高优先级注入 AI — 可覆盖蓝图', 'Injected into the AI with the highest priority when drafting — it can override the blueprint')}</span>
                  </div>
                  <Textarea
                    value={selected.userGuidance}
                    onChange={e => updateField('userGuidance', e.target.value)}
                    placeholder={text(
                      '我想在这章加入一个意外的背叛...\n让反派在这章露出破绽...\n（不填则完全按蓝图走）',
                      'Add an unexpected betrayal in this chapter...\nLet the antagonist reveal a weakness...\n(Leave blank to follow the blueprint exactly.)',
                    )}
                    rows={3}
                  />
                </div>

                {/* 章节要点（定稿后自动生成，也可手动编辑）；自动生成时间保留在 .hint 里 */}
                <div className="fld">
                  <div className="fh">
                    <span className="fn">{text('章节要点', 'Chapter notes')}</span>
                    <span className="opt">{text('选填', 'Optional')}</span>
                    <span className="hint">
                      {selected.notesUpdatedAt
                        ? text(
                          `定稿后自动生成 — ${new Date(selected.notesUpdatedAt).toLocaleDateString(locale)}`,
                          `Generated after finalization — ${new Date(selected.notesUpdatedAt).toLocaleDateString(locale)}`,
                        )
                        : text('定稿后由 AI 自动回填', 'Filled in by the AI after finalization')}
                    </span>
                  </div>
                  <Textarea
                    value={selected.notes || ''}
                    onChange={e => updateField('notes', e.target.value)}
                    placeholder={text(
                      '定稿后 AI 会自动填充本章要点（事件进展/角色变化/伏笔埋点），也可以提前手动输入给 AI 作参考',
                      'After finalization, AI fills these notes with plot progress, character changes, and foreshadowing. You can also enter them beforehand as AI reference.',
                    )}
                    rows={3}
                  />
                </div>

                {/* 底部动作行 — demo 3121 行：保存 + 写作此章（不可写时给禁用的占位按钮） */}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  {/* 先生：单章保存同样要「未修改=已保存 / 改动了=保存」，
                      脏标记直接取该章是否在 dirtyChapterNumbers 里 */}
                  <Button
                    variant="outline"
                    onClick={handleSaveOne}
                    disabled={saving || !dirtyChapterNumbers.has(selected.chapterNumber)}
                  >
                    <Save size={12} /> {dirtyChapterNumbers.has(selected.chapterNumber)
                      ? text('保存', 'Save')
                      : text('已保存', 'Saved')}
                  </Button>
                  {selectedIsWritable ? (
                    <button
                      className="btn primary"
                      type="button"
                      onClick={() => handleWriteChapter(selected)}
                      title={text('以当前蓝图信息生成草稿', 'Create a draft from this blueprint')}
                    >
                      <PenLine size={12} /> {text('写作此章 →', 'Write this chapter →')}
                    </button>
                  ) : (
                    <button className="btn ghost" type="button" disabled>
                      {authorityError
                        ? text('先修复定稿章节', 'Repair the finalized chapters first')
                        : nextWritableBlueprint
                          ? text(`写作入口为第 ${nextWritableBlueprint.chapterNumber} 章`, `The writing entry is Chapter ${nextWritableBlueprint.chapterNumber}`)
                          : text('先完善卡面', 'Complete this card first')}
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, opacity: 0.3, minHeight: 320 }}>
                <BookOpen size={36} />
                <span style={{ fontSize: 13 }}>{text('在左侧选择一章开始编辑', 'Choose a chapter on the left to start editing')}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
