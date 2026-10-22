import { useCallback, useEffect, useRef, useState } from 'react'
import { formatResourceUri, parseResourceUri, resourceWriteAllowed } from '../../shared/project-paths'
import { useProjectStore } from '../../stores/project-store'
import { registerEditorExitSaveHandler, useEditorStore } from '../../stores/editor-store'
import { useWorkflowStore, workflowResourceKey } from '../../stores/workflow-store'
import { useLocaleStore } from '../../stores/locale-store'
import { toast } from '../ui/Toast'
import { displayedErrorMessage, englishWithReason } from '../../i18n/app-errors'
import {
  parseDraftMeta,
  type DraftMeta,
  type DraftStatus,
  type FrozenDraftSourceIdentity,
} from '../../services/workflows/chapter-workflow'
import { getPendingRevisions, getReviewsForVersion, type ReviewEntry, type RevisionEntry } from '../../services/draft-index'
import { isRevisionSourceCurrent, refreshChapterFacts } from '../../stores/navigation/chapter-facts'
import { readDraftBody } from '../../stores/draft-store'
import { ipc } from '../../services/ipc-client'
import { retryFinalizationPublication } from '../../services/finalization-client'
import { captureFinalizationSnapshot } from '../../services/finalization-snapshot'
import { countDraftUnits } from '../../shared/draft-units'
import { globalEventBus } from '../../shared/event-bus'
import { sameProjectSessionContext } from '../../shared/project-session-context'
import type { SaveOutcome } from './save-feedback'
import { guardRepairPostProcess } from '../../services/workflow-guards'
import {
  captureProjectSession,
  isProjectSessionCurrent,
  isProjectSessionPath,
} from '../project-session-gate'

type Text = (zh: string, en: string) => string

/** 审稿的检查维度。promptLabel 是交给工作流的固定中文名，不随界面语言变化。 */
export function reviewDimensions(text: Text) {
  return [
    { key: 'continuity', label: text('剧情连贯性', 'Story continuity'), desc: text('与前文是否矛盾', 'Consistency with earlier chapters'), promptLabel: '剧情连贯性' },
    { key: 'logic', label: text('剧情合理性', 'Story logic'), desc: text('因果逻辑、动机、常识', 'Causality, motivation, and plausibility'), promptLabel: '剧情合理性' },
    { key: 'character', label: text('角色状态', 'Character state'), desc: text('能力/位置/情感一致性', 'Ability, location, and emotional consistency'), promptLabel: '角色状态' },
    { key: 'foreshadow', label: text('前后章节串联', 'Chapter connections'), desc: text('伏笔、悬念连贯', 'Foreshadowing and suspense continuity'), promptLabel: '前后章节串联' },
  ]
}

export type DraftChapterMeta = DraftMeta & { chapterTitle?: string; filePath?: string }

export interface MergeData {
  originalContent: string
  modifiedContent: string
  revisionPath: string
  targetSnapshot: { content: string; contentRevision: number }
  staleReason: string | null
}

interface DraftTarget {
  tabId: string
  filePath: string
  content: string
  projectKey: string
}

/**
 * 一稿草稿的数据与动作：元数据、待合并修稿、审稿记录，以及保存、AI 修稿、AI 审稿、定稿、实体稿重试、修复定稿与修稿合并。
 * 单章视图用它。
 * 所有动作都以标签里的正文为准（含未保存的修改），并在每次异步之后核对项目会话。
 */
