import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  closeProjectDatabase,
  createProjectDatabase,
  getCurrentProjectPath,
  initProjectDatabase,
} from '../../database'
import { BlueprintRepository } from '../../repositories/blueprint-repository'
import {
  closeConnection,
  listDocuments,
  parsePortableKnowledgeSnapshot,
  restorePortableKnowledgeSnapshot,
  search,
} from '../../vector-store'
import { createCanonicalProjectManifest, parseCanonicalProjectManifest } from '../../../src/shared/project-format'
import { extractPortableProjectArchive, writePortableProjectArchive } from '../portable-project-archive'
import type { PortableProjectManifest } from '../portable-project-format'
import { exportPortableProject, type ExportPortableProjectInput } from '../project-archive-service'
import { restorePortableProject } from '../project-restore-service'
import { parsePortableTransferAuthority } from '../portable-transfer-authority'
import { createPortableProjectAssetProvider } from '../portable-project-assets'
import { activateCanonicalProjectData, deactivateProjectData } from '../project-data-locator'
import { readPortableRuntimeFreeze } from '../portable-runtime-freeze'
import { createProjectArchiveRoundtripFixture } from '../../../test/desktop/project-archive.fixture'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
const roots: string[] = []
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const restoreJournalPath = (target: string) => {
  const resolved = path.resolve(target).replace(/^\\\\\?\\/u, '')
  const normalized = process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
  return path.join(path.dirname(resolved), `.portable-project-restore-${sha256(normalized).slice(0, 32)}.json`)
}

interface Fixture {
  base: string
  sourceRoot: string
  sourceStorage: string
  archive: string
  targetRoot: string
  attemptParent: string
  sourceProjectId: string
  currentBody: string
}

function fixture(): Fixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'b01-restore-service-'))
  roots.push(base)
  const sourceRoot = path.join(base, '源项目')
  const sourceStorage = path.join(sourceRoot, '.ai-novel')
  const attemptParent = path.join(base, 'export-attempts')
  fs.mkdirSync(sourceStorage, { recursive: true })
  fs.mkdirSync(attemptParent)
  const sourceProjectId = randomUUID()
  fs.writeFileSync(path.join(sourceStorage, 'project.json'), JSON.stringify(createCanonicalProjectManifest({
    projectId: sourceProjectId,
    createdAt: '2026-09-20T00:00:00.000Z',
  })))
  createProjectDatabase(sourceRoot, Buffer.alloc(32, 7))
  initProjectDatabase(sourceRoot)
  BlueprintRepository.listPendingCharacterSyncOperations()
  closeProjectDatabase()
  const oldBody = '旧版定稿。'
  const currentBody = '当前定稿，作者路径 C:\\设定\\雨夜.txt 必须原样。'
  const db = new Database(path.join(sourceStorage, 'project.db'))
  db.pragma('foreign_keys = ON')
  try {
    db.prepare("INSERT INTO project_core(id,project_name,writing_language) VALUES('main','雨夜','zh-CN')").run()
    db.prepare('INSERT INTO contents(id,body) VALUES(1,?),(2,?)').run(oldBody, currentBody)
    db.prepare(`INSERT INTO drafts(id,chapter_number,version,status,source,content_id,word_count,source_dependencies)
      VALUES(1,1,1,'finalized','write',1,?,'[]'),(2,1,2,'finalized','rewrite',2,?,'[]')`)
      .run(oldBody.length, currentBody.length)
    db.prepare(`INSERT INTO finalization_outbox(
      finalization_id,draft_id,chapter_number,chapter_title,content_hash,content_revision,content_snapshot,
      target_file_name,publication_status,last_error
    ) VALUES(?,1,1,'旧雨',?,1,?,'旧雨.md','published',''),(?,2,1,'新雨',?,1,?,'新雨.md','pending','')`)
      .run('finalization-old', sha256(oldBody), oldBody, 'finalization-current', sha256(currentBody), currentBody)
    db.prepare(`INSERT INTO summary_snapshots(
      id,draft_id,chapter_number,chapter_notes,source_finalization_id,source_content_hash,projection_generation
    ) VALUES(1,1,1,'旧摘要','finalization-old',?,1),(2,2,1,'当前摘要','finalization-current',?,2)`)
      .run(sha256(oldBody), sha256(currentBody))
  } finally { db.close() }
  return {
    base,
    sourceRoot,
    sourceStorage,
    archive: path.join(base, 'project.ainovel'),
    targetRoot: path.join(base, '恢复项目'),
    attemptParent,
    sourceProjectId,
    currentBody,
  }
}

