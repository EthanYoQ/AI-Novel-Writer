import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { buildReviewGenerationReport } from '../../../src/shared/review-generation-report'
import type { FrozenChapterGoals } from '../../../src/shared/chapter-goal-review'
import type { ConsistencyFinding } from '../../../src/shared/consistency-preflight'
import { buildReviewCycleRecheckReport, type ReviewCycleRecheckContext } from '../../../src/shared/review-cycle'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { M01_GENERATION_SQL } from '../../migrations/m01-generation-runs'
import {
  applyM03ReviewCycle,
  applyM06ReviewCycleMerge,
  canonicalM03FindingSetHash,
  verifyM03ReviewCycle,
} from '../../migrations/m03-review-cycle'
import { RevisionRepository } from '../revision-repository'
import {
  ReviewCycleRepository,
  type AttachGeneratedRevisionInput,
  type CreateReviewCycleInput,
} from '../review-cycle-repository'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

function fixture() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys=ON')
  db.transaction(() => {
    initializeLegacyBaselineSchema(db); db.exec(M01_GENERATION_SQL)
    applyM03ReviewCycle(db); applyM06ReviewCycleMerge(db)
  })()
  return db
}

const defaultGoals: FrozenChapterGoals = { chapterNumber: 1, coverage: 'complete',
  items: [{ id: 'goal-pass', text: '完成开场' }] }
const defaultModel = { summary: '审稿完成', items: [{ category: '文风', severity: 'pass', description: '通过' }],
  goalReviews: [{ id: 'goal-pass', status: 'completed', description: '已经完成', evidence: [{ quote: '开场' }] }] }

interface SeedOptions {
  key?: string
  source?: string
  sourceStatus?: 'draft' | 'revised'
  existingDraftId?: number
  model?: Record<string, unknown>
  frozenGoals?: FrozenChapterGoals
  preflight?: readonly ConsistencyFinding[]
  corruptBody?: string
  effect?: 'valid' | 'none' | 'wrong-effect' | 'wrong-artifact'
}

function seed(db: import('better-sqlite3').Database, options: SeedOptions = {}): {
  call: CreateReviewCycleInput
  reviewId: number
  source: string
  sourceStatus: 'draft' | 'revised'
  draftId: number
  reviewBody: string
  frozenGoals: FrozenChapterGoals
  preflight: readonly ConsistencyFinding[]
} {
  const key = options.key ?? 'review'
  const source = options.source ?? '开场😀目标完成，预检证据，重复，重复。'
  const sourceStatus = options.sourceStatus ?? 'draft'
  const frozenGoals = options.frozenGoals ?? defaultGoals
  const preflight = options.preflight ?? []
  const modelContent = JSON.stringify(options.model ?? defaultModel)
  const generatedBody = JSON.stringify(buildReviewGenerationReport({ content: modelContent, sourceContent: source,
    frozenGoals, writingLanguage: 'zh-CN', uiLocale: 'zh-CN', preflightFindings: preflight }), null, 2)
  const body = options.corruptBody ?? generatedBody
  const sourceContentId = options.existingDraftId === undefined
    ? Number(db.prepare('INSERT INTO contents(body) VALUES(?)').run(source).lastInsertRowid) : null
  const draftId = options.existingDraftId ?? Number(db.prepare(`INSERT INTO drafts(chapter_number,version,status,content_id)
    VALUES(1,1,'draft',?)`).run(sourceContentId).lastInsertRowid)
  const reviewContentId = Number(db.prepare('INSERT INTO contents(body) VALUES(?)').run(body).lastInsertRowid)
  const reviewIndex = Number(db.prepare('SELECT COALESCE(MAX(review_index),0)+1 FROM reviews WHERE base_draft_id=?')
    .pluck().get(draftId))
  const reviewId = Number(db.prepare(`INSERT INTO reviews(base_draft_id,review_index,source_draft_chapter_number,
    source_draft_version,source_draft_status,source_content,content_id) VALUES(?,?,1,1,?,?,?)`)
    .run(draftId, reviewIndex, sourceStatus, source, reviewContentId).lastInsertRowid)
  const rootActionId = `root-${key}`
  const action = { rootActionId, projectId: 'project', epoch: 'epoch', operation: 'review-chapter',
    uiActionNonce: `nonce-${key}`, frozenInputHash: hash(`frozen-${key}`), status: 'active' }
  db.prepare('INSERT INTO generation_roots(root_action_id,idempotency_key,action_json,budget_json) VALUES(?,?,?,?)')
    .run(rootActionId, `root-key-${key}`, JSON.stringify(action), '{}')

  if (options.effect !== 'none') {
    const attemptId = `attempt-${key}`
    const runId = `run-${key}`
    const artifactId = `artifact-${key}`
    const context = { version: 1, operation: 'review-chapter', sourceHash: hash(source),
      source: { id: draftId, chapterNumber: 1, version: 1, status: sourceStatus, content: source }, config: {},
      writingLanguage: 'zh-CN', uiLocale: 'zh-CN', authorInputs: [], characterStates: '（暂无）', worldbuilding: '',
      history: [], blueprints: [], frozenGoals, preflightFindings: preflight }
    const contextHash = hash(JSON.stringify(context))
    const fingerprint = Object.fromEntries(['chapterBriefHash', 'authorGuidanceHash', 'dependencyHash', 'contextSnapshotHash',
      'templateHash', 'skillSnapshotHash', 'modelLeaseRevision', 'policyHash', 'outputContractHash']
      .map((name, index) => [name, hash(`fingerprint:${key}:${index}`)]))
    const binding = { projectId: 'project', epoch: 'epoch', fingerprint, contextSnapshotId: `context-${key}`,
      sourceManifest: { operation: 'review-chapter', reviewRevisionContext: context,
        reviewRevisionContextHash: contextHash,
        authorInputs: [{ id: 'review-revision-context', text: JSON.stringify(context) }] }, sourceRefs: [] }
    db.prepare('INSERT INTO generation_runs(run_id,root_action_id,binding_json,status,created_at_ms,open_key) VALUES(?,?,?,?,?,?)')
      .run(runId, rootActionId, JSON.stringify(binding), 'completed', 1, `open-${key}`)
    const artifact = { artifactId, attemptId, rootActionId, projectId: 'project', epoch: 'epoch', fingerprint,
      revision: 1, text: modelContent, textHash: options.effect === 'wrong-artifact' ? hash('wrong') : hash(modelContent) }
    const artifactRef = { artifactId, revision: 1, textHash: artifact.textHash }
    const usage = { artifactIdentity: { artifactId, epoch: 'epoch', fingerprint }, result: { usage: null, finishReason: 'stop' },
      reviewRevisionEffect: { kind: 'review', id: reviewId, index: reviewIndex,
        contentHash: options.effect === 'wrong-effect' ? hash('wrong') : hash(body), contextHash, artifact: artifactRef } }
    db.prepare(`INSERT INTO generation_attempts(attempt_id,reservation_id,run_id,root_action_id,attempt_json,
      usage_receipt_json,invocation_nonce) VALUES(?,?,?,?,?,?,?)`).run(attemptId, `reservation-${key}`, runId, rootActionId,
      JSON.stringify({ attemptId, reservationId: `reservation-${key}`, rootActionId, status: 'settled', reservedTokens: 100,
        requestedOutputTokens: 100, actualTokens: 1 }), JSON.stringify(usage), `invocation-${key}`)
    db.prepare('INSERT INTO generation_artifacts(artifact_id,attempt_id,run_id,artifact_json,revision,status) VALUES(?,?,?,?,?,?)')
      .run(artifactId, attemptId, runId, JSON.stringify(artifact), 1, 'partial')
  }

  return { reviewId, source, sourceStatus, draftId, reviewBody: body, frozenGoals, preflight,
    call: { rootActionId, reviewId, reviewContentHash: hash(body), source: {
    projectId: 'project', epoch: 'epoch', sourceId: `draft:${draftId}`, revision: 1, contentHash: hash(source),
  } } }
}

function create(db: import('better-sqlite3').Database, input: CreateReviewCycleInput) {
  return db.transaction(() => ReviewCycleRepository.create(input, db))()
}

