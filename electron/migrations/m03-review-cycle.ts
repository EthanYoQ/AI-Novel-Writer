import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type Database from 'better-sqlite3'
import { buildReviewGenerationReport } from '../../src/shared/review-generation-report'
import { buildReviewCycleRecheckReport, classifyFindingEvidenceChange,
  type ReviewCycleRecheckContext, type ReviewCycleRecheckFinding } from '../../src/shared/review-cycle'
import { parseHumanConfirmedReviewSnapshot, type HumanConfirmedReviewSnapshot } from '../../src/shared/human-confirmed-review'
import { composeVisibleContinuation } from '../../src/shared/visible-continuation'
import type { ReviewRevisionContext } from '../../src/shared/review-revision-generation'
import type { MigrationImplementation, SchemaReader } from './registry'

const HASH = /^[a-f0-9]{64}$/u
const CYCLE_STATUSES = new Set(['not-generated', 'generated', 'merge-committed'])
const FINDING_STATUSES = new Set(['unverified', 'unresolved', 'unknown', 'resolved', 'author-waived'])
const FINDING_KINDS = new Set(['objective', 'literary'])
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && (value as number) >= minimum
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object'
  && !Array.isArray(value) ? value as Record<string, unknown> : null

export const M03_REVIEW_CYCLE_TABLES = Object.freeze(['review_cycles', 'review_findings'] as const)

export interface M03FindingDescriptor {
  findingId: string
  source: { projectId: string; epoch: string; sourceId: string; revision: number; contentHash: string;
    span: { start: number; end: number; unit: 'utf16-code-unit' } | null }
  excerptHash: string | null
  occurrence: number | null
  category: string
  targetId: string | null
  kind: 'objective' | 'literary'
  problemText: string
  expectedText: string | null
  status: 'unverified' | 'unresolved' | 'unknown' | 'resolved' | 'author-waived'
  evidenceHash: string | null
  confirmationItemIndex: number | null
}

/** Canonical order is finding identity order; a null span is the explicit unverified-anchor marker. */
export function canonicalM03FindingSetHash(findings: readonly M03FindingDescriptor[]): string {
  const immutable = findings.map(finding => ({ findingId: finding.findingId,
    sourceProjectId: finding.source.projectId, sourceEpoch: finding.source.epoch, sourceId: finding.source.sourceId,
    sourceRevision: finding.source.revision, sourceContentHash: finding.source.contentHash,
    spanStart: finding.source.span?.start ?? null, spanEnd: finding.source.span?.end ?? null,
    spanUnit: finding.source.span?.unit ?? null, excerptHash: finding.excerptHash, occurrence: finding.occurrence,
    category: finding.category, targetId: finding.targetId, kind: finding.kind,
    problemText: finding.problemText, expectedText: finding.expectedText }))
  return hash(JSON.stringify(immutable.sort((left, right) => left.findingId < right.findingId ? -1 : left.findingId > right.findingId ? 1 : 0)))
}

export const M03_REVIEW_CYCLE_SQL = `
CREATE TABLE review_cycles (
 cycle_id TEXT PRIMARY KEY,
 root_action_id TEXT NOT NULL REFERENCES generation_roots(root_action_id),
 review_id INTEGER NOT NULL UNIQUE REFERENCES reviews(id) ON DELETE CASCADE,
 review_content_hash TEXT NOT NULL,
 confirmation_review_id INTEGER UNIQUE REFERENCES reviews(id),
 confirmation_content_hash TEXT,
 revision_id INTEGER UNIQUE REFERENCES revisions(id),
 source_hash TEXT NOT NULL,
 finding_set_hash TEXT NOT NULL,
 comparison_version INTEGER NOT NULL,
 revision_status TEXT NOT NULL CHECK(revision_status IN ('not-generated','generated','merge-committed')),
 merged_hash TEXT,
 recheck_count INTEGER NOT NULL CHECK(recheck_count IN (0,1)),
 recheck_attempt_id TEXT UNIQUE REFERENCES generation_attempts(attempt_id),
 CHECK((confirmation_review_id IS NULL) = (confirmation_content_hash IS NULL)),
 CHECK((revision_status='not-generated' AND revision_id IS NULL AND merged_hash IS NULL AND recheck_count=0 AND recheck_attempt_id IS NULL)
    OR (revision_status='generated' AND revision_id IS NOT NULL AND merged_hash IS NULL AND recheck_count=0 AND recheck_attempt_id IS NULL)
    OR (revision_status='merge-committed' AND revision_id IS NOT NULL AND merged_hash IS NOT NULL
      AND ((recheck_count=0 AND recheck_attempt_id IS NULL) OR (recheck_count=1 AND recheck_attempt_id IS NOT NULL))))
);
CREATE TABLE review_findings (
 cycle_id TEXT NOT NULL REFERENCES review_cycles(cycle_id) ON DELETE CASCADE,
 finding_id TEXT NOT NULL,
 source_project_id TEXT NOT NULL,
 source_epoch TEXT NOT NULL,
 source_id TEXT NOT NULL,
 source_revision INTEGER NOT NULL,
 source_content_hash TEXT NOT NULL,
 span_start INTEGER,
 span_end INTEGER,
 span_unit TEXT,
 excerpt_hash TEXT,
 occurrence INTEGER,
 category TEXT NOT NULL,
 target_id TEXT,
 kind TEXT NOT NULL CHECK(kind IN ('objective','literary')),
 problem_text TEXT NOT NULL,
 expected_text TEXT,
 status TEXT NOT NULL CHECK(status IN ('unverified','unresolved','unknown','resolved','author-waived')),
 evidence_hash TEXT,
 confirmation_item_index INTEGER,
 PRIMARY KEY(cycle_id,finding_id),
 CHECK((status IN ('unverified','author-waived') AND span_start IS NULL AND span_end IS NULL AND span_unit IS NULL
    AND excerpt_hash IS NULL AND occurrence IS NULL AND target_id IS NULL)
   OR (status<>'unverified' AND span_start IS NOT NULL AND span_end IS NOT NULL AND span_unit='utf16-code-unit'
    AND excerpt_hash IS NOT NULL AND occurrence IS NOT NULL AND target_id IS NOT NULL)),
 CHECK((status='author-waived' AND confirmation_item_index IS NOT NULL)
   OR (status<>'author-waived' AND confirmation_item_index IS NULL))
);`