function exportInput(f: Fixture): ExportPortableProjectInput {
  return {
    sourceProjectRoot: f.sourceRoot,
    projectSession: { projectId: f.sourceProjectId, projectPath: f.sourceRoot, leaseId: 'lease' },
    targetArchivePath: f.archive,
    attemptParentPath: f.attemptParent,
    assertCurrentContext: () => undefined,
    assets: { snapshot: () => ({ files: [], verifyUnchanged: () => undefined }) },
    snapshotGeneration: 'restore-roundtrip-1',
    now: () => new Date('2026-09-21T00:00:00.000Z'),
  }
}

async function exportedFixture(): Promise<Fixture> {
  const f = fixture()
  await exportPortableProject(exportInput(f))
  return f
}

async function archiveWithout(f: Fixture, archivePath: string): Promise<string> {
  const unpackParent = path.join(f.base, `variant-${randomUUID()}`)
  fs.mkdirSync(unpackParent)
  const unpacked = await extractPortableProjectArchive({ archivePath: f.archive, stagingParentPath: unpackParent })
  const key = archivePath.toLocaleLowerCase('en-US')
  const entries = unpacked.manifest.entries.filter(entry => entry.path.toLocaleLowerCase('en-US') !== key)
  const total = entries.reduce((sum, entry) => sum + entry.byteSize, 0)
  const manifest: PortableProjectManifest = {
    ...unpacked.manifest,
    entries,
    declaredUncompressedBytes: total,
    declaredCompressedBytes: total,
  }
  const target = path.join(f.base, `missing-${randomUUID()}.ainovel`)
  await writePortableProjectArchive({
    manifest,
    sources: entries.map(entry => ({ entry, sourcePath: path.join(unpacked.stagingPath, ...entry.path.split('/')) })),
    targetPath: target,
  })
  return target
}

async function corruptArchiveEntry(f: Fixture, archivePath: string): Promise<string> {
  const unpackParent = path.join(f.base, `variant-${randomUUID()}`)
  fs.mkdirSync(unpackParent)
  const unpacked = await extractPortableProjectArchive({ archivePath: f.archive, stagingParentPath: unpackParent })
  const file = path.join(unpacked.stagingPath, ...archivePath.split('/'))
  fs.writeFileSync(file, '{')
  const entries = unpacked.manifest.entries.map(entry => entry.path === archivePath
    ? { ...entry, byteSize: 1, sha256: sha256('{') } : entry)
  const total = entries.reduce((sum, entry) => sum + entry.byteSize, 0)
  const target = path.join(f.base, `corrupt-${randomUUID()}.ainovel`)
  await writePortableProjectArchive({
    manifest: { ...unpacked.manifest, entries, declaredUncompressedBytes: total, declaredCompressedBytes: total },
    sources: entries.map(entry => ({ entry, sourcePath: path.join(unpacked.stagingPath, ...entry.path.split('/')) })),
    targetPath: target,
  })
  return target
}

async function archiveWithExtra(f: Fixture, archivePath: string): Promise<string> {
  const unpackParent = path.join(f.base, `variant-${randomUUID()}`)
  fs.mkdirSync(unpackParent)
  const unpacked = await extractPortableProjectArchive({ archivePath: f.archive, stagingParentPath: unpackParent })
  const sourcePath = path.join(unpacked.stagingPath, `extra-${randomUUID()}.txt`)
  fs.writeFileSync(sourcePath, 'reserved')
  const entry = { path: archivePath, byteSize: 8, sha256: sha256('reserved'), disposition: 'author-content' as const }
  const entries = [...unpacked.manifest.entries, entry]
  const total = entries.reduce((sum, item) => sum + item.byteSize, 0)
  const target = path.join(f.base, `reserved-${randomUUID()}.ainovel`)
  await writePortableProjectArchive({
    manifest: { ...unpacked.manifest, entries, declaredUncompressedBytes: total, declaredCompressedBytes: total },
    sources: [
      ...unpacked.manifest.entries.map(item => ({
        entry: item,
        sourcePath: path.join(unpacked.stagingPath, ...item.path.split('/')),
      })),
      { entry, sourcePath },
    ],
    targetPath: target,
  })
  return target
}