function seedRevision(db: import('better-sqlite3').Database, base: ReturnType<typeof seed>, options: {
  key?: string
  revisionContent?: string
  effect?: 'valid' | 'wrong-composition' | 'different-root'
  replacePending?: boolean
  snapshot?: Record<string, unknown>
} = {}): { attach: AttachGeneratedRevisionInput; confirmationId: number; revisionId: number } {
  const key = options.key ?? 'revision'
  const revisionContent = options.revisionContent ?? `${base.source}\n修稿补充。`
  const snapshot = options.snapshot ?? { kind: 'human-confirmed-review', schemaVersion: 1, sourceReviewId: base.reviewId,
    sourceDraft: { id: base.draftId, chapterNumber: 1, version: 1, status: base.sourceStatus, content: base.source },
    summary: '作者确认', authorGuidance: '', items: [{ category: '连续性', severity: 'warning',
      description: '本次忽略', decision: 'ignore', origin: 'ai' }] }
  const confirmationBody = JSON.stringify(snapshot, null, 2)
  const confirmationContentId = Number(db.prepare('INSERT INTO contents(body) VALUES(?)').run(confirmationBody).lastInsertRowid)
  const confirmationIndex = Number(db.prepare('SELECT COALESCE(MAX(review_index),0)+1 FROM reviews WHERE base_draft_id=?')
    .pluck().get(base.draftId))
  const confirmationId = Number(db.prepare(`INSERT INTO reviews(base_draft_id,review_index,source_draft_chapter_number,
    source_draft_version,source_draft_status,source_content,content_id) VALUES(?,?,1,1,?,?,?)`)
    .run(base.draftId, confirmationIndex, base.sourceStatus, base.source, confirmationContentId).lastInsertRowid)
  const revision = options.replacePending === false ? (() => {
    const revisionIndex = Number(db.prepare('SELECT COALESCE(MAX(revision_index),0)+1 FROM revisions WHERE base_draft_id=?')
      .pluck().get(base.draftId))
    const contentId = Number(db.prepare('INSERT INTO contents(body) VALUES(?)').run(revisionContent).lastInsertRowid)
    const id = Number(db.prepare(`INSERT INTO revisions(base_draft_id,revision_index,revision_type,status,user_prompt,
      review_source_id,source_draft_chapter_number,source_draft_version,source_draft_status,source_content,content_id,word_count)
      VALUES(?,?,'review-fix','pending','',?,1,1,?,?,?,?)`)
      .run(base.draftId, revisionIndex, confirmationId, base.sourceStatus, base.source, contentId, revisionContent.length).lastInsertRowid)
    return { id, revisionIndex }
  })() : RevisionRepository.replacePending({ baseDraftId: base.draftId, revisionType: 'review-fix',
    reviewSourceId: confirmationId, content: revisionContent, wordCount: revisionContent.length,
    expectedSource: { id: base.draftId, chapterNumber: 1, version: 1, status: base.sourceStatus, content: base.source } }, db)

  const rootActionId = options.effect === 'different-root' ? `${base.call.rootActionId}-other-${key}` : base.call.rootActionId
  if (rootActionId !== base.call.rootActionId) {
    db.prepare('INSERT INTO generation_roots(root_action_id,idempotency_key,action_json,budget_json) VALUES(?,?,?,?)')
      .run(rootActionId, `other-root-key-${key}`, JSON.stringify({ rootActionId, projectId: 'project', epoch: 'epoch',
        operation: 'refine-from-review', uiActionNonce: `other-${key}`, frozenInputHash: hash(`other-${key}`), status: 'active' }), '{}')
  }
  const attemptId = `attempt-${key}`
  const runId = `run-${key}`
  const artifactId = `artifact-${key}`
  const context = { version: 1, operation: 'refine-from-review', sourceHash: hash(base.source),
    source: { id: base.draftId, chapterNumber: 1, version: 1, status: base.sourceStatus, content: base.source }, config: {},
    writingLanguage: 'zh-CN', uiLocale: 'zh-CN', authorInputs: [], characterStates: '（暂无）', worldbuilding: '',
    history: [], blueprints: [], frozenGoals: base.frozenGoals, preflightFindings: base.preflight,
    confirmation: { reviewSourceId: confirmationId, content: confirmationBody,
      originalReviewContentHash: hash(base.reviewBody), snapshot } }
  const contextHash = hash(JSON.stringify(context))
  const fingerprint = Object.fromEntries(['chapterBriefHash', 'authorGuidanceHash', 'dependencyHash', 'contextSnapshotHash',
    'templateHash', 'skillSnapshotHash', 'modelLeaseRevision', 'policyHash', 'outputContractHash']
    .map((name, index) => [name, hash(`revision-fingerprint:${key}:${index}`)]))
  const binding = { projectId: 'project', epoch: 'epoch', fingerprint, contextSnapshotId: `revision-context-${key}`,
    sourceManifest: { operation: 'refine-from-review', reviewRevisionContext: context,
      reviewRevisionContextHash: contextHash,
      authorInputs: [{ id: 'review-revision-context', text: JSON.stringify(context) }] }, sourceRefs: [] }
  db.prepare('INSERT INTO generation_runs(run_id,root_action_id,binding_json,status,created_at_ms,open_key) VALUES(?,?,?,?,?,?)')
    .run(runId, rootActionId, JSON.stringify(binding), 'completed', 2, `open-${key}`)
  const contentHash = hash(revisionContent)
  const artifact = { artifactId, attemptId, rootActionId, projectId: 'project', epoch: 'epoch', fingerprint,
    revision: 1, text: revisionContent, textHash: contentHash }
  const artifactRef = { artifactId, revision: 1, textHash: contentHash }
  const visibleComposition = { algorithm: 'visible-append-v1',
    textHash: options.effect === 'wrong-composition' ? hash('wrong-composition') : contentHash,
    artifactIds: [artifactId], sources: [artifactRef] }
  const usage = { artifactIdentity: { artifactId, epoch: 'epoch', fingerprint }, result: { usage: null, finishReason: 'stop' },
    visibleComposition, reviewRevisionEffect: { kind: 'revision', id: revision.id, index: revision.revisionIndex,
      contentHash, compositionHash: contentHash, contextHash, artifact: artifactRef } }
  db.prepare(`INSERT INTO generation_attempts(attempt_id,reservation_id,run_id,root_action_id,attempt_json,
    usage_receipt_json,invocation_nonce) VALUES(?,?,?,?,?,?,?)`).run(attemptId, `reservation-${key}`, runId, rootActionId,
    JSON.stringify({ attemptId, reservationId: `reservation-${key}`, rootActionId, status: 'settled', reservedTokens: 100,
      requestedOutputTokens: 100, actualTokens: 1 }), JSON.stringify(usage), `invocation-${key}`)
  db.prepare('INSERT INTO generation_artifacts(artifact_id,attempt_id,run_id,artifact_json,revision,status) VALUES(?,?,?,?,?,?)')
    .run(artifactId, attemptId, runId, JSON.stringify(artifact), 1, 'partial')
  return { confirmationId, revisionId: revision.id, attach: { cycleId: '', rootActionId: base.call.rootActionId,
    confirmationReviewId: confirmationId, confirmationContentHash: hash(confirmationBody), revisionId: revision.id,
    revisionContentHash: contentHash } }
}

function seedConfirmation(db: import('better-sqlite3').Database, base: ReturnType<typeof seed>,
  snapshot: Record<string, unknown>): { id: number; body: string } {
  const body = JSON.stringify(snapshot, null, 2)
  const contentId = Number(db.prepare('INSERT INTO contents(body) VALUES(?)').run(body).lastInsertRowid)
  const reviewIndex = Number(db.prepare('SELECT COALESCE(MAX(review_index),0)+1 FROM reviews WHERE base_draft_id=?')
    .pluck().get(base.draftId))
  const id = Number(db.prepare(`INSERT INTO reviews(base_draft_id,review_index,source_draft_chapter_number,
    source_draft_version,source_draft_status,source_content,content_id) VALUES(?,?,1,1,'draft',?,?)`)
    .run(base.draftId, reviewIndex, base.source, contentId).lastInsertRowid)
  return { id, body }
}

function risk(stableFactKey: string, evidence: string): ConsistencyFinding {
  return { stableFactKey, severity: 'warning', sourceChapter: 1, evidence,
    issue: { zhCN: '事实冲突', enUS: 'Fact conflict' }, suggestion: { zhCN: '请核实', enUS: 'Verify' } }
}

function generatedCycle(db: import('better-sqlite3').Database, key: string, sameDraft?: ReturnType<typeof seed>,
  options: SeedOptions = {}) {
  const seeded = seed(db, { ...options, key: `review-${key}`, ...(sameDraft
    ? { source: sameDraft.source, existingDraftId: sameDraft.draftId } : {}) })
  const cycle = create(db, seeded.call)
  const revision = seedRevision(db, seeded, { key: `revision-${key}`, replacePending: !sameDraft })
  revision.attach.cycleId = cycle.cycleId
  db.transaction(() => ReviewCycleRepository.attachGeneratedRevision(revision.attach, db))()
  return { seeded, cycle, revision }
}

function mergeRows(db: import('better-sqlite3').Database, item: ReturnType<typeof generatedCycle>, mergedContent: string): string {
  const contentId = db.prepare('SELECT content_id FROM drafts WHERE id=?').pluck().get(item.seeded.draftId) as number
  db.prepare('UPDATE contents SET body=? WHERE id=?').run(mergedContent, contentId)
  db.prepare("UPDATE drafts SET status='revised',word_count=? WHERE id=?")
    .run(mergedContent.length, item.seeded.draftId)
  db.prepare("UPDATE revisions SET status='merged',merged_to_draft_id=? WHERE id=?")
    .run(item.seeded.draftId, item.revision.revisionId)
  return hash(mergedContent)
}

function mergedFindingCycle(db: import('better-sqlite3').Database, key: string, mergedContent: string) {
  const item = generatedCycle(db, key, undefined, { source: '开场时门闩松动，主角立即停步。',
    preflight: [risk('fact:door-latch', '门闩松动')] })
  const mergedHash = mergeRows(db, item, mergedContent)
  db.transaction(() => ReviewCycleRepository.commitMergedRevision({ revisionId: item.revision.revisionId, mergedHash }, db))()
  return { ...item, mergedContent, mergedHash }
}

function seedRecheckAttempt(db: import('better-sqlite3').Database, item: ReturnType<typeof mergedFindingCycle>,
  context: ReviewCycleRecheckContext, input: { key: string; rootActionId?: string; mappings: Array<{
    findingId: string; targetId: string; reviewItemIndex: number; resolved: boolean; evidenceHash?: string
  }> }): { attemptId: string; reviewId: number } {
  const { key } = input
  const rootActionId = input.rootActionId ?? item.seeded.call.rootActionId
  if (rootActionId !== item.seeded.call.rootActionId) {
    db.prepare('INSERT INTO generation_roots(root_action_id,idempotency_key,action_json,budget_json) VALUES(?,?,?,?)')
      .run(rootActionId, `recheck-root-key-${key}`, JSON.stringify({ rootActionId, projectId: 'project', epoch: 'epoch',
        operation: 'review-chapter', uiActionNonce: `recheck-${key}`, frozenInputHash: hash(`recheck-${key}`), status: 'active' }), '{}')
  }
  const modelContent = JSON.stringify({ summary: '复核完成', items: input.mappings.map(mapping => ({
    findingId: mapping.findingId, targetId: mapping.targetId, resolved: mapping.resolved,
    evidenceQuote: item.mergedContent.slice(0, 2), reason: '复核证据',
  })) })
  const frozenGoals: FrozenChapterGoals = { chapterNumber: 1, coverage: 'not_configured', items: [] }
  const report = buildReviewCycleRecheckReport(modelContent, item.mergedContent, context, 'zh-CN')
  const reviewBody = JSON.stringify({ summary: report.summary, items: report.items }, null, 2)
  const reportItems = (JSON.parse(reviewBody) as { items: unknown[] }).items
  const receiptFindings = input.mappings.map(mapping => ({ ...mapping,
    evidenceHash: mapping.evidenceHash ?? hash(JSON.stringify({ findingId: mapping.findingId, targetId: mapping.targetId,
      reviewItemIndex: mapping.reviewItemIndex, item: reportItems[mapping.reviewItemIndex], resolved: mapping.resolved })) }))
  const reviewIndex = Number(db.prepare('SELECT COALESCE(MAX(review_index),0)+1 FROM reviews WHERE base_draft_id=?')
    .pluck().get(item.seeded.draftId))
  const contentId = Number(db.prepare('INSERT INTO contents(body) VALUES(?)').run(reviewBody).lastInsertRowid)
  const reviewId = Number(db.prepare(`INSERT INTO reviews(base_draft_id,review_index,source_draft_chapter_number,
    source_draft_version,source_draft_status,source_content,content_id) VALUES(?,?,1,1,'revised',?,?)`)
    .run(item.seeded.draftId, reviewIndex, item.mergedContent, contentId).lastInsertRowid)
  const attemptId = `attempt-recheck-${key}`, runId = `run-recheck-${key}`, artifactId = `artifact-recheck-${key}`
  const reviewContext = { version: 1, operation: 'review-chapter', sourceHash: item.mergedHash,
    source: { id: item.seeded.draftId, chapterNumber: 1, version: 1, status: 'revised', content: item.mergedContent },
    config: {}, writingLanguage: 'zh-CN', uiLocale: 'zh-CN', authorInputs: [], characterStates: '（暂无）',
    worldbuilding: '', history: [], blueprints: [], frozenGoals, preflightFindings: [], recheck: context }
  const contextHash = hash(JSON.stringify(reviewContext))
  const fingerprint = Object.fromEntries(['chapterBriefHash', 'authorGuidanceHash', 'dependencyHash', 'contextSnapshotHash',
    'templateHash', 'skillSnapshotHash', 'modelLeaseRevision', 'policyHash', 'outputContractHash']
    .map((name, index) => [name, hash(`recheck-fingerprint:${key}:${index}`)]))
  const binding = { projectId: 'project', epoch: 'epoch', fingerprint, contextSnapshotId: `recheck-context-${key}`,
    sourceManifest: { operation: 'review-chapter', reviewRevisionContext: reviewContext,
      reviewRevisionContextHash: contextHash,
      authorInputs: [{ id: 'review-revision-context', text: JSON.stringify(reviewContext) }] }, sourceRefs: [] }
  db.prepare('INSERT INTO generation_runs(run_id,root_action_id,binding_json,status,created_at_ms,open_key) VALUES(?,?,?,?,?,?)')
    .run(runId, rootActionId, JSON.stringify(binding), 'completed', 3, `open-recheck-${key}`)
  const artifact = { artifactId, attemptId, rootActionId, projectId: 'project', epoch: 'epoch', fingerprint,
    revision: 1, text: modelContent, textHash: hash(modelContent) }
  const artifactRef = { artifactId, revision: 1, textHash: artifact.textHash }
  const usage = { artifactIdentity: { artifactId, epoch: 'epoch', fingerprint }, result: { usage: null, finishReason: 'stop' },
    reviewRevisionEffect: { kind: 'review', id: reviewId, index: reviewIndex, contentHash: hash(reviewBody),
      contextHash, artifact: artifactRef }, reviewCycleRecheck: { ...context, findings: receiptFindings } }
  db.prepare(`INSERT INTO generation_attempts(attempt_id,reservation_id,run_id,root_action_id,attempt_json,
    usage_receipt_json,invocation_nonce) VALUES(?,?,?,?,?,?,?)`).run(attemptId, `reservation-${attemptId}`, runId, rootActionId,
    JSON.stringify({ attemptId, reservationId: `reservation-${attemptId}`, rootActionId, status: 'settled', reservedTokens: 100,
      requestedOutputTokens: 100, actualTokens: 1 }), JSON.stringify(usage), `invocation-${attemptId}`)
  db.prepare('INSERT INTO generation_artifacts(artifact_id,attempt_id,run_id,artifact_json,revision,status) VALUES(?,?,?,?,?,?)')
    .run(artifactId, attemptId, runId, JSON.stringify(artifact), 1, 'partial')
  return { attemptId, reviewId }
}