/** The central runner owns the transaction and user_version. Existing reviews are deliberately not inferred or backfilled. */
export function applyM03ReviewCycle(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('REVIEW_CYCLE_MIGRATION_TRANSACTION_REQUIRED')
  for (const table of ['reviews', 'revisions', 'generation_roots', 'generation_runs', 'generation_attempts']) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
      throw new Error('REVIEW_CYCLE_MIGRATION_SCHEMA_UNRECOGNIZED')
    }
  }
  db.exec(M03_REVIEW_CYCLE_SQL)
}

export const M06_REVIEW_CYCLE_MERGE_SQL = `CREATE TABLE review_cycle_merges (
 cycle_id TEXT PRIMARY KEY REFERENCES review_cycles(cycle_id) ON DELETE CASCADE,
 body TEXT NOT NULL
);`

/** Only a still-current, hash-matched v6 merge can supply a historical snapshot. */
export function applyM06ReviewCycleMerge(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('REVIEW_CYCLE_MIGRATION_TRANSACTION_REQUIRED')
  if (!verifyM03ReviewCycle(db)) throw new Error('REVIEW_CYCLE_MIGRATION_SOURCE_INVALID')
  const merged = db.prepare(`SELECT rc.cycle_id,rc.merged_hash,c.body FROM review_cycles rc
    JOIN revisions r ON r.id=rc.revision_id JOIN drafts d ON d.id=r.base_draft_id
    JOIN contents c ON c.id=d.content_id WHERE rc.revision_status='merge-committed'`).all() as Array<{
      cycle_id: string; merged_hash: string; body: string }>
  db.exec(M06_REVIEW_CYCLE_MERGE_SQL)
  const insert = db.prepare('INSERT INTO review_cycle_merges(cycle_id,body) VALUES(?,?)')
  for (const row of merged) {
    if (hash(row.body) !== row.merged_hash) throw new Error('REVIEW_CYCLE_MIGRATION_SOURCE_INVALID')
    insert.run(row.cycle_id, row.body)
  }
}

interface CycleRow {
  cycle_id: string; root_action_id: string; review_id: number; review_content_hash: string
  confirmation_review_id: number | null; confirmation_content_hash: string | null; revision_id: number | null
  source_hash: string; finding_set_hash: string; comparison_version: number; revision_status: string
  merged_hash: string | null; recheck_count: number; recheck_attempt_id: string | null
}
interface FindingRow {
  cycle_id: string; finding_id: string; source_project_id: string; source_epoch: string; source_id: string
  source_revision: number; source_content_hash: string; span_start: number | null; span_end: number | null
  span_unit: string | null; excerpt_hash: string | null; occurrence: number | null; category: string
  target_id: string | null; kind: string; problem_text: string; expected_text: string | null
  status: string; evidence_hash: string | null; confirmation_item_index: number | null
}
interface ReviewRow { id: number; base_draft_id: number; source_draft_chapter_number: number | null; source_draft_version: number | null;
  source_draft_status: string | null; source_content: string | null; body: string }
interface RevisionRow { id: number; base_draft_id: number; review_source_id: number | null; source_draft_chapter_number: number | null;
  source_draft_version: number | null; source_draft_status: string | null; source_content: string | null;
  status: string; merged_to_draft_id: number | null; body: string }
interface AttemptRow { attempt_id: string; run_id: string; root_action_id: string; run_root_action_id: string
  binding_json: string; attempt_json: string; usage_receipt_json: string | null }

