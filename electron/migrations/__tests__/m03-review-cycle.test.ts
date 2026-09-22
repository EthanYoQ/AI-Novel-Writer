import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { initializeLegacyBaselineSchema } from '../baseline-schema'
import { M01_GENERATION_SQL } from '../m01-generation-runs'
import { applyM03ReviewCycle, canonicalM03FindingSetHash, createM03Migration, verifyM03ReviewCycle,
  type M03FindingDescriptor } from '../m03-review-cycle'
import { buildReviewGenerationReport } from '../../../src/shared/review-generation-report'
import { buildReviewCycleRecheckReport, type ReviewCycleRecheckContext } from '../../../src/shared/review-cycle'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function fixture() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys=ON')
  db.transaction(() => { initializeLegacyBaselineSchema(db); db.exec(M01_GENERATION_SQL) })()
  return db
}
function content(db: import('better-sqlite3').Database, body: string): number {
  return Number(db.prepare('INSERT INTO contents(body) VALUES(?)').run(body).lastInsertRowid)
}
function attempt(db: import('better-sqlite3').Database, root: string, id: string, input: {
  kind: 'review' | 'revision'; entityId: number; index: number; contentHash: string; source: string
  sourceId: number; sourceChapterNumber?: number; sourceVersion?: number; sourceStatus?: 'draft' | 'revised'
  artifactText: string; confirmation?: object; recheck?: ReviewCycleRecheckContext; reviewCycleRecheck?: object
}): void {
  const operation = input.kind === 'review' ? 'review-chapter' : 'refine-from-review'
  const context = { version: 1, operation, sourceHash: hash(input.source),
    source: { id: input.sourceId, chapterNumber: input.sourceChapterNumber ?? 1, version: input.sourceVersion ?? 1,
      status: input.sourceStatus ?? 'draft', content: input.source },
    config: {}, writingLanguage: 'zh-CN', uiLocale: 'zh-CN', authorInputs: [], characterStates: '（暂无）', worldbuilding: '',
    history: [], blueprints: [], frozenGoals: { chapterNumber: 1, coverage: 'not_configured', items: [] }, preflightFindings: [],
    ...(input.confirmation ? { confirmation: input.confirmation } : {}), ...(input.recheck ? { recheck: input.recheck } : {}) }
  const fingerprint = Object.fromEntries(['chapterBriefHash', 'authorGuidanceHash', 'dependencyHash', 'contextSnapshotHash',
    'templateHash', 'skillSnapshotHash', 'modelLeaseRevision', 'policyHash', 'outputContractHash'].map((key, index) => [key, hash(`${id}:${index}`)]))
  const binding = { projectId: 'project', epoch: 'epoch', fingerprint, contextSnapshotId: `context-${id}`,
    sourceManifest: { operation, reviewRevisionContext: context, reviewRevisionContextHash: hash(JSON.stringify(context)),
      authorInputs: [{ id: 'review-revision-context', text: JSON.stringify(context) }] }, sourceRefs: [] }
  db.prepare('INSERT OR IGNORE INTO generation_roots(root_action_id,idempotency_key,action_json,budget_json) VALUES(?,?,?,?)')
    .run(root, `key-${root}`, JSON.stringify({ projectId: 'project', epoch: 'epoch', operation, uiActionNonce: id,
      frozenInputHash: hash(id), rootActionId: root, status: 'active' }), '{}')
  db.prepare('INSERT OR IGNORE INTO generation_runs(run_id,root_action_id,binding_json,status,created_at_ms,open_key) VALUES(?,?,?,?,?,?)')
    .run(`run-${id}`, root, JSON.stringify(binding), 'completed', 1, `open-${id}`)
  const artifact = { artifactId: `artifact-${id}`, attemptId: id, rootActionId: root, projectId: 'project', epoch: 'epoch',
    fingerprint, revision: 1, text: input.artifactText, textHash: hash(input.artifactText) }
  const artifactRef = { artifactId: artifact.artifactId, revision: artifact.revision, textHash: artifact.textHash }
  const effect = { kind: input.kind, id: input.entityId, index: input.index, contentHash: input.contentHash,
    contextHash: hash(JSON.stringify(context)), artifact: artifactRef,
    ...(input.kind === 'revision' ? { compositionHash: input.contentHash } : {}) }
  const usage = { artifactIdentity: { artifactId: artifact.artifactId, epoch: artifact.epoch, fingerprint },
    result: { usage: null, finishReason: 'stop' }, reviewRevisionEffect: effect,
    ...(input.kind === 'revision' ? { visibleComposition: { algorithm: 'visible-append-v1', textHash: input.contentHash,
      artifactIds: [artifact.artifactId], sources: [artifactRef] } } : {}),
    ...(input.reviewCycleRecheck ? { reviewCycleRecheck: input.reviewCycleRecheck } : {}) }
  db.prepare('INSERT INTO generation_attempts(attempt_id,reservation_id,run_id,root_action_id,attempt_json,usage_receipt_json,invocation_nonce) VALUES(?,?,?,?,?,?,?)')
    .run(id, `reservation-${id}`, `run-${id}`, root, JSON.stringify({ attemptId: id, reservationId: `reservation-${id}`,
      rootActionId: root, status: 'settled', reservedTokens: 100, requestedOutputTokens: 100, actualTokens: 1 }), JSON.stringify(usage), `nonce-${id}`)
  db.prepare('INSERT INTO generation_artifacts(artifact_id,attempt_id,run_id,artifact_json,revision,status) VALUES(?,?,?,?,?,?)')
    .run(artifact.artifactId, id, `run-${id}`, JSON.stringify(artifact), artifact.revision, 'partial')
}

