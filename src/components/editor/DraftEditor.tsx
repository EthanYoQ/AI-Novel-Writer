import { useState, useRef, useEffect, useCallback, type CSSProperties } from 'react'
import { Sparkles, Search, BadgeCheck, Save, FileStack, FileText, Wrench, Check } from 'lucide-react'

import { useProjectStore } from '../../stores/project-store'
import { registerEditorExitSaveHandler, useEditorStore } from '../../stores/editor-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { useLocaleStore } from '../../stores/locale-store'
import { useUiVersionStore, isModernShell } from '../../stores/ui-version-store'
import CodeMirrorEditor from './CodeMirrorEditor'
import ThreeWayMerge from './ThreeWayMerge'
import WritingSkillBubble from './WritingSkillBubble'
import ExternalAiAuditBoard, { type ExternalAiHandoffHandle } from './ExternalAiAuditBoard'
import { REFINE_HANDOFF_CONFIG } from './external-ai-handoff-config'
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
  type FrozenDraftSourceIdentity,
} from '../../services/workflows/chapter-workflow'
import { getPendingRevisions, getReviewsForVersion, type RevisionEntry } from '../../services/draft-index'
import { readDraftBody } from '../../stores/draft-store'
import { ipc } from '../../services/ipc-client'
import { requireIpcSuccess } from '../../services/ipc-result'
import { retryFinalizationPublication } from '../../services/finalization-client'
import { captureFinalizationSnapshot } from '../../services/finalization-snapshot'

