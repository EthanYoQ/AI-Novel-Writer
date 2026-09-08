import { writingLanguageText, type WritingLanguage } from './writing-language'

export interface ChapterGoalEvidence { quote: string; start: number; end: number }
export interface ChapterGoalReviewItem {
  id: string
  text: string
  status: 'completed' | 'unmet' | 'unknown'
  description: string
  evidence: readonly ChapterGoalEvidence[]
}
export interface ChapterGoalReview {
  version: 1
  chapterNumber: number
  /** Coverage describes the checklist, never permission to finalize a chapter. */
  coverage: 'complete' | 'unknown' | 'not_configured'
  items: readonly ChapterGoalReviewItem[]
}
export interface FrozenChapterGoals {
  chapterNumber: number
  coverage: ChapterGoalReview['coverage']
  items: readonly Readonly<{ id: string; text: string }>[]
}

/** Only explicit current-chapter list boundaries are split; prose is not semantically rewritten. */
export function freezeChapterGoals(chapterNumber: number, keyEvents: string | null | undefined): FrozenChapterGoals {
  const items = (keyEvents ?? '').split(/\r?\n|[；;]/u).map(text => text.trim()).filter(Boolean)
    .map((text, index) => Object.freeze({ id: `ch${chapterNumber}:keyEvents:${index + 1}`, text }))
  return Object.freeze({
    chapterNumber,
    coverage: keyEvents === undefined ? 'unknown' : items.length ? 'complete' : 'not_configured',
    items: Object.freeze(items),
  })
}

export function buildChapterGoalReviewPrompt(goals: FrozenChapterGoals, language: WritingLanguage): string {
  return writingLanguageText(language,
    `【本章目标逐项核对｜软件冻结清单】
保留原有 summary 与 items 通用审稿格式，并在同一 JSON 根对象增加 goalReviews 数组（不受通用 items 的条数限制）。
逐项返回 {"id":"清单中的原始id","status":"completed|unmet|unknown","description":"判断理由","evidence":[{"quote":"当前待审正文中的逐字引文"}]}。不得删除目标、改写目标或自创 id。
逐项阅读整章，检查目标的每个明确到期动作；部分完成不等于整项目标完成。“本章完成”不能用准备、承诺、打算以后完成来代替。若有明确延期、拒绝或相反结果，用 unmet 并引用依据；若只因没有找到完成证据，使用 unknown，不把未提细节直接判为错误。
按目标原意区分约定与执行：要求本章约定未来行动，只需本章达成约定，不要求提前执行。未来章节计划、叙事钩子、purpose 和人物说谎不自动成为本章必须兑现的事实。
completed 与 unmet 均须提供当前正文的逐字证据，不能引用蓝图或把计划当已发生事实；unknown 可以 evidence:[]。引文能定位只说明引文存在，不证明语义判断正确。不要检查字数或要求补齐所有背景细节。
冻结清单：${JSON.stringify(goals)}`,
    `[Current chapter goal checklist | software-frozen]
Keep the existing summary/items review contract and add goalReviews to the same JSON root (not subject to the general items limit).
Return each {"id":"original checklist id","status":"completed|unmet|unknown","description":"reason","evidence":[{"quote":"verbatim current draft excerpt"}]} without deleting or rewriting goals or inventing IDs.
Check every explicitly due action against the whole chapter. Preparation or a promise is not completion when execution is due now. Explicit postponement/refusal/opposite outcomes support unmet with evidence; absent completion evidence alone is unknown, not a proven error.
Respect the goal's meaning: agreeing on a future action can complete an agreement goal without executing that action now. Future chapter plans, hooks, purpose and character lies are not automatically due facts.
completed/unmet require verbatim current-draft evidence, never a plan quoted as an event. unknown may have empty evidence. Locatable quotations do not prove semantic correctness. Do not check length or demand every background detail.
Frozen checklist: ${JSON.stringify(goals)}`)
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && Boolean(value.trim()) }