function effect(row: AttemptRow): Record<string, unknown> | null {
  if (!row.usage_receipt_json) return null
  const receipt = JSON.parse(row.usage_receipt_json) as { reviewRevisionEffect?: unknown }
  return receipt.reviewRevisionEffect && typeof receipt.reviewRevisionEffect === 'object'
    ? receipt.reviewRevisionEffect as Record<string, unknown> : null
}
function proveEffect(db: Database.Database, row: AttemptRow, expected: {
  kind: 'review' | 'revision'; id: number; index: number; contentHash: string
  source: { id: number; chapterNumber: number; version: number; status: string; content: string }
  confirmation?: { reviewSourceId: number; content: string; originalReviewContentHash: string;
    snapshot: HumanConfirmedReviewSnapshot }
  recheck?: ReviewCycleRecheckContext
}): boolean {
  const stored = effect(row)
  if (!stored || stored.kind !== expected.kind || stored.id !== expected.id || stored.index !== expected.index
    || stored.contentHash !== expected.contentHash || !HASH.test(String(stored.contextHash))) return false
  const allowed = expected.kind === 'revision'
    ? ['artifact', 'compositionHash', 'contentHash', 'contextHash', 'id', 'index', 'kind']
    : ['artifact', 'contentHash', 'contextHash', 'id', 'index', 'kind']
  if (Object.keys(stored).sort().join() !== allowed.join()) return false
  const binding = JSON.parse(row.binding_json) as Record<string, unknown>
  const manifest = binding.sourceManifest as Record<string, unknown> | undefined
  const context = manifest?.reviewRevisionContext as Record<string, unknown> | undefined
  const source = context?.source as Record<string, unknown> | undefined
  const confirmation = context?.confirmation as Record<string, unknown> | undefined
  const recheck = context?.recheck as Record<string, unknown> | undefined
  const validRecheckVersionPair = !expected.recheck || recheck?.version === 1
    && (expected.recheck.version === 1 || expected.recheck.version === 2)
    || recheck?.version === 2 && expected.recheck.version === 2
  const frozenRecheck = validRecheckVersionPair && expected.recheck && recheck
    ? { ...expected.recheck, version: recheck.version } : expected.recheck
  const sourceHash = hash(expected.source.content)
  if (!context || context.version !== 1 || context.operation !== (expected.kind === 'review' ? 'review-chapter' : 'refine-from-review')
    || !source || Object.keys(source).sort().join() !== 'chapterNumber,content,id,status,version'
    || source.id !== expected.source.id || source.chapterNumber !== expected.source.chapterNumber
    || source.version !== expected.source.version || source.status !== expected.source.status || source.content !== expected.source.content
    || context.sourceHash !== sourceHash || stored.contextHash !== hash(JSON.stringify(context))
    || !context.config || !['zh-CN', 'en-US'].includes(String(context.writingLanguage))
    || !['zh-CN', 'en-US'].includes(String(context.uiLocale)) || !Array.isArray(context.authorInputs)
    || typeof context.characterStates !== 'string' || typeof context.worldbuilding !== 'string'
    || !Array.isArray(context.history) || !Array.isArray(context.blueprints) || !context.frozenGoals
    || !Array.isArray(context.preflightFindings)
    || manifest?.reviewRevisionContextHash !== stored.contextHash || manifest.operation !== context.operation
    || JSON.stringify(manifest.authorInputs) !== JSON.stringify([{ id: 'review-revision-context', text: JSON.stringify(context) }])
    || (expected.kind === 'review' && (confirmation !== undefined
      || !validRecheckVersionPair || !isDeepStrictEqual(recheck, frozenRecheck)))
    || (expected.kind === 'revision' && (!expected.confirmation || !confirmation
      || Object.keys(confirmation).sort().join() !== 'content,originalReviewContentHash,reviewSourceId,snapshot'
      || confirmation.reviewSourceId !== expected.confirmation.reviewSourceId
      || confirmation.content !== expected.confirmation.content
      || confirmation.originalReviewContentHash !== expected.confirmation.originalReviewContentHash
      || !isDeepStrictEqual(confirmation.snapshot, expected.confirmation.snapshot)
      || recheck !== undefined))) return false
  const attempt = JSON.parse(row.attempt_json) as Record<string, unknown>
  const usage = JSON.parse(row.usage_receipt_json!) as Record<string, unknown>
  const result = usage.result as Record<string, unknown> | undefined
  if (!['settled', 'unknown'].includes(String(attempt.status)) || result?.finishReason !== 'stop' || result.failureCode !== undefined) return false
  const artifactRef = stored.artifact as Record<string, unknown> | undefined
  if (!artifactRef || Object.keys(artifactRef).sort().join() !== 'artifactId,revision,textHash'
    || !nonempty(artifactRef.artifactId) || !integer(artifactRef.revision) || !HASH.test(String(artifactRef.textHash))) return false
  const artifactRow = db.prepare(`SELECT artifact_id,attempt_id,run_id,artifact_json,revision,status
    FROM generation_artifacts WHERE artifact_id=?`).get(artifactRef.artifactId) as {
      artifact_id: string; attempt_id: string; run_id: string; artifact_json: string; revision: number; status: string
    } | undefined
  if (!artifactRow || artifactRow.attempt_id !== row.attempt_id || artifactRow.run_id !== row.run_id
    || artifactRow.revision !== artifactRef.revision || artifactRow.status === 'discarded') return false
  const artifact = JSON.parse(artifactRow.artifact_json) as Record<string, unknown>
  const identity = usage.artifactIdentity as Record<string, unknown> | undefined
  if (artifact.artifactId !== artifactRef.artifactId || artifact.attemptId !== row.attempt_id
    || artifact.rootActionId !== row.root_action_id || artifact.projectId !== binding.projectId || !nonempty(artifact.epoch)
    || artifact.revision !== artifactRef.revision || artifact.textHash !== artifactRef.textHash
    || typeof artifact.text !== 'string' || hash(artifact.text) !== artifact.textHash
    || JSON.stringify(artifact.fingerprint) !== JSON.stringify(binding.fingerprint)
    || identity?.artifactId !== artifact.artifactId || identity.epoch !== artifact.epoch
    || JSON.stringify(identity.fingerprint) !== JSON.stringify(artifact.fingerprint)) return false
  if (expected.kind === 'review') {
    const frozen = context as unknown as ReviewRevisionContext
    const rebuilt = JSON.stringify(expected.recheck
      ? (() => { const report = buildReviewCycleRecheckReport(artifact.text as string, frozen.source.content, expected.recheck!, frozen.uiLocale)
        return { summary: report.summary, items: report.items } })()
      : buildReviewGenerationReport({ content: artifact.text as string,
        sourceContent: frozen.source.content, frozenGoals: frozen.frozenGoals, writingLanguage: frozen.writingLanguage,
        uiLocale: frozen.uiLocale, preflightFindings: frozen.preflightFindings }), null, 2)
    if (hash(rebuilt) !== expected.contentHash) return false
  }
  if (expected.kind === 'revision') {
    const composition = usage.visibleComposition as Record<string, unknown> | undefined
    const sources = composition?.sources as unknown[] | undefined, artifactIds = composition?.artifactIds
    if (!HASH.test(String(stored.compositionHash)) || stored.compositionHash !== expected.contentHash
      || composition?.algorithm !== 'visible-append-v1' || composition.textHash !== stored.compositionHash
      || !Array.isArray(artifactIds) || artifactIds.length < 1 || artifactIds.length > 32
      || new Set(artifactIds).size !== artifactIds.length || artifactIds.at(-1) !== artifactRef.artifactId
      || !Array.isArray(sources) || JSON.stringify(sources.at(-1)) !== JSON.stringify(artifactRef)) return false
    let composed = '', previousOrdinal = -1
    const rebuiltSources: unknown[] = []
    for (const artifactId of artifactIds) {
      if (!nonempty(artifactId)) return false
      const candidate = db.prepare(`SELECT a.attempt_id,a.run_id,a.status,a.artifact_json,a.revision,t.rowid AS ordinal,
          t.attempt_json,t.usage_receipt_json FROM generation_artifacts a JOIN generation_attempts t ON t.attempt_id=a.attempt_id
          WHERE a.artifact_id=?`).get(artifactId) as { attempt_id: string; run_id: string; status: string; artifact_json: string;
            revision: number; ordinal: number; attempt_json: string; usage_receipt_json: string } | undefined
      if (!candidate || candidate.run_id !== row.run_id || candidate.status === 'discarded' || candidate.ordinal <= previousOrdinal) return false
      const visible = JSON.parse(candidate.artifact_json) as Record<string, unknown>
      const physical = JSON.parse(candidate.attempt_json) as Record<string, unknown>
      const candidateUsage = JSON.parse(candidate.usage_receipt_json) as Record<string, unknown>
      const candidateResult = candidateUsage.result as Record<string, unknown> | undefined
      const candidateIdentity = candidateUsage.artifactIdentity as Record<string, unknown> | undefined
      if (!['settled', 'unknown'].includes(String(physical.status)) || !['stop', 'length'].includes(String(candidateResult?.finishReason))
        || typeof visible.text !== 'string' || !visible.text.trim() || hash(visible.text) !== visible.textHash
        || visible.artifactId !== artifactId || visible.attemptId !== candidate.attempt_id || visible.rootActionId !== row.root_action_id
        || visible.projectId !== binding.projectId || !nonempty(visible.epoch) || visible.revision !== candidate.revision
        || JSON.stringify(visible.fingerprint) !== JSON.stringify(binding.fingerprint)
        || candidateIdentity?.artifactId !== artifactId || candidateIdentity.epoch !== visible.epoch
        || JSON.stringify(candidateIdentity.fingerprint) !== JSON.stringify(visible.fingerprint)) return false
      const next = rebuiltSources.length > 0 ? composeVisibleContinuation(composed, visible.text) : visible.text.trim()
      if (!next.trim() || (rebuiltSources.length > 0
        && (next.match(/[\p{L}\p{N}]/gu)?.length ?? 0) <= (composed.match(/[\p{L}\p{N}]/gu)?.length ?? 0))) return false
      composed = next; previousOrdinal = candidate.ordinal
      rebuiltSources.push({ artifactId, revision: visible.revision, textHash: visible.textHash })
    }
    if (hash(composed) !== stored.compositionHash || JSON.stringify(rebuiltSources) !== JSON.stringify(sources)) return false
  } else if (stored.compositionHash !== undefined) return false
  return true
}
function descriptor(row: FindingRow): M03FindingDescriptor {
  return { findingId: row.finding_id, source: { projectId: row.source_project_id, epoch: row.source_epoch,
    sourceId: row.source_id, revision: row.source_revision, contentHash: row.source_content_hash,
    span: row.span_start === null ? null : { start: row.span_start, end: row.span_end!, unit: 'utf16-code-unit' } },
  excerptHash: row.excerpt_hash, occurrence: row.occurrence, category: row.category,
  targetId: row.target_id, kind: row.kind as M03FindingDescriptor['kind'], problemText: row.problem_text,
  expectedText: row.expected_text, status: row.status as M03FindingDescriptor['status'],
  evidenceHash: row.evidence_hash, confirmationItemIndex: row.confirmation_item_index }
}

