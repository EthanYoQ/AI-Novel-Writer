import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { build } from 'esbuild'
import * as lance from '@lancedb/lancedb'
import { Field, Int32, Schema, Utf8 } from 'apache-arrow'
import { importLegacyProjectCopy } from '../legacy-project-copy-import'
import { verifyProjectSqlite } from '../sqlite-project-migration'
import { readPortableRuntimeFreeze } from '../portable-runtime-freeze'
import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { ChapterDeletionService } from '../chapter-deletion-service'
import { readPortableCurrentAuthority } from '../portable-current-authority'
import { ProjectAccessService } from '../project-access'
import { createPortableTransferAuthority } from '../portable-transfer-authority'
import { ProjectCoreRepository } from '../../repositories/project-core-repository'
import { CharacterRosterRepository } from '../../repositories/character-roster-repository'
import { commitAuthorCharacterRoster } from '../character-roster-author'
import { buildGenerationSourceBinding } from '../generation-source-binding'
import { SummaryRepository } from '../../repositories/summary-repository'
import { LLMHistoryRepository } from '../../repositories/llm-repository'
import { PostProcessRepository } from '../../repositories/post-process-repository'
import { closeConnection } from '../../vector-store'
import { listDocuments, readDocumentCopy } from '../../knowledge-base'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const roots: string[] = []
const preflightOptions = { maxNativePathCharacters: 4096 }
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function fixture(version: 'v100' | 'v100-official' | 'v110', charactersArch = '作者明确角色群像，与正文推断不同') {
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
      .run(7, 'main', '合成旧项目', charactersArch)
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

function sourceState(f: ReturnType<typeof fixture>) {
  const entries: [string, string][] = []
  const visit = (directory: string) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), info = fs.lstatSync(file)
      entries.push([path.relative(f.source, file), info.isFile() ? hash(file) : 'directory'])
      if (info.isDirectory()) visit(file)
    }
  }
  visit(f.source)
  return entries
}