describe('ReviewCycleRepository.create', () => {
  it.each([
    ['missing goalReview', '{"summary":"broken","items":[]}'],
    ['empty summary and items', '{"summary":"","items":[],"goalReview":{"version":1,"chapterNumber":1,"coverage":"not_configured","items":[]}}'],
  ])('rejects a saved review with %s and leaves no partial cycle', (_name, corruptBody) => {
    const db = fixture()
    try {
      const seeded = seed(db, { corruptBody })
      expect(() => create(db, seeded.call)).toThrow('REVIEW_CYCLE_INPUT_INVALID')
      expect(db.prepare('SELECT COUNT(*) FROM review_cycles').pluck().get()).toBe(0)
      expect(db.prepare('SELECT COUNT(*) FROM review_findings').pluck().get()).toBe(0)
    } finally { db.close() }
  })

  it('requires an outer transaction', () => {
    const db = fixture()
    try {
      const seeded = seed(db)
      expect(() => ReviewCycleRepository.create(seeded.call, db)).toThrow('REVIEW_CYCLE_TRANSACTION_REQUIRED')
    } finally { db.close() }
  })

  it('rejects root metadata without a durable generation effect and rolls its savepoint back', () => {
    const db = fixture()
    try {
      const seeded = seed(db, { effect: 'none' })
      expect(() => create(db, seeded.call)).toThrow('REVIEW_CYCLE_INPUT_INVALID')
      expect(db.prepare('SELECT COUNT(*) FROM review_cycles').pluck().get()).toBe(0)
      expect(verifyM03ReviewCycle(db)).toBe(true)
    } finally { db.close() }
  })

  it.each(['wrong-effect', 'wrong-artifact'] as const)('rejects a %s provenance chain', (effect) => {
    const db = fixture()
    try {
      const seeded = seed(db, { effect })
      expect(() => create(db, seeded.call)).toThrow('REVIEW_CYCLE_INPUT_INVALID')
      expect(db.prepare('SELECT COUNT(*) FROM review_cycles').pluck().get()).toBe(0)
      expect(verifyM03ReviewCycle(db)).toBe(true)
    } finally { db.close() }
  })

  it.each([
    ['root project', (input: CreateReviewCycleInput) => { input.source.projectId = 'other-project' }],
    ['root epoch', (input: CreateReviewCycleInput) => { input.source.epoch = 'other-epoch' }],
    ['root id', (input: CreateReviewCycleInput) => { input.rootActionId = 'missing-root' }],
    ['review id', (input: CreateReviewCycleInput) => { input.reviewId += 1 }],
    ['review hash', (input: CreateReviewCycleInput) => { input.reviewContentHash = hash('other-review') }],
    ['source id', (input: CreateReviewCycleInput) => { input.source.sourceId = 'draft:999' }],
    ['source revision', (input: CreateReviewCycleInput) => { input.source.revision += 1 }],
    ['source hash', (input: CreateReviewCycleInput) => { input.source.contentHash = hash('other-source') }],
  ])('rejects a %s mismatch', (_name, mutate) => {
    const db = fixture()
    try {
      const seeded = seed(db)
      mutate(seeded.call)
      expect(() => create(db, seeded.call)).toThrow('REVIEW_CYCLE_INPUT_INVALID')
      expect(db.prepare('SELECT COUNT(*) FROM review_cycles').pluck().get()).toBe(0)
    } finally { db.close() }
  })

  it('requires input and stored review source revisions to be at least one', () => {
    const db = fixture()
    try {
      const seeded = seed(db)
      seeded.call.source.revision = 0
      expect(() => create(db, seeded.call)).toThrow('REVIEW_CYCLE_INPUT_INVALID')
      seeded.call.source.revision = 1
      db.prepare('UPDATE reviews SET source_draft_version=0 WHERE id=?').run(seeded.reviewId)
      expect(() => create(db, seeded.call)).toThrow('REVIEW_CYCLE_INPUT_INVALID')
      expect(db.prepare('SELECT COUNT(*) FROM review_cycles').pluck().get()).toBe(0)
    } finally { db.close() }
  })

  it('classifies stable targets, preserves free duplicates, and uses UTF-16 spans', () => {
    const db = fixture()
    const source = '开场😀目标完成，未知证据，预检证据，重复，重复。'
    const frozenGoals: FrozenChapterGoals = { chapterNumber: 1, coverage: 'complete', items: [
      { id: 'goal-unmet', text: '完成目标' }, { id: 'goal-unknown', text: '核实目标' },
      { id: 'goal-no-proof', text: '无证目标' },
    ] }
    const model = { summary: '发现问题', items: [
      { category: '文风', severity: 'warning', description: '重复意见', quote: '目标完成' },
      { category: '文风', severity: 'warning', description: '重复意见', quote: '目标完成' },
      { category: '节奏', severity: 'pass', description: '通过' },
    ], goalReviews: [
      { id: 'goal-unmet', status: 'unmet', description: '尚未完成', evidence: [{ quote: '😀目标完成' }] },
      { id: 'goal-unknown', status: 'unknown', description: '仍需核实', evidence: [{ quote: '未知证据' }] },
      { id: 'goal-no-proof', status: 'unknown', description: '没有证据', evidence: [] },
    ] }
    try {
      const seeded = seed(db, { source, frozenGoals, model, preflight: [risk('fact:stable', '预检证据')] })
      const created = create(db, seeded.call)
      expect(created.findingCount).toBe(6)
      expect(verifyM03ReviewCycle(db)).toBe(true)
      const rows = db.prepare('SELECT * FROM review_findings ORDER BY rowid').all() as Record<string, unknown>[]
      expect(new Set(rows.map(row => row.finding_id)).size).toBe(6)
      const unmet = rows.find(row => row.target_id === 'goal-unmet')!
      const unmetQuote = '😀目标完成'
      expect(unmet).toMatchObject({ kind: 'objective', status: 'unresolved', span_start: source.indexOf(unmetQuote),
        span_end: source.indexOf(unmetQuote) + unmetQuote.length, span_unit: 'utf16-code-unit',
        excerpt_hash: hash(unmetQuote), occurrence: 1 })
      expect(rows.find(row => row.target_id === 'goal-unknown')).toMatchObject({ kind: 'objective', status: 'unknown',
        span_start: source.indexOf('未知证据'), span_end: source.indexOf('未知证据') + '未知证据'.length })
      expect(rows.find(row => row.target_id === 'fact:stable')).toMatchObject({ kind: 'objective', status: 'unresolved' })
      const unverified = rows.filter(row => row.status === 'unverified')
      expect(unverified).toHaveLength(3)
      for (const row of unverified) expect(row).toMatchObject({ span_start: null, span_end: null, span_unit: null,
        excerpt_hash: null, occurrence: null, target_id: null })
      expect(unverified.filter(row => row.kind === 'literary')).toHaveLength(2)
    } finally { db.close() }
  })

  it('fails closed for duplicate objective quotes and multi-evidence goals', () => {
    const db = fixture()
    const source = '重复证据；重复证据；唯一甲；唯一乙。'
    const frozenGoals: FrozenChapterGoals = { chapterNumber: 1, coverage: 'complete',
      items: [{ id: 'goal-multi', text: '多证据目标' }] }
    const model = { summary: '需要修复', items: [{ category: '文风', severity: 'pass', description: '通过' }],
      goalReviews: [{ id: 'goal-multi', status: 'unmet', description: '两处证据',
        evidence: [{ quote: '唯一甲' }, { quote: '唯一乙' }] }] }
    try {
      const seeded = seed(db, { source, frozenGoals, model, preflight: [risk('fact:duplicate', '重复证据')] })
      const created = create(db, seeded.call)
      expect(created.findingCount).toBe(2)
      const rows = db.prepare('SELECT * FROM review_findings').all() as Record<string, unknown>[]
      for (const row of rows) expect(row).toMatchObject({ status: 'unverified', target_id: null,
        span_start: null, span_end: null, excerpt_hash: null, occurrence: null })
      expect(verifyM03ReviewCycle(db)).toBe(true)
    } finally { db.close() }
  })

  it('keeps different unknown goal identities when both have the same empty anchor descriptor', () => {
    const db = fixture()
    const frozenGoals: FrozenChapterGoals = { chapterNumber: 1, coverage: 'complete', items: [
      { id: 'goal-a', text: '核实甲' }, { id: 'goal-b', text: '核实乙' },
    ] }
    const model = { summary: '需要核实', items: [{ category: '文风', severity: 'pass', description: '通过' }],
      goalReviews: [
        { id: 'goal-a', status: 'unknown', description: '没有证据', evidence: [] },
        { id: 'goal-b', status: 'unknown', description: '没有证据', evidence: [] },
      ] }
    try {
      const seeded = seed(db, { frozenGoals, model })
      const created = create(db, seeded.call)
      expect(created.findingCount).toBe(2)
      const rows = db.prepare('SELECT * FROM review_findings ORDER BY finding_id').all() as Record<string, unknown>[]
      expect(rows).toHaveLength(2)
      expect(new Set(rows.map(row => row.finding_id)).size).toBe(2)
      for (const row of rows) expect(row).toMatchObject({ kind: 'objective', status: 'unverified', target_id: null,
        span_start: null, span_end: null, excerpt_hash: null })
      expect(verifyM03ReviewCycle(db)).toBe(true)
    } finally { db.close() }
  })

  it('keeps different preflight identities after duplicate-quote anchoring fails and deduplicates an exact repeat', () => {
    const db = fixture()
    const source = '开场，重复证据，重复证据。'
    try {
      const seeded = seed(db, { source, preflight: [
        risk('fact:a', '重复证据'), risk('fact:b', '重复证据'), risk('fact:a', '重复证据'),
      ] })
      const created = create(db, seeded.call)
      expect(created.findingCount).toBe(2)
      const rows = db.prepare('SELECT * FROM review_findings ORDER BY finding_id').all() as Record<string, unknown>[]
      expect(rows).toHaveLength(2)
      expect(new Set(rows.map(row => row.finding_id)).size).toBe(2)
      for (const row of rows) expect(row).toMatchObject({ kind: 'objective', status: 'unverified', target_id: null,
        span_start: null, span_end: null, excerpt_hash: null })
      expect(verifyM03ReviewCycle(db)).toBe(true)
    } finally { db.close() }
  })

  it('preserves different anchors for one stable target and deduplicates only identical descriptors', () => {
    const db = fixture()
    const source = '开场，唯一甲，唯一乙。'
    try {
      const seeded = seed(db, { source, preflight: [
        risk('fact:same', '唯一甲'), risk('fact:same', '唯一乙'), risk('fact:same', '唯一甲'),
      ] })
      const created = create(db, seeded.call)
      expect(created.findingCount).toBe(2)
      const rows = db.prepare("SELECT * FROM review_findings WHERE target_id='fact:same' ORDER BY span_start").all() as Record<string, unknown>[]
      expect(rows).toHaveLength(2)
      expect(rows.map(row => row.span_start)).toEqual([source.indexOf('唯一甲'), source.indexOf('唯一乙')])
      expect(new Set(rows.map(row => row.finding_id)).size).toBe(2)
      expect(verifyM03ReviewCycle(db)).toBe(true)
    } finally { db.close() }
  })

  it('is deterministic and idempotent, but rejects immutable persisted conflicts', () => {
    const db = fixture()
    try {
      const seeded = seed(db)
      const first = create(db, seeded.call)
      expect(verifyM03ReviewCycle(db)).toBe(true)
      expect(create(db, seeded.call)).toEqual(first)
      expect(db.prepare('SELECT COUNT(*) FROM review_cycles').pluck().get()).toBe(1)
      db.prepare('UPDATE review_cycles SET finding_set_hash=? WHERE cycle_id=?').run(hash('tampered'), first.cycleId)
      expect(() => create(db, seeded.call)).toThrow('REVIEW_CYCLE_CONFLICT')
      expect(db.prepare('SELECT COUNT(*) FROM review_cycles').pluck().get()).toBe(1)
    } finally { db.close() }
  })

  it('rolls cycle and findings back with a later caller failure', () => {
    const db = fixture()
    const model = { summary: '需修改', items: [{ category: '文风', severity: 'warning',
      description: '需修改', quote: '开场' }], goalReviews: defaultModel.goalReviews }
    try {
      const seeded = seed(db, { model })
      expect(() => db.transaction(() => {
        ReviewCycleRepository.create(seeded.call, db)
        throw new Error('later write failed')
      })()).toThrow('later write failed')
      expect(db.prepare('SELECT COUNT(*) FROM review_cycles').pluck().get()).toBe(0)
      expect(db.prepare('SELECT COUNT(*) FROM review_findings').pluck().get()).toBe(0)
      expect(verifyM03ReviewCycle(db)).toBe(true)
    } finally { db.close() }
  })

  it('persists an empty canonical finding set with complete reopen proof', () => {
    const db = fixture()
    try {
      const seeded = seed(db)
      const created = create(db, seeded.call)
      expect(created).toMatchObject({ findingCount: 0, findingSetHash: canonicalM03FindingSetHash([]) })
      expect(db.prepare('SELECT COUNT(*) FROM review_findings').pluck().get()).toBe(0)
      expect(verifyM03ReviewCycle(db)).toBe(true)
    } finally { db.close() }
  })
})

