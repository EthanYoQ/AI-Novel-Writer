/**
 * Immutable, user-confirmed review snapshot persisted in the existing
 * `reviews.content` JSON field. The source AI review remains a separate,
 * unchanged review record; `sourceReviewId` points back to it.
 */
export const HUMAN_CONFIRMED_REVIEW_KIND = 'human-confirmed-review' as const
export const HUMAN_CONFIRMED_REVIEW_SCHEMA_VERSION = 1 as const

export type HumanConfirmedReviewDecision = 'apply' | 'ignore'
export type HumanConfirmedReviewOrigin = 'ai' | 'author'

export interface HumanConfirmedReviewItem {
  category: string
  severity: string
  description: string
  quote?: string
  decision: HumanConfirmedReviewDecision
  origin: HumanConfirmedReviewOrigin
}

export interface HumanConfirmedReviewSnapshot {
  kind: typeof HUMAN_CONFIRMED_REVIEW_KIND
  schemaVersion: typeof HUMAN_CONFIRMED_REVIEW_SCHEMA_VERSION
  /** The immutable original AI-review row; never the confirmation row itself. */
  sourceReviewId: number
  summary: string
  authorGuidance: string
  items: readonly HumanConfirmedReviewItem[]
}

export interface HumanConfirmedReviewSnapshotInput {
  sourceReviewId: number
  summary: string
  authorGuidance: string
  items: readonly HumanConfirmedReviewItem[]
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function parseItem(value: unknown): HumanConfirmedReviewItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const category = nonEmptyString(record.category)
  const severity = nonEmptyString(record.severity)
  const description = nonEmptyString(record.description)
  const quote = record.quote === undefined ? undefined : stringValue(record.quote)
  const decision = record.decision
  const origin = record.origin

  if (
    !category
    || !severity
    || !description
    || (decision !== 'apply' && decision !== 'ignore')
    || (origin !== 'ai' && origin !== 'author')
  ) return null
  if (quote === null) return null

  return Object.freeze({
    category,
    severity,
    description,
    ...(quote === undefined ? {} : { quote }),
    decision,
    origin,
  })
}

/**
 * Validates an in-memory candidate and returns a canonical frozen snapshot.
 * Invalid or historical review values return null instead of throwing.
 */
export function validateHumanConfirmedReviewSnapshot(
  value: unknown,
): HumanConfirmedReviewSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    record.kind !== HUMAN_CONFIRMED_REVIEW_KIND
    || record.schemaVersion !== HUMAN_CONFIRMED_REVIEW_SCHEMA_VERSION
    || !positiveSafeInteger(record.sourceReviewId)
    || !Array.isArray(record.items)
  ) return null

  const summary = stringValue(record.summary)
  const authorGuidance = stringValue(record.authorGuidance)
  if (summary === null || authorGuidance === null) return null

  const items = record.items.map(parseItem)
  if (items.some(item => item === null)) return null

  return Object.freeze({
    kind: HUMAN_CONFIRMED_REVIEW_KIND,
    schemaVersion: HUMAN_CONFIRMED_REVIEW_SCHEMA_VERSION,
    sourceReviewId: record.sourceReviewId,
    summary,
    authorGuidance,
    items: Object.freeze(items as HumanConfirmedReviewItem[]),
  })
}

/** Returns null for raw AI reports, malformed JSON, and unsupported schemas. */
export function parseHumanConfirmedReviewSnapshot(
  content: string,
): HumanConfirmedReviewSnapshot | null {
  try {
    return validateHumanConfirmedReviewSnapshot(JSON.parse(content) as unknown)
  } catch {
    return null
  }
}

/** Constructs a canonical snapshot that can be persisted without mutating its source AI review. */
export function createHumanConfirmedReviewSnapshot(
  input: HumanConfirmedReviewSnapshotInput,
): HumanConfirmedReviewSnapshot | null {
  return validateHumanConfirmedReviewSnapshot({
    kind: HUMAN_CONFIRMED_REVIEW_KIND,
    schemaVersion: HUMAN_CONFIRMED_REVIEW_SCHEMA_VERSION,
    ...input,
  })
}

export function serializeHumanConfirmedReviewSnapshot(
  snapshot: HumanConfirmedReviewSnapshot,
): string {
  return JSON.stringify(snapshot, null, 2)
}

/** True when the author explicitly selected at least one review item for repair. */
export function hasIncludedReviewItems(snapshot: HumanConfirmedReviewSnapshot): boolean {
  return snapshot.items.some(item => item.decision === 'apply')
}

/** Author guidance is also explicit confirmed work, even when no AI item is selected. */
export function hasIncludedReviewWork(snapshot: HumanConfirmedReviewSnapshot): boolean {
  return hasIncludedReviewItems(snapshot) || Boolean(snapshot.authorGuidance.trim())
}

/**
 * The only review material passed to the refiner: selected items and explicit
 * author guidance. It intentionally omits ignored items, the raw AI report,
 * and the AI-produced summary.
 */
export function renderHumanConfirmedReviewBrief(snapshot: HumanConfirmedReviewSnapshot): string {
  const appliedItems = snapshot.items.filter(item => item.decision === 'apply')
  const sections: string[] = []

  if (appliedItems.length > 0) {
    sections.push([
      '【已确认纳入本次修稿的审稿项】',
      ...appliedItems.map((item, index) => {
        const quote = item.quote?.trim()
          ? `\n  相关原文：${item.quote.trim()}`
          : ''
        return `${index + 1}. [${item.category} / ${item.severity}] ${item.description}${quote}`
      }),
    ].join('\n'))
  }

  const authorGuidance = snapshot.authorGuidance.trim()
  if (authorGuidance) {
    sections.push(`【作者补充修稿指导】\n${authorGuidance}`)
  }

  return sections.join('\n\n')
}
