import { useState, useRef, useEffect, useCallback } from 'react'
import { Sparkles, Search, BadgeCheck, Save, FileStack, FileText, Wrench, Check } from 'lucide-react'

import { useProjectStore } from '../../stores/project-store'
import { useEditorStore } from '../../stores/editor-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { useLocaleStore } from '../../stores/locale-store'
import CodeMirrorEditor from './CodeMirrorEditor'
import ThreeWayMerge from './ThreeWayMerge'
import { Button } from '../ui/Button'
import { toast } from '../ui/Toast'
import { confirm } from '../ui/Confirm'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from '../ui/Dialog'
import {
  parseDraftMeta,
  type DraftMeta,
  type DraftStatus,
} from '../../services/workflows/chapter-workflow'
import { getPendingRevisions, getReviewsForVersion, type RevisionEntry } from '../../services/draft-index'
import { readDraftBody } from '../../stores/draft-store'
import { ipc } from '../../services/ipc-client'
import { requireIpcSuccess } from '../../services/ipc-result'
import { retryFinalizationPublication } from '../../services/finalization-client'
import { captureFinalizationSnapshot } from '../../services/finalization-snapshot'

import { DRAFT_STATUS_LABEL, DRAFT_STATUS_COLOR } from '../../shared/draft-status'
import { PostProcessStatusPanel } from '../ui/PostProcessStatusPanel'
import { getChapterFinalizeScope } from '../../services/workflows/workflow-utils'
import { guardRepairPostProcess } from '../../services/workflow-guards'
import {
  captureProjectSession,
  isProjectSessionCurrent,
  isProjectSessionPath,
} from '../project-session-gate'

const DRAFT_STATUS_EN: Record<string, string> = {
  draft: 'Draft',
  revised: 'Revised',
  reviewed: 'Reviewed',
  finalized: 'Finalized',
  archived: 'Archived',
}

interface Props {
  tabId: string
  filePath: string
  content: string
  projectKey: string
}

/**
 * 草稿编辑器
 * — 顶部工具栏：草稿状态 + 待合并修稿 + AI 修稿(含自定义提示词) / AI 审稿 / 定稿
 * — 正文：CodeMirrorEditor（prose 模式）
 */
export default function DraftEditor(props: Props) {
  const currentProject = useProjectStore(s => s.currentProject)
  const projectSession = captureProjectSession(currentProject)
  const sessionKey = projectSession && isProjectSessionPath(projectSession, props.projectKey)
    ? `${projectSession.projectId}:${projectSession.leaseId}`
    : `inactive:${props.projectKey}`

  // 同一路径重新打开会生成新 lease；用会话键重挂载，避免旧会话的本地 UI 状态短暂显示。
  return <DraftEditorSession key={sessionKey} {...props} />
}

