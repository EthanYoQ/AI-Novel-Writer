import { useEffect, useState } from 'react'
import { captureProjectSession, isProjectSessionCurrent, isProjectSessionPath } from '../project-session-gate'
import { useProjectStore } from '../../stores/project-store'
import { useLocaleStore } from '../../stores/locale-store'
import { displayedErrorMessage } from '../../i18n/app-errors'
import { useLLMStore } from '../../stores/llm-store'
import { ipc } from '../../services/ipc-client'
import { requireIpcSuccess } from '../../services/ipc-result'
import { availableGenerationModelId } from '../../services/workflows/chapter-write-launch'
import type { ExpectedDraftSource } from '../../shared/ipc-channels'
import { parseChapterGoalReview, type ChapterGoalReview } from '../../shared/chapter-goal-review'
import type { ReviewCycleProjection, ReviewFindingStatus } from '../../shared/review-cycle'
import {
  confirmationSourceReviewId,
  createHumanConfirmedReviewSnapshot,
  hasIncludedReviewItems,
  parseHumanConfirmedReviewSnapshot,
  serializeHumanConfirmedReviewSnapshot,
  type HumanConfirmedReviewItem,
  type HumanConfirmedReviewSnapshot,
} from '../../shared/human-confirmed-review'

/** 审稿问题条目（JSON 格式） */
export interface ReviewIssue {
  category: string
  severity: 'error' | 'warning' | 'pass' | 'unknown'
  goalId?: string
  description: string
  /** 引用的原文片段（有问题时提供） */
  quote?: string
  stableFactKey?: string
  sourceChapter?: number
  findingId?: string
}

/** AI 返回的 JSON 审稿结构 */
interface ReviewJSON {
  goalReview?: unknown
  items: Array<{
    category: string
    severity: string
    goalId?: string
    description: string
    quote?: string
    stableFactKey?: string
    sourceChapter?: number
    findingId?: string
  }>
  summary: string
}

export interface EditableReviewItem extends HumanConfirmedReviewItem {
  id: string
  reviewItemIndex: number
  severity: ReviewIssue['severity']
  findingStatus?: ReviewFindingStatus
}

export interface ConfirmedChecklist {
  /** The newly appended confirmation row, which is the revision's reviewSourceId. */
  reviewSourceId: number
  content: string
  snapshot: HumanConfirmedReviewSnapshot
}

// ===== 解析器 =====

/** 标准化 severity 值 */
export function normalizeSeverity(raw: string): ReviewIssue['severity'] {
  const s = typeof raw === 'string' ? raw.toLowerCase().trim() : ''
  if (s === 'error' || s === 'critical' || s === 'severe') return 'error'
  if (s === 'warning' || s === 'warn' || s === 'minor') return 'warning'
  if (s === 'pass') return 'pass'
  return 'unknown'
}

/** 尝试从文本中提取 JSON（兼容 ```json 包裹） */
function extractJSON(text: string): string | null {
  // 先尝试直接解析
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) return trimmed

  // 尝试从 ```json ... ``` 中提取
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/)
  if (codeBlockMatch) return codeBlockMatch[1].trim()

  // 尝试找第一个 { 和最后一个 }
  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1)
  }

  return null
}

/** 解析审稿报告（优先 JSON，回退到旧版文本解析） */
function parseReport(text: string, fallbackCategory: string): { issues: ReviewIssue[]; summary: string; goalReview?: ChapterGoalReview } {
  const jsonStr = extractJSON(text)
  if (jsonStr) {
    try {
      const data = JSON.parse(jsonStr) as ReviewJSON
      if (data.items && Array.isArray(data.items)) {
        const issues: ReviewIssue[] = data.items.map(item => ({
          category: item.category || fallbackCategory,
          severity: normalizeSeverity(item.severity),
          goalId: item.goalId,
          description: item.description || '',
          quote: item.quote || undefined,
          stableFactKey: item.stableFactKey || undefined,
          sourceChapter: Number.isSafeInteger(item.sourceChapter) && Number(item.sourceChapter) > 0
            ? item.sourceChapter
            : undefined,
          findingId: typeof item.findingId === 'string' ? item.findingId : undefined,
        }))
        return { issues, summary: data.summary || '', goalReview: parseChapterGoalReview(data.goalReview) ?? undefined }
      }
    } catch {
      // JSON 解析失败，回退到文本解析
    }
  }

  // 回退：旧版 markdown 文本解析（兼容历史数据）
  return parseLegacyReport(text, fallbackCategory)
}

