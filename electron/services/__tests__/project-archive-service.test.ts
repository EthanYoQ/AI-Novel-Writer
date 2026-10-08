import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, createProjectDatabase, initProjectDatabase } from '../../database'
import { BlueprintRepository } from '../../repositories/blueprint-repository'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { migrateSchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { verifyM03ReviewCycle, canonicalM03FindingSetHash } from '../../migrations/m03-review-cycle'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import { buildReviewGenerationReport } from '../../../src/shared/review-generation-report'
import type { ReviewCycleRecheckContext } from '../../../src/shared/review-cycle'
import type { GenerationTransportDiagnostics } from '../../../src/shared/generation-contract'
import { extractPortableProjectArchive } from '../portable-project-archive'
import { restorePortableProject } from '../project-restore-service'
import { readPortableRuntimeFreeze } from '../portable-runtime-freeze'
import { ReviewRevisionGeneration } from '../review-revision-generation'
import { GenerationRunRepository } from '../../repositories/generation-run-repository'
import {
  exportPortableProject,
  type ExportPortableProjectInput,
  type PortableAssetSnapshot,
  type PortableProvidedFile,
} from '../project-archive-service'
import { createProjectArchiveRoundtripFixture } from '../../../test/desktop/project-archive.fixture'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
const roots: string[] = []
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')

interface Fixture {
  base: string
  root: string
  storage: string
  databasePath: string
  target: string
  attemptParent: string
  extractParent: string
  projectId: string
  session: { projectId: string; projectPath: string; leaseId: string }
}

function fixture(donor = false): Fixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'b01-export-service-'))
  roots.push(base)
  const root = path.join(base, '作者项目')
  const storage = path.join(root, '.ai-novel')
  const attemptParent = path.join(base, 'private-attempts')
  const extractParent = path.join(base, 'private-extracts')
  fs.mkdirSync(storage, { recursive: true })
  fs.mkdirSync(attemptParent)
  fs.mkdirSync(extractParent)
  const projectId = randomUUID()
  fs.writeFileSync(path.join(storage, 'project.json'), JSON.stringify(createCanonicalProjectManifest({
    projectId,
    createdAt: '2026-09-20T00:00:00.000Z',
  })))
  if (donor) {
    const db = new Database(path.join(storage, 'project.db'))
    try {
      initializeLegacyBaselineSchema(db)
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='characters'").get() as { sql: string }
      db.exec('ALTER TABLE characters RENAME TO characters_without_avatar')
      db.exec(row.sql.replace("      cs_location TEXT DEFAULT '',", "      avatar TEXT NOT NULL DEFAULT '',\n      cs_location TEXT DEFAULT '',"))
      db.exec('DROP TABLE characters_without_avatar')
      migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 7)
    } finally { db.close() }
  } else createProjectDatabase(root, Buffer.alloc(32, 7))
  initProjectDatabase(root)
  BlueprintRepository.listPendingCharacterSyncOperations()
  closeProjectDatabase()
  return {
    base,
    root,
    storage,
    databasePath: path.join(storage, 'project.db'),
    target: path.join(base, '项目副本.ainovel'),
    attemptParent,
    extractParent,
    projectId,
    session: { projectId, projectPath: root, leaseId: 'lease-current' },
  }
}

function providedFile(fixture: Fixture, archivePath: string, value: string, disposition: PortableProvidedFile['disposition']): PortableProvidedFile {
  const sourcePath = path.join(fixture.storage, 'explicit-assets', ...archivePath.split('/'))
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
  const bytes = Buffer.from(value, 'utf8')
  fs.writeFileSync(sourcePath, bytes)
  return { id: archivePath, archivePath, sourcePath, byteSize: bytes.length, sha256: hash(bytes), disposition }
}

function provider(files: readonly PortableProvidedFile[] = [], verifyUnchanged: () => void = () => undefined): ExportPortableProjectInput['assets'] {
  return {
    snapshot(): PortableAssetSnapshot {
      return {
        files,
        semanticCounts: { 'provided-assets': files.length },
        omittedItems: [],
        transferReceiptIds: [],
        historyProjectionIds: [],
        verifyUnchanged,
      }
    },
  }
}

function input(f: Fixture, assets = provider(), overrides: Partial<ExportPortableProjectInput> = {}): ExportPortableProjectInput {
  return {
    sourceProjectRoot: f.root,
    projectSession: f.session,
    targetArchivePath: f.target,
    attemptParentPath: f.attemptParent,
    assertCurrentContext: context => {
      if (context.leaseId !== f.session.leaseId) throw new Error('stale')
    },
    assets,
    now: () => new Date('2026-09-21T00:00:00.000Z'),
    snapshotGeneration: 'generation-test-1',
    ...overrides,
  }
}