function DraftEditorSession({ tabId, filePath, content, projectKey }: Props) {
  // 从系统读取草稿元数据与章节标题
  const [meta, setMeta] = useState<(DraftMeta & { chapterTitle?: string; filePath?: string }) | null>(null)
  const editorTab = useEditorStore(
    state => state.tabs.find(tab => tab.id === tabId && tab.projectKey === projectKey),
  )
  const currentProject = useProjectStore(s => s.currentProject)
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const projectMatches = currentProject?.path === projectKey
  const tabDraftStatus = editorTab?.draftStatus
  const [pendingRevisions, setPendingRevisions] = useState<RevisionEntry[]>([])
  const [reviewCount, setReviewCount] = useState(0)

  // 【BUG1&2 修复】合并视图弹窗数据（不再占用 Tab）
  const [mergeData, setMergeData] = useState<{
    originalContent: string
    modifiedContent: string
    revisionPath: string
  } | null>(null)

  // 后处理失败状态（用于控制是否展示修复按钮）
  const [hasProcessFailure, setHasProcessFailure] = useState(false)

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
      const chapterDir = `vela://draft/ch${m.chapterNumber}`
      // 检查待合并修稿
      const pending = await getPendingRevisions(chapterDir, m.version, projectKey)
      if (!cancelled && isProjectSessionCurrent(projectSession)) setPendingRevisions(pending)
      // 检查审稿报告
      const reviews = await getReviewsForVersion(chapterDir, m.version, projectKey)
      if (!cancelled && isProjectSessionCurrent(projectSession)) setReviewCount(reviews.length)
    }
    load()

    // 数据刷新由 ProjectService 统一处理（FINALIZE_COMPLETE 事件驱动 Store 更新后组件自动重渲染）

    return () => {
      cancelled = true
    }
  }, [currentProject, filePath, projectKey])

  const status: DraftStatus = tabDraftStatus ?? meta?.status ?? 'draft'
  const isReadonly = status === 'finalized' || status === 'archived'

  // 检查是否有相关章节工作流正在运行
  // ✅ 只订阅 activeRuns，不订阅 globalLogs 等高频更新字段
  const activeRuns = useWorkflowStore(s => s.activeRuns)
  const activeChapterRun = activeRuns.find(r =>
    r.projectPath === projectKey
    && r.type === 'chapter_creation'
    && meta
    && (r.title.includes(`第${meta.chapterNumber}章`) || r.title.includes(`第 ${meta.chapterNumber} 章`))
  )
  const isChapterBusy = !!activeChapterRun

  const [saving, setSaving] = useState(false)
  const [confirmAction, setConfirmAction] = useState<'refine' | 'review' | null>(null)
  const [userRefinePrompt, setUserRefinePrompt] = useState('')
  // 审稿维度多选
  const REVIEW_DIMS = [
    {
      key: 'continuity',
      label: text('剧情连贯性', 'Story continuity'),
      desc: text('与前文是否矛盾', 'Consistency with earlier chapters'),
      promptLabel: '剧情连贯性',
    },
    {
      key: 'logic',
      label: text('剧情合理性', 'Story logic'),
      desc: text('因果逻辑、动机、常识', 'Causality, motivation, and plausibility'),
      promptLabel: '剧情合理性',
    },
    {
      key: 'character',
      label: text('角色状态', 'Character state'),
      desc: text('能力/位置/情感一致性', 'Ability, location, and emotional consistency'),
      promptLabel: '角色状态',
    },
    {
      key: 'foreshadow',
      label: text('前后章节串联', 'Chapter connections'),
      desc: text('伏笔、悬念连贯', 'Foreshadowing and suspense continuity'),
      promptLabel: '前后章节串联',
    },
  ]
  const [reviewDims, setReviewDims] = useState<Record<string, boolean>>(
    Object.fromEntries(REVIEW_DIMS.map(d => [d.key, true]))
  )
  const [charCount, setCharCount] = useState(0)
  const isDirty = editorTab?.dirty ?? false
  const finalizationPending = editorTab?.finalizationPublication === 'pending'
  const finalizationConflict = editorTab?.finalizationConflict
  const currentBodyRef = useRef(content)

  /** 保存（vela://draft/ 走 DB，其他走 FS） */
  const doSave = async (draftContent: string) => {
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
    try {
      if (filePath.startsWith('vela://draft/') || filePath.startsWith('vela://manuscript/')) {
        const prefix = filePath.startsWith('vela://draft/') ? 'vela://draft/' : 'vela://manuscript/'
        const draftId = parseInt(filePath.replace(prefix, ''))
        const result = await ipc.invokeWithProjectSession(
          projectSession,
          'db:draft-update-content',
          draftId,
          saveSnapshot.content,
          saveSnapshot.content.length,
          projectSession.projectPath,
        )
        if (!result.success) throw new Error(result.error || text('草稿保存失败', 'Could not save the draft'))
      } else {
        requireIpcSuccess(
          await ipc.invokeWithProjectSession(
            projectSession,
            'fs:write-file',
            filePath,
            saveSnapshot.content,
            projectSession.projectPath,
          ),
          '保存草稿文件',
        )
      }
      if (!isProjectSessionCurrent(projectSession)) return
      const currentTab = useEditorStore.getState().tabs.find(
        tab => tab.id === tabId && tab.projectKey === projectKey,
      )
      if (currentTab) {
        useEditorStore.getState().settleTabSave(currentTab.id, saveSnapshot)
      }
    } finally {
      if (isProjectSessionCurrent(projectSession)) setSaving(false)
    }
  }

  /** 执行 AI 修稿（含用户自定义提示词） */
  const doRefine = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !currentProject || !meta || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    try {
      const { useWorkflowStore } = await import('../../stores/workflow-store')
      const { createRefineOnlyWorkflow } = await import('../../services/workflows/chapter-workflow')
      if (!isProjectSessionCurrent(projectSession)) return

      const body = await readDraftBody(filePath, projectKey, projectSession)
      if (!isProjectSessionCurrent(projectSession)) return

      useWorkflowStore.getState().startWorkflow(createRefineOnlyWorkflow({
        projectPath: projectSession.projectPath,
        chapterNumber: meta.chapterNumber,
        chapterTitle: meta.chapterTitle ?? '未知标题',
        draftPath: filePath,
        draftContent: body,
        userRefinePrompt: userRefinePrompt.trim() || undefined,
      }, projectSession), false)
    } catch (e) {
      if (!isProjectSessionCurrent(projectSession)) return
      toast.error(text(`修稿启动失败：${e}`, 'Could not start AI revision.'))
    }
  }

  /** 执行 AI 审稿 */
  const doReview = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !currentProject || !meta || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    try {
      const { useWorkflowStore } = await import('../../stores/workflow-store')
      const { createReviewOnlyWorkflow } = await import('../../services/workflows/chapter-workflow')
      if (!isProjectSessionCurrent(projectSession)) return

      const body = await readDraftBody(filePath, projectKey, projectSession)
      if (!isProjectSessionCurrent(projectSession)) return

      useWorkflowStore.getState().startWorkflow(createReviewOnlyWorkflow({
        projectPath: projectSession.projectPath,
        chapterNumber: meta.chapterNumber,
        chapterTitle: meta.chapterTitle ?? '未知标题',
        draftPath: filePath,
        draftContent: body,
        reviewFocus: REVIEW_DIMS.filter(d => reviewDims[d.key]).map(d => d.promptLabel).join('、') || undefined,
      }, projectSession), false)
    } catch (e) {
      if (!isProjectSessionCurrent(projectSession)) return
      toast.error(text(`审稿启动失败：${e}`, 'Could not start AI review.'))
    }
  }

  /** 定稿 */
  const doFinalize = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !currentProject || !meta || isChapterBusy || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    const ok = await confirm(
      text(
        `确定要将第 ${meta.chapterNumber} 章定稿吗？\n\n定稿后章节将标记为完成，不再支持修改和重新后处理。`,
        `Finalize Chapter ${meta.chapterNumber}?\n\nIt will be marked complete and can no longer be edited or post-processed again.`,
      ),
      {
        title: text('确认定稿', 'Confirm finalization'),
        confirmText: text('确认定稿', 'Finalize'),
      }
    )
    if (!ok || !isProjectSessionCurrent(projectSession)) return
    try {
      const { useWorkflowStore } = await import('../../stores/workflow-store')
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
      toast.error(text(`定稿启动失败：${e}`, 'Could not start finalization.'))
    }
  }

  /** 实体稿失败后只按已提交的 finalizationId 重试；不再交回正文或路径。 */
  const doRetryManuscriptPublication = useCallback(async () => {
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
      toast.error(text(`实体稿发布失败：${error}`, 'Could not publish the manuscript.'))
    }
  }, [currentProject, projectKey, tabId, text])

  /** 修复定稿后处理 — 只重跑失败的步骤 */
  const doRepairFinalize = useCallback(async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !currentProject || !meta || isChapterBusy || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    try {
      const guard = await guardRepairPostProcess(meta.chapterNumber, projectKey, projectSession)
      if (!isProjectSessionCurrent(projectSession)) return
      if (!guard.ok) {
        toast.error(locale === 'zh-CN'
          ? (guard.message || text('无法执行修复', 'Could not run the repair.'))
          : text('无法执行修复', 'Could not run the repair.'))
        return
      }
      const { useWorkflowStore } = await import('../../stores/workflow-store')
      const { createRepairFinalizeWorkflow } = await import('../../services/workflows/chapter-workflow')
      if (!isProjectSessionCurrent(projectSession)) return
      useWorkflowStore.getState().startWorkflow(
        createRepairFinalizeWorkflow(meta.chapterNumber, projectSession.projectPath, projectSession),
        false,
      )
    } catch (e) {
      if (!isProjectSessionCurrent(projectSession)) return
      toast.error(text(`修复启动失败：${e}`, 'Could not start the repair.'))
    }
  }, [currentProject, isChapterBusy, locale, meta, projectKey, projectMatches, text])

  /** 打开待合并修稿 —— 弹出式合并视图，不占用原草稿 Tab */
  const openPendingRevision = async (rev: RevisionEntry) => {
    const projectSession = captureProjectSession(currentProject)
    if (!meta || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    // 使用 vela://revision/{id} 协议路径读取修稿内容
    const revPath = `vela://revision/${rev.id}`

    // 读取原稿和修稿
    const [origContent, revContent] = await Promise.all([
      readDraftBody(filePath, projectKey, projectSession),
      readDraftBody(revPath, projectKey, projectSession),
    ])
    if (!isProjectSessionCurrent(projectSession)) return
    if (!origContent && !revContent) return

    // 设置弹窗数据，不再打开新 Tab
    setMergeData({
      originalContent: origContent,
      modifiedContent: revContent,
      revisionPath: revPath,
    })
  }

  /** 合并完成回调 —— 就地覆写原草稿（不新建版本，仅蓝图写稿时才产生新版本） */
  const handleMergeComplete = async (mergedText: string) => {
    const projectSession = captureProjectSession(currentProject)
    if (!meta || !mergeData || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    const chapterDir = `vela://draft/ch${meta.chapterNumber}`

    try {
      const { useDraftStore } = await import('../../stores/draft-store')
      const result = await useDraftStore.getState().applyMergedRevision(
        chapterDir,
        meta.chapterNumber,
        filePath,
        mergeData.revisionPath,
        mergedText,
        projectKey,
        projectSession,
      )

      if (!isProjectSessionCurrent(projectSession)) return
      if (result.success) {
        // 关闭弹窗 + 刷新待合并列表 + 更新本地元数据
        setMergeData(null)
        setMeta(prev => prev ? { ...prev, status: 'revised' } : prev)
        toast.success(text('合并完成，草稿已更新', 'Merge complete. The draft is updated.'))
        const { getPendingRevisions } = await import('../../services/draft-index')
        const pending = await getPendingRevisions(chapterDir, meta.version, projectKey)
        if (isProjectSessionCurrent(projectSession)) setPendingRevisions(pending)
      } else {
        toast.error(text(`合并失败：${result.error}`, 'Could not merge the revision.'))
      }
    } catch (e) {
      if (!isProjectSessionCurrent(projectSession)) return
      toast.error(text(`合并出错：${e}`, 'An error occurred while merging the revision.'))
    }
  }

  /** 打开最新的审稿报告 */
  const openLatestReview = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!meta || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    const chapterDir = `vela://draft/ch${meta.chapterNumber}`
    const { getLatestReview } = await import('../../services/draft-index')
    if (!isProjectSessionCurrent(projectSession)) return
    const latest = await getLatestReview(chapterDir, meta.version, projectKey)
    if (!isProjectSessionCurrent(projectSession)) return
    if (!latest) return

    // 使用 review 的数据库 ID 读取审稿报告内容
    const reportContent = await readDraftBody(`vela://review/${latest.id}`, projectKey, projectSession)
    if (!isProjectSessionCurrent(projectSession)) return
    if (!reportContent) return

    useEditorStore.getState().openFile({
      id: `review-report-${meta.chapterNumber}-${latest.id}`,
      name: text(`审稿报告 v${meta.version}`, `Review report v${meta.version}`),
      type: 'review-report',
      content: reportContent,
      filePath,
      reviewReport: reportContent,
      chapterNumber: meta.chapterNumber,
      chapterDir,
      projectKey,
    })
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* 顶部工具栏 */}
      <div
        className="flex items-center justify-between gap-2 px-3 h-9 flex-shrink-0"
        style={{
          borderBottom: '1px solid var(--color-border)',
          backgroundColor: 'var(--color-editor-bg)',
        }}
      >
        {/* 左侧：章节标题 + 版本 */}
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-medium truncate" style={{ color: 'var(--color-text-secondary)' }}>
              {meta
                ? text(`第 ${meta.chapterNumber} 章 — ${meta.chapterTitle || '未知标题'}`, `Chapter ${meta.chapterNumber} — ${meta.chapterTitle || 'Untitled'}`)
                : text('草稿', 'Draft')}
          </span>
          {meta && (
            <span className="text-[0.7rem] flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
              v{meta.version}
            </span>
          )}
        </div>

        {/* 右侧：字数 + 状态 + 待合并 + AI操作 + 定稿 */}
        {!isReadonly && (
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {/* 字数 */}
            {charCount > 0 && (
              <span className="text-xs tabular-nums mr-1" style={{ color: 'var(--color-text-muted)' }}>
                {text(`${charCount.toLocaleString(locale)} 字`, `${charCount.toLocaleString(locale)} characters`)}
              </span>
            )}

            {/* 未保存指示灯 */}
            {isDirty && (
              <span
                className="w-1.5 h-1.5 rounded-full flex-shrink-0 mr-0.5"
                style={{ backgroundColor: 'var(--color-warning)' }}
                title={text('有未保存的修改', 'There are unsaved changes')}
              />
            )}

            {/* 保存按钮 */}
            {isDirty && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => doSave(currentBodyRef.current)}
                disabled={saving}
                title={text('保存（⌘S）', 'Save (Ctrl+S)')}
              >
                <Save size={12} />
                {saving ? text('保存中...', 'Saving...') : text('保存', 'Save')}
              </Button>
            )}

            {/* 状态标签 */}
            <span
              className="text-[0.7rem] px-1.5 py-0.5 rounded flex-shrink-0"
              style={{
                backgroundColor: 'var(--color-hover)',
                color: DRAFT_STATUS_COLOR[status] ?? 'var(--color-text-muted)',
              }}
            >
              {text(DRAFT_STATUS_LABEL[status] ?? status, DRAFT_STATUS_EN[status] ?? status)}
            </span>

            {finalizationConflict && (
              <span
                className="text-[0.7rem] px-1.5 py-0.5 rounded flex-shrink-0"
                style={{ color: 'var(--color-warning)', backgroundColor: 'var(--color-hover)' }}
                title={text(
                  '定稿完成事件没有覆盖这次编辑；请先处理本地后续修改与已定稿版本的差异。',
                  'Finalization did not overwrite this edit. Resolve the difference between your later local changes and the finalized version first.',
                )}
              >
                {text('已保留后续编辑', 'Later edits kept')}
              </span>
            )}

            {finalizationPending && (
              <Button
                variant="outline"
                size="sm"
                onClick={doRetryManuscriptPublication}
                title={text('定稿已提交、实体稿待发布；只重试已提交的发布记录', 'Finalization is submitted and the manuscript is pending publication. Retry only the submitted publication.')}
              >
                <Wrench size={12} />
                {text('重试实体稿', 'Retry manuscript')}
              </Button>
            )}

            {/* Pending revisions */}
            {pendingRevisions.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => openPendingRevision(pendingRevisions[0])}
                title={text('有待合并的修稿，点击打开三栏合并视图', 'Open the three-way merge view for pending revisions')}
              >
                <FileStack size={12} />
                {text(`待合并(${pendingRevisions.length})`, `Pending (${pendingRevisions.length})`)}
              </Button>
            )}

            {/* Review report */}
            {reviewCount > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={openLatestReview}
                title={text('查看最新审稿报告', 'View the latest review report')}
              >
                <FileText size={12} />
                {text(`审稿报告(${reviewCount})`, `Review report (${reviewCount})`)}
              </Button>
            )}

            {/* AI 修稿 */}
            <Button
              variant="ai"
              size="sm"
              onClick={() => { setUserRefinePrompt(''); setConfirmAction('refine') }}
              disabled={isChapterBusy}
                title={text('AI 修稿 — 大神级润色，生成修稿并打开合并视图', 'AI revision — polish the chapter, create a revision, and open the merge view')}
            >
              <Sparkles size={12} />
                {text('AI 修稿', 'AI revise')}
            </Button>

            {/* AI 审稿 */}
            <Button
              variant="ai"
              size="sm"
              onClick={() => setConfirmAction('review')}
              disabled={isChapterBusy}
                title={text('AI 审稿 — 一致性检查，生成审稿报告', 'AI review — run a consistency check and create a review report')}
            >
              <Search size={12} />
                {text('AI 审稿', 'AI review')}
            </Button>

            {/* 定稿 */}
            <Button
              variant="success"
              size="sm"
              onClick={doFinalize}
              disabled={isChapterBusy || !!finalizationConflict || finalizationPending}
                title={text('定稿 — 确认终稿并写入正文章节', 'Finalize — confirm the final draft and write it to the manuscript')}
            >
              <BadgeCheck size={12} />
                {text('定稿', 'Finalize')}
            </Button>
          </div>
        )}

        {/* 已定稿/归档显示只读提示 */}
        {isReadonly && (
          <div className="flex items-center gap-2 flex-shrink-0">
            {charCount > 0 && (
              <span className="text-xs tabular-nums" style={{ color: 'var(--color-text-muted)' }}>
                {text(`${charCount.toLocaleString(locale)} 字`, `${charCount.toLocaleString(locale)} characters`)}
              </span>
            )}
            <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {status === 'finalized'
                ? text('已定稿（只读）', 'Finalized (read-only)')
                : text('已归档（只读）', 'Archived (read-only)')}
            </span>
            {finalizationPending && (
              <Button
                variant="outline"
                size="sm"
                onClick={doRetryManuscriptPublication}
                title={text('定稿已提交、实体稿待发布；只重试已提交的发布记录', 'Finalization is submitted and the manuscript is pending publication. Retry only the submitted publication.')}
              >
                <Wrench size={11} />
                {text('重试实体稿', 'Retry manuscript')}
              </Button>
            )}
            {/* 已定稿 → 有失败项时显示修复定稿按钮 */}
            {status === 'finalized' && meta && hasProcessFailure && (
              <Button
                variant="outline"
                size="sm"
                onClick={doRepairFinalize}
                disabled={isChapterBusy}
                title={text('重新执行失败的后处理步骤（角色卡、知识库等）', 'Retry failed post-processing steps such as character cards and knowledge indexing')}
              >
                <Wrench size={11} />
                {text('修复定稿', 'Repair finalization')}
              </Button>
            )}
          </div>
        )}
      </div>

      {/* 后处理状态面板（仅定稿草稿显示） */}
      {status === 'finalized' && meta && (
        <div className="px-3 py-1.5" style={{ borderBottom: '1px solid var(--color-border)' }}>
          <PostProcessStatusPanel
            scope={getChapterFinalizeScope(meta.chapterNumber)}
            onRetry={() => doRepairFinalize()}
            onStatusLoad={setHasProcessFailure}
          />
        </div>
      )}

      {/* 正文区 */}
      <div className="flex-1 overflow-hidden relative">
        <CodeMirrorEditor
          mode="prose"
          content={content}
          filePath={filePath}
          editable={!isReadonly && !isChapterBusy}
          hideStatusBar
          onCharCountChange={setCharCount}
          onChange={(text) => {
            currentBodyRef.current = text
            useEditorStore.getState().updateTabContent(tabId, text)
          }}
          onSave={(text) => doSave(text)}
        />


      </div>

      {/* AI 操作确认弹窗（修稿含自定义提示词输入框） */}
      <Dialog open={confirmAction !== null} onOpenChange={(v) => !v && setConfirmAction(null)}>
        <DialogContent className="max-w-[440px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles size={15} className="text-[var(--color-accent)]" />
              {confirmAction === 'refine'
                ? text('AI 修稿确认', 'Confirm AI revision')
                : text('AI 审稿确认', 'Confirm AI review')}
            </DialogTitle>
            <DialogDescription>
              {text('对象：', 'Target: ')}{meta
                ? `${meta.chapterTitle || text('未知标题', 'Untitled')} v${meta.version}`
                : text('当前草稿', 'Current draft')}
            </DialogDescription>
          </DialogHeader>
          <div className="px-5 py-2 text-sm space-y-1.5" style={{ color: 'var(--color-text-secondary)' }}>
            {confirmAction === 'refine' ? (
              <>
                <div className="font-medium text-[var(--color-text)]">{text('本次【直接修稿】范围：', 'This direct revision will:')}</div>
                <div>{text('1. 全文基础润色、词汇优化，增强画面与表现力。', '1. Polish the full chapter, improve wording, and strengthen imagery and expression.')}</div>
                <div>{text('2. 可在下方指定的额外修稿要求。', '2. Follow any additional revision instructions below.')}</div>
              </>
            ) : (
              <>
                <div>{text('将调用 AI 对本章草稿进行一致性检查，并生成审稿报告。', 'AI will check this chapter for consistency and generate a review report.')}</div>
                <div className="mt-3">
                  <div className="text-xs font-medium mb-2" style={{ color: 'var(--color-text)' }}>{text('重点检查维度：', 'Review focus:')}</div>
                  <div className="flex flex-wrap gap-2">
                    {REVIEW_DIMS.map(d => (
                      <label
                        key={d.key}
                        className="flex items-center gap-1.5 cursor-pointer select-none px-2 py-1 rounded-md text-xs"
                        style={{
                          border: `1px solid ${reviewDims[d.key] ? 'var(--color-accent)' : 'var(--color-border)'}`,
                          backgroundColor: reviewDims[d.key] ? 'rgba(var(--color-accent-rgb),0.1)' : 'transparent',
                          color: reviewDims[d.key] ? 'var(--color-accent)' : 'var(--color-text-muted)',
                        }}
                        onClick={() => setReviewDims(prev => ({ ...prev, [d.key]: !prev[d.key] }))}
                      >
                        <div
                          className="w-3 h-3 rounded flex items-center justify-center flex-shrink-0"
                          style={{
                            backgroundColor: reviewDims[d.key] ? 'var(--color-accent)' : 'transparent',
                            border: `1.5px solid ${reviewDims[d.key] ? 'var(--color-accent)' : 'var(--color-border)'}`,
                          }}
                        >
                          {reviewDims[d.key] && (
                            <Check size={9} strokeWidth={3} color="white" aria-hidden="true" />
                          )}
                        </div>
                        {d.label}
                      </label>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* 修稿时显示自定义提示词输入框 */}
          {confirmAction === 'refine' && (
            <div className="px-5 pb-2">
              <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
                {text('附加修稿要求（可选）：', 'Additional revision guidance (optional):')}
              </label>
              <textarea
                className="w-full px-3 py-2 rounded-md text-sm"
                style={{
                  background: 'var(--color-bg-elevated)',
                  border: '1px solid var(--color-border)',
                  color: 'var(--color-text)',
                  minHeight: 72,
                  resize: 'vertical',
                  outline: 'none',
                }}
                placeholder={text(
                  '例如：加强打斗场面的画面感；把结尾的伏笔改为更隐晦的暗示；对白太书面化，改为口语化风格...',
                  'For example: make action scenes more vivid; make the final foreshadowing subtler; make dialogue less formal...',
                )}
                value={userRefinePrompt}
                onChange={e => setUserRefinePrompt(e.target.value)}
              />
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmAction(null)}>{text('取消', 'Cancel')}</Button>
            <Button
              variant="ai"
              onClick={() => {
                const act = confirmAction
                setConfirmAction(null)
                if (act === 'refine') doRefine()
                else if (act === 'review') doReview()
              }}
            >
              {text('确认执行', 'Run')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 弹出式三栏合并视图 —— 使用统一 Dialog 组件 */}
      <Dialog open={mergeData !== null} onOpenChange={(v) => !v && setMergeData(null)}>
        <DialogContent
          className="p-0"
          style={{
            width: '90vw',
            maxWidth: '90vw',
            height: '85vh',
            maxHeight: '85vh',
            overflow: 'hidden',
          }}
          /* 阻止点击遮罩关闭，防止误触丢失合并进度 */
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader className="px-4 py-0" style={{ height: 38, display: 'flex', alignItems: 'center' }}>
            <DialogTitle className="flex items-center gap-2 text-[0.8rem]">
              {text(
                `修稿合并 — 第${meta?.chapterNumber ?? ''}章 ${meta?.chapterTitle || '未知标题'}`,
                `Revision merge — Chapter ${meta?.chapterNumber ?? ''} ${meta?.chapterTitle || 'Untitled'}`,
              )}
            </DialogTitle>
          </DialogHeader>
          {/* 合并视图主体 */}
          <div className="flex-1 overflow-hidden" style={{ height: 'calc(85vh - 38px - 1px)' }}>
            {mergeData && (
              <ThreeWayMerge
                originalContent={mergeData.originalContent}
                modifiedContent={mergeData.modifiedContent}
                onComplete={handleMergeComplete}
                onCancel={() => setMergeData(null)}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
