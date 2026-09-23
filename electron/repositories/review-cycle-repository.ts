import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { canonicalM03FindingSetHash, verifyM03ReviewCycle, type M03FindingDescriptor } from '../migrations/m03-review-cycle'
import { parseHumanConfirmedReviewSnapshot, type HumanConfirmedReviewSnapshot } from '../../src/shared/human-confirmed-review'
import { classifyFindingEvidenceChange, type ReviewCycleRecheckContext,
  type ReviewCycleRecheckFinding, type ReviewCycleProjection } from '../../src/shared/review-cycle'

const HASH = /^[a-f0-9]{64}$/u
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const record = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
)
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && Number(value) >= minimum
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => (
  Object.keys(value).sort().join() === [...keys].sort().join()
)

export interface ReviewCycleSource {
  projectId: string
  epoch: string
  sourceId: string
  revision: number
  contentHash: string
}

export interface CreateReviewCycleInput {
  rootActionId: string
  reviewId: number
  reviewContentHash: string
  source: ReviewCycleSource
}

export interface CreatedReviewCycle {
  cycleId: string
  findingSetHash: string
  findingCount: number
}

export interface AttachGeneratedRevisionInput {
  cycleId: string
  rootActionId: string
  confirmationReviewId: number
  confirmationContentHash: string
  revisionId: number
  revisionContentHash: string
}

export interface GeneratedRevisionBinding {
  cycleId: string
  confirmationReviewId: number
  revisionId: number
  revisionStatus: 'generated'
  idempotent: boolean
}

export interface AuthorConfirmationBinding {
  cycleId: string
  confirmationReviewId: number
  confirmationContentHash: string
  waivedFindingCount: number
  idempotent: boolean
}

export interface MergeCommittedCycle {
  revisionId: number
  bound: boolean
  cycleId?: string
  revisionStatus?: 'merge-committed'
  idempotent: boolean
}

export interface ReviewCycleRecheckPlan {
  disposition: 'required' | 'not-required' | 'completed'
  context: ReviewCycleRecheckContext | null
  rootActionId: string
  reviewId: number
}

export interface CommittedReviewCycleRecheck {
  cycleId: string
  attemptId: string
  recheckCount: 1
  idempotent: boolean
}

export interface DiscardedRevisionReconciliation {
  revisionId: number
  detached: boolean
}

export interface DiscardedRevisionsReconciliation {
  revisionIds: number[]
  detached: number
}

interface ReviewRow {
  base_draft_id: number
  source_draft_version: number | null
  source_content: string | null
  body: string
}

interface CycleBindingRow {
  cycle_id: string
  root_action_id: string
  review_id: number
  confirmation_review_id: number | null
  confirmation_content_hash: string | null
  revision_id: number | null
  source_hash: string
  revision_status: 'not-generated' | 'generated' | 'merge-committed'
}

interface RecheckCycleRow {
  cycle_id: string
  root_action_id: string
  review_id: number
  finding_set_hash: string
  comparison_version: number
  revision_status: string
  merged_hash: string | null
  recheck_count: number
  recheck_attempt_id: string | null
  source_content: string | null
  merged_body: string
}

interface RecheckFindingRow {
  finding_id: string
  target_id: string | null
  category: string
  kind: 'objective' | 'literary'
  problem_text: string
  expected_text: string | null
  status: string
  span_start: number | null
  span_end: number | null
  span_unit: string | null
  occurrence: number | null
}

interface SourceBoundRow {
  base_draft_id: number
  source_draft_chapter_number: number | null
  source_draft_version: number | null
  source_draft_status: string | null
  source_content: string | null
  body: string
}

interface SavedItem {
  index: number
  category: string
  severity: 'error' | 'warning' | 'pass' | 'unknown'
  description: string
  quote?: string
  goalId?: string
  stableFactKey?: string
}

interface SavedGoal {
  id: string
  text: string
  description: string
  status: 'completed' | 'unmet' | 'unknown'
  evidence: readonly { quote: string; start: number; end: number }[]
}

interface SavedReport {
  items: SavedItem[]
  goals: SavedGoal[]
}

function invalid(): never { throw new Error('REVIEW_CYCLE_INPUT_INVALID') }
function conflict(): never { throw new Error('REVIEW_CYCLE_CONFLICT') }