/** Mechanical coverage/evidence validation; the model still owns the semantic judgment. */
export function normalizeChapterGoalReview(
  raw: unknown, goals: FrozenChapterGoals, draft: string, language: WritingLanguage,
): ChapterGoalReview {
  const candidates = Array.isArray(raw) ? raw : []
  let invalidCoverage = !Array.isArray(raw) && goals.items.length > 0
  if (candidates.some(value => !record(value) || !goals.items.some(goal => goal.id === record(value)?.id))) invalidCoverage = true
  const items = goals.items.map((goal): ChapterGoalReviewItem => {
    const matches = candidates.filter(value => record(value)?.id === goal.id)
    const candidate = matches.length === 1 ? record(matches[0]) : null
    const evidence: ChapterGoalEvidence[] = []
    let valid = Boolean(candidate && Object.keys(candidate).every(key => ['id', 'status', 'description', 'evidence'].includes(key))
      && ['completed', 'unmet', 'unknown'].includes(String(candidate.status))
      && nonempty(candidate.description) && Array.isArray(candidate.evidence))
    if (valid && candidate) {
      for (const value of candidate.evidence as unknown[]) {
        const entry = record(value)
        const quote = entry?.quote
        const start = typeof quote === 'string' ? draft.indexOf(quote) : -1
        if (!entry || Object.keys(entry).some(key => key !== 'quote') || !nonempty(quote) || start < 0) valid = false
        else evidence.push({ quote, start, end: start + quote.length })
      }
      if (candidate.status !== 'unknown' && evidence.length === 0) valid = false
    }
    if (!valid) invalidCoverage = true
    return {
      ...goal,
      status: valid ? candidate!.status as ChapterGoalReviewItem['status'] : 'unknown',
      description: valid ? candidate!.description as string : writingLanguageText(language,
        '该目标缺少有效的逐项判断或正文证据，请人工核实。', 'This goal lacks a valid judgment or draft evidence; verify it manually.'),
      evidence: valid ? evidence : [],
    }
  })
  return { version: 1, chapterNumber: goals.chapterNumber, coverage: invalidCoverage ? 'unknown' : goals.coverage, items }
}

/** Read persisted canonical reports, including historical reports without this optional field. */
export function parseChapterGoalReview(value: unknown): ChapterGoalReview | null {
  const parsed = record(value)
  if (!parsed || parsed.version !== 1 || !Number.isSafeInteger(parsed.chapterNumber) || Number(parsed.chapterNumber) < 1
    || !['complete', 'unknown', 'not_configured'].includes(String(parsed.coverage)) || !Array.isArray(parsed.items)) return null
  const ids = new Set<string>()
  for (const value of parsed.items) {
    const item = record(value)
    if (!item || !nonempty(item.id) || ids.has(item.id) || !nonempty(item.text) || !nonempty(item.description)
      || !['completed', 'unmet', 'unknown'].includes(String(item.status)) || !Array.isArray(item.evidence)) return null
    ids.add(item.id)
    if (item.status !== 'unknown' && item.evidence.length === 0) return null
    for (const value of item.evidence) {
      const evidence = record(value)
      if (!evidence || !nonempty(evidence.quote) || !Number.isSafeInteger(evidence.start) || Number(evidence.start) < 0
        || evidence.end !== Number(evidence.start) + evidence.quote.length) return null
    }
  }
  return parsed as unknown as ChapterGoalReview
}

/** A deterministic presentation projection, not another editable source of goal truth. */
export function chapterGoalReviewItems(review: ChapterGoalReview, language: WritingLanguage): Array<Record<string, unknown>> {
  const category = writingLanguageText(language, '本章目标', 'Chapter goal')
  const items: Array<Record<string, unknown>> = review.items.map(item => ({
    category, goalId: item.id,
    severity: item.status === 'completed' ? 'pass' : item.status === 'unmet' ? 'error' : 'unknown',
    description: `${item.text}\n${item.description}`,
    ...(item.evidence.length ? { quote: item.evidence.map(evidence => evidence.quote).join('\n') } : {}),
  }))
  if (review.coverage !== 'complete') items.push({
    category, severity: 'unknown',
    description: review.coverage === 'not_configured'
      ? writingLanguageText(language, '本章未配置可核对的关键事件，未完成目标验收。', 'No chapter key events are configured; goal acceptance was not performed.')
      : writingLanguageText(language, '本章目标来源或逐项核对不完整，请人工核实。', 'Chapter goal sources or checklist coverage are incomplete; verify manually.'),
  })
  return items
}
