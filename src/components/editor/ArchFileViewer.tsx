import { LegacyRosterRecoveryPanel } from './LegacyRosterRecoveryPanel'
import { resourceWriteAllowed } from '../../shared/project-paths'
import { useState, useCallback, useRef, useEffect } from 'react'
import { Save, RefreshCw, Sparkles, Loader2, AlertTriangle, FileText } from 'lucide-react'
import { renderIcon } from '../panels/sidebar/sidebar-icons'

import { registerEditorExitSaveHandler, useEditorStore, type PlanningRecoverySaveSnapshot } from '../../stores/editor-store'
import ArchitectureConfirmDialog from '../dialogs/ArchitectureConfirmDialog'
import { ARCH_STEP_NAMES, archSectionHasContent, judgeArchCore, type ArchStepKey } from '../../services/architecture-step-selection'
import { Button } from '../ui/Button'
import { ipc } from '../../services/ipc-client'
import { requireIpcSuccess } from '../../services/ipc-result'
import { CORE_FIELD_MAP, parseCoreField } from '../../services/resource-protocol'
import { appErrorMessage } from '../../i18n/app-errors'
import { toast } from '../ui/Toast'
import { CharacterCardImportButton } from '../characters/CharacterCardImportButton'
import CodeMirrorEditor from './CodeMirrorEditor'
import { SaveFeedback, type SaveOutcome } from './save-feedback'
import { useProjectStore } from '../../stores/project-store'
import { useLocaleStore } from '../../stores/locale-store'
import { launchCreativeWorkflow } from '../../services/workflows/creative-workflow-launcher'
import { createArchitectureWorkflow } from '../../services/workflows/architecture-workflow'
import { renderPlotOutlineSynopsis, validPlotOutlineAuthorPrefix, type PlotOutlineRangeSource } from '../../shared/plot-outline-contract'
import { useWorkflowStore } from '../../stores/workflow-store'
import { outlineProgress } from '../../shared/plot-outline-checkpoint'
import { archOutlineSource, readArchCheckpoint } from '../../services/architecture-service'
import { outlineSourceChangedNote, outlineSourceInvalidNote, planningRemainingText } from '../run/run-recovery'
import { globalEventBus } from '../../shared/event-bus'
import {
  ARCH_REFRESH_BLOCKED_MESSAGE,
  ARCH_PROJECT_MISMATCH_MESSAGE,
  ArchReloadGate,
  archEditStoreAction,
  decideArchExternalRefresh,
  didArchSaveSettle,
  hasUnsavedArchEdit,
  isArchProjectCurrent,
  reassertBlockedArchEdit,
  shouldRefreshArchOnWorkflowComplete,
  writeArchEditState,
} from './arch-file-refresh-policy'
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


/** 与 Sidebar / WorldBuildingEditor 保持一致的架构文件元信息 */
/** 视图头与生成按钮的名字取 ARCH_STEP_NAMES；角色名单一节在这里看到的是名单的只读全文。 */
const ARCH_META: Record<ArchStepKey, { iconName: string; view: readonly [string, string]; desc: string; descEn: string }> = {
  premise: { iconName: 'target', view: ARCH_STEP_NAMES.premise, desc: 'Logline、核心冲突、金手指定位', descEn: 'Logline, central conflict, and story hook' },
  characters: { iconName: 'users', view: ['角色名单全文', 'Cast as text'], desc: '角色弧光、关系网、矛盾交织', descEn: 'Character arcs, relationships, and conflicts' },
  worldbuilding: { iconName: 'globe', view: ARCH_STEP_NAMES.worldbuilding, desc: '核心规则、阶层断层、深层危机', descEn: 'Core rules, social divides, and deeper crises' },
  synopsis: { iconName: 'map', view: ARCH_STEP_NAMES.synopsis, desc: '三幕式情节骨架', descEn: 'Three-act story structure' },
}

/**
 * 名单全文由主进程按名单生成，开头的「# 角色图谱」标题是持久投影的一部分（改它会让既有作品的投影校验全部失配），
 * 只在查看时去掉，标签与视图头已写明「角色名单全文」。
 */
