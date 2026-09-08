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
按 id、evidence、description、status 顺序逐项返回 {"id":"原始id","evidence":[{"quote":"当前正文逐字引文"}],"description":"逐个列出目标原文中的每个当章子动作及其判断，再汇总","status":"completed|unmet|unknown"}，不得删项、改写目标或自创 id。
依次判断：
1. 先按原意区分当章行动与背景/未来约束；仅当目标要求达成约定时，本章达成约定即可，不要求提前执行。背景、purpose、未来计划不是已发生事实，也不自动变成到期行动。
2. 当章到期行动有明确延期、拒绝或相反结果的正文证据 → unmet。准备/承诺不能代替要求现在完成的行动；部分完成不等于整项目标完成。
3. 全部到期动作有完成证据，或正文明确支持该项约束 → completed。
4. 仅未提及、无法判断或证据不足 → unknown，不能以“没写到”断言“没发生”。例如要求归还借书，正文只写走进图书馆：应 unknown，不能判 unmet。
最后汇总所有子动作：任一 unmet → unmet；否则任一 unknown → unknown；仅全部完成 → completed。不得用多数已完成掩盖一个延期或不明子动作。
completed/unmet 都须当前正文逐字证据；unknown 可 evidence:[]。不拼接或改写引文，不引用计划证明行动；引文存在不证明推断成立。不检查字数或强求背景细节。
冻结清单：${JSON.stringify(goals)}`,
    `[Current chapter goal checklist | software-frozen]
Keep the existing summary/items review contract and add goalReviews to the same JSON root (not subject to the general items limit).
Return fields in id, evidence, description, status order: {"id":"original id","evidence":[{"quote":"verbatim current draft excerpt"}],"description":"list every current-chapter sub-action in the original goal with its judgment, then summarize","status":"completed|unmet|unknown"}. Do not delete/rewrite goals or invent IDs.
Decide in order:
1. Distinguish actions due now from background/future constraints. An agreement goal only requires the agreement, not early execution. Background, purpose and future plans are not established events or automatically due actions.
2. Explicit draft evidence of postponement, refusal or an opposite outcome for a due action → unmet. Preparation/promises cannot replace execution due now; partial completion is not whole-goal completion.
3. Evidence completes every due action or explicitly supports the constraint → completed.
4. Mere omission, ambiguity or insufficient evidence → unknown, not proof of non-occurrence. Example: a goal requires returning a library book, but the draft only describes entering the library: unknown, not unmet.
Aggregate last: any unmet → unmet; otherwise any unknown → unknown; only all completed → completed. A completed majority cannot hide one postponed or uncertain sub-action.
completed/unmet require verbatim current-draft evidence; unknown may use evidence:[]. Do not combine/rewrite quotations or cite plans as proof. Locatable evidence does not prove an inference. Do not check length or demand background detail.
Frozen checklist: ${JSON.stringify(goals)}`)
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && Boolean(value.trim()) }

/** Permit only an extra enclosing quotation pair, never punctuation or whitespace rewriting. */
function locateGoalEvidence(quote: unknown, draft: string): ChapterGoalEvidence | null {
  if (!nonempty(quote)) return null
  let candidate = quote
  let start = draft.indexOf(candidate)
  if (start < 0) {
    if (!((quote.startsWith('“') && quote.endsWith('”')) || (quote.startsWith('"') && quote.endsWith('"')))) return null
    candidate = quote.slice(1, -1)
    if (!nonempty(candidate)) return null
    start = draft.indexOf(candidate)
    if (start < 0 || draft.indexOf(candidate, start + 1) >= 0) return null
  }
  const end = start + candidate.length
  return { quote: draft.slice(start, end), start, end }
}

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
        const located = locateGoalEvidence(entry?.quote, draft)
        if (!entry || Object.keys(entry).some(key => key !== 'quote') || !located) valid = false
        else evidence.push(located)
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