export function useDraftActions({ tabId, filePath, content, projectKey }: DraftTarget) {
  const [meta, setMeta] = useState<DraftChapterMeta | null>(null)
  const editorTab = useEditorStore(
    state => state.tabs.find(tab => tab.id === tabId && tab.projectKey === projectKey),
  )
  const currentProject = useProjectStore(s => s.currentProject)
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const projectMatches = currentProject?.path === projectKey
  const tabDraftStatus = editorTab?.draftStatus
  const [pendingRevisions, setPendingRevisions] = useState<RevisionEntry[]>([])
  const [reviews, setReviews] = useState<ReviewEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [mergeData, setMergeData] = useState<MergeData | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveOutcome, setSaveOutcome] = useState<SaveOutcome>('idle')
  const currentBodyRef = useRef(content)

  const reload = useCallback(() => setReloadKey(key => key + 1), [])
  // 打开修稿合并要先读修订与源稿；读的过程中作者关掉了合并或已合并完，晚到的结果不再摆出来。
  const mergeRequest = useRef(0)
  const closeMerge = useCallback(() => {
    mergeRequest.current += 1
    setMergeData(null)
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const projectSession = captureProjectSession(currentProject)
      if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) return
      const m = await parseDraftMeta(filePath, projectKey, projectSession)
      if (cancelled || !isProjectSessionCurrent(projectSession) || !m) return
      const bps = await ipc.invokeWithProjectSession(
        projectSession,
        'db:blueprint-get-all',
        projectSession.projectPath,
      )
      if (cancelled || !isProjectSessionCurrent(projectSession)) return
      const bp = Array.isArray(bps) ? bps.find((b: unknown) => (b as { chapterNumber?: number }).chapterNumber === m.chapterNumber) : null
      setMeta({ ...m, chapterTitle: bp ? (bp as { title?: string }).title : undefined, filePath, fileName: `v${m.version}`, createdAt: m.updatedAt ?? m.createdAt })
      // 使用 DB 化的虚拟 chapterDir（用于 draft-index 兼容层解析章节号）
      const chapterDir = `ai-novel://draft/ch${m.chapterNumber}`
      const [pending, versionReviews] = await Promise.all([
        getPendingRevisions(chapterDir, m.version, projectKey),
        getReviewsForVersion(chapterDir, m.version, projectKey),
        refreshChapterFacts([m], projectSession),
      ])
      if (cancelled || !isProjectSessionCurrent(projectSession)) return
      setPendingRevisions(pending)
      setReviews(versionReviews)
      setLoaded(true)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [currentProject, filePath, projectKey, reloadKey])

  // 审稿、修稿、定稿等工作流结束后，这一稿的审稿记录与待合并修稿可能变了。
  useEffect(() => globalEventBus.on('WORKFLOW_COMPLETE', ({ projectSession }) => {
    if (sameProjectSessionContext(projectSession, captureProjectSession(useProjectStore.getState().currentProject))) reload()
  }), [reload])

  const status: DraftStatus = tabDraftStatus ?? meta?.status ?? 'draft'
  const isReadonly = status === 'finalized' || status === 'archived' || !resourceWriteAllowed(filePath)

  const activeRuns = useWorkflowStore(s => s.activeRuns)
  // 按运行占用的章节资源判断归属；标题随界面语言变化，英文界面里没有「第N章」。
  const activeChapterRun = activeRuns.find(r =>
    r.projectPath === projectKey
    && r.type === 'chapter_creation'
    && meta
    && r.resourceKeys?.includes(workflowResourceKey('chapter', meta.chapterNumber))
  )
  const isChapterBusy = !!activeChapterRun
  const isDirty = editorTab?.dirty ?? false
  const finalizationPending = editorTab?.finalizationPublication === 'pending'
  const finalizationConflict = editorTab?.finalizationConflict

  const onBodyChange = (body: string) => {
    currentBodyRef.current = body
    setSaveOutcome('idle')
    useEditorStore.getState().updateTabContent(tabId, body)
  }

  /** 保存（ai-novel://draft/ 走 DB，其他走 FS） */
  const save = async (draftContent: string, propagateFailure = false) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    const targetTab = useEditorStore.getState().tabs.find(
      tab => tab.id === tabId && tab.projectKey === projectKey,
    )
    if (
      !targetTab
      || targetTab.draftStatus === 'finalized'
      || targetTab.draftStatus === 'archived'
      || status === 'finalized'
      || status === 'archived'
    ) return
    const saveSnapshot = {
      content: targetTab.content ?? draftContent,
      contentRevision: targetTab.contentRevision ?? 0,
    }
    setSaving(true)
    setSaveOutcome('idle')
    try {
      const resource = parseResourceUri(filePath)
      if (!resourceWriteAllowed(filePath) || resource?.kind !== 'draft') throw new Error(text('资源只读或无效', 'This resource is read-only or invalid.'))
      const result = await ipc.invokeWithProjectSession(
        projectSession,
        'db:draft-update-content',
        resource.id,
        saveSnapshot.content,
        countDraftUnits(saveSnapshot.content),
        projectSession.projectPath,
      )
      if (!result.success) throw new Error(result.error || text('草稿保存失败', 'Could not save the draft'))
      if (!isProjectSessionCurrent(projectSession)) return
      const currentTab = useEditorStore.getState().tabs.find(
        tab => tab.id === tabId && tab.projectKey === projectKey,
      )
      if (currentTab) {
        useEditorStore.getState().settleTabSave(currentTab.id, saveSnapshot)
        const settledTab = useEditorStore.getState().tabs.find(tab => tab.id === currentTab.id)
        setSaveOutcome(settledTab?.dirty ? 'idle' : 'saved')
      }
      // 待合并的修稿按保存的正文判断能否合并，正文变了就要重读。
      if (pendingRevisions.length > 0) reload()
    } catch (error) {
      if (isProjectSessionCurrent(projectSession)) {
        setSaveOutcome('failed')
        toast.error(displayedErrorMessage(locale, error, text('草稿保存失败', 'Could not save the draft')))
      }
      if (propagateFailure) throw error
    } finally {
      if (isProjectSessionCurrent(projectSession)) setSaving(false)
    }
  }

  const exitSaveRef = useRef(save)
  useEffect(() => {
    exitSaveRef.current = save
  })
  useEffect(() => {
    registerEditorExitSaveHandler({
      tabId,
      type: 'chapter',
      projectKey,
      save: () => exitSaveRef.current(currentBodyRef.current, true),
    })
  }, [projectKey, tabId])

  const freezeDraftSourceForAI = async (projectSession: NonNullable<ReturnType<typeof captureProjectSession>>) => {
    if (!meta) return null
    const targetTab = useEditorStore.getState().tabs.find(
      tab => tab.id === tabId && tab.projectKey === projectKey,
    )
    if (!targetTab || (targetTab.draftId !== undefined && targetTab.draftId !== meta.id)) {
      toast.warning(text(
        '当前草稿身份已变化，请重新打开后再执行 AI 操作',
        'The current draft identity changed. Reopen it before running the AI action.',
      ))
      return null
    }
    const body = targetTab.content ?? currentBodyRef.current
    const sourceDraft = Object.freeze({
      id: meta.id,
      chapterNumber: meta.chapterNumber,
      version: meta.version,
      status: targetTab.draftStatus ?? meta.status,
      contentRevision: targetTab.contentRevision ?? 0,
    })

    if (targetTab.dirty) await save(body, true)
    if (!isProjectSessionCurrent(projectSession)) return null
    return Object.freeze({ body, sourceDraft })
  }

  const isFrozenAISourceCurrent = (
    body: string,
    sourceDraft: FrozenDraftSourceIdentity,
  ): boolean => {
    const currentTab = useEditorStore.getState().tabs.find(
      tab => tab.id === tabId && tab.projectKey === projectKey,
    )
    if (
      !currentTab
      || currentTab.content !== body
      || (currentTab.contentRevision ?? 0) !== sourceDraft.contentRevision
      || (currentTab.draftId !== undefined && currentTab.draftId !== sourceDraft.id)
      || (currentTab.chapterNumber !== undefined && currentTab.chapterNumber !== sourceDraft.chapterNumber)
      || (currentTab.draftStatus !== undefined && currentTab.draftStatus !== sourceDraft.status)
    ) {
      toast.warning(text(
        '确认后正文已变化，本次 AI 操作未启动',
        'The draft changed after confirmation, so the AI action was not started.',
      ))
      return false
    }
    return true
  }

  /** 执行 AI 修稿（含用户自定义提示词） */
  const refine = async (userRefinePrompt: string) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !currentProject || !meta || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    try {
      const source = await freezeDraftSourceForAI(projectSession)
      if (!source || !isProjectSessionCurrent(projectSession)) return
      const { createRefineOnlyWorkflow } = await import('../../services/workflows/chapter-workflow')
      if (!isProjectSessionCurrent(projectSession)) return
      if (!isFrozenAISourceCurrent(source.body, source.sourceDraft)) return

      useWorkflowStore.getState().startWorkflow(createRefineOnlyWorkflow({
        projectPath: projectSession.projectPath,
        chapterNumber: meta.chapterNumber,
        chapterTitle: meta.chapterTitle ?? '未知标题',
        draftPath: filePath,
        draftContent: source.body,
        sourceDraft: source.sourceDraft,
        userRefinePrompt: userRefinePrompt.trim() || undefined,
      }, projectSession), false)
    } catch (e) {
      if (!isProjectSessionCurrent(projectSession)) return
      const reason = displayedErrorMessage(useLocaleStore.getState().locale, e)
      toast.error(text(`修稿启动失败：${reason}`, englishWithReason('Could not start AI revision.', reason)))
    }
  }

  /** 执行 AI 审稿；reviewFocus 是勾选维度的 promptLabel 以顿号连接，全不勾时为空。 */
  const review = async (reviewFocus: string | undefined) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !currentProject || !meta || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    try {
      const source = await freezeDraftSourceForAI(projectSession)
      if (!source || !isProjectSessionCurrent(projectSession)) return
      const { createReviewOnlyWorkflow } = await import('../../services/workflows/chapter-workflow')
      if (!isProjectSessionCurrent(projectSession)) return
      if (!isFrozenAISourceCurrent(source.body, source.sourceDraft)) return

      useWorkflowStore.getState().startWorkflow(createReviewOnlyWorkflow({
        projectPath: projectSession.projectPath,
        chapterNumber: meta.chapterNumber,
        chapterTitle: meta.chapterTitle ?? '未知标题',
        draftPath: filePath,
        draftContent: source.body,
        sourceDraft: source.sourceDraft,
        reviewFocus,
      }, projectSession), false)
    } catch (e) {
      if (!isProjectSessionCurrent(projectSession)) return
      const reason = displayedErrorMessage(useLocaleStore.getState().locale, e)
      toast.error(text(`审稿启动失败：${reason}`, englishWithReason('Could not start AI review.', reason)))
    }
  }

  /**
   * 能否定稿：项目、元数据就位，本章没有写作任务在跑，也没有进行中的定稿或待处理的定稿冲突（ADR 0003 要求冲突显式保留，
   * 再定稿会清掉它）。所有定稿入口都看这一项，finalize 自己也再查一次。
   */
  const canFinalize = Boolean(projectMatches && currentProject && meta && !isChapterBusy && !finalizationConflict && !finalizationPending)

  /** 定稿：冻结标签里可见的正文（含未保存的修改）作为提交快照。 */
  const finalize = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!canFinalize || !currentProject || !meta || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    try {
      const { createFinalizeWorkflow } = await import('../../services/workflows/chapter-workflow')
      if (!isProjectSessionCurrent(projectSession)) return
      const targetTab = useEditorStore.getState().tabs.find(
        tab => tab.id === tabId && tab.projectKey === projectKey,
      )
      if (!targetTab) {
        throw new Error(text('当前草稿或项目会话已失效，无法冻结定稿内容', 'The draft or project session is no longer available.'))
      }
      const snapshot = captureFinalizationSnapshot({
        tab: {
          ...targetTab,
          // 老标签可能尚未填入这两个数据库身份；只能从已解析的当前标签元数据补齐，
          // 正文仍严格取编辑器可见值，不再回读 SQLite。
          draftId: targetTab.draftId ?? meta.id,
          chapterNumber: targetTab.chapterNumber ?? meta.chapterNumber,
          content: targetTab.content ?? currentBodyRef.current,
        },
        projectSession,
        chapterTitle: meta.chapterTitle ?? '未知标题',
      })
      if (!isProjectSessionCurrent(projectSession)) return
      useEditorStore.setState(state => ({
        tabs: state.tabs.map(tab => tab.id === snapshot.tabId && tab.projectKey === snapshot.projectPath
          ? {
              ...tab,
              draftId: snapshot.draftId,
              chapterNumber: snapshot.chapterNumber,
              projectSessionLease: snapshot.projectSession.leaseId,
              finalizationConflict: undefined,
            }
          : tab),
      }))

      if (!isProjectSessionCurrent(projectSession)) return
      useWorkflowStore.getState().startWorkflow(createFinalizeWorkflow({
        projectPath: projectSession.projectPath,
        chapterNumber: meta.chapterNumber,
        chapterTitle: meta.chapterTitle ?? '未知标题',
        draftPath: filePath,
        draftContent: snapshot.content,
        snapshot,
      }, projectSession), false)
    } catch (e) {
      if (!isProjectSessionCurrent(projectSession)) return
      const reason = displayedErrorMessage(useLocaleStore.getState().locale, e)
      toast.error(text(`定稿启动失败：${reason}`, englishWithReason('Could not start finalization.', reason)))
    }
  }

  /** 实体稿失败后只按已提交的 finalizationId 重试；不再交回正文或路径。 */
  const retryManuscriptPublication = useCallback(async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    const finalizationId = useEditorStore.getState().tabs.find(
      tab => tab.id === tabId && tab.projectKey === projectKey,
    )?.finalizationId
    if (!finalizationId) return
    try {
      const result = await retryFinalizationPublication(finalizationId, projectSession)
      if (!isProjectSessionCurrent(projectSession)) return
      if (!result.success) {
        throw new Error(result.error || text('实体稿发布仍未完成', 'Manuscript publication is not complete.'))
      }
      useEditorStore.setState(state => ({
        tabs: state.tabs.map(tab => tab.id === tabId
          && tab.projectKey === projectKey
          && tab.finalizationId === finalizationId
          ? { ...tab, finalizationPublication: 'published' }
          : tab),
      }))
      toast.success(text('实体稿已发布', 'Manuscript published'))
    } catch (error) {
      if (!isProjectSessionCurrent(projectSession)) return
      const reason = displayedErrorMessage(useLocaleStore.getState().locale, error)
      toast.error(text(`实体稿发布失败：${reason}`, englishWithReason('Could not publish the manuscript.', reason)))
    }
  }, [currentProject, projectKey, tabId, text])

  /** 修复定稿后处理 — 不传 stepKey 时只重跑失败的步骤 */
  const repairFinalize = useCallback(async (stepKey?: string) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !currentProject || !meta || isChapterBusy || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    try {
      const guard = await guardRepairPostProcess(meta.chapterNumber, projectKey, projectSession)
      if (!isProjectSessionCurrent(projectSession)) return
      if (!guard.ok) {
        toast.error(locale === 'zh-CN'
          ? displayedErrorMessage(locale, guard.message, text('无法执行修复', 'Could not run the repair.'))
          : text('无法执行修复', 'Could not run the repair.'))
        return
      }
      const { createRepairFinalizeWorkflow } = await import('../../services/workflows/chapter-workflow')
      if (!isProjectSessionCurrent(projectSession)) return
      useWorkflowStore.getState().startWorkflow(
        createRepairFinalizeWorkflow(meta.chapterNumber, projectSession.projectPath, projectSession, stepKey),
        false,
      )
    } catch (e) {
      if (!isProjectSessionCurrent(projectSession)) return
      const reason = displayedErrorMessage(useLocaleStore.getState().locale, e)
      toast.error(text(`修复启动失败：${reason}`, englishWithReason('Could not start the repair.', reason)))
    }
  }, [currentProject, isChapterBusy, locale, meta, projectKey, projectMatches, text])

  /** 读出待合并修稿与它的真实冻结源，交给合并视图；正文有未保存修改或读取期间变了就不打开。 */
  const openPendingRevision = async (rev: RevisionEntry) => {
    const request = ++mergeRequest.current
    const projectSession = captureProjectSession(currentProject)
    if (!meta || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    const targetTab = useEditorStore.getState().tabs.find(
      tab => tab.id === tabId && tab.projectKey === projectKey,
    )
    if (!targetTab || targetTab.dirty) {
      toast.warning(text(
        '当前正文有未保存修改，请先保存并重新打开修订对比',
        'The draft has unsaved changes. Save it and reopen the revision comparison.',
      ))
      return
    }
    const targetSnapshot = {
      content: targetTab.content ?? content,
      contentRevision: targetTab.contentRevision ?? 0,
    }
    const revPath = formatResourceUri({ kind: 'revision', id: rev.id })

    const [currentSavedContent, revision] = await Promise.all([
      readDraftBody(filePath, projectKey, projectSession),
      ipc.invokeWithProjectSession(projectSession, 'db:revision-get-full', rev.id, projectKey),
    ])
    if (!isProjectSessionCurrent(projectSession) || request !== mergeRequest.current) return
    if (!revision) return
    const currentTarget = useEditorStore.getState().tabs.find(
      tab => tab.id === tabId && tab.projectKey === projectKey,
    )
    if (
      !currentTarget
      || currentTarget.dirty
      || currentTarget.content !== targetSnapshot.content
      || (currentTarget.contentRevision ?? 0) !== targetSnapshot.contentRevision
    ) {
      toast.warning(text(
        '读取修订期间正文已变化，请保存后重新打开修订对比',
        'The draft changed while the revision was loading. Save it and reopen the comparison.',
      ))
      return
    }

    const source = revision.sourceDraft
    const staleReason = !source
      ? text(
          '旧修订稿缺少生成时源稿，修订仍可查看但不能合并。',
          'This legacy revision has no generation source. It remains viewable but cannot be merged.',
        )
      : !isRevisionSourceCurrent(source, { ...meta, status: currentTarget.draftStatus ?? meta.status, content: currentSavedContent })
        ? text(
            '当前草稿已不是该修订稿的生成时源稿，修订仍可查看但不能合并。',
            'The current draft no longer matches this revision’s generation source. It remains viewable but cannot be merged.',
          )
        : null

    // 始终展示修订与其真实冻结源；旧行或 stale 源只读，不用当前正文重基。
    setMergeData({
      originalContent: source?.content ?? '',
      modifiedContent: revision.content,
      revisionPath: revPath,
      targetSnapshot,
      staleReason,
    })
  }

  /** 合并完成 —— 就地覆写原草稿（不新建版本，仅蓝图写稿时才产生新版本）。返回是否已提交。 */
  const completeMerge = async (mergedText: string): Promise<boolean> => {
    const projectSession = captureProjectSession(currentProject)
    if (!meta || !mergeData || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return false
    if (mergeData.staleReason) {
      toast.warning(mergeData.staleReason)
      return false
    }
    const chapterDir = `ai-novel://draft/ch${meta.chapterNumber}`
    const currentTarget = useEditorStore.getState().tabs.find(
      tab => tab.id === tabId && tab.projectKey === projectKey,
    )
    if (
      !currentTarget
      || currentTarget.dirty
      || currentTarget.content !== mergeData.targetSnapshot.content
      || (currentTarget.contentRevision ?? 0) !== mergeData.targetSnapshot.contentRevision
    ) {
      toast.warning(text(
        '打开对比后正文已变化，未提交修订；请保存后重新打开',
        'The draft changed after the comparison opened. The revision was not committed; save and reopen it.',
      ))
      return false
    }

    try {
      const { useDraftStore } = await import('../../stores/draft-store')
      const result = await useDraftStore.getState().applyMergedRevision(
        chapterDir,
        meta.chapterNumber,
        filePath,
        mergeData.revisionPath,
        mergedText,
        mergeData.originalContent,
        projectKey,
        projectSession,
      )

      if (!isProjectSessionCurrent(projectSession)) return false
      if (result.success) {
        closeMerge()
        setMeta(prev => prev ? { ...prev, status: 'revised' } : prev)
        // 标签上的稿状态优先于元数据，合并后同步改成已修稿，否则界面仍按合并前的状态显示。
        useEditorStore.setState(state => ({
          tabs: state.tabs.map(tab => tab.id === tabId && tab.projectKey === projectKey && tab.draftStatus !== undefined
            ? { ...tab, draftStatus: 'revised' }
            : tab),
        }))
        toast.success(text('合并完成，草稿已更新', 'Merge complete. The draft is updated.'))
        if (result.postCommitError) toast.warning(text(
          '合并已持久化，但自动复验未启动；请从审稿报告重试。',
          'The merge is durable, but the automatic recheck did not start. Retry it from the review report.',
        ))
        reload()
        return true
      }
      const reason = displayedErrorMessage(locale, result.error)
      toast.error(text(`合并失败：${reason}`, englishWithReason('Could not merge the revision.', reason)))
    } catch (e) {
      if (!isProjectSessionCurrent(projectSession)) return false
      const reason = displayedErrorMessage(useLocaleStore.getState().locale, e)
      toast.error(text(`合并出错：${reason}`, englishWithReason('An error occurred while merging the revision.', reason)))
    }
    return false
  }

  /** 丢弃不能再合并的修稿（生成后正文改过）；修稿记录标为已弃用，复验周期随之对账。 */
  const discardRevisions = async (ids: readonly number[]) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    try {
      for (const id of ids) {
        const result = await ipc.invokeWithProjectSession(projectSession, 'db:revision-mark-discarded', id, projectSession.projectPath)
        if (!result.success) throw new Error(result.error)
      }
    } catch (error) {
      const reason = displayedErrorMessage(useLocaleStore.getState().locale, error)
      if (isProjectSessionCurrent(projectSession)) toast.error(text(`丢弃修稿失败：${reason}`, englishWithReason('Could not discard the revision.', reason)))
    }
    if (isProjectSessionCurrent(projectSession)) reload()
  }

  return {
    meta, status, isReadonly, isChapterBusy, isDirty, finalizationPending, finalizationConflict,
    pendingRevisions, reviews, loaded, reload,
    saving, saveOutcome, currentBodyRef, onBodyChange, save,
    refine, review, canFinalize, finalize, retryManuscriptPublication, repairFinalize,
    mergeData, closeMerge, openPendingRevision, completeMerge, discardRevisions,
  }
}