function seedProject(f: Fixture, secret = 'token-绝不外带'): { body: string; avatar: Buffer; secretDigest: string } {
  const body = '雨落在铜钥匙上。作者写下 C:\\某地\\旧稿.txt，字节必须原样。'
  const avatar = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 9)])
  const characterA = randomUUID()
  const characterB = randomUUID()
  const avatarPath = `avatars/${hash(characterA)}/1-${hash(avatar)}.png`
  fs.mkdirSync(path.dirname(path.join(f.storage, avatarPath)), { recursive: true })
  fs.writeFileSync(path.join(f.storage, avatarPath), avatar)
  const db = new Database(f.databasePath)
  db.pragma('foreign_keys = ON')
  try {
    db.prepare("INSERT INTO project_core(id,project_name,writing_language) VALUES('main',?,'zh-CN')").run('铜钥匙')
    db.prepare('INSERT INTO contents(id,body) VALUES(1,?)').run(body)
    db.prepare(`INSERT INTO drafts(id,chapter_number,version,status,source,content_id,word_count,source_dependencies)
      VALUES(1,1,1,'finalized','write',1,?,?)`).run(body.length, '[]')
    db.prepare(`INSERT INTO finalization_outbox(
      finalization_id,draft_id,chapter_number,chapter_title,content_hash,content_revision,content_snapshot,
      target_file_name,publication_status,last_error
    ) VALUES(?,?,?,?,?,1,?,?,'pending',?)`).run('finalization-1', 1, 1, '雨夜', hash(body), body, '第一章-雨夜.md', `C:\\错误\\${secret}`)
    db.prepare(`INSERT INTO characters(character_id,name,role,static_provenance)
      VALUES(?,?,'protagonist','{}'),(?,?,'supporting','{}')`).run(characterA, '林澈', characterB, '苏晚')
    db.prepare(`INSERT INTO character_avatar_assets(
      character_id,asset_revision,relative_path,content_hash,mime,byte_size,source_reference
    ) VALUES(?,1,?,?,'image/png',?,'avatar.png')`).run(characterA, avatarPath, hash(avatar), avatar.length)
    db.prepare('INSERT INTO character_identity_approvals(operation_id,payload_hash,receipt_json) VALUES(?,?,?)')
      .run('approval-1', hash('approval'), JSON.stringify({ operationId: 'approval-1', secretRef: secret }))
    db.prepare(`INSERT INTO character_relationships(
      relationship_id,source_character_id,target_character_id,relation,source_display_snapshot,
      target_display_snapshot,provenance_json,approval_id
    ) VALUES(?,?,?,?,?,?,?,?)`).run('relationship-1', characterA, characterB, '盟友', '林澈', '苏晚',
      JSON.stringify({ source: 'author' }), 'approval-1')
    db.prepare(`INSERT INTO recovery_candidates(
      candidate_id,run_id,step_id,project_id,chapter_number,chapter_title,source_snapshot,source_hash,
      source_draft_identity_captured,visible_text,content_hash,failure_code,failure_reason,status
    ) VALUES(?,?,?,?,?,?,?,?,0,?,?,?,?,'pending')`).run(
      'candidate-1', 'run-1', 'step-1', f.projectId, 2, '第二章', JSON.stringify({
        chapterNumber: 2, title: '第二章', role: '推进', purpose: '追踪', keyEvents: '发现线索', characters: ['林澈'],
      }), hash('source'), '候选正文', hash('候选正文'), 'MODEL_UNKNOWN', `secretRef=${secret}`,
    )
    const action = { projectId: f.projectId, epoch: 'epoch-1', operation: 'draft', uiActionNonce: 'nonce',
      frozenInputHash: hash('input'), rootActionId: 'root-1', status: 'active' }
    db.prepare('INSERT INTO generation_roots(root_action_id,idempotency_key,action_json,budget_json) VALUES(?,?,?,?)')
      .run('root-1', 'root-key-1', JSON.stringify({ ...action, secretRef: secret }), JSON.stringify({
        maxPhysicalRequests: 2, maxTokenLiability: 1000, maxOutputPerRequest: 500, maxActiveElapsedMs: 1000,
      }))
    db.prepare('INSERT INTO generation_runs VALUES(?,?,?,?,?,?)').run(
      'run-1', 'root-1', JSON.stringify({ projectId: f.projectId, epoch: 'epoch-1', fingerprint: {},
        contextSnapshotId: 'context-1', sourceManifest: { secretRef: secret }, sourceRefs: [] }), 'running', 1, 'open-key-1')
    const attempt = { attemptId: 'attempt-1', reservationId: 'reservation-1', rootActionId: 'root-1',
      status: 'unknown', reservedTokens: 500, requestedOutputTokens: 400 }
    const rawReceipt = JSON.stringify({ secretRef: secret, path: 'C:\\Users\\writer\\token.txt' })
    const secretDigest = hash(rawReceipt)
    db.prepare('INSERT INTO generation_attempts VALUES(?,?,?,?,?,?,?)').run(
      'attempt-1', 'reservation-1', 'run-1', 'root-1', JSON.stringify(attempt),
      JSON.stringify({ rawReceipt, digest: secretDigest }), 'invocation-1')
    const artifact = { artifactId: 'artifact-1', attemptId: 'attempt-1', rootActionId: 'root-1',
      projectId: f.projectId, epoch: 'epoch-1', fingerprint: {}, revision: 1,
      text: '候选续写 C:\\作者设定\\地点', textHash: hash('候选续写 C:\\作者设定\\地点') }
    db.prepare('INSERT INTO generation_artifacts VALUES(?,?,?,?,?,?)').run(
      'artifact-1', 'attempt-1', 'run-1', JSON.stringify(artifact), 1, 'partial')
    db.prepare('INSERT INTO import_legacy_identity_bridge VALUES(?,?,?,?,datetime(\'now\'))')
      .run('legacy-secret', Buffer.from(secret).toString('hex'), '01'.repeat(12), '02'.repeat(16))
    db.prepare(`INSERT INTO import_runs(
      id,purpose,root_run_id,effect_namespace,source_fingerprint,manifest_fingerprint,source_display_json,
      locale,stage,status,total_chapters,manifest_chapter_count,execution_owner,execution_epoch,lease_expires_at
    ) VALUES(?,?,?,?,?,?,?,'zh-CN','parsing','running',0,0,?,?,?)`).run(
      'import-1', 'reference', 'import-1', 'import:reference:import-1', hash('source-file'), hash('manifest'),
      JSON.stringify([{ displayName: '资料.txt', mediaType: 'text/plain', size: 12 }]), secret, 9, 999999,
    )
    return { body, avatar, secretDigest }
  } finally { db.close() }
}