function exactSchema(db: Database.Database, table: string, columns: readonly string[], fragments: readonly string[]): boolean {
  const actual = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name)
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string } | undefined
  if (JSON.stringify(actual) !== JSON.stringify(columns) || !row) return false
  const compact = row.sql.replace(/\s/gu, '').toLowerCase()
  return fragments.every(fragment => compact.includes(fragment.replace(/\s/gu, '').toLowerCase()))
}

export function verifyM03ReviewCycle(db: Database.Database): boolean {
  try {
    if (db.pragma('foreign_keys', { simple: true }) !== 1 || (db.pragma('foreign_key_check') as unknown[]).length) return false
    const mergeTable = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_cycle_merges'").get())
    if (!mergeTable && Number(db.pragma('user_version', { simple: true })) >= 7) return false
    if (mergeTable && !exactSchema(db, 'review_cycle_merges', ['cycle_id', 'body'], [
      'cycle_id TEXT PRIMARY KEY REFERENCES review_cycles(cycle_id) ON DELETE CASCADE', 'body TEXT NOT NULL',
    ])) return false
    if (!exactSchema(db, 'review_cycles', ['cycle_id', 'root_action_id', 'review_id', 'review_content_hash', 'confirmation_review_id',
      'confirmation_content_hash', 'revision_id', 'source_hash', 'finding_set_hash', 'comparison_version', 'revision_status',
      'merged_hash', 'recheck_count', 'recheck_attempt_id'], [
      'root_action_id TEXT NOT NULL REFERENCES generation_roots(root_action_id)',
      'review_id INTEGER NOT NULL UNIQUE REFERENCES reviews(id) ON DELETE CASCADE', 'confirmation_review_id INTEGER UNIQUE REFERENCES reviews(id)',
      'revision_id INTEGER UNIQUE REFERENCES revisions(id)', 'recheck_attempt_id TEXT UNIQUE REFERENCES generation_attempts(attempt_id)',
      "CHECK(recheck_count IN (0,1))", "revision_status='merge-committed'",
    ]) || !exactSchema(db, 'review_findings', ['cycle_id', 'finding_id', 'source_project_id', 'source_epoch', 'source_id',
      'source_revision', 'source_content_hash', 'span_start', 'span_end', 'span_unit', 'excerpt_hash', 'occurrence', 'category',
      'target_id', 'kind', 'problem_text', 'expected_text', 'status', 'evidence_hash', 'confirmation_item_index'], [
      'cycle_id TEXT NOT NULL REFERENCES review_cycles(cycle_id) ON DELETE CASCADE',
      "status IN ('unverified','author-waived')", "span_unit='utf16-code-unit'", "status='author-waived'",
    ])) return false
    const cycles = db.prepare('SELECT * FROM review_cycles ORDER BY cycle_id').all() as CycleRow[]
    const snapshots = mergeTable ? new Map((db.prepare('SELECT cycle_id,body FROM review_cycle_merges').all() as Array<{
      cycle_id: string; body: string }>).map(row => [row.cycle_id, row.body])) : null
    if (snapshots && (snapshots.size !== cycles.filter(cycle => cycle.revision_status === 'merge-committed').length
      || cycles.some(cycle => cycle.revision_status !== 'merge-committed' && snapshots.has(cycle.cycle_id)))) return false
    for (const cycle of cycles) {
      if (!nonempty(cycle.cycle_id) || !nonempty(cycle.root_action_id) || !integer(cycle.review_id, 1)
        || !HASH.test(cycle.review_content_hash) || !HASH.test(cycle.source_hash) || !HASH.test(cycle.finding_set_hash)
        || !integer(cycle.comparison_version, 1) || !CYCLE_STATUSES.has(cycle.revision_status)
        || !integer(cycle.recheck_count) || cycle.recheck_count > 1) return false
      const review = db.prepare(`SELECT r.id,r.base_draft_id,r.source_draft_chapter_number,r.source_draft_version,
          r.source_draft_status,r.source_content,c.body
        FROM reviews r JOIN contents c ON c.id=r.content_id WHERE r.id=?`).get(cycle.review_id) as ReviewRow | undefined
      if (!review || !integer(review.source_draft_chapter_number, 1) || !integer(review.source_draft_version, 1)
        || !nonempty(review.source_draft_status) || review.source_content === null || hash(review.body) !== cycle.review_content_hash
        || hash(review.source_content) !== cycle.source_hash) return false
      const root = db.prepare('SELECT action_json FROM generation_roots WHERE root_action_id=?').get(cycle.root_action_id) as { action_json: string } | undefined
      const action = root && JSON.parse(root.action_json) as Record<string, unknown>
      if (!action || !nonempty(action.projectId) || !nonempty(action.epoch)) return false
      const attempts = db.prepare(`SELECT a.attempt_id,a.run_id,a.root_action_id,r.root_action_id AS run_root_action_id,
          r.binding_json,a.attempt_json,a.usage_receipt_json
        FROM generation_attempts a JOIN generation_runs r ON r.run_id=a.run_id WHERE a.root_action_id=? ORDER BY a.rowid`)
        .all(cycle.root_action_id) as AttemptRow[]
      if (attempts.some(row => { const binding = JSON.parse(row.binding_json) as Record<string, unknown>
        return row.run_root_action_id !== cycle.root_action_id || binding.projectId !== action.projectId || !nonempty(binding.epoch) })) return false
      const reviewIndex = Number(db.prepare('SELECT review_index FROM reviews WHERE id=?').pluck().get(cycle.review_id))
      const reviewAttempts = attempts.filter(row => proveEffect(db, row, { kind: 'review', id: cycle.review_id,
        index: reviewIndex, contentHash: cycle.review_content_hash, source: { id: review.base_draft_id,
          chapterNumber: review.source_draft_chapter_number!, version: review.source_draft_version!,
          status: review.source_draft_status!, content: review.source_content! } }))
      if (reviewAttempts.length !== 1) return false
      const reviewBinding = JSON.parse(reviewAttempts[0]!.binding_json) as Record<string, unknown>

      let confirmation: { body: string; snapshot: HumanConfirmedReviewSnapshot } | null = null
      if (cycle.confirmation_review_id !== null) {
        const row = db.prepare('SELECT r.source_content,c.body FROM reviews r JOIN contents c ON c.id=r.content_id WHERE r.id=? AND r.base_draft_id=?')
          .get(cycle.confirmation_review_id, review.base_draft_id) as { source_content: string | null; body: string } | undefined
        if (!row || !cycle.confirmation_content_hash || hash(row.body) !== cycle.confirmation_content_hash) return false
        const snapshot = parseHumanConfirmedReviewSnapshot(row.body)
        const sourceDraft = snapshot?.sourceDraft
        if (!snapshot || snapshot.sourceReviewId !== cycle.review_id
          || row.source_content === null || hash(row.source_content) !== cycle.source_hash
          || !sourceDraft || sourceDraft.id !== review.base_draft_id || sourceDraft.version !== review.source_draft_version
          || typeof sourceDraft.content !== 'string' || hash(sourceDraft.content) !== cycle.source_hash) return false
        confirmation = { body: row.body, snapshot }
      } else if (cycle.confirmation_content_hash !== null) return false

      let revision: RevisionRow | undefined
      if (cycle.revision_id !== null) {
        revision = db.prepare(`SELECT r.id,r.base_draft_id,r.review_source_id,r.source_draft_chapter_number,r.source_draft_version,
          r.source_draft_status,r.source_content,r.status,r.merged_to_draft_id,c.body
          FROM revisions r JOIN contents c ON c.id=r.content_id WHERE r.id=?`).get(cycle.revision_id) as RevisionRow | undefined
        if (!revision || !confirmation || revision.base_draft_id !== review.base_draft_id
          || revision.review_source_id !== cycle.confirmation_review_id || revision.source_content === null
          || revision.source_draft_chapter_number !== review.source_draft_chapter_number
          || revision.source_draft_version !== review.source_draft_version || revision.source_draft_status !== review.source_draft_status
          || revision.source_content !== review.source_content || hash(revision.source_content) !== cycle.source_hash) return false
        const revisionHash = hash(revision.body)
        const revisionIndex = Number(db.prepare('SELECT revision_index FROM revisions WHERE id=?').pluck().get(cycle.revision_id))
        const revisionAttempts = attempts.filter(row => proveEffect(db, row, { kind: 'revision', id: cycle.revision_id!,
          index: revisionIndex, contentHash: revisionHash, source: { id: review.base_draft_id,
            chapterNumber: review.source_draft_chapter_number!, version: review.source_draft_version!,
            status: review.source_draft_status!, content: review.source_content! },
          confirmation: { reviewSourceId: cycle.confirmation_review_id!, content: confirmation.body,
            originalReviewContentHash: cycle.review_content_hash, snapshot: confirmation.snapshot } }))
        if (revisionAttempts.length !== 1) return false
      }
      if (cycle.revision_status === 'not-generated' && (revision || cycle.merged_hash !== null || cycle.recheck_count !== 0 || cycle.recheck_attempt_id !== null)) return false
      if (cycle.revision_status === 'generated' && (!revision || revision.status !== 'pending'
        || cycle.merged_hash !== null || cycle.recheck_count !== 0 || cycle.recheck_attempt_id !== null)) return false
      const recheckEvidence = new Map<string, { targetId: string; evidenceHash: string; resolved: boolean }>()
      const recheckEligible = new Set<string>()
      const recheckTargets = new Map<string, string>()
      if (cycle.revision_status === 'merge-committed') {
        if (!revision || revision.status !== 'merged' || revision.merged_to_draft_id !== revision.base_draft_id
          || revision.base_draft_id !== review.base_draft_id || !cycle.merged_hash || !HASH.test(cycle.merged_hash)) return false
        const merged = snapshots ? { body: snapshots.get(cycle.cycle_id) } : db.prepare('SELECT c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.id=?')
          .get(revision.merged_to_draft_id) as { body: string } | undefined
        if (!merged || typeof merged.body !== 'string' || hash(merged.body) !== cycle.merged_hash) return false
        const mergedBody = merged.body
        if (cycle.recheck_count === 1) {
          const recheck = attempts.find(row => row.attempt_id === cycle.recheck_attempt_id)
          const recheckEffect = recheck && effect(recheck)
          if (!recheckEffect || recheckEffect.kind !== 'review' || !integer(recheckEffect.id, 1)) return false
          const recheckReview = db.prepare('SELECT r.source_content,c.body FROM reviews r JOIN contents c ON c.id=r.content_id WHERE r.id=?')
            .get(recheckEffect.id) as { source_content: string | null; body: string } | undefined
          const recheckMeta = db.prepare(`SELECT base_draft_id,review_index,source_draft_chapter_number,source_draft_version,
              source_draft_status FROM reviews WHERE id=?`).get(recheckEffect.id) as { base_draft_id: number; review_index: number;
                source_draft_chapter_number: number | null; source_draft_version: number | null; source_draft_status: string | null } | undefined
          const mergedDraft = db.prepare('SELECT chapter_number,version,status FROM drafts WHERE id=?').get(review.base_draft_id) as {
            chapter_number: number; version: number; status: string } | undefined
          const recheckFindings = db.prepare(`SELECT finding_id,target_id,category,kind,problem_text,expected_text,status,span_start,span_end,span_unit,occurrence
            FROM review_findings WHERE cycle_id=? ORDER BY finding_id`).all(cycle.cycle_id) as Array<{
              finding_id: string; target_id: string | null; category: string; kind: 'objective' | 'literary'
              problem_text: string; expected_text: string | null; status: string
              span_start: number | null; span_end: number | null; span_unit: string | null; occurrence: number | null
            }>
          const eligible: ReviewCycleRecheckFinding[] = recheckFindings.flatMap(finding => {
            if (finding.status === 'unverified' || finding.status === 'author-waived' || finding.target_id === null
              || finding.span_start === null || finding.span_end === null || finding.span_unit !== 'utf16-code-unit'
              || finding.occurrence === null) return []
            const value: ReviewCycleRecheckFinding = { findingId: finding.finding_id, targetId: finding.target_id,
              category: finding.category, kind: finding.kind,
              problem: finding.problem_text, ...(finding.expected_text ? { expected: finding.expected_text } : {}),
              sourceSpan: { start: finding.span_start, end: finding.span_end, unit: 'utf16-code-unit' }, occurrence: finding.occurrence,
              sourceExcerpt: review.source_content!.slice(finding.span_start, finding.span_end) }
            return classifyFindingEvidenceChange(review.source_content!, mergedBody, value) === 'changed' ? [value] : []
          })
          for (const finding of eligible) {
            recheckEligible.add(finding.findingId)
            recheckTargets.set(finding.findingId, finding.targetId)
          }
          const usage = JSON.parse(recheck.usage_receipt_json!) as Record<string, unknown>
          const receipt = usage.reviewCycleRecheck as Record<string, unknown> | undefined
          if (!receipt || (receipt.version !== 1 && receipt.version !== 2)) return false
          const expectedRecheck: ReviewCycleRecheckContext = { version: receipt.version, cycleId: cycle.cycle_id,
            comparisonVersion: cycle.comparison_version, mergedHash: cycle.merged_hash,
            findingSetHash: cycle.finding_set_hash, findings: eligible }
          if (!recheckReview || !recheckMeta || !mergedDraft || recheckMeta.base_draft_id !== review.base_draft_id
            || recheckMeta.source_draft_chapter_number !== mergedDraft.chapter_number || recheckMeta.source_draft_version !== mergedDraft.version
            || recheckMeta.source_draft_status !== 'revised' || recheckReview.source_content === null
            || hash(recheckReview.source_content) !== cycle.merged_hash
            || !proveEffect(db, recheck, { kind: 'review', id: recheckEffect.id as number, index: recheckMeta.review_index,
              contentHash: hash(recheckReview.body), source: { id: review.base_draft_id, chapterNumber: mergedDraft.chapter_number,
                version: mergedDraft.version, status: recheckMeta.source_draft_status, content: recheckReview.source_content },
              recheck: expectedRecheck })) return false
          const report = JSON.parse(recheckReview.body) as { items?: unknown[] }
          if (receipt.cycleId !== cycle.cycle_id
            || receipt.comparisonVersion !== cycle.comparison_version || receipt.mergedHash !== cycle.merged_hash
            || receipt.findingSetHash !== cycle.finding_set_hash || !Array.isArray(receipt.findings)
            || !Array.isArray(report.items)) return false
          const receiptFindings = receipt.findings as Record<string, unknown>[]
          const seenReviewItems = new Set<number>()
          for (const item of receiptFindings) {
            const reportItem = integer(item?.reviewItemIndex) ? record(report.items[item.reviewItemIndex as number]) : null
            if (!item || !nonempty(item.findingId) || !nonempty(item.targetId) || !integer(item.reviewItemIndex)
              || item.reviewItemIndex >= report.items.length || typeof item.resolved !== 'boolean'
              || receipt.version === 2 && item.resolved === true
              || recheckTargets.get(item.findingId) !== item.targetId || reportItem?.resolved !== item.resolved
              || !HASH.test(String(item.evidenceHash)) || seenReviewItems.has(item.reviewItemIndex)
              || recheckEvidence.has(item.findingId)) return false
            const evidenceHash = hash(JSON.stringify({ findingId: item.findingId, targetId: item.targetId,
              reviewItemIndex: item.reviewItemIndex, item: report.items[item.reviewItemIndex], resolved: item.resolved }))
            if (item.evidenceHash !== evidenceHash) return false
            seenReviewItems.add(item.reviewItemIndex)
            recheckEvidence.set(item.findingId, { targetId: item.targetId, evidenceHash, resolved: item.resolved })
          }
          if (receiptFindings.length !== recheckEvidence.size) return false
        } else if (cycle.recheck_attempt_id !== null) return false
      }

      const findings = db.prepare('SELECT * FROM review_findings WHERE cycle_id=? ORDER BY finding_id').all(cycle.cycle_id) as FindingRow[]
      if (canonicalM03FindingSetHash(findings.map(descriptor)) !== cycle.finding_set_hash) return false
      const seenAnchors = new Set<string>()
      for (const finding of findings) {
        if (!nonempty(finding.finding_id) || !nonempty(finding.source_project_id) || !nonempty(finding.source_epoch)
          || !nonempty(finding.source_id) || !integer(finding.source_revision) || !HASH.test(finding.source_content_hash)
          || finding.source_project_id !== action.projectId || finding.source_epoch !== reviewBinding.epoch
          || finding.source_id !== `draft:${review.base_draft_id}` || finding.source_revision !== review.source_draft_version
          || finding.source_content_hash !== cycle.source_hash || !nonempty(finding.category) || !nonempty(finding.problem_text)
          || finding.expected_text !== null && !nonempty(finding.expected_text)
          || !FINDING_KINDS.has(finding.kind) || !FINDING_STATUSES.has(finding.status)) return false
        const emptyAnchor = finding.span_start === null && finding.span_end === null && finding.span_unit === null
          && finding.excerpt_hash === null && finding.occurrence === null && finding.target_id === null
        if (finding.status === 'unverified' || finding.status === 'author-waived' && emptyAnchor) {
          if (!emptyAnchor || finding.status === 'unverified'
            && (finding.evidence_hash !== null || finding.confirmation_item_index !== null)) return false
        } else {
          if (!integer(finding.span_start) || !integer(finding.span_end, 1) || finding.span_end <= finding.span_start
            || finding.span_end > review.source_content.length || finding.span_unit !== 'utf16-code-unit'
            || !finding.excerpt_hash || !HASH.test(finding.excerpt_hash)
            || hash(review.source_content.slice(finding.span_start, finding.span_end)) !== finding.excerpt_hash
            || !integer(finding.occurrence, 1) || !nonempty(finding.target_id)) return false
          const anchor = JSON.stringify([finding.source_content_hash, { start: finding.span_start, end: finding.span_end, unit: finding.span_unit },
            finding.occurrence, finding.excerpt_hash, finding.category, finding.target_id])
          if (seenAnchors.has(anchor)) return false
          seenAnchors.add(anchor)
          const excerpt = review.source_content.slice(finding.span_start, finding.span_end)
          let occurrence = 0
          for (let offset = 0; offset <= finding.span_start;) {
            const located = review.source_content.indexOf(excerpt, offset)
            if (located < 0 || located > finding.span_start) break
            occurrence += 1
            offset = located + Math.max(1, excerpt.length)
          }
          if (occurrence !== finding.occurrence) return false
        }
        if (finding.evidence_hash !== null && !HASH.test(finding.evidence_hash)) return false
        if (recheckEligible.has(finding.finding_id)) {
          const candidateEvidence = recheckEvidence.get(finding.finding_id)
          const evidence = candidateEvidence?.targetId === finding.target_id ? candidateEvidence : undefined
          const expectedStatus = evidence ? evidence.resolved ? 'resolved' : 'unresolved' : 'unknown'
          if (finding.status !== expectedStatus
            || evidence && evidence.evidenceHash !== finding.evidence_hash
            || !evidence && finding.evidence_hash !== null) return false
        }
        if (finding.status === 'resolved') {
          const evidence = recheckEvidence.get(finding.finding_id)
          if (cycle.recheck_count !== 1 || !finding.evidence_hash || !evidence || !evidence.resolved
            || evidence.targetId !== finding.target_id || evidence.evidenceHash !== finding.evidence_hash) return false
        }
        if (finding.status === 'author-waived') {
          if (!confirmation || finding.evidence_hash !== cycle.confirmation_content_hash
            || !integer(finding.confirmation_item_index)) return false
          const item = (confirmation.snapshot.items as unknown[])[finding.confirmation_item_index]
          if (confirmation.snapshot.schemaVersion !== 2 || confirmation.snapshot.cycleId !== cycle.cycle_id
            || !item || typeof item !== 'object' || (item as Record<string, unknown>).findingId !== finding.finding_id
            || (item as Record<string, unknown>).decision !== 'waive') return false
        } else if (finding.confirmation_item_index !== null) return false
      }
    }
    return true
  } catch { return false }
}

export function createM03Migration(deps: {
  database: (reader: SchemaReader) => Database.Database
  verifyKnownSchema: (reader: SchemaReader) => boolean
}): MigrationImplementation {
  return { id: 'M03', from: 3, to: 4, owner: 'S11', migrate: reader => applyM03ReviewCycle(deps.database(reader)),
    verify: reader => deps.verifyKnownSchema(reader) && verifyM03ReviewCycle(deps.database(reader)) }
}

export function createM06Migration(deps: {
  database: (reader: SchemaReader) => Database.Database
  verifyKnownSchema: (reader: SchemaReader) => boolean
}): MigrationImplementation {
  return { id: 'M06', from: 6, to: 7, owner: 'S11', migrate: reader => applyM06ReviewCycleMerge(deps.database(reader)),
    verify: reader => deps.verifyKnownSchema(reader) && verifyM03ReviewCycle(deps.database(reader)) }
}