/** 旧版文本解析器（兼容历史审稿报告） */
function parseLegacyReport(text: string, fallbackCategory: string): { issues: ReviewIssue[]; summary: string } {
  const issues: ReviewIssue[] = []
  const lines = text.split('\n')
  let currentCategory = fallbackCategory
  const summaryLines: string[] = []
  let inSummary = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // 匹配标题行
    const headingMatch = trimmed.match(/^#{2,3}\s+(.+)/)
    if (headingMatch) {
      const heading = headingMatch[1].replace(/[*_]/g, '')
      if (/总体评价|总结|总评/.test(heading)) {
        inSummary = true
      } else {
        inSummary = false
        currentCategory = heading
      }
      continue
    }

    if (inSummary) {
      summaryLines.push(trimmed.replace(/^[-*]\s*/, ''))
      continue
    }

    // 检测 emoji 严重级别
    let severity: ReviewIssue['severity'] = 'pass'
    if (trimmed.includes('🔴')) severity = 'error'
    else if (trimmed.includes('🟡')) severity = 'warning'
    else if (trimmed.includes('🟢') || trimmed.includes('✅')) severity = 'pass'
    else if (trimmed.startsWith('-') || trimmed.startsWith('*')) severity = 'warning'
    else continue

    const cleanDesc = trimmed
      .replace(/^[-*]\s*/, '')
      .replace(/[🔴🟡🟢✅]\s*/u, '')
      .replace(/\*\*/g, '')

    if (cleanDesc) {
      issues.push({ category: currentCategory, severity, description: cleanDesc })
    }
  }

  return { issues, summary: summaryLines.join(' ') }
}