describe('ReviewCycleRepository generated revision state', () => {
  it('binds an explicit v2 author waiver before generation and leaves other findings unresolved', () => {
    const db = fixture()
    try {
      const seeded = seed(db, { key: 'author-waiver',
        preflight: [risk('fact:door', '预检证据'), risk('fact:window', '😀目标完成')] })
      const cycle = create(db, seeded.call)
      const rows = db.prepare('SELECT finding_id,target_id FROM review_findings WHERE cycle_id=? ORDER BY target_id')
        .all(cycle.cycleId) as Array<{ finding_id: string; target_id: string }>
      const snapshot = { kind: 'human-confirmed-review', schemaVersion: 2, cycleId: cycle.cycleId,
        sourceReviewId: seeded.reviewId,
        sourceDraft: { id: seeded.draftId, chapterNumber: 1, version: 1, status: 'draft', content: seeded.source },
        summary: '作者确认', authorGuidance: '', items: rows.map((row, index) => ({ findingId: row.finding_id,
          category: '连续性', severity: 'warning', description: `意见 ${index + 1}`,
          decision: index === 0 ? 'waive' : 'apply', origin: 'ai' })) }
      const confirmation = seedConfirmation(db, seeded, snapshot)
      const result = db.transaction(() => ReviewCycleRepository.commitAuthorConfirmation({
        cycleId: cycle.cycleId, confirmationReviewId: confirmation.id,
      }, db))()
      expect(result).toMatchObject({ confirmationReviewId: confirmation.id, waivedFindingCount: 1, idempotent: false })
      expect(db.prepare(`SELECT target_id,status,evidence_hash,confirmation_item_index FROM review_findings
        WHERE cycle_id=? ORDER BY target_id`).all(cycle.cycleId)).toEqual([
        { target_id: 'fact:door', status: 'author-waived', evidence_hash: hash(confirmation.body), confirmation_item_index: 0 },
        { target_id: 'fact:window', status: 'unresolved', evidence_hash: null, confirmation_item_index: null },
      ])
      expect(db.prepare('SELECT revision_status,confirmation_review_id,confirmation_content_hash FROM review_cycles WHERE cycle_id=?')
        .get(cycle.cycleId)).toEqual({ revision_status: 'not-generated', confirmation_review_id: confirmation.id,
          confirmation_content_hash: hash(confirmation.body) })
      expect(verifyM03ReviewCycle(db)).toBe(true)
      expect(db.transaction(() => ReviewCycleRepository.commitAuthorConfirmation({
        cycleId: cycle.cycleId, confirmationReviewId: confirmation.id,
      }, db))()).toMatchObject({ waivedFindingCount: 1, idempotent: true })
    } finally { db.close() }
  })

  it.each(['wrong-cycle', 'missing-finding', 'duplicate-finding'] as const)(
    'rejects %s waiver identity without partially binding the cycle', (failure) => {
      const db = fixture()
      try {
        const seeded = seed(db, { key: `waiver-${failure}`, preflight: [risk('fact:kept', '预检证据')] })
        const cycle = create(db, seeded.call)
        const findingId = db.prepare('SELECT finding_id FROM review_findings WHERE cycle_id=?').pluck().get(cycle.cycleId) as string
        const item = { findingId: failure === 'missing-finding' ? 'missing-finding' : findingId,
          category: '连续性', severity: 'warning', description: '作者带建议完成', decision: 'waive', origin: 'ai' }
        const snapshot = { kind: 'human-confirmed-review', schemaVersion: 2,
          cycleId: failure === 'wrong-cycle' ? 'cycle:wrong' : cycle.cycleId, sourceReviewId: seeded.reviewId,
          sourceDraft: { id: seeded.draftId, chapterNumber: 1, version: 1, status: 'draft', content: seeded.source },
          summary: '', authorGuidance: '', items: failure === 'duplicate-finding' ? [item, { ...item }] : [item] }
        const confirmation = seedConfirmation(db, seeded, snapshot)
        expect(() => db.transaction(() => ReviewCycleRepository.commitAuthorConfirmation({
          cycleId: cycle.cycleId, confirmationReviewId: confirmation.id,
        }, db))()).toThrow()
        expect(db.prepare('SELECT confirmation_review_id,confirmation_content_hash FROM review_cycles WHERE cycle_id=?')
          .get(cycle.cycleId)).toEqual({ confirmation_review_id: null, confirmation_content_hash: null })
        expect(db.prepare('SELECT status,evidence_hash,confirmation_item_index FROM review_findings WHERE cycle_id=?')
          .get(cycle.cycleId)).toEqual({ status: 'unresolved', evidence_hash: null, confirmation_item_index: null })
      } finally { db.close() }
    },
  )

  it('allows an author to explicitly waive an unverified finding without fabricating an anchor', () => {
    const db = fixture()
    try {
      const seeded = seed(db, { key: 'waiver-unverified', source: '门闩松动，门闩松动。',
        preflight: [risk('fact:ambiguous', '门闩松动')] })
      const cycle = create(db, seeded.call)
      const findingId = db.prepare('SELECT finding_id FROM review_findings WHERE cycle_id=?').pluck().get(cycle.cycleId) as string
      const snapshot = { kind: 'human-confirmed-review', schemaVersion: 2, cycleId: cycle.cycleId,
        sourceReviewId: seeded.reviewId,
        sourceDraft: { id: seeded.draftId, chapterNumber: 1, version: 1, status: 'draft', content: seeded.source },
        summary: '', authorGuidance: '', items: [{ findingId, category: '连续性', severity: 'unknown',
          description: '作者确认带建议完成', decision: 'waive', origin: 'ai' }] }
      const confirmation = seedConfirmation(db, seeded, snapshot)
      expect(db.transaction(() => ReviewCycleRepository.commitAuthorConfirmation({
        cycleId: cycle.cycleId, confirmationReviewId: confirmation.id,
      }, db))()).toMatchObject({ waivedFindingCount: 1 })
      expect(db.prepare(`SELECT status,target_id,span_start,span_end,excerpt_hash,occurrence,evidence_hash,
        confirmation_item_index FROM review_findings WHERE cycle_id=?`).get(cycle.cycleId)).toEqual({
        status: 'author-waived', target_id: null, span_start: null, span_end: null, excerpt_hash: null, occurrence: null,
        evidence_hash: hash(confirmation.body), confirmation_item_index: 0,
      })
      expect(verifyM03ReviewCycle(db)).toBe(true)
    } finally { db.close() }
  })

  it('atomically attaches a same-root durable revision and replays the same binding idempotently', () => {
    const db = fixture()
    try {
      const seeded = seed(db, { preflight: [risk('fact:kept', '预检证据')] })
      const cycle = create(db, seeded.call)
      const revision = seedRevision(db, seeded)
      revision.attach.cycleId = cycle.cycleId
      const first = db.transaction(() => ReviewCycleRepository.attachGeneratedRevision(revision.attach, db))()
      expect(first).toEqual({ cycleId: cycle.cycleId, confirmationReviewId: revision.confirmationId,
        revisionId: revision.revisionId, revisionStatus: 'generated', idempotent: false })
      expect(db.prepare('SELECT revision_status,confirmation_review_id,revision_id FROM review_cycles WHERE cycle_id=?')
        .get(cycle.cycleId)).toEqual({ revision_status: 'generated', confirmation_review_id: revision.confirmationId,
          revision_id: revision.revisionId })
      expect(db.prepare('SELECT status FROM review_findings WHERE cycle_id=?').pluck().get(cycle.cycleId)).toBe('unresolved')
      expect(verifyM03ReviewCycle(db)).toBe(true)
      expect(db.transaction(() => ReviewCycleRepository.attachGeneratedRevision(revision.attach, db))())
        .toMatchObject({ idempotent: true })
      expect(() => db.transaction(() => ReviewCycleRepository.attachGeneratedRevision({ ...revision.attach,
        revisionId: revision.revisionId + 100 }, db))()).toThrow('REVIEW_CYCLE_CONFLICT')
      expect(() => db.transaction(() => ReviewCycleRepository.attachGeneratedRevision({ ...revision.attach,
        confirmationReviewId: revision.confirmationId + 100 }, db))()).toThrow('REVIEW_CYCLE_CONFLICT')
      expect(verifyM03ReviewCycle(db)).toBe(true)
    } finally { db.close() }
  })

  it.each(['wrong-composition', 'different-root'] as const)('rejects a revision with %s proof and keeps the cycle ungenerated', (effect) => {
    const db = fixture()
    try {
      const seeded = seed(db)
      const cycle = create(db, seeded.call)
      const revision = seedRevision(db, seeded, { effect })
      revision.attach.cycleId = cycle.cycleId
      expect(() => db.transaction(() => ReviewCycleRepository.attachGeneratedRevision(revision.attach, db))())
        .toThrow('REVIEW_CYCLE_INPUT_INVALID')
      expect(db.prepare('SELECT revision_status,confirmation_review_id,revision_id FROM review_cycles WHERE cycle_id=?')
        .get(cycle.cycleId)).toEqual({ revision_status: 'not-generated', confirmation_review_id: null, revision_id: null })
    } finally { db.close() }
  })

  it('rolls confirmation, revision, effect, and attach back when attach proof fails in the caller transaction', () => {
    const db = fixture()
    try {
      const seeded = seed(db)
      const cycle = create(db, seeded.call)
      const before = { reviews: db.prepare('SELECT COUNT(*) FROM reviews').pluck().get(),
        revisions: db.prepare('SELECT COUNT(*) FROM revisions').pluck().get(),
        runs: db.prepare('SELECT COUNT(*) FROM generation_runs').pluck().get(),
        attempts: db.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get() }
      expect(() => db.transaction(() => {
        const revision = seedRevision(db, seeded, { effect: 'wrong-composition' })
        revision.attach.cycleId = cycle.cycleId
        ReviewCycleRepository.attachGeneratedRevision(revision.attach, db)
      })()).toThrow('REVIEW_CYCLE_INPUT_INVALID')
      expect({ reviews: db.prepare('SELECT COUNT(*) FROM reviews').pluck().get(),
        revisions: db.prepare('SELECT COUNT(*) FROM revisions').pluck().get(),
        runs: db.prepare('SELECT COUNT(*) FROM generation_runs').pluck().get(),
        attempts: db.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get() }).toEqual(before)
      expect(db.prepare('SELECT revision_status FROM review_cycles WHERE cycle_id=?').pluck().get(cycle.cycleId))
        .toBe('not-generated')
      expect(verifyM03ReviewCycle(db)).toBe(true)
    } finally { db.close() }
  })

  it('detaches a replacePending-discarded old cycle before binding the new cycle', () => {
    const db = fixture()
    try {
      const first = seed(db, { key: 'review-one' })
      const firstCycle = create(db, first.call)
      const firstRevision = seedRevision(db, first, { key: 'revision-one' })
      firstRevision.attach.cycleId = firstCycle.cycleId
      db.transaction(() => ReviewCycleRepository.attachGeneratedRevision(firstRevision.attach, db))()

      const second = seed(db, { key: 'review-two', source: first.source, existingDraftId: first.draftId })
      const secondCycle = create(db, second.call)
      expect(() => db.transaction(() => ReviewCycleRepository.attachGeneratedRevision({ ...firstRevision.attach,
        cycleId: secondCycle.cycleId, rootActionId: second.call.rootActionId }, db))()).toThrow('REVIEW_CYCLE_CONFLICT')
      const secondRevision = seedRevision(db, second, { key: 'revision-two', revisionContent: `${first.source}\n第二版修稿。` })
      secondRevision.attach.cycleId = secondCycle.cycleId
      expect(db.prepare('SELECT status FROM revisions WHERE id=?').pluck().get(firstRevision.revisionId)).toBe('discarded')
      expect(db.prepare('SELECT revision_status,revision_id,confirmation_review_id FROM review_cycles WHERE cycle_id=?')
        .get(firstCycle.cycleId)).toEqual({ revision_status: 'not-generated', revision_id: null,
          confirmation_review_id: firstRevision.confirmationId })
      expect(verifyM03ReviewCycle(db)).toBe(true)
      db.transaction(() => ReviewCycleRepository.attachGeneratedRevision(secondRevision.attach, db))()

      expect(db.prepare('SELECT revision_status,revision_id,confirmation_review_id FROM review_cycles WHERE cycle_id=?')
        .get(firstCycle.cycleId)).toEqual({ revision_status: 'not-generated', revision_id: null,
          confirmation_review_id: firstRevision.confirmationId })
      expect(db.prepare('SELECT revision_status,revision_id,confirmation_review_id FROM review_cycles WHERE cycle_id=?')
        .get(secondCycle.cycleId)).toEqual({ revision_status: 'generated', revision_id: secondRevision.revisionId,
          confirmation_review_id: secondRevision.confirmationId })
      expect(verifyM03ReviewCycle(db)).toBe(true)
    } finally { db.close() }
  })

  it('atomically detaches a generated cycle when RevisionRepository.markDiscarded is the authority write', () => {
    const db = fixture()
    try {
      const item = generatedCycle(db, 'direct-discard')
      RevisionRepository.markDiscarded(item.revision.revisionId, db)
      expect(db.prepare('SELECT status FROM revisions WHERE id=?').pluck().get(item.revision.revisionId)).toBe('discarded')
      expect(db.prepare('SELECT revision_status,revision_id,confirmation_review_id FROM review_cycles WHERE cycle_id=?')
        .get(item.cycle.cycleId)).toEqual({ revision_status: 'not-generated', revision_id: null,
          confirmation_review_id: item.revision.confirmationId })
      expect(verifyM03ReviewCycle(db)).toBe(true)
    } finally { db.close() }
  })

  it('reconciles multiple discarded generated cycles in one verifier-safe batch', () => {
    const db = fixture()
    try {
      const first = generatedCycle(db, 'batch-one')
      const second = generatedCycle(db, 'batch-two', first.seeded)
      db.prepare("UPDATE revisions SET status='discarded' WHERE id IN (?,?)")
        .run(first.revision.revisionId, second.revision.revisionId)
      expect(verifyM03ReviewCycle(db)).toBe(false)
      expect(() => db.transaction(() => ReviewCycleRepository
        .reconcileDiscardedRevision(first.revision.revisionId, db))()).toThrow('REVIEW_CYCLE_CONFLICT')
      expect(db.prepare("SELECT COUNT(*) FROM review_cycles WHERE revision_status='generated'").pluck().get()).toBe(2)

      const result = db.transaction(() => ReviewCycleRepository.reconcileDiscardedRevisions([
        second.revision.revisionId, first.revision.revisionId,
      ], db))()
      expect(result).toEqual({ revisionIds: [first.revision.revisionId, second.revision.revisionId].sort((a, b) => a - b),
        detached: 2 })
      for (const item of [first, second]) {
        expect(db.prepare('SELECT revision_status,revision_id,confirmation_review_id FROM review_cycles WHERE cycle_id=?')
          .get(item.cycle.cycleId)).toEqual({ revision_status: 'not-generated', revision_id: null,
            confirmation_review_id: item.revision.confirmationId })
      }
      expect(verifyM03ReviewCycle(db)).toBe(true)
    } finally { db.close() }
  })

  it('accepts an empty batch and normalizes duplicate discarded revision ids', () => {
    const db = fixture()
    try {
      expect(db.transaction(() => ReviewCycleRepository.reconcileDiscardedRevisions([], db))())
        .toEqual({ revisionIds: [], detached: 0 })
      const item = generatedCycle(db, 'duplicate-batch')
      db.prepare("UPDATE revisions SET status='discarded' WHERE id=?").run(item.revision.revisionId)
      expect(db.transaction(() => ReviewCycleRepository.reconcileDiscardedRevisions([
        item.revision.revisionId, item.revision.revisionId,
      ], db))()).toEqual({ revisionIds: [item.revision.revisionId], detached: 1 })
      expect(verifyM03ReviewCycle(db)).toBe(true)
    } finally { db.close() }
  })

  it('validates every batch member before updating any cycle', () => {
    const db = fixture()
    try {
      const discarded = generatedCycle(db, 'atomic-discarded')
      const pending = generatedCycle(db, 'atomic-pending', discarded.seeded)
      db.prepare("UPDATE revisions SET status='discarded' WHERE id=?").run(discarded.revision.revisionId)
      expect(() => db.transaction(() => ReviewCycleRepository.reconcileDiscardedRevisions([
        discarded.revision.revisionId, pending.revision.revisionId,
      ], db))()).toThrow('REVIEW_CYCLE_CONFLICT')
      expect(db.prepare('SELECT revision_status,revision_id FROM review_cycles WHERE cycle_id=?')
        .get(discarded.cycle.cycleId)).toEqual({ revision_status: 'generated', revision_id: discarded.revision.revisionId })
      expect(db.prepare('SELECT revision_status,revision_id FROM review_cycles WHERE cycle_id=?')
        .get(pending.cycle.cycleId)).toEqual({ revision_status: 'generated', revision_id: pending.revision.revisionId })
    } finally { db.close() }
  })

  it('reconciles only discarded generated revisions and rejects pending or merged revisions', () => {
    const db = fixture()
    try {
      const seeded = seed(db)
      const cycle = create(db, seeded.call)
      const revision = seedRevision(db, seeded)
      revision.attach.cycleId = cycle.cycleId
      db.transaction(() => ReviewCycleRepository.attachGeneratedRevision(revision.attach, db))()
      expect(() => db.transaction(() => ReviewCycleRepository.reconcileDiscardedRevisions([revision.revisionId], db))())
        .toThrow('REVIEW_CYCLE_CONFLICT')
      db.prepare("UPDATE revisions SET status='merged' WHERE id=?").run(revision.revisionId)
      expect(() => db.transaction(() => ReviewCycleRepository.reconcileDiscardedRevisions([revision.revisionId], db))())
        .toThrow('REVIEW_CYCLE_CONFLICT')
      db.prepare("UPDATE revisions SET status='discarded' WHERE id=?").run(revision.revisionId)
      expect(db.transaction(() => ReviewCycleRepository.reconcileDiscardedRevision(revision.revisionId, db))())
        .toEqual({ revisionId: revision.revisionId, detached: true })
      expect(db.prepare('SELECT revision_status,revision_id,confirmation_review_id FROM review_cycles WHERE cycle_id=?')
        .get(cycle.cycleId)).toEqual({ revision_status: 'not-generated', revision_id: null,
          confirmation_review_id: revision.confirmationId })
      expect(db.transaction(() => ReviewCycleRepository.reconcileDiscardedRevision(revision.revisionId, db))())
        .toEqual({ revisionId: revision.revisionId, detached: false })
      expect(verifyM03ReviewCycle(db)).toBe(true)
    } finally { db.close() }
  })
})