function seedValid(db: import('better-sqlite3').Database) {
  const source = '甲推开门，雨水顺着袖口落下。'
  const reviewArtifactText = JSON.stringify({ summary: '发现一处连续性问题。',
    items: [{ category: 'continuity', severity: 'warning', description: '门闩状态需确认。', quote: '甲推开门' }] })
  const reviewBody = JSON.stringify(buildReviewGenerationReport({ content: reviewArtifactText, sourceContent: source,
    frozenGoals: { chapterNumber: 1, coverage: 'not_configured', items: [] }, writingLanguage: 'zh-CN', uiLocale: 'zh-CN',
    preflightFindings: [] }), null, 2)
  const draftId = Number(db.prepare("INSERT INTO drafts(chapter_number,version,status,content_id) VALUES(1,1,'draft',?)").run(content(db, source)).lastInsertRowid)
  const reviewId = Number(db.prepare(`INSERT INTO reviews(base_draft_id,review_index,source_draft_chapter_number,source_draft_version,source_draft_status,source_content,content_id)
    VALUES(?,1,1,1,'draft',?,?)`).run(draftId, source, content(db, reviewBody)).lastInsertRowid)
  const confirmationBody = JSON.stringify({ kind: 'human-confirmed-review', schemaVersion: 1, sourceReviewId: reviewId,
    sourceDraft: { id: draftId, chapterNumber: 1, version: 1, status: 'draft', content: source }, summary: '', authorGuidance: '',
    items: [{ category: 'continuity', severity: 'warning', description: '纳入修稿', stableFactKey: 'target-1', decision: 'apply', origin: 'ai' }] }, null, 2)
  const confirmationId = Number(db.prepare(`INSERT INTO reviews(base_draft_id,review_index,source_draft_chapter_number,source_draft_version,source_draft_status,source_content,content_id)
    VALUES(?,2,1,1,'draft',?,?)`).run(draftId, source, content(db, confirmationBody)).lastInsertRowid)
  const revisionBody = '甲推开门，先抖落袖口的雨水。'
  const revisionId = Number(db.prepare(`INSERT INTO revisions(base_draft_id,revision_index,revision_type,status,user_prompt,review_source_id,
    source_draft_chapter_number,source_draft_version,source_draft_status,source_content,content_id) VALUES(?,1,'review-fix','pending','',?,1,1,'draft',?,?)`)
    .run(draftId, confirmationId, source, content(db, revisionBody)).lastInsertRowid)
  const root = 'root-1'
  attempt(db, root, 'attempt-review', { kind: 'review', entityId: reviewId, index: 1, contentHash: hash(reviewBody),
    source, sourceId: draftId, artifactText: reviewArtifactText })
  attempt(db, root, 'attempt-revision', { kind: 'revision', entityId: revisionId, index: 1, contentHash: hash(revisionBody),
    source, sourceId: draftId, artifactText: revisionBody, confirmation: { reviewSourceId: confirmationId, content: confirmationBody,
      originalReviewContentHash: hash(reviewBody), snapshot: JSON.parse(confirmationBody) } })
  const finding: M03FindingDescriptor = { findingId: 'finding-1', source: { projectId: 'project', epoch: 'epoch',
    sourceId: `draft:${draftId}`, revision: 1, contentHash: hash(source), span: { start: 0, end: 1, unit: 'utf16-code-unit' } },
  excerptHash: hash('甲'), occurrence: 1, category: 'continuity', targetId: 'target-1', kind: 'objective',
  problemText: '门闩状态与权威事实冲突', expectedText: null,
  status: 'unresolved', evidenceHash: null, confirmationItemIndex: null }
  db.prepare(`INSERT INTO review_cycles VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('cycle-1', root, reviewId, hash(reviewBody),
    confirmationId, hash(confirmationBody), revisionId, hash(source), canonicalM03FindingSetHash([finding]), 1, 'generated', null, 0, null)
  db.prepare(`INSERT INTO review_findings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('cycle-1', finding.findingId,
    finding.source.projectId, finding.source.epoch, finding.source.sourceId, finding.source.revision, finding.source.contentHash,
    finding.source.span!.start, finding.source.span!.end, finding.source.span!.unit, finding.excerptHash, finding.occurrence,
    finding.category, finding.targetId, finding.kind, finding.problemText, finding.expectedText,
    finding.status, finding.evidenceHash, finding.confirmationItemIndex)
  return { source, reviewBody, draftId, reviewId, confirmationId, revisionId, root }
}

function rewriteRevisionConfirmationProof(db: import('better-sqlite3').Database, confirmationBody: string): void {
  const binding = JSON.parse(db.prepare("SELECT binding_json FROM generation_runs WHERE run_id='run-attempt-revision'")
    .pluck().get() as string) as { sourceManifest: { reviewRevisionContext: {
      confirmation: { content: string; snapshot: Record<string, unknown> }
    }; reviewRevisionContextHash: string; authorInputs: Array<{ id: string; text: string }> } }
  binding.sourceManifest.reviewRevisionContext.confirmation.content = confirmationBody
  binding.sourceManifest.reviewRevisionContext.confirmation.snapshot = JSON.parse(confirmationBody) as Record<string, unknown>
  const contextJson = JSON.stringify(binding.sourceManifest.reviewRevisionContext)
  const contextHash = hash(contextJson)
  binding.sourceManifest.reviewRevisionContextHash = contextHash
  binding.sourceManifest.authorInputs = [{ id: 'review-revision-context', text: contextJson }]
  const usage = JSON.parse(db.prepare("SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id='attempt-revision'")
    .pluck().get() as string) as { reviewRevisionEffect: { contextHash: string } }
  usage.reviewRevisionEffect.contextHash = contextHash
  db.prepare("UPDATE generation_runs SET binding_json=? WHERE run_id='run-attempt-revision'").run(JSON.stringify(binding))
  db.prepare("UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id='attempt-revision'").run(JSON.stringify(usage))
}

describe('M03 review cycle migration', () => {
  it('requires the central transaction and creates empty tables without backfilling or changing old rows', () => {
    const db = fixture()
    try {
      db.exec("INSERT INTO contents(body) VALUES('old'); INSERT INTO drafts(chapter_number,version,content_id) VALUES(1,1,1); INSERT INTO reviews(base_draft_id,review_index,content_id) VALUES(1,1,1)")
      const before = db.prepare('SELECT * FROM reviews').all()
      expect(() => applyM03ReviewCycle(db)).toThrow('REVIEW_CYCLE_MIGRATION_TRANSACTION_REQUIRED')
      db.transaction(() => applyM03ReviewCycle(db))()
      expect(db.prepare('SELECT * FROM reviews').all()).toEqual(before)
      expect(db.prepare('SELECT COUNT(*) FROM review_cycles').pluck().get()).toBe(0)
      expect(db.prepare('SELECT COUNT(*) FROM review_findings').pluck().get()).toBe(0)
      expect(verifyM03ReviewCycle(db)).toBe(true)
    } finally { db.close() }
  })

  it('accepts a complete same-root review, confirmation, revision and finding proof', () => {
    const db = fixture()
    try { db.transaction(() => applyM03ReviewCycle(db))(); seedValid(db); expect(verifyM03ReviewCycle(db)).toBe(true) }
    finally { db.close() }
  })

  it.each([
    ['missing effect index', "UPDATE generation_attempts SET usage_receipt_json=json_remove(usage_receipt_json,'$.reviewRevisionEffect.index') WHERE attempt_id='attempt-review'"],
    ['missing terminal artifact', "DELETE FROM generation_artifacts WHERE attempt_id='attempt-review'"],
    ['missing revision composition', "UPDATE generation_attempts SET usage_receipt_json=json_remove(usage_receipt_json,'$.visibleComposition') WHERE attempt_id='attempt-revision'"],
  ])('rejects a production-impossible review/revision effect: %s', (_label, sql) => {
    const db = fixture()
    try {
      db.transaction(() => applyM03ReviewCycle(db))(); seedValid(db)
      expect(verifyM03ReviewCycle(db)).toBe(true)
      db.exec(sql)
      expect(verifyM03ReviewCycle(db)).toBe(false)
    } finally { db.close() }
  })

  it('rejects a valid review artifact whose rebuilt production report differs from the saved review', () => {
    const db = fixture()
    try {
      db.transaction(() => applyM03ReviewCycle(db))(); seedValid(db)
      const changed = JSON.stringify({ summary: '另一份合法审稿。',
        items: [{ category: 'continuity', severity: 'pass', description: '未发现连续性问题。' }] })
      const artifact = JSON.parse(db.prepare("SELECT artifact_json FROM generation_artifacts WHERE attempt_id='attempt-review'")
        .pluck().get() as string) as Record<string, unknown>
      artifact.text = changed
      artifact.textHash = hash(changed)
      db.prepare("UPDATE generation_artifacts SET artifact_json=? WHERE attempt_id='attempt-review'").run(JSON.stringify(artifact))
      const receipt = JSON.parse(db.prepare("SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id='attempt-review'")
        .pluck().get() as string) as { reviewRevisionEffect: { artifact: { textHash: string } } }
      receipt.reviewRevisionEffect.artifact.textHash = hash(changed)
      db.prepare("UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id='attempt-review'").run(JSON.stringify(receipt))
      expect(verifyM03ReviewCycle(db)).toBe(false)
    } finally { db.close() }
  })

  it('rejects a revision composition with a foreign-run artifact prefix even when its terminal receipt still matches', () => {
    const db = fixture()
    try {
      db.transaction(() => applyM03ReviewCycle(db))(); seedValid(db)
      const receipt = JSON.parse(db.prepare("SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id='attempt-revision'")
        .pluck().get() as string) as { visibleComposition: { artifactIds: string[] } }
      receipt.visibleComposition.artifactIds.unshift('artifact-attempt-review')
      db.prepare("UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id='attempt-revision'").run(JSON.stringify(receipt))
      expect(verifyM03ReviewCycle(db)).toBe(false)
    } finally { db.close() }
  })

  it('rejects a self-consistent revision effect whose frozen confirmation content differs from the persisted confirmation', () => {
    const db = fixture()
    try {
      db.transaction(() => applyM03ReviewCycle(db))(); seedValid(db)
      const binding = JSON.parse(db.prepare("SELECT binding_json FROM generation_runs WHERE run_id='run-attempt-revision'")
        .pluck().get() as string) as { sourceManifest: { reviewRevisionContext: {
          confirmation: { content: string; snapshot: Record<string, unknown> }
        }; reviewRevisionContextHash: string; authorInputs: Array<{ id: string; text: string }> } }
      const confirmation = binding.sourceManifest.reviewRevisionContext.confirmation
      const different = { ...JSON.parse(confirmation.content) as Record<string, unknown>, summary: '另一份作者确认' }
      confirmation.content = JSON.stringify(different, null, 2)
      confirmation.snapshot = different
      const contextJson = JSON.stringify(binding.sourceManifest.reviewRevisionContext)
      const contextHash = hash(contextJson)
      binding.sourceManifest.reviewRevisionContextHash = contextHash
      binding.sourceManifest.authorInputs = [{ id: 'review-revision-context', text: contextJson }]
      const usage = JSON.parse(db.prepare("SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id='attempt-revision'")
        .pluck().get() as string) as { reviewRevisionEffect: { contextHash: string } }
      usage.reviewRevisionEffect.contextHash = contextHash
      db.prepare("UPDATE generation_runs SET binding_json=? WHERE run_id='run-attempt-revision'").run(JSON.stringify(binding))
      db.prepare("UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id='attempt-revision'").run(JSON.stringify(usage))
      expect(verifyM03ReviewCycle(db)).toBe(false)
    } finally { db.close() }
  })

  it('hashes only explicit immutable fields independent of nested property and finding order', () => {
    const first = { findingId: 'b', source: { projectId: 'project', epoch: 'epoch', sourceId: 'draft:1', revision: 1,
      contentHash: 'a'.repeat(64), span: { start: 0, end: 1, unit: 'utf16-code-unit' as const } }, excerptHash: 'b'.repeat(64),
    occurrence: 1, category: 'fact', targetId: 'target-b', kind: 'objective' as const,
    problemText: '事实冲突', expectedText: null, status: 'unresolved' as const,
    evidenceHash: null, confirmationItemIndex: null }
    const reordered = { ...first, source: { span: { unit: 'utf16-code-unit' as const, end: 1, start: 0 },
      contentHash: 'a'.repeat(64), revision: 1, sourceId: 'draft:1', epoch: 'epoch', projectId: 'project' } }
    const second = { ...first, findingId: 'a', targetId: 'target-a' }
    expect(canonicalM03FindingSetHash([first, second])).toBe(canonicalM03FindingSetHash([second, reordered]))
  })

  it('cascades cycles and findings when the owning draft or reviews are deleted', () => {
    for (const deleteSql of ['DELETE FROM drafts', 'DELETE FROM reviews']) {
      const db = fixture()
      try {
        db.transaction(() => applyM03ReviewCycle(db))(); seedValid(db)
        db.exec(deleteSql)
        expect(db.prepare('SELECT COUNT(*) FROM review_cycles').pluck().get()).toBe(0)
        expect(db.prepare('SELECT COUNT(*) FROM review_findings').pluck().get()).toBe(0)
        expect(db.pragma('foreign_key_check')).toEqual([])
      } finally { db.close() }
    }
  })

  it('rejects an empty database whose installed M03 schema proof was damaged', () => {
    const db = fixture()
    try {
      db.transaction(() => applyM03ReviewCycle(db))()
      expect(verifyM03ReviewCycle(db)).toBe(true)
      db.exec('ALTER TABLE review_cycles ADD COLUMN unauthorized_projection TEXT')
      expect(verifyM03ReviewCycle(db)).toBe(false)
    } finally { db.close() }
  })

  it('accepts an explicitly null unverified anchor without fabricating a target', () => {
    const db = fixture()
    try {
      db.transaction(() => applyM03ReviewCycle(db))()
      const { reviewId, reviewBody, root, source } = seedValid(db)
      db.exec('DELETE FROM review_findings; DELETE FROM review_cycles')
      const finding: M03FindingDescriptor = { findingId: 'uncertain', source: { projectId: 'project', epoch: 'epoch', sourceId: 'draft:1', revision: 1,
        contentHash: hash(source), span: null }, excerptHash: null, occurrence: null, category: 'continuity', targetId: null,
      kind: 'objective', problemText: '证据无法唯一定位', expectedText: null,
      status: 'unverified', evidenceHash: null, confirmationItemIndex: null }
      db.prepare('INSERT INTO review_cycles VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('cycle-u', root, reviewId, hash(reviewBody), null, null, null,
        hash(source), canonicalM03FindingSetHash([finding]), 1, 'not-generated', null, 0, null)
      db.prepare('INSERT INTO review_findings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('cycle-u', finding.findingId,
        finding.source.projectId, finding.source.epoch, finding.source.sourceId, finding.source.revision, finding.source.contentHash,
        null, null, null, null, null, finding.category, null, finding.kind, finding.problemText, finding.expectedText,
        finding.status, null, null)
      expect(verifyM03ReviewCycle(db)).toBe(true)
    } finally { db.close() }
  })

  it('requires an explicit v2 cycle/finding waiver identity and never treats v1 ignore as waived', () => {
    const db = fixture()
    try {
      db.transaction(() => applyM03ReviewCycle(db))()
      const seeded = seedValid(db)
      const waiver = JSON.stringify({ kind: 'human-confirmed-review', schemaVersion: 2, cycleId: 'cycle-1', sourceReviewId: seeded.reviewId,
        sourceDraft: { id: 1, chapterNumber: 1, version: 1, status: 'draft', content: seeded.source }, summary: '', authorGuidance: '',
        items: [{ findingId: 'finding-1', category: 'continuity', severity: 'warning', description: '作者带建议完成',
          decision: 'waive', origin: 'ai' }] }, null, 2)
      db.prepare('UPDATE contents SET body=? WHERE id=(SELECT content_id FROM reviews WHERE id=?)').run(waiver, seeded.confirmationId)
      db.prepare('UPDATE review_cycles SET confirmation_content_hash=?').run(hash(waiver))
      db.prepare("UPDATE review_findings SET status='author-waived',evidence_hash=?,confirmation_item_index=0").run(hash(waiver))
      rewriteRevisionConfirmationProof(db, waiver)
      expect(verifyM03ReviewCycle(db)).toBe(true)
      const legacyIgnore = waiver.replace('"schemaVersion": 2', '"schemaVersion": 1').replace('"decision": "waive"', '"decision": "ignore"')
      db.prepare('UPDATE contents SET body=? WHERE id=(SELECT content_id FROM reviews WHERE id=?)').run(legacyIgnore, seeded.confirmationId)
      db.prepare('UPDATE review_cycles SET confirmation_content_hash=?').run(hash(legacyIgnore))
      db.prepare('UPDATE review_findings SET evidence_hash=?').run(hash(legacyIgnore))
      rewriteRevisionConfirmationProof(db, legacyIgnore)
      expect(verifyM03ReviewCycle(db)).toBe(false)
    } finally { db.close() }
  })

  it('accepts one same-root recheck bound to the merged hash and new finding evidence', () => {
    const db = fixture()
    try {
      db.transaction(() => applyM03ReviewCycle(db))()
      const seeded = seedValid(db), merged = '甲推开门，先抖落袖口的雨水，再确认门闩完好。'
      const excerpt = '雨水顺着袖口落下'
      const start = seeded.source.indexOf(excerpt)
      const finding: M03FindingDescriptor = { findingId: 'finding-1', source: { projectId: 'project', epoch: 'epoch',
        sourceId: `draft:${seeded.draftId}`, revision: 1, contentHash: hash(seeded.source),
        span: { start, end: start + excerpt.length, unit: 'utf16-code-unit' } }, excerptHash: hash(excerpt), occurrence: 1,
      category: 'continuity', targetId: 'target-1', kind: 'objective', problemText: '门闩仍然敞开',
      expectedText: '门闩必须保持关闭', status: 'unresolved', evidenceHash: null,
      confirmationItemIndex: null }
      const findingSetHash = canonicalM03FindingSetHash([finding])
      const recheckContext: ReviewCycleRecheckContext = { version: 1, cycleId: 'cycle-1', comparisonVersion: 1,
        mergedHash: hash(merged), findingSetHash, findings: [{ findingId: 'finding-1', targetId: 'target-1',
          category: 'continuity', kind: 'objective', problem: finding.problemText, expected: finding.expectedText!,
          sourceSpan: finding.source.span!, occurrence: 1,
          sourceExcerpt: excerpt }] }
      const recheckArtifactText = JSON.stringify({ summary: '连续性问题已解决。',
        items: [{ findingId: 'finding-1', targetId: 'target-1', resolved: true, evidenceQuote: '再确认门闩完好',
          reason: '合并稿已明确门闩完好。' }] })
      const built = buildReviewCycleRecheckReport(recheckArtifactText, merged, recheckContext, 'zh-CN')
      const recheckBody = JSON.stringify({ summary: built.summary, items: built.items }, null, 2)
      const reviewItem = (JSON.parse(recheckBody) as { items: unknown[] }).items[0]
      const evidenceHash = hash(JSON.stringify({ findingId: 'finding-1', targetId: 'target-1', reviewItemIndex: 0,
        item: reviewItem, resolved: true }))
      const recheck = { version: 1, cycleId: 'cycle-1', comparisonVersion: 1, mergedHash: hash(merged), findingSetHash,
        findings: [{ findingId: 'finding-1', targetId: 'target-1', reviewItemIndex: 0, evidenceHash, resolved: true }] }
      db.prepare("UPDATE contents SET body=? WHERE id=(SELECT content_id FROM drafts WHERE id=?)").run(merged, seeded.draftId)
      db.prepare("UPDATE drafts SET status='revised' WHERE id=?").run(seeded.draftId)
      db.prepare("UPDATE revisions SET status='merged',merged_to_draft_id=? WHERE id=?").run(seeded.draftId, seeded.revisionId)
      const recheckReviewId = Number(db.prepare(`INSERT INTO reviews(base_draft_id,review_index,source_draft_chapter_number,source_draft_version,source_draft_status,source_content,content_id)
        VALUES(?,3,1,1,'revised',?,?)`).run(seeded.draftId, merged, content(db, recheckBody)).lastInsertRowid)
      attempt(db, seeded.root, 'attempt-recheck', { kind: 'review', entityId: recheckReviewId, index: 3,
        contentHash: hash(recheckBody), source: merged, sourceId: seeded.draftId,
        sourceStatus: 'revised', artifactText: recheckArtifactText, recheck: recheckContext, reviewCycleRecheck: recheck })
      db.prepare(`UPDATE review_cycles SET revision_status='merge-committed',merged_hash=?,recheck_count=1,recheck_attempt_id=?,finding_set_hash=? WHERE cycle_id='cycle-1'`)
        .run(hash(merged), 'attempt-recheck', findingSetHash)
      db.prepare(`UPDATE review_findings SET span_start=?,span_end=?,excerpt_hash=?,occurrence=1,problem_text=?,expected_text=?,
        status='resolved',evidence_hash=?,confirmation_item_index=NULL WHERE cycle_id='cycle-1'`)
        .run(start, start + excerpt.length, hash(excerpt), finding.problemText, finding.expectedText, evidenceHash)
      expect(verifyM03ReviewCycle(db)).toBe(true)
      db.prepare("UPDATE review_findings SET evidence_hash=? WHERE cycle_id='cycle-1'").run('c'.repeat(64))
      expect(verifyM03ReviewCycle(db)).toBe(false)
      db.prepare("UPDATE review_findings SET evidence_hash=? WHERE cycle_id='cycle-1'").run(evidenceHash)
      expect(verifyM03ReviewCycle(db)).toBe(true)
      const originalReceipt = db.prepare("SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id='attempt-recheck'").pluck().get() as string
      db.prepare("UPDATE generation_attempts SET usage_receipt_json=json_set(usage_receipt_json,'$.reviewCycleRecheck.mergedHash',?) WHERE attempt_id='attempt-recheck'")
        .run('d'.repeat(64))
      expect(verifyM03ReviewCycle(db)).toBe(false)
      db.prepare("UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id='attempt-recheck'").run(originalReceipt)
      expect(verifyM03ReviewCycle(db)).toBe(true)
      const originalBinding = db.prepare("SELECT binding_json FROM generation_runs WHERE run_id='run-attempt-recheck'").pluck().get() as string
      const binding = JSON.parse(originalBinding) as { sourceManifest: { reviewRevisionContext: { source: { version: number; status: string } };
        reviewRevisionContextHash: string; authorInputs: Array<{ id: string; text: string }> } }
      binding.sourceManifest.reviewRevisionContext.source.version = 2
      binding.sourceManifest.reviewRevisionContext.source.status = 'draft'
      const contextJson = JSON.stringify(binding.sourceManifest.reviewRevisionContext)
      const contextHash = hash(contextJson)
      binding.sourceManifest.reviewRevisionContextHash = contextHash
      binding.sourceManifest.authorInputs = [{ id: 'review-revision-context', text: contextJson }]
      const mismatchedReceipt = JSON.parse(originalReceipt) as { reviewRevisionEffect: { contextHash: string } }
      mismatchedReceipt.reviewRevisionEffect.contextHash = contextHash
      db.prepare("UPDATE generation_runs SET binding_json=? WHERE run_id='run-attempt-recheck'").run(JSON.stringify(binding))
      db.prepare("UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id='attempt-recheck'").run(JSON.stringify(mismatchedReceipt))
      expect(verifyM03ReviewCycle(db)).toBe(false)
      db.prepare("UPDATE generation_runs SET binding_json=? WHERE run_id='run-attempt-recheck'").run(originalBinding)
      db.prepare("UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id='attempt-recheck'").run(originalReceipt)
      expect(verifyM03ReviewCycle(db)).toBe(true)
      db.prepare("UPDATE reviews SET source_content='wrong' WHERE id=?").run(recheckReviewId)
      expect(verifyM03ReviewCycle(db)).toBe(false)
    } finally { db.close() }
  })

  it.each([
    ['review body changed', "UPDATE contents SET body='changed' WHERE id=(SELECT content_id FROM reviews WHERE id=(SELECT review_id FROM review_cycles))"],
    ['finding source hash changed', "UPDATE review_findings SET source_content_hash='" + 'b'.repeat(64) + "'"],
    ['UTF-16 excerpt changed', "UPDATE review_findings SET excerpt_hash='" + 'b'.repeat(64) + "'"],
    ['finding set hash changed', "UPDATE review_cycles SET finding_set_hash='" + 'b'.repeat(64) + "'"],
    ['revision root changed', "UPDATE generation_attempts SET root_action_id='other-root' WHERE attempt_id='attempt-revision'"],
    ['confirmation source changed', "UPDATE contents SET body=replace(body, '\"sourceReviewId\": 1', '\"sourceReviewId\": 999') WHERE id=(SELECT content_id FROM reviews WHERE id=(SELECT confirmation_review_id FROM review_cycles))"],
  ])('rejects damaged persisted invariant: %s', (_label, sql) => {
    const db = fixture()
    try {
      db.transaction(() => applyM03ReviewCycle(db))(); seedValid(db); expect(verifyM03ReviewCycle(db)).toBe(true)
      if (sql.includes("other-root")) db.prepare('INSERT INTO generation_roots VALUES(?,?,?,?,?,?,?,?)').run('other-root','other-key',JSON.stringify({ projectId: 'project', epoch: 'epoch' }),'{}',0,null,null,0)
      db.exec(sql)
      expect(verifyM03ReviewCycle(db)).toBe(false)
    } finally { db.close() }
  })

  it('rolls back both tables on interruption', () => {
    const db = fixture()
    try {
      expect(() => db.transaction(() => { applyM03ReviewCycle(db); throw new Error('interrupted') })()).toThrow('interrupted')
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('review_cycles','review_findings')").all()).toEqual([])
    } finally { db.close() }
  })

  it('creates the registered S11 migration metadata and composes known-schema verification', () => {
    const db = fixture()
    try {
      const migration = createM03Migration({ database: () => db, verifyKnownSchema: () => true })
      expect(migration).toMatchObject({ id: 'M03', from: 3, to: 4, owner: 'S11' })
      db.transaction(() => migration.migrate({} as never))()
      expect(migration.verify({} as never)).toBe(true)
      const rejected = createM03Migration({ database: () => db, verifyKnownSchema: () => false })
      expect(rejected.verify({} as never)).toBe(false)
    } finally { db.close() }
  })
})