function seedMergedCycle(f: Fixture, config: Record<string, unknown> = {}, recheckReceipt?: Record<string, unknown>,
  reportOptions: { longReport?: boolean; reportVersion?: 2; recheckReportVersion?: 1 | 2;
    diagnostics?: GenerationTransportDiagnostics } = {}): {
  cycleId: string; body: string; mergedHash: string; reviewBody: string; recheckBody?: string
} {
  const db = new Database(f.databasePath)
  db.pragma('foreign_keys = ON')
  try {
  const source = reportOptions.longReport ? '甲推开门，'.repeat(40) + '但这只是传闻。' : '甲推开门，雨水顺着袖口落下。'
  const body = '甲推开门，作者手工合并了新正文。'
  const reviewOutput = JSON.stringify({ summary: reportOptions.longReport ? '核对原文。'.repeat(30) + '保留限定。' : '检查完成', items: [{ category: 'continuity',
    severity: 'warning', description: reportOptions.longReport ? '门闩状态需确认。'.repeat(30) + '但这只是传闻。' : '门闩状态需确认。',
    quote: reportOptions.longReport ? source : '甲推开门' }] })
  const reviewBody = JSON.stringify(buildReviewGenerationReport({ content: reviewOutput, sourceContent: source,
    frozenGoals: { chapterNumber: 1, coverage: 'not_configured', items: [] }, writingLanguage: 'zh-CN', uiLocale: 'zh-CN',
    preflightFindings: [], reportVersion: reportOptions.reportVersion ?? 1 }), null, 2)
  const addContent = (value: string) => Number(db.prepare('INSERT INTO contents(body) VALUES(?)').run(value).lastInsertRowid)
  const draftId = Number(db.prepare("INSERT INTO drafts(chapter_number,version,status,content_id) VALUES(1,1,'revised',?)")
    .run(addContent(body)).lastInsertRowid)
  const reviewId = Number(db.prepare(`INSERT INTO reviews(base_draft_id,review_index,source_draft_chapter_number,
    source_draft_version,source_draft_status,source_content,content_id) VALUES(?,1,1,1,'draft',?,?)`)
    .run(draftId, source, addContent(reviewBody)).lastInsertRowid)
  const confirmationBody = JSON.stringify({ kind: 'human-confirmed-review', schemaVersion: 1, sourceReviewId: reviewId,
    sourceDraft: { id: draftId, chapterNumber: 1, version: 1, status: 'draft', content: source },
    summary: '', authorGuidance: '', items: [] }, null, 2)
  const confirmationId = Number(db.prepare(`INSERT INTO reviews(base_draft_id,review_index,source_draft_chapter_number,
    source_draft_version,source_draft_status,source_content,content_id) VALUES(?,2,1,1,'draft',?,?)`)
    .run(draftId, source, addContent(confirmationBody)).lastInsertRowid)
  const revisionBody = '甲推开门，先抖落袖口的雨水。'
  const revisionId = Number(db.prepare(`INSERT INTO revisions(base_draft_id,revision_index,revision_type,status,
    merged_to_draft_id,user_prompt,review_source_id,source_draft_chapter_number,source_draft_version,
    source_draft_status,source_content,content_id) VALUES(?,1,'review-fix','merged',?,'',?,1,1,'draft',?,?)`)
    .run(draftId, draftId, confirmationId, source, addContent(revisionBody)).lastInsertRowid)
  const root = 'root-merge'
  db.prepare('INSERT INTO generation_roots(root_action_id,idempotency_key,action_json,budget_json) VALUES(?,?,?,?)')
    .run(root, 'root-key', JSON.stringify({ projectId: f.projectId, epoch: 'epoch', operation: 'review-chapter',
      uiActionNonce: 'merge', frozenInputHash: hash(source), rootActionId: root, status: 'active' }),
    JSON.stringify({ maxPhysicalRequests: 1, maxTokenLiability: 100, maxOutputPerRequest: 100, maxActiveElapsedMs: 1000 }))
  const attempt = (kind: 'review' | 'revision', id: number, index: number, content: string, output: string,
    confirmation?: object, recheck?: ReviewCycleRecheckContext) => {
    const label = recheck ? 'recheck' : kind
    const attemptId = `attempt-${label}`, runId = `run-${label}`, artifactId = `artifact-${label}`
    const frozenSource = recheck ? body : source
    const operation = kind === 'review' ? 'review-chapter' : 'refine-from-review'
    const context = { version: 1, operation, sourceHash: hash(frozenSource),
      source: { id: draftId, chapterNumber: 1, version: 1, status: recheck ? 'revised' : 'draft', content: frozenSource },
      config, writingLanguage: 'zh-CN', uiLocale: 'zh-CN', authorInputs: [], characterStates: '（暂无）',
      worldbuilding: '', history: [], blueprints: [],
      frozenGoals: { chapterNumber: 1, coverage: 'not_configured', items: [] }, preflightFindings: [],
      ...(confirmation ? { confirmation } : {}), ...(recheck ? { recheck } : {}) }
    const fingerprint = Object.fromEntries([
      'chapterBriefHash', 'authorGuidanceHash', 'dependencyHash', 'contextSnapshotHash', 'templateHash',
      'skillSnapshotHash', 'modelLeaseRevision', 'policyHash', 'outputContractHash',
    ].map((key, number) => [key, hash(`${attemptId}:${number}`)]))
    const artifact = { artifactId, attemptId, rootActionId: root, projectId: f.projectId, epoch: 'epoch',
      fingerprint, revision: 1, text: output, textHash: hash(output) }
    const artifactRef = { artifactId, revision: 1, textHash: hash(output) }
    const reportVersion = recheck ? reportOptions.recheckReportVersion === 2 ? 2 : undefined : reportOptions.reportVersion
    const effect = { kind, id, index, contentHash: hash(content), contextHash: hash(JSON.stringify(context)),
      artifact: artifactRef, ...(kind === 'revision' ? { compositionHash: hash(content) }
        : reportVersion === undefined ? {} : { reportVersion }) }
    db.prepare('INSERT INTO generation_runs(run_id,root_action_id,binding_json,status,created_at_ms,open_key) VALUES(?,?,?,?,?,?)')
      .run(runId, root, JSON.stringify({ projectId: f.projectId, epoch: 'epoch', fingerprint,
        sourceManifest: { operation, secretRef: 'private-credential-sentinel',
          machinePath: 'C:\\Users\\EthanQ\\private-machine-sentinel',
          reviewRevisionContext: context, reviewRevisionContextHash: effect.contextHash,
          authorInputs: [{ id: 'review-revision-context', text: JSON.stringify(context) }] } }),
      'completed', 1, `open-${label}`)
    db.prepare(`INSERT INTO generation_attempts(attempt_id,reservation_id,run_id,root_action_id,attempt_json,
      usage_receipt_json,invocation_nonce) VALUES(?,?,?,?,?,?,?)`).run(attemptId, `reservation-${label}`, runId, root,
      JSON.stringify({ attemptId, reservationId: `reservation-${label}`, rootActionId: root, status: 'settled',
        reservedTokens: 100, requestedOutputTokens: 100, actualTokens: 1 }),
      JSON.stringify({ artifactIdentity: { artifactId, epoch: 'epoch', fingerprint }, result: { usage: null, finishReason: 'stop',
        ...(reportOptions.diagnostics ? { diagnostics: reportOptions.diagnostics } : {}) },
        reviewRevisionEffect: effect, ...(kind === 'review' && (recheck || recheckReceipt)
          ? { reviewCycleRecheck: recheck ?? recheckReceipt } : {}),
        ...(kind === 'revision' ? { visibleComposition: { algorithm: 'visible-append-v1',
          textHash: hash(content), artifactIds: [artifactId], sources: [artifactRef] } } : {}) }), `nonce-${label}`)
    db.prepare('INSERT INTO generation_artifacts(artifact_id,attempt_id,run_id,artifact_json,revision,status) VALUES(?,?,?,?,1,?)')
      .run(artifactId, attemptId, runId, JSON.stringify(artifact), 'partial')
  }
    attempt('review', reviewId, 1, reviewBody, reviewOutput)
    attempt('revision', revisionId, 1, revisionBody, revisionBody, {
      reviewSourceId: confirmationId, content: confirmationBody, originalReviewContentHash: hash(reviewBody),
      snapshot: JSON.parse(confirmationBody),
    })
    const cycleId = 'cycle-merge'
    db.prepare('INSERT INTO review_cycles VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(cycleId, root, reviewId,
      hash(reviewBody), confirmationId, hash(confirmationBody), revisionId, hash(source),
      canonicalM03FindingSetHash([]), 1, 'merge-committed', hash(body), 0, null)
    db.prepare('INSERT INTO review_cycle_merges(cycle_id,body) VALUES(?,?)').run(cycleId, body)
    let recheckBody: string | undefined
    if (reportOptions.recheckReportVersion) {
      const recheck: ReviewCycleRecheckContext = { version: 2, cycleId, comparisonVersion: 1,
        mergedHash: hash(body), findingSetHash: canonicalM03FindingSetHash([]), findings: [] }
      const output = `复核说明\n\`\`\`json\n${JSON.stringify({ summary: '保留完整复核说明。', items: [] })}\n\`\`\`\n说明结束`
      recheckBody = JSON.stringify({ summary: reportOptions.recheckReportVersion === 2
        ? '保留完整复核说明。' : '复核输出无效；受影响项目保持待核实。', items: [] }, null, 2)
      const recheckId = Number(db.prepare(`INSERT INTO reviews(base_draft_id,review_index,source_draft_chapter_number,
        source_draft_version,source_draft_status,source_content,content_id) VALUES(?,3,1,1,'revised',?,?)`)
        .run(draftId, body, addContent(recheckBody)).lastInsertRowid)
      attempt('review', recheckId, 3, recheckBody, output, undefined, recheck)
      db.prepare('UPDATE review_cycles SET recheck_count=1,recheck_attempt_id=? WHERE cycle_id=?').run('attempt-recheck', cycleId)
    }
    if (!verifyM03ReviewCycle(db)) throw new Error('MERGED_CYCLE_FIXTURE_INVALID')
    return { cycleId, body, mergedHash: hash(body), reviewBody, recheckBody }
  } finally { db.close() }
}

async function extract(f: Fixture) {
  return extractPortableProjectArchive({ archivePath: f.target, stagingParentPath: f.extractParent })
}

