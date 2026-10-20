import type { Locale } from '../../i18n/types'
import type { MainGenerationRunView } from '../../services/generation/generation-runtime'
import type { GenerationBudgetDiagnostic } from '../../services/generation/task-budget-planner'
import { canCommitRecoveredReview } from '../../services/workflows/commands/review-chapter.command'
import { withoutDraftReconciliationArtifacts } from '../../shared/draft-reconciliation'
import type { EditorInlineRecovery } from '../../shared/editor-inline-generation'
import type { GenerationBatchHistory, GenerationRecoveryContext } from '../../shared/generation-owner-contract'
import { plotOutlineSourceInvalidText } from '../../shared/plot-outline-contract'
import type { RecoveryCandidate } from '../../shared/recovery-candidate'
import type { ReviewRevisionRecovery } from '../../shared/review-revision-generation'
import { workflowResourceKey, type WorkflowRun } from '../../stores/workflow-store'

/**
 * 运行中断后可以接着做的事。运行侧页从这里取标题、提示、可复制的文字与动作是否可用，
 * 自己只负责排版；数据由 use-run-recovery 读取，动作也由它执行。
 */
export type RecoveryEntry = CandidateEntry | PlanningEntry | EditorEntry | ReviewEntry | BatchEntry | DraftEntry

export interface RecoveryText {
  id: string
  text: string
}

interface Usage {
  budget?: readonly GenerationBudgetDiagnostic[]
  /** 「已用 N 次请求」。 */
  usage?: string
}

/** 写作中断时留下的正文候选（旧的恢复候选表）。 */
export interface CandidateEntry {
  kind: 'candidate'
  key: string
  title: string
  staleNote?: string
  text: string
  canContinue: boolean
  candidate: RecoveryCandidate
}

/** 情节大纲或章节蓝图自动生成中断后保留的恢复稿。 */
export interface PlanningEntry {
  kind: 'planning'
  key: string
  title: string
  note: string
  actionLabel: string
  recovery: GenerationRecoveryContext
}

/** 正文选区的 AI 建议（润色、扩写等）中断。 */
export interface EditorEntry extends Usage {
  kind: 'editor'
  key: string
  title: string
  selectedText: string
  conflictNote?: string
  suggestions: (RecoveryText & { incompleteNote?: string })[]
  tails: RecoveryText[]
  documentText: string
  canContinue: boolean
  labels: { copySuggestion: string; copyTail: string; copyDocument: string; continue: string }
  recovery: EditorInlineRecovery
}

/** 审稿或修稿中断。 */
export interface ReviewEntry extends Usage {
  kind: 'review'
  key: string
  chapterNumber: number
  title: string
  notes: string[]
  artifacts: RecoveryText[]
  tails: RecoveryText[]
  actionLabel: string
  canAct: boolean
  labels: { copy: string; copyTail: string }
  view: MainGenerationRunView
}

/** 批量创作中断，可从下一章继续。 */
export interface BatchEntry {
  kind: 'batch'
  key: string
  title: string
  staleNote?: string
  canContinue: boolean
  actionLabel: string
  batchId: string
  range: { startChapter: number; endChapter: number }
}

/** 单章写作中断：勾选保留的片段续写，或沿已存细纲继续。 */
export interface DraftEntry extends Usage {
  kind: 'draft'
  key: string
  chapterNumber?: number
  title: string
  artifacts: (RecoveryText & { selectable: boolean })[]
  tails: RecoveryText[]
  note: string
  actionLabel: string
  /** 草稿已保存且正文后来改过：只能复制。 */
  changed: boolean
  /** 没有已存的续写方案时，至少要勾选一段才能继续。 */
  needsPick: boolean
  labels: { copy: string; tailLead: string }
  view: MainGenerationRunView
}

export interface RecoverySources {
  candidates: readonly RecoveryCandidate[]
  planning: readonly GenerationRecoveryContext[]
  editors: readonly EditorInlineRecovery[]
  reviews: readonly { view: MainGenerationRunView; recovery: ReviewRevisionRecovery }[]
  batches: readonly GenerationBatchHistory[]
  drafts: readonly { view: MainGenerationRunView; recovery: GenerationRecoveryContext }[]
}