import { DRAFT_STATUS_LABEL, DRAFT_STATUS_COLOR } from '../../shared/draft-status'
import { resolveWritingLanguage } from '../../shared/writing-language'
import { buildExternalAiRefineMaterial } from '../../services/external-ai-refine-material'
import { countDraftUnits } from '../../shared/draft-units'
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
  /** 现代外壳（v2 墨纸书斋 / v3 时尚杂志）把定稿通知做成纸面右下角的印章，经典界面仍是横条。 */
  const isV2Ui = useUiVersionStore(s => isModernShell(s.uiVersion))
  const projectMatches = currentProject?.path === projectKey
  const tabDraftStatus = editorTab?.draftStatus
  const [pendingRevisions, setPendingRevisions] = useState<RevisionEntry[]>([])
  const [reviewCount, setReviewCount] = useState(0)

  // 【BUG1&2 修复】合并视图弹窗数据（不再占用 Tab）
  const [mergeData, setMergeData] = useState<{
    originalContent: string
    modifiedContent: string
    revisionPath: string
    targetSnapshot: { content: string; contentRevision: number }
    staleReason: string | null
    /**
     * 是否来自**外部 AI 修稿**。
     *
     * 两边的产物性质不同：内置修稿落的是数据库里的修订记录（revisionPath），
     * 合并完成要把结果提交回记录；外部修稿没有记录，合并结果只写回编辑器，
     * 由先生自己保存。所以完成路径要分家。
     */
    external?: boolean
  } | null>(null)

  // 后处理失败状态（用于控制是否展示修复按钮）
  const [hasProcessFailure, setHasProcessFailure] = useState(false)

  /**
   * currentProject 的最新值引用。
   *
   * project-store 的 updateNovelConfig 每次都用 {...project} 重建对象，
   * 所以把 currentProject 写进下面的依赖数组会让「改任意配置字段」
   * （哪怕只在输入框里敲一个数字）都重跑这里的三次 IPC 查询。
   * 数据真正相关的键是「项目路径 + 文件路径」，改依赖为前者 + 用 ref 取最新对象。
   */
  const currentProjectRef = useRef(currentProject)
  // 赋值放在 effect 里而不是 render 期（同 CodeMirrorEditor 的 updateHandlerRef 范式）：
  // render 期写 ref 在并发渲染 / StrictMode 双调用下可能写入被丢弃的那次渲染的值。
  // 本 effect 声明在下面的读取 effect 之前，React 按声明顺序执行，读到的必是最新对象。
  useEffect(() => {
    currentProjectRef.current = currentProject
  })

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const projectSession = captureProjectSession(currentProjectRef.current)
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
  }, [filePath, projectKey])

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
  /**
   * 本次「确认执行」走哪条路。
   *
   * 先生（流程重构）：弹窗里原本混着两套语义 —— 按钮执行内部 AI，
   * 而外部入口一碰就开浏览器。现在收成一个二选一的开关，按钮做什么由它决定。
   */
  const [executor, setExecutor] = useState<'internal' | 'external'>('internal')
  /** 外部模式下选中的入口（卡片现在是选择框，可多选）。 */
  const [selectedAiIds, setSelectedAiIds] = useState<string[]>([])
  /** 两块外部板块的命令式出口：确认执行时由按钮调用。 */
  const reviewBoardRef = useRef<ExternalAiHandoffHandle>(null)
  const refineBoardRef = useRef<ExternalAiHandoffHandle>(null)
  const [userRefinePrompt, setUserRefinePrompt] = useState('')
  // 审稿维度多选。
  //
  // label 是给作者看的措辞；promptLabel 是**给模型的维度名** —— 它既要参与审稿
  // 提示词的构造，又要把模型返回的 category 匹配回本表（见 prompt-templates 里
  // 那份示例合同）。所以改文案只动 label，promptLabel 一个字都不能动。
  const REVIEW_DIMS = [
    {
      key: 'continuity',
      label: text('剧情的连贯性', 'Story continuity'),
      desc: text('与前文是否矛盾', 'Consistency with earlier chapters'),
      promptLabel: '剧情连贯性',
    },
    {
      key: 'logic',
      label: text('剧情的合理性', 'Story logic'),
      desc: text('因果逻辑、动机、常识', 'Causality, motivation, and plausibility'),
      promptLabel: '剧情合理性',
    },
    {
      key: 'character',
      label: text('角色前后状态', 'Character state'),
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
          countDraftUnits(saveSnapshot.content),
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
      // 先生：草稿保存成功 —— 在正文栏右上角提示一下（这里正是落盘成功的时刻）
    } finally {
      if (isProjectSessionCurrent(projectSession)) setSaving(false)
    }
  }

  const exitSaveRef = useRef(doSave)
  useEffect(() => {
    exitSaveRef.current = doSave
  })
  useEffect(() => {
    registerEditorExitSaveHandler({
      tabId,
      type: 'chapter',
      projectKey,
      save: () => exitSaveRef.current(currentBodyRef.current),
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

    if (targetTab.dirty) await doSave(body)
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

  /** 把一段正文写回编辑器（外部修稿的合并结果、以及回流都走它）。 */
  const writeTextToEditor = (text: string) => {
    currentBodyRef.current = text
    useEditorStore.getState().updateTabContent(tabId, text)
  }

  /**
   * 外部 AI 修稿的产物进来时：**不直接覆盖**，而是打开改稿差异对比。
   *
   * 先生说得对 —— 网页版交回的正文该先逐处比对再决定要不要采纳，
   * 直接糊上去等于把原稿的措辞一并赌掉了。这里复用项目自带的三方合并视图：
   * 左边原稿、右边改稿，先生一处一处挑，点了「完成合并」才写回编辑器。
   */
  const openExternalRefineComparison = (text: string) => {
    const original = currentBodyRef.current
    setMergeData({
      originalContent: original,
      modifiedContent: text,
      // 外部来源没有修订记录；完成路径也不提交记录（见 handleMergeComplete）
      revisionPath: '',
      targetSnapshot: { content: original, contentRevision: editorTab?.contentRevision ?? 0 },
      staleReason: null,
      external: true,
    })
  }

  /** 选择／取消选择某个外部入口（可选择多个，确认执行时一次打开）。 */
  const toggleSelectedAi = (id: string) => {
    setSelectedAiIds(current => current.includes(id)
      ? current.filter(item => item !== id)
      : [...current, id])
  }

  /** 执行 AI 修稿（含用户自定义提示词） */
  const doRefine = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !currentProject || !meta || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    try {
      const source = await freezeDraftSourceForAI(projectSession)
      if (!source || !isProjectSessionCurrent(projectSession)) return
      const { useWorkflowStore } = await import('../../stores/workflow-store')
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
      toast.error(text(`修稿启动失败：${e}`, 'Could not start AI revision.'))
    }
  }

  /** 执行 AI 审稿 */
  const doReview = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !currentProject || !meta || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    try {
      const source = await freezeDraftSourceForAI(projectSession)
      if (!source || !isProjectSessionCurrent(projectSession)) return
      const { useWorkflowStore } = await import('../../stores/workflow-store')
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
  const doRepairFinalize = useCallback(async (stepKey?: string) => {
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
        createRepairFinalizeWorkflow(meta.chapterNumber, projectSession.projectPath, projectSession, stepKey),
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
    // 使用 vela://revision/{id} 协议路径读取修稿内容
    const revPath = `vela://revision/${rev.id}`

    // 读取原稿和修稿
    const [currentSavedContent, revision] = await Promise.all([
      readDraftBody(filePath, projectKey, projectSession),
      ipc.invokeWithProjectSession(projectSession, 'db:revision-get-full', rev.id, projectKey),
    ])
    if (!isProjectSessionCurrent(projectSession)) return
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
      : source.id !== meta.id
        || source.chapterNumber !== meta.chapterNumber
        || source.version !== meta.version
        || source.status !== (currentTarget.draftStatus ?? meta.status)
        || source.content !== currentSavedContent
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

  /** 合并完成回调 —— 就地覆写原草稿（不新建版本，仅蓝图写稿时才产生新版本） */
  const handleMergeComplete = async (mergedText: string) => {
    /*
      外部 AI 修稿这条路先分流：它没有修订记录可提交，
      合并结果直接写回编辑器 —— 绝不悄悄覆盖，先生自己按保存。
    */
    if (mergeData?.external) {
      writeTextToEditor(mergedText)
      setMergeData(null)
      toast.success(text(
        '已把合并结果写回编辑器，记得保存',
        'Merged text written back to the editor — remember to save.',
      ))
      return
    }

    const projectSession = captureProjectSession(currentProject)
    if (!meta || !mergeData || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    if (mergeData.staleReason) {
      toast.warning(mergeData.staleReason)
      return
    }
    const chapterDir = `vela://draft/ch${meta.chapterNumber}`
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
      return
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
      draftId: meta.id,
      reviewId: latest.id,
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
                {text(`${charCount.toLocaleString(locale)} 字`, `${charCount.toLocaleString(locale)} words`)}
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

            {/* 保存按钮
                先生：未修改时显示「已保存」、改动了才显示「保存」——
                按钮始终在位，作者扫一眼就知道当前状态，不用抢那几秒提示。
                早先这里是 {isDirty && <按钮>}，一保存按钮整个消失，反馈无处可落。 */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => doSave(currentBodyRef.current)}
              disabled={saving || !isDirty}
              title={text('保存（⌘S）', 'Save (Ctrl+S)')}
            >
              <Save size={12} />
              {/* 先生：不显示「保存中…」—— 保存是毫秒级的，切换文案只会让按钮变宽、抽搐 */}
              {isDirty ? text('保存', 'Save') : text('已保存', 'Saved')}
            </Button>

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
                style={{ color: 'var(--color-warning-text)', backgroundColor: 'var(--color-hover)' }}
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
                title={text('AI 修稿 — 专业精修章节，生成修订并打开合并视图', 'AI revision — professionally refine the chapter, create a revision, and open the merge view')}
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
                {text(`${charCount.toLocaleString(locale)} 字`, `${charCount.toLocaleString(locale)} words`)}
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
                onClick={() => void doRepairFinalize()}
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

      {/* 后处理状态（定稿草稿）不再占正文上方一行 —— 见正文容器右下角的印章/告警卡 */}

      {/* 正文区
          纸页页眉（章节名）由 CSS 的 .cm-content::before 绘制，见 v2-editor.css；
          这里只把章节名通过自定义属性递进去 —— 零结构改动，也避免与 CodeMirror
          自身的滚动容器形成嵌套滚动。 */}
      <div
        className="flex-1 overflow-hidden relative"
        style={meta
          ? ({
              ['--v2-paper-head']: JSON.stringify(
                meta.chapterTitle || text(`第 ${meta.chapterNumber} 章`, `Chapter ${meta.chapterNumber}`),
              ),
            } as CSSProperties)
          : undefined}
      >
        <CodeMirrorEditor
          mode="prose"
          content={content}
          paperHead={meta ? {
            title: meta.chapterTitle || text(`第 ${meta.chapterNumber} 章`, `Chapter ${meta.chapterNumber}`),
            subtitle: currentProject?.name
              ? text(
                  `${currentProject.name} · 第 ${meta.chapterNumber} 章`,
                  `${currentProject.name} · Chapter ${meta.chapterNumber}`,
                )
              : '',
          } : null}
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

        {/*
          定稿后处理状态。
          墨纸书斋里它不再占正文上方一行：全部成功时只在纸面右下角盖一枚朱砂印
          （无底色），处理中盖淡印；只有失败时才展开成可点重试的告警卡。
        */}
        {status === 'finalized' && meta && (
          <PostProcessStatusPanel
            scope={getChapterFinalizeScope(meta.chapterNumber)}
            onRetry={doRepairFinalize}
            onStatusLoad={setHasProcessFailure}
            appearance={isV2Ui ? 'seal' : 'bar'}
          />
        )}
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
          <div
            className="px-5 py-2 text-sm space-y-1.5 max-h-[56vh] overflow-y-auto"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            {confirmAction === 'refine' ? (
              <>
                <ExecutorChoice
                  value={executor}
                  onChange={setExecutor}
                  internalLabel={text('内部 AI 修稿', 'Internal AI revision')}
                  externalLabel={text('外部 AI 修稿', 'External AI revision')}
                />

                {/* 内部区：没选「内部」时整块灰掉（与外部板块同一套灰态类） */}
                <div className={executor === 'internal' ? undefined : 'handoff-board-disabled'}>
                <div className="font-medium text-[var(--color-text)]">{text('本次【直接修稿】范围：', 'This direct revision will:')}</div>
                <div>{text('1. 全文基础润色、词汇优化，增强画面与表现力。', '1. Polish the full chapter, improve wording, and strengthen imagery and expression.')}</div>
                <div>{text('2. 可在下方指定的额外修稿要求。', '2. Follow any additional revision instructions below.')}</div>
                {/* 修稿属于 refinement 阶段：这里挂的 Skill 会随本次提示词一起交给模型。 */}
                <div className="mt-3">
                  <WritingSkillBubble stage="refinement" />
                </div>
                </div>

                {/*
                  外部 AI 修稿 —— 与审稿那边是同一副骨架（同一个组件，换一份配置与装配）。
                  卡片是**选择框**：先生选好要在哪几家改，再按弹窗底部的「确认执行」统一打开。
                  disabled 由上面的执行方式决定：没选「外部」时整块灰掉、不可交互。
                */}
                <ExternalAiAuditBoard
                  ref={refineBoardRef}
                  config={REFINE_HANDOFF_CONFIG}
                  disabled={executor !== 'external'}
                  selectedEntryIds={selectedAiIds}
                  onToggleEntry={toggleSelectedAi}
                  chapterTitle={meta?.chapterTitle ?? ''}
                  chapterNumber={meta?.chapterNumber}
                  getDraftContent={() => currentBodyRef.current}
                  getReviewContext={() => {
                    const projectSession = captureProjectSession(currentProject)
                    if (
                      !projectSession
                      || !currentProject
                      || !isProjectSessionPath(projectSession, projectKey)
                    ) return null
                    return {
                      projectSession,
                      projectPath: projectSession.projectPath,
                      novelConfig: { ...currentProject.novelConfig } as Record<string, unknown>,
                      writingLanguage: resolveWritingLanguage(currentProject.novelConfig.writingLanguage),
                      // 上面那个「附加修稿要求」输入框里的内容，一并交给对方
                      userRefinePrompt: userRefinePrompt.trim() || undefined,
                    }
                  }}
                  buildMaterial={buildExternalAiRefineMaterial}
                  onApplyResult={openExternalRefineComparison}
                />
              </>
            ) : (
              <>
                <ExecutorChoice
                  value={executor}
                  onChange={setExecutor}
                  internalLabel={text('内部 AI 审稿', 'Internal AI review')}
                  externalLabel={text('外部 AI 审计', 'External AI audit')}
                />

                {/* 内部区：没选「内部」时整块灰掉 */}
                <div className={executor === 'internal' ? undefined : 'handoff-board-disabled'}>
                <div>{text('将调用 AI 对本章草稿进行一致性检查，并生成审稿报告。', 'AI will check this chapter for consistency and generate a review report.')}</div>
                {/* 审稿属于 review 阶段：与下面的检查维度并列，都是「本次要交代清楚」的事。 */}
                <div className="mt-3">
                  <WritingSkillBubble stage="review" />
                </div>
                <div className="mt-3">
                  <div className="text-xs font-medium mb-2" style={{ color: 'var(--color-text)' }}>{text('重点检查维度：', 'Review focus:')}</div>
                  {/*
                    先生：四格排成整齐的 2×2。
                    原先用 flex-wrap，四个标签宽窄不一（「剧情连贯性」比「前后章节串联」短
                    一个字），换行时参差得像没对齐 —— 换成等宽网格就齐了。
                    同时把早就写好、却一直没用上的 desc 显示出来：作者一眼能看出每一维在查什么；
                    勾选态的字色提到正文色（最亮那一档），未选才用 muted。
                  */}
                  <div className="grid grid-cols-2 gap-2">
                    {REVIEW_DIMS.map(d => {
                      const checked = reviewDims[d.key]
                      return (
                        <label
                          key={d.key}
                          className="flex items-start gap-2 cursor-pointer select-none px-2.5 py-2 rounded-lg transition-colors"
                          style={{
                            border: `1px solid ${checked ? 'var(--color-accent)' : 'var(--color-border)'}`,
                            backgroundColor: checked ? 'rgba(var(--color-accent-rgb),0.08)' : 'transparent',
                          }}
                          onClick={() => setReviewDims(prev => ({ ...prev, [d.key]: !prev[d.key] }))}
                        >
                          <div
                            className="w-3.5 h-3.5 mt-0.5 rounded flex items-center justify-center flex-shrink-0"
                            style={{
                              backgroundColor: checked ? 'var(--color-accent)' : 'transparent',
                              border: `1.5px solid ${checked ? 'var(--color-accent)' : 'var(--color-border)'}`,
                            }}
                          >
                            {checked && (
                              <Check size={9} strokeWidth={3} color="white" aria-hidden="true" />
                            )}
                          </div>
                          <span className="flex min-w-0 flex-col">
                            <span
                              className="text-xs font-medium"
                              style={{ color: checked ? 'var(--color-text)' : 'var(--color-text-muted)' }}
                            >
                              {d.label}
                            </span>
                            <span
                              className="text-[0.65rem] leading-snug"
                              style={{ color: 'var(--color-text-muted)' }}
                            >
                              {d.desc}
                            </span>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </div>
                </div>

                {/*
                  外部 AI 审计 —— 网页版 AI 的收藏夹。
                  卡片是选择框：选好要在哪几家审，再按弹窗底部的「确认执行」统一打开
                  （可以一次开好几家，材料只装配一份、只复制一次）。
                */}
                <ExternalAiAuditBoard
                  ref={reviewBoardRef}
                  disabled={executor !== 'external'}
                  selectedEntryIds={selectedAiIds}
                  onToggleEntry={toggleSelectedAi}
                  chapterTitle={meta?.chapterTitle ?? ''}
                  chapterNumber={meta?.chapterNumber}
                  getDraftContent={() => currentBodyRef.current}
                  /*
                    装配完整审稿材料要用的项目上下文：**点击那一刻**现取。
                    审稿维度沿用上方那份勾选表，与内置审稿的 reviewFocus 算法一致 ——
                    两条路给出的「重点检查维度」必须是同一个值。
                  */
                  getReviewContext={() => {
                    const projectSession = captureProjectSession(currentProject)
                    if (
                      !projectSession
                      || !currentProject
                      || !isProjectSessionPath(projectSession, projectKey)
                    ) return null
                    return {
                      projectSession,
                      projectPath: projectSession.projectPath,
                      novelConfig: { ...currentProject.novelConfig } as Record<string, unknown>,
                      writingLanguage: resolveWritingLanguage(currentProject.novelConfig.writingLanguage),
                      reviewFocus: REVIEW_DIMS.filter(d => reviewDims[d.key]).map(d => d.promptLabel).join('、') || undefined,
                    }
                  }}
                />
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
              // 外部模式下一个都没选就无从打开 —— 按钮直接禁掉，别让先生点了没反应
              disabled={executor === 'external' && selectedAiIds.length === 0}
              onClick={async () => {
                const act = confirmAction
                if (executor === 'external') {
                  // 外部：装配 → 复制材料 → 一次打开选中的那几家（材料只装一份、只复制一次）
                  const board = act === 'refine' ? refineBoardRef.current : reviewBoardRef.current
                  if (await board?.launch()) setConfirmAction(null)
                  return
                }
                setConfirmAction(null)
                if (act === 'refine') doRefine()
                else if (act === 'review') doReview()
              }}
            >
              {executor === 'external'
                ? text(
                  `打开选中的 ${selectedAiIds.length} 个外部 AI`,
                  `Open ${selectedAiIds.length} external AI site(s)`,
                )
                : text('确认执行', 'Run')}
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
              {mergeData?.external
                ? text(
                  `外部 AI 修稿 · 差异对比 — 第${meta?.chapterNumber ?? ''}章 ${meta?.chapterTitle || '未知标题'}`,
                  `External AI revision · comparison — Chapter ${meta?.chapterNumber ?? ''} ${meta?.chapterTitle || 'Untitled'}`,
                )
                : text(
                  `修稿合并 — 第${meta?.chapterNumber ?? ''}章 ${meta?.chapterTitle || '未知标题'}`,
                  `Revision merge — Chapter ${meta?.chapterNumber ?? ''} ${meta?.chapterTitle || 'Untitled'}`,
                )}
            </DialogTitle>
          </DialogHeader>
          {/* 合并视图主体 */}
          <div className="flex-1 overflow-hidden" style={{ height: 'calc(85vh - 38px - 1px)' }}>
            {mergeData && (
              <div className="flex h-full flex-col">
                {mergeData.staleReason && (
                  <div role="alert" className="border-b border-[var(--color-border)] px-4 py-2 text-sm text-[var(--color-warning-text)]">
                    {mergeData.staleReason}
                  </div>
                )}
                <div className="min-h-0 flex-1">
                  <ThreeWayMerge
                    originalContent={mergeData.originalContent}
                    modifiedContent={mergeData.modifiedContent}
                    onComplete={handleMergeComplete}
                    onCancel={() => setMergeData(null)}
                  />
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * 执行方式二选一：内部 AI 走软件自带流程，外部 AI 交给网页版。
 *
 * 用 role="radio" 而不是 checkbox —— 这两条路**互斥**（先生的原话是「只能二选一」），
 * 单选语义既符合实际，也不会出现「两个都勾着、按下去不知道执行谁」的歧义。
 * 视觉上仍是先生要的那种「标题前的小勾圈」。
 */
function ExecutorChoice({
  value,
  onChange,
  internalLabel,
  externalLabel,
}: {
  value: 'internal' | 'external'
  onChange: (value: 'internal' | 'external') => void
  internalLabel: string
  externalLabel: string
}) {
  const text = useLocaleStore(s => s.text)
  const options: Array<{ key: 'internal' | 'external'; label: string }> = [
    { key: 'internal', label: internalLabel },
    { key: 'external', label: externalLabel },
  ]

  return (
    <div
      className="flex items-center gap-4 mb-3"
      role="radiogroup"
      aria-label={text('执行方式', 'Executor')}
    >
      {options.map(({ key, label }) => {
        const active = value === key
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(key)}
            className="flex items-center gap-1.5 transition-colors"
            style={{
              fontSize: '0.8rem',
              fontWeight: active ? 600 : 400,
              color: active ? 'var(--color-accent)' : 'var(--color-text-secondary)',
              background: 'transparent',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
            }}
          >
            <span
              aria-hidden="true"
              className="flex items-center justify-center rounded-full flex-shrink-0"
              style={{
                width: 13,
                height: 13,
                border: `1.5px solid ${active ? 'var(--color-accent)' : 'var(--color-border)'}`,
              }}
            >
              {active && (
                <span style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--color-accent)' }} />
              )}
            </span>
            {label}
          </button>
        )
      })}
    </div>
  )
}