function parseSavedReport(body: string): SavedReport {
  let raw: unknown
  try { raw = JSON.parse(body) } catch { invalid() }
  const report = record(raw)
  if (!report || !exactKeys(report, ['summary', 'items', 'goalReview'])
    || !nonempty(report.summary) || !Array.isArray(report.items) || report.items.length === 0) invalid()
  const goalReview = record(report.goalReview)
  if (!goalReview || !exactKeys(goalReview, ['version', 'chapterNumber', 'coverage', 'items'])
    || goalReview.version !== 1 || !integer(goalReview.chapterNumber, 1)
    || !['complete', 'unknown', 'not_configured'].includes(String(goalReview.coverage))
    || !Array.isArray(goalReview.items)) invalid()

  const goalIds = new Set<string>()
  const goals = goalReview.items.map((value): SavedGoal => {
    const item = record(value)
    if (!item || !exactKeys(item, ['id', 'text', 'status', 'description', 'evidence'])
      || !nonempty(item.id) || goalIds.has(item.id) || !nonempty(item.text) || !nonempty(item.description)
      || !['completed', 'unmet', 'unknown'].includes(String(item.status)) || !Array.isArray(item.evidence)) invalid()
    goalIds.add(item.id)
    const evidence = item.evidence.map((entry) => {
      const proof = record(entry)
      if (!proof || !exactKeys(proof, ['quote', 'start', 'end']) || !nonempty(proof.quote)
        || !integer(proof.start) || proof.end !== Number(proof.start) + proof.quote.length) invalid()
      return { quote: proof.quote, start: Number(proof.start), end: Number(proof.end) }
    })
    if (item.status !== 'unknown' && evidence.length === 0) invalid()
    return { id: item.id, text: item.text, description: item.description,
      status: item.status as SavedGoal['status'], evidence }
  })

  const items = report.items.map((value, index): SavedItem => {
    const item = record(value)
    if (!item || Object.keys(item).some(key => ![
      'category', 'severity', 'description', 'quote', 'goalId', 'stableFactKey', 'sourceChapter',
    ].includes(key)) || !nonempty(item.category) || !nonempty(item.description)
      || !['error', 'warning', 'pass', 'unknown'].includes(String(item.severity))
      || (item.quote !== undefined && !nonempty(item.quote))
      || (item.goalId !== undefined && (!nonempty(item.goalId) || !goalIds.has(item.goalId)))
      || (item.stableFactKey !== undefined && !nonempty(item.stableFactKey))
      || (item.goalId !== undefined && item.stableFactKey !== undefined)
      || (item.stableFactKey !== undefined && (item.severity !== 'warning' || !nonempty(item.quote)
        || !integer(item.sourceChapter, 1)))
      || (item.sourceChapter !== undefined && (item.stableFactKey === undefined || !integer(item.sourceChapter, 1)))) invalid()
    return { index, category: item.category, severity: item.severity as SavedItem['severity'], description: item.description,
      ...(item.quote === undefined ? {} : { quote: item.quote }),
      ...(item.goalId === undefined ? {} : { goalId: item.goalId }),
      ...(item.stableFactKey === undefined ? {} : { stableFactKey: item.stableFactKey }) }
  })
  for (const goal of goals) {
    const projections = items.filter(item => item.goalId === goal.id)
    const expectedSeverity = goal.status === 'completed' ? 'pass' : goal.status === 'unmet' ? 'error' : 'unknown'
    const expectedQuote = goal.evidence.length ? goal.evidence.map(item => item.quote).join('\n') : undefined
    if (projections.length !== 1 || projections[0]!.severity !== expectedSeverity
      || projections[0]!.quote !== expectedQuote) invalid()
  }
  return { items, goals }
}

function locateUnique(source: string, quote: string): { start: number; end: number } | null {
  const start = source.indexOf(quote)
  return start >= 0 && source.indexOf(quote, start + 1) < 0 ? { start, end: start + quote.length } : null
}

function finding(input: {
  source: ReviewCycleSource
  sourceText: string
  category: string
  targetId: string | null
  kind: 'objective' | 'literary'
  problemText: string
  expectedText?: string
  quote: string | null
  anchoredStatus: 'unresolved' | 'unknown'
  logicalIdentity: string
}): M03FindingDescriptor {
  const span = input.quote === null ? null : locateUnique(input.sourceText, input.quote)
  const anchored = input.targetId !== null && span !== null
  const descriptor: M03FindingDescriptor = {
    findingId: '',
    source: { ...input.source, span: anchored ? { ...span, unit: 'utf16-code-unit' } : null },
    excerptHash: anchored ? hash(input.quote!) : null,
    occurrence: anchored ? 1 : null,
    category: input.category,
    targetId: anchored ? input.targetId : null,
    kind: input.kind,
    problemText: input.problemText,
    expectedText: input.expectedText ?? null,
    status: anchored ? input.anchoredStatus : 'unverified',
    evidenceHash: null,
    confirmationItemIndex: null,
  }
  const identity = { sourceProjectId: descriptor.source.projectId, sourceEpoch: descriptor.source.epoch,
    sourceId: descriptor.source.sourceId, sourceRevision: descriptor.source.revision,
    sourceContentHash: descriptor.source.contentHash, spanStart: descriptor.source.span?.start ?? null,
    spanEnd: descriptor.source.span?.end ?? null, spanUnit: descriptor.source.span?.unit ?? null,
    excerptHash: descriptor.excerptHash, occurrence: descriptor.occurrence, category: descriptor.category,
    targetId: descriptor.targetId, kind: descriptor.kind, logicalIdentity: input.logicalIdentity }
  descriptor.findingId = `finding:${hash(JSON.stringify(identity))}`
  return descriptor
}

function buildFindings(report: SavedReport, source: ReviewCycleSource, sourceText: string): M03FindingDescriptor[] {
  const result: M03FindingDescriptor[] = []
  const findingById = new Map<string, M03FindingDescriptor>()
  const add = (item: M03FindingDescriptor) => {
    const existing = findingById.get(item.findingId)
    if (!existing) {
      result.push(item)
      findingById.set(item.findingId, item)
    } else if (existing.status !== item.status && item.status === 'unresolved') existing.status = 'unresolved'
  }
  for (const goal of report.goals) {
    if (goal.evidence.some(item => sourceText.slice(item.start, item.end) !== item.quote)) invalid()
    if (goal.status === 'completed') continue
    const projection = report.items.find(item => item.goalId === goal.id)!
    const quote = goal.evidence.length === 1 ? goal.evidence[0]!.quote : null
    add(finding({ source, sourceText, category: projection.category, targetId: goal.id, kind: 'objective', quote,
      problemText: projection.description, expectedText: `${goal.text}\n${goal.description}`,
      anchoredStatus: goal.status === 'unknown' ? 'unknown' : 'unresolved', logicalIdentity: `goal:${goal.id}` }))
  }
  for (const item of report.items) {
    if (item.severity === 'pass' || item.goalId) continue
    const objective = item.stableFactKey !== undefined
    add(finding({ source, sourceText, category: item.category, targetId: item.stableFactKey ?? null,
      kind: objective ? 'objective' : 'literary', quote: item.quote ?? null, problemText: item.description,
      anchoredStatus: 'unresolved',
      logicalIdentity: objective ? `preflight:${item.stableFactKey}` : `free:${item.index}` }))
  }
  return result
}