export const EMPTY_RECOVERY_SOURCES: RecoverySources = { candidates: [], planning: [], editors: [], reviews: [], batches: [], drafts: [] }

function lang(locale: Locale) {
  return (zh: string, en: string) => locale === 'en-US' ? en : zh
}

function usageOf(view: Pick<MainGenerationRunView, 'budgetDiagnostics' | 'ledger'>, locale: Locale): Usage {
  const t = lang(locale)
  return {
    budget: view.budgetDiagnostics,
    usage: view.ledger ? t(`已用 ${view.ledger.physicalRequests} 次请求`, `${view.ledger.physicalRequests} requests used`) : undefined,
  }
}

/** 没写出任何字的片段（例如刚发出请求就取消）没有可复制、可续接的内容，不列出。 */
export const hasText = (item: { text: string }) => item.text.trim().length > 0

const texts = (items: readonly { attemptId: string; text: string }[] | undefined): RecoveryText[] =>
  (items ?? []).filter(hasText).map(item => ({ id: item.attemptId, text: item.text }))

export function candidateEntry(candidate: RecoveryCandidate, locale: Locale): CandidateEntry {
  const t = lang(locale)
  return {
    kind: 'candidate',
    key: candidate.candidateId,
    title: t(
      `${candidate.replacesCandidateId ? '替代候选' : '原始候选'} · 第${candidate.chapterNumber}章 ${candidate.chapterTitle}`,
      `${candidate.replacesCandidateId ? 'Replacement candidate' : 'Original candidate'} · Chapter ${candidate.chapterNumber} ${candidate.chapterTitle}`,
    ),
    staleNote: candidate.sourceCurrent ? undefined : t('源章节已变化；可复制或放弃，但不能直接继续。', 'The source chapter changed. You can copy or discard this candidate, but cannot continue it directly.'),
    text: candidate.visibleText,
    canContinue: candidate.sourceCurrent,
    candidate,
  }
}

/** 大纲分批生成会留下多份恢复稿，标题带上各自的章节范围以便区分。 */
export function planningTitle(recovery: Pick<GenerationRecoveryContext, 'plotOutlineRecovery' | 'plotOutline'>, locale: Locale): string {
  const t = lang(locale)
  if (!recovery.plotOutlineRecovery) return t('蓝图恢复稿', 'Blueprint recovery draft')
  const range = recovery.plotOutline?.range
  if (!range) return t('大纲恢复稿', 'Outline recovery draft')
  const chapters = range.from === range.to ? `${range.from}` : `${range.from}–${range.to}`
  return t(`大纲恢复稿 · 第 ${chapters} 章`, `Outline recovery draft · ch. ${chapters}`)
}

/** 恢复稿编辑器顶部的待完成范围；只剩一章时与标题一样写「第 6 章」。 */
export function planningRemainingText(range: { from: number; to: number }, targetUnits: number, unit: string, text: (zh: string, en: string) => string): string {
  return range.from === range.to
    ? text(`待完成第 ${range.from} 章，每章目标 ${targetUnits} ${unit}。`, `Chapter ${range.from} remains. Target ${targetUnits} ${unit} per chapter.`)
    : text(`待完成第 ${range.from} 至 ${range.to} 章，每章目标 ${targetUnits} ${unit}。`, `Chapters ${range.from} to ${range.to} remain. Target ${targetUnits} ${unit} per chapter.`)
}

/** 升级前以现行规则判无效的大纲开跑、不能继续的大纲恢复稿：说明是重复章号、乱序还是章号与范围对不上；不是来源无效时为 null，由调用方用通用说明。 */
export function outlineSourceInvalidNote(recovery: Pick<GenerationRecoveryContext, 'plotOutline' | 'plotOutlineRecovery'>, locale: Locale): string | null {
  const writeState = recovery.plotOutlineRecovery?.writeState
  if (writeState?.kind !== 'blocked' || writeState.reason !== 'source-invalid') return null
  return plotOutlineSourceInvalidText(recovery.plotOutline?.sourceExpected.synopsis ?? '', locale)
}