async function verifyFrozenLegacyConsumersAfterRestart(target: string, entry: string) {
  await build({
    stdin: {
      resolveDir: process.cwd(), sourcefile: 'legacy-freeze-child.ts', loader: 'ts',
      contents: `
        import assert from 'node:assert/strict'
        import { initProjectDatabase, closeProjectDatabase, getProjectDb } from './electron/database'
        import { FinalizationService } from './electron/services/finalization-service'
        import { BlueprintRepository } from './electron/repositories/blueprint-repository'
        import { RecoveryCandidateRepository } from './electron/repositories/recovery-candidate-repository'
        import { ImportRunRepository } from './electron/repositories/import-run-repository'

        const root = process.env.LEGACY_FREEZE_ROOT!
        let publishCalls = 0, modelFetchCalls = 0
        globalThis.fetch = async () => { modelFetchCalls++; throw new Error('unexpected model fetch') }
        initProjectDatabase(root)
        try {
          const db = getProjectDb()!
          const rows = () => ['finalization_outbox', 'recovery_candidates', 'import_runs']
            .map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all())
          const before = rows()
          const retry = await new FinalizationService({ publisher: { async publish() { publishCalls++ } } })
            .retry({ projectRoot: root, finalizationId: 'old-outbox' })
          assert.equal(retry.success, false)
          assert.equal(retry.committed, true)
          assert.equal(retry.error, 'PORTABLE_RUNTIME_FROZEN')
          assert.equal(RecoveryCandidateRepository.listPending().some(item =>
            item.candidateId === 'old-candidate' && item.visibleText === '旧候选正文' && !item.sourceCurrent), true)
          assert.throws(() => RecoveryCandidateRepository.updatePending('old-candidate', '覆盖正文'), /PORTABLE_RUNTIME_FROZEN/)
          assert.throws(() => RecoveryCandidateRepository.resolve('old-candidate', 'discarded'), /PORTABLE_RUNTIME_FROZEN/)
          db.exec('SAVEPOINT mixed_candidates')
          try {
            const source = { chapterNumber: 8, title: '第八章', role: '推进', purpose: '继续',
              keyEvents: '新线索', characters: [], suspenseHook: '', userGuidance: '' }
            BlueprintRepository.upsert({ ...source, notes: '', notesUpdatedAt: '' })
            const fresh = RecoveryCandidateRepository.record({ runId: 'new-run', stepId: 'generate-draft',
              projectId: 'current-project', chapterNumber: 8, chapterTitle: source.title, source, sourceDraft: null,
              visibleText: '新候选正文', failureCode: 'NETWORK_ERROR', failureReason: 'test' })
            assert.deepEqual(RecoveryCandidateRepository.listPending().map(item => ({
              candidateId: item.candidateId, visibleText: item.visibleText, sourceCurrent: item.sourceCurrent,
            })), [
              { candidateId: 'old-candidate', visibleText: '旧候选正文', sourceCurrent: false },
              { candidateId: fresh.candidateId, visibleText: '新候选正文', sourceCurrent: true },
            ])
            assert.equal(RecoveryCandidateRepository.updatePending(fresh.candidateId, '可编辑正文').visibleText, '可编辑正文')
            db.prepare('UPDATE recovery_candidates SET source_hash=? WHERE candidate_id=?').run('bad', fresh.candidateId)
            assert.throws(() => RecoveryCandidateRepository.listPending(), /恢复候选完整性校验失败/)
          } finally { db.exec('ROLLBACK TO mixed_candidates; RELEASE mixed_candidates') }
          assert.equal(ImportRunRepository.get('old-import')?.id, 'old-import')
          assert.equal(ImportRunRepository.listResumable().some(item => item.id === 'old-import'), false)
          assert.throws(() => ImportRunRepository.startOrResume('old-import', 'new-owner'), /PORTABLE_RUNTIME_FROZEN/)
          assert.equal(publishCalls, 0)
          assert.equal(modelFetchCalls, 0)
          assert.deepEqual(rows(), before)
        } finally { closeProjectDatabase() }
      `,
    },
    outfile: entry, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22',
    plugins: [{ name: 'unused-electron-imports', setup(build) {
      build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'test-shim' }))
      build.onLoad({ filter: /.*/, namespace: 'test-shim' }, () => ({ contents:
        'export const app = { getPath() { throw Error("Electron-only path used") } }; export const nativeImage = {}', loader: 'js' }))
    } }],
  })
  const child = spawn(process.execPath, [entry], {
    cwd: process.cwd(), env: { ...process.env, LEGACY_FREEZE_ROOT: target }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', data => { stderr += String(data) })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  expect(code, stderr).toBe(0)
}

async function terminateImportAt(f: ReturnType<typeof fixture>, phase: 'sqlite-converted' | 'renamed') {
  const entry = path.join(path.dirname(f.source), 'import-child.mjs')
  await build({ entryPoints: [path.resolve('electron/services/legacy-project-copy-import.ts')], outfile: entry,
    bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22',
    plugins: [{ name: 'unused-electron-imports', setup(build) {
      build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'test-shim' }))
      build.onLoad({ filter: /.*/, namespace: 'test-shim' }, () => ({ contents:
        'export const app = { getPath() { throw Error("Electron-only path used") } }; export const nativeImage = {}', loader: 'js' }))
    } }],
  })
  const script = `
    import fs from 'node:fs'
    import { pathToFileURL } from 'node:url'
    const { entry, sourceRoot, targetRoot, phase } = JSON.parse(process.env.LEGACY_IMPORT_CHILD)
    const pause = () => { fs.writeSync(1, 'REACHED\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0) }
    if (phase === 'renamed') {
      const rename = fs.renameSync
      fs.renameSync = (from, to) => { rename(from, to); if (to === targetRoot) pause() }
    }
    const { importLegacyProjectCopy } = await import(pathToFileURL(entry).href)
    await importLegacyProjectCopy({ sourceRoot, targetRoot, preflightOptions: { maxNativePathCharacters: 4096 },
      checkpoint: current => { if (current === phase) pause() } })
    process.exitCode = 31
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), env: { ...process.env, LEGACY_IMPORT_CHILD: JSON.stringify({ entry, sourceRoot: f.source, targetRoot: f.target, phase }) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', data => { stderr += String(data) })
  const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve([code, signal]))
  })
  let stdout = ''
  const reached = new Promise<void>(resolve => child.stdout.on('data', data => {
    stdout += String(data)
    if (stdout.includes('REACHED\n')) resolve()
  }))
  let timer: ReturnType<typeof setTimeout> | undefined
  let observed = false
  try {
    await Promise.race([
      reached,
      exited.then(([code, signal]) => { throw new Error(`child exited before ${phase}: ${code}/${signal} ${stderr}`) }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`child timeout at ${phase}: ${stderr}`)), 30_000) }),
    ])
    expect(child.exitCode).toBeNull()
    observed = true
  } finally {
    if (timer) clearTimeout(timer)
    const killed = child.exitCode === null ? child.kill() : false
    const [, signal] = await exited
    if (observed) { expect(killed).toBe(true); expect(signal).toBe('SIGTERM') }
  }
}
afterEach(() => { closeProjectDatabase(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

it.each(['v100', 'v110'] as const)('%s 有旧角色原文但无角色卡时拒绝发布且保留源', async version => {
  const f = fixture(version), before = sourceState(f)
  expect(await importLegacyProjectCopy({ sourceRoot: f.source, targetRoot: f.target, preflightOptions }))
    .toMatchObject({ state: 'blocked', code: 'LEGACY_IMPORT_ROSTER_UNAVAILABLE' })
  expect(fs.existsSync(f.target)).toBe(false)
  expect(sourceState(f)).toEqual(before)
  const attempts = fs.readdirSync(path.dirname(f.target)).filter(name => name.startsWith('.new.legacy-import-'))
  expect(attempts).toHaveLength(1)
  const staging = path.join(path.dirname(f.target), attempts[0]!, 'target', '.ai-novel', 'project.db')
  const preserved = new Database(staging, { readonly: true, fileMustExist: true })
  try {
    expect(preserved.prepare("SELECT legacy_markdown FROM character_roster_meta WHERE id='main'").pluck().get())
      .toBe('作者明确角色群像，与正文推断不同')
  } finally { preserved.close() }
})

function addLegacyCards(f: ReturnType<typeof fixture>) {
  const source = new Database(path.join(f.legacy, 'vela.db'))
  try {
    source.prepare(`INSERT INTO characters(rowid,name,role,background,relationships,cs_location,cs_updated_at_chapter)
      VALUES (?,?,?,?,?,?,?)`).run(44, '乙', 'protagonist', '旧角色资料\r\n原文',
      JSON.stringify([{ target: '甲', relation: '同门' }]), '旧山门', 0)
    source.prepare('INSERT INTO characters(rowid,name,role,background) VALUES (?,?,?,?)')
      .run(45, '甲', 'supporting', '同门的作者设定')
  } finally { source.close() }
}

async function markLegacyCardsReady(f: ReturnType<typeof fixture>, officialV100 = false) {
  // Produce old ready hashes through the existing roster commit path.
  expect(await importLegacyProjectCopy({ sourceRoot: f.source, targetRoot: f.target, preflightOptions }))
    .toMatchObject({ state: 'ready' })
  const converted = new Database(path.join(f.target, '.ai-novel', 'project.db'), { readonly: true })
  let meta: { projection_hash: string; fact_hash: string; characters_arch: string }
  try {
    meta = converted.prepare(`SELECT m.projection_hash,m.fact_hash,c.characters_arch FROM character_roster_meta m
      JOIN project_core c ON c.id=m.id WHERE m.id='main'`).get() as typeof meta
  } finally { converted.close() }
  fs.rmSync(f.target, { recursive: true, force: true })
  const old = new Database(path.join(f.legacy, 'vela.db'))
  try {
    old.prepare("INSERT INTO character_roster_meta(id,schema_version,revision,migration_state,projection_hash,fact_hash) VALUES('main',1,1,'ready',?,?)")
      .run(meta.projection_hash, meta.fact_hash)
    old.prepare("UPDATE project_core SET characters_arch=? WHERE id='main'").run(meta.characters_arch)
    if (officialV100) expect(old.prepare("SELECT migration_state FROM character_roster_meta WHERE id='main'").pluck().get()).toBe('ready')
    else expect(CharacterRosterRepository.read(old).status).toBe('ready')
  } finally { old.close() }
  return meta
}

it('v1.1 ready 旧卡在离线副本内绑定唯一 PK 关系并保持作者投影', async () => {
  const f = fixture('v110', '')
  addLegacyCards(f)
  const oldMeta = await markLegacyCardsReady(f)
  const before = sourceState(f)
  const result = await importLegacyProjectCopy({ sourceRoot: f.source, targetRoot: f.target, preflightOptions })
  expect(result, JSON.stringify(result)).toMatchObject({ state: 'ready' })
  if (result.state !== 'ready') return
  const db = new Database(path.join(f.target, '.ai-novel', 'project.db'), { readonly: true })
  try {
    const roster = CharacterRosterRepository.read(db)
    expect(roster).toMatchObject({ migrationState: 'ready', status: 'ready' })
    const owner = roster.entries.find(entry => entry.name === '乙')!
    const target = roster.entries.find(entry => entry.name === '甲')!
    expect(owner.relationships).toEqual([{ target: '甲', targetCharacterId: target.characterId, relation: '同门' }])
    expect(db.prepare('SELECT source_character_id,target_character_id,relation,provenance_json FROM character_relationships').all())
      .toEqual([{ source_character_id: owner.characterId, target_character_id: target.characterId, relation: '同门',
        provenance_json: expect.any(String) }])
    const edge = db.prepare('SELECT provenance_json FROM character_relationships').pluck().get() as string
    expect(JSON.parse(edge)).toMatchObject({ kind: 'legacy', sourceKey: 'legacy:characters:0:relationships:0',
      sourceHash: createHash('sha256').update('[{"target":"甲","relation":"同门"}]').digest('hex') })
    expect(db.prepare('SELECT projection_hash,fact_hash FROM character_roster_meta WHERE id=?').get('main'))
      .toEqual({ projection_hash: oldMeta.projection_hash, fact_hash: oldMeta.fact_hash })
    expect(db.prepare('SELECT characters_arch FROM project_core WHERE id=?').pluck().get('main')).toBe(oldMeta.characters_arch)
    expect(db.prepare('SELECT resolved_character_id FROM character_identity_proposals').pluck().get()).toBe(target.characterId)
    expect(db.prepare('SELECT operation_id FROM character_identity_approvals').pluck().all())
      .toEqual(['legacy-offline-identity-binding'])
  } finally { db.close() }
  expect(sourceState(f)).toEqual(before)
})

it('官方 v1.0 ready 旧卡在只读验源后导入，源和旧副本的 DDL、行、已有 DB/WAL 数据不变', async () => {
  const f = fixture('v100-official', '')
  addLegacyCards(f)
  await markLegacyCardsReady(f, true)
  const before = sourceState(f)
  const copied: Array<unknown> = []
  const result = await importLegacyProjectCopy({ sourceRoot: f.source, targetRoot: f.target, preflightOptions,
    checkpoint(phase) {
      if (phase !== 'assets-converted' && phase !== 'verified') return
      const attempt = fs.readdirSync(path.dirname(f.target)).find(name => name.startsWith('.new.legacy-import-'))!
      const oldPath = path.join(path.dirname(f.target), attempt, 'source', '.vela', 'vela.db')
      const old = new Database(oldPath, { readonly: true, fileMustExist: true })
      try { copied.push({ database: hash(oldPath), wal: fs.existsSync(oldPath + '-wal') && fs.statSync(oldPath + '-wal').size
        ? hash(oldPath + '-wal') : null,
        schema: old.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),
        cards: old.prepare('SELECT rowid AS source_rowid,* FROM characters ORDER BY rowid').all(),
        meta: old.prepare('SELECT rowid AS source_rowid,* FROM character_roster_meta').all(),
      }) } finally { old.close() }
    },
  })
  expect(result, JSON.stringify(result)).toMatchObject({ state: 'ready' })
  expect(copied).toHaveLength(2)
  expect(copied[1]).toEqual(copied[0])
  expect(sourceState(f)).toEqual(before)
  if (result.state !== 'ready') return
  const db = new Database(path.join(f.target, '.ai-novel', 'project.db'), { readonly: true, fileMustExist: true })
  try { expect(CharacterRosterRepository.read(db)).toMatchObject({ migrationState: 'ready', status: 'ready' }) }
  finally { db.close() }
})

it('官方 v1.0 旧 ready 标签不能洗白已篡改的原始关系', async () => {
  const f = fixture('v100-official', '')
  addLegacyCards(f)
  await markLegacyCardsReady(f, true)
  const old = new Database(path.join(f.legacy, 'vela.db'))
  try { old.prepare("UPDATE characters SET relationships=? WHERE name='乙'").run('[{"target":"甲","relation":"改写后关系"}]') }
  finally { old.close() }
  const before = sourceState(f)
  expect(await importLegacyProjectCopy({ sourceRoot: f.source, targetRoot: f.target, preflightOptions }))
    .toEqual({ state: 'blocked', code: 'LEGACY_IMPORT_ROSTER_UNAVAILABLE' })
  expect(fs.existsSync(f.target)).toBe(false)
  expect(sourceState(f)).toEqual(before)
  const attempt = fs.readdirSync(path.dirname(f.target)).find(name => name.startsWith('.new.legacy-import-'))!
  expect(fs.readdirSync(path.join(path.dirname(f.target), attempt, 'source', '.vela'))
    .filter(name => name.startsWith('.roster-check-'))).toEqual([])
})

it.each(['missing', 'stale-source', 'ambiguous', 'missing-origin'] as const)('v1.1 ready 旧关系 %s endpoint 阻断发布且不写稳定边', async problem => {
  const f = fixture('v110', '')
  addLegacyCards(f)
  await markLegacyCardsReady(f)
  if (problem === 'missing' || problem === 'stale-source') {
    const old = new Database(path.join(f.legacy, 'vela.db'))
    try { old.prepare('UPDATE characters SET relationships=? WHERE name=?')
      .run(problem === 'missing' ? '[{"target":"不存在","relation":"同门"}]' : '[{"target":"甲","relation":"旧快照以外的新关系"}]', '乙') } finally { old.close() }
  }
  const before = sourceState(f)
  const result = await importLegacyProjectCopy({ sourceRoot: f.source, targetRoot: f.target, preflightOptions,
    checkpoint: problem === 'ambiguous' || problem === 'missing-origin' ? phase => {
      if (phase !== 'assets-converted') return
      const attempt = fs.readdirSync(path.dirname(f.target)).find(name => name.startsWith('.new.legacy-import-'))!
      const staging = new Database(path.join(path.dirname(f.target), attempt, 'target', '.ai-novel', 'project.db'))
      try {
        if (problem === 'ambiguous') {
          const ids = staging.prepare('SELECT character_id FROM characters ORDER BY name').pluck().all() as string[]
          staging.prepare('UPDATE character_identity_proposals SET candidate_ids_json=? WHERE owner_character_id IS NOT NULL')
            .run(JSON.stringify(ids))
        } else staging.prepare("DELETE FROM character_identity_origins WHERE source_key='legacy:characters:1'").run()
      } finally { staging.close() }
    } : undefined,
  })
  expect(result).toEqual({ state: 'blocked', code: problem === 'missing' || problem === 'stale-source'
    ? 'LEGACY_IMPORT_ROSTER_UNAVAILABLE'
    : problem === 'ambiguous' ? 'LEGACY_IMPORT_SQLITE_VERIFICATION_FAILED' : 'MIGRATION_VERIFICATION_FAILED' })
  expect(fs.existsSync(f.target)).toBe(false)
  expect(sourceState(f)).toEqual(before)
  if (problem !== 'missing' && problem !== 'stale-source') return
  const attempt = fs.readdirSync(path.dirname(f.target)).find(name => name.startsWith('.new.legacy-import-'))!
  const staging = new Database(path.join(path.dirname(f.target), attempt, 'target', '.ai-novel', 'project.db'), { readonly: true })
  try { expect(staging.prepare('SELECT COUNT(*) FROM character_relationships').pluck().get()).toBe(0) }
  finally { staging.close() }
})

it.each(['v100', 'v110'] as const)('%s 非空旧角色卡与关系确定性采用，生产保存重开不回写源', async version => {
  const f = fixture(version, '')
  addLegacyCards(f)
  const old = new Database(path.join(f.legacy, 'vela.db'))
  try { old.prepare('INSERT INTO blueprints(chapter_number,characters) VALUES(?,?)').run(7, '["乙","甲","章级待出场"]') }
  finally { old.close() }
  const before = sourceState(f)
  let preservedFacts: unknown[] = []
  const tables = ['characters', 'character_aliases', 'character_identity_origins']
  const result = await importLegacyProjectCopy({ sourceRoot: f.source, targetRoot: f.target, preflightOptions,
    checkpoint(phase) {
      if (phase !== 'assets-converted') return
      const attempt = fs.readdirSync(path.dirname(f.target)).find(name => name.startsWith('.new.legacy-import-'))!
      const staging = new Database(path.join(path.dirname(f.target), attempt, 'target', '.ai-novel', 'project.db'), { readonly: true })
      try { preservedFacts = tables.map(table => staging.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()) }
      finally { staging.close() }
    },
  })
  expect(result, JSON.stringify(result)).toMatchObject({ state: 'ready' })
  if (result.state !== 'ready') return
  initProjectDatabase(f.target)
  const db = getProjectDb()!
  expect(tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(preservedFacts)
  const roster = CharacterRosterRepository.read()
  expect(roster).toMatchObject({ status: 'ready', migrationState: 'ready', identityRevision: 0 })
  expect(roster.entries).toHaveLength(2)
  const protagonist = roster.entries.find(entry => entry.name === '乙')!
  const companion = roster.entries.find(entry => entry.name === '甲')!
  expect(protagonist.characterId).toBeTruthy()
  expect(companion.characterId).toBeTruthy()
  expect(protagonist).toMatchObject({ background: '旧角色资料\r\n原文',
    currentState: { location: '旧山门', updatedAtChapter: 0 },
    relationships: [{ target: '甲', targetCharacterId: companion.characterId, relation: '同门' }] })
  expect(db.prepare("SELECT legacy_markdown FROM character_roster_meta WHERE id='main'").pluck().get()).toBe('')
  expect(ProjectCoreRepository.get()!.charactersArch).toContain('甲（同门）')
  const relation = db.prepare('SELECT * FROM character_relationships').get() as { provenance_json: string; approval_id: string }
  expect(JSON.parse(relation.provenance_json)).toMatchObject({ kind: 'legacy', sourceKey: 'legacy:characters:0:relationships:0', migration: 'offline-project-copy' })
  expect(relation.approval_id).toBe('legacy-offline-identity-binding')
  expect(db.prepare('SELECT characters FROM blueprints WHERE chapter_number=7').pluck().get()).toBe('["乙","甲","章级待出场"]')
  expect(db.prepare('SELECT raw_value,resolved_character_id FROM character_identity_proposals WHERE owner_character_id IS NULL ORDER BY source_key').all())
    .toEqual([{ raw_value: '乙', resolved_character_id: protagonist.characterId },
      { raw_value: '甲', resolved_character_id: companion.characterId }, { raw_value: '章级待出场', resolved_character_id: null }])
  expect(db.prepare("SELECT COUNT(*) FROM character_identity_approvals WHERE operation_id LIKE 'legacy-cards-adoption:%'").pluck().get()).toBe(1)
  expect(db.prepare('SELECT COUNT(*) FROM llm_calls').pluck().get()).toBe(0)
  expect(db.prepare('SELECT COUNT(*) FROM generation_runs').pluck().get()).toBe(0)
  const fingerprint = 'a'.repeat(64)
  const writing = buildGenerationSourceBinding({ db, projectStorageRoot: path.join(f.target, '.ai-novel'),
    globalDataRoot: path.dirname(f.source), readBuiltinPrompt: () => JSON.stringify({ key: 'draft', content: '测试写作契约', systemRole: '测试' }) },
  { projectId: result.projectId, epoch: 'test-import-session', operation: 'chapter-draft', chapterNumber: 7,
    selectedDraftIds: [], selectedFinalizedDraftIds: [], promptKeys: ['draft'], skillStages: [],
    modelReceipt: { modelId: 'fixture', provider: 'openai', protocol: 'openai', modelName: 'fixture',
      modelRevision: fingerprint, endpointFingerprint: fingerprint, capabilityEvidence: {
        source: { contextWindowTokens: 'unknown', maxOutputTokens: 'user-operational-cap', featureFlags: 'unknown' },
        subjectFingerprint: fingerprint, contextWindowTokens: 8000, maxOutputTokens: 1000, reasoning: false, structuredOutput: false, usage: true } },
    policy: { version: 'fixture', maxPhysicalRequests: 1 }, outputContract: 'visible-text' })
  expect(JSON.parse(writing.materials.find(item => item.ref.sourceId === 'character-relationships:all')!.text))
    .toMatchObject([{ source_character_id: protagonist.characterId, target_character_id: companion.characterId, relation: '同门' }])
  const saved = commitAuthorCharacterRoster(db, { operationId: 'imported-author-edit', schemaVersion: 1,
    intent: 'manual_edit', expectedRevision: roster.revision, expectedIdentityRevision: roster.identityRevision,
    entries: roster.entries.map(entry => entry.characterId === protagonist.characterId ? { ...entry, notes: '新版保存笔记' } : entry),
  }, { projectId: result.projectId, epoch: 'test-import-session' }, () => {})
  closeProjectDatabase()
  initProjectDatabase(f.target)
  expect(CharacterRosterRepository.read()).toEqual(saved.snapshot)
  expect(CharacterRosterRepository.read().entries.find(entry => entry.characterId === protagonist.characterId)?.notes).toBe('新版保存笔记')
  expect(getProjectDb()!.prepare("SELECT COUNT(*) FROM character_identity_approvals WHERE operation_id LIKE 'legacy-cards-adoption:%'").pluck().get()).toBe(1)
  expect(sourceState(f)).toEqual(before)
})

it.each([
  '与甲是同门', '[{"target":" 甲","relation":"同门"}]', '[{"target":"不存在","relation":"同门"}]',
  '[{"target":"乙","relation":"自指"}]', '[{"target":"甲","relation":""}]',
  '[{"target":"甲","relation":"同门","confidence":1}]',
  '[{"target":"甲","relation":"同门"},{"target":"甲","relation":"友人"}]',
  '{"target":"甲","relation":"同门"}',
])('旧卡关系不满足完整主键边契约时阻断且保全：%s', async relationships => {
  const f = fixture('v110', '')
  addLegacyCards(f)
  const old = new Database(path.join(f.legacy, 'vela.db'))
  try { old.prepare('UPDATE characters SET relationships=? WHERE name=?').run(relationships, '乙') }
  finally { old.close() }
  const before = sourceState(f)
  expect(await importLegacyProjectCopy({ sourceRoot: f.source, targetRoot: f.target, preflightOptions }))
    .toEqual({ state: 'blocked', code: 'LEGACY_IMPORT_ROSTER_UNAVAILABLE' })
  expect(sourceState(f)).toEqual(before)
  expect(fs.existsSync(f.target)).toBe(false)
  const attempt = fs.readdirSync(path.dirname(f.target)).find(name => name.startsWith('.new.legacy-import-'))!
  const staging = new Database(path.join(path.dirname(f.target), attempt, 'target', '.ai-novel', 'project.db'), { readonly: true })
  try {
    expect(staging.prepare('SELECT relationships FROM characters WHERE name=?').pluck().get('乙')).toBe(relationships)
    expect(staging.prepare('SELECT COUNT(*) FROM character_relationships').pluck().get()).toBe(0)
    expect(staging.prepare('SELECT COUNT(*) FROM character_identity_approvals').pluck().get()).toBe(0)
    expect(CharacterRosterRepository.read(staging).migrationState).toBe('legacy_cards_preserved')
  } finally { staging.close() }
})

it.each(['v100', 'v110'] as const)('%s 非空旧原文与卡片无法证明无损时仍拒绝发布并保留 staging', async version => {
  const f = fixture(version)
  addLegacyCards(f)
  const before = sourceState(f)
  expect(await importLegacyProjectCopy({ sourceRoot: f.source, targetRoot: f.target, preflightOptions }))
    .toMatchObject({ state: 'blocked', code: 'LEGACY_IMPORT_ROSTER_UNAVAILABLE' })
  expect(fs.existsSync(f.target)).toBe(false)
  expect(sourceState(f)).toEqual(before)
  const attempt = fs.readdirSync(path.dirname(f.target)).find(name => name.startsWith('.new.legacy-import-'))!
  const staging = new Database(path.join(path.dirname(f.target), attempt, 'target', '.ai-novel', 'project.db'), { readonly: true })
  try {
    expect(CharacterRosterRepository.read(staging)).toMatchObject({ migrationState: 'legacy_cards_preserved', status: 'inconsistent',
      legacyMarkdown: '作者明确角色群像，与正文推断不同' })
    expect(staging.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(2)
    expect(staging.prepare('SELECT relationships FROM characters WHERE name=?').pluck().get('乙'))
      .toBe('[{"target":"甲","relation":"同门"}]')
    expect(staging.prepare('SELECT raw_value,resolved_character_id FROM character_identity_proposals').all())
      .toEqual([{ raw_value: '{"target":"甲","relation":"同门"}', resolved_character_id: null }])
    expect(staging.prepare('SELECT COUNT(*) FROM character_identity_approvals').pluck().get()).toBe(0)
  } finally { staging.close() }
})

it.each(['v100', 'v110'] as const)('%s 合法空角色名单的离线完整副本含 WAL、作者配置和正文', async version => {
  const f = fixture(version, '')
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
    expect(db.prepare('SELECT characters_arch FROM project_core WHERE id=?').pluck().get('main')).toBe('')
    expect(db.prepare("SELECT migration_state FROM character_roster_meta WHERE id='main'").pluck().get()).toBe('empty')
    expect(db.prepare('SELECT body FROM contents WHERE id=11').pluck().get()).toBe('合成章节正文\r\n原字节')
    expect(db.prepare('SELECT content_id FROM drafts WHERE id=19').pluck().get()).toBe(11)
  } finally { db.close() }
  expect(Object.fromEntries(Object.keys(f.sourceHashes).map(name => [name, hash(path.join(f.legacy, name))]))).toEqual(f.sourceHashes)
  expect(await importLegacyProjectCopy({ sourceRoot: f.source, targetRoot: f.target, preflightOptions })).toMatchObject({ state: 'blocked', code: 'LEGACY_IMPORT_TARGET_EXISTS' })
})

it('旧项目根内的真实知识原文变成可读项目副本，片段不能冒充全文', async () => {
  const f = fixture('v110', '')
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

  const interrupted = fixture('v100', '')
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
    const f = fixture('v110', '')
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

it.each(['sqlite-converted', 'renamed'] as const)('%s 子进程终止后源保留且目标可安全恢复', async phase => {
  const f = fixture('v110', ''), before = sourceState(f)
  await terminateImportAt(f, phase)
  expect(sourceState(f)).toEqual(before)
  const attempts = fs.readdirSync(path.dirname(f.target)).filter(name => name.startsWith('.new.legacy-import-'))
  expect(attempts).toHaveLength(1)
  const owner = JSON.parse(fs.readFileSync(path.join(path.dirname(f.target), attempts[0]!, '.vibe-owner.json'), 'utf8'))
  expect(owner).toMatchObject({ owner: 'AI Novel A11 offline import', sourceProject: f.source, ttlHours: 24 })
  expect(owner.cleanupCommand).toContain(attempts[0])
  if (phase === 'sqlite-converted') {
    expect(fs.existsSync(f.target)).toBe(false)
    expect(await importLegacyProjectCopy({ sourceRoot: f.source, targetRoot: f.target, preflightOptions }))
      .toMatchObject({ state: 'ready', targetRoot: f.target })
  } else {
    expect(verifyProjectSqlite({ databasePath: path.join(f.target, '.ai-novel', 'project.db') }).schemaVersion).toBe(7)
    const access = new ProjectAccessService(preflightOptions)
    const trusted = access.adoptLegacyProject(access.probeExistingProject(f.target))
    expect(trusted.projectId).not.toBe(f.sourceProjectId)
    initProjectDatabase(trusted.rootPath)
    expect(ProjectCoreRepository.get()?.projectName).toBe('合成旧项目')
    closeProjectDatabase()
    expect(await importLegacyProjectCopy({ sourceRoot: f.source, targetRoot: f.target, preflightOptions }))
      .toMatchObject({ state: 'blocked', code: 'LEGACY_IMPORT_TARGET_EXISTS' })
  }
  const targetDb = new Database(path.join(f.target, '.ai-novel', 'project.db'), { readonly: true })
  try {
    expect(targetDb.prepare('SELECT body FROM contents WHERE id=11').pluck().get()).toBe('合成章节正文\r\n原字节')
  } finally { targetDb.close() }
  expect(hash(path.join(f.target, 'outline.md'))).toBe(hash(path.join(f.source, 'outline.md')))
  for (const file of ['prompts/author.txt', 'skills/author.md'])
    expect(hash(path.join(f.target, '.ai-novel', file))).toBe(hash(path.join(f.legacy, file)))
  expect(sourceState(f)).toEqual(before)
})

it('旧候选正文保留为可读冻结历史，新项目不重放', async () => {
  const f = fixture('v110', ''), db = new Database(path.join(f.legacy, 'vela.db'))
  const candidateSource = JSON.stringify({ chapterNumber: 7, title: '第七章', role: '推进', purpose: '追踪', keyEvents: '线索', characters: [] })
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
        candidateSource, createHash('sha256').update(candidateSource).digest('hex'),
        '旧候选正文', createHash('sha256').update('旧候选正文').digest('hex'))
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
    expect(copy.prepare('SELECT source_hash FROM recovery_candidates WHERE candidate_id=?').pluck().get('old-candidate')).toBe('')
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
  closeProjectDatabase()
  await verifyFrozenLegacyConsumersAfterRestart(f.target, path.join(path.dirname(f.source), 'legacy-freeze-child.mjs'))
  expect(Object.fromEntries(Object.keys(before).map(name => [name, hash(path.join(f.legacy, name))]))).toEqual(before)
  expect(fs.existsSync(path.join(f.legacy, 'vela.db'))).toBe(true)
})

it.each(['v100', 'v110'] as const)('%s 无 manifest 的旧历史启用新 lineage，旧删除操作不能重放', async version => {
  const f = fixture(version, '')
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
  const frozenRefusal = { success: false, committed: false, error: expect.stringContaining('仅保留为历史') }
  const calls: string[] = []
  const service = new ChapterDeletionService({ cleaner: {
    async removeManuscript() { calls.push('manuscript') },
    async removeKnowledgeDocument() { calls.push('knowledge') },
  } })
  expect(await service.retry(f.target, 'old-deletion')).toEqual(frozenRefusal)
  expect(await service.confirmLegacyKnowledgeAbsent(f.target, 'old-deletion')).toEqual(frozenRefusal)
  expect(await service.delete(f.target, { draftId: 19, chapterNumber: 7 })).toEqual(frozenRefusal)
  expect(calls).toEqual([])
  expect(targetDb.prepare('SELECT status,attempt_count FROM chapter_deletion_operations WHERE operation_id=?')
    .get('old-deletion')).toMatchObject({ status: 'pending', attempt_count: 0 })
  expect(hash(path.join(f.legacy, 'vela.db'))).toBe(sourceDatabaseHash)
})

it.each(['v100', 'v110'] as const)('%s 旧版无收据定稿正文保留为 legacy，仅转移有证明的定稿', async version => {
  const f = fixture(version, '')
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
  const f = fixture('v110', '')
  fs.mkdirSync(path.join(f.legacy, 'avatars'))
  fs.writeFileSync(path.join(f.legacy, 'avatars', 'unmapped.png'), Buffer.from('89504e470d0a1a0a00000000', 'hex'))
  expect(await importLegacyProjectCopy({ sourceRoot: f.source, targetRoot: f.target, preflightOptions }))
    .toMatchObject({ state: 'ready' })
  const unresolved = path.join(f.target, '.ai-novel', 'avatars', 'unresolved')
  expect(fs.readFileSync(path.join(unresolved, fs.readdirSync(unresolved)[0]!))).toEqual(fs.readFileSync(path.join(f.legacy, 'avatars', 'unmapped.png')))
  expect(fs.existsSync(path.join(f.legacy, 'avatars', 'unmapped.png'))).toBe(true)
})
