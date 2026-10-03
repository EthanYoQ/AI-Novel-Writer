import type { Locale } from '../i18n/types'
import {
  chapterGoalReviewItems,
  normalizeChapterGoalReview,
  type FrozenChapterGoals,
} from './chapter-goal-review'
import {
  mergeConsistencyFindingsIntoReview,
  type ConsistencyFinding,
  type ReviewLike,
} from './consistency-preflight'
import type { WritingLanguage } from './writing-language'
import { extractSingleCompleteJsonObject } from './character-proposal-parser'
import { stripDraftThinkingTags } from './draft-visible-text'

const REVIEW_SUMMARY_MAX_CHARACTERS = 120
const REVIEW_DESCRIPTION_MAX_CHARACTERS = 200
const REVIEW_QUOTE_MAX_CHARACTERS = 160
export type ReviewReportVersion = 1 | 2

interface ReviewResultItem extends Record<string, unknown> {
  category: string
  severity: 'error' | 'warning' | 'pass'
  description: string
  quote?: string
}

interface ReviewResult extends Record<string, unknown> {
  summary: string
  items: ReviewResultItem[]
  goalReviews?: unknown
}

function isNonemptyText(value: unknown): value is string {
  return typeof value === 'string'
    && Boolean(value.trim())
}

function reportText(value: string, maxCharacters: number, version: ReviewReportVersion): string {
  // V1 is retained only to prove already-saved reports against their original bytes.
  return version === 1 ? Array.from(value.trim()).slice(0, maxCharacters).join('') : value.trim()
}

function isReviewShape(value: unknown): value is ReviewResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const review = value as Record<string, unknown>
  if (Object.keys(review).some(key => key !== 'summary' && key !== 'items' && key !== 'goalReviews')
    || typeof review.summary !== 'string'
    || !Array.isArray(review.items)
    || review.items.length < 1
    || review.items.length > 10) return false
  return review.items.every((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const record = item as Record<string, unknown>
    const severity = record.severity
    return !Object.keys(record).some(key => (
      key !== 'category'
      && key !== 'severity'
      && key !== 'description'
      && key !== 'quote'
    ))
      && typeof record.category === 'string'
      && (severity === 'error' || severity === 'warning' || severity === 'pass')
      && typeof record.description === 'string'
      && (record.quote === undefined
        ? severity === 'pass'
        : typeof record.quote === 'string')
  })
}

function isReviewResult(value: unknown): value is ReviewResult {
  return isReviewShape(value)
    && isNonemptyText(value.summary)
    && value.items.every(item => (
      Boolean(item.category.trim())
      && isNonemptyText(item.description)
      && (item.quote === undefined || isNonemptyText(item.quote))
    ))
}

/** Accept one complete visible report with optional prose/fences; retain the model shape gate. */
export function parseReviewGenerationResult(content: string, reportVersion: ReviewReportVersion = 2): ReviewResult {
  if (reportVersion !== 1 && reportVersion !== 2) throw new Error('invalid review contract')
  const trimmed = stripDraftThinkingTags(content)
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(trimmed)
  let parsed: unknown
  try {
    parsed = JSON.parse(fenced?.[1]?.trim() ?? trimmed)
  } catch {
    parsed = JSON.parse(extractSingleCompleteJsonObject(trimmed, true))
  }
  if (!isReviewShape(parsed)) throw new Error('invalid review contract')
  const bounded: ReviewResult = {
    ...(parsed.goalReviews === undefined ? {} : { goalReviews: parsed.goalReviews }),
    summary: reportText(parsed.summary, REVIEW_SUMMARY_MAX_CHARACTERS, reportVersion),
    items: parsed.items.map(item => ({
      category: item.category,
      severity: item.severity,
      description: reportText(item.description, REVIEW_DESCRIPTION_MAX_CHARACTERS, reportVersion),
      ...(item.quote === undefined || (item.severity === 'pass' && !item.quote.trim())
        ? {}
        : { quote: reportText(item.quote, REVIEW_QUOTE_MAX_CHARACTERS, reportVersion) }),
    })),
  }
  if (!isReviewResult(bounded)) throw new Error('invalid review contract')
  return bounded
}

/** Assemble the saved report using only the caller's frozen source and preflight evidence. */
export function buildReviewGenerationReport(input: {
  content: string
  sourceContent: string
  frozenGoals: FrozenChapterGoals
  writingLanguage: WritingLanguage
  uiLocale: Locale
  preflightFindings: readonly ConsistencyFinding[]
  reportVersion?: ReviewReportVersion
}): ReviewLike & { items: Array<Record<string, unknown>> } {
  const parsedResult: ReviewLike = parseReviewGenerationResult(input.content, input.reportVersion)
  const goalReview = normalizeChapterGoalReview(
    parsedResult.goalReviews,
    input.frozenGoals,
    input.sourceContent,
    input.writingLanguage,
  )
  delete parsedResult.goalReviews
  parsedResult.goalReview = goalReview
  parsedResult.items = [...(parsedResult.items ?? []), ...chapterGoalReviewItems(goalReview, input.writingLanguage)]
  if (parsedResult.items.some(item => item.severity === 'unknown')) {
    parsedResult.summary = input.uiLocale === 'en-US'
      ? 'The review contains unresolved items and is not an overall pass.'
      : '审稿包含待核实项目，不能视为全部通过。'
  } else if (goalReview.items.some(item => item.status === 'unmet')) {
    parsedResult.summary = input.uiLocale === 'en-US'
      ? 'Some chapter goals are unmet; check their evidence.'
      : '本章存在尚未完成的目标，请核对逐项证据。'
  }
  return mergeConsistencyFindingsIntoReview(parsedResult, input.preflightFindings, input.uiLocale)
}
