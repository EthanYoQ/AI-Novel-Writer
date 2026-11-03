import type { DraftMeta } from '../../services/draft-index'
import type { NovelConfig } from '../../shared/ipc-channels'
import type { ReviewCycleProjection } from '../../shared/review-cycle'
import type { EditorTab } from '../editor-store'
import type { WorkflowRun } from '../workflow-store'
import type { ResourcePage, WorkStage } from './navigation-intents'
import type { StageWork } from './stage-store'

/** 设定的必填项，与设定画板一致：一段核心大纲，加类型、篇幅、目标读者三项。 */
export type SetupField = 'coreOutline' | 'genre' | 'length' | 'targetAudience'
export const SETUP_FIELDS: readonly SetupField[] = ['coreOutline', 'genre', 'length', 'targetAudience']

/**
 * 架构的四节：故事前提、角色名单、世界观、情节大纲。
 * ia.md 写的是「4 节均已确认」，但产品里各节没有确认状态（ArchitectureConfirmDialog 只是生成前勾选步骤），
 * 所以取架构页徽标同一个判定：前提、世界观有内容，角色名单已就绪，情节大纲按分批检查点全书写完且没有中断的批次（checkArchConfirmed）。
 */
export const ARCHITECTURE_SECTIONS = ['premise', 'characters', 'worldbuilding', 'synopsis'] as const

/** 完成为实心勾选圆，进行中为按比例填充的进度环，未开始为虚线圆。 */
export type StageProgress =
  | { state: 'done' }
  | { state: 'active'; ratio: number }
  | { state: 'todo' }

export type StageStatus =
  | { stage: 'setup'; progress: StageProgress; missing: readonly SetupField[] }
  | { stage: 'architecture'; progress: StageProgress; filled: number; total: number }
  /** total 是设定里的规划章数；至少 1 章蓝图即完成，planned / total 只作进度说明。 */
  | { stage: 'blueprint'; progress: StageProgress; planned: number; total: number }
  | { stage: 'manuscript'; progress: StageProgress; finalized: number; total: number }

/** 一章所处的位置：待写、草稿（待审稿）、已审稿（待修稿）、有修稿待合并、已修稿（待定稿）、定稿。 */
export type ChapterPhase = 'todo' | 'draft' | 'reviewed' | 'merge' | 'revised' | 'final'

/** 一稿走到哪一步要看的审稿与修稿记录，由 chapter-facts 读出；流程脊与单章视图读同一份。 */
export interface ChapterFacts {
  /** 可以合并的待合并修稿 id，按生成先后。 */
  mergeable: readonly number[]
  /** 不能再合并、只能查看或丢弃的待合并修稿：edited 是生成后正文或稿状态变了，unsourced 是旧修稿没有记下生成时的源稿。 */
  stale: readonly { id: number; reason: 'edited' | 'unsourced' }[]
  /** 这一稿最新的审稿；cycleStatus 是它所属复验周期的修稿进度，旧审稿与合并后的自动复验没有周期。 */
  latestReview: { createdAt: string; cycleStatus: ReviewCycleProjection['revisionStatus'] | null } | null
  /** 最近一次合并修稿的时间；没合并过为 null。 */
  lastMergedAt: string | null
}

/**
 * 一稿（未归档）走到哪一步。数据库里没有代码把草稿设为 reviewed：审稿只新增审稿记录，合并修稿才把稿改成 revised，
 * 所以 reviewed 状态与草稿一样看记录。有可合并的修稿就停在合并；过期的修稿不占主流程。
 * 已修稿的稿只有在最近一次合并之后又审过稿、且那份审稿的复验周期还没合并时才算已审稿：合并前的审稿（比如审稿后直接修稿合并）
 * 与合并后的自动复验都不算。合并与审稿落在同一秒时按合并在后处理。
 */
export function chapterPhase(status: Exclude<DraftMeta['status'], 'archived' | 'superseded'>, facts: ChapterFacts | undefined): ChapterPhase {
  if (status === 'finalized') return 'final'
  if (!facts) return status === 'revised' ? 'revised' : 'draft'
  const { mergeable, latestReview: review, lastMergedAt } = facts
  if (mergeable.length > 0) return 'merge'
  if (status !== 'revised') return review ? 'reviewed' : 'draft'
  if (!review?.cycleStatus || review.cycleStatus === 'merge-committed') return 'revised'
  return lastMergedAt === null || review.createdAt > lastMergedAt ? 'reviewed' : 'revised'
}

export interface ChapterRow {
  number: number
  title: string
  phase: ChapterPhase
  /** 有工作流正在写这一章。 */
  running: boolean
  /** 打开这一章时载入的稿：有定稿之后才建的未归档草稿时取它，否则取定稿，再否则取最新的未归档草稿；待写章为空。 */
  draft: DraftMeta | null
  /** 这一章有定稿；当前稿可能是定稿之后新建的草稿。 */
  hasFinal: boolean
}