afterEach(() => {
  closeProjectDatabase()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('portable project export service', { timeout: 20_000 }, () => {
  it('preserves admitted predecessor, recheck goals and state-update raw values without admitting unknown fields', async () => {
    const material = { draftId: 10, chapterNumber: 1, chapterTitle: '', content: '前驱正文',
      identity: { projectId: 'project', sourceId: 'candidate:10', revision: 1, contentHash: hash('前驱正文'), provenance: 'generated' } }
    const update = { characterId: 'character-1', currentState: { location: '城门' }, evidence: { start: 0, end: 2, text: '城门' } }
    const materials = { predecessor: material,
      history: [{ ...material, projection: { draftId: 10, currentFinalizedDraftId: 10, chapterNumber: 1,
        chapterTitle: '', chapterNotes: '', facts: [], characterStateCandidates: [{ characterName: '林澈', field: 'location', value: '城门', rawValue: update }] } }],
      recheck: { version: 2, cycleId: 'cycle-merge', comparisonVersion: 1, mergedHash: hash('merged'), findingSetHash: hash('findings'),
        sourceContent: '原文', findings: [{ findingId: 'goal-1', targetId: 'goal-1', category: 'goal', kind: 'objective',
          problem: '目标尚未呈现', expected: '出现线索', mustShow: true }] } }
    const seedContext = (f: Fixture, extras: typeof materials) => {
      seedMergedCycle(f)
      const db = new Database(f.databasePath)
      try {
        const binding = JSON.parse(db.prepare("SELECT binding_json FROM generation_runs WHERE run_id='run-review'").pluck().get() as string)
        Object.assign(binding.sourceManifest.reviewRevisionContext, extras)
        binding.sourceManifest.reviewRevisionContextHash = hash(JSON.stringify(binding.sourceManifest.reviewRevisionContext))
        binding.sourceManifest.authorInputs = [{ id: 'review-revision-context', text: JSON.stringify(binding.sourceManifest.reviewRevisionContext) }]
        db.prepare('INSERT INTO generation_runs VALUES(?,?,?,?,?,?)').run('run-next-review', 'root-merge', JSON.stringify(binding), 'open', 2, 'open-next-review')
      } finally { db.close() }
    }
    const f = fixture()
    seedContext(f, materials)
    await exportPortableProject(input(f))
    const targetRoot = path.join(f.base, 'restored-context')
    await restorePortableProject({ archivePath: f.target, targetProjectRoot: targetRoot })
    const restored = new Database(path.join(targetRoot, '.ai-novel', 'project.db'), { readonly: true })
    try {
      const binding = JSON.parse(restored.prepare("SELECT binding_json FROM generation_runs WHERE run_id='run-next-review'").pluck().get() as string)
      expect(binding.sourceManifest.reviewRevisionContext).toMatchObject(materials)
      expect(binding.sourceManifest.reviewRevisionContextHash).toBe(hash(JSON.stringify(binding.sourceManifest.reviewRevisionContext)))
    } finally { restored.close() }
    for (const mutate of [
      (value: typeof materials) => { Object.assign(value.predecessor, { secretRef: 'excluded' }) },
      (value: typeof materials) => { Object.assign(value.recheck.findings[0]!, { mustShow: false }) },
      (value: typeof materials) => { Object.assign(value.history[0]!.projection.characterStateCandidates[0]!.rawValue, { machinePath: 'C:/secret' }) },
    ]) {
      const invalid = fixture(), changed = structuredClone(materials)
      mutate(changed); seedContext(invalid, changed)
      await expect(exportPortableProject(input(invalid))).rejects.toThrow('PORTABLE_UNSAFE_PROJECTION')
    }
  })

  it('rejects an export whose combined frozen history cannot be read back', async () => {
    const f = fixture()
    seedProject(f)
    const db = new Database(f.databasePath)
    const artifact = JSON.parse(db.prepare('SELECT artifact_json FROM generation_artifacts').pluck().get() as string)
    artifact.text = 'a'.repeat(9 * 1024 * 1024); artifact.textHash = hash(artifact.text)
    db.prepare('UPDATE generation_artifacts SET artifact_json=?').run(JSON.stringify(artifact))
    const attempt = JSON.parse(db.prepare('SELECT attempt_json FROM generation_attempts').pluck().get() as string)
    db.prepare('INSERT INTO generation_attempts VALUES(?,?,?,?,?,?,?)').run('attempt-2', 'reservation-2', 'run-1', 'root-1',
      JSON.stringify({ ...attempt, attemptId: 'attempt-2', reservationId: 'reservation-2' }), null, 'invocation-2')
    db.prepare('INSERT INTO generation_artifacts VALUES(?,?,?,?,?,?)').run('artifact-2', 'attempt-2', 'run-1',
      JSON.stringify({ ...artifact, artifactId: 'artifact-2', attemptId: 'attempt-2' }), 2, 'partial')
    db.close()
    await expect(exportPortableProject(input(f))).rejects.toThrow('PORTABLE_RUNTIME_FREEZE_INVALID')
    expect(fs.existsSync(f.target)).toBe(false)
    const source = new Database(f.databasePath, { readonly: true })
    try { expect(source.prepare('SELECT COUNT(*) FROM generation_artifacts').pluck().get()).toBe(2) }
    finally { source.close() }
  })

  it.each(['character-delete', 'runtime-replace', 'runtime-remove'])('exports %s avatar provenance with its retained asset', async provenance => {
    const f = fixture()
    seedProject(f)
    const db = new Database(f.databasePath)
    db.exec(`INSERT INTO character_avatar_unresolved(record_id,disposition,source_reference,source_relative_path,
      preserved_relative_path,content_hash,mime,byte_size,candidate_character_ids_json)
      SELECT 'orphan-1','orphan','${provenance}:'||character_id,relative_path,relative_path,content_hash,mime,byte_size,'[]'
      FROM character_avatar_assets`)
    db.exec('DELETE FROM character_avatar_assets'); db.close()
    await exportPortableProject(input(f))
    const restoredRoot = path.join(f.base, 'restored-avatar')
    await restorePortableProject({ archivePath: f.target, targetProjectRoot: restoredRoot })
    const restored = new Database(path.join(restoredRoot, '.ai-novel', 'project.db'), { readonly: true })
    try { expect(restored.prepare('SELECT source_reference FROM character_avatar_unresolved').pluck().get()).toMatch(new RegExp(`^${provenance}:`)) }
    finally { restored.close() }
  })

  it.each([1, 2] as const)('roundtrips a wrapped recheck with report derivation v%i and unchanged saved ACK', async version => {
    const f = fixture(), seeded = seedMergedCycle(f, {}, undefined, { recheckReportVersion: version })
    await exportPortableProject(input(f))
    const targetRoot = path.join(f.base, 'restored-recheck')
    await restorePortableProject({ archivePath: f.target, targetProjectRoot: targetRoot })
    const restored = new Database(path.join(targetRoot, '.ai-novel', 'project.db'), { readonly: true })
    try {
      const usage = JSON.parse(restored.prepare("SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id='attempt-recheck'")
        .pluck().get() as string)
      expect(usage.reviewRevisionEffect.reportVersion).toBe(version === 2 ? 2 : undefined)
      expect(usage.reviewCycleRecheck.version).toBe(2)
      expect(verifyM03ReviewCycle(restored)).toBe(true)
      const runs = new GenerationRunRepository(() => restored), run = runs.get('run-recheck')
      const scope = { projectId: run.binding.projectId, epoch: run.binding.epoch }
      const service = new ReviewRevisionGeneration(restored, runs, scope, () => {})
      const saved = service.commitReview({ contextId: 'saved-replay', handle: { ...scope, rootActionId: run.rootActionId, runId: run.runId },
        artifact: usage.reviewRevisionEffect.artifact }, () => { throw new Error('SAVED_REPLAY_MUST_NOT_RESUME') })
      expect(saved.content).toBe(seeded.recheckBody)
      expect(saved.contentHash).toBe(hash(seeded.recheckBody!))
      expect(runs.receipt('attempt-recheck').artifact?.text).toContain('复核说明\n```json\n')
    } finally { restored.close() }
  })

  it.each([1, 2] as const)('roundtrips an immutable v7 merged cycle and saved report version %i without local diagnostics', async version => {
    const f = fixture()
    const secret = 'private-diagnostics-sentinel'
    const seeded = seedMergedCycle(f, {}, undefined, { longReport: true, ...(version === 2 ? { reportVersion: 2 } : {}),
      diagnostics: { startedAt: 1, elapsedMs: 2, firstResponseMs: 1, lastResponseMs: 2, lastOutputMs: 2,
        phase: 'complete', endReason: 'completed', visibleEvents: 1, reasoningEvents: 0, errorCode: secret } })
    const sourceBefore = fs.readFileSync(f.databasePath)
    await exportPortableProject(input(f))
    expect(fs.readFileSync(f.databasePath)).toEqual(sourceBefore)
    expect(fs.readFileSync(f.target).includes(Buffer.from(secret))).toBe(false)
    const targetRoot = path.join(f.base, 'restored')
    await restorePortableProject({ archivePath: f.target, targetProjectRoot: targetRoot })
    expect(fs.readFileSync(path.join(targetRoot, '.ai-novel', 'project.db')).includes(Buffer.from(secret))).toBe(false)
    const freeze = readPortableRuntimeFreeze(targetRoot)
    for (const attemptId of ['attempt-review', 'attempt-revision']) {
      expect(() => freeze.assertMutable('generation_attempts', attemptId)).toThrow('PORTABLE_RUNTIME_FROZEN')
    }
    const restored = new Database(path.join(targetRoot, '.ai-novel', 'project.db'), { readonly: true })
    try {
      for (const receipt of restored.prepare('SELECT usage_receipt_json FROM generation_attempts').pluck().all() as string[]) {
        expect(JSON.parse(receipt).result).toEqual({ finishReason: 'stop' })
      }
      expect(restored.prepare('SELECT cycle_id,body FROM review_cycle_merges').get()).toEqual({
        cycle_id: seeded.cycleId, body: seeded.body,
      })
      expect(restored.prepare('SELECT merged_hash FROM review_cycles WHERE cycle_id=?').pluck().get(seeded.cycleId))
        .toBe(seeded.mergedHash)
      expect(hash(restored.prepare('SELECT body FROM review_cycle_merges WHERE cycle_id=?').pluck().get(seeded.cycleId) as string))
        .toBe(seeded.mergedHash)
      const restoredBinding = restored.prepare("SELECT binding_json FROM generation_runs WHERE run_id='run-review'")
        .pluck().get() as string
      expect(restoredBinding).not.toContain('private-credential-sentinel')
      expect(restoredBinding).not.toContain('private-machine-sentinel')
      const usage = JSON.parse(restored.prepare("SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id='attempt-review'")
        .pluck().get() as string)
      expect(usage.reviewRevisionEffect.reportVersion).toBe(version === 2 ? 2 : undefined)
      expect(verifyM03ReviewCycle(restored)).toBe(true)
      const runs = new GenerationRunRepository(() => restored), run = runs.get('run-review')
      const scope = { projectId: run.binding.projectId, epoch: run.binding.epoch }
      const service = new ReviewRevisionGeneration(restored, runs, scope, () => {})
      const saved = service.commitReview({ contextId: 'saved-replay', handle: { ...scope, rootActionId: run.rootActionId, runId: run.runId },
        artifact: usage.reviewRevisionEffect.artifact }, () => { throw new Error('SAVED_REPLAY_MUST_NOT_RESUME') })
      expect(saved.content).toBe(seeded.reviewBody)
      expect(saved.contentHash).toBe(hash(seeded.reviewBody))
      expect(saved.source.content).toBe(JSON.parse(restoredBinding).sourceManifest.reviewRevisionContext.source.content)
    } finally { restored.close() }
  })

  it('rejects unknown fields in a saved review result', async () => {
    const f = fixture()
    seedMergedCycle(f)
    const db = new Database(f.databasePath)
    try {
      db.prepare("UPDATE generation_attempts SET usage_receipt_json=json_set(usage_receipt_json,'$.result.extra','private-extra-sentinel')").run()
    } finally { db.close() }
    const sourceBefore = fs.readFileSync(f.databasePath)
    await expect(exportPortableProject(input(f))).rejects.toMatchObject({ code: 'PORTABLE_UNSAFE_PROJECTION' })
    expect(fs.readFileSync(f.databasePath)).toEqual(sourceBefore)
    expect(fs.existsSync(f.target)).toBe(false)
  })

  it.each([
    ['secretRef', 'private-credential-sentinel'],
    ['machinePath', 'C:\\Users\\EthanQ\\private-machine-sentinel'],
  ])('fails closed for a merged cycle context containing %s', async (key, sentinel) => {
    const f = fixture()
    seedMergedCycle(f, { [key]: sentinel })
    await expect(exportPortableProject(input(f))).rejects.toMatchObject({ code: 'PORTABLE_UNSAFE_PROJECTION' })
    expect(fs.existsSync(f.target)).toBe(false)
  })

  it('rejects a secret hidden in the wrong config field while the source cycle remains valid', async () => {
    const f = fixture()
    seedMergedCycle(f, { text: 'private-credential-sentinel' })
    await expect(exportPortableProject(input(f))).rejects.toMatchObject({ code: 'PORTABLE_UNSAFE_PROJECTION' })
    expect(fs.existsSync(f.target)).toBe(false)
  })

  it('rejects extra recheck receipt content while the source cycle remains valid', async () => {
    const f = fixture()
    seedMergedCycle(f, {}, { version: 2, cycleId: 'cycle-merge', comparisonVersion: 1,
      mergedHash: hash('甲推开门，作者手工合并了新正文。'), findingSetHash: canonicalM03FindingSetHash([]),
      findings: [], text: 'C:\\Users\\EthanQ\\private-machine-sentinel' })
    await expect(exportPortableProject(input(f))).rejects.toMatchObject({ code: 'PORTABLE_UNSAFE_PROJECTION' })
    expect(fs.existsSync(f.target)).toBe(false)
  })

  it('exports the shared 20-chapter corpus with authority, assets and frozen runtime history', async () => {
    const f = await createProjectArchiveRoundtripFixture()
    try {
      const sourceBefore = fs.readFileSync(f.sourceDatabasePath)
      await f.exportArchive()
      expect(fs.readFileSync(f.sourceDatabasePath)).toEqual(sourceBefore)

      const extractParent = path.join(f.base, 'shared-export-inspect')
      fs.mkdirSync(extractParent)
      const unpacked = await extractPortableProjectArchive({ archivePath: f.archivePath, stagingParentPath: extractParent })
      expect(unpacked.manifest.entries.map(entry => entry.path)).toEqual(expect.arrayContaining([
        'project.db', 'portable-runtime-freeze.json', '.ai-novel/portable-transfer-authority.json',
        'portable-knowledge-source.json', 'prompts/draft.json', 'skills/roundtrip/SKILL.md',
        'writing-skills.json', 'partial_arch/history.json', expect.stringMatching(/^avatars\//u),
      ]))
      const portable = new Database(path.join(unpacked.stagingPath, 'project.db'), { readonly: true })
      try {
        expect(portable.prepare("SELECT COUNT(*) FROM drafts WHERE status='finalized'").pluck().get()).toBe(20)
        expect(Buffer.from(portable.prepare('SELECT body FROM contents WHERE id=20').pluck().get() as string))
          .toEqual(f.chapter20BodyBytes)
        expect(portable.prepare('SELECT character_id FROM characters ORDER BY character_id').pluck().all())
          .toEqual([f.characterId, f.supportingCharacterId])
        expect(portable.prepare('SELECT relation FROM character_relationships').pluck().get()).toBe('盟友')
        expect(portable.prepare("SELECT status FROM recovery_candidates WHERE candidate_id='candidate-old'").pluck().get()).toBe('pending')
        expect(JSON.parse(portable.prepare("SELECT attempt_json FROM generation_attempts WHERE attempt_id='attempt-unknown'")
          .pluck().get() as string)).toMatchObject({ status: 'unknown' })
        expect(portable.prepare("SELECT publication_status FROM finalization_outbox WHERE finalization_id='outbox-old'").pluck().get()).toBe('pending')
        expect(portable.prepare("SELECT status FROM import_runs WHERE id='import-old'").pluck().get()).toBe('ready')
        expect(portable.prepare("SELECT execution_owner FROM import_runs WHERE id='import-old'").pluck().get()).toBe('')
      } finally { portable.close() }
      const avatar = unpacked.manifest.entries.find(entry => entry.disposition === 'avatar-asset')!
      expect(fs.readFileSync(path.join(unpacked.stagingPath, ...avatar.path.split('/')))).toEqual(f.avatarBytes)
      const freeze = JSON.parse(fs.readFileSync(path.join(unpacked.stagingPath, 'portable-runtime-freeze.json'), 'utf8'))
      expect(freeze.records).toEqual(expect.arrayContaining([
        expect.objectContaining({ table: 'recovery_candidates', recordId: 'candidate-old', nonReplayable: true }),
        expect.objectContaining({ table: 'generation_attempts', recordId: 'attempt-unknown', nonReplayable: true }),
        expect.objectContaining({ table: 'finalization_outbox', recordId: 'outbox-old', nonReplayable: true }),
        expect.objectContaining({ table: 'import_runs', recordId: 'import-old', nonReplayable: true }),
      ]))
      const transfer = JSON.parse(fs.readFileSync(path.join(
        unpacked.stagingPath, '.ai-novel', 'portable-transfer-authority.json',
      ), 'utf8'))
      expect(transfer).toMatchObject({ originProjectId: f.sourceProjectId, targetProjectId: null })
      expect(transfer.finalizations).toHaveLength(20)
      expect(transfer.summarySources).toHaveLength(20)
      for (const entry of unpacked.manifest.entries) {
        const bytes = fs.readFileSync(path.join(unpacked.stagingPath, ...entry.path.split('/')))
        for (const forbidden of f.sensitiveValues) expect(bytes.includes(Buffer.from(forbidden))).toBe(false)
      }
    } finally { f.dispose() }
  })

  it('keeps SQLite sidecar paths below the Windows limit under a long cloud staging parent', async () => {
    const f = fixture()
    const legacySuffix = path.join('.portable-export-attempt-123456', 'source-final-verification.db-wal')
    const padding = 263 - path.join(f.base, legacySuffix).length - 1
    expect(padding).toBeGreaterThan(0)
    const stagingParent = path.join(f.base, 'x'.repeat(padding))
    fs.mkdirSync(stagingParent)
    expect(path.join(stagingParent, legacySuffix).length).toBe(263)
    const targetArchivePath = path.join(stagingParent, 'backup.ainovel')
    const sourceBefore = fs.readFileSync(f.databasePath)
    const receipt = await exportPortableProject(input(f, provider(), {
      attemptParentPath: stagingParent,
      targetArchivePath,
      __testHooks: { afterPortableDatabaseCreated(attemptRoot) {
        expect(path.join(attemptRoot, 'source-final-verification.db-wal').length).toBeLessThan(260)
      } },
    }))
    expect(receipt.targetSha256).toBe(hash(fs.readFileSync(targetArchivePath)))
    expect(fs.readFileSync(f.databasePath)).toEqual(sourceBefore)
    expect(fs.readdirSync(stagingParent)).toEqual(['backup.ainovel'])
  })

  it('exports canonical v7 domain data, explicit assets and F03 avatars while freezing runtime history', async () => {
    const f = fixture()
    const seeded = seedProject(f)
    const assets = [
      providedFile(f, 'knowledge/世界观.txt', '城门只在雨夜开启。', 'knowledge-source'),
      providedFile(f, 'prompts/章节提示.txt', '保持克制。', 'prompt'),
      providedFile(f, 'skills/悬疑.md', '逐步揭示线索。', 'skill'),
      providedFile(f, 'candidates/旧候选.txt', '候选正文', 'author-content'),
    ]
    const before = fs.readFileSync(f.databasePath)
    const contextCalls: string[] = []
    const receipt = await exportPortableProject(input(f, provider(assets), {
      assertCurrentContext: context => { contextCalls.push(context.leaseId) },
    }))
    expect(receipt).toMatchObject({
      originProjectId: f.projectId,
      snapshotGeneration: 'generation-test-1',
      requiresRuntimeFreezeGuard: true,
      sourceEvidence: { schemaVersion: 7, tableCount: 51, fieldCount: 481 },
    })
    expect(contextCalls).toEqual(['lease-current', 'lease-current', 'lease-current'])
    expect(fs.readFileSync(f.databasePath)).toEqual(before)
    expect(fs.readdirSync(f.attemptParent)).toEqual([])

    const unpacked = await extract(f)
    expect(unpacked.manifest.declaredCompressedBytes).toBe(unpacked.manifest.declaredUncompressedBytes)
    expect(unpacked.manifest.semanticCounts['table.contents']).toBe(1)
    expect(unpacked.manifest.semanticCounts['table.review_cycle_merges']).toBe(0)
    expect(unpacked.manifest.entries.map(entry => entry.path)).toEqual(expect.arrayContaining([
      'project.db', 'portable-runtime-freeze.json', 'knowledge/世界观.txt', 'prompts/章节提示.txt',
      'skills/悬疑.md', 'candidates/旧候选.txt', '.ai-novel/portable-transfer-authority.json',
      expect.stringMatching(/^avatars\//u),
    ]))
    const transferEntry = unpacked.manifest.entries.find(entry => entry.path === '.ai-novel/portable-transfer-authority.json')!
    expect(transferEntry.disposition).toBe('transfer-receipt')
    const transfer = JSON.parse(fs.readFileSync(path.join(unpacked.stagingPath, ...transferEntry.path.split('/')), 'utf8'))
    expect(unpacked.manifest.transferReceiptIds).toContain(transfer.receiptId)
    expect(transfer).toMatchObject({
      originProjectId: f.projectId,
      targetProjectId: null,
      snapshotGeneration: 'generation-test-1',
      requiresRuntimeFreezeGuard: true,
    })
    const portable = new Database(path.join(unpacked.stagingPath, 'project.db'), { readonly: true })
    try {
      expect(portable.pragma('user_version', { simple: true })).toBe(7)
      expect(portable.prepare('SELECT COUNT(*) FROM review_cycle_merges').pluck().get()).toBe(0)
      expect(portable.prepare('SELECT body FROM contents WHERE id=1').pluck().get()).toBe(seeded.body)
      expect(portable.prepare('SELECT relation FROM character_relationships').pluck().get()).toBe('盟友')
      expect(portable.prepare('SELECT publication_status FROM finalization_outbox').pluck().get()).toBe('pending')
      expect(portable.prepare('SELECT status FROM recovery_candidates').pluck().get()).toBe('pending')
      expect(portable.prepare('SELECT status FROM generation_runs').pluck().get()).toBe('running')
      expect(portable.prepare('SELECT COUNT(*) FROM import_legacy_identity_bridge').pluck().get()).toBe(0)
      expect(portable.prepare('SELECT execution_owner FROM import_runs').pluck().get()).toBe('')
      expect(JSON.parse(portable.prepare('SELECT artifact_json FROM generation_artifacts').pluck().get() as string))
        .toMatchObject({ text: '候选续写 C:\\作者设定\\地点', revision: 1 })
    } finally { portable.close() }
    const avatarEntry = unpacked.manifest.entries.find(entry => entry.disposition === 'avatar-asset')!
    expect(fs.readFileSync(path.join(unpacked.stagingPath, ...avatarEntry.path.split('/')))).toEqual(seeded.avatar)
    const freeze = JSON.parse(fs.readFileSync(path.join(unpacked.stagingPath, 'portable-runtime-freeze.json'), 'utf8'))
    expect(freeze).toMatchObject({ nonReplayable: true, requiresRuntimeFreezeGuard: true })
    expect(freeze.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'generation_attempts', terminalState: 'unknown', nonReplayable: true }),
      expect.objectContaining({ table: 'finalization_outbox', terminalState: 'pending', nonReplayable: true }),
      expect.objectContaining({ table: 'import_runs', terminalState: 'running', nonReplayable: true }),
      expect.objectContaining({ table: 'recovery_candidates', terminalState: 'pending', nonReplayable: true }),
    ]))
  })

  it('exports and restores registered donor v7 avatars without carrying the legacy avatar reference', async () => {
    const f = fixture(true)
    const seeded = seedProject(f)
    const db = new Database(f.databasePath)
    try { db.prepare("UPDATE characters SET avatar='C:\\old-machine\\private-avatar.png' WHERE name='林澈'").run() }
    finally { db.close() }
    const before = fs.readFileSync(f.databasePath)

    const receipt = await exportPortableProject(input(f))
    expect(receipt.sourceEvidence).toMatchObject({ schemaVersion: 7, tableCount: 51, fieldCount: 482 })
    const targetProjectRoot = path.join(f.base, 'restored-donor')
    await restorePortableProject({ archivePath: f.target, targetProjectRoot })

    const restoredStorage = path.join(targetProjectRoot, '.ai-novel')
    const restored = new Database(path.join(restoredStorage, 'project.db'), { readonly: true })
    try {
      expect(restored.pragma('user_version', { simple: true })).toBe(7)
      expect(restored.prepare('SELECT avatar FROM characters').pluck().all()).toEqual(['', ''])
      expect(restored.prepare('SELECT body FROM contents WHERE id=1').pluck().get()).toBe(seeded.body)
      const avatarPath = restored.prepare('SELECT relative_path FROM character_avatar_assets').pluck().get() as string
      expect(fs.readFileSync(path.join(restoredStorage, avatarPath))).toEqual(seeded.avatar)
    } finally { restored.close() }
    expect(fs.readFileSync(f.databasePath)).toEqual(before)
  })

  it('never carries X values, secretRef, raw sensitive receipts or their digests while preserving author path-like text bytes', async () => {
    const f = fixture()
    const seeded = seedProject(f)
    await exportPortableProject(input(f))
    const bytes = fs.readFileSync(f.target)
    const rawReceipt = JSON.stringify({ secretRef: 'token-绝不外带', path: 'C:\\Users\\writer\\token.txt' })
    for (const forbidden of ['token-绝不外带', 'legacy-secret', rawReceipt, seeded.secretDigest]) {
      expect(bytes.includes(Buffer.from(forbidden, 'utf8'))).toBe(false)
    }
    const unpacked = await extract(f)
    const portable = new Database(path.join(unpacked.stagingPath, 'project.db'), { readonly: true })
    try {
      expect(portable.prepare('SELECT body FROM contents').pluck().get()).toBe(seeded.body)
      expect(portable.prepare('SELECT last_error FROM finalization_outbox').pluck().get()).toBe('')
      expect(portable.prepare('SELECT usage_receipt_json FROM generation_attempts').pluck().get()).toBeNull()
    } finally { portable.close() }
  })

  it('records F03 reference-only avatars without inventing a file', async () => {
    const f = fixture()
    const db = new Database(f.databasePath)
    db.prepare(`INSERT INTO character_avatar_unresolved(
      record_id,disposition,source_reference,source_relative_path,preserved_relative_path,
      content_hash,mime,byte_size,candidate_character_ids_json
    ) VALUES('missing-1','reference-only','missing.png','missing.png',NULL,NULL,NULL,NULL,'[]')`).run()
    db.close()
    await exportPortableProject(input(f))
    const unpacked = await extract(f)
    expect(unpacked.manifest.entries.some(entry => entry.disposition === 'avatar-asset')).toBe(false)
    const freeze = JSON.parse(fs.readFileSync(path.join(unpacked.stagingPath, 'portable-runtime-freeze.json'), 'utf8'))
    expect(freeze.avatarReferenceProjections).toEqual([expect.objectContaining({
      kind: 'unresolved-reference', recordId: 'missing-1', nonReplayable: true,
    })])
  })

  it.each([
    ['unknown table', (db: InstanceType<typeof Database>) => db.exec('CREATE TABLE future_secret(id TEXT)')],
    ['unknown field', (db: InstanceType<typeof Database>) => db.exec('ALTER TABLE contents ADD COLUMN future_secret TEXT')],
  ])('blocks %s before publishing', async (_label, mutate) => {
    const f = fixture()
    const db = new Database(f.databasePath)
    mutate(db)
    db.close()
    await expect(exportPortableProject(input(f))).rejects.toThrow('PORTABLE_SCHEMA_UNSUPPORTED')
    expect(fs.existsSync(f.target)).toBe(false)
  })

  it('rejects an unsafe portable DB path and a missing avatar before publication', async () => {
    const f = fixture()
    seedProject(f)
    const db = new Database(f.databasePath)
    db.prepare("UPDATE finalization_outbox SET target_file_name='C:\\outside\\chapter.md'").run()
    db.close()
    await expect(exportPortableProject(input(f))).rejects.toThrow('PORTABLE_PATH_UNSAFE')
    expect(fs.existsSync(f.target)).toBe(false)

    const missing = fixture()
    const characterId = randomUUID()
    const missingDb = new Database(missing.databasePath)
    missingDb.prepare("INSERT INTO characters(character_id,name,static_provenance) VALUES(?,?,'{}')")
      .run(characterId, '缺图角色')
    missingDb.prepare(`INSERT INTO character_avatar_assets(
      character_id,asset_revision,relative_path,content_hash,mime,byte_size,source_reference
    ) VALUES(?,1,'avatars/missing.png',?,'image/png',32,'missing.png')`).run(characterId, 'a'.repeat(64))
    missingDb.close()
    await expect(exportPortableProject(input(missing))).rejects.toThrow('PORTABLE_ASSET_MISSING')
    expect(fs.existsSync(missing.target)).toBe(false)
  })

  it('blocks unsafe required R projection instead of silently dropping it', async () => {
    const f = fixture()
    const db = new Database(f.databasePath)
    db.prepare('INSERT INTO contents(id,body) VALUES(1,?)').run('正文')
    db.prepare(`INSERT INTO drafts(id,chapter_number,version,content_id,source_dependencies)
      VALUES(1,1,1,1,?)`).run(JSON.stringify([{ draftId: 1, contentHash: hash('正文'), secretRef: 'forbidden' }]))
    db.close()
    await expect(exportPortableProject(input(f))).rejects.toThrow('PORTABLE_UNSAFE_PROJECTION')
    expect(fs.existsSync(f.target)).toBe(false)
  })

  it.each([
    ['bad relative path', (f: Fixture) => provider([{ ...providedFile(f, 'safe.txt', 'x', 'author-content'), archivePath: '../escape.txt' }])],
    ['missing file', (f: Fixture) => {
      const file = providedFile(f, 'safe.txt', 'x', 'author-content')
      fs.unlinkSync(file.sourcePath)
      return provider([file])
    }],
  ])('rejects %s and leaves the source and target unchanged', async (_label, makeProvider) => {
    const f = fixture()
    const before = fs.readFileSync(f.databasePath)
    await expect(exportPortableProject(input(f, makeProvider(f)))).rejects.toThrow(/PORTABLE_(PATH_UNSAFE|ASSET_MISSING)/u)
    expect(fs.readFileSync(f.databasePath)).toEqual(before)
    expect(fs.existsSync(f.target)).toBe(false)
  })

  it('rejects provider files outside canonical project storage even with valid metadata', async () => {
    const f = fixture()
    const bytes = Buffer.from('outside-secret', 'utf8')
    const sourcePath = path.join(f.base, 'outside-secret.txt')
    fs.writeFileSync(sourcePath, bytes)
    const file: PortableProvidedFile = {
      id: 'outside-secret',
      archivePath: 'knowledge/outside.txt',
      sourcePath,
      byteSize: bytes.length,
      sha256: hash(bytes),
      disposition: 'knowledge-source',
    }
    await expect(exportPortableProject(input(f, provider([file])))).rejects.toThrow('PORTABLE_ASSET_UNSAFE')
    expect(fs.existsSync(f.target)).toBe(false)
  })

  it('detects database and provider asset mutations before archive publication', async () => {
    const f = fixture()
    const file = providedFile(f, 'knowledge/a.txt', 'first', 'knowledge-source')
    await expect(exportPortableProject(input(f, provider([file]), {
      __testHooks: { afterPortableDatabaseCreated: () => {
        const db = new Database(f.databasePath)
        db.prepare("INSERT INTO contents(body) VALUES('late mutation')").run()
        db.close()
      } },
    }))).rejects.toThrow('PORTABLE_SOURCE_CHANGED')
    expect(fs.existsSync(f.target)).toBe(false)

    const second = fixture()
    const mutable = providedFile(second, 'knowledge/b.txt', 'before', 'knowledge-source')
    await expect(exportPortableProject(input(second, provider([mutable], () => {
      fs.writeFileSync(mutable.sourcePath, 'after')
      throw new Error('changed')
    })))).rejects.toThrow('PORTABLE_SOURCE_CHANGED')
    expect(fs.existsSync(second.target)).toBe(false)
  })

  it('detects source and provider mutations that happen while the archive is being built', async () => {
    const f = fixture()
    await expect(exportPortableProject(input(f, provider(), {
      __testHooks: { afterArchiveBuilt: () => {
        const db = new Database(f.databasePath)
        db.prepare("INSERT INTO contents(body) VALUES('archive-time mutation')").run()
        db.close()
      } },
    }))).rejects.toThrow('PORTABLE_SOURCE_CHANGED')
    expect(fs.existsSync(f.target)).toBe(false)

    const second = fixture()
    const mutable = providedFile(second, 'knowledge/during-build.txt', 'before', 'knowledge-source')
    await expect(exportPortableProject(input(second, provider([mutable]), {
      __testHooks: { afterArchiveBuilt: () => fs.writeFileSync(mutable.sourcePath, 'after!') },
    }))).rejects.toThrow('PORTABLE_SOURCE_CHANGED')
    expect(fs.existsSync(second.target)).toBe(false)
  })

  it('rechecks the current session after staging and rejects a stale capability', async () => {
    const f = fixture()
    let calls = 0
    await expect(exportPortableProject(input(f, provider(), {
      assertCurrentContext: () => ++calls < 3,
    }))).rejects.toThrow('PORTABLE_SOURCE_CHANGED')
    expect(calls).toBe(3)
    expect(fs.existsSync(f.target)).toBe(false)
  })

  it('preserves unknown attempt contents instead of recursively deleting them', async () => {
    const f = fixture()
    let attemptRoot = ''
    let calls = 0
    await expect(exportPortableProject(input(f, provider(), {
      assertCurrentContext: () => ++calls === 1,
      __testHooks: { afterPortableDatabaseCreated: root => {
        attemptRoot = root
        fs.writeFileSync(path.join(root, 'keep.txt'), 'not-owned')
      } },
    }))).rejects.toThrow('PORTABLE_SOURCE_CHANGED')
    expect(fs.readFileSync(path.join(attemptRoot, 'keep.txt'), 'utf8')).toBe('not-owned')
    expect(fs.existsSync(f.target)).toBe(false)
  })

  it('preserves a replacement attempt root whose identity no longer matches', async () => {
    const f = fixture()
    let replacementRoot = ''
    await expect(exportPortableProject(input(f, provider(), {
      __testHooks: { afterPortableDatabaseCreated: root => {
        fs.renameSync(root, `${root}-original`)
        fs.mkdirSync(root)
        fs.writeFileSync(path.join(root, 'keep.txt'), 'replacement')
        replacementRoot = root
      } },
    }))).rejects.toThrow(/PORTABLE_(ASSET_MISSING|SOURCE_CHANGED)/u)
    expect(fs.readFileSync(path.join(replacementRoot, 'keep.txt'), 'utf8')).toBe('replacement')
    expect(fs.existsSync(f.target)).toBe(false)
  })

  it('does not overwrite an existing target and never places attempts inside the source project', async () => {
    const f = fixture()
    fs.writeFileSync(f.target, 'keep')
    await expect(exportPortableProject(input(f))).rejects.toThrow('PORTABLE_ARCHIVE_TARGET_EXISTS')
    expect(fs.readFileSync(f.target, 'utf8')).toBe('keep')
    await expect(exportPortableProject(input(f, provider(), {
      targetArchivePath: path.join(f.root, 'forbidden.ainovel'),
    }))).rejects.toThrow('PORTABLE_TARGET_INSIDE_SOURCE')
  })
})