/** 大纲恢复稿因来源（模型设置、作品设定、提示词模板或写作 Skill）已变而被封锁写回。 */
export function outlineSourceChangedBlocked(recovery: Pick<GenerationRecoveryContext, 'plotOutlineRecovery'>): boolean {
  const writeState = recovery.plotOutlineRecovery?.writeState
  return writeState?.kind === 'blocked' && writeState.reason === 'source-changed'
}

/**
 * 来源已变的大纲恢复稿：只能查看或复制；正式大纲还没有这一批时（含最后一章生成完、正式保存被来源检查拒绝）
 * 要从本批起始章重新生成。其余情况为 null。
 */
export function outlineSourceChangedNote(recovery: Pick<GenerationRecoveryContext, 'plotOutline' | 'plotOutlineRecovery'>, locale: Locale): string | null {
  if (!outlineSourceChangedBlocked(recovery)) return null
  const t = lang(locale), outline = recovery.plotOutline
  if (recovery.plotOutlineRecovery?.inFormalOutline) {
    return t('这批大纲已经生成完毕，但模型设置、作品设定、提示词模板或写作 Skill 已经变了，恢复稿不能覆盖正式内容，只能查看或复制。',
      'This outline batch finished, but the model settings, book settings, a prompt template or a writing skill have changed, so this recovery draft cannot replace saved content. You can view or copy it.')
  }
  const from = outline?.range.from
  return from
    ? t(`模型设置、作品设定、提示词模板或写作 Skill 已经变了，恢复稿不能覆盖正式内容，只能查看或复制。请从第 ${from} 章重新生成情节大纲。`,
      `The model settings, book settings, a prompt template or a writing skill changed, so this recovery draft cannot replace saved content. View or copy it, then generate the plot outline again from chapter ${from}.`)
    : t('模型设置、作品设定、提示词模板或写作 Skill 已经变了，恢复稿不能覆盖正式内容，只能查看或复制。请重新生成情节大纲。',
      'The model settings, book settings, a prompt template or a writing skill changed, so this recovery draft cannot replace saved content. View or copy it, then generate the plot outline again.')
}

function planningEntry(recovery: GenerationRecoveryContext, locale: Locale): PlanningEntry {
  const t = lang(locale)
  const sourceChanged = outlineSourceChangedNote(recovery, locale)
  return {
    kind: 'planning',
    key: recovery.handle.runId,
    title: planningTitle(recovery, locale),
    note: outlineSourceInvalidNote(recovery, locale) ?? sourceChanged
      ?? t('自动生成已保留候选。可编辑并本地保存，或明确继续缺少的章节。', 'The candidate is preserved. Edit and save it locally, or explicitly generate the remaining chapters.'),
    actionLabel: sourceChanged ? t('查看恢复稿', 'View recovery draft') : t('编辑恢复稿', 'Edit recovery draft'),
    recovery,
  }
}

function editorEntry(recovery: EditorInlineRecovery, locale: Locale): EditorEntry {
  const t = lang(locale)
  const { view } = recovery
  return {
    kind: 'editor',
    key: view.handle.runId,
    title: t('编辑器选区建议', 'Editor selection suggestion'),
    selectedText: recovery.context.selectedText,
    ...usageOf(view, locale),
    conflictNote: recovery.sourceStatus === 'conflict' ? t('来源已变化；原建议仍可复制。', 'Sources changed; the original suggestion can still be copied.') : undefined,
    suggestions: (view.candidates ?? view.artifacts).filter(hasText).map(artifact => ({
      id: artifact.artifactId,
      text: artifact.text,
      incompleteNote: artifact.status === 'completed' ? undefined : t('生成未完整完成，保留的文字仅供参考。', 'Generation is incomplete; the saved text is for reference.'),
    })),
    tails: texts(view.unsavedTails),
    documentText: recovery.context.documentText,
    canContinue: recovery.sourceStatus === 'current' && view.status !== 'cancelled'
      && view.ledger?.physicalRequests === 0 && !(view.candidates?.length || view.artifacts.length),
    labels: {
      copySuggestion: t('复制建议', 'Copy suggestion'),
      copyTail: t('复制未保存文字', 'Copy unsaved text'),
      copyDocument: t('复制原文稿', 'Copy original manuscript'),
      continue: t('继续原选区任务', 'Continue original selection task'),
    },
    recovery,
  }
}