function cycleId(input: CreateReviewCycleInput): string {
  return `cycle:${hash(JSON.stringify([input.rootActionId, input.reviewId, input.reviewContentHash]))}`
}

function persistedFinding(row: Record<string, unknown>): M03FindingDescriptor {
  return {
    findingId: row.finding_id as string,
    source: { projectId: row.source_project_id as string, epoch: row.source_epoch as string,
      sourceId: row.source_id as string, revision: row.source_revision as number,
      contentHash: row.source_content_hash as string, span: row.span_start === null ? null
        : { start: row.span_start as number, end: row.span_end as number, unit: 'utf16-code-unit' } },
    excerptHash: row.excerpt_hash as string | null,
    occurrence: row.occurrence as number | null,
    category: row.category as string,
    targetId: row.target_id as string | null,
    kind: row.kind as M03FindingDescriptor['kind'],
    problemText: row.problem_text as string,
    expectedText: row.expected_text as string | null,
    status: row.status as M03FindingDescriptor['status'],
    evidenceHash: row.evidence_hash as string | null,
    confirmationItemIndex: row.confirmation_item_index as number | null,
  }
}

function sourceMatches(left: SourceBoundRow, right: SourceBoundRow): boolean {
  return left.base_draft_id === right.base_draft_id
    && left.source_draft_chapter_number === right.source_draft_chapter_number
    && left.source_draft_version === right.source_draft_version
    && left.source_draft_status === right.source_draft_status
    && left.source_content !== null && left.source_content === right.source_content
}

function validateGeneratedBinding(input: AttachGeneratedRevisionInput, cycle: CycleBindingRow,
  db: Database.Database): { baseDraftId: number; snapshot: HumanConfirmedReviewSnapshot } {
  const review = db.prepare(`SELECT r.base_draft_id,r.source_draft_chapter_number,r.source_draft_version,
      r.source_draft_status,r.source_content,c.body FROM reviews r JOIN contents c ON c.id=r.content_id WHERE r.id=?`)
    .get(cycle.review_id) as SourceBoundRow | undefined
  const confirmation = db.prepare(`SELECT r.base_draft_id,r.source_draft_chapter_number,r.source_draft_version,
      r.source_draft_status,r.source_content,c.body FROM reviews r JOIN contents c ON c.id=r.content_id WHERE r.id=?`)
    .get(input.confirmationReviewId) as SourceBoundRow | undefined
  const revision = db.prepare(`SELECT r.base_draft_id,r.source_draft_chapter_number,r.source_draft_version,
      r.source_draft_status,r.source_content,r.review_source_id,r.status,c.body
      FROM revisions r JOIN contents c ON c.id=r.content_id WHERE r.id=?`).get(input.revisionId) as
    (SourceBoundRow & { review_source_id: number | null; status: string }) | undefined
  const snapshot = confirmation && parseHumanConfirmedReviewSnapshot(confirmation.body)
  if (!review || !confirmation || !revision || !snapshot?.sourceDraft
    || hash(review.source_content ?? '') !== cycle.source_hash
    || !sourceMatches(review, confirmation) || !sourceMatches(review, revision)
    || hash(confirmation.body) !== input.confirmationContentHash
    || hash(revision.body) !== input.revisionContentHash
    || snapshot.sourceReviewId !== cycle.review_id || snapshot.sourceDraft.id !== review.base_draft_id
    || snapshot.sourceDraft.chapterNumber !== review.source_draft_chapter_number
    || snapshot.sourceDraft.version !== review.source_draft_version
    || snapshot.sourceDraft.status !== review.source_draft_status || snapshot.sourceDraft.content !== review.source_content
    || revision.review_source_id !== input.confirmationReviewId || revision.status !== 'pending') invalid()
  return { baseDraftId: review.base_draft_id, snapshot }
}

function validateAuthorConfirmation(cycle: CycleBindingRow, confirmationReviewId: number,
  db: Database.Database): { snapshot: HumanConfirmedReviewSnapshot; contentHash: string } {
  const review = db.prepare(`SELECT r.base_draft_id,r.source_draft_chapter_number,r.source_draft_version,
      r.source_draft_status,r.source_content,c.body FROM reviews r JOIN contents c ON c.id=r.content_id WHERE r.id=?`)
    .get(cycle.review_id) as SourceBoundRow | undefined
  const confirmation = db.prepare(`SELECT r.base_draft_id,r.source_draft_chapter_number,r.source_draft_version,
      r.source_draft_status,r.source_content,c.body FROM reviews r JOIN contents c ON c.id=r.content_id WHERE r.id=?`)
    .get(confirmationReviewId) as SourceBoundRow | undefined
  const snapshot = confirmation && parseHumanConfirmedReviewSnapshot(confirmation.body)
  if (!review || !confirmation || !snapshot?.sourceDraft || hash(review.source_content ?? '') !== cycle.source_hash
    || !sourceMatches(review, confirmation) || snapshot.sourceReviewId !== cycle.review_id
    || snapshot.sourceDraft.id !== review.base_draft_id
    || snapshot.sourceDraft.chapterNumber !== review.source_draft_chapter_number
    || snapshot.sourceDraft.version !== review.source_draft_version
    || snapshot.sourceDraft.status !== review.source_draft_status
    || snapshot.sourceDraft.content !== review.source_content) invalid()
  return { snapshot, contentHash: hash(confirmation.body) }
}

