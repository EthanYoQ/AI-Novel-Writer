import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

import type Database from 'better-sqlite3'

import {
  closeProjectDatabase,
  createProjectDatabase,
  getProjectDb,
  initProjectDatabase,
} from '../../electron/database'
import { BlueprintRepository } from '../../electron/repositories/blueprint-repository'
import type { FinalizationCommitInput } from '../../electron/repositories/finalization-repository'
import { freezeFinalizedCharacterSnapshot } from '../../electron/repositories/summary-repository'
import { createPortableProjectAssetProvider } from '../../electron/services/portable-project-assets'
import { exportPortableProject } from '../../electron/services/project-archive-service'
import { restorePortableProject } from '../../electron/services/project-restore-service'
import { restorePortableKnowledgeSnapshot } from '../../electron/vector-store'
import { createCanonicalProjectManifest } from '../../src/shared/project-format'
import type { GenerationSourceBindingInput } from '../../electron/services/generation-source-binding'

const require = createRequire(import.meta.url)
const Sqlite = require('better-sqlite3') as typeof import('better-sqlite3')
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')

const SOURCE_PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const TARGET_PROJECT_ID = '22222222-2222-4222-8222-222222222222'
const CHARACTER_ID = '33333333-3333-4333-8333-333333333333'
const SUPPORTING_CHARACTER_ID = '44444444-4444-4444-8444-444444444444'
const CHAPTER_20_FINALIZATION_ID = 'finalization-20'
const CHAPTER_20_INJURY = '林澈左肩受伤'
const CHAPTER_20_CLUE = '旧车站车票指向北门储物柜'
const AUTHOR_WINDOWS_PATH = String.raw`C:\作者资料\旧车站.txt`
const CHAPTER_20_BODY = `第20章定稿：${CHAPTER_20_INJURY}，${CHAPTER_20_CLUE}。作者正文路径 ${AUTHOR_WINDOWS_PATH} 保持原样。`
const CHAPTER_20_DERIVED = `伤势：${CHAPTER_20_INJURY}；线索：${CHAPTER_20_CLUE}。`
const AUTHOR_CHARACTER_STATE = '作者指定仍在南门'
const LEGACY_CHARACTER_STATE = '旧档案中的警觉'
const EARLIER_DERIVED_STATE = '第一章留下雨城地图'
const SECRET = 'sk-roundtrip-never-export'
const MACHINE_PATH = String.raw`C:\Users\writer\.secrets\model.json`

export interface ProjectArchiveRoundtripFixture {
  readonly base: string
  readonly sourceRoot: string
  readonly sourceStorage: string
  readonly sourceDatabasePath: string
  readonly archivePath: string
  readonly targetRoot: string
  readonly targetStorage: string
  readonly targetDatabasePath: string
  readonly transferAuthorityPath: string
  readonly globalDataRoot: string
  readonly sourceProjectId: string
  readonly targetProjectId: string
  readonly characterId: string
  readonly supportingCharacterId: string
  readonly chapter20DraftId: number
  readonly chapter20FinalizationId: string
  readonly chapter20Body: string
  readonly chapter20BodyBytes: Buffer
  readonly chapter20Derived: string
  readonly chapter20Injury: string
  readonly chapter20Clue: string
  readonly authorCharacterState: string
  readonly legacyCharacterState: string
  readonly earlierDerivedState: string
  readonly authorWindowsPath: string
  readonly avatarBytes: Buffer
  readonly sensitiveValues: readonly string[]
  readonly chapter21GenerationInput: GenerationSourceBindingInput
  exportArchive(): Promise<void>
  restoreArchive(): Promise<void>
  exportAndRestore(): Promise<void>
  reopenRestoredProject(): void
  restoredDatabase(): Database.Database
  prepareChapter20Replacement(database: Database.Database): {
    draftId: number
    body: string
    commit: FinalizationCommitInput
  }
  dispose(): void
}