export interface WorkFacts {
  config: Pick<NovelConfig, 'coreOutline' | 'genre' | 'targetAudience' | 'totalChapters' | 'wordsPerChapter'>
  architecture: StageWork['architecture']
  blueprints: StageWork['blueprints']
  drafts: Readonly<Record<number, readonly DraftMeta[]>>
  runningChapters: ReadonlySet<number>
  /** 按稿 id 的审稿与修稿记录；还没读出的稿按状态估计。 */
  chapterFacts?: Readonly<Record<number, ChapterFacts>>
}

const DONE: StageProgress = { state: 'done' }
const TODO: StageProgress = { state: 'todo' }

function fraction(done: number, total: number): StageProgress {
  if (total <= 0 || done <= 0) return TODO
  return done >= total ? DONE : { state: 'active', ratio: done / total }
}

export function missingSetup(config: WorkFacts['config']): SetupField[] {
  const blank = (value: string | undefined) => !value?.trim()
  // 与主进程的作品概览同一口径：章数、字数都得是正的安全整数。
  const count = (value: number) => Number.isSafeInteger(value) && value > 0
  return SETUP_FIELDS.filter(field => field === 'length'
    ? !(count(config.totalChapters) && count(config.wordsPerChapter))
    : blank(config[field]))
}

/** 这一章动过笔：有定稿（之后又新建了空草稿也算），或当前稿有正文。只有空的当前稿不算；没记字数的旧稿按有正文算。 */
const begun = (row: ChapterRow) => row.hasFinal || (row.phase !== 'todo' && row.draft?.wordCount !== 0)

/**
 * 四个阶段的状态，顺序固定为设定、架构、蓝图、正文。完成判定按 ia.md：设定必填项齐全，架构四节都有内容，
 * 蓝图至少 1 章（分批规划的作品不会因为没规划完就一直停在蓝图），正文按章统计。
 * 定稿章数与章节列表同源：定稿之后又建了草稿的章按草稿算，不计入定稿。
 */
export function deriveStages(facts: WorkFacts, chapters: readonly ChapterRow[] = deriveChapters(facts)): StageStatus[] {
  const missing = missingSetup(facts.config)
  const filled = ARCHITECTURE_SECTIONS.filter(section => facts.architecture[section]).length
  const total = Math.max(0, facts.config.totalChapters || 0)
  const planned = facts.blueprints.length
  const finalized = chapters.filter(row => row.phase === 'final').length
  const started = chapters.some(begun)
  return [
    { stage: 'setup', missing,
      progress: missing.length === 0 ? DONE : { state: 'active', ratio: (SETUP_FIELDS.length - missing.length) / SETUP_FIELDS.length } },
    { stage: 'architecture', filled, total: ARCHITECTURE_SECTIONS.length, progress: fraction(filled, ARCHITECTURE_SECTIONS.length) },
    { stage: 'blueprint', planned, total, progress: planned > 0 ? DONE : TODO },
    { stage: 'manuscript', finalized, total,
      progress: total > 0 && finalized >= total ? DONE : started ? { state: 'active', ratio: total > 0 ? finalized / total : 0 } : TODO },
  ]
}

type WorkingDraft = DraftMeta & { status: 'draft' | 'reviewed' | 'revised' }
const isWorking = (draft: DraftMeta): draft is WorkingDraft => draft.status === 'draft' || draft.status === 'reviewed' || draft.status === 'revised'

/**
 * 这份稿在定稿之后才建（版本历史「回退到此版本」会在定稿章上新建草稿）。旧版本的草稿箱允许给较旧的版本定稿，
 * 所以不能按版本号比：定稿前就有的更高版本不算。定稿时间取定稿稿的 updated_at（定稿后不可再改）；
 * 两者同为数据库 datetime('now') 的写法，可直接按字符串比；同一秒内分不出先后时退回按版本号。
 */
function createdAfterFinal(draft: DraftMeta, final: DraftMeta): boolean {
  const finalizedAt = final.updatedAt
  if (!finalizedAt || draft.createdAt === finalizedAt) return draft.version > final.version
  return draft.createdAt > finalizedAt
}

