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
export function freezeChapterGoals(chapterNumber: number, keyEvents: string | null | undefined,
  authorSources: readonly string[] = []): FrozenChapterGoals {
  const items: Array<Readonly<{ id: string; text: string }>> = (keyEvents ?? '').split(/\r?\n|[；;]/u).map(text => text.trim()).filter(Boolean)
    .map((text, index) => Object.freeze({ id: `ch${chapterNumber}:keyEvents:${index + 1}`, text }))
  const marker = /^\s*【第(\d+)章必现】\s*(\S(?:.*\S)?)\s*$/u
  const mustShow = authorSources.flatMap(source => source.split(/\r?\n/u).flatMap(line => {
    const match = marker.exec(line)
    return match && Number(match[1]) === chapterNumber ? [match[2]!] : []
  })).map((text, index) => Object.freeze({ id: `ch${chapterNumber}:mustShow:${index + 1}`, text }))
  items.push(...mustShow)
  return Object.freeze({
    chapterNumber,
    coverage: items.length ? 'complete' : keyEvents === undefined ? 'unknown' : 'not_configured',
    items: Object.freeze(items),
  })
}

export function buildChapterGoalReviewPrompt(goals: FrozenChapterGoals, language: WritingLanguage): string {
  return writingLanguageText(language,
    `【本章目标逐项核对｜软件冻结清单】
保留原有 summary 与 items 通用审稿格式，并在同一 JSON 根对象增加 goalReviews 数组（不受通用 items 的条数限制）。
按 id、evidence、description、status 顺序逐项返回 {"id":"原始id","evidence":[{"quote":"当前正文逐字引文"}],"description":"逐个列出目标原文中的每个当章子动作及其判断，再汇总","status":"completed|unmet|unknown"}，不得删项、改写目标或自创 id。
依次判断：
1. 先按原意区分当章行动与背景/未来约束，并判断目标是否要求本章新发生，还是明确要求回顾或维持已有状态；仅当目标要求达成约定时，本章达成约定即可，不要求提前执行。背景、purpose、未来计划不是已发生事实，也不自动变成到期行动。
随后通读待审全文，检查所有可能满足目标原义的动作与实际后果，不能因一处证据是旧结果就断言全文缺失。在 description 中逐个简述子动作要求、前章同一事件的终态、本章动作与实际后果，并据此前后差异区分本章新发生、旧结果或未来计划，最后按下述规则判状态。前章未记载同一事件时如实说明；合理的新动作不必在前文预先出现。新发生按叙事动作与后果判断，不另要求更换钟点或场景，但须核实目标明确的时点或场景要求。要求当章新发生时，旧结果不能代替；明确要求回顾或维持状态时，不另造动作或代价。目标未限定代价形式、金额、强度或不可逆程度时，不自行增加门槛，但仍须可定位的具体实际后果；泛泛不便、旧损失或未来承诺不自动算完成。若目标要求本章新发生，通读后仍只有旧结果或时点不明，且无明确延期、拒绝或相反结果的正文证据时，按下述 unknown 处理；不凭引文存在或没有矛盾判 completed。description 只写简短核对结果，不输出长篇推理。
2. 当章到期行动有明确延期、拒绝或相反结果的正文证据 → unmet。准备/承诺不能代替要求现在完成的行动；部分完成不等于整项目标完成。
3. 全部到期动作有完成证据，或正文明确支持该项约束 → completed。标识含 mustShow 的目标必须有正文中积极、可定位的明示证据；背景一致或没有矛盾不算完成。
4. 仅未提及、无法判断或证据不足 → unknown，不能以“没写到”断言“没发生”。必现目标完全未展示也为 unknown，可由作者明确纳入一次修稿。普通背景只检查矛盾。例如要求归还借书，正文只写走进图书馆：应 unknown，不能判 unmet。
最后汇总所有子动作：任一 unmet → unmet；否则任一 unknown → unknown；仅全部完成 → completed。不得用多数已完成掩盖一个延期或不明子动作。
completed/unmet 都须当前正文逐字证据；unknown 可 evidence:[]。不拼接或改写引文，不引用计划证明行动；引文存在不证明推断成立。不检查字数或强求背景细节。
目标原文与作者确认设定冲突时，无论正文是否写出该冲突内容，都判 unknown（不判 completed 或 unmet），并在 description 说明冲突，仍不得改写目标。
冻结清单：${JSON.stringify(goals)}`,
    `[Current chapter goal checklist | software-frozen]
Keep the existing summary/items review contract and add goalReviews to the same JSON root (not subject to the general items limit).
Return fields in id, evidence, description, status order: {"id":"original id","evidence":[{"quote":"verbatim current draft excerpt"}],"description":"list every current-chapter sub-action in the original goal with its judgment, then summarize","status":"completed|unmet|unknown"}. Do not delete/rewrite goals or invent IDs.
Decide in order:
1. Distinguish actions due now from background/future constraints, and decide whether the goal requires something new in this chapter or explicitly asks for a recap or maintenance of an existing state. An agreement goal only requires the agreement, not early execution. Background, purpose and future plans are not established events or automatically due actions.
Then read the whole draft for all actions and actual consequences that could satisfy the goal's original meaning. One excerpt recounting an old result does not establish absence from the whole draft. In description, briefly state each sub-action's requirement, the same event's end state in the previous chapter, and this chapter's actions and actual consequences. Use that comparison to distinguish new current-chapter events, old results and future plans, then assign status by the rules below. If the previous chapter does not record the same event, state that; reasonable new actions need not appear earlier. Judge new events by narrative actions and consequences, without requiring a different clock time or scene, while checking any timing or scene explicitly required by the goal. Old results cannot satisfy required new progress. Explicit recap or state-maintenance goals need no invented action or cost. Do not add a threshold for a cost's form, amount, intensity or irreversibility when the goal specifies none, but still require a locatable concrete actual consequence. Vague inconvenience, old loss and future promises do not automatically count as completion. For a goal requiring something new in this chapter, if the whole draft has only old results or unclear timing and no explicit postponement, refusal or opposite outcome, apply unknown below. A quote's presence or absence of contradiction does not establish completed. Keep description to brief comparison results, without lengthy reasoning.
2. Explicit draft evidence of postponement, refusal or an opposite outcome for a due action → unmet. Preparation/promises cannot replace execution due now; partial completion is not whole-goal completion.
3. Evidence completes every due action or explicitly supports the constraint → completed. A mustShow goal requires positive, locatable prose showing it; background consistency or absence of contradiction is insufficient.
4. Mere omission, ambiguity or insufficient evidence → unknown, not proof of non-occurrence. A completely unshown mustShow goal is unknown and may enter one revision when the author explicitly applies it. Ordinary background is checked only for contradiction. Example: a goal requires returning a library book, but the draft only describes entering the library: unknown, not unmet.
Aggregate last: any unmet → unmet; otherwise any unknown → unknown; only all completed → completed. A completed majority cannot hide one postponed or uncertain sub-action.
completed/unmet require verbatim current-draft evidence; unknown may use evidence:[]. Do not combine/rewrite quotations or cite plans as proof. Locatable evidence does not prove an inference. Do not check length or demand background detail.
If a goal's text conflicts with author-confirmed settings, judge it unknown (never completed or unmet) whether or not the draft contains the conflicting content, and explain the conflict in description. Still do not rewrite the goal.
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