export function isReviewId(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function editableItemsFromReview(
  issues: ReviewIssue[],
  snapshot: HumanConfirmedReviewSnapshot | null,
  cycle?: ReviewCycleProjection | null,
): EditableReviewItem[] {
  if (snapshot) {
    return snapshot.items.map((item, index) => {
      const finding = cycle?.findings.find(candidate => candidate.findingId === item.findingId)
      return {
        ...item,
        id: item.origin + '-' + (index + 1),
        reviewItemIndex: index,
        severity: normalizeSeverity(item.severity),
        decision: finding?.status === 'author-waived' ? 'waive' : item.decision,
        findingStatus: item.decision === 'waive' ? 'author-waived' : finding?.status,
      }
    })
  }

  return issues.map((issue, index) => {
    const finding = cycle?.findings.find(candidate => candidate.reviewItemIndex === index)
    return {
      id: 'ai-' + (index + 1),
      reviewItemIndex: index,
      category: issue.category,
      severity: issue.severity,
      description: issue.description,
      ...(issue.quote ? { quote: issue.quote } : {}),
      ...(issue.stableFactKey ? { stableFactKey: issue.stableFactKey } : {}),
      ...(issue.sourceChapter ? { sourceChapter: issue.sourceChapter } : {}),
      ...(issue.goalId ? { goalId: issue.goalId } : {}),
      ...(issue.findingId || finding?.findingId ? { findingId: issue.findingId ?? finding?.findingId } : {}),
      findingStatus: finding?.status,
      decision: finding?.status === 'author-waived'
        ? 'waive'
        : !issue.goalId && (issue.severity === 'error' || issue.severity === 'warning') ? 'apply' : 'ignore',
      origin: 'ai' as const,
    }
  })
}

function matchesReviewSource(
  source: ExpectedDraftSource,
  draft: { id: number; chapterNumber: number; version: number; status: string },
  content: string,
): boolean {
  return source.id === draft.id
    && source.chapterNumber === draft.chapterNumber
    && source.version === draft.version
    && source.status === draft.status
    && source.content === content
}

/** 一份审稿报告的持久化复验周期：确认快照指向原始审稿，周期也按原始审稿读。reloadCycle 在复验后重读。 */
export function useReviewCycle({ reportText, reviewId, projectKey, cycle, refreshKey }: {
  reportText: string
  reviewId?: number
  projectKey: string
  cycle?: ReviewCycleProjection | null
  /** 变化时重读周期：修稿生成、合并提交都会改它，而审稿报告本身不变。 */
  refreshKey?: string
}) {
  const snapshot = parseHumanConfirmedReviewSnapshot(reportText)
  const cycleReviewId = confirmationSourceReviewId(snapshot, reviewId)
  // 读回的周期记着属于哪份审稿：重新审稿后新周期读回来之前，不把上一份审稿的周期当成这一份的。
  const [loadedCycle, setLoadedCycle] = useState<{ reviewId: number | undefined; cycle: ReviewCycleProjection | null }>(
    () => ({ reviewId: cycleReviewId, cycle: cycle ?? null }))

  const reloadCycle = async (): Promise<ReviewCycleProjection | null> => {
    if (!isReviewId(cycleReviewId)) return null
    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) return null
    const next = await ipc.invokeWithProjectSession(projectSession, 'db:review-cycle-get', cycleReviewId,
      projectSession.projectPath)
    if (isProjectSessionCurrent(projectSession)) setLoadedCycle({ reviewId: cycleReviewId, cycle: next })
    return next
  }

  useEffect(() => {
    if (cycle !== undefined || !isReviewId(cycleReviewId)) return
    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    let cancelled = false
    void (async () => {
      const next = await ipc.invokeWithProjectSession(projectSession, 'db:review-cycle-get', cycleReviewId,
        projectSession.projectPath)
      if (!cancelled && isProjectSessionCurrent(projectSession)) setLoadedCycle({ reviewId: cycleReviewId, cycle: next })
    })()
    return () => { cancelled = true }
  }, [cycleReviewId, cycle, projectKey, refreshKey])

  const resolvedCycle = cycle !== undefined ? cycle : loadedCycle.reviewId === cycleReviewId ? loadedCycle.cycle : null
  // 报告可以原地更新；会话键只在底层不可变报告变了时变，可编辑清单随之重置。
  const sessionKey = String(reviewId ?? 'untracked')
    + ':' + String(snapshot?.sourceReviewId ?? 'raw')
    + ':' + projectKey
    + ':' + reportText
  return { snapshot, cycle: resolvedCycle, reloadCycle, sessionKey }
}

export interface ReviewChecklistInput {
  /** 原始审稿报告文本（JSON 或旧版 markdown） */
  reportText: string
  /** 审稿报告关联的草稿路径（用于触发修稿） */
  draftPath?: string
  chapterNumber?: number
  chapterDir?: string
  /** 原始 AI 审稿报告的数据库 ID；确认快照必须持续指向该记录。 */
  reviewId?: number
  projectKey: string
  initialSnapshot: HumanConfirmedReviewSnapshot | null
  cycle?: ReviewCycleProjection | null
  reloadCycle: () => Promise<ReviewCycleProjection | null>
}

/**
 * 审稿清单：逐项纳入或忽略、作者补充问题与总体指导、确认为不可变快照、按确认意见修稿、合并后复验。
 * 单章视图的审稿侧页用它；挂载方用 useReviewCycle 的 sessionKey 作 key，报告变了就重置。
 */