/** 正文阶段的章节列表：蓝图章与已有稿的章取并集，按章号排序。 */
export function deriveChapters(facts: Pick<WorkFacts, 'blueprints' | 'drafts' | 'runningChapters' | 'chapterFacts'>): ChapterRow[] {
  const titles = new Map(facts.blueprints.map(blueprint => [blueprint.chapterNumber, blueprint.title]))
  const numbers = new Set([...titles.keys(), ...Object.keys(facts.drafts).map(Number)])
  return [...numbers].sort((a, b) => a - b).map(number => {
    const drafts = facts.drafts[number] ?? []
    const final = drafts.find(draft => draft.status === 'finalized') ?? null
    const latest = drafts.filter(isWorking).sort((a, b) => b.version - a.version)[0] ?? null
    const working = latest && (!final || createdAfterFinal(latest, final)) ? latest : null
    return {
      number,
      title: titles.get(number) || final?.chapterTitle || '',
      phase: working ? chapterPhase(working.status, facts.chapterFacts?.[working.id]) : final ? 'final' : 'todo',
      running: facts.runningChapters.has(number),
      draft: working ?? final,
      hasFinal: final !== null,
    }
  })
}

/**
 * 打开作品、书房「继续写作」与点「正文」打开的章：几章都在写时取最后一章在写的（用户决定），
 * 其次最早一章还没动笔的（待写或只有空稿），都没有时取最后一章定稿。
 */
export function focusChapter(rows: readonly ChapterRow[]): ChapterRow | null {
  return rows.filter(row => begun(row) && row.phase !== 'final').at(-1)
    ?? rows.find(row => !begun(row))
    ?? rows.at(-1)
    ?? null
}

/**
 * 打开作品时落在第一个未完成的阶段；四个阶段都完成时落在正文。设定齐了且已有蓝图或正文时落在当前写作位置（正文）：
 * 架构没写完（比如大纲分批只写了一部分）不把作者拉回架构，有正文没有蓝图也不落到空的蓝图页；流程脊与架构页照旧显示部分完成。
 */
export function landingStage(stages: readonly StageStatus[]): WorkStage {
  const first = stages.find(status => status.progress.state !== 'done')?.stage ?? 'manuscript'
  const begun = stages.some(status => (status.stage === 'blueprint' || status.stage === 'manuscript') && status.progress.state !== 'todo')
  return begun && first !== 'setup' ? 'manuscript' : first
}

export type StageLocation =
  | { kind: 'stage'; stage: WorkStage; chapter?: number }
  | { kind: 'resource'; page: ResourcePage }

const TAB_LOCATION: Record<EditorTab['type'], StageLocation> = {
  config: { kind: 'stage', stage: 'setup' },
  'world-building': { kind: 'stage', stage: 'architecture' },
  'arch-file': { kind: 'stage', stage: 'architecture' },
  character: { kind: 'stage', stage: 'architecture' },
  outline: { kind: 'stage', stage: 'architecture' },
  'chapter-card': { kind: 'stage', stage: 'blueprint' },
  chapter: { kind: 'stage', stage: 'manuscript' },
  'review-report': { kind: 'stage', stage: 'manuscript' },
  diff: { kind: 'stage', stage: 'manuscript' },
  'narrative-thread': { kind: 'resource', page: 'plot' },
  knowledge: { kind: 'resource', page: 'knowledge' },
  'version-history': { kind: 'resource', page: 'history' },
}

/** 当前标签属于哪个阶段或资料页；正文类标签带上章号。 */
export function locate(tab: Pick<EditorTab, 'type' | 'chapterNumber'> | undefined): StageLocation | null {
  if (!tab) return null
  const location = TAB_LOCATION[tab.type]
  return location.kind === 'stage' && location.stage === 'manuscript' && tab.chapterNumber !== undefined
    ? { ...location, chapter: tab.chapterNumber }
    : location
}

/**
 * 工作流正在写的章：运行声明的资源里形如 chapter:<章号> 的那些。
 * 批量创作一次声明整批章，但按章逐步写（第 i 步写第 i 章），只有当前步骤那一章在写，其余还在排队；暂停时没有章在写。
 */
export function runningChapters(runs: readonly Pick<WorkflowRun, 'resourceKeys' | 'type' | 'currentStepIndex' | 'status'>[]): Set<number> {
  const numbers = new Set<number>()
  for (const run of runs) {
    if (run.status === 'paused') continue
    const chapters = (run.resourceKeys ?? []).flatMap(key => {
      const match = /^chapter:(\d+)$/.exec(key)
      return match ? [Number(match[1])] : []
    })
    const writing = run.type === 'batch_generate' ? chapters.slice(run.currentStepIndex, run.currentStepIndex + 1) : chapters
    for (const number of writing) numbers.add(number)
  }
  return numbers
}

/** 整个运行的完成比例：已完成步骤加当前步骤自身的进度。 */
export function runProgress(run: Pick<WorkflowRun, 'steps' | 'currentStepIndex'>): number {
  if (run.steps.length === 0) return 0
  const completed = run.steps.filter(step => step.status === 'completed' || step.status === 'skipped').length
  const current = run.steps[run.currentStepIndex]
  const partial = current && current.status === 'running' ? (current.progress ?? 0) / 100 : 0
  return Math.min(1, (completed + partial) / run.steps.length)
}