function bindAuthorWaivers(input: { cycleId: string; confirmationContentHash: string },
  snapshot: HumanConfirmedReviewSnapshot, db: Database.Database, apply: boolean): number {
  if (snapshot.schemaVersion === 1) return 0
  if (snapshot.cycleId !== input.cycleId) invalid()
  const findings = db.prepare(`SELECT finding_id,status,evidence_hash,confirmation_item_index
    FROM review_findings WHERE cycle_id=?`).all(input.cycleId) as Array<{ finding_id: string; status: string;
      evidence_hash: string | null; confirmation_item_index: number | null }>
  const byId = new Map(findings.map(finding => [finding.finding_id, finding]))
  const seen = new Set<string>()
  let waived = 0
  for (const [index, item] of snapshot.items.entries()) {
    if (item.origin !== 'ai' || item.findingId === undefined) continue
    if (seen.has(item.findingId) || !byId.has(item.findingId)) invalid()
    seen.add(item.findingId)
    if (item.decision !== 'waive') continue
    waived += 1
    const current = byId.get(item.findingId)!
    if (!apply) {
      if (current.status !== 'author-waived' || current.evidence_hash !== input.confirmationContentHash
        || current.confirmation_item_index !== index) conflict()
      continue
    }
    if (current.status === 'resolved') conflict()
    const result = db.prepare(`UPDATE review_findings
      SET status='author-waived',evidence_hash=?,confirmation_item_index=?
      WHERE cycle_id=? AND finding_id=? AND status<>'resolved'`)
      .run(input.confirmationContentHash, index, input.cycleId, item.findingId)
    if (result.changes !== 1) conflict()
  }
  return waived
}

function reconcileDiscardedRevisionIds(db: Database.Database, revisionIds: readonly number[]): number {
  const cycles: Array<{ cycle_id: string; revision_id: number }> = []
  for (const revisionId of revisionIds) {
    const revision = db.prepare('SELECT status FROM revisions WHERE id=?').get(revisionId) as { status: string } | undefined
    if (!revision || revision.status !== 'discarded') conflict()
    const cycle = db.prepare('SELECT cycle_id,revision_status FROM review_cycles WHERE revision_id=?').get(revisionId) as {
      cycle_id: string; revision_status: string
    } | undefined
    if (cycle && cycle.revision_status !== 'generated') conflict()
    if (cycle) cycles.push({ cycle_id: cycle.cycle_id, revision_id: revisionId })
  }
  for (const cycle of cycles) {
    const result = db.prepare(`UPDATE review_cycles SET revision_id=NULL,revision_status='not-generated'
      WHERE cycle_id=? AND revision_id=? AND revision_status='generated'`).run(cycle.cycle_id, cycle.revision_id)
    if (result.changes !== 1) conflict()
  }
  return cycles.length
}

function detachDiscardedGeneratedCycles(db: Database.Database, baseDraftId: number, excludedCycleId: string): void {
  const rows = db.prepare(`SELECT rc.revision_id FROM review_cycles rc
    JOIN revisions r ON r.id=rc.revision_id
    WHERE rc.revision_status='generated' AND r.status='discarded' AND r.base_draft_id=? AND rc.cycle_id<>?`)
    .all(baseDraftId, excludedCycleId) as { revision_id: number }[]
  reconcileDiscardedRevisionIds(db, rows.map(row => row.revision_id))
}

function isCurrentMergedCycle(cycleId: string, mergedHash: string, db: Database.Database): boolean {
  const current = db.prepare(`SELECT c.body,v.revision_index,
      (SELECT MAX(newer.revision_index) FROM revisions newer
        WHERE newer.base_draft_id=v.base_draft_id AND newer.status='merged') AS latest_merged_index
    FROM review_cycles rc JOIN revisions v ON v.id=rc.revision_id
    JOIN drafts d ON d.id=v.base_draft_id JOIN contents c ON c.id=d.content_id WHERE rc.cycle_id=?`)
    .get(cycleId) as { body: string; revision_index: number; latest_merged_index: number | null } | undefined
  return Boolean(current && current.revision_index === current.latest_merged_index
    && hash(current.body) === mergedHash)
}

function readRecheckCycle(cycleId: string, db: Database.Database): RecheckCycleRow {
  const snapshot = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_cycle_merges'").get())
  const cycle = db.prepare(`SELECT rc.cycle_id,rc.root_action_id,rc.review_id,rc.finding_set_hash,rc.comparison_version,
      rc.revision_status,rc.merged_hash,rc.recheck_count,rc.recheck_attempt_id,r.source_content,
      ${snapshot ? 'm.body' : 'c.body'} AS merged_body
    FROM review_cycles rc JOIN reviews r ON r.id=rc.review_id JOIN revisions v ON v.id=rc.revision_id
    JOIN drafts d ON d.id=v.base_draft_id JOIN contents c ON c.id=d.content_id
    ${snapshot ? 'JOIN review_cycle_merges m ON m.cycle_id=rc.cycle_id' : ''} WHERE rc.cycle_id=?`)
    .get(cycleId) as RecheckCycleRow | undefined
  if (!cycle || cycle.revision_status !== 'merge-committed' || !cycle.merged_hash
    || !HASH.test(cycle.merged_hash) || cycle.source_content === null
    || hash(cycle.merged_body) !== cycle.merged_hash || !isCurrentMergedCycle(cycleId, cycle.merged_hash, db)
    || !verifyM03ReviewCycle(db)) conflict()
  return cycle
}