function insertRoundtripDomain(database: Database.Database, sourceProjectId: string, avatarPath: string, avatarBytes: Buffer): void {
  database.pragma('foreign_keys = ON')
  database.transaction(() => {
    database.prepare("UPDATE continuity_projection_meta SET generation=1,stale_from_chapter=20 WHERE id='main'").run()
    database.prepare(`INSERT INTO project_core(
      id,project_name,writing_language,total_chapters,global_guidance,world_setting
    ) VALUES('main','雨城档案','zh-CN',40,'作者要求保留事实来源。','雨城北门只在雨夜开放。')`).run()
    const blueprint = database.prepare(`INSERT INTO blueprints(
      chapter_number,title,role,purpose,key_events,characters,user_guidance
    ) VALUES(?,?,?,?,?,?,?)`)
    for (let chapter = 1; chapter <= 21; chapter += 1) {
      blueprint.run(chapter, `第${chapter}章`, '主线', chapter === 21 ? '承接伤势与车票线索' : '推进调查',
        chapter === 21 ? '打开北门储物柜' : `完成第${chapter}章事件`, JSON.stringify(['林澈', '苏晚']), '不得改写作者事实')
    }

    const chapterSource = {
      draftId: 20,
      finalizationId: CHAPTER_20_FINALIZATION_ID,
      chapterNumber: 20,
      contentHash: sha256(CHAPTER_20_BODY),
    }
    const sourceOrder = {
      continuityEpoch: `${sourceProjectId}:1`,
      chapterNumber: 20,
      authoritativeFinalizationRevision: 2,
    }
    database.prepare(`INSERT INTO characters(
      character_id,static_provenance,identity_revision,retired,name,role,relationships,
      cs_location,cs_physical_state,cs_mental_state,cs_key_items,cs_recent_events,cs_updated_at_chapter,cs_provenance
    ) VALUES(?,? ,0,0,'林澈','protagonist','盟友：苏晚',?,?,?,?,?,20,?)`).run(
      CHARACTER_ID,
      JSON.stringify({ kind: 'author' }),
      AUTHOR_CHARACTER_STATE,
      CHAPTER_20_INJURY,
      LEGACY_CHARACTER_STATE,
      CHAPTER_20_CLUE,
      EARLIER_DERIVED_STATE,
      JSON.stringify({
        location: { kind: 'author', chapterNumber: 1 },
        physicalState: { kind: 'derived', source: chapterSource, revision: 1, sourceOrder },
        mentalState: { kind: 'legacy' },
        keyItems: { kind: 'derived', source: chapterSource, revision: 1, sourceOrder },
        recentEvents: { kind: 'derived', source: {
          draftId: 1,
          finalizationId: 'finalization-1',
          chapterNumber: 1,
          contentHash: sha256('第1章定稿正文：调查继续。'),
        }, revision: 1, sourceOrder: {
          continuityEpoch: `${sourceProjectId}:1`,
          chapterNumber: 1,
          authoritativeFinalizationRevision: 1,
        } },
      }),
    )
    database.prepare(`INSERT INTO characters(
      character_id,static_provenance,identity_revision,retired,name,role,relationships
    ) VALUES(?,? ,0,0,'苏晚','supporting','盟友：林澈')`).run(
      SUPPORTING_CHARACTER_ID,
      JSON.stringify({ kind: 'author' }),
    )
    database.prepare('INSERT INTO character_identity_approvals(operation_id,payload_hash,receipt_json) VALUES(?,?,?)')
      .run('relationship-approval', sha256('relationship-approval'), JSON.stringify({ operationId: 'relationship-approval' }))
    database.prepare(`INSERT INTO character_relationships(
      relationship_id,source_character_id,target_character_id,relation,source_display_snapshot,
      target_display_snapshot,provenance_json,approval_id
    ) VALUES('relationship-main',?,?,?,?,?,?, 'relationship-approval')`).run(
      CHARACTER_ID, SUPPORTING_CHARACTER_ID, '盟友', '林澈', '苏晚', JSON.stringify({ kind: 'author' }),
    )
    database.prepare(`INSERT INTO character_avatar_assets(
      character_id,asset_revision,relative_path,content_hash,mime,byte_size,source_reference
    ) VALUES(?,1,?,?,'image/png',?,'author-avatar.png')`).run(
      CHARACTER_ID, avatarPath, sha256(avatarBytes), avatarBytes.length,
    )

    const content = database.prepare('INSERT INTO contents(id,body) VALUES(?,?)')
    const draft = database.prepare(`INSERT INTO drafts(
      id,chapter_number,version,status,source,content_id,word_count,source_dependencies
    ) VALUES(?,?,?,'finalized','write',?,?, '[]')`)
    const finalization = database.prepare(`INSERT INTO finalization_outbox(
      finalization_id,draft_id,chapter_number,chapter_title,content_hash,content_revision,
      content_snapshot,target_file_name,publication_status,last_error
    ) VALUES(?,?,?,?,?,?,?,?,'pending',?)`)
    const summary = database.prepare(`INSERT INTO summary_snapshots(
      id,draft_id,chapter_number,chapter_notes,continuity_facts,source_finalization_id,
      source_content_hash,projection_generation
    ) VALUES(?,?,?,?,?,?,?,1)`)
    for (let chapter = 1; chapter <= 20; chapter += 1) {
      const body = chapter === 20 ? CHAPTER_20_BODY : `第${chapter}章定稿正文：调查继续。`
      const finalizationId = `finalization-${chapter}`
      const contentHash = sha256(body)
      content.run(chapter, body)
      draft.run(chapter, chapter, chapter === 20 ? 2 : 1, chapter, Buffer.from(body).length)
      finalization.run(finalizationId, chapter, chapter, `第${chapter}章`, contentHash, 1, body,
        `chapter-${chapter}.md`, chapter === 20 ? `publish failed at ${MACHINE_PATH}; ${SECRET}` : '')
      summary.run(chapter, chapter, chapter, chapter === 20 ? CHAPTER_20_DERIVED : `第${chapter}章连续性摘要。`,
        chapter === 20 ? JSON.stringify([{
          category: 'open-thread',
          entities: ['旧车站车票'],
          statement: CHAPTER_20_CLUE,
          sourceChapter: 20,
          evidence: CHAPTER_20_CLUE,
        }]) : '[]', finalizationId, contentHash)
      freezeFinalizedCharacterSnapshot(database, {
        draftId: chapter,
        finalizationId,
        chapterNumber: chapter,
        contentHash,
      })
    }

    const archivedBody = '第20章旧候选定稿，不是当前权威。'
    content.run(120, archivedBody)
    database.prepare(`INSERT INTO drafts(
      id,chapter_number,version,status,source,content_id,word_count,source_dependencies
    ) VALUES(120,20,1,'archived','write',120,?,'[]')`).run(Buffer.from(archivedBody).length)
    finalization.run('outbox-old', 120, 20, '旧第20章', sha256(archivedBody), 1, archivedBody, 'chapter-20-old.md', '')

    database.prepare(`INSERT INTO recovery_candidates(
      candidate_id,run_id,step_id,project_id,chapter_number,chapter_title,source_snapshot,source_hash,
      source_draft_identity_captured,visible_text,content_hash,failure_code,failure_reason,status
    ) VALUES('candidate-old','run-old','chapter-draft',?,21,'第21章',?,?,0,?,?,'MODEL_UNKNOWN',?,'pending')`).run(
      sourceProjectId,
      JSON.stringify({ chapterNumber: 21, title: '第21章', role: '主线', purpose: '调查', keyEvents: '旧候选', characters: ['林澈'] }),
      sha256('candidate-source'),
      '旧候选正文',
      sha256('旧候选正文'),
      `secretRef=${SECRET}`,
    )
    const action = {
      projectId: sourceProjectId,
      epoch: 'source-epoch',
      operation: 'chapter-draft',
      uiActionNonce: 'old-action',
      frozenInputHash: sha256('old-input'),
      rootActionId: 'root-old',
      status: 'active',
      secretRef: SECRET,
    }
    database.prepare('INSERT INTO generation_roots(root_action_id,idempotency_key,action_json,budget_json) VALUES(?,?,?,?)')
      .run('root-old', 'root-key-old', JSON.stringify(action), JSON.stringify({
        maxPhysicalRequests: 2,
        maxTokenLiability: 1000,
        maxOutputPerRequest: 500,
        maxActiveElapsedMs: 1000,
      }))
    database.prepare('INSERT INTO generation_runs VALUES(?,?,?,?,?,?)').run(
      'run-old', 'root-old', JSON.stringify({
        projectId: sourceProjectId,
        epoch: 'source-epoch',
        fingerprint: {},
        contextSnapshotId: 'context-old',
        sourceManifest: { secretRef: SECRET, machinePath: MACHINE_PATH },
        sourceRefs: [],
      }), 'running', 1, 'open-key-old',
    )
    const attempt = {
      attemptId: 'attempt-unknown',
      reservationId: 'reservation-old',
      rootActionId: 'root-old',
      status: 'unknown',
      reservedTokens: 500,
      requestedOutputTokens: 400,
    }
    const rawSensitiveReceipt = JSON.stringify({ secretRef: SECRET, path: MACHINE_PATH })
    database.prepare('INSERT INTO generation_attempts VALUES(?,?,?,?,?,?,?)').run(
      'attempt-unknown', 'reservation-old', 'run-old', 'root-old', JSON.stringify(attempt),
      JSON.stringify({ rawSensitiveReceipt, digest: sha256(rawSensitiveReceipt) }), 'invocation-old',
    )
    database.prepare('INSERT INTO generation_artifacts VALUES(?,?,?,?,?,?)').run(
      'artifact-old', 'attempt-unknown', 'run-old', JSON.stringify({
        artifactId: 'artifact-old',
        attemptId: 'attempt-unknown',
        rootActionId: 'root-old',
        projectId: sourceProjectId,
        epoch: 'source-epoch',
        fingerprint: {},
        revision: 1,
        text: '旧 partial history 可见正文',
        textHash: sha256('旧 partial history 可见正文'),
      }), 1, 'partial',
    )
    database.prepare(`INSERT INTO import_runs(
      id,purpose,root_run_id,effect_namespace,source_fingerprint,manifest_fingerprint,source_display_json,
      locale,stage,status,total_chapters,manifest_chapter_count,execution_owner,execution_epoch,lease_expires_at
    ) VALUES('import-old','reference','import-old','import:reference:import-old',?,?,?,'zh-CN','prepared','ready',0,0,?,?,?)`).run(
      sha256('import-source'), sha256('import-manifest'),
      JSON.stringify([{ displayName: '旧资料.txt', mediaType: 'text/plain', size: 12 }]),
      SECRET, 7, 999_999,
    )
  })()
}