function castTextForView(markdown: string): string {
  return markdown.replace(/^# (?:角色图谱|Character graph)\n+/u, '')
}

/** 从文件路径推断出 ArchStepKey */
function detectStepKey(filePath: string): ArchStepKey | null {
  const field = parseCoreField(filePath)
  const coreKey = Object.keys(CORE_FIELD_MAP).find(key => CORE_FIELD_MAP[key] === field)
  if (coreKey) return coreKey as ArchStepKey
  if (filePath.endsWith('premise.md')) return 'premise'
  if (filePath.endsWith('characters.md')) return 'characters'
  if (filePath.endsWith('worldbuilding.md')) return 'worldbuilding'
  if (filePath.endsWith('synopsis.md')) return 'synopsis'
  return null
}

interface Props {
  tabId: string
  filePath: string
  projectKey: string
  content: string
  savedContent: string
}

/**
 * 架构文件编辑器（Markdown 文件 WYSIWYG 编辑）
 * - 使用 CodeMirrorEditor（document 模式）+ hideStatusBar，底部栏信息整合到本组件工具栏
 * - 脏状态通过比较内容字符串判断，不依赖 onChange 时机
 */
export default function ArchFileViewer(props: Props) {
  const currentProject = useProjectStore(s => s.currentProject)
  const projectSession = captureProjectSession(currentProject)
  const sessionKey = projectSession && isProjectSessionPath(projectSession, props.projectKey)
    ? `${projectSession.projectId}:${projectSession.leaseId}`
    : `inactive:${props.projectKey}`

  // 同一路径重新打开会产生新 lease；重挂载可隔离旧会话的编辑器临时状态。
  return <ArchFileViewerSession key={sessionKey} {...props} />
}

function ArchFileViewerSession({
  tabId,
  filePath,
  projectKey,
  content: initialContent,
  savedContent: initialSavedContent,
}: Props) {
  const stepKey = detectStepKey(filePath)
  const isCharacterProjection = stepKey === 'characters'
  const meta = stepKey ? ARCH_META[stepKey] : null
  const currentProject = useProjectStore(s => s.currentProject)
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const recoveryTab = useEditorStore(s => s.tabs.find(tab => tab.id === tabId && tab.planningRecovery))
  const [recovery, setRecovery] = useState(recoveryTab?.planningRecovery)
  const [authorEnd, setAuthorEnd] = useState(String(recoveryTab?.planningSaveEnd ?? ''))
  const [recoveryError, setRecoveryError] = useState('')
  const [continuing, setContinuing] = useState(false)
  const recoverySession = useRef(captureProjectSession(currentProject))
  const authorEndRef = useRef(authorEnd)
  const recoveryRef = useRef(recovery)
  const hasRecovery = Boolean(recoveryTab)
  const currentProjectKey = currentProject?.path
  const projectMatches = isArchProjectCurrent(projectKey, currentProjectKey)
  const planningTargetUnit = recovery?.plotOutline?.sourceExpected.writingLanguage === 'en-US' ? text('词', 'words') : text('字', 'characters')

  const refreshRecovery = useCallback(async () => {
    const session = recoverySession.current
    const original = recoveryTab?.planningRecovery
    if (!session || !original || !isProjectSessionCurrent(session)) return
    const next = await ipc.invokeWithProjectSession(session, 'generation:read-context', { handle: original.handle })
    if (isProjectSessionCurrent(session)) { recoveryRef.current = next; setRecovery(next) }
    return next
  }, [recoveryTab?.planningRecovery])
  useEffect(() => {
    if (!hasRecovery) return
    void refreshRecovery().catch(error => setRecoveryError(appErrorMessage(useLocaleStore.getState().locale, error)))
  }, [hasRecovery, refreshRecovery])

  // 磁盘上的内容（已保存的基准）
  const savedContentRef = useRef(initialSavedContent)
  // 编辑器当前内容（用 ref 而非 state，避免每次键入都重渲染导致光标跳末尾）
  const currentContentRef = useRef(initialContent)
  // 传给 CodeMirrorEditor 的初始内容（只有『外部重载』时才更新，不随用户键入变化）
  const [editorContent, setEditorContent] = useState(initialContent)

  const [saving, setSaving] = useState(false)
  const [saveOutcome, setSaveOutcome] = useState<SaveOutcome>('idle')
  const [loading, setLoading] = useState(false)
  const [showDialog, setShowDialog] = useState(false)
  const [checkingArch, setCheckingArch] = useState(false)
  const [fullArchStatus, setFullArchStatus] = useState<Record<string, boolean>>({})
  const [fullArchConfirmed, setFullArchConfirmed] = useState<Record<string, boolean>>({})
  const [synopsisSource, setSynopsisSource] = useState<PlotOutlineRangeSource>({ synopsis: '', totalChapters: 0, writingLanguage: 'zh-CN' })
  const lastCompletedArchitectureRunRef = useRef<string | null>(null)
  const [refreshBlockedMessage, setRefreshBlockedMessage] = useState<string | null>(null)
  const reloadGateRef = useRef(new ArchReloadGate())

  const isArchRunning = useWorkflowStore(s => s.isTypeRunning('architecture_generation'))
  const {
    snapshot: rosterSnapshot,
    repairError: rosterRepairError,
    isRepairing: extracting,
    refresh: loadCharacterRosterStatus,
    migrate: handleRepairCharacterRoster,
  } = useCharacterRosterRepair({ projectKey, enabled: isCharacterProjection })

  // 中文字数（由 CodeMirrorEditor 回调更新）
  const [charCount, setCharCount] = useState(0)

  // 脚状态（独立 state，不跟着 content 走）
  const [isDirty, setIsDirty] = useState(initialContent !== initialSavedContent)
  const visibleBlockedMessage = projectMatches
    ? refreshBlockedMessage
    : ARCH_PROJECT_MISMATCH_MESSAGE

  // 外部内容更新时的热重载（拦截 store.syncTabContent 带来的 props.content 更新）
  useEffect(() => {
    if (!projectMatches) return
    const decision = decideArchExternalRefresh({
      savedContent: savedContentRef.current,
      currentContent: currentContentRef.current,
    }, initialContent)
    if (decision.kind === 'blocked') {
      reassertBlockedArchEdit(
        useEditorStore.getState(),
        tabId,
        currentContentRef.current,
      )
      setRefreshBlockedMessage(ARCH_REFRESH_BLOCKED_MESSAGE)
      return
    }
    if (decision.kind === 'apply') {
      reloadGateRef.current.recordContentChange()
      setLoading(false)
      savedContentRef.current = initialContent
      currentContentRef.current = initialContent
      setEditorContent(initialContent)
      setIsDirty(false)
      setRefreshBlockedMessage(null)
    }
  }, [initialContent, projectMatches, tabId])


  // 内容变化回调：更新 ref，不触发重渲染，避免 content prop 回传导致光标跳末尾
  const handleChange = useCallback((md: string) => {
    if (isCharacterProjection) return
    reloadGateRef.current.recordContentChange()
    setLoading(false)
    setSaveOutcome('idle')
    currentContentRef.current = md
    const storeAction = archEditStoreAction({
      savedContent: savedContentRef.current,
      currentContent: md,
    })
    const dirty = storeAction === 'update-dirty'
    setIsDirty(dirty)
    // 同步 editor-store 的 tab.dirty，供标题栏警示灯、Tab 圆点、关闭确认使用
    writeArchEditState(useEditorStore.getState(), tabId, md, storeAction)
  }, [isCharacterProjection, tabId])

  /** 保存（统一走 ai-novel://core/ DB 路径） */
  const handleSave = useCallback(async (md: string, propagateFailure = false) => {
    if (isCharacterProjection) return
    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) {
      return
    }
    reloadGateRef.current.invalidate()
    setLoading(false)
    setSaving(true)
    setSaveOutcome('idle')
    const savedSnapshot = useEditorStore.getState().tabs.find(tab => tab.id === tabId)
    let submittedSnapshot = { content: md, contentRevision: savedSnapshot?.contentRevision ?? 0 }
    try {
      if (!resourceWriteAllowed(filePath)) throw new Error(text('资源只读或无效', 'This resource is read-only or invalid.'))
      if (recoveryRef.current) {
        const original = recoveryRef.current
        const session = recoverySession.current
        if (!session || !isProjectSessionCurrent(session)) throw new Error(text('项目会话已切换，请重新打开恢复稿', 'The project session changed. Reopen the recovery draft.'))
        const fresh = await ipc.invokeWithProjectSession(session, 'generation:read-context', { handle: original.handle })
        const progress = original.plotOutline
        const candidate = fresh.plotOutlineRecovery
        const tab = useEditorStore.getState().tabs.find(tab => tab.id === tabId)
        const operationId = tab?.planningSaveOperationId
        if (!progress || !candidate || !operationId || candidate.leaseEpoch !== session.leaseId) throw new Error(text('恢复内容暂时无法读取，请重新打开恢复稿', 'Recovery content is unavailable. Reopen the recovery draft.'))
        const pending = tab?.planningSaveSnapshot
        if (pending?.status === 'saved' || candidate.saved && !pending) throw new Error(text('本次恢复已保存，后续修改仅供复制。', 'This recovery is saved. Further edits can only be copied.'))
        if (candidate.writeState.kind !== 'ready' && !candidate.saved) throw new Error(text('当前无法保存，请等待生成结束或检查来源变化', 'Wait for generation to finish or check changed sources before saving.'))
        let submission = pending
        if (!submission) {
          const committedRange = { from: progress.range.from, to: Number(authorEndRef.current) }
          let synopsis = md.trimEnd()
          if (!validPlotOutlineAuthorPrefix(synopsis, progress, committedRange)) {
            const expected = progress.sourceExpected
            const title = renderPlotOutlineSynopsis('', expected.totalChapters, expected)
            const generatedTo = Math.min(progress.range.from + (progress.composition?.chapters?.length ?? 0), progress.range.to)
            const oldTail = renderPlotOutlineSynopsis('', generatedTo, expected).slice(title.length)
            if (oldTail && candidate.draft.endsWith(oldTail) && synopsis.endsWith(oldTail)) synopsis = synopsis.slice(0, -oldTail.length)
            synopsis = synopsis.trimEnd() + renderPlotOutlineSynopsis('', committedRange.to, expected).slice(title.length)
          }
          if (!validPlotOutlineAuthorPrefix(synopsis, progress, committedRange)) throw new Error(text('请保留连续完整章节，并移除所选保存终点之后的未完成内容。原有范围外内容须保持不变。', 'Keep complete consecutive chapters and remove incomplete content after the selected ending chapter. Preserve the original content outside this range.'))
          submission = {
            ...submittedSnapshot, status: 'pending', channel: 'db:project-core-synopsis-commit',
            request: { synopsis, expected: progress.sourceExpected,
              authorRecovery: { sourceHandle: candidate.sourceHandle, leaseEpoch: candidate.leaseEpoch, operationId, committedRange } },
          } satisfies PlanningRecoverySaveSnapshot
          useEditorStore.getState().setPlanningSaveSnapshot(tabId, submission)
        }
        if (submission.channel !== 'db:project-core-synopsis-commit') throw new Error('INVALID_PLANNING_SAVE_CHANNEL')
        const result = await ipc.invokeWithProjectSession(session, 'db:project-core-synopsis-commit', {
          ...submission.request, authorRecovery: { ...submission.request.authorRecovery, leaseEpoch: candidate.leaseEpoch },
        }, projectKey)
        if (!result.success && !pending && isProjectSessionCurrent(session)) useEditorStore.getState().setPlanningSaveSnapshot(tabId, undefined)
        requireIpcSuccess(result, '保存恢复大纲')
        if (!isProjectSessionCurrent(session)) return
        submittedSnapshot = { ...submission, content: submission.request.synopsis }
        const currentTab = useEditorStore.getState().tabs.find(tab => tab.id === tabId)
        if (submission.content !== submittedSnapshot.content && currentTab?.content === submission.content
          && (currentTab.contentRevision ?? 0) === submission.contentRevision && currentContentRef.current === submission.content) {
          currentContentRef.current = submittedSnapshot.content
          setEditorContent(submittedSnapshot.content)
          useEditorStore.getState().syncTabContent(tabId, submittedSnapshot.content)
          submittedSnapshot.contentRevision = useEditorStore.getState().tabs.find(tab => tab.id === tabId)?.contentRevision ?? 0
        }
        useEditorStore.getState().setPlanningSaveSnapshot(tabId, { ...submission, status: 'saved' })
        setRecoveryError('')
      } else if (filePath.startsWith('ai-novel://core/')) {
        const dbField = parseCoreField(filePath)
        if (!dbField) return
        requireIpcSuccess(await ipc.invokeWithProjectSession(
          projectSession,
          'db:project-core-update',
          { [dbField]: md },
          projectSession.projectPath,
        ), '保存架构文件')
      } else {
        // DB 化后架构文件不应有物理路径；如果意外触发，尝试 FS 写入兜底
        console.warn('[ArchFileViewer] 非预期的物理路径保存:', filePath)
        requireIpcSuccess(
          await ipc.invokeWithProjectSession(
            projectSession,
            'fs:write-file',
            filePath,
            md,
            projectSession.projectPath,
          ),
          '保存架构文件',
        )
      }
      if (isProjectSessionCurrent(projectSession)) {
        reloadGateRef.current.invalidate()
        setLoading(false)
        const savedContent = submittedSnapshot.content
        savedContentRef.current = savedContent
        if (recoveryRef.current) useEditorStore.getState().settleTabSave(tabId, submittedSnapshot)
        const settled = recoveryRef.current
          ? !useEditorStore.getState().tabs.find(tab => tab.id === tabId)?.dirty
          : didArchSaveSettle(savedContent, currentContentRef.current)
        if (settled) {
          setIsDirty(false)
          setRefreshBlockedMessage(null)
          if (!recoveryRef.current) useEditorStore.getState().markTabSaved(tabId, savedContent)
          setSaveOutcome('saved')
        } else {
          setIsDirty(true)
          if (!recoveryRef.current) useEditorStore.getState().updateTabContent(tabId, currentContentRef.current)
          setSaveOutcome('idle')
        }
        if (recoveryRef.current) await refreshRecovery()
      }
    } catch (error) {
      if (isProjectSessionCurrent(projectSession)) {
        if (recoveryRef.current) setRecoveryError(appErrorMessage(useLocaleStore.getState().locale, error))
        setSaveOutcome('failed')
        toast.error(appErrorMessage(useLocaleStore.getState().locale, error))
      }
      // Exit-save must reject so the caller cannot close an unsaved document.
      if (propagateFailure) throw error
    } finally {
      if (isProjectSessionCurrent(projectSession)) setSaving(false)
    }
  }, [filePath, isCharacterProjection, projectKey, tabId, refreshRecovery, text])

  useEffect(() => {
    if (isCharacterProjection) return
    // EditorArea unmounts the inactive tab. The store removes this handler only
    // when the tab itself closes, so an inactive dirty document can still save
    // during application exit.
    registerEditorExitSaveHandler({
      tabId,
      type: 'arch-file',
      projectKey,
      save: () => handleSave(currentContentRef.current, true),
    })
  }, [handleSave, isCharacterProjection, projectKey, tabId])

  /** 从 DB 重新加载（AI 生成后刷新用） */
  const handleReload = useCallback(async () => {
    if (recoveryRef.current) {
      try {
        await refreshRecovery()
        setRecoveryError('')
      } catch (error) {
        setRecoveryError(appErrorMessage(useLocaleStore.getState().locale, error))
      }
      return
    }
    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) {
      return
    }
    if (hasUnsavedArchEdit({
      savedContent: savedContentRef.current,
      currentContent: currentContentRef.current,
    })) {
      reassertBlockedArchEdit(
        useEditorStore.getState(),
        tabId,
        currentContentRef.current,
      )
      setRefreshBlockedMessage(ARCH_REFRESH_BLOCKED_MESSAGE)
      return
    }

    const reloadToken = reloadGateRef.current.begin()
    setLoading(true)
    try {
      let newContent = ''
      if (filePath.startsWith('ai-novel://core/')) {
        const core = await ipc.invokeWithProjectSession(
          projectSession,
          'db:project-core-get',
          projectSession.projectPath,
        )
        const dbField = parseCoreField(filePath)
        newContent = dbField && core
          ? String(core[dbField as keyof typeof core] ?? '')
          : ''
      } else {
        // 数据库存储后，架构文件不应再有物理路径。
        console.warn('[ArchFileViewer] 非预期的物理路径刷新:', filePath)
        const res = await ipc.invokeWithProjectSession(
          projectSession,
          'fs:read-file',
          filePath,
          projectSession.projectPath,
        )
        if (res.success) newContent = res.content
      }
      const currentTab = useEditorStore.getState().tabs.find(tab => tab.id === tabId)
      if (
        !reloadGateRef.current.isCurrent(reloadToken)
        || !isProjectSessionCurrent(projectSession)
        || currentTab?.projectKey !== projectKey
      ) {
        return
      }
      const decision = decideArchExternalRefresh({
        savedContent: savedContentRef.current,
        currentContent: currentContentRef.current,
      }, newContent)
      if (decision.kind === 'blocked') {
        reassertBlockedArchEdit(
          useEditorStore.getState(),
          tabId,
          currentContentRef.current,
        )
        setRefreshBlockedMessage(ARCH_REFRESH_BLOCKED_MESSAGE)
        return
      }
      if (decision.kind === 'apply') {
        savedContentRef.current = decision.content
        currentContentRef.current = decision.content
        setEditorContent(decision.content)
        setIsDirty(false)
        setRefreshBlockedMessage(null)
        useEditorStore.getState().markTabSaved(tabId, decision.content)
      }
    } catch (error) {
      if (
        reloadGateRef.current.isCurrent(reloadToken)
        && isProjectSessionCurrent(projectSession)
      ) {
        console.warn('[ArchFileViewer] 架构文档刷新失败:', error)
      }
    } finally {
      if (reloadGateRef.current.isCurrent(reloadToken) && isProjectSessionCurrent(projectSession)) {
        setLoading(false)
      }
    }
  }, [filePath, projectKey, tabId, refreshRecovery])

  useEffect(() => {
    const reloadGate = reloadGateRef.current
    return () => {
      reloadGate.invalidate()
    }
  }, [])

  // 监听架构生成完成事件，自动刷新当前页面
  useEffect(() => {
    return globalEventBus.on('WORKFLOW_COMPLETE', (payload) => {
      const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
      if (!projectSession || !isProjectSessionCurrent(projectSession)) return
      if (!shouldRefreshArchOnWorkflowComplete(
        payload,
        projectSession,
        lastCompletedArchitectureRunRef.current,
      )) return
      lastCompletedArchitectureRunRef.current = payload.runId
      void handleReload()
      void loadCharacterRosterStatus()
    })
  }, [handleReload, loadCharacterRosterStatus, projectKey])

  /** 确认后启动架构生成工作流 */
  const handleConfirm = async (
    selectedSteps: ArchStepKey[],
    stepGuidance: Record<string, string>,
    synopsisRange?: { from: number; to: number },
    targetUnits?: number,
  ) => {
    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey) || !isProjectSessionCurrent(projectSession)) {
      throw new Error(text('项目会话已切换，未启动架构生成', 'The project session changed, so architecture generation did not start.'))
    }
    await launchCreativeWorkflow({
      workflow: 'generate_architecture',
      selectedSteps,
      stepGuidance,
      synopsisRange,
      targetUnits,
    }, projectSession)
  }

  const handleOpenDialog = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!stepKey || !projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) {
      return
    }
    setCheckingArch(true)
    try {
      const core = await ipc.invokeWithProjectSession(
        projectSession,
        'db:project-core-get',
        projectSession.projectPath,
      )
      if (!isProjectSessionCurrent(projectSession)) return
      const source = archOutlineSource(core, currentProject?.novelConfig)
      // 分批检查点只用来认出被打断的一批；读不到时与架构页一样按没有检查点判定。
      // 名单视图的 hook 只在角色页启用，其他文档页要直接读库，否则就绪的名单会被当成新生成并默认勾选重写。
      const [checkpoint, roster] = await Promise.all([
        readArchCheckpoint(projectSession),
        ipc.invokeWithProjectSession(projectSession, 'db:character-roster-read', projectSession.projectPath),
      ])
      if (!isProjectSessionCurrent(projectSession)) return
      // 有内容决定覆盖还是新生成，已确认决定默认勾选；两者与架构页共用 judgeArchCore。
      const judged = judgeArchCore(core, outlineProgress(source.synopsis, checkpoint, source.writingLanguage, source.totalChapters).kind)
      const rosterReady = roster.status === 'ready'
      const status: Record<string, boolean> = { ...judged.hasContent, characters: rosterReady }
      const confirmed: Record<string, boolean> = { ...judged.confirmed, characters: rosterReady }
      // 当前文件在编辑器里有未保存的内容时，生成会覆盖它而不是新生成。是否已确认只影响默认勾选，而当前文件总是勾选的，不必按编辑器内容再判。
      if (archSectionHasContent(currentContentRef.current)) status[stepKey] = true
      setFullArchStatus(status)
      setFullArchConfirmed(confirmed)
      setSynopsisSource(source)
      setShowDialog(true)
    } catch (error) {
      if (isProjectSessionCurrent(projectSession)) {
        console.warn('[ArchFileViewer] 检查架构状态失败:', error)
      }
    } finally {
      if (isProjectSessionCurrent(projectSession)) setCheckingArch(false)
    }
  }

  const continuePlanning = async () => {
    if (continuing || saving) return
    setContinuing(true)
    try {
      const next = await refreshRecovery()
      const continuation = next?.planningContinuation
      const session = recoverySession.current
      if (!session || !isProjectSessionCurrent(session) || !continuation?.remainingRange
        || !['ready', 'continued'].includes(continuation.state)) throw new Error(text('当前不能继续，请先保存完整章节或等待生成结束', 'Save completed chapters or wait for generation to finish before continuing.'))
      await useWorkflowStore.getState().startWorkflow(createArchitectureWorkflow({
        projectPath: projectKey, projectSession: session, selectedSteps: ['synopsis'],
        synopsisRange: continuation.remainingRange, targetUnits: continuation.targetUnits, restartFrom: continuation.sourceHandle,
      }))
      await refreshRecovery()
    } catch (error) { setRecoveryError(appErrorMessage(useLocaleStore.getState().locale, error)) }
    finally { setContinuing(false) }
  }
  const generated = initialContent.length > 50 && !initialContent.includes('待生成')

  const rosterPresentation = stepKey === 'characters'
    ? getCharacterRosterRepairPresentation(rosterSnapshot, text, rosterRepairError)
    : null
  const canRepairRoster = canExplicitlyRepairCharacterRoster(rosterPresentation)
  const discardCharacterProjectionDraft = useCallback(() => {
    if (!isCharacterProjection) return
    // 旧版未保存 Markdown 草稿仍停留在只读编辑器中，作者可先复制。只有
    // 明确点击后才放弃该草稿并接受当前确定性投影。
    const projection = rosterSnapshot?.renderedMarkdown ?? initialSavedContent
    savedContentRef.current = projection
    currentContentRef.current = projection
    setEditorContent(projection)
    setIsDirty(false)
    writeArchEditState(useEditorStore.getState(), tabId, projection, 'sync-saved')
  }, [initialSavedContent, isCharacterProjection, rosterSnapshot?.renderedMarkdown, tabId])

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* 工具栏（背景与编辑区一致，内嵌在内容区中而非独立标题栏） */}
      <div
        className="flex items-center justify-between gap-2 px-3 h-9 flex-shrink-0"
        style={{
          borderBottom: '1px solid var(--color-border)',
          backgroundColor: 'var(--color-editor-bg)',
        }}
      >
        {/* 左侧：Emoji + 标题 + 描述 */}
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="flex-shrink-0" style={{ color: 'var(--color-text-muted)', opacity: 0.6 }}>{meta ? renderIcon(meta.iconName, 14) : <FileText size={14} />}</span>
          <span className="text-xs font-medium flex-shrink-0" style={{ color: 'var(--color-text-secondary)' }}>
            {meta ? text(...meta.view) : text('架构文档', 'Architecture document')}
          </span>
          {meta && (
            <span className="text-xs truncate hidden sm:inline" style={{ color: 'var(--color-text-muted)' }}>
              — {text(meta.desc, meta.descEn)}
            </span>
          )}
        </div>

        {/* 右侧：字数 + 状态 + 操作按钮 */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {isCharacterProjection && (
            <CharacterCardImportButton projectKey={projectKey} disabled={!projectMatches} />
          )}

          {/* 字数 */}
          {charCount > 0 && (
            <span className="text-xs tabular-nums" style={{ color: 'var(--color-text-muted)' }}>
              {charCount.toLocaleString()} {text('字', 'characters')}
            </span>
          )}

          {/* 保存状态 */}
          {saving && (
            <span className="text-xs" style={{ color: 'var(--color-accent)' }}>{text('保存中...', 'Saving...')}</span>
          )}
          {isDirty && !saving && (
            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: 'var(--color-warning)' }} title={text('有未保存的修改', 'Unsaved changes')} />
          )}
          <SaveFeedback dirty={isDirty} saving={saving} outcome={saveOutcome} />

          {/* 刷新按钮 */}
          <Button
            variant="ghost"
            size="icon"
            onClick={handleReload}
            title={text('从磁盘重新加载（AI 生成完成后可点击刷新）', 'Reload from disk (refresh after AI generation completes)')}
            disabled={loading || !projectMatches}
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </Button>

          {/* 保存按钮（有修改时才显示） */}
          {!isCharacterProjection && isDirty && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => { void handleSave(currentContentRef.current) }}
              disabled={saving || !projectMatches || recoveryTab?.planningSaveSnapshot?.status === 'saved' || Boolean(recovery && recovery.plotOutlineRecovery?.writeState.kind !== 'ready' && !(recovery.plotOutlineRecovery?.saved && recoveryTab?.planningSaveSnapshot?.status === 'pending'))}
              title={text('保存（Cmd+S）', 'Save (Cmd+S)')}
            >
              <Save size={12} />
              {text('保存', 'Save')}
            </Button>
          )}

          {/* 旧项目只可显式安全修复；不再从 Markdown 标题/排版提取角色卡。 */}
          {stepKey === 'characters' && canRepairRoster && !isArchRunning && rosterPresentation?.actionLabel && (
            <Button
              size="sm"
              disabled={extracting || !projectMatches}
              onClick={() => { void handleRepairCharacterRoster() }}
              className="gap-1.5 bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow-sm hover:from-amber-600 hover:to-orange-600 border-none hover:shadow hover:-translate-y-[0.5px] transition-all"
              title={rosterPresentation.actionTitle}
            >
              {extracting
                ? <RefreshCw size={12} className="animate-spin opacity-90" />
                : <AlertTriangle size={12} className="opacity-90" />
              }
              {extracting ? text('处理中...', 'Working...') : rosterPresentation.actionLabel}
            </Button>
          )}

          {/* AI 生成按钮 */}
          {stepKey && meta && !recovery && (
            <Button
              variant="ai"
              size="sm"
              onClick={handleOpenDialog}
              disabled={checkingArch || !projectMatches}
              title={generated
                ? text(`AI 重新生成「${ARCH_STEP_NAMES[stepKey][0]}」`, `AI Regenerate “${ARCH_STEP_NAMES[stepKey][1]}”`)
                : text(`AI 生成「${ARCH_STEP_NAMES[stepKey][0]}」`, `AI Generate “${ARCH_STEP_NAMES[stepKey][1]}”`)}
            >
              {checkingArch ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
              {generated ? text('AI 重新生成', 'AI Regenerate') : text('AI 生成', 'AI Generate')}
            </Button>
          )}
        </div>
      </div>

      {recovery && <div className="px-3 py-2 text-xs space-y-2" aria-label={text('大纲恢复', 'Outline recovery')}>
        {recoveryTab?.planningSaveSnapshot?.status === 'saved' && <p>{text('本次恢复已保存，后续修改仅供复制。', 'This recovery is saved. Further edits can only be copied.')}</p>}
        <p>{text('这是可编辑的恢复稿。保存只写入本地，不会调用模型。请用“## 第1章：标题”这样的章标题，保留连续完整章节。', 'Edit this recovery draft. Saving is local and does not call a model. Keep complete consecutive chapters with headings such as “## Chapter 1: Title”.')}</p>
        <label>{text('保存到第几章', 'Last complete chapter')} <input type="number" min={recovery.plotOutline?.range.from} max={recovery.plotOutline?.range.to} value={authorEnd} onChange={event => {
          const value = event.target.value
          authorEndRef.current = value; setAuthorEnd(value)
          useEditorStore.setState(state => ({ tabs: state.tabs.map(tab => tab.id === tabId ? { ...tab, planningSaveEnd: value } : tab) }))
        }} /></label>
        <p>{recovery.planningContinuation?.remainingRange
          ? planningRemainingText(recovery.planningContinuation.remainingRange, recovery.planningContinuation.targetUnits, planningTargetUnit, text)
          : text('本次所选章节已保存。', 'The selected chapters are saved.')}</p>
        {recovery.plotOutlineRecovery?.writeState.kind === 'blocked' && <p>{outlineSourceInvalidNote(recovery, locale) ?? outlineSourceChangedNote(recovery, locale) ?? text('生成尚在进行、来源已变化或本稿已保存时，不能覆盖正式内容。草稿仍可编辑和复制。', 'Active generation, changed sources or an already saved draft prevent replacing saved content. You can still edit and copy this draft.')}</p>}
        <button type="button" className="btn-secondary" disabled={continuing || saving || !projectMatches || !recovery.planningContinuation?.remainingRange || !['ready', 'continued'].includes(recovery.planningContinuation.state)} onClick={() => { void continuePlanning() }}>{text('继续生成缺少的章节', 'Generate remaining chapters')}</button>
        <details><summary>{text('原始候选', 'Original candidate')}</summary><pre className="whitespace-pre-wrap max-h-40 overflow-auto">{recoveryTab?.originalContent}</pre></details>
        {recoveryError && <p role="alert">{recoveryError}</p>}
      </div>}

      {projectMatches && stepKey === 'characters' && <LegacyRosterRecoveryPanel onRecover={handleRepairCharacterRoster} busy={extracting} />}
      {stepKey === 'characters' && rosterPresentation && (
        <div
          role="status"
          className="flex items-start gap-2 px-3 py-2 text-xs"
          style={{
            color: rosterPresentation.kind === 'ready' || rosterPresentation.kind === 'empty'
              ? 'var(--color-text-secondary)'
              : 'var(--color-warning-text)',
            backgroundColor: 'var(--color-editor-bg)',
            borderBottom: '1px solid var(--color-border)',
          }}
        >
          {rosterPresentation.kind === 'ready' || rosterPresentation.kind === 'empty'
            ? <FileText size={13} className="flex-shrink-0 mt-0.5" />
            : <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />}
          <span><strong>{rosterPresentation.label}</strong> · {rosterPresentation.description}</span>
        </div>
      )}

      {isCharacterProjection && (
        <div
          role="note"
          className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
          style={{
            color: 'var(--color-text-secondary)',
            backgroundColor: 'var(--color-editor-bg)',
            borderBottom: '1px solid var(--color-border)',
          }}
        >
          <span>{text('这是角色名单的只读全文，由名单自动生成。修改角色身份、档案和关系请到「角色名单」页。', 'This is the read-only text of the cast, generated from it. Edit identities, profiles and relationships on the Cast page.')}</span>
          {isDirty && (
            <Button
              variant="outline"
              size="sm"
              onClick={discardCharacterProjectionDraft}
              title={text('旧草稿可先复制；点击后明确放弃并加载当前的角色名单全文', 'Copy the legacy draft first; this explicitly discards it and loads the current cast text.')}
            >
              {text('放弃旧草稿并加载投影', 'Discard draft and load projection')}
            </Button>
          )}
        </div>
      )}

      {visibleBlockedMessage && (
        <div
          role="status"
          className="flex items-center gap-2 px-3 py-2 text-xs"
          style={{
            color: 'var(--color-warning-text)',
            backgroundColor: 'var(--color-editor-bg)',
            borderBottom: '1px solid var(--color-border)',
          }}
        >
          <AlertTriangle size={13} className="flex-shrink-0" />
          <span>{visibleBlockedMessage}</span>
        </div>
      )}

      {/* CodeMirrorEditor document 模式，隐藏底部栏（信息已整合到上方工具栏） */}
      <div className="flex-1 overflow-hidden">
        <CodeMirrorEditor
          mode="document"
          content={isCharacterProjection && rosterSnapshot?.status === 'ready' ? castTextForView(editorContent) : editorContent}
          filePath={filePath}
          editable={!isCharacterProjection}
          onChange={isCharacterProjection ? undefined : handleChange}
          onSave={isCharacterProjection ? undefined : handleSave}
          onCharCountChange={setCharCount}
          hideStatusBar
          placeholder={text(
            '尚未生成内容，点击右上角「AI 生成」或直接在此编辑...',
            'No content yet. Click “AI Generate” in the top-right or start editing here...',
          )}
        />
      </div>

      {/* AI 生成确认弹窗 */}
      {stepKey && (
        <ArchitectureConfirmDialog
          isOpen={showDialog}
          onClose={() => setShowDialog(false)}
          archStatus={fullArchStatus}
          confirmed={fullArchConfirmed}
          synopsisSource={synopsisSource}
          initialSelectedSteps={[stepKey]}
          onConfirm={handleConfirm}
        />
      )}
    </div>
  )
}