describe('ReviewCycleRepository merge state', () => {
  it('keeps both cycle histories valid when the same draft is merged twice', () => {
    const db = fixture()
    try {
      const first = generatedCycle(db, 'twice-first')
      const firstText = `${first.seeded.source}\n作者第一次手工合并。`
      const firstRequest = { revisionId: first.revision.revisionId, targetDraftId: first.seeded.draftId,
        expectedDraftContent: first.seeded.source, mergedContent: firstText, wordCount: firstText.length }
      expect(RevisionRepository.mergeIntoDraft(firstRequest, db).idempotent).toBe(false)

      const secondSeed = seed(db, { key: 'review-twice-second', source: firstText,
        sourceStatus: 'revised', existingDraftId: first.seeded.draftId,
        preflight: [risk('fact:twice', '作者第一次手工合并')] })
      const secondCycle = create(db, secondSeed.call)
      const secondRevision = seedRevision(db, secondSeed, { key: 'revision-twice-second' })
      secondRevision.attach.cycleId = secondCycle.cycleId
      db.transaction(() => ReviewCycleRepository.attachGeneratedRevision(secondRevision.attach, db))()
      const secondText = firstText.replace('作者第一次手工合并', '作者第二次手工合并')
      expect(RevisionRepository.mergeIntoDraft({ revisionId: secondRevision.revisionId,
        targetDraftId: secondSeed.draftId, expectedDraftContent: firstText, mergedContent: secondText,
        wordCount: secondText.length }, db).idempotent).toBe(false)
      expect(verifyM03ReviewCycle(db)).toBe(true)
      expect(ReviewCycleRepository.getByReviewId(first.seeded.reviewId, db)?.mergedHash).toBe(hash(firstText))
      expect(ReviewCycleRepository.getByReviewId(first.seeded.reviewId, db)?.recheckDisposition).toBeUndefined()
      expect(() => ReviewCycleRepository.planRecheck(first.cycle.cycleId, db)).toThrow('REVIEW_CYCLE_CONFLICT')
      expect(ReviewCycleRepository.planRecheck(secondCycle.cycleId, db).disposition).toBe('required')
      db.prepare('UPDATE contents SET body=? WHERE id=(SELECT content_id FROM drafts WHERE id=?)')
        .run(firstText, first.seeded.draftId)
      expect(verifyM03ReviewCycle(db)).toBe(true)
      expect(() => ReviewCycleRepository.planRecheck(first.cycle.cycleId, db)).toThrow('REVIEW_CYCLE_CONFLICT')
    } finally { db.close() }
  })

  it('keeps a merged cycle readable after an author edit without restarting its recheck', () => {
    const db = fixture()
    try {
      const item = generatedCycle(db, 'edited-after-merge')
      const merged = `${item.seeded.source}\n作者手工合并。`
      RevisionRepository.mergeIntoDraft({ revisionId: item.revision.revisionId,
        targetDraftId: item.seeded.draftId, expectedDraftContent: item.seeded.source,
        mergedContent: merged, wordCount: merged.length }, db)
      db.prepare('UPDATE contents SET body=? WHERE id=(SELECT content_id FROM drafts WHERE id=?)')
        .run(`${merged} 作者继续编辑。`, item.seeded.draftId)
      expect(verifyM03ReviewCycle(db)).toBe(true)
      expect(ReviewCycleRepository.getByReviewId(item.seeded.reviewId, db)?.mergedHash).toBe(hash(merged))
      expect(() => ReviewCycleRepository.planRecheck(item.cycle.cycleId, db)).toThrow('REVIEW_CYCLE_CONFLICT')
    } finally { db.close() }
  })

  it('commits the real draft, revision, and cycle rows atomically through RevisionRepository.mergeIntoDraft', () => {
    const db = fixture()
    try {
      const seeded = seed(db, { key: 'review-real-merge-entry', preflight: [risk('fact:real-merge', '预检证据')] })
      const cycle = create(db, seeded.call)
      const revision = seedRevision(db, seeded, { key: 'revision-real-merge-entry' })
      revision.attach.cycleId = cycle.cycleId
      db.transaction(() => ReviewCycleRepository.attachGeneratedRevision(revision.attach, db))()
      const item = { seeded, cycle, revision }
      const mergedContent = `${item.seeded.source}\n作者确认后的合并正文。`
      const request = { revisionId: item.revision.revisionId, targetDraftId: item.seeded.draftId,
        expectedDraftContent: item.seeded.source, mergedContent, wordCount: mergedContent.length }
      expect(RevisionRepository.mergeIntoDraft(request, db)).toMatchObject({ idempotent: false, status: 'revised' })
      expect(db.prepare(`SELECT d.status,d.word_count,c.body FROM drafts d JOIN contents c ON c.id=d.content_id
        WHERE d.id=?`).get(item.seeded.draftId)).toEqual({ status: 'revised', word_count: mergedContent.length,
        body: mergedContent })
      expect(db.prepare('SELECT status,merged_to_draft_id FROM revisions WHERE id=?').get(item.revision.revisionId))
        .toEqual({ status: 'merged', merged_to_draft_id: item.seeded.draftId })
      expect(db.prepare('SELECT revision_status,merged_hash FROM review_cycles WHERE cycle_id=?').get(item.cycle.cycleId))
        .toEqual({ revision_status: 'merge-committed', merged_hash: hash(mergedContent) })
      expect(db.prepare('SELECT status FROM review_findings WHERE cycle_id=?').pluck().get(item.cycle.cycleId)).toBe('unresolved')
      expect(verifyM03ReviewCycle(db)).toBe(true)
      expect(RevisionRepository.mergeIntoDraft(request, db)).toMatchObject({ idempotent: true })
      expect(() => RevisionRepository.markMerged(item.revision.revisionId, item.seeded.draftId, db))
        .toThrow('必须通过原子正文合并入口')
    } finally { db.close() }
  })

  it('rolls the real merge entry back when cycle commit fails, then retries the same merge', () => {
    const db = fixture()
    try {
      const item = generatedCycle(db, 'real-merge-rollback')
      const mergedContent = `${item.seeded.source}\n事务完整性。`
      const request = { revisionId: item.revision.revisionId, targetDraftId: item.seeded.draftId,
        expectedDraftContent: item.seeded.source, mergedContent, wordCount: mergedContent.length }
      db.exec(`CREATE TRIGGER fail_cycle_merge BEFORE UPDATE OF revision_status ON review_cycles
        WHEN NEW.revision_status='merge-committed' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_CYCLE_MERGE_FAILURE'); END`)
      expect(() => RevisionRepository.mergeIntoDraft(request, db)).toThrow('SYNTHETIC_CYCLE_MERGE_FAILURE')
      expect(db.prepare(`SELECT d.status,d.word_count,c.body FROM drafts d JOIN contents c ON c.id=d.content_id
        WHERE d.id=?`).get(item.seeded.draftId)).toEqual({ status: 'draft', word_count: 0, body: item.seeded.source })
      expect(db.prepare('SELECT status,merged_to_draft_id FROM revisions WHERE id=?').get(item.revision.revisionId))
        .toEqual({ status: 'pending', merged_to_draft_id: null })
      expect(db.prepare('SELECT revision_status,merged_hash FROM review_cycles WHERE cycle_id=?').get(item.cycle.cycleId))
        .toEqual({ revision_status: 'generated', merged_hash: null })
      expect(verifyM03ReviewCycle(db)).toBe(true)
      db.exec('DROP TRIGGER fail_cycle_merge')
      expect(RevisionRepository.mergeIntoDraft(request, db)).toMatchObject({ idempotent: false })
      expect(verifyM03ReviewCycle(db)).toBe(true)
    } finally { db.close() }
  })

  it.each([
    ['substantive', () => '完全改写后的正文，问题仍由后续复核判定。'],
    ['no-op', (source: string) => source],
    ['format-only', (source: string) => `${source}\n`],
    ['unrelated', (source: string) => `${source} 天气转晴。`],
    ['partial-finding', (source: string) => source.replace('重复，重复', '重复')],
  ])('records a %s merge without changing finding status', (key, merged) => {
    const db = fixture()
    try {
      const seeded = seed(db, { key: `merge-${key}`, preflight: [risk(`fact:${key}`, '预检证据')] })
      const cycle = create(db, seeded.call)
      const revision = seedRevision(db, seeded, { key: `merge-revision-${key}` })
      revision.attach.cycleId = cycle.cycleId
      db.transaction(() => ReviewCycleRepository.attachGeneratedRevision(revision.attach, db))()
      const item = { seeded, cycle, revision }
      const mergedHash = mergeRows(db, item, merged(seeded.source))
      const receipt = db.transaction(() => ReviewCycleRepository.commitMergedRevision({
        revisionId: revision.revisionId, mergedHash,
      }, db))()
      expect(receipt).toEqual({ revisionId: revision.revisionId, bound: true, cycleId: cycle.cycleId,
        revisionStatus: 'merge-committed', idempotent: false })
      expect(db.prepare('SELECT revision_status,merged_hash FROM review_cycles WHERE cycle_id=?').get(cycle.cycleId))
        .toEqual({ revision_status: 'merge-committed', merged_hash: mergedHash })
      expect(db.prepare('SELECT status FROM review_findings WHERE cycle_id=?').pluck().get(cycle.cycleId)).toBe('unresolved')
      expect(verifyM03ReviewCycle(db)).toBe(true)
    } finally { db.close() }
  })

  it('returns an unbound no-op for an ordinary merged refinement', () => {
    const db = fixture()
    try {
      const seeded = seed(db, { key: 'ordinary-refine' })
      const revisionContent = `${seeded.source}\n普通修稿。`
      const contentId = Number(db.prepare('INSERT INTO contents(body) VALUES(?)').run(revisionContent).lastInsertRowid)
      const revisionId = Number(db.prepare(`INSERT INTO revisions(base_draft_id,revision_index,revision_type,status,
        merged_to_draft_id,source_draft_chapter_number,source_draft_version,source_draft_status,source_content,content_id,word_count)
        VALUES(?,1,'refine','merged',?,1,1,'draft',?,?,?)`)
        .run(seeded.draftId, seeded.draftId, seeded.source, contentId, revisionContent.length).lastInsertRowid)
      const draftContentId = db.prepare('SELECT content_id FROM drafts WHERE id=?').pluck().get(seeded.draftId) as number
      db.prepare('UPDATE contents SET body=? WHERE id=?').run(revisionContent, draftContentId)
      db.prepare("UPDATE drafts SET status='revised' WHERE id=?").run(seeded.draftId)
      expect(db.transaction(() => ReviewCycleRepository.commitMergedRevision({
        revisionId, mergedHash: hash(revisionContent),
      }, db))()).toEqual({ revisionId, bound: false, idempotent: true })
      expect(db.prepare('SELECT COUNT(*) FROM review_cycles').pluck().get()).toBe(0)
    } finally { db.close() }
  })

  it('is idempotent for the same merged hash and rejects wrong state, draft, or hash', () => {
    const db = fixture()
    try {
      const item = generatedCycle(db, 'merge-conflicts')
      expect(() => db.transaction(() => ReviewCycleRepository.commitMergedRevision({
        revisionId: item.revision.revisionId, mergedHash: hash(item.seeded.source),
      }, db))()).toThrow('REVIEW_CYCLE_CONFLICT')

      const otherContentId = Number(db.prepare("INSERT INTO contents(body) VALUES('other')").run().lastInsertRowid)
      const otherDraftId = Number(db.prepare(`INSERT INTO drafts(chapter_number,version,status,content_id)
        VALUES(2,1,'draft',?)`).run(otherContentId).lastInsertRowid)
      const mergedHash = mergeRows(db, item, '合并后的正文。')
      db.prepare('UPDATE revisions SET merged_to_draft_id=? WHERE id=?').run(otherDraftId, item.revision.revisionId)
      expect(() => db.transaction(() => ReviewCycleRepository.commitMergedRevision({
        revisionId: item.revision.revisionId, mergedHash,
      }, db))()).toThrow('REVIEW_CYCLE_CONFLICT')
      db.prepare('UPDATE revisions SET merged_to_draft_id=? WHERE id=?').run(item.seeded.draftId, item.revision.revisionId)
      expect(() => db.transaction(() => ReviewCycleRepository.commitMergedRevision({
        revisionId: item.revision.revisionId, mergedHash: hash('wrong body'),
      }, db))()).toThrow('REVIEW_CYCLE_CONFLICT')

      expect(db.transaction(() => ReviewCycleRepository.commitMergedRevision({
        revisionId: item.revision.revisionId, mergedHash,
      }, db))()).toMatchObject({ bound: true, idempotent: false })
      expect(db.transaction(() => ReviewCycleRepository.commitMergedRevision({
        revisionId: item.revision.revisionId, mergedHash,
      }, db))()).toMatchObject({ bound: true, idempotent: true })
      expect(() => db.transaction(() => ReviewCycleRepository.commitMergedRevision({
        revisionId: item.revision.revisionId, mergedHash: hash('different'),
      }, db))()).toThrow('REVIEW_CYCLE_CONFLICT')
      expect(verifyM03ReviewCycle(db)).toBe(true)
    } finally { db.close() }
  })

  it('rejects a wrong-root revision proof and rolls the cycle update back', () => {
    const db = fixture()
    try {
      const item = generatedCycle(db, 'merge-wrong-root')
      const mergedHash = mergeRows(db, item, '合并正文。')
      const otherRoot = 'root-merge-wrong-root-other'
      db.prepare('INSERT INTO generation_roots(root_action_id,idempotency_key,action_json,budget_json) VALUES(?,?,?,?)')
        .run(otherRoot, 'wrong-root-key', JSON.stringify({ rootActionId: otherRoot, projectId: 'project', epoch: 'epoch',
          operation: 'refine-from-review', uiActionNonce: 'wrong-root', frozenInputHash: hash('wrong-root'), status: 'active' }), '{}')
      db.prepare('UPDATE generation_attempts SET root_action_id=? WHERE attempt_id=?')
        .run(otherRoot, 'attempt-revision-merge-wrong-root')
      expect(() => db.transaction(() => ReviewCycleRepository.commitMergedRevision({
        revisionId: item.revision.revisionId, mergedHash,
      }, db))()).toThrow('REVIEW_CYCLE_CONFLICT')
      expect(db.prepare('SELECT revision_status,merged_hash FROM review_cycles WHERE cycle_id=?').get(item.cycle.cycleId))
        .toEqual({ revision_status: 'generated', merged_hash: null })
    } finally { db.close() }
  })

  it('rolls the real merge rows and cycle state back with a later outer failure', () => {
    const db = fixture()
    try {
      const item = generatedCycle(db, 'merge-outer-rollback')
      expect(() => db.transaction(() => {
        const mergedHash = mergeRows(db, item, '事务内合并正文。')
        ReviewCycleRepository.commitMergedRevision({ revisionId: item.revision.revisionId, mergedHash }, db)
        throw new Error('later write failed')
      })()).toThrow('later write failed')
      const draft = db.prepare(`SELECT d.status,c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.id=?`)
        .get(item.seeded.draftId)
      expect(draft).toEqual({ status: 'draft', body: item.seeded.source })
      expect(db.prepare('SELECT status,merged_to_draft_id FROM revisions WHERE id=?').get(item.revision.revisionId))
        .toEqual({ status: 'pending', merged_to_draft_id: null })
      expect(db.prepare('SELECT revision_status,merged_hash FROM review_cycles WHERE cycle_id=?').get(item.cycle.cycleId))
        .toEqual({ revision_status: 'generated', merged_hash: null })
      expect(verifyM03ReviewCycle(db)).toBe(true)
    } finally { db.close() }
  })
})