export async function createProjectArchiveRoundtripFixture(): Promise<ProjectArchiveRoundtripFixture> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'b01-roundtrip-'))
  const sourceRoot = path.join(base, '源项目')
  const sourceStorage = path.join(sourceRoot, '.ai-novel')
  const targetRoot = path.join(base, '恢复项目')
  const targetStorage = path.join(targetRoot, '.ai-novel')
  const archivePath = path.join(base, '完整项目.ainovel')
  const attemptParent = path.join(base, 'export-attempts')
  const globalDataRoot = path.join(base, 'global')
  fs.mkdirSync(sourceStorage, { recursive: true })
  fs.mkdirSync(attemptParent)
  fs.mkdirSync(globalDataRoot)
  fs.writeFileSync(path.join(sourceStorage, 'project.json'), JSON.stringify(createCanonicalProjectManifest({
    projectId: SOURCE_PROJECT_ID,
    createdAt: '2026-09-20T00:00:00.000Z',
  })))
  createProjectDatabase(sourceRoot, Buffer.alloc(32, 7))
  initProjectDatabase(sourceRoot)
  BlueprintRepository.listPendingCharacterSyncOperations()
  closeProjectDatabase()

  const avatarBytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(32, 0x2a),
  ])
  const avatarPath = `avatars/${sha256(CHARACTER_ID)}/1-${sha256(avatarBytes)}.png`
  fs.mkdirSync(path.dirname(path.join(sourceStorage, avatarPath)), { recursive: true })
  fs.writeFileSync(path.join(sourceStorage, avatarPath), avatarBytes)
  const sourceDatabasePath = path.join(sourceStorage, 'project.db')
  const sourceDatabase = new Sqlite(sourceDatabasePath)
  try { insertRoundtripDomain(sourceDatabase, SOURCE_PROJECT_ID, avatarPath, avatarBytes) }
  finally { sourceDatabase.close() }

  fs.mkdirSync(path.join(sourceStorage, 'prompts'))
  fs.writeFileSync(path.join(sourceStorage, 'prompts', 'draft.json'), JSON.stringify({
    key: 'draft',
    content: '第21章必须承接伤势与旧车站车票。',
  }))
  fs.mkdirSync(path.join(sourceStorage, 'skills', 'roundtrip'), { recursive: true })
  fs.writeFileSync(path.join(sourceStorage, 'skills', 'roundtrip', 'SKILL.md'), [
    '---',
    'name: roundtrip',
    'language: zh-CN',
    'stage: drafting',
    '---',
    '保留权威正文与连续性来源。',
  ].join('\n'))
  fs.writeFileSync(path.join(sourceStorage, 'writing-skills.json'), JSON.stringify({
    version: 1,
    bindings: { drafting: 'project:roundtrip' },
  }))
  fs.mkdirSync(path.join(sourceStorage, 'partial_arch'))
  fs.writeFileSync(path.join(sourceStorage, 'partial_arch', 'history.json'), JSON.stringify({
    visible: '旧 partial history 可见但不可执行',
  }))
  await restorePortableKnowledgeSnapshot(sourceStorage, {
    version: 1,
    documents: [{
      docId: 'knowledge-rain-city',
      fileName: '雨城世界观.txt',
      corpusKind: 'project-knowledge',
      chunks: [{ chunkIndex: 0, text: '雨城北门只在雨夜开放，储物柜编号为二十。' }],
    }],
  })

  const modelHash = sha256('synthetic-model')
  const sensitiveReceipt = JSON.stringify({ secretRef: SECRET, path: MACHINE_PATH })
  let disposed = false
  const fixture: ProjectArchiveRoundtripFixture = {
    base,
    sourceRoot,
    sourceStorage,
    sourceDatabasePath,
    archivePath,
    targetRoot,
    targetStorage,
    targetDatabasePath: path.join(targetStorage, 'project.db'),
    transferAuthorityPath: path.join(targetStorage, 'portable-transfer-authority.json'),
    globalDataRoot,
    sourceProjectId: SOURCE_PROJECT_ID,
    targetProjectId: TARGET_PROJECT_ID,
    characterId: CHARACTER_ID,
    supportingCharacterId: SUPPORTING_CHARACTER_ID,
    chapter20DraftId: 20,
    chapter20FinalizationId: CHAPTER_20_FINALIZATION_ID,
    chapter20Body: CHAPTER_20_BODY,
    chapter20BodyBytes: Buffer.from(CHAPTER_20_BODY, 'utf8'),
    chapter20Derived: CHAPTER_20_DERIVED,
    chapter20Injury: CHAPTER_20_INJURY,
    chapter20Clue: CHAPTER_20_CLUE,
    authorCharacterState: AUTHOR_CHARACTER_STATE,
    legacyCharacterState: LEGACY_CHARACTER_STATE,
    earlierDerivedState: EARLIER_DERIVED_STATE,
    authorWindowsPath: AUTHOR_WINDOWS_PATH,
    avatarBytes,
    sensitiveValues: [SECRET, MACHINE_PATH, sha256(sensitiveReceipt)],
    chapter21GenerationInput: {
      projectId: TARGET_PROJECT_ID,
      epoch: 'restored-epoch-1',
      operation: 'chapter-draft',
      chapterNumber: 21,
      selectedDraftIds: [],
      selectedFinalizedDraftIds: [20],
      promptKeys: ['draft'],
      skillStages: ['drafting'],
      authorInputs: [{ id: 'chapter-21-direction', text: '作者要求第21章继续追查北门储物柜。' }],
      modelReceipt: {
        modelId: 'synthetic-model',
        provider: 'custom',
        protocol: 'openai',
        modelName: 'synthetic',
        modelRevision: modelHash,
        endpointFingerprint: modelHash,
        capabilityEvidence: {
          source: {
            contextWindowTokens: 'unknown',
            maxOutputTokens: 'user-operational-cap',
            featureFlags: 'unknown',
          },
          subjectFingerprint: modelHash,
          contextWindowTokens: 8_000,
          maxOutputTokens: 1_000,
          reasoning: false,
          structuredOutput: false,
          usage: true,
        },
      },
      policy: { version: 'roundtrip-v1', maxPhysicalRequests: 1 },
      outputContract: 'visible-text',
    },
    exportArchive: async () => {
      await exportPortableProject({
        sourceProjectRoot: sourceRoot,
        projectSession: { projectId: SOURCE_PROJECT_ID, projectPath: sourceRoot, leaseId: 'source-lease' },
        targetArchivePath: archivePath,
        attemptParentPath: attemptParent,
        assertCurrentContext: () => undefined,
        assets: createPortableProjectAssetProvider(),
        snapshotGeneration: 'b01-roundtrip-generation',
        now: () => new Date('2026-09-21T00:00:00.000Z'),
      })
    },
    restoreArchive: async () => {
      await restorePortableProject({
        archivePath,
        targetProjectRoot: targetRoot,
        newProjectId: () => TARGET_PROJECT_ID,
        now: () => new Date('2026-09-21T01:00:00.000Z'),
      })
    },
    exportAndRestore: async () => {
      await fixture.exportArchive()
      await fixture.restoreArchive()
    },
    reopenRestoredProject: () => {
      closeProjectDatabase()
      initProjectDatabase(targetRoot)
      closeProjectDatabase()
      initProjectDatabase(targetRoot)
    },
    restoredDatabase: () => {
      const database = getProjectDb()
      if (!database) throw new Error('ROUNDTRIP_RESTORED_DATABASE_NOT_OPEN')
      return database
    },
    prepareChapter20Replacement: (database) => {
      const draftId = 121
      const body = '第20章新定稿：林澈伤势已经包扎，北门储物柜中的新证据成为当前权威。'
      database.prepare('INSERT INTO contents(id,body) VALUES(?,?)').run(draftId, body)
      database.prepare(`INSERT INTO drafts(
        id,chapter_number,version,status,source,content_id,word_count,source_dependencies
      ) VALUES(?,20,3,'draft','rewrite',?,?,?)`).run(
        draftId,
        draftId,
        Buffer.from(body).length,
        JSON.stringify([{ draftId: 20, contentHash: sha256(CHAPTER_20_BODY), kind: 'finalized',
          chapterNumber: 20, finalizationId: CHAPTER_20_FINALIZATION_ID }]),
      )
      return {
        draftId,
        body,
        commit: {
          finalizationId: 'finalization-20-replacement',
          draftId,
          chapterNumber: 20,
          chapterTitle: '第20章新定稿',
          content: body,
          contentHash: sha256(body),
          contentRevision: 1,
          targetFileName: 'chapter-20-replacement.md',
        },
      }
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      closeProjectDatabase()
      fs.rmSync(base, { recursive: true, force: true })
    },
  }
  return fixture
}
