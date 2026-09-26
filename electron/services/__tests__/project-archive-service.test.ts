import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, createProjectDatabase, initProjectDatabase } from '../../database'
import { BlueprintRepository } from '../../repositories/blueprint-repository'
import { verifyM03ReviewCycle, canonicalM03FindingSetHash } from '../../migrations/m03-review-cycle'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import { buildReviewGenerationReport } from '../../../src/shared/review-generation-report'
import { extractPortableProjectArchive } from '../portable-project-archive'
import { restorePortableProject } from '../project-restore-service'
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

function fixture(): Fixture {
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
  createProjectDatabase(root, Buffer.alloc(32, 7))
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

function seedMergedCycle(f: Fixture, config: Record<string, unknown> = {}, recheckReceipt?: Record<string, unknown>): {
  cycleId: string; body: string; mergedHash: string
} {
  const db = new Database(f.databasePath)
  db.pragma('foreign_keys = ON')
  try {
  const source = '甲推开门，雨水顺着袖口落下。'
  const body = '甲推开门，作者手工合并了新正文。'
  const reviewOutput = JSON.stringify({ summary: '检查完成', items: [{ category: 'continuity',
    severity: 'warning', description: '门闩状态需确认。', quote: '甲推开门' }] })
  const reviewBody = JSON.stringify(buildReviewGenerationReport({ content: reviewOutput, sourceContent: source,
    frozenGoals: { chapterNumber: 1, coverage: 'not_configured', items: [] }, writingLanguage: 'zh-CN', uiLocale: 'zh-CN',
    preflightFindings: [] }), null, 2)
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
    confirmation?: object) => {
    const attemptId = `attempt-${kind}`, runId = `run-${kind}`, artifactId = `artifact-${kind}`
    const operation = kind === 'review' ? 'review-chapter' : 'refine-from-review'
    const context = { version: 1, operation, sourceHash: hash(source),
      source: { id: draftId, chapterNumber: 1, version: 1, status: 'draft', content: source },
      config, writingLanguage: 'zh-CN', uiLocale: 'zh-CN', authorInputs: [], characterStates: '（暂无）',
      worldbuilding: '', history: [], blueprints: [],
      frozenGoals: { chapterNumber: 1, coverage: 'not_configured', items: [] }, preflightFindings: [],
      ...(confirmation ? { confirmation } : {}) }
    const fingerprint = Object.fromEntries([
      'chapterBriefHash', 'authorGuidanceHash', 'dependencyHash', 'contextSnapshotHash', 'templateHash',
      'skillSnapshotHash', 'modelLeaseRevision', 'policyHash', 'outputContractHash',
    ].map((key, number) => [key, hash(`${attemptId}:${number}`)]))
    const artifact = { artifactId, attemptId, rootActionId: root, projectId: f.projectId, epoch: 'epoch',
      fingerprint, revision: 1, text: output, textHash: hash(output) }
    const artifactRef = { artifactId, revision: 1, textHash: hash(output) }
    const effect = { kind, id, index, contentHash: hash(content), contextHash: hash(JSON.stringify(context)),
      artifact: artifactRef, ...(kind === 'revision' ? { compositionHash: hash(content) } : {}) }
    db.prepare('INSERT INTO generation_runs(run_id,root_action_id,binding_json,status,created_at_ms,open_key) VALUES(?,?,?,?,?,?)')
      .run(runId, root, JSON.stringify({ projectId: f.projectId, epoch: 'epoch', fingerprint,
        sourceManifest: { operation, secretRef: 'private-credential-sentinel',
          machinePath: 'C:\\Users\\EthanQ\\private-machine-sentinel',
          reviewRevisionContext: context, reviewRevisionContextHash: effect.contextHash,
          authorInputs: [{ id: 'review-revision-context', text: JSON.stringify(context) }] } }),
      'completed', 1, `open-${kind}`)
    db.prepare(`INSERT INTO generation_attempts(attempt_id,reservation_id,run_id,root_action_id,attempt_json,
      usage_receipt_json,invocation_nonce) VALUES(?,?,?,?,?,?,?)`).run(attemptId, `reservation-${kind}`, runId, root,
      JSON.stringify({ attemptId, reservationId: `reservation-${kind}`, rootActionId: root, status: 'settled',
        reservedTokens: 100, requestedOutputTokens: 100, actualTokens: 1 }),
      JSON.stringify({ artifactIdentity: { artifactId, epoch: 'epoch', fingerprint }, result: { usage: null, finishReason: 'stop' },
        reviewRevisionEffect: effect, ...(kind === 'review' && recheckReceipt ? { reviewCycleRecheck: recheckReceipt } : {}),
        ...(kind === 'revision' ? { visibleComposition: { algorithm: 'visible-append-v1',
          textHash: hash(content), artifactIds: [artifactId], sources: [artifactRef] } } : {}) }), `nonce-${kind}`)
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
    if (!verifyM03ReviewCycle(db)) throw new Error('MERGED_CYCLE_FIXTURE_INVALID')
    return { cycleId, body, mergedHash: hash(body) }
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
  it('roundtrips an immutable v7 merged cycle with its body and bound hash', async () => {
    const f = fixture()
    const seeded = seedMergedCycle(f)
    await exportPortableProject(input(f))
    const targetRoot = path.join(f.base, 'restored')
    await restorePortableProject({ archivePath: f.target, targetProjectRoot: targetRoot })
    const restored = new Database(path.join(targetRoot, '.ai-novel', 'project.db'), { readonly: true })
    try {
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
    } finally { restored.close() }
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