describe('ReviewCycleRepository recheck state', () => {
  it.each([
    ['no-op', (source: string) => source],
    ['format-only', (source: string) => `${source}\n`],
    ['unrelated', (source: string) => `${source} 天色逐渐变暗。`],
  ])('does not request a model for %s evidence', (_name, merged) => {
    const db = fixture()
    try {
      const source = '开场时门闩松动，主角立即停步。'
      const item = mergedFindingCycle(db, `plan-${_name}`, merged(source))
      const before = db.prepare('SELECT * FROM review_cycles WHERE cycle_id=?').get(item.cycle.cycleId)
      const findings = db.prepare('SELECT * FROM review_findings WHERE cycle_id=? ORDER BY finding_id').all(item.cycle.cycleId)
      expect(ReviewCycleRepository.planRecheck(item.cycle.cycleId, db)).toEqual({ disposition: 'not-required',
        context: null, rootActionId: item.seeded.call.rootActionId, reviewId: item.seeded.reviewId })
      expect(db.prepare('SELECT * FROM review_cycles WHERE cycle_id=?').get(item.cycle.cycleId)).toEqual(before)
      expect(db.prepare('SELECT * FROM review_findings WHERE cycle_id=? ORDER BY finding_id').all(item.cycle.cycleId))
        .toEqual(findings)
    } finally { db.close() }
  })

  it('excludes unverified ambiguous anchors', () => {
    const db = fixture()
    try {
      const ambiguous = generatedCycle(db, 'plan-ambiguous', undefined, { source: '门闩松动，门闩松动。',
        preflight: [risk('fact:duplicate-latch', '门闩松动')] })
      const ambiguousHash = mergeRows(db, ambiguous, '门闩已经修好。')
      db.transaction(() => ReviewCycleRepository.commitMergedRevision({
        revisionId: ambiguous.revision.revisionId, mergedHash: ambiguousHash,
      }, db))()
      expect(ReviewCycleRepository.planRecheck(ambiguous.cycle.cycleId, db).disposition).toBe('not-required')
    } finally { db.close() }
  })

  it('plans only changed anchored evidence', () => {
    const db = fixture()
    try {
      const item = mergedFindingCycle(db, 'plan-required', '开场时门闩已修好，主角继续前进。')
      const plan = ReviewCycleRepository.planRecheck(item.cycle.cycleId, db)
      expect(plan.disposition).toBe('required')
      expect(plan.context).toMatchObject({ version: 2, cycleId: item.cycle.cycleId, mergedHash: item.mergedHash,
        findingSetHash: item.cycle.findingSetHash,
        findings: [{ targetId: 'fact:door-latch', kind: 'objective', category: '确定性一致性预检',
          problem: expect.stringContaining('事实冲突') }] })
      expect(plan.rootActionId).toBe(item.seeded.call.rootActionId)
      expect(plan.reviewId).toBe(item.seeded.reviewId)
    } finally { db.close() }
  })

  it.each([
    ['unresolved', false, 'unresolved', expect.stringMatching(/^[a-f0-9]{64}$/u)],
  ] as const)('commits one valid %s mapping without changing the immutable finding set', (_name, resolved, status, evidenceHash) => {
    const db = fixture()
    try {
      const item = mergedFindingCycle(db, `commit-${_name}`, '开场时门闩已修好，主角继续前进。')
      const plan = ReviewCycleRepository.planRecheck(item.cycle.cycleId, db)
      const finding = plan.context!.findings[0]!
      const attempt = seedRecheckAttempt(db, item, plan.context!, { key: `commit-${_name}`,
        mappings: [{ findingId: finding.findingId, targetId: finding.targetId, reviewItemIndex: 0, resolved }] })
      const beforeHash = db.prepare('SELECT finding_set_hash FROM review_cycles WHERE cycle_id=?').pluck().get(item.cycle.cycleId)
      const result = db.transaction(() => ReviewCycleRepository.commitRecheck(item.cycle.cycleId, attempt.attemptId, db))()
      expect(result).toEqual({ cycleId: item.cycle.cycleId, attemptId: attempt.attemptId,
        recheckCount: 1, idempotent: false })
      expect(db.prepare('SELECT status,evidence_hash FROM review_findings WHERE finding_id=?').get(finding.findingId))
        .toEqual({ status, evidence_hash: evidenceHash })
      expect(db.prepare('SELECT finding_set_hash,recheck_count,recheck_attempt_id FROM review_cycles WHERE cycle_id=?')
        .get(item.cycle.cycleId)).toEqual({ finding_set_hash: beforeHash, recheck_count: 1,
        recheck_attempt_id: attempt.attemptId })
      expect(ReviewCycleRepository.planRecheck(item.cycle.cycleId, db).disposition).toBe('completed')
      expect(verifyM03ReviewCycle(db)).toBe(true)
      const originalUsage = db.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=?')
        .pluck().get(attempt.attemptId) as string
      db.prepare("UPDATE generation_attempts SET usage_receipt_json=json_set(usage_receipt_json,'$.reviewCycleRecheck.version',1) WHERE attempt_id=?")
        .run(attempt.attemptId)
      expect(verifyM03ReviewCycle(db)).toBe(false)
      db.prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id=?').run(originalUsage, attempt.attemptId)
      expect(verifyM03ReviewCycle(db)).toBe(true)
      db.prepare("UPDATE review_findings SET status='unknown' WHERE finding_id=?").run(finding.findingId)
      expect(verifyM03ReviewCycle(db)).toBe(false)
    } finally { db.close() }
  })

  it('rejects a v2 model-positive mapping instead of persisting a false resolved state', () => {
    const db = fixture()
    try {
      const item = mergedFindingCycle(db, 'commit-model-positive', '开场时门闩已修好，主角继续前进。')
      const context = ReviewCycleRepository.planRecheck(item.cycle.cycleId, db).context!
      const finding = context.findings[0]!
      const attempt = seedRecheckAttempt(db, item, context, { key: 'commit-model-positive',
        mappings: [{ findingId: finding.findingId, targetId: finding.targetId, reviewItemIndex: 0, resolved: true }] })
      expect(() => db.transaction(() => ReviewCycleRepository.commitRecheck(item.cycle.cycleId, attempt.attemptId, db))())
        .toThrow('REVIEW_CYCLE_CONFLICT')
      expect(db.prepare('SELECT status,evidence_hash FROM review_findings WHERE finding_id=?').get(finding.findingId))
        .toEqual({ status: 'unresolved', evidence_hash: null })
      expect(verifyM03ReviewCycle(db)).toBe(true)
    } finally { db.close() }
  })

  it('degrades a missing receipt mapping to unknown', () => {
    const db = fixture()
    try {
      const item = mergedFindingCycle(db, 'unknown-missing', '开场时门闩已修好，主角继续前进。')
      const context = ReviewCycleRepository.planRecheck(item.cycle.cycleId, db).context!
      const finding = context.findings[0]!
      const attempt = seedRecheckAttempt(db, item, context, { key: 'unknown-missing', mappings: [] })
      db.transaction(() => ReviewCycleRepository.commitRecheck(item.cycle.cycleId, attempt.attemptId, db))()
      expect(db.prepare('SELECT status,evidence_hash FROM review_findings WHERE finding_id=?').get(finding.findingId))
        .toEqual({ status: 'unknown', evidence_hash: null })
      expect(verifyM03ReviewCycle(db)).toBe(true)
      db.prepare("UPDATE review_findings SET status='unresolved' WHERE finding_id=?").run(finding.findingId)
      expect(verifyM03ReviewCycle(db)).toBe(false)
    } finally { db.close() }
  })

  it('rejects a receipt mapping for the wrong stable target', () => {
    const db = fixture()
    try {
      const item = mergedFindingCycle(db, 'wrong-target', '开场时门闩已修好，主角继续前进。')
      const context = ReviewCycleRepository.planRecheck(item.cycle.cycleId, db).context!
      const finding = context.findings[0]!
      const attempt = seedRecheckAttempt(db, item, context, { key: 'wrong-target',
        mappings: [{ findingId: finding.findingId, targetId: 'fact:wrong', reviewItemIndex: 0, resolved: false }] })
      expect(() => db.transaction(() => ReviewCycleRepository.commitRecheck(item.cycle.cycleId, attempt.attemptId, db))())
        .toThrow('REVIEW_CYCLE_CONFLICT')
      expect(db.prepare('SELECT status,evidence_hash FROM review_findings WHERE finding_id=?').get(finding.findingId))
        .toEqual({ status: 'unresolved', evidence_hash: null })
      expect(verifyM03ReviewCycle(db)).toBe(true)
    } finally { db.close() }
  })

  it('keeps distinct findings for the same stable target independently unresolved', () => {
    const db = fixture()
    try {
      const item = generatedCycle(db, 'unknown-duplicate-target', undefined, { source: '门闩松动，主角立即停步。',
        preflight: [risk('fact:door-latch', '门闩松动'), risk('fact:door-latch', '主角立即停步')] })
      const mergedContent = '门闩已经修好，主角继续前进。'
      const mergedHash = mergeRows(db, item, mergedContent)
      db.transaction(() => ReviewCycleRepository.commitMergedRevision({ revisionId: item.revision.revisionId, mergedHash }, db))()
      const merged = { ...item, mergedContent, mergedHash }
      const context = ReviewCycleRepository.planRecheck(item.cycle.cycleId, db).context!
      expect(context.findings).toHaveLength(2)
      const mappings = context.findings.map((finding, reviewItemIndex) => ({ findingId: finding.findingId,
        targetId: finding.targetId, reviewItemIndex, resolved: false }))
      const attempt = seedRecheckAttempt(db, merged, context, { key: 'unknown-duplicate-target', mappings })
      db.transaction(() => ReviewCycleRepository.commitRecheck(item.cycle.cycleId, attempt.attemptId, db))()
      expect(db.prepare('SELECT status,evidence_hash FROM review_findings WHERE cycle_id=? ORDER BY finding_id')
        .all(item.cycle.cycleId)).toEqual([
        { status: 'unverified', evidence_hash: null }, { status: 'unverified', evidence_hash: null },
        { status: 'unresolved', evidence_hash: expect.stringMatching(/^[a-f0-9]{64}$/u) },
        { status: 'unresolved', evidence_hash: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      ])
      expect(verifyM03ReviewCycle(db)).toBe(true)
    } finally { db.close() }
  })

  it('fails closed and rolls back when a duplicate mapping cannot pass the central verifier', () => {
    const db = fixture()
    try {
      const item = mergedFindingCycle(db, 'unknown-duplicate-mapping', '开场时门闩已修好，主角继续前进。')
      const context = ReviewCycleRepository.planRecheck(item.cycle.cycleId, db).context!
      const finding = context.findings[0]!
      const duplicate = { findingId: finding.findingId, targetId: finding.targetId, reviewItemIndex: 0, resolved: true }
      const attempt = seedRecheckAttempt(db, item, context, { key: 'unknown-duplicate-mapping',
        mappings: [duplicate, duplicate] })
      expect(() => db.transaction(() => ReviewCycleRepository.commitRecheck(
        item.cycle.cycleId, attempt.attemptId, db))()).toThrow('REVIEW_CYCLE_CONFLICT')
      expect(db.prepare('SELECT status,evidence_hash FROM review_findings WHERE finding_id=?').get(finding.findingId))
        .toEqual({ status: 'unresolved', evidence_hash: null })
      expect(db.prepare('SELECT recheck_count,recheck_attempt_id FROM review_cycles WHERE cycle_id=?').get(item.cycle.cycleId))
        .toEqual({ recheck_count: 0, recheck_attempt_id: null })
      expect(verifyM03ReviewCycle(db)).toBe(true)
    } finally { db.close() }
  })

  it('is idempotent for the same attempt and rejects a second attempt', () => {
    const db = fixture()
    try {
      const item = mergedFindingCycle(db, 'recheck-idempotent', '开场时门闩已修好，主角继续前进。')
      const context = ReviewCycleRepository.planRecheck(item.cycle.cycleId, db).context!
      const finding = context.findings[0]!
      const first = seedRecheckAttempt(db, item, context, { key: 'recheck-idempotent-first',
        mappings: [{ findingId: finding.findingId, targetId: finding.targetId, reviewItemIndex: 0, resolved: false }] })
      const second = seedRecheckAttempt(db, item, context, { key: 'recheck-idempotent-second', mappings: [] })
      db.transaction(() => ReviewCycleRepository.commitRecheck(item.cycle.cycleId, first.attemptId, db))()
      expect(db.transaction(() => ReviewCycleRepository.commitRecheck(item.cycle.cycleId, first.attemptId, db))())
        .toEqual({ cycleId: item.cycle.cycleId, attemptId: first.attemptId, recheckCount: 1, idempotent: true })
      expect(() => db.transaction(() => ReviewCycleRepository.commitRecheck(item.cycle.cycleId, second.attemptId, db))())
        .toThrow('REVIEW_CYCLE_CONFLICT')
      expect(verifyM03ReviewCycle(db)).toBe(true)
    } finally { db.close() }
  })

  it('fails closed for a wrong cycle state', () => {
    const db = fixture()
    try {
      const generated = generatedCycle(db, 'recheck-wrong-state')
      expect(() => ReviewCycleRepository.planRecheck(generated.cycle.cycleId, db)).toThrow('REVIEW_CYCLE_CONFLICT')
    } finally { db.close() }
  })

  it('fails closed for wrong hash, root, and receipt hash', () => {
    const db = fixture()
    try {
      const item = mergedFindingCycle(db, 'recheck-fail-closed', '开场时门闩已修好，主角继续前进。')
      const context = ReviewCycleRepository.planRecheck(item.cycle.cycleId, db).context!
      const finding = context.findings[0]!
      const wrongRoot = `${item.seeded.call.rootActionId}-wrong`
      const attempt = seedRecheckAttempt(db, item, context, { key: 'recheck-wrong-root', rootActionId: wrongRoot,
        mappings: [{ findingId: finding.findingId, targetId: finding.targetId, reviewItemIndex: 0, resolved: true }] })
      expect(() => db.transaction(() => ReviewCycleRepository.commitRecheck(item.cycle.cycleId, attempt.attemptId, db))())
        .toThrow('REVIEW_CYCLE_CONFLICT')
      const valid = seedRecheckAttempt(db, item, context, { key: 'recheck-wrong-hash', mappings: [] })
      const usage = JSON.parse(db.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=?')
        .pluck().get(valid.attemptId) as string) as { reviewCycleRecheck: { mergedHash: string } }
      usage.reviewCycleRecheck.mergedHash = hash('wrong')
      db.prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id=?').run(JSON.stringify(usage), valid.attemptId)
      expect(() => db.transaction(() => ReviewCycleRepository.commitRecheck(item.cycle.cycleId, valid.attemptId, db))())
        .toThrow('REVIEW_CYCLE_CONFLICT')
      expect(db.prepare('SELECT recheck_count,recheck_attempt_id FROM review_cycles WHERE cycle_id=?').get(item.cycle.cycleId))
        .toEqual({ recheck_count: 0, recheck_attempt_id: null })
      db.prepare('UPDATE review_cycles SET merged_hash=? WHERE cycle_id=?').run(hash('tampered'), item.cycle.cycleId)
      expect(() => ReviewCycleRepository.planRecheck(item.cycle.cycleId, db)).toThrow('REVIEW_CYCLE_CONFLICT')
    } finally { db.close() }
  })

  it('rolls the finding and cycle updates back with a later outer failure', () => {
    const db = fixture()
    try {
      const item = mergedFindingCycle(db, 'recheck-rollback', '开场时门闩已修好，主角继续前进。')
      const context = ReviewCycleRepository.planRecheck(item.cycle.cycleId, db).context!
      const finding = context.findings[0]!
      const attempt = seedRecheckAttempt(db, item, context, { key: 'recheck-rollback',
        mappings: [{ findingId: finding.findingId, targetId: finding.targetId, reviewItemIndex: 0, resolved: false }] })
      expect(() => db.transaction(() => {
        ReviewCycleRepository.commitRecheck(item.cycle.cycleId, attempt.attemptId, db)
        throw new Error('later write failed')
      })()).toThrow('later write failed')
      expect(db.prepare('SELECT status,evidence_hash FROM review_findings WHERE finding_id=?').get(finding.findingId))
        .toEqual({ status: 'unresolved', evidence_hash: null })
      expect(db.prepare('SELECT recheck_count,recheck_attempt_id FROM review_cycles WHERE cycle_id=?').get(item.cycle.cycleId))
        .toEqual({ recheck_count: 0, recheck_attempt_id: null })
      expect(verifyM03ReviewCycle(db)).toBe(true)
    } finally { db.close() }
  })
})