function recheckContext(cycle: RecheckCycleRow, db: Database.Database): ReviewCycleRecheckContext {
  const rows = db.prepare(`SELECT finding_id,target_id,category,kind,problem_text,expected_text,status,span_start,span_end,span_unit,occurrence
    FROM review_findings WHERE cycle_id=? ORDER BY finding_id`).all(cycle.cycle_id) as RecheckFindingRow[]
  const findings: ReviewCycleRecheckFinding[] = []
  for (const row of rows) {
    if (['unverified', 'resolved', 'author-waived'].includes(row.status) || row.target_id === null
      || row.span_start === null || row.span_end === null || row.span_unit !== 'utf16-code-unit'
      || row.occurrence === null) continue
    const finding: ReviewCycleRecheckFinding = { findingId: row.finding_id, targetId: row.target_id,
      category: row.category, kind: row.kind,
      problem: row.problem_text, ...(row.expected_text ? { expected: row.expected_text } : {}),
      sourceSpan: { start: row.span_start, end: row.span_end, unit: 'utf16-code-unit' }, occurrence: row.occurrence,
      sourceExcerpt: cycle.source_content!.slice(row.span_start, row.span_end) }
    if (classifyFindingEvidenceChange(cycle.source_content!, cycle.merged_body, finding) === 'changed') findings.push(finding)
  }
  return { version: 2, cycleId: cycle.cycle_id, comparisonVersion: cycle.comparison_version,
    mergedHash: cycle.merged_hash!, findingSetHash: cycle.finding_set_hash, findings }
}

export class ReviewCycleRepository {
  static getByReviewId(reviewId: number, db: Database.Database): ReviewCycleProjection | null {
    if (!integer(reviewId, 1)) invalid()
    const cycle = db.prepare(`SELECT cycle_id,review_id,revision_status,merged_hash,recheck_count
      FROM review_cycles WHERE review_id=?`).get(reviewId) as { cycle_id: string; review_id: number;
        revision_status: ReviewCycleProjection['revisionStatus']; merged_hash: string | null; recheck_count: 0 | 1 } | undefined
    if (!cycle) return null
    if (!verifyM03ReviewCycle(db)) conflict()
    const review = db.prepare(`SELECT r.source_content,c.body FROM reviews r
      JOIN contents c ON c.id=r.content_id WHERE r.id=?`).get(reviewId) as { source_content: string | null; body: string } | undefined
    if (!review || review.source_content === null) conflict()
    const report = parseSavedReport(review.body)
    const sourceRow = db.prepare(`SELECT source_project_id,source_epoch,source_id,source_revision,source_content_hash
      FROM review_findings WHERE cycle_id=? LIMIT 1`).get(cycle.cycle_id) as { source_project_id: string; source_epoch: string;
        source_id: string; source_revision: number; source_content_hash: string } | undefined
    const persisted = db.prepare(`SELECT finding_id,category,target_id,kind,status FROM review_findings
      WHERE cycle_id=? ORDER BY finding_id`).all(cycle.cycle_id) as Array<{ finding_id: string; category: string;
        target_id: string | null; kind: 'objective' | 'literary'; status: ReviewCycleProjection['findings'][number]['status'] }>
    if (!sourceRow && persisted.length) conflict()
    const itemIndex = new Map<string, number>()
    if (sourceRow) {
      const source: ReviewCycleSource = { projectId: sourceRow.source_project_id, epoch: sourceRow.source_epoch,
        sourceId: sourceRow.source_id, revision: sourceRow.source_revision, contentHash: sourceRow.source_content_hash }
      for (const item of report.items) {
        if (item.severity === 'pass') continue
        const goal = item.goalId ? report.goals.find(candidate => candidate.id === item.goalId) : undefined
        if (goal?.status === 'completed') continue
        const objective = item.stableFactKey !== undefined || Boolean(goal)
        const descriptor = finding({ source, sourceText: review.source_content, category: item.category,
          targetId: goal?.id ?? item.stableFactKey ?? null, kind: objective ? 'objective' : 'literary',
          quote: goal ? goal.evidence.length === 1 ? goal.evidence[0]!.quote : null : item.quote ?? null,
          problemText: item.description, ...(goal ? { expectedText: `${goal.text}\n${goal.description}` } : {}),
          anchoredStatus: goal?.status === 'unknown' ? 'unknown' : 'unresolved',
          logicalIdentity: goal ? `goal:${goal.id}` : objective ? `preflight:${item.stableFactKey}` : `free:${item.index}` })
        if (!itemIndex.has(descriptor.findingId)) itemIndex.set(descriptor.findingId, item.index)
      }
    }
    const projection: ReviewCycleProjection = { cycleId: cycle.cycle_id, reviewId: cycle.review_id,
      revisionStatus: cycle.revision_status, ...(cycle.merged_hash ? { mergedHash: cycle.merged_hash } : {}),
      recheckCount: cycle.recheck_count, findings: persisted.map(row => ({ findingId: row.finding_id,
        reviewItemIndex: itemIndex.get(row.finding_id) ?? null, category: row.category, kind: row.kind, status: row.status,
        ...(row.target_id ? { targetId: row.target_id } : {}) })) }
    if (cycle.revision_status === 'merge-committed') {
      if (cycle.merged_hash && isCurrentMergedCycle(cycle.cycle_id, cycle.merged_hash, db)) {
        projection.recheckDisposition = this.planRecheck(cycle.cycle_id, db).disposition
      }
    }
    return projection
  }

