import { useState } from 'react'
import {
  AlertTriangle,
  CheckCircle,
  CircleMinus,
  FileCheck2,
  HelpCircle,
  Info,
  ListChecks,
  Pencil,
  Plus,
  Quote,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { Button } from '../ui/Button'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from '../ui/Dialog'
import { Input } from '../ui/Input'
import { Label } from '../ui/Label'
import { NativeSelect } from '../ui/NativeSelect'
import { Textarea } from '../ui/Textarea'
import { captureProjectSession, isProjectSessionCurrent, isProjectSessionPath } from '../project-session-gate'
import { useProjectStore } from '../../stores/project-store'
import { useLocaleStore } from '../../stores/locale-store'
import { useLLMStore } from '../../stores/llm-store'
import { ipc } from '../../services/ipc-client'
import { requireIpcSuccess } from '../../services/ipc-result'
import type { ModelProfile } from '../../shared/ipc-channels'
import {
  createHumanConfirmedReviewSnapshot,
  hasIncludedReviewItems,
  parseHumanConfirmedReviewSnapshot,
  renderHumanConfirmedReviewBrief,
  serializeHumanConfirmedReviewSnapshot,
  type HumanConfirmedReviewItem,
  type HumanConfirmedReviewSnapshot,
} from '../../shared/human-confirmed-review'

/** 审稿问题条目（JSON 格式） */
interface ReviewIssue {
  category: string
  severity: 'error' | 'warning' | 'pass'
  description: string
  /** 引用的原文片段（有问题时提供） */
  quote?: string
}

/** AI 返回的 JSON 审稿结构 */
interface ReviewJSON {
  items: Array<{
    category: string
    severity: string
    description: string
    quote?: string
  }>
  summary: string
}

interface ReviewReportProps {
  /** 原始审稿报告文本（JSON 或旧版 markdown） */
  reportText: string
  /** 审稿报告关联的草稿路径（用于触发修稿） */
  draftPath?: string
  /** 章节号 */
  chapterNumber?: number
  /** 章节目录 */
  chapterDir?: string
  /** 原始 AI 审稿报告的数据库 ID；确认快照必须持续指向该记录。 */
  reviewId?: number
  /** 审稿与草稿所属项目。 */
  projectKey: string
}

interface EditableReviewItem extends HumanConfirmedReviewItem {
  id: string
  severity: ReviewIssue['severity']
}

interface ConfirmedChecklist {
  /** The newly appended confirmation row, which is the revision's reviewSourceId. */
  reviewSourceId: number
  content: string
  snapshot: HumanConfirmedReviewSnapshot
}

// ===== 解析器 =====

/** 标准化 severity 值 */
function normalizeSeverity(raw: string): ReviewIssue['severity'] {
  const s = raw.toLowerCase().trim()
  if (s === 'error' || s === 'critical' || s === 'severe') return 'error'
  if (s === 'warning' || s === 'warn' || s === 'minor') return 'warning'
  return 'pass'
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
function parseReport(text: string, fallbackCategory: string): { issues: ReviewIssue[]; summary: string } {
  const jsonStr = extractJSON(text)
  if (jsonStr) {
    try {
      const data = JSON.parse(jsonStr) as ReviewJSON
      if (data.items && Array.isArray(data.items)) {
        const issues: ReviewIssue[] = data.items.map(item => ({
          category: item.category || fallbackCategory,
          severity: normalizeSeverity(item.severity),
          description: item.description || '',
          quote: item.quote || undefined,
        }))
        return { issues, summary: data.summary || '' }
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

// ===== 视觉配置 =====

const SEVERITY_META: Record<ReviewIssue['severity'], {
  colorClass: string
  bgClass: string
  borderClass: string
}> = {
  error: {
    colorClass: 'text-[var(--color-error-text)]',
    bgClass: 'bg-red-500/10',
    borderClass: 'border-red-500/30',
  },
  warning: {
    colorClass: 'text-[var(--color-warning-text)]',
    bgClass: 'bg-yellow-500/10',
    borderClass: 'border-yellow-500/30',
  },
  pass: {
    colorClass: 'text-[var(--color-success-text)]',
    bgClass: 'bg-green-500/10',
    borderClass: 'border-green-500/30',
  },
}

function severityCopy(
  severity: ReviewIssue['severity'],
  text: (zhCNText: string, enUSText: string) => string,
) {
  switch (severity) {
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

function SeverityIcon({ severity }: { severity: ReviewIssue['severity'] }) {
  if (severity === 'error') return <AlertTriangle size={14} className="flex-shrink-0" style={{ color: 'var(--color-error)' }} />
  if (severity === 'warning') return <AlertTriangle size={14} className="flex-shrink-0" style={{ color: 'var(--color-warning)' }} />
  return <CheckCircle size={14} className="flex-shrink-0" style={{ color: 'var(--color-success)' }} />
}

function isGenerationModel(model: ModelProfile): boolean {
  return model.purposes.includes('generation')
}

function availableGenerationModelId(
  models: ModelProfile[],
  modelId: string | null | undefined,
): string | null {
  return modelId && models.some(model => model.id === modelId && isGenerationModel(model))
    ? modelId
    : null
}

function preferredGenerationModelId(models: ModelProfile[], defaultModelId: string | null): string | null {
  return availableGenerationModelId(models, defaultModelId)
    ?? models.find(isGenerationModel)?.id
    ?? null
}

function isReviewId(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function editableItemsFromReview(
  issues: ReviewIssue[],
  snapshot: HumanConfirmedReviewSnapshot | null,
): EditableReviewItem[] {
  if (snapshot) {
    return snapshot.items.map((item, index) => ({
      ...item,
      id: item.origin + '-' + (index + 1),
      severity: normalizeSeverity(item.severity),
    }))
  }

  return issues.map((issue, index) => ({
    id: 'ai-' + (index + 1),
    category: issue.category,
    severity: issue.severity,
    description: issue.description,
    ...(issue.quote ? { quote: issue.quote } : {}),
    decision: issue.severity === 'pass' ? 'ignore' : 'apply',
    origin: 'ai',
  }))
}

function confirmationSourceReviewId(
  snapshot: HumanConfirmedReviewSnapshot | null,
  reviewId: number | undefined,
): number | undefined {
  return snapshot?.sourceReviewId ?? reviewId
}

/** 审稿报告查看器 */
export default function ReviewReport(props: ReviewReportProps) {
  const snapshot = parseHumanConfirmedReviewSnapshot(props.reportText)
  const reportKey = String(props.reviewId ?? 'untracked')
    + ':' + String(snapshot?.sourceReviewId ?? 'raw')
    + ':' + props.reportText

  // A report tab can update in place. A keyed session resets its editable
  // checklist only when the underlying immutable report changes.
  return <ReviewReportSession key={reportKey} {...props} initialSnapshot={snapshot} />
}

interface ReviewReportSessionProps extends ReviewReportProps {
  initialSnapshot: HumanConfirmedReviewSnapshot | null
}

function ReviewReportSession({
  reportText,
  draftPath,
  chapterNumber,
  chapterDir,
  projectKey,
  reviewId,
  initialSnapshot,
}: ReviewReportSessionProps) {
  const text = useLocaleStore(s => s.text)
  const parsedReport = parseReport(reportText, text('综合检查', 'General review'))
  const [items, setItems] = useState<EditableReviewItem[]>(() => (
    editableItemsFromReview(parsedReport.issues, initialSnapshot)
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
  const [showRevisionDialog, setShowRevisionDialog] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [showLegend, setShowLegend] = useState(false)
  const sourceReviewId = confirmationSourceReviewId(initialSnapshot, reviewId)
  const summary = initialSnapshot?.summary ?? parsedReport.summary
  const canManageChecklist = Boolean(draftPath && chapterDir)

  // 按分类分组
  const categories = new Map<string, EditableReviewItem[]>()
  for (const item of items) {
    const list = categories.get(item.category) || []
    list.push(item)
    categories.set(item.category, list)
  }

  // 统计
  const errorCount = items.filter((i) => i.severity === 'error').length
  const warningCount = items.filter((i) => i.severity === 'warning').length
  const passCount = items.filter((i) => i.severity === 'pass').length
  const errorCopy = severityCopy('error', text)
  const warningCopy = severityCopy('warning', text)
  const passCopy = severityCopy('pass', text)

  const updateItem = (itemId: string, patch: Partial<EditableReviewItem>) => {
    setItems(current => current.map(item => item.id === itemId ? { ...item, ...patch } : item))
    setChecklistError(null)
  }

  const addAuthorItem = () => {
    setItems(current => {
      const authorItemCount = current.filter(item => item.origin === 'author').length
      return [
        ...current,
        {
          id: 'author-' + Date.now() + '-' + (authorItemCount + 1),
          category: text('作者补充', 'Author note'),
          severity: 'warning',
          description: '',
          decision: 'apply',
          origin: 'author',
        },
      ]
    })
  }

  const confirmChecklist = async () => {
    if (!draftPath || !chapterDir) {
      setChecklistError(text(
        '此审稿报告未关联到可修稿的草稿，无法确认清单。',
        'This review is not linked to a revisable draft, so its checklist cannot be confirmed.',
      ))
      return
    }
    if (!isReviewId(sourceReviewId)) {
      setChecklistError(text(
        '此审稿报告缺少原始审稿记录，无法确认。请重新运行 AI 审稿。',
        'This review has no source record, so it cannot be confirmed. Run AI review again.',
      ))
      return
    }

    if (items.some(item => item.origin === 'author' && !item.description.trim())) {
      setChecklistError(text(
        '请填写或移除空白的人工问题后再确认。',
        'Fill in or remove blank author-added issues before confirming.',
      ))
      return
    }

    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) {
      setChecklistError(text(
        '当前项目会话已失效，请重新打开该项目后再确认。',
        'The current project session is no longer active. Reopen the project and try again.',
      ))
      return
    }

    const snapshot = createHumanConfirmedReviewSnapshot({
      sourceReviewId,
      summary,
      authorGuidance,
      items: items.map(({ category, severity, description, quote, decision, origin }) => ({
        category,
        severity,
        description,
        ...(quote?.trim() ? { quote: quote.trim() } : {}),
        decision,
        origin,
      })),
    })
    if (!snapshot) {
      setChecklistError(text(
        '审稿清单包含未填写的分类、问题或严重程度；请补充后再确认。',
        'The checklist has an empty category, issue, or severity. Complete it before confirming.',
      ))
      return
    }

    setConfirming(true)
    try {
      const { parseDraftMeta } = await import('../../services/workflows/chapter-workflow')
      if (!isProjectSessionCurrent(projectSession)) return
      const draftMeta = await parseDraftMeta(
        draftPath,
        projectSession.projectPath,
        projectSession,
      )
      if (!isProjectSessionCurrent(projectSession)) return
      if (!draftMeta) {
        setChecklistError(text(
          '找不到关联草稿，无法确认审稿清单。',
          'The associated draft could not be found, so the review checklist cannot be confirmed.',
        ))
        return
      }

      const reviewIndex = await ipc.invokeWithProjectSession(
        projectSession,
        'db:review-next-index',
        draftMeta.id,
        projectSession.projectPath,
      )
      if (!isProjectSessionCurrent(projectSession)) return
      const content = serializeHumanConfirmedReviewSnapshot(snapshot)
      const createResult = requireIpcSuccess(
        await ipc.invokeWithProjectSession(projectSession, 'db:review-create', {
          baseDraftId: draftMeta.id,
          reviewIndex,
          content,
        }, projectSession.projectPath),
        text('保存确认审稿清单', 'Save confirmed review checklist'),
      )
      if (!isProjectSessionCurrent(projectSession)) return
      if (!isReviewId(createResult.id)) {
        throw new Error(text(
          '确认审稿清单未返回记录标识。',
          'The confirmed checklist did not return a record identifier.',
        ))
      }

      setConfirmed({
        reviewSourceId: createResult.id,
        content,
        snapshot,
      })
      setEditingChecklist(false)
      setChecklistError(null)
    } catch (error) {
      if (!isProjectSessionCurrent(projectSession)) return
      setChecklistError(error instanceof Error
        ? error.message
        : text('确认审稿清单时发生错误。', 'An error occurred while confirming the review checklist.'))
    } finally {
      if (isProjectSessionCurrent(projectSession)) setConfirming(false)
    }
  }

  const startConfirmedRevision = async (generationModelId: string): Promise<string | null> => {
    if (!confirmed || editingChecklist) {
      return text(
        '请先确认审稿清单后再启动修稿。',
        'Confirm the review checklist before starting a revision.',
      )
    }
    if (!hasIncludedReviewItems(confirmed.snapshot)) {
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
        confirmedReviewContent: confirmed.content,
        reviewSourceId: confirmed.reviewSourceId,
        generationModelId: frozenGenerationModelId,
      }, projectSession), false)
      setChecklistError(null)
      return null
    } catch (error) {
      if (!isProjectSessionCurrent(projectSession)) return null
      return error instanceof Error
        ? error.message
        : text('启动审稿修稿时发生错误。', 'An error occurred while starting the review-driven revision.')
    } finally {
      if (isProjectSessionCurrent(projectSession)) setProcessing(false)
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 py-4">
        {/* 统计栏 */}
        <div className="flex items-center gap-4 mb-4 pb-3 border-b border-[var(--color-border)]">
          <h3 className="text-base font-bold text-[var(--color-text)]">{text('审稿报告', 'Review report')}</h3>
          <div className="flex items-center gap-3 text-xs ml-auto">
            {errorCount > 0 && (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-red-500/20 text-[var(--color-error-text)]">
                <SeverityIcon severity="error" /> {errorCount} {errorCopy.countLabel}
              </span>
            )}
            {warningCount > 0 && (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-yellow-500/20 text-[var(--color-warning-text)]">
                <SeverityIcon severity="warning" /> {warningCount} {warningCopy.countLabel}
              </span>
            )}
            <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-green-500/20 text-[var(--color-success-text)]">
              <SeverityIcon severity="pass" /> {passCount} {passCopy.countLabel}
            </span>
            {/* 图例帮助按钮 */}
            <button
              className="flex items-center justify-center rounded-full hover:bg-[var(--color-hover)] transition-colors"
              style={{ width: 22, height: 22 }}
              onClick={() => setShowLegend(!showLegend)}
              title={text('颜色说明', 'Color legend')}
            >
              <HelpCircle size={14} style={{ color: 'var(--color-text-muted)' }} />
            </button>
          </div>
        </div>

        {/* 颜色图例说明 */}
        {showLegend && (
          <div
            className="mb-4 rounded-lg border p-3 text-xs space-y-2"
            style={{
              backgroundColor: 'var(--color-bg-elevated)',
              borderColor: 'var(--color-border)',
            }}
          >
            <div className="font-medium text-[var(--color-text)] mb-1.5">{text('颜色标记说明', 'Color legend')}</div>
            {(['error', 'warning', 'pass'] as const).map(sev => {
              const meta = SEVERITY_META[sev]
              const copy = severityCopy(sev, text)
              return (
                <div key={sev} className="flex items-center gap-2">
                  <span className={cn(
                    'inline-flex items-center gap-1 px-2 py-0.5 rounded',
                    meta.bgClass, meta.colorClass
                  )}>
                    <SeverityIcon severity={sev} /> {copy.label}
                  </span>
                  <span style={{ color: 'var(--color-text-secondary)' }}>
                    — {copy.actionLabel}
                  </span>
                </div>
              )
            })}
          </div>
        )}

        {/* 总体评价（如有） */}
        {summary && (
          <div
            className="mb-4 px-4 py-3 rounded-lg border text-sm"
            style={{
              backgroundColor: 'var(--color-bg-elevated)',
              borderColor: 'var(--color-border)',
              color: 'var(--color-text)',
            }}
          >
            <span className="font-medium">{text('总体评价：', 'Overall assessment:')}</span>
            <span style={{ color: 'var(--color-text-secondary)' }}>{summary}</span>
          </div>
        )}

        {/* 分类展示 */}
        {items.length === 0 ? (
          <div className="text-center py-8 text-[var(--color-text-muted)] text-sm">
            <CheckCircle size={32} className="mx-auto mb-2" style={{ color: 'var(--color-success)' }} />
            {text('审稿通过，未发现问题', 'Review passed. No issues found.')}
          </div>
        ) : (
          <div className="space-y-4">
            {Array.from(categories.entries()).map(([category, items]) => (
              <div key={category}>
                <h4 className="text-sm font-semibold text-[var(--color-text)] mb-2 flex items-center gap-1.5">
                  <Info size={14} className="text-[var(--color-text-muted)]" />
                  {category}
                </h4>
                <div className="space-y-1.5 pl-1">
                  {items.map((item) => {
                    const meta = SEVERITY_META[item.severity]
                    const copy = severityCopy(item.severity, text)
                    const isPass = item.severity === 'pass'
                    const isEmptyAuthorIssue = item.origin === 'author' && !item.description.trim()
                    return (
                      <div
                        key={item.id}
                        className={cn(
                          'px-3 py-2 rounded-md border text-xs leading-relaxed',
                          meta.borderClass, meta.bgClass
                        )}
                      >
                        <div className="flex items-start gap-2">
                          <SeverityIcon severity={item.severity} />
                          <div className="flex-1 min-w-0 space-y-2">
                            {editingChecklist && !isPass ? (
                              <>
                                <div className="grid grid-cols-[minmax(0,1fr)_130px] gap-2">
                                  <Input
                                    aria-label={text('问题分类', 'Issue category')}
                                    value={item.category}
                                    onChange={(event) => updateItem(item.id, { category: event.target.value })}
                                  />
                                  <NativeSelect
                                    aria-label={text('严重程度', 'Severity')}
                                    value={item.severity}
                                    onChange={(event) => updateItem(item.id, {
                                      severity: normalizeSeverity(event.target.value),
                                    })}
                                  >
                                    <option value="error">{text('严重问题', 'Critical issue')}</option>
                                    <option value="warning">{text('改进建议', 'Improvement')}</option>
                                  </NativeSelect>
                                </div>
                                <Textarea
                                  aria-label={text('审稿问题', 'Review issue')}
                                  aria-invalid={isEmptyAuthorIssue || undefined}
                                  aria-describedby={isEmptyAuthorIssue ? `author-issue-hint-${item.id}` : undefined}
                                  value={item.description}
                                  placeholder={item.origin === 'author' ? text(
                                    '请填写需要纳入本次修稿的具体问题',
                                    'Describe the specific issue to include in this revision',
                                  ) : undefined}
                                  onChange={(event) => updateItem(item.id, { description: event.target.value })}
                                />
                                {isEmptyAuthorIssue && (
                                  <p
                                    id={`author-issue-hint-${item.id}`}
                                    className="text-[0.7rem] text-[var(--color-warning-text)]"
                                  >
                                    {text(
                                      '请填写具体问题，或移除这一项。',
                                      'Describe the issue, or remove this item.',
                                    )}
                                  </p>
                                )}
                                <Input
                                  aria-label={text('相关原文（可选）', 'Related text (optional)')}
                                  value={item.quote ?? ''}
                                  placeholder={text('相关原文（可选）', 'Related text (optional)')}
                                  onChange={(event) => updateItem(item.id, { quote: event.target.value })}
                                />
                              </>
                            ) : (
                              <div>
                                <span className="text-[var(--color-text-secondary)]">{item.description}</span>
                                <span className={cn('ml-2 text-[0.65rem] opacity-70', meta.colorClass)}>
                                  [{copy.actionLabel}]
                                </span>
                              </div>
                            )}
                            {!isPass && editingChecklist && (
                              <div className="flex items-center justify-between gap-2">
                                <span className={cn('text-[0.7rem]', meta.colorClass)}>
                                  {item.decision === 'apply'
                                    ? text('已纳入本次修稿', 'Included in this revision')
                                    : text('已忽略，不会传给模型', 'Ignored; not sent to the model')}
                                </span>
                                <div className="flex items-center gap-1">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => updateItem(item.id, {
                                      decision: item.decision === 'apply' ? 'ignore' : 'apply',
                                    })}
                                  >
                                    {item.decision === 'apply'
                                      ? <CircleMinus size={12} />
                                      : <RotateCcw size={12} />}
                                    {item.decision === 'apply'
                                      ? text('忽略', 'Ignore')
                                      : text('恢复', 'Restore')}
                                  </Button>
                                  {item.origin === 'author' && (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => setItems(current => current.filter(candidate => candidate.id !== item.id))}
                                      title={text('移除人工问题', 'Remove author issue')}
                                    >
                                      <X size={12} />
                                      {text('移除', 'Remove')}
                                    </Button>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                        {/* 引用原文（如有） */}
                        {!editingChecklist && item.quote && (
                          <div
                            className="mt-1.5 ml-5 pl-2 text-[0.7rem] italic"
                            style={{
                              borderLeft: '2px solid var(--color-border)',
                              color: 'var(--color-text-muted)',
                            }}
                          >
                            <Quote size={10} className="inline mr-1 opacity-60" />
                            {item.quote}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        <section className="mt-6 rounded-lg border border-[var(--color-border)] p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h4 className="text-sm font-semibold text-[var(--color-text)] flex items-center gap-1.5">
                <ListChecks size={15} className="text-[var(--color-accent)]" />
                {text('人工确认修稿清单', 'Human-confirmed revision checklist')}
              </h4>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                {editingChecklist
                  ? text('错误和建议默认纳入；“通过”仅展示，不会成为修稿任务。', 'Issues and suggestions are included by default; passed checks stay visible but are never revision tasks.')
                  : text('已保存为新的不可变确认快照；原始 AI 审稿未被修改。', 'Saved as a new immutable confirmation snapshot; the original AI review was not modified.')}
              </p>
            </div>
            {confirmed && !editingChecklist && (
              <span className="inline-flex items-center gap-1 text-xs text-[var(--color-success-text)]">
                <FileCheck2 size={14} />
                {text('已确认', 'Confirmed')}
              </span>
            )}
          </div>

          {editingChecklist && (
            <>
              <div>
                <Label htmlFor="review-author-guidance">
                  {text('总体修稿指导（可选）', 'Overall revision guidance (optional)')}
                </Label>
                <Textarea
                  id="review-author-guidance"
                  value={authorGuidance}
                  onChange={(event) => setAuthorGuidance(event.target.value)}
                  placeholder={text(
                    '例如：优先修复角色动机的前后不一致，保持本章克制的叙事节奏。',
                    'For example: prioritize inconsistent character motivation while keeping this chapter’s restrained pace.',
                  )}
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={addAuthorItem}>
                  <Plus size={13} />
                  {text('新增人工问题', 'Add author issue')}
                </Button>
                {canManageChecklist ? (
                  <Button variant="ai" size="sm" onClick={confirmChecklist} disabled={confirming}>
                    <FileCheck2 size={13} />
                    {confirmed
                      ? text('重新确认审稿清单', 'Confirm updated checklist')
                      : text('确认审稿清单', 'Confirm review checklist')}
                  </Button>
                ) : (
                  <span className="text-xs text-[var(--color-text-muted)]">
                    {text('关联草稿后可确认清单。', 'Link this report to a draft to confirm the checklist.')}
                  </span>
                )}
              </div>
            </>
          )}

          {confirmed && !editingChecklist && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setEditingChecklist(true)
                  setChecklistError(null)
                }}
              >
                <Pencil size={13} />
                {text('编辑清单', 'Edit checklist')}
              </Button>
              <Button
                variant="ai"
                size="sm"
                onClick={() => {
                  if (!hasIncludedReviewItems(confirmed.snapshot)) {
                    setChecklistError(text(
                      '未纳入任何审稿项，无法启动修稿。请恢复至少一项错误或建议后重新确认。',
                      'No review item is included. Restore at least one issue or suggestion, then confirm again before revising.',
                    ))
                    return
                  }
                  setChecklistError(null)
                  setShowRevisionDialog(true)
                }}
                disabled={processing}
              >
                <Sparkles size={13} />
                {text('按确认意见修稿', 'Revise from confirmed checklist')}
              </Button>
            </div>
          )}

          {checklistError && (
            <p role="alert" className="text-xs text-[var(--color-error-text)]">
              {checklistError}
            </p>
          )}
        </section>

        {/* 原始文本折叠 */}
        <details className="mt-6">
          <summary className="text-xs text-[var(--color-text-muted)] cursor-pointer hover:text-[var(--color-text)]">
            {text(
              initialSnapshot ? '查看此确认记录原文' : '查看原始 AI 审稿文本',
              initialSnapshot ? 'View this confirmation record' : 'View original AI review text',
            )}
          </summary>
          <pre className="mt-2 text-xs whitespace-pre-wrap font-mono leading-5 text-[var(--color-text-secondary)] bg-[var(--color-sidebar)] rounded-md p-3 border border-[var(--color-border)]">
            {reportText}
          </pre>
        </details>
      </div>

      {showRevisionDialog && confirmed && (
        <ConfirmedRevisionDialog
          snapshot={confirmed.snapshot}
          onClose={() => setShowRevisionDialog(false)}
          onStart={startConfirmedRevision}
        />
      )}
    </div>
  )
}

interface ConfirmedRevisionDialogProps {
  snapshot: HumanConfirmedReviewSnapshot
  onClose: () => void
  onStart: (generationModelId: string) => Promise<string | null>
}

/**
 * Mounted only while open so every revision gets a fresh local snapshot of the
 * global default model. The chooser never writes to the global default.
 */
function ConfirmedRevisionDialog({ snapshot, onClose, onStart }: ConfirmedRevisionDialogProps) {
  const text = useLocaleStore(s => s.text)
  const models = useLLMStore(s => s.models)
  const defaultModelId = useLLMStore(s => s.defaultModelId)
  const [generationModelId, setGenerationModelId] = useState<string | null>(() => (
    preferredGenerationModelId(models, defaultModelId)
  ))
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const generationModels = models.filter(isGenerationModel)
  const fallbackGenerationModelId = preferredGenerationModelId(models, defaultModelId)
  const selectedGenerationModelId = generationModelId ?? fallbackGenerationModelId
  const selectedGenerationModel = generationModels.find(model => model.id === selectedGenerationModelId)
  const modelSelectionError = generationModels.length === 0
    ? text(
      '没有已配置且可用于文本生成的模型。请在设置中添加或启用一项生成模型。',
      'No configured model can generate text. Add or enable a generation model in Settings.',
    )
    : !selectedGenerationModel
      ? text(
        '所选修稿模型已不可用。请选择一项可用于文本生成的模型后再试。',
        'The selected revision model is no longer available. Select a compatible generation model and try again.',
      )
      : null
  const confirmedBrief = renderHumanConfirmedReviewBrief(snapshot)

  const start = async () => {
    if (modelSelectionError || !selectedGenerationModelId) {
      setStartError(modelSelectionError ?? text(
        '请选择一项可用于文本生成的模型。',
        'Select a compatible generation model before starting.',
      ))
      return
    }

    const frozenGenerationModelId = availableGenerationModelId(
      useLLMStore.getState().models,
      selectedGenerationModelId,
    )
    if (!frozenGenerationModelId) {
      setStartError(text(
        '所选修稿模型已不可用。请选择一项可用于文本生成的模型后再试。',
        'The selected revision model is no longer available. Select a compatible generation model and try again.',
      ))
      return
    }

    setStarting(true)
    try {
      const error = await onStart(frozenGenerationModelId)
      if (error) {
        setStartError(error)
        return
      }
      onClose()
    } catch (error) {
      setStartError(error instanceof Error
        ? error.message
        : text('启动审稿修稿时发生错误。', 'An error occurred while starting the review-driven revision.'))
    } finally {
      setStarting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => {
      if (!open && !starting) onClose()
    }}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles size={15} className="text-[var(--color-accent)]" />
            {text('按确认意见修稿', 'Revise from confirmed checklist')}
          </DialogTitle>
          <DialogDescription>
            {text(
              '仅将已确认纳入的审稿项和作者指导传给修稿流程；已忽略项与原始 AI 报告不会成为模型指令。',
              'Only confirmed review items and author guidance are sent to revision. Ignored items and the raw AI report are not model instructions.',
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="px-5 py-2 space-y-3">
          <div>
            <Label htmlFor="review-revision-model">
              {text('本次修稿模型', 'Model for this revision')}
            </Label>
            <NativeSelect
              id="review-revision-model"
              value={selectedGenerationModelId ?? ''}
              onChange={(event) => {
                setGenerationModelId(event.target.value || null)
                setStartError(null)
              }}
              disabled={generationModels.length === 0 || starting}
            >
              <option value="" disabled>{text('请选择可用生成模型', 'Select a generation model')}</option>
              {generationModels.map(model => (
                <option key={model.id} value={model.id}>{model.name || model.modelName}</option>
              ))}
            </NativeSelect>
            <p className="mt-1 text-[0.7rem] text-[var(--color-text-muted)]">
              {text('仅用于本次修稿，不会更改默认模型。', 'Used for this revision only; it does not change the default model.')}
            </p>
            {modelSelectionError && (
              <p role="alert" className="mt-1 text-xs text-[var(--color-error-text)]">
                {modelSelectionError}
              </p>
            )}
          </div>
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3">
            <div className="mb-1 text-xs font-medium text-[var(--color-text)]">
              {text('将传给修稿流程的已确认意见', 'Confirmed guidance sent to revision')}
            </div>
            <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap font-sans text-xs leading-5 text-[var(--color-text-secondary)]">
              {confirmedBrief}
            </pre>
          </div>
          {startError && (
            <p role="alert" className="text-xs text-[var(--color-error-text)]">
              {startError}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={starting}>
            {text('取消', 'Cancel')}
          </Button>
          <Button variant="ai" onClick={start} disabled={starting || Boolean(modelSelectionError)}>
            <Sparkles size={13} />
            {text('开始修稿', 'Start revision')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