function reviewEntry({ view, recovery }: RecoverySources['reviews'][number], locale: Locale): ReviewEntry {
  const t = lang(locale)
  const review = recovery.context.operation === 'review-chapter'
  const requestsReview = review && !recovery.saved && !canCommitRecoveredReview(recovery)
  const current = recovery.sourceStatus === 'current'
  const live = view.status !== 'cancelled'
  const notes = [
    recovery.sourceStatus === 'conflict' && !recovery.saved
      && t('来源已变化；候选仍可复制，不能直接保存。', 'Sources changed; copy the candidate to preserve it. Direct saving is unavailable.'),
    current && !recovery.saved && !recovery.canResume && !review
      && t('候选未通过保存校验；可复制保留，请从原稿重新发起任务。', 'The candidate failed save validation. Copy it if needed, then start a new action from the source draft.'),
    current && live && !recovery.saved && !recovery.canResume && review
      && t('当前任务的审稿请求次数已用尽。原稿保留，可从原稿发起新的审稿任务。', 'This task has used all review attempts. The source draft is preserved. Start a new review task from the source draft.'),
    requestsReview && current && live && recovery.canResume
      && t('尚无完整审稿报告。重新审稿会重新调用模型；原稿保留。', 'No complete review report is available. Reviewing again sends a new model request; the source draft is preserved.'),
  ].filter((note): note is string => Boolean(note))
  return {
    kind: 'review',
    key: view.handle.runId,
    chapterNumber: recovery.context.source.chapterNumber,
    title: t(`第${recovery.context.source.chapterNumber}章${review ? '审稿' : '修稿'}候选`,
      `Chapter ${recovery.context.source.chapterNumber} ${review ? 'review' : 'revision'} candidate`),
    ...usageOf(view, locale),
    notes,
    artifacts: (view.candidates ?? view.artifacts).filter(hasText).map(artifact => ({ id: artifact.artifactId, text: artifact.text })),
    tails: texts(view.unsavedTails),
    actionLabel: recovery.saved ? t('打开已保存结果', 'Open saved result')
      : requestsReview ? t('重新审稿', 'Review again') : t('恢复此审修任务', 'Recover this review or revision'),
    canAct: Boolean(recovery.saved) || (recovery.canResume && current && live),
    labels: { copy: t('复制', 'Copy'), copyTail: t('复制未保存文字', 'Copy unsaved text') },
    view,
  }
}

function batchEntry(batch: GenerationBatchHistory, locale: Locale): BatchEntry {
  const t = lang(locale)
  return {
    kind: 'batch',
    key: batch.batchId,
    title: t(`批量正文：已保存 ${batch.completedChapters.length} 章，下一章 ${batch.nextChapterNumber}`,
      `Batch drafts: ${batch.completedChapters.length} saved; next chapter ${batch.nextChapterNumber}`),
    staleNote: batch.sourceCurrent ? undefined : t('批次来源已变化，不能继续此批次。请从当前正文发起新任务。',
      'The batch source changed. This batch cannot continue. Start a new task from the current text.'),
    canContinue: batch.sourceCurrent,
    actionLabel: t('继续此批次', 'Continue this batch'),
    batchId: batch.batchId,
    range: batch.range,
  }
}