afterEach(() => {
  closeProjectDatabase()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('portable project restore service', () => {
  it('restores the shared 20-chapter corpus under a new identity with exact authored assets and frozen history', async () => {
    const f = await createProjectArchiveRoundtripFixture()
    try {
      await f.exportAndRestore()
      expect(parseCanonicalProjectManifest(JSON.parse(fs.readFileSync(
        path.join(f.targetStorage, 'project.json'), 'utf8',
      ))).projectId).toBe(f.targetProjectId)
      expect(f.targetProjectId).not.toBe(f.sourceProjectId)

      const db = new Database(f.targetDatabasePath, { readonly: true })
      let avatarPath = ''
      try {
        expect(db.prepare("SELECT COUNT(*) FROM drafts WHERE status='finalized'").pluck().get()).toBe(20)
        expect(Buffer.from(db.prepare('SELECT body FROM contents WHERE id=20').pluck().get() as string))
          .toEqual(f.chapter20BodyBytes)
        expect(db.prepare('SELECT character_id FROM characters ORDER BY character_id').pluck().all())
          .toEqual([f.characterId, f.supportingCharacterId])
        expect(db.prepare('SELECT source_character_id,target_character_id,relation FROM character_relationships').get())
          .toEqual({ source_character_id: f.characterId, target_character_id: f.supportingCharacterId, relation: '盟友' })
        const character = db.prepare('SELECT cs_physical_state AS physicalState,cs_key_items AS keyItems FROM characters WHERE character_id=?')
          .get(f.characterId)
        expect(character).toEqual({ physicalState: f.chapter20Injury, keyItems: f.chapter20Clue })
        avatarPath = db.prepare('SELECT relative_path FROM character_avatar_assets WHERE character_id=?').pluck().get(f.characterId) as string
        expect(db.prepare("SELECT status FROM recovery_candidates WHERE candidate_id='candidate-old'").pluck().get()).toBe('pending')
        expect(JSON.parse(db.prepare("SELECT attempt_json FROM generation_attempts WHERE attempt_id='attempt-unknown'")
          .pluck().get() as string)).toMatchObject({ status: 'unknown' })
        expect(db.prepare("SELECT publication_status FROM finalization_outbox WHERE finalization_id='outbox-old'").pluck().get()).toBe('pending')
        expect(db.prepare("SELECT status FROM import_runs WHERE id='import-old'").pluck().get()).toBe('ready')
      } finally { db.close() }

      expect(fs.readFileSync(path.join(f.targetStorage, avatarPath))).toEqual(f.avatarBytes)
      expect(JSON.parse(fs.readFileSync(path.join(f.targetStorage, 'prompts', 'draft.json'), 'utf8')))
        .toMatchObject({ content: '第21章必须承接伤势与旧车站车票。' })
      expect(fs.readFileSync(path.join(f.targetStorage, 'skills', 'roundtrip', 'SKILL.md'), 'utf8'))
        .toContain('保留权威正文与连续性来源。')
      expect(JSON.parse(fs.readFileSync(path.join(f.targetStorage, 'writing-skills.json'), 'utf8')))
        .toEqual({ version: 1, bindings: { drafting: 'project:roundtrip' } })
      expect(JSON.parse(fs.readFileSync(path.join(f.targetStorage, 'partial_arch', 'history.json'), 'utf8')))
        .toEqual({ visible: '旧 partial history 可见但不可执行' })
      expect(parsePortableKnowledgeSnapshot(JSON.parse(fs.readFileSync(
        path.join(f.targetStorage, 'portable-knowledge-source.json'), 'utf8',
      ))).documents).toEqual([expect.objectContaining({
        docId: 'knowledge-rain-city',
        chunks: [expect.objectContaining({ text: '雨城北门只在雨夜开放，储物柜编号为二十。' })],
      })])

      const guard = readPortableRuntimeFreeze(f.targetRoot)
      expect(guard.active).toBe(true)
      expect(guard.isFrozen('recovery_candidates', 'candidate-old')).toBe(true)
      expect(guard.isFrozen('generation_attempts', 'attempt-unknown')).toBe(true)
      expect(guard.isFrozen('finalization_outbox', 'outbox-old')).toBe(true)
      expect(guard.isFrozen('import_runs', 'import-old')).toBe(true)
      const authority = parsePortableTransferAuthority(JSON.parse(fs.readFileSync(f.transferAuthorityPath, 'utf8')))
      expect(authority).toMatchObject({ originProjectId: f.sourceProjectId, targetProjectId: f.targetProjectId })
      expect(authority.finalizations).toHaveLength(20)
      expect(authority.summarySources).toHaveLength(20)
    } finally { f.dispose() }
  })

  it('roundtrips production raw assets and canonical knowledge as searchable full text only', async () => {
    const f = fixture()
    fs.mkdirSync(path.join(f.sourceStorage, 'prompts'))
    fs.mkdirSync(path.join(f.sourceStorage, 'skills', '作者'), { recursive: true })
    fs.writeFileSync(path.join(f.sourceStorage, 'prompts', '续写.json'), '{"提示":"保留铜钥匙"}')
    fs.writeFileSync(path.join(f.sourceStorage, 'skills', '作者', 'SKILL.md'), '维持克制叙述。')
    fs.writeFileSync(path.join(f.sourceStorage, 'partial_arch.json'), '{"候选":"未采用段落"}')
    await restorePortableKnowledgeSnapshot(f.sourceStorage, { version: 1, documents: [{
      docId: 'doc-世界观', fileName: '世界观.txt', corpusKind: 'project-knowledge',
      chunks: [{ chunkIndex: 0, text: '雨城北门由铜钥匙开启。' }, { chunkIndex: 1, text: '城外没有向量服务。' }],
    }] })
    await exportPortableProject({ ...exportInput(f), assets: createPortableProjectAssetProvider() })
    const firstReceipt = await restorePortableProject({ archivePath: f.archive, targetProjectRoot: f.targetRoot })
    expect(await restorePortableProject({ archivePath: f.archive, targetProjectRoot: f.targetRoot })).toEqual(firstReceipt)

    expect(fs.readFileSync(path.join(f.targetRoot, '.ai-novel', 'prompts', '续写.json'), 'utf8'))
      .toBe('{"提示":"保留铜钥匙"}')
    expect(fs.readFileSync(path.join(f.targetRoot, '.ai-novel', 'skills', '作者', 'SKILL.md'), 'utf8'))
      .toBe('维持克制叙述。')
    expect(fs.existsSync(path.join(f.targetRoot, '.ai-novel', 'embedding-spaces.json'))).toBe(false)
    activateCanonicalProjectData(f.targetRoot)
    try {
      expect(await listDocuments(f.targetRoot)).toEqual([expect.objectContaining({
        id: 'doc-世界观', fileName: '世界观.txt', corpusKind: 'project-knowledge', chunkCount: 2, filePath: '',
      })])
      expect(await search(f.targetRoot, '铜钥匙')).toEqual([expect.objectContaining({
        text: '雨城北门由铜钥匙开启。', fileName: '世界观.txt',
      })])
    } finally {
      closeConnection(f.targetRoot)
      deactivateProjectData(f.targetRoot)
    }
    expect(fs.readdirSync(path.join(f.targetRoot, '.ai-novel', 'lancedb'))
      .some(name => name.startsWith('chunks__space_'))).toBe(false)

    fs.writeFileSync(path.join(f.targetRoot, '.ai-novel', 'portable-knowledge-source.json'), '{"stale":true}')
    const reexportAttempts = path.join(f.base, 'reexport-attempts')
    const reexportExtracts = path.join(f.base, 'reexport-extracts')
    const reexportArchive = path.join(f.base, 'reexport.ainovel')
    fs.mkdirSync(reexportAttempts)
    fs.mkdirSync(reexportExtracts)
    await exportPortableProject({
      sourceProjectRoot: f.targetRoot,
      projectSession: { projectId: firstReceipt.targetProjectId, projectPath: f.targetRoot, leaseId: 'reexport' },
      targetArchivePath: reexportArchive,
      attemptParentPath: reexportAttempts,
      assertCurrentContext: () => undefined,
      assets: createPortableProjectAssetProvider(),
      snapshotGeneration: 'reexport-generation',
    })
    const reexported = await extractPortableProjectArchive({ archivePath: reexportArchive,
      stagingParentPath: reexportExtracts })
    expect(reexported.manifest.entries.filter(entry => entry.path === 'portable-knowledge-source.json')).toHaveLength(1)
    expect(parsePortableKnowledgeSnapshot(JSON.parse(fs.readFileSync(
      path.join(reexported.stagingPath, 'portable-knowledge-source.json'), 'utf8',
    )))).toEqual({ version: 1, documents: [{
      docId: 'doc-世界观', fileName: '世界观.txt', corpusKind: 'project-knowledge',
      chunks: [{ chunkIndex: 0, text: '雨城北门由铜钥匙开启。' }, { chunkIndex: 1, text: '城外没有向量服务。' }],
    }] })
  })

  it('restores under a new project identity without switching the active database', async () => {
    const f = await exportedFixture()
    const inspectParent = path.join(f.base, 'inspect')
    fs.mkdirSync(inspectParent)
    const exported = await extractPortableProjectArchive({ archivePath: f.archive, stagingParentPath: inspectParent })
    const frozenBytes = fs.readFileSync(path.join(exported.stagingPath, 'portable-runtime-freeze.json'))
    initProjectDatabase(f.sourceRoot)
    const targetProjectId = '11111111-1111-4111-8111-111111111111'

    const receipt = await restorePortableProject({
      archivePath: f.archive,
      targetProjectRoot: f.targetRoot,
      newProjectId: () => targetProjectId,
      now: () => new Date('2026-09-21T01:00:00.000Z'),
    })

    expect(receipt).toEqual({
      originProjectId: f.sourceProjectId,
      targetProjectId,
      targetProjectRoot: f.targetRoot,
      snapshotGeneration: 'restore-roundtrip-1',
      portableDatabaseSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      requiresRuntimeFreezeGuard: true,
    })
    expect(getCurrentProjectPath()).toBe(f.sourceRoot)
    expect(parseCanonicalProjectManifest(JSON.parse(fs.readFileSync(
      path.join(f.targetRoot, '.ai-novel', 'project.json'), 'utf8',
    ))).projectId).toBe(targetProjectId)
    expect(fs.readFileSync(path.join(f.targetRoot, '.ai-novel', 'portable-runtime-freeze.json'))).toEqual(frozenBytes)

    const databasePath = path.join(f.targetRoot, '.ai-novel', 'project.db')
    expect(sha256(fs.readFileSync(databasePath))).toBe(receipt.portableDatabaseSha256)
    const db = new Database(databasePath, { readonly: true })
    try {
      expect(db.prepare('SELECT id FROM project_core').pluck().get()).toBe('main')
      expect(db.prepare('SELECT body FROM contents WHERE id=2').pluck().get()).toBe(f.currentBody)
      expect(db.prepare('SELECT finalization_id FROM finalization_outbox ORDER BY draft_id').pluck().all())
        .toEqual(['finalization-old', 'finalization-current'])
      expect(db.prepare('SELECT id FROM summary_snapshots ORDER BY id').pluck().all()).toEqual([1, 2])
    } finally { db.close() }
    const authority = parsePortableTransferAuthority(JSON.parse(fs.readFileSync(
      path.join(f.targetRoot, '.ai-novel', 'portable-transfer-authority.json'), 'utf8',
    )))
    expect(authority.targetProjectId).toBe(targetProjectId)
    expect(authority.finalizations).toEqual([expect.objectContaining({
      finalizationId: 'finalization-current', draftId: 2, chapterNumber: 1, contentHash: sha256(f.currentBody),
    })])
    expect(authority.summarySources).toEqual([expect.objectContaining({
      summaryId: 2, draftId: 2, sourceFinalizationId: 'finalization-current',
    })])
    expect(fs.readdirSync(f.base).filter(name => name.startsWith('.portable-project-attempt-'))).toEqual([])
  })

  it('rejects a corrupt production knowledge snapshot without exposing a target', async () => {
    const f = fixture()
    await exportPortableProject({ ...exportInput(f), assets: createPortableProjectAssetProvider() })
    const corrupt = await corruptArchiveEntry(f, 'portable-knowledge-source.json')
    await expect(restorePortableProject({ archivePath: corrupt, targetProjectRoot: f.targetRoot }))
      .rejects.toThrow('PORTABLE_RESTORE_INVALID')
    expect(fs.existsSync(f.targetRoot)).toBe(false)
  })

  it('refuses an existing target without modifying it', async () => {
    const f = await exportedFixture()
    fs.mkdirSync(f.targetRoot)
    fs.writeFileSync(path.join(f.targetRoot, 'keep.txt'), 'keep')
    await expect(restorePortableProject({ archivePath: f.archive, targetProjectRoot: f.targetRoot }))
      .rejects.toThrow('PORTABLE_RESTORE_TARGET_EXISTS')
    expect(fs.readFileSync(path.join(f.targetRoot, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it.each([
    ['transfer receipt', '.ai-novel/portable-transfer-authority.json'],
    ['runtime freeze', 'portable-runtime-freeze.json'],
  ])('rejects a missing %s and cleans its extraction attempt', async (_label, missingPath) => {
    const f = await exportedFixture()
    const archive = await archiveWithout(f, missingPath)
    await expect(restorePortableProject({ archivePath: archive, targetProjectRoot: f.targetRoot }))
      .rejects.toThrow('PORTABLE_RESTORE_INVALID')
    expect(fs.existsSync(f.targetRoot)).toBe(false)
    expect(fs.readdirSync(f.base).filter(name => name.startsWith('.portable-project-attempt-'))).toEqual([])
  })

  it.each([
    ['transfer receipt', '.ai-novel/portable-transfer-authority.json'],
    ['runtime freeze', 'portable-runtime-freeze.json'],
  ])('rejects a corrupt %s and cleans its extraction attempt', async (_label, corruptPath) => {
    const f = await exportedFixture()
    const corrupt = await corruptArchiveEntry(f, corruptPath)
    await expect(restorePortableProject({ archivePath: corrupt, targetProjectRoot: f.targetRoot }))
      .rejects.toThrow('PORTABLE_RESTORE_INVALID')
    expect(fs.readdirSync(f.base).filter(name => name.startsWith('.portable-project-attempt-'))).toEqual([])
  })

  it('preserves a target created by a racing third party', async () => {
    const f = await exportedFixture()
    await expect(restorePortableProject({
      archivePath: f.archive,
      targetProjectRoot: f.targetRoot,
      __testHooks: { beforeInstall: (_staging, target) => {
        fs.mkdirSync(target)
        fs.writeFileSync(path.join(target, 'keep.txt'), 'replacement')
      } },
    })).rejects.toThrow('PORTABLE_RESTORE_TARGET_EXISTS')
    expect(fs.readFileSync(path.join(f.targetRoot, 'keep.txt'), 'utf8')).toBe('replacement')
  })

  it('does not depend on POSIX rename-over-empty behavior when an empty target wins the race', async () => {
    const f = await exportedFixture()
    const originalRename = fs.renameSync
    let rootRenameCalls = 0
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (path.resolve(target.toString()) === path.resolve(f.targetRoot)) {
        rootRenameCalls += 1
        if (fs.existsSync(f.targetRoot) && fs.readdirSync(f.targetRoot).length === 0) fs.rmdirSync(f.targetRoot)
      }
      return originalRename(source, target)
    })
    try {
      await expect(restorePortableProject({
        archivePath: f.archive,
        targetProjectRoot: f.targetRoot,
        __testHooks: { beforeInstall: (_staging, target) => fs.mkdirSync(target) },
      })).rejects.toThrow('PORTABLE_RESTORE_TARGET_EXISTS')
      expect(fs.readdirSync(f.targetRoot)).toEqual([])
      expect(rootRenameCalls).toBe(0)
    } finally { rename.mockRestore() }
  })

  it('resumes the same archive from an owned partial reservation without exposing a valid project early', async () => {
    const f = await exportedFixture()
    let staging = ''
    await expect(restorePortableProject({
      archivePath: f.archive,
      targetProjectRoot: f.targetRoot,
      newProjectId: () => '11111111-1111-4111-8111-111111111111',
      __testHooks: {
        beforeInstall: value => { staging = value },
        afterTargetReserved: (journal, target) => {
          const partialStorage = path.join(target, '.ai-novel')
          fs.mkdirSync(partialStorage)
          const token = (JSON.parse(fs.readFileSync(journal, 'utf8')) as { reservationToken: string }).reservationToken
          const temporary = path.join(partialStorage, `.portable-runtime-freeze.json.portable-restore-${token}.tmp`)
          fs.copyFileSync(
            path.join(staging, '.ai-novel', 'portable-runtime-freeze.json'),
            temporary,
          )
          fs.linkSync(temporary, path.join(partialStorage, 'portable-runtime-freeze.json'))
          throw new Error('simulated-crash-with-partial-reservation')
        },
      },
    })).rejects.toThrow('simulated-crash-with-partial-reservation')
    expect(fs.existsSync(path.join(f.targetRoot, '.ai-novel', 'project.json'))).toBe(false)
    expect(fs.existsSync(restoreJournalPath(f.targetRoot))).toBe(true)

    const recovered = await restorePortableProject({ archivePath: f.archive, targetProjectRoot: f.targetRoot })
    expect(recovered.targetProjectId).toBe('11111111-1111-4111-8111-111111111111')
    expect(fs.existsSync(path.join(f.targetRoot, '.ai-novel', 'project.json'))).toBe(true)
    expect(fs.existsSync(path.join(f.targetRoot, '.portable-restore-reservation.json'))).toBe(false)
    expect(fs.existsSync(restoreJournalPath(f.targetRoot))).toBe(false)
  })

  it('returns the complete installation after the commit response is lost', async () => {
    const f = await exportedFixture()
    const targetProjectId = '11111111-1111-4111-8111-111111111111'
    await expect(restorePortableProject({
      archivePath: f.archive,
      targetProjectRoot: f.targetRoot,
      newProjectId: () => targetProjectId,
      __testHooks: { afterInstallCommitted: target => {
        const journal = JSON.parse(fs.readFileSync(restoreJournalPath(target), 'utf8')) as { reservationToken: string }
        const manifest = path.join(target, '.ai-novel', 'project.json')
        fs.linkSync(manifest, path.join(
          target,
          '.ai-novel',
          `.project.json.portable-restore-${journal.reservationToken}.tmp`,
        ))
        throw new Error('response-lost')
      } },
    })).rejects.toThrow('response-lost')

    const replay = await restorePortableProject({
      archivePath: f.archive,
      targetProjectRoot: f.targetRoot,
      newProjectId: () => { throw new Error('must reuse committed identity') },
    })
    expect(replay.targetProjectId).toBe(targetProjectId)
    expect(fs.existsSync(path.join(f.targetRoot, '.portable-restore-reservation.json'))).toBe(false)
    expect(fs.existsSync(restoreJournalPath(f.targetRoot))).toBe(false)
    expect(fs.readdirSync(path.join(f.targetRoot, '.ai-novel')).some(name => name.endsWith('.tmp'))).toBe(false)
  })

  it('preserves an owned reservation when a different archive targets the same path', { timeout: 20_000 }, async () => {
    const first = await exportedFixture()
    const second = await exportedFixture()
    await expect(restorePortableProject({
      archivePath: first.archive,
      targetProjectRoot: first.targetRoot,
      __testHooks: { afterTargetReserved: () => { throw new Error('first-crashed') } },
    })).rejects.toThrow('first-crashed')
    const before = fs.readFileSync(path.join(first.targetRoot, '.portable-restore-reservation.json'))

    await expect(restorePortableProject({ archivePath: second.archive, targetProjectRoot: first.targetRoot }))
      .rejects.toThrow('PORTABLE_RESTORE_TARGET_EXISTS')
    expect(fs.readFileSync(path.join(first.targetRoot, '.portable-restore-reservation.json'))).toEqual(before)
    expect(fs.existsSync(path.join(first.targetRoot, '.ai-novel', 'project.json'))).toBe(false)
  })

  it('fails closed on a damaged or linked install journal without deleting it', async () => {
    const damaged = await exportedFixture()
    const damagedJournal = restoreJournalPath(damaged.targetRoot)
    fs.writeFileSync(damagedJournal, '{')
    await expect(restorePortableProject({ archivePath: damaged.archive, targetProjectRoot: damaged.targetRoot }))
      .rejects.toThrow('PORTABLE_RESTORE_UNSAFE_TARGET')
    expect(fs.readFileSync(damagedJournal, 'utf8')).toBe('{')

    const linked = await exportedFixture()
    const outside = path.join(linked.base, 'outside-journal.json')
    fs.writeFileSync(outside, '{}')
    const linkedJournal = restoreJournalPath(linked.targetRoot)
    fs.symlinkSync(outside, linkedJournal, 'file')
    await expect(restorePortableProject({ archivePath: linked.archive, targetProjectRoot: linked.targetRoot }))
      .rejects.toThrow('PORTABLE_RESTORE_UNSAFE_TARGET')
    expect(fs.readFileSync(outside, 'utf8')).toBe('{}')
    expect(fs.lstatSync(linkedJournal).isSymbolicLink()).toBe(true)
  })

  it('rejects a linked target root and preserves the linked directory', async () => {
    const f = await exportedFixture()
    const outside = path.join(f.base, 'outside-target')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep')
    fs.symlinkSync(outside, f.targetRoot, 'junction')
    await expect(restorePortableProject({ archivePath: f.archive, targetProjectRoot: f.targetRoot }))
      .rejects.toThrow('PORTABLE_RESTORE_UNSAFE_TARGET')
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('has no partial final target before commit and a complete project after commit', async () => {
    const f = await exportedFixture()
    await expect(restorePortableProject({
      archivePath: f.archive,
      targetProjectRoot: f.targetRoot,
      __testHooks: { beforeInstall: () => { throw new Error('crash-before-commit') } },
    })).rejects.toThrow('crash-before-commit')
    expect(fs.existsSync(f.targetRoot)).toBe(false)

    const committed = path.join(f.base, 'committed-before-crash')
    await expect(restorePortableProject({
      archivePath: f.archive,
      targetProjectRoot: committed,
      __testHooks: { afterInstallCommitted: () => { throw new Error('crash-after-commit') } },
    })).rejects.toThrow('crash-after-commit')
    expect(parseCanonicalProjectManifest(JSON.parse(fs.readFileSync(
      path.join(committed, '.ai-novel', 'project.json'), 'utf8',
    ))).kind).toBe('ai-novel-project')
    expect(fs.existsSync(path.join(committed, '.ai-novel', 'project.db'))).toBe(true)
  })

  it.each([
    ['extra reserved entry', '.ai-novel/extra.txt'],
    ['nested reserved namespace', '.ai-novel/.ai-novel/extra.txt'],
    ['flattened authority collision', 'portable-transfer-authority.json'],
    ['portable vector table', 'lancedb/chunks.lance'],
    ['portable embedding registry', 'embedding-spaces.json'],
  ])('rejects %s', async (_label, archivePath) => {
    const f = await exportedFixture()
    const archive = await archiveWithExtra(f, archivePath)
    await expect(restorePortableProject({ archivePath: archive, targetProjectRoot: f.targetRoot }))
      .rejects.toThrow('PORTABLE_RESTORE_INVALID')
    expect(fs.existsSync(f.targetRoot)).toBe(false)
  })

  it('never recursively removes unknown staging content after validation fails', async () => {
    const f = await exportedFixture()
    let staging = ''
    await expect(restorePortableProject({
      archivePath: f.archive,
      targetProjectRoot: f.targetRoot,
      __testHooks: { afterStagingCaptured: root => {
        staging = root
        fs.writeFileSync(path.join(root, 'keep.txt'), 'not-owned')
        fs.writeFileSync(path.join(root, '.ai-novel', 'portable-transfer-authority.json'), '{')
      } },
    })).rejects.toThrow('PORTABLE_RESTORE_INVALID')
    expect(fs.readFileSync(path.join(staging, 'keep.txt'), 'utf8')).toBe('not-owned')
  })
})