export function useReviewChecklist({
  reportText,
  draftPath,
  chapterNumber,
  chapterDir,
  projectKey,
  reviewId,
  initialSnapshot,
  cycle,
  reloadCycle,
}: ReviewChecklistInput) {
  const text = useLocaleStore(s => s.text)
  const parsedReport = parseReport(reportText, text('综合检查', 'General review'))
  const [items, setItems] = useState<EditableReviewItem[]>(() => (
    editableItemsFromReview(parsedReport.issues, initialSnapshot, cycle)
  ))
  const [authorGuidance, setAuthorGuidance] = useState(() => initialSnapshot?.authorGuidance ?? '')
  const [confirmed, setConfirmed] = useState<ConfirmedChecklist | null>(() => (
    initialSnapshot && isReviewId(reviewId)
      ? {
        reviewSourceId: reviewId,
        content: reportText,
        snapshot: initialSnapshot,
      }
      : null
  ))
  const [editingChecklist, setEditingChecklist] = useState(() => !initialSnapshot || !isReviewId(reviewId))
  const [checklistError, setChecklistError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [rechecking, setRechecking] = useState(false)
  const [recheckMessage, setRecheckMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const sourceReviewId = confirmationSourceReviewId(initialSnapshot, reviewId)
  const summary = initialSnapshot?.summary ?? parsedReport.summary
  const goalReview = confirmed?.snapshot.goalReview ?? initialSnapshot?.goalReview ?? parsedReport.goalReview
  const canManageChecklist = Boolean(draftPath && chapterDir)

  useEffect(() => {
    if (initialSnapshot || !draftPath || !chapterDir || !isReviewId(reviewId)) return

    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) return

    let cancelled = false
    void (async () => {
      const { parseDraftMeta } = await import('../../services/workflows/chapter-workflow')
      if (cancelled || !isProjectSessionCurrent(projectSession)) return
      const draftMeta = await parseDraftMeta(
        draftPath,
        projectSession.projectPath,
        projectSession,
      )
      if (cancelled || !isProjectSessionCurrent(projectSession) || !draftMeta) return

      const latestReview = await ipc.invokeWithProjectSession(
        projectSession,
        'db:review-get-latest',
        draftMeta.id,
        projectSession.projectPath,
      )
      if (cancelled || !isProjectSessionCurrent(projectSession) || !latestReview) return

      const restoredSnapshot = parseHumanConfirmedReviewSnapshot(latestReview.content)
      if (!restoredSnapshot || restoredSnapshot.sourceReviewId !== reviewId) return

      setItems(editableItemsFromReview([], restoredSnapshot, cycle))
      setAuthorGuidance(restoredSnapshot.authorGuidance)
      setConfirmed({
        reviewSourceId: latestReview.id,
        content: latestReview.content,
        snapshot: restoredSnapshot,
      })
      setEditingChecklist(false)
    })()

    return () => {
      cancelled = true
    }
  }, [chapterDir, cycle, draftPath, initialSnapshot, projectKey, reviewId])


  const updateItem = (itemId: string, patch: Partial<EditableReviewItem>) => {
    setItems(current => current.map(item => item.id === itemId ? { ...item, ...patch } : item))
    setChecklistError(null)
  }

  const removeItem = (itemId: string) => {
    setItems(current => current.filter(candidate => candidate.id !== itemId))
  }

  const addAuthorItem = () => {
    setItems(current => {
      const authorItemCount = current.filter(item => item.origin === 'author').length
      return [
        ...current,
        {
          id: 'author-' + Date.now() + '-' + (authorItemCount + 1),
          reviewItemIndex: current.length,
          category: text('作者补充', 'Author note'),
          severity: 'warning',
          description: '',
          decision: 'apply',
          origin: 'author',
        },
      ]
    })
  }

  const confirmChecklist = async (): Promise<ConfirmedChecklist | null> => {
    if (!draftPath || !chapterDir) {
      setChecklistError(text(
        '此审稿报告未关联到可修稿的草稿，无法确认清单。',
        'This review is not linked to a revisable draft, so its checklist cannot be confirmed.',
      ))
      return null
    }
    if (!isReviewId(sourceReviewId)) {
      setChecklistError(text(
        '此审稿报告缺少原始审稿记录，无法确认。请重新运行 AI 审稿。',
        'This review has no source record, so it cannot be confirmed. Run AI review again.',
      ))
      return null
    }

    if (items.some(item => item.origin === 'author' && !item.description.trim())) {
      setChecklistError(text(
        '请填写或移除空白的人工问题后再确认。',
        'Fill in or remove blank author-added issues before confirming.',
      ))
      return null
    }

    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) {
      setChecklistError(text(
        '当前项目会话已失效，请重新打开该项目后再确认。',
        'The current project session is no longer active. Reopen the project and try again.',
      ))
      return null
    }

    setConfirming(true)
    try {
      const { parseDraftMeta } = await import('../../services/workflows/chapter-workflow')
      if (!isProjectSessionCurrent(projectSession)) return null
      const draftMeta = await parseDraftMeta(
        draftPath,
        projectSession.projectPath,
        projectSession,
      )
      if (!isProjectSessionCurrent(projectSession)) return null
      if (!draftMeta) {
        setChecklistError(text(
          '找不到关联草稿，无法确认审稿清单。',
          'The associated draft could not be found, so the review checklist cannot be confirmed.',
        ))
        return null
      }

      const sourceReview = await ipc.invokeWithProjectSession(
        projectSession,
        'db:review-get-full',
        sourceReviewId,
        projectSession.projectPath,
      )
      if (!isProjectSessionCurrent(projectSession)) return null
      const { readDraftBody } = await import('../../stores/draft-store')
      const currentDraftContent = await readDraftBody(
        draftPath,
        projectSession.projectPath,
        projectSession,
      )
      if (!isProjectSessionCurrent(projectSession)) return null
      if (
        !sourceReview
        || sourceReview.id !== sourceReviewId
        || sourceReview.baseDraftId !== draftMeta.id
        || !sourceReview.sourceDraft
        || !matchesReviewSource(sourceReview.sourceDraft, draftMeta, currentDraftContent)
      ) {
        setChecklistError(text(
          '源草稿已变化，无法确认这份旧审稿；请重新运行 AI 审稿。',
          'The source draft changed, so this stale review cannot be confirmed. Run AI review again.',
        ))
        return null
      }

      const snapshot = createHumanConfirmedReviewSnapshot({
        sourceReviewId,
        sourceDraft: sourceReview.sourceDraft,
        ...(cycle?.cycleId || initialSnapshot?.cycleId
          ? { cycleId: cycle?.cycleId ?? initialSnapshot?.cycleId }
          : {}),
        summary,
        authorGuidance,
        ...(goalReview ? { goalReview } : {}),
        items: items.map((item) => {
          const findingId = item.findingId ?? (item.origin === 'ai'
            ? cycle?.findings.find(finding => finding.reviewItemIndex === item.reviewItemIndex)?.findingId
            : undefined)
          return {
            category: item.category,
            severity: item.severity,
            description: item.description,
            ...(item.quote?.trim() ? { quote: item.quote.trim() } : {}),
            ...(item.stableFactKey ? { stableFactKey: item.stableFactKey } : {}),
            ...(item.sourceChapter ? { sourceChapter: item.sourceChapter } : {}),
            ...(item.goalId ? { goalId: item.goalId } : {}),
            ...(findingId ? { findingId } : {}),
            decision: item.decision,
            origin: item.origin,
          }
        }),
      })
      if (!snapshot) {
        setChecklistError(text(
          '审稿清单包含未填写的分类、问题或严重程度；请补充后再确认。',
          'The checklist has an empty category, issue, or severity. Complete it before confirming.',
        ))
        return null
      }

      const reviewIndex = await ipc.invokeWithProjectSession(
        projectSession,
        'db:review-next-index',
        draftMeta.id,
        projectSession.projectPath,
      )
      if (!isProjectSessionCurrent(projectSession)) return null
      const content = serializeHumanConfirmedReviewSnapshot(snapshot)
        const createResponse = await ipc.invokeWithProjectSession(projectSession, 'db:review-create', {
          baseDraftId: draftMeta.id,
          reviewIndex,
          content,
          expectedSource: sourceReview.sourceDraft,
          ...(cycle?.cycleId ? { reviewCycleId: cycle.cycleId } : {}),
        }, projectSession.projectPath)
      if (createResponse.errorCode === 'SOURCE_DRAFT_CHANGED') {
        throw new Error(text(
          '确认期间源草稿已变化，清单未保存；请重新运行 AI 审稿。',
          'The source draft changed during confirmation, so the checklist was not saved. Run AI review again.',
        ))
      }
      const createResult = requireIpcSuccess(
        createResponse,
        text('保存确认审稿清单', 'Save confirmed review checklist'),
      )
      if (!isProjectSessionCurrent(projectSession)) return null
      if (!isReviewId(createResult.id)) {
        throw new Error(text(
          '确认审稿清单未返回记录标识。',
          'The confirmed checklist did not return a record identifier.',
        ))
      }

      const saved = { reviewSourceId: createResult.id, content, snapshot }
      setConfirmed(saved)
      setEditingChecklist(false)
      setChecklistError(null)
      return saved
    } catch (error) {
      if (!isProjectSessionCurrent(projectSession)) return null
      setChecklistError(displayedErrorMessage(
        useLocaleStore.getState().locale,
        error,
        text('确认审稿清单时发生错误。', 'An error occurred while confirming the review checklist.'),
      ))
    } finally {
      if (isProjectSessionCurrent(projectSession)) setConfirming(false)
    }
    return null
  }

  /** 按已确认的清单修稿；checklist 不传时取当前已确认且未再编辑的清单。返回错误说明，成功启动时为 null。 */
  const startConfirmedRevision = async (generationModelId: string, checklist: ConfirmedChecklist | null = editingChecklist ? null : confirmed): Promise<string | null> => {
    if (!checklist) {
      return text(
        '请先确认审稿清单后再启动修稿。',
        'Confirm the review checklist before starting a revision.',
      )
    }
    if (!hasIncludedReviewItems(checklist.snapshot)) {
      const error = text(
        '未纳入任何审稿项，无法启动修稿。请恢复至少一项错误或建议后重新确认。',
        'No review item is included. Restore at least one issue or suggestion, then confirm again before revising.',
      )
      setChecklistError(error)
      return error
    }
    if (!draftPath || !chapterDir) {
      return text(
        '此审稿报告未关联到可修稿的草稿。',
        'This review is not linked to a revisable draft.',
      )
    }

    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) {
      return text(
        '当前项目会话已失效，请重新打开该项目后再试。',
        'The current project session is no longer active. Reopen the project and try again.',
      )
    }

    setProcessing(true)
    try {
      const { readDraftBody } = await import('../../stores/draft-store')
      const draftContent = await readDraftBody(
        draftPath,
        projectSession.projectPath,
        projectSession,
      )
      if (!isProjectSessionCurrent(projectSession)) return null
      if (!draftContent) {
        return text(
          '关联草稿为空或无法读取，未启动修稿。',
          'The associated draft is empty or unreadable; revision was not started.',
        )
      }

      // Re-check after every asynchronous preflight: a deleted or repurposed
      // profile must never be frozen into a revision workflow.
      const currentModelId = availableGenerationModelId(
        useLLMStore.getState().models,
        generationModelId,
      )
      if (!currentModelId) {
        return text(
          '所选修稿模型已不可用。请选择一项可用于文本生成的模型后再试。',
          'The selected revision model is no longer available. Select a compatible generation model and try again.',
        )
      }

      const { createRefineFromReviewWorkflow, parseDraftMeta } = await import('../../services/workflows/chapter-workflow')
      const draftMeta = await parseDraftMeta(
        draftPath,
        projectSession.projectPath,
        projectSession,
      )
      if (!isProjectSessionCurrent(projectSession)) return null
      if (!draftMeta) {
        return text(
          '找不到关联草稿，未启动修稿。',
          'The associated draft could not be found; revision was not started.',
        )
      }
      if (
        !checklist.snapshot.sourceDraft
        || !matchesReviewSource(checklist.snapshot.sourceDraft, draftMeta, draftContent)
      ) {
        return text(
          '源草稿已变化，未启动修稿；请重新运行 AI 审稿并确认清单。',
          'The source draft changed, so revision was not started. Run AI review and confirm the checklist again.',
        )
      }

      const frozenGenerationModelId = availableGenerationModelId(
        useLLMStore.getState().models,
        currentModelId,
      )
      if (!frozenGenerationModelId) {
        return text(
          '所选修稿模型已不可用。请选择一项可用于文本生成的模型后再试。',
          'The selected revision model is no longer available. Select a compatible generation model and try again.',
        )
      }

      const chapterNum = draftMeta.chapterNumber || chapterNumber || 0
      const chapterTitle = draftMeta.chapterTitle || text(
        '第' + chapterNum + '章',
        'Chapter ' + chapterNum,
      )
      const { useWorkflowStore } = await import('../../stores/workflow-store')
      if (!isProjectSessionCurrent(projectSession)) return null
      useWorkflowStore.getState().startWorkflow(createRefineFromReviewWorkflow({
        projectPath: projectSession.projectPath,
        chapterNumber: chapterNum,
        chapterTitle,
        draftPath,
        draftContent,
        confirmedReviewContent: checklist.content,
        reviewSourceId: checklist.reviewSourceId,
        generationModelId: frozenGenerationModelId,
      }, projectSession), false)
      setChecklistError(null)
      return null
    } catch (error) {
      if (!isProjectSessionCurrent(projectSession)) return null
      return displayedErrorMessage(useLocaleStore.getState().locale, error,
        text('启动审稿修稿时发生错误。', 'An error occurred while starting the review-driven revision.'))
    } finally {
      if (isProjectSessionCurrent(projectSession)) setProcessing(false)
    }
  }

  const retryRequiredRecheck = async () => {
    if (!cycle || cycle.revisionStatus !== 'merge-committed' || cycle.recheckDisposition !== 'required'
      || !cycle.mergedHash || !draftPath) return
    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) {
      setRecheckMessage({ kind: 'error', text: text(
        '当前项目会话已失效，请重新打开项目后重试复验。',
        'The project session is no longer active. Reopen the project and retry the recheck.',
      ) })
      return
    }
    setRechecking(true)
    setRecheckMessage(null)
    try {
      const [{ createReviewOnlyWorkflow, parseDraftMeta }, { readDraftBody }, { useWorkflowStore }, { useEditorStore }] = await Promise.all([
        import('../../services/workflows/chapter-workflow'),
        import('../../stores/draft-store'),
        import('../../stores/workflow-store'),
        import('../../stores/editor-store'),
      ])
      if (!isProjectSessionCurrent(projectSession)) return
      const [draftMeta, draftContent] = await Promise.all([
        parseDraftMeta(draftPath, projectSession.projectPath, projectSession),
        readDraftBody(draftPath, projectSession.projectPath, projectSession),
      ])
      if (!isProjectSessionCurrent(projectSession)) return
      if (!draftMeta || !draftContent) throw new Error(text(
        '关联的合并稿不可读，无法启动复验。',
        'The merged draft cannot be read, so the recheck was not started.',
      ))
      const draftTab = useEditorStore.getState().tabs.find(tab => (
        tab.projectKey === projectSession.projectPath && tab.filePath === draftPath
      ))
      const workflow = createReviewOnlyWorkflow({
        projectPath: projectSession.projectPath,
        chapterNumber: draftMeta.chapterNumber,
        chapterTitle: draftMeta.chapterTitle || text(`第${draftMeta.chapterNumber}章`, `Chapter ${draftMeta.chapterNumber}`),
        draftPath,
        draftContent,
        sourceDraft: { id: draftMeta.id, chapterNumber: draftMeta.chapterNumber, version: draftMeta.version,
          status: draftMeta.status, contentRevision: draftTab?.contentRevision ?? 0 },
        reviewCycleId: cycle.cycleId,
        expectedMergedHash: cycle.mergedHash,
      }, projectSession)
      const workflowStore = useWorkflowStore.getState()
      const conflict = workflowStore.getResourceConflict(workflow)
      if (conflict) throw new Error(text(
        `复验暂未启动：任务“${conflict.title}”正在占用本章。`,
        `The recheck was not started because “${conflict.title}” is using this chapter.`,
      ))
      const runId = await workflowStore.startWorkflow(workflow, false)
      if (!isProjectSessionCurrent(projectSession)) return
      const run = useWorkflowStore.getState().history.find(candidate => candidate.id === runId)
      if (!run || run.status !== 'completed') throw new Error(run?.error || text(
        '复验任务未完成；可在修复模型或资源问题后再次重试。',
        'The recheck did not complete. Fix the model or resource issue and retry.',
      ))
      const refreshed = await reloadCycle()
      if (!isProjectSessionCurrent(projectSession)) return
      if (refreshed?.recheckDisposition !== 'completed') throw new Error(text(
        '复验已运行，但持久化状态仍未完成，请重试。',
        'The recheck ran, but its persisted state is still incomplete. Retry it.',
      ))
      setRecheckMessage({ kind: 'success', text: text('合并后复验已完成。', 'The post-merge recheck is complete.') })
    } catch (error) {
      if (isProjectSessionCurrent(projectSession)) setRecheckMessage({ kind: 'error', text: displayedErrorMessage(useLocaleStore.getState().locale, error,
        text('启动合并后复验时发生错误。', 'An error occurred while starting the post-merge recheck.')) })
    } finally {
      if (isProjectSessionCurrent(projectSession)) setRechecking(false)
    }
  }

  return {
    items, authorGuidance, setAuthorGuidance, confirmed, editingChecklist, setEditingChecklist,
    checklistError, setChecklistError, confirming, processing, rechecking, recheckMessage,
    summary, goalReview, canManageChecklist, cycle,
    updateItem, removeItem, addAuthorItem, confirmChecklist, startConfirmedRevision, retryRequiredRecheck,
  }
}

