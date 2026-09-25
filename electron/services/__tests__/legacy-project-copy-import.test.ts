import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, expect, it } from 'vitest'
import * as lance from '@lancedb/lancedb'
import { Field, Int32, Schema, Utf8 } from 'apache-arrow'
import { importLegacyProjectCopy } from '../legacy-project-copy-import'
import { verifyProjectSqlite } from '../sqlite-project-migration'
import { readPortableRuntimeFreeze } from '../portable-runtime-freeze'
import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { ChapterDeletionService } from '../chapter-deletion-service'
import { readPortableCurrentAuthority } from '../portable-current-authority'
import { createPortableTransferAuthority } from '../portable-transfer-authority'
import { SummaryRepository } from '../../repositories/summary-repository'
import { LLMHistoryRepository } from '../../repositories/llm-repository'
import { PostProcessRepository } from '../../repositories/post-process-repository'
import { closeConnection } from '../../vector-store'
import { listDocuments, readDocumentCopy } from '../../knowledge-base'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const roots: string[] = []
const preflightOptions = { maxNativePathCharacters: 4096 }
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function fixture(version: 'v100' | 'v110') {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/a11-copy-import')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'attempt-')); roots.push(root)
  const source = path.join(root, 'old'), target = path.join(root, 'new'), legacy = path.join(source, '.vela')
  fs.mkdirSync(legacy, { recursive: true })
  const seed = path.join(root, 'seed.db'), db = new Database(seed)
  try {
    db.pragma('journal_mode = WAL'); db.pragma('wal_autocheckpoint = 0')
    db.exec(fs.readFileSync(new URL(`./legacy-${version}-schema.sql`, import.meta.url), 'utf8'))
    db.prepare('INSERT INTO project_core(rowid,id,project_name,characters_arch) VALUES (?,?,?,?)')
      .run(7, 'main', '合成旧项目', '作者明确角色群像，与正文推断不同')
    db.prepare('INSERT INTO contents(id,body) VALUES (?,?)').run(11, '合成章节正文\r\n原字节')
    db.prepare('INSERT INTO drafts(id,chapter_number,version,content_id,word_count) VALUES (?,?,?,?,?)').run(19, 7, 1, 11, 876)
    for (const suffix of ['', '-wal', '-shm']) fs.copyFileSync(seed + suffix, path.join(legacy, 'vela.db') + suffix)
  } finally { db.close() }
  const sourceProjectId = randomUUID()
  fs.writeFileSync(path.join(legacy, 'project.json'), JSON.stringify({ schemaVersion: 1, kind: 'ai-novel-project', projectId: sourceProjectId, createdAt: '2026-09-01T00:00:00.000Z' }))
  fs.mkdirSync(path.join(legacy, 'prompts'))
  fs.writeFileSync(path.join(legacy, 'prompts', 'author.txt'), '作者项目级提示词')
  fs.mkdirSync(path.join(legacy, 'skills'))
  fs.writeFileSync(path.join(legacy, 'skills', 'author.md'), '作者项目级 Skill 原文')
  fs.writeFileSync(path.join(source, 'outline.md'), '作者目录级大纲')
  const sourceHashes = Object.fromEntries(['vela.db', 'vela.db-wal', 'vela.db-shm', 'project.json', 'prompts/author.txt', 'skills/author.md']
    .map(name => [name, hash(path.join(legacy, name))]))
  return { source, target, legacy, sourceProjectId, sourceHashes }
}
afterEach(() => { closeProjectDatabase(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

it.each(['v100', 'v110'] as const)('%s 离线完整副本含 WAL、作者配置和正文，源只读且新身份独立', async version => {
  const f = fixture(version)
  const result = await importLegacyProjectCopy({ sourceRoot: f.source, targetRoot: f.target, preflightOptions })
  expect(result, JSON.stringify(result)).toMatchObject({ state: 'ready', targetRoot: f.target })
  if (result.state !== 'ready') return
  expect(result.projectId).not.toBe(f.sourceProjectId)
  expect(fs.existsSync(path.join(f.target, '.vela'))).toBe(false)
  expect(fs.readFileSync(path.join(f.target, 'outline.md'), 'utf8')).toBe('作者目录级大纲')
  expect(fs.readFileSync(path.join(f.target, '.ai-novel', 'prompts', 'author.txt'), 'utf8')).toBe('作者项目级提示词')
  expect(fs.readFileSync(path.join(f.target, '.ai-novel', 'skills', 'author.md'), 'utf8')).toBe('作者项目级 Skill 原文')
  expect(verifyProjectSqlite({ databasePath: path.join(f.target, '.ai-novel', 'project.db') }).schemaVersion).toBe(7)
  const db = new Database(path.join(f.target, '.ai-novel', 'project.db'), { readonly: true })
  try {
    expect(db.prepare('SELECT characters_arch FROM project_core WHERE id=?').pluck().get('main')).toBe('作者明确角色群像，与正文推断不同')
    expect(db.prepare('SELECT body FROM contents WHERE id=11').pluck().get()).toBe('合成章节正文\r\n原字节')
    expect(db.prepare('SELECT content_id FROM drafts WHERE id=19').pluck().get()).toBe(11)
  } finally { db.close() }
  expect(Object.fromEntries(Object.keys(f.sourceHashes).map(name => [name, hash(path.join(f.legacy, name))]))).toEqual(f.sourceHashes)
  expect(await importLegacyProjectCopy({ sourceRoot: f.source, targetRoot: f.target, preflightOptions })).toMatchObject({ state: 'blocked', code: 'LEGACY_IMPORT_TARGET_EXISTS' })
})

it('旧项目根内的真实知识原文变成可读项目副本，片段不能冒充全文', async () => {
  const f = fixture('v110')
  const original = path.join(f.source, '创作资料.txt')
  const content = '完整原文第一段。\n\n完整原文第二段只存在于旧项目文件。'
  fs.writeFileSync(original, content)
  const connection = await lance.connect(path.join(f.legacy, 'lancedb'))
  const tables: lance.Table[] = []
  try {
    const fields = [new Field('id', new Utf8()), new Field('docId', new Utf8()), new Field('fileName', new Utf8()),
      new Field('text', new Utf8()), new Field('chunkIndex', new Int32()), new Field('totalChunks', new Int32()),
      new Field('importedAt', new Utf8()), new Field('corpusKind', new Utf8())]
    tables.push(await connection.createTable('chunks', [
      { id: 'old-chunk', docId: 'old-doc', fileName: '创作资料.txt', text: '完整原文第一段。',
        chunkIndex: 0, totalChunks: 1, importedAt: '2026-09-13', corpusKind: 'reference' },
    ],
    { schema: new Schema(fields) }))
    tables.push(await connection.createTable('documents', [
      { id: 'old-doc', fileName: '创作资料.txt', filePath: original,
        importedAt: '2026-09-13', chunkCount: 1, corpusKind: 'reference' },
    ]))
  } finally { for (const table of tables) table.close(); connection.close() }
  const originalHash = hash(original)
  const result = await importLegacyProjectCopy({ sourceRoot: f.source, targetRoot: f.target, preflightOptions })
  expect(result, JSON.stringify(result)).toMatchObject({ state: 'ready' })
  expect(hash(original)).toBe(originalHash)
  expect(hash(path.join(f.target, '创作资料.txt'))).toBe(originalHash)
  initProjectDatabase(f.target)
  try {
    const documents = await listDocuments(f.target)
    expect(documents.find(doc => doc.id === 'old-doc')?.filePath).toBe('knowledge-copy:old-doc')
    expect(await readDocumentCopy('old-doc', f.target)).toMatchObject({
      available: true, content, edited: false, indexStatus: 'stale',
    })
  } finally { closeConnection(f.target) }
})

it.each(['outside', 'missing'] as const)('旧知识原文引用 %s 时阻断发布且不读取旧项目外文件', async reference => {
  const f = fixture('v110')
  const filePath = reference === 'outside' ? path.join(path.dirname(f.source), '外部资料.txt')
    : path.join(f.source, '缺失资料.txt')
  if (reference === 'outside') fs.writeFileSync(filePath, '只在旧项目外的合成资料，不得读取或转入新项目。')
  const sourceHash = hash(path.join(f.legacy, 'vela.db'))
  const outsideHash = reference === 'outside' ? hash(filePath) : null
  const connection = await lance.connect(path.join(f.legacy, 'lancedb'))
  const tables: lance.Table[] = []
  try {
    tables.push(await connection.createTable('chunks', [{ id: 'old-chunk', docId: 'old-doc',
      fileName: '创作资料.txt', text: '旧索引片段', chunkIndex: 0, totalChunks: 1,
      importedAt: '2026-09-13', corpusKind: 'reference' }], { schema: new Schema([
      new Field('id', new Utf8()), new Field('docId', new Utf8()), new Field('fileName', new Utf8()),
      new Field('text', new Utf8()), new Field('chunkIndex', new Int32()), new Field('totalChunks', new Int32()),
      new Field('importedAt', new Utf8()), new Field('corpusKind', new Utf8()),
    ]) }))
    tables.push(await connection.createTable('documents', [{ id: 'old-doc', fileName: '创作资料.txt',
      filePath, importedAt: '2026-09-13', chunkCount: 1, corpusKind: 'reference' }]))
  } finally { for (const table of tables) table.close(); connection.close() }
  expect(await importLegacyProjectCopy({ sourceRoot: f.source, targetRoot: f.target, preflightOptions }))
    .toMatchObject({ state: 'blocked', code: 'LEGACY_IMPORT_KNOWLEDGE_ORIGINAL_UNAVAILABLE' })
  expect(fs.existsSync(f.target)).toBe(false)
  expect(hash(path.join(f.legacy, 'vela.db'))).toBe(sourceHash)
  if (outsideHash) expect(hash(filePath)).toBe(outsideHash)
})

it('源资料变化、未知旧资产均在发布前拒绝，旧项目保留', async () => {
  const f = fixture('v110')
  const changed = await importLegacyProjectCopy({ sourceRoot: f.source, targetRoot: f.target, preflightOptions,
    checkpoint: phase => { if (phase === 'copied') fs.appendFileSync(path.join(f.legacy, 'prompts', 'author.txt'), '外部改写') },
  })
  expect(changed).toMatchObject({ state: 'blocked', code: 'LEGACY_IMPORT_SOURCE_CHANGED' })
  expect(fs.existsSync(f.target)).toBe(false)
  expect(fs.readdirSync(path.dirname(f.target)).filter(name => name.includes('.new.legacy-import-'))).toEqual([])
  fs.writeFileSync(path.join(f.legacy, 'unmapped-author-notes.txt'), '不可静默丢弃')
  expect(await importLegacyProjectCopy({ sourceRoot: f.source, targetRoot: f.target, preflightOptions }))
    .toMatchObject({ state: 'blocked', code: 'LEGACY_IMPORT_UNMAPPED_ASSET' })
  expect(fs.existsSync(path.join(f.legacy, 'unmapped-author-notes.txt'))).toBe(true)
})

it('缺失必需旧库或目标发布前中断均不留下半成品', async () => {
  const missing = fixture('v110')
  fs.unlinkSync(path.join(missing.legacy, 'vela.db'))
  expect(await importLegacyProjectCopy({ sourceRoot: missing.source, targetRoot: missing.target, preflightOptions }))
    .toMatchObject({ state: 'blocked', code: 'LEGACY_IMPORT_UNMAPPED_ASSET' })
  expect(fs.existsSync(missing.target)).toBe(false)
  expect(fs.existsSync(path.join(missing.legacy, 'vela.db-wal'))).toBe(true)

  const interrupted = fixture('v100')
  let reachedVerified = false
  expect(await importLegacyProjectCopy({ sourceRoot: interrupted.source, targetRoot: interrupted.target, preflightOptions,
    checkpoint: phase => { if (phase === 'verified') { reachedVerified = true; throw new Error('synthetic interruption') } },
  })).toMatchObject({ state: 'blocked', code: 'LEGACY_IMPORT_IO_FAILED' })
  expect(reachedVerified).toBe(true)
  expect(fs.existsSync(interrupted.target)).toBe(false)
  expect(fs.readdirSync(path.dirname(interrupted.target)).filter(name => name.startsWith('.new.legacy-import-'))).toEqual([])
  expect(Object.fromEntries(Object.keys(interrupted.sourceHashes).map(name => [name, hash(path.join(interrupted.legacy, name))])))
    .toEqual(interrupted.sourceHashes)
})

it.each(['sqlite-converted', 'assets-converted', 'history-frozen'] as const)(
  '%s 持久化后中断只清理目标 staging，同路径重试可完成', async phase => {
    const f = fixture('v110')
    if (phase === 'history-frozen') {
      const db = new Database(path.join(f.legacy, 'vela.db'))
      try {
        db.prepare(`INSERT INTO llm_calls(id,model_id,model_name,purpose,prompt_tokens,completion_tokens,
          total_tokens,duration_ms,success,error_message,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
          .run(31, 'old-model', 'old-model', 'review', 1, 1, 2, 10, 1, '', '2026-09-01 12:00:00')
      } finally { db.close() }
    }
    const sourceFiles = Object.keys(f.sourceHashes)
    const sourceHashes = () => Object.fromEntries(sourceFiles.map(name => {
      const file = path.join(f.legacy, name)
      return [name, fs.existsSync(file) ? hash(file) : null]
    }))
    const before = sourceHashes()
    let reached = false
    const stopped = await importLegacyProjectCopy({ sourceRoot: f.source, targetRoot: f.target, preflightOptions,
      checkpoint: current => { if (current === phase) { reached = true; throw new Error('synthetic interruption') } },
    })
    expect(reached).toBe(true)
    expect(stopped).toMatchObject({ state: 'blocked', code: 'LEGACY_IMPORT_IO_FAILED' })
    expect(fs.existsSync(f.target)).toBe(false)
    expect(fs.readdirSync(path.dirname(f.target)).filter(name => name.startsWith('.new.legacy-import-'))).toEqual([])
    expect(sourceHashes()).toEqual(before)
    expect(await importLegacyProjectCopy({ sourceRoot: f.source, targetRoot: f.target, preflightOptions }))
      .toMatchObject({ state: 'ready', targetRoot: f.target })
  },
)

it('旧候选正文保留为可读冻结历史，新项目不重放', async () => {
  const f = fixture('v110'), db = new Database(path.join(f.legacy, 'vela.db'))
  try {
    db.prepare('INSERT INTO contents(id,body) VALUES(?,?)').run(12, '旧版人工审稿原文')
    db.prepare(`INSERT INTO reviews(id,base_draft_id,review_index,content_id,source_draft_chapter_number,
      source_draft_version,source_draft_status,source_content) VALUES(?,?,?,?,?,?,?,?)`)
      .run(21, 19, 1, 12, 7, 1, 'draft', '合成章节正文\r\n原字节')
    db.prepare(`INSERT INTO finalization_outbox(finalization_id,draft_id,chapter_number,chapter_title,
      content_hash,content_revision,content_snapshot,target_file_name,publication_status,last_error)
      VALUES(?,?,?,?,?,1,?,?,'pending',?)`).run('old-outbox', 19, 7, '第七章',
      createHash('sha256').update('合成章节正文\r\n原字节').digest('hex'), '合成章节正文\r\n原字节', '第七章.md', 'C:\\private\\token-secret')
    db.prepare(`INSERT INTO import_runs(id,root_run_id,effect_namespace,source_fingerprint,manifest_fingerprint,
      locale,stage,status,total_chapters,manifest_chapter_count,execution_owner,execution_epoch,lease_expires_at)
      VALUES(?,?,?,?,?,'zh-CN','parsing','running',0,0,?,?,?)`)
      .run('old-import', 'old-import', 'import:old-import', createHash('sha256').update('source').digest('hex'),
        createHash('sha256').update('manifest').digest('hex'), 'old-machine-authority', 4, 999999999)
    db.prepare(`INSERT INTO recovery_candidates(candidate_id,run_id,step_id,project_id,chapter_number,
      source_snapshot,source_hash,visible_text,content_hash) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run('old-candidate', 'old-run', 'old-step', f.sourceProjectId, 7,
        JSON.stringify({ chapterNumber: 7, title: '第七章', role: '推进', purpose: '追踪', keyEvents: '线索', characters: [] }),
        hash(path.join(f.legacy, 'project.json')), '旧候选正文', 'content-hash')
    db.prepare(`INSERT INTO llm_calls(id,model_id,model_name,purpose,prompt_tokens,completion_tokens,
      total_tokens,duration_ms,success,error_message,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(31, 'model?token=secret', 'C:\\private\\model', 'review', 120, 0, 120, 43, 0,
        'C:\\private\\token-secret', '2026-09-01 12:00:00')
    db.prepare('INSERT INTO post_process_runs(id,trigger_source_type,trigger_source_id) VALUES(?,?,?)')
      .run('old-post-run', 'draft', '19')
    db.prepare('INSERT INTO post_process_steps(run_id,step_key,ok,attempt_count,error_msg) VALUES(?,?,?,?,?)')
      .run('old-post-run', 'review', 0, 1, 'C:\\private\\token-secret')
  } finally { db.close() }
  const before = Object.fromEntries(fs.readdirSync(f.legacy).filter(name => fs.lstatSync(path.join(f.legacy, name)).isFile())
    .map(name => [name, hash(path.join(f.legacy, name))]))
  const result = await importLegacyProjectCopy({ sourceRoot: f.source, targetRoot: f.target, preflightOptions })
  expect(result).toMatchObject({ state: 'ready' })
  const frozen = readPortableRuntimeFreeze(f.target)
  const transferred = JSON.parse(fs.readFileSync(path.join(f.target, '.ai-novel', 'portable-transfer-authority.json'), 'utf8'))
  expect(transferred).toMatchObject({ originProjectId: f.sourceProjectId, targetProjectId: result.state === 'ready' ? result.projectId : undefined })
  expect(frozen.isFrozen('recovery_candidates', 'old-candidate')).toBe(true)
  expect(frozen.isFrozen('finalization_outbox', 'old-outbox')).toBe(true)
  expect(frozen.isFrozen('import_runs', 'old-import')).toBe(true)
  expect(() => frozen.assertMutable('recovery_candidates', 'old-candidate')).toThrow('PORTABLE_RUNTIME_FROZEN')
  const copy = new Database(path.join(f.target, '.ai-novel', 'project.db'), { readonly: true })
  try {
    expect(copy.prepare('SELECT visible_text FROM recovery_candidates WHERE candidate_id=?').pluck().get('old-candidate')).toBe('旧候选正文')
    expect(copy.prepare('SELECT body FROM contents WHERE id=(SELECT content_id FROM reviews WHERE id=21)').pluck().get()).toBe('旧版人工审稿原文')
    expect(copy.prepare('SELECT source_content FROM reviews WHERE id=21').pluck().get()).toBe('合成章节正文\r\n原字节')
    expect(copy.prepare('SELECT publication_status FROM finalization_outbox WHERE finalization_id=?').pluck().get('old-outbox')).toBe('pending')
    expect(copy.prepare('SELECT last_error FROM finalization_outbox WHERE finalization_id=?').pluck().get('old-outbox')).not.toContain('token-secret')
    expect(copy.prepare('SELECT execution_owner FROM import_runs WHERE id=?').pluck().get('old-import')).not.toBe('old-machine-authority')
    expect(copy.prepare('SELECT model_id,model_name,purpose,prompt_tokens,total_tokens,success,error_message FROM llm_calls WHERE id=31').get())
      .toMatchObject({ model_id: '', model_name: '旧版模型身份不可用', purpose: 'legacy', prompt_tokens: 120,
        total_tokens: 120, success: 0, error_message: '旧版错误详情不可用' })
    expect(copy.prepare("SELECT error_msg FROM post_process_steps WHERE run_id='old-post-run'").pluck().get())
      .toBe('旧版错误详情不可用')
    expect(JSON.stringify(copy.prepare('SELECT * FROM llm_calls').all())).not.toContain('token-secret')
  }
  finally { copy.close() }
  initProjectDatabase(f.target)
  expect(LLMHistoryRepository.getStats()).toMatchObject({ totalCalls: 1, failedCalls: 1, totalTokens: 120 })
  expect(LLMHistoryRepository.getHistory(1)).toMatchObject([{ modelName: '旧版模型身份不可用', success: 0 }])
  expect(PostProcessRepository.getSteps('old-post-run')).toMatchObject([{ errorMsg: '旧版错误详情不可用', attemptCount: 1 }])
  expect(Object.fromEntries(Object.keys(before).map(name => [name, hash(path.join(f.legacy, name))]))).toEqual(before)
  expect(fs.existsSync(path.join(f.legacy, 'vela.db'))).toBe(true)
})

it.each(['v100', 'v110'] as const)('%s 无 manifest 的旧历史启用新 lineage，旧删除操作不能重放', async version => {
  const f = fixture(version)
  fs.rmSync(path.join(f.legacy, 'project.json'))
  const oldCandidateProjectId = randomUUID()
  const source = new Database(path.join(f.legacy, 'vela.db'))
  try {
    source.prepare(`INSERT INTO recovery_candidates(candidate_id,run_id,step_id,project_id,chapter_number,
      source_snapshot,source_hash,visible_text,content_hash) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run('old-candidate', 'old-run', 'old-step', oldCandidateProjectId, 7,
        JSON.stringify({ chapterNumber: 7, title: '第七章', role: '推进', purpose: '追踪', keyEvents: '线索', characters: [] }),
        'old-source-hash', '旧候选正文', 'old-content-hash')
    source.prepare(`INSERT INTO chapter_deletion_operations(operation_id,draft_id,chapter_number,finalization_id,
      target_file_name,knowledge_document_id,status) VALUES(?,?,?,?,?,?,'pending')`)
      .run('old-deletion', 19, 7, 'old-finalization', '第七章.md', 'old-knowledge-doc')
    source.prepare(`INSERT INTO finalization_outbox(finalization_id,draft_id,chapter_number,chapter_title,
      content_hash,content_revision,content_snapshot,target_file_name,publication_status)
      VALUES(?,?,?,?,?,1,?,?,'pending')`).run('old-outbox', 19, 7, '第七章',
        createHash('sha256').update('合成章节正文\r\n原字节').digest('hex'), '合成章节正文\r\n原字节', '第七章.md')
    source.prepare(`INSERT INTO import_runs(id,root_run_id,effect_namespace,source_fingerprint,manifest_fingerprint,
      locale,stage,status,total_chapters,manifest_chapter_count) VALUES(?,?,?,?,?,'zh-CN','parsing','running',0,0)`)
      .run('old-import', 'old-import', 'import:old-import', createHash('sha256').update('source').digest('hex'),
        createHash('sha256').update('manifest').digest('hex'))
  } finally { source.close() }
  const sourceDatabaseHash = hash(path.join(f.legacy, 'vela.db'))
  const result = await importLegacyProjectCopy({ sourceRoot: f.source, targetRoot: f.target, preflightOptions })
  expect(result, JSON.stringify(result)).toMatchObject({ state: 'ready' })
  if (result.state !== 'ready') return
  expect(result.projectId).not.toBe(oldCandidateProjectId)
  const storage = path.join(f.target, '.ai-novel')
  const freeze = JSON.parse(fs.readFileSync(path.join(storage, 'portable-runtime-freeze.json'), 'utf8'))
  const authority = JSON.parse(fs.readFileSync(path.join(storage, 'portable-transfer-authority.json'), 'utf8'))
  expect(freeze.originProjectId).toBe(result.projectId)
  expect(authority).toMatchObject({ originProjectId: result.projectId, targetProjectId: result.projectId })
  expect(readPortableRuntimeFreeze(f.target).isFrozen('recovery_candidates', 'old-candidate')).toBe(true)
  expect(readPortableRuntimeFreeze(f.target).isFrozen('chapter_deletion_operations', 'old-deletion')).toBe(true)
  expect(readPortableRuntimeFreeze(f.target).isFrozen('finalization_outbox', 'old-outbox')).toBe(true)
  expect(readPortableRuntimeFreeze(f.target).isFrozen('import_runs', 'old-import')).toBe(true)
  initProjectDatabase(f.target)
  const targetDb = getProjectDb()!
  expect(readPortableCurrentAuthority({ database: targetDb, projectStorageRoot: storage, projectId: result.projectId }))
    .toMatchObject({ originProjectId: result.projectId })
  expect(targetDb.prepare('SELECT project_id FROM recovery_candidates WHERE candidate_id=?').pluck().get('old-candidate'))
    .toBe(oldCandidateProjectId)
  expect(targetDb.prepare('SELECT status FROM chapter_deletion_operations WHERE operation_id=?').pluck().get('old-deletion'))
    .toBe('pending')
  const calls: string[] = []
  const service = new ChapterDeletionService({ cleaner: {
    async removeManuscript() { calls.push('manuscript') },
    async removeKnowledgeDocument() { calls.push('knowledge') },
  } })
  expect(await service.retry(f.target, 'old-deletion')).toMatchObject({ success: false, committed: false,
    operation: { operationId: 'old-deletion' } })
  expect(await service.confirmLegacyKnowledgeAbsent(f.target, 'old-deletion')).toMatchObject({ success: false, committed: false,
    operation: { operationId: 'old-deletion' } })
  expect(await service.delete(f.target, { draftId: 19, chapterNumber: 7 })).toMatchObject({ success: false, committed: false,
    operation: { operationId: 'old-deletion' } })
  expect(calls).toEqual([])
  expect(targetDb.prepare('SELECT status,attempt_count FROM chapter_deletion_operations WHERE operation_id=?')
    .get('old-deletion')).toMatchObject({ status: 'pending', attempt_count: 0 })
  expect(hash(path.join(f.legacy, 'vela.db'))).toBe(sourceDatabaseHash)
})

it.each(['v100', 'v110'] as const)('%s 旧版无收据定稿正文保留为 legacy，仅转移有证明的定稿', async version => {
  const f = fixture(version)
  const source = new Database(path.join(f.legacy, 'vela.db'))
  try {
    source.prepare("UPDATE drafts SET status='finalized' WHERE id=19").run()
    source.prepare('INSERT INTO summary_snapshots(id,chapter_number,character_states) VALUES(?,?,?)')
      .run(31, 7, '{"主角":{"location":"旧设定"}}')
    source.prepare('INSERT INTO contents(id,body) VALUES(?,?)').run(12, '有来源收据的第八章定稿')
    source.prepare("INSERT INTO drafts(id,chapter_number,version,content_id,status) VALUES(22,8,1,12,'finalized')").run()
    source.prepare(`INSERT INTO finalization_outbox(finalization_id,draft_id,chapter_number,chapter_title,
      content_hash,content_revision,content_snapshot,target_file_name,publication_status)
      VALUES(?,?,?,?,?,1,?,?,'published')`).run('bound-finalization', 22, 8, '第八章',
        createHash('sha256').update('有来源收据的第八章定稿').digest('hex'), '有来源收据的第八章定稿', '第八章.md')
  } finally { source.close() }
  const sourceHash = hash(path.join(f.legacy, 'vela.db'))
  const result = await importLegacyProjectCopy({ sourceRoot: f.source, targetRoot: f.target, preflightOptions })
  expect(result, JSON.stringify(result)).toMatchObject({ state: 'ready' })
  if (result.state !== 'ready') return
  const storage = path.join(f.target, '.ai-novel')
  const authority = JSON.parse(fs.readFileSync(path.join(storage, 'portable-transfer-authority.json'), 'utf8'))
  expect(authority.finalizations).toEqual([{
    finalizationId: 'bound-finalization', draftId: 22, chapterNumber: 8,
    contentHash: createHash('sha256').update('有来源收据的第八章定稿').digest('hex'),
  }])
  expect(authority.summarySources).toEqual([])
  initProjectDatabase(f.target)
  expect(SummaryRepository.readFinalizedSource(19)).toMatchObject({ status: 'legacy', content: '合成章节正文\r\n原字节' })
  expect(getProjectDb()!.prepare('SELECT content_snapshot FROM finalization_outbox WHERE finalization_id=?').pluck().get('bound-finalization'))
    .toBe('有来源收据的第八章定稿')
  expect(getProjectDb()!.prepare('SELECT character_states FROM summary_snapshots WHERE id=31').pluck().get())
    .toBe('{"主角":{"location":"旧设定"}}')
  expect(() => createPortableTransferAuthority({ database: getProjectDb()!, originProjectId: result.projectId,
    snapshotGeneration: randomUUID(), portableDatabaseSha256: 'a'.repeat(64) })).toThrow('PORTABLE_TRANSFER_AUTHORITY_INVALID')
  expect(hash(path.join(f.legacy, 'vela.db'))).toBe(sourceHash)
})

it('旧定稿存在失配收据时拒绝发布，不能把坏收据降为 legacy', async () => {
  const f = fixture('v110')
  const source = new Database(path.join(f.legacy, 'vela.db'))
  try {
    source.prepare("UPDATE drafts SET status='finalized' WHERE id=19").run()
    source.prepare(`INSERT INTO finalization_outbox(finalization_id,draft_id,chapter_number,chapter_title,
      content_hash,content_revision,content_snapshot,target_file_name,publication_status)
      VALUES(?,?,?,?,?,1,?,?,'published')`).run('bad-finalization', 19, 7, '第七章',
        'a'.repeat(64), '失配正文', '第七章.md')
  } finally { source.close() }
  expect(await importLegacyProjectCopy({ sourceRoot: f.source, targetRoot: f.target, preflightOptions }))
    .toMatchObject({ state: 'blocked', code: 'PORTABLE_TRANSFER_AUTHORITY_INVALID' })
  expect(fs.existsSync(f.target)).toBe(false)
})

it('未被角色引用的头像原字节保留为待处理资料', async () => {
  const f = fixture('v110')
  fs.mkdirSync(path.join(f.legacy, 'avatars'))
  fs.writeFileSync(path.join(f.legacy, 'avatars', 'unmapped.png'), Buffer.from('89504e470d0a1a0a00000000', 'hex'))
  expect(await importLegacyProjectCopy({ sourceRoot: f.source, targetRoot: f.target, preflightOptions }))
    .toMatchObject({ state: 'ready' })
  const unresolved = path.join(f.target, '.ai-novel', 'avatars', 'unresolved')
  expect(fs.readFileSync(path.join(unresolved, fs.readdirSync(unresolved)[0]!))).toEqual(fs.readFileSync(path.join(f.legacy, 'avatars', 'unmapped.png')))
  expect(fs.existsSync(path.join(f.legacy, 'avatars', 'unmapped.png'))).toBe(true)
})