  static create(input: CreateReviewCycleInput, db: Database.Database): CreatedReviewCycle {
    if (!db.inTransaction) throw new Error('REVIEW_CYCLE_TRANSACTION_REQUIRED')
    if (!nonempty(input.rootActionId) || !integer(input.reviewId, 1) || !HASH.test(input.reviewContentHash)
      || !nonempty(input.source.projectId) || !nonempty(input.source.epoch) || !nonempty(input.source.sourceId)
      || !integer(input.source.revision, 1) || !HASH.test(input.source.contentHash)) invalid()

    return db.transaction((): CreatedReviewCycle => {
      const root = db.prepare('SELECT action_json FROM generation_roots WHERE root_action_id=?').get(input.rootActionId) as {
        action_json: string
      } | undefined
      let action: Record<string, unknown> | null = null
      try { action = record(root && JSON.parse(root.action_json)) } catch { invalid() }
      if (!action || action.rootActionId !== input.rootActionId || action.projectId !== input.source.projectId
        || action.epoch !== input.source.epoch || action.operation !== 'review-chapter') invalid()

      const review = db.prepare(`SELECT r.base_draft_id,r.source_draft_version,r.source_content,c.body
        FROM reviews r JOIN contents c ON c.id=r.content_id WHERE r.id=?`).get(input.reviewId) as ReviewRow | undefined
      if (!review || review.source_content === null || !integer(review.source_draft_version, 1)
        || input.source.sourceId !== `draft:${review.base_draft_id}`
        || input.source.revision !== review.source_draft_version
        || hash(review.source_content) !== input.source.contentHash || hash(review.body) !== input.reviewContentHash) invalid()

      const report = parseSavedReport(review.body)
      const findings = buildFindings(report, input.source, review.source_content)
      const findingSetHash = canonicalM03FindingSetHash(findings)
      const id = cycleId(input)
      const existing = db.prepare(`SELECT cycle_id,root_action_id,review_content_hash,source_hash,finding_set_hash,comparison_version
        FROM review_cycles WHERE review_id=?`).get(input.reviewId) as Record<string, unknown> | undefined
      if (existing) {
        const stored = db.prepare('SELECT * FROM review_findings WHERE cycle_id=? ORDER BY finding_id').all(existing.cycle_id) as Record<string, unknown>[]
        if (existing.cycle_id !== id || existing.root_action_id !== input.rootActionId
          || existing.review_content_hash !== input.reviewContentHash || existing.source_hash !== input.source.contentHash
          || existing.finding_set_hash !== findingSetHash || existing.comparison_version !== 1
          || canonicalM03FindingSetHash(stored.map(persistedFinding)) !== findingSetHash) conflict()
        if (!verifyM03ReviewCycle(db)) conflict()
        return { cycleId: id, findingSetHash, findingCount: findings.length }
      }

      db.prepare(`INSERT INTO review_cycles(cycle_id,root_action_id,review_id,review_content_hash,source_hash,
        finding_set_hash,comparison_version,revision_status,recheck_count) VALUES(?,?,?,?,?,?,1,'not-generated',0)`)
        .run(id, input.rootActionId, input.reviewId, input.reviewContentHash, input.source.contentHash, findingSetHash)
      const insert = db.prepare(`INSERT INTO review_findings(cycle_id,finding_id,source_project_id,source_epoch,source_id,
        source_revision,source_content_hash,span_start,span_end,span_unit,excerpt_hash,occurrence,category,target_id,kind,
        problem_text,expected_text,status,evidence_hash,confirmation_item_index) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      for (const item of findings) insert.run(id, item.findingId, item.source.projectId, item.source.epoch, item.source.sourceId,
        item.source.revision, item.source.contentHash, item.source.span?.start ?? null, item.source.span?.end ?? null,
        item.source.span?.unit ?? null, item.excerptHash, item.occurrence, item.category, item.targetId, item.kind,
        item.problemText, item.expectedText, item.status,
        item.evidenceHash, item.confirmationItemIndex)
      if (!verifyM03ReviewCycle(db)) invalid()
      return { cycleId: id, findingSetHash, findingCount: findings.length }
    })()
  }

  static commitAuthorConfirmation(input: { cycleId: string; confirmationReviewId: number },
    db: Database.Database): AuthorConfirmationBinding {
    if (!db.inTransaction) throw new Error('REVIEW_CYCLE_TRANSACTION_REQUIRED')
    if (!nonempty(input.cycleId) || !integer(input.confirmationReviewId, 1)) invalid()
    return db.transaction((): AuthorConfirmationBinding => {
      const cycle = db.prepare(`SELECT cycle_id,root_action_id,review_id,confirmation_review_id,confirmation_content_hash,
        revision_id,source_hash,revision_status FROM review_cycles WHERE cycle_id=?`).get(input.cycleId) as CycleBindingRow | undefined
      if (!cycle || cycle.revision_status !== 'not-generated' || cycle.revision_id !== null) conflict()
      const confirmation = validateAuthorConfirmation(cycle, input.confirmationReviewId, db)
      if (cycle.confirmation_review_id !== null) {
        if (cycle.confirmation_review_id !== input.confirmationReviewId
          || cycle.confirmation_content_hash !== confirmation.contentHash) conflict()
        const waivedFindingCount = bindAuthorWaivers({ cycleId: input.cycleId,
          confirmationContentHash: confirmation.contentHash }, confirmation.snapshot, db, false)
        if (!verifyM03ReviewCycle(db)) conflict()
        return { cycleId: input.cycleId, confirmationReviewId: input.confirmationReviewId,
          confirmationContentHash: confirmation.contentHash, waivedFindingCount, idempotent: true }
      }
      const confirmationOwner = db.prepare('SELECT cycle_id FROM review_cycles WHERE confirmation_review_id=?')
        .pluck().get(input.confirmationReviewId) as string | undefined
      if (confirmationOwner && confirmationOwner !== input.cycleId) conflict()
      const waivedFindingCount = bindAuthorWaivers({ cycleId: input.cycleId,
        confirmationContentHash: confirmation.contentHash }, confirmation.snapshot, db, true)
      const result = db.prepare(`UPDATE review_cycles SET confirmation_review_id=?,confirmation_content_hash=?
        WHERE cycle_id=? AND revision_status='not-generated' AND confirmation_review_id IS NULL AND revision_id IS NULL`)
        .run(input.confirmationReviewId, confirmation.contentHash, input.cycleId)
      if (result.changes !== 1 || !verifyM03ReviewCycle(db)) conflict()
      return { cycleId: input.cycleId, confirmationReviewId: input.confirmationReviewId,
        confirmationContentHash: confirmation.contentHash, waivedFindingCount, idempotent: false }
    })()
  }

  static attachGeneratedRevision(input: AttachGeneratedRevisionInput, db: Database.Database): GeneratedRevisionBinding {
    if (!db.inTransaction) throw new Error('REVIEW_CYCLE_TRANSACTION_REQUIRED')
    if (!nonempty(input.cycleId) || !nonempty(input.rootActionId) || !integer(input.confirmationReviewId, 1)
      || !HASH.test(input.confirmationContentHash) || !integer(input.revisionId, 1)
      || !HASH.test(input.revisionContentHash)) invalid()
    return db.transaction((): GeneratedRevisionBinding => {
      const cycle = db.prepare(`SELECT cycle_id,root_action_id,review_id,confirmation_review_id,confirmation_content_hash,
        revision_id,source_hash,revision_status FROM review_cycles WHERE cycle_id=?`).get(input.cycleId) as CycleBindingRow | undefined
      if (!cycle || cycle.root_action_id !== input.rootActionId) invalid()
      if (cycle.revision_status === 'merge-committed') conflict()
      if (cycle.revision_status === 'generated') {
        if (cycle.confirmation_review_id !== input.confirmationReviewId
          || cycle.confirmation_content_hash !== input.confirmationContentHash || cycle.revision_id !== input.revisionId) conflict()
        const { snapshot } = validateGeneratedBinding(input, cycle, db)
        bindAuthorWaivers({ cycleId: input.cycleId, confirmationContentHash: input.confirmationContentHash }, snapshot, db, false)
        if (!verifyM03ReviewCycle(db)) conflict()
        return { cycleId: input.cycleId, confirmationReviewId: input.confirmationReviewId,
          revisionId: input.revisionId, revisionStatus: 'generated', idempotent: true }
      }
      if (cycle.revision_id !== null || cycle.confirmation_review_id !== null
        && (cycle.confirmation_review_id !== input.confirmationReviewId
          || cycle.confirmation_content_hash !== input.confirmationContentHash)) conflict()
      const revisionOwner = db.prepare('SELECT cycle_id FROM review_cycles WHERE revision_id=?').pluck().get(input.revisionId) as string | undefined
      const confirmationOwner = db.prepare('SELECT cycle_id FROM review_cycles WHERE confirmation_review_id=?')
        .pluck().get(input.confirmationReviewId) as string | undefined
      if (revisionOwner && revisionOwner !== input.cycleId || confirmationOwner && confirmationOwner !== input.cycleId) conflict()
      const { baseDraftId, snapshot } = validateGeneratedBinding(input, cycle, db)
      bindAuthorWaivers({ cycleId: input.cycleId, confirmationContentHash: input.confirmationContentHash }, snapshot, db,
        cycle.confirmation_review_id === null)
      detachDiscardedGeneratedCycles(db, baseDraftId, input.cycleId)
      const result = db.prepare(`UPDATE review_cycles SET confirmation_review_id=?,confirmation_content_hash=?,revision_id=?,
        revision_status='generated' WHERE cycle_id=? AND revision_status='not-generated' AND revision_id IS NULL`)
        .run(input.confirmationReviewId, input.confirmationContentHash, input.revisionId, input.cycleId)
      if (result.changes !== 1 || !verifyM03ReviewCycle(db)) invalid()
      return { cycleId: input.cycleId, confirmationReviewId: input.confirmationReviewId,
        revisionId: input.revisionId, revisionStatus: 'generated', idempotent: false }
    })()
  }

  static commitMergedRevision(input: { revisionId: number; mergedHash: string },
    db: Database.Database): MergeCommittedCycle {
    if (!db.inTransaction) throw new Error('REVIEW_CYCLE_TRANSACTION_REQUIRED')
    if (!input || !integer(input.revisionId, 1) || !HASH.test(input.mergedHash)) invalid()
    return db.transaction((): MergeCommittedCycle => {
      const cycle = db.prepare(`SELECT cycle_id,revision_status,merged_hash FROM review_cycles WHERE revision_id=?`)
        .get(input.revisionId) as { cycle_id: string; revision_status: string; merged_hash: string | null } | undefined
      if (!cycle) return { revisionId: input.revisionId, bound: false, idempotent: true }
      if (!['generated', 'merge-committed'].includes(cycle.revision_status)) conflict()
      const merged = db.prepare(`SELECT r.status,r.base_draft_id,r.merged_to_draft_id,c.body
        FROM revisions r JOIN drafts d ON d.id=r.base_draft_id JOIN contents c ON c.id=d.content_id WHERE r.id=?`)
        .get(input.revisionId) as { status: string; base_draft_id: number; merged_to_draft_id: number | null;
          body: string } | undefined
      if (!merged || merged.status !== 'merged' || merged.merged_to_draft_id !== merged.base_draft_id
        || hash(merged.body) !== input.mergedHash) conflict()
      if (cycle.revision_status === 'merge-committed') {
        if (cycle.merged_hash !== input.mergedHash || !verifyM03ReviewCycle(db)) conflict()
        return { revisionId: input.revisionId, bound: true, cycleId: cycle.cycle_id,
          revisionStatus: 'merge-committed', idempotent: true }
      }
      const result = db.prepare(`UPDATE review_cycles SET revision_status='merge-committed',merged_hash=?
        WHERE cycle_id=? AND revision_id=? AND revision_status='generated' AND merged_hash IS NULL`)
        .run(input.mergedHash, cycle.cycle_id, input.revisionId)
      if (result.changes === 1 && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_cycle_merges'").get()) {
        db.prepare('INSERT INTO review_cycle_merges(cycle_id,body) VALUES(?,?)').run(cycle.cycle_id, merged.body)
      }
      if (result.changes !== 1 || !verifyM03ReviewCycle(db)) conflict()
      return { revisionId: input.revisionId, bound: true, cycleId: cycle.cycle_id,
        revisionStatus: 'merge-committed', idempotent: false }
    })()
  }

  static planRecheck(cycleId: string, db: Database.Database): ReviewCycleRecheckPlan {
    if (!nonempty(cycleId)) invalid()
    const cycle = readRecheckCycle(cycleId, db)
    if (cycle.recheck_count === 1) return { disposition: 'completed', context: null,
      rootActionId: cycle.root_action_id, reviewId: cycle.review_id }
    if (cycle.recheck_count !== 0 || cycle.recheck_attempt_id !== null) conflict()
    const context = recheckContext(cycle, db)
    return { disposition: context.findings.length ? 'required' : 'not-required',
      context: context.findings.length ? context : null, rootActionId: cycle.root_action_id, reviewId: cycle.review_id }
  }

  static commitRecheck(cycleId: string, attemptId: string, db: Database.Database): CommittedReviewCycleRecheck {
    if (!db.inTransaction) throw new Error('REVIEW_CYCLE_TRANSACTION_REQUIRED')
    if (!nonempty(cycleId) || !nonempty(attemptId)) invalid()
    return db.transaction((): CommittedReviewCycleRecheck => {
      const current = readRecheckCycle(cycleId, db)
      if (current.recheck_count === 1) {
        if (current.recheck_attempt_id !== attemptId) conflict()
        return { cycleId, attemptId, recheckCount: 1, idempotent: true }
      }
      const plan = this.planRecheck(cycleId, db)
      if (plan.disposition !== 'required' || !plan.context) conflict()
      const attempt = db.prepare('SELECT root_action_id,usage_receipt_json FROM generation_attempts WHERE attempt_id=?')
        .get(attemptId) as { root_action_id: string; usage_receipt_json: string } | undefined
      let usage: Record<string, unknown> | null = null
      try { usage = record(attempt && JSON.parse(attempt.usage_receipt_json)) } catch { invalid() }
      const receipt = record(usage?.reviewCycleRecheck)
      if (!attempt || attempt.root_action_id !== plan.rootActionId || !receipt
        || (receipt.version !== 1 && receipt.version !== 2)
        || receipt.cycleId !== cycleId || receipt.comparisonVersion !== plan.context.comparisonVersion
        || receipt.mergedHash !== plan.context.mergedHash || receipt.findingSetHash !== plan.context.findingSetHash
        || !Array.isArray(receipt.findings)) conflict()
      const mappings = receipt.findings.map(value => record(value))
      if (mappings.some(mapping => mapping?.resolved === true)) conflict()
      const expectedTargets = new Map(plan.context.findings.map(finding => [finding.findingId, finding.targetId]))
      if (mappings.some(mapping => !mapping || expectedTargets.get(String(mapping.findingId)) !== mapping.targetId)) conflict()
      const itemIndexes = new Map<number, number>()
      for (const mapping of mappings) {
        if (mapping && integer(mapping.reviewItemIndex)) itemIndexes.set(mapping.reviewItemIndex,
          (itemIndexes.get(mapping.reviewItemIndex) ?? 0) + 1)
      }
      const update = db.prepare(`UPDATE review_findings SET status=?,evidence_hash=?,confirmation_item_index=NULL
        WHERE cycle_id=? AND finding_id=? AND status NOT IN ('resolved','author-waived')`)
      for (const finding of plan.context.findings) {
        const candidates = mappings.filter(mapping => mapping?.findingId === finding.findingId)
        const mapping = candidates.length === 1 ? candidates[0] : null
        const valid = mapping && mapping.targetId === finding.targetId && integer(mapping.reviewItemIndex)
          && itemIndexes.get(mapping.reviewItemIndex as number) === 1
          && HASH.test(String(mapping.evidenceHash)) && typeof mapping.resolved === 'boolean'
        const status = valid ? mapping!.resolved ? 'resolved' : 'unresolved' : 'unknown'
        const result = update.run(status, valid ? mapping!.evidenceHash : null, cycleId, finding.findingId)
        if (result.changes !== 1) conflict()
      }
      const result = db.prepare(`UPDATE review_cycles SET recheck_count=1,recheck_attempt_id=?
        WHERE cycle_id=? AND revision_status='merge-committed' AND recheck_count=0 AND recheck_attempt_id IS NULL`)
        .run(attemptId, cycleId)
      if (result.changes !== 1 || !verifyM03ReviewCycle(db)) conflict()
      return { cycleId, attemptId, recheckCount: 1, idempotent: false }
    })()
  }

  static reconcileDiscardedRevision(revisionId: number, db: Database.Database): DiscardedRevisionReconciliation {
    if (!db.inTransaction) throw new Error('REVIEW_CYCLE_TRANSACTION_REQUIRED')
    if (!integer(revisionId, 1)) invalid()
    const result = this.reconcileDiscardedRevisions([revisionId], db)
    return { revisionId, detached: result.detached === 1 }
  }

  static reconcileDiscardedRevisions(revisionIds: readonly number[], db: Database.Database): DiscardedRevisionsReconciliation {
    if (!db.inTransaction) throw new Error('REVIEW_CYCLE_TRANSACTION_REQUIRED')
    if (!Array.isArray(revisionIds) || revisionIds.some(revisionId => !integer(revisionId, 1))) invalid()
    const uniqueIds = [...new Set(revisionIds)].sort((left, right) => left - right)
    return db.transaction(() => {
      const detached = reconcileDiscardedRevisionIds(db, uniqueIds)
      if (!verifyM03ReviewCycle(db)) conflict()
      return { revisionIds: uniqueIds, detached }
    })()
  }
}