/** 严重程度的名称、处理建议与计数用词；两种审稿界面共用。 */
export function severityCopy(
  severity: ReviewIssue['severity'],
  text: (zhCNText: string, enUSText: string) => string,
) {
  switch (severity) {
    case 'unknown':
      return {
        label: text('待核实', 'Needs verification'),
        actionLabel: text('证据不足，不代表通过；默认不修稿', 'Insufficient evidence; not passed or included by default'),
        countLabel: text('待核实', 'unverified'),
      }
    case 'error':
      return {
        label: text('严重问题', 'Critical issue'),
        actionLabel: text('强烈建议修复', 'Strongly recommended to fix'),
        countLabel: text('严重', 'critical'),
      }
    case 'warning':
      return {
        label: text('改进建议', 'Improvement'),
        actionLabel: text('建议酌情修复', 'Consider fixing'),
        countLabel: text('建议', 'suggestions'),
      }
    default:
      return {
        label: text('检查通过', 'Passed'),
        actionLabel: text('无需处理', 'No action needed'),
        countLabel: text('通过', 'passed'),
      }
  }
}

/** 审稿项要不要用于修稿：纳入为勾选。「通过」只展示，没有勾选框。 */
export function includedCount(items: readonly EditableReviewItem[]): number {
  return items.filter(item => item.severity !== 'pass' && item.decision === 'apply').length
}