function draftEntry({ view, recovery }: RecoverySources['drafts'][number], locale: Locale): DraftEntry {
  const t = lang(locale)
  const unique = [...new Map([...view.artifacts, ...(view.candidates ?? [])].map(item => [item.artifactId, item])).values()]
  const changed = recovery.draftSave.kind === 'changed'
  const outlineOnly = !recovery.composition && recovery.attemptedPurposes.every(purpose => purpose === 'chapter-draft-short-outline')
    && Boolean(recovery.draftShortOutline?.completedOutput || recovery.draftShortOutline?.retry?.kind === 'available')
  return {
    kind: 'draft',
    key: view.handle.runId,
    chapterNumber: recovery.chapterNumber,
    title: changed ? t(`第${recovery.chapterNumber}章生成记录`, `Chapter ${recovery.chapterNumber} generation history`)
      : t(`第${recovery.chapterNumber}章候选`, `Chapter ${recovery.chapterNumber} candidate`),
    ...usageOf(view, locale),
    artifacts: withoutDraftReconciliationArtifacts(unique, recovery).filter(hasText).map(artifact => ({
      id: artifact.artifactId, text: artifact.text, selectable: !changed && artifact.compositionEligible === true,
    })),
    tails: texts(view.unsavedTails),
    note: changed ? t('草稿已保存，正文后来已修改。请从草稿箱打开当前正文；原生成文字仍可复制。',
      'The draft was saved and later edited. Open the current text from Drafts. The original generated text can still be copied.')
      : t('勾选顺序决定续接顺序；未完成或来源冲突的片段仍可复制。', 'Selection order determines continuation order. Incomplete or conflicted text can still be copied.'),
    actionLabel: changed ? t('已保存，正文已修改', 'Saved, then edited')
      : outlineOnly ? recovery.draftShortOutline?.retry?.kind === 'available'
        ? t('重做一次细纲并继续写稿', 'Retry outline once and continue drafting')
        : t('沿原细纲继续写稿', 'Continue drafting with the saved outline')
        : t('确认继续已选正文', 'Confirm selected draft continuation'),
    changed,
    needsPick: !recovery.composition && !outlineOnly,
    labels: { copy: t('复制', 'Copy'), tailLead: t('尚未落盘的正文，可先复制保留：', 'Text not yet saved; copy it to preserve it:') },
    view,
  }
}

/**
 * 这次打开作品后还在进行的工作：它正显示在运行卡片里，不是中断留下的。
 * 单章与审修要这次打开里有单章运行正占着这一章：会话内失败时持久状态不会改，仍记为 running，不能当作还在写。
 * 批量运行也占着各章，但它写的正文带批次号、不列为单章条目（use-run-recovery），也不跑审修，所以不算。
 * 选区生成不是工作流运行，看 epoch：上次打开时没写完的换过会话，仍算可恢复。
 * 批量看进行中（含暂停）的批量运行：资源锁让同一批章同时只有一个批量运行在写，范围相同就是它在推进这一批。
 */
export function isInFlight(entry: RecoveryEntry, leaseId: string | undefined, liveRuns: readonly Pick<WorkflowRun, 'type' | 'resourceKeys'>[]): boolean {
  if (entry.kind === 'batch') return liveRuns.some(run => run.type === 'batch_generate' && sameChapters(run.resourceKeys, entry.range))
  if (entry.kind === 'editor') return entry.recovery.view.status === 'running' && entry.recovery.view.handle.epoch === leaseId
  if ((entry.kind !== 'draft' && entry.kind !== 'review') || entry.chapterNumber === undefined) return false
  const chapter = workflowResourceKey('chapter', entry.chapterNumber)
  return entry.view.status === 'running' && entry.view.handle.epoch === leaseId
    && liveRuns.some(run => run.type !== 'batch_generate' && run.resourceKeys?.includes(chapter))
}

function sameChapters(keys: readonly string[] | undefined, range: BatchEntry['range']): boolean {
  const chapters = (keys ?? []).flatMap(key => /^chapter:(\d+)$/.exec(key)?.[1] ?? []).map(Number)
  return chapters.length === range.endChapter - range.startChapter + 1
    && chapters.every((chapter, index) => chapter === range.startChapter + index)
}

/** 单章候选的续写按钮是否可点：没有改过正文，且勾了片段或有已存方案可沿用。 */
export function canResumeDraft(entry: DraftEntry, picked: readonly string[]): boolean {
  return !entry.changed && (picked.length > 0 || !entry.needsPick)
}

/** 列出顺序与旧 AI 输出一致：恢复稿、选区建议、审修、批量、单章，最后是旧的恢复候选表。 */
export function buildRecoveryEntries(sources: RecoverySources, locale: Locale): RecoveryEntry[] {
  return [
    ...sources.planning.map(recovery => planningEntry(recovery, locale)),
    ...sources.editors.map(recovery => editorEntry(recovery, locale)),
    ...sources.reviews.map(item => reviewEntry(item, locale)),
    ...sources.batches.map(batch => batchEntry(batch, locale)),
    ...sources.drafts.map(item => draftEntry(item, locale)),
    ...sources.candidates.map(candidate => candidateEntry(candidate, locale)),
  ]
}
