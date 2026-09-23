import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { migrateSchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { ProjectPeekService } from '../project-peek'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
type DatabaseHandle = import('better-sqlite3').Database

const roots: string[] = []
const handles: DatabaseHandle[] = []
afterEach(() => {
  for (const database of handles.splice(0)) database.close()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function manifest(projectId: string) {
  return {
    schemaVersion: 1,
    kind: 'ai-novel-project',
    projectId,
    createdAt: '2026-09-21T00:00:00.000Z',
    storageFormat: 'ai-novel',
    storageVersion: 1,
  }
}

function fixture(options: { schemaVersion?: number; journalMode?: 'delete' | 'wal' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-project-peek-'))
  roots.push(root)
  const storage = path.join(root, '.ai-novel')
  const scratch = path.join(root, 'peek-scratch')
  fs.mkdirSync(storage)
  const projectId = randomUUID()
  fs.writeFileSync(path.join(storage, 'project.json'), JSON.stringify(manifest(projectId)))
  const databasePath = path.join(storage, 'project.db')
  const database = new Database(databasePath)
  handles.push(database)
  database.pragma('foreign_keys = ON')
  initializeLegacyBaselineSchema(database)
  migrateSchema(new SqliteSchemaAdapter(database), getDesktopMigrationRegistry(), options.schemaVersion ?? 7)
  if ((options.schemaVersion ?? 7) === 7) seedCore(database)
  if (options.journalMode === 'wal') database.pragma('journal_mode = WAL')
  return { root, storage, scratch, projectId, databasePath, database }
}

function seedCore(database: DatabaseHandle, totalChapters = 3) {
  database.prepare(`
    INSERT INTO project_core (
      id, project_name, genre, sub_genre, target_audience, total_chapters,
      words_per_chapter, writing_language, plot_structure, narrative_pov,
      core_outline, world_setting, golden_finger, protagonist_profile,
      global_guidance, writing_style, premise, worldbuilding, characters_arch, synopsis
    ) VALUES (
      'main', '雨夜来信', '悬疑', '都市', '成年读者', ?,
      3000, 'zh-CN', 'three_act', 'third_limited',
      '核心大纲', '世界设定', '无', '主角档案',
      '保持克制', '冷峻现实主义', '', '', '', ''
    )
  `).run(totalChapters)
}

function addChapter(database: DatabaseHandle, chapterNumber: number, options: {
  blueprint?: boolean; draft?: boolean; review?: boolean; finalized?: boolean
} = {}) {
  if (options.blueprint) database.prepare('INSERT INTO blueprints (chapter_number,title) VALUES (?,?)')
    .run(chapterNumber, `第${chapterNumber}章`)
  if (!options.draft && !options.review && !options.finalized) return
  const body = `第${chapterNumber}章正文：雨落在旧车站。`
  const content = database.prepare('INSERT INTO contents (body) VALUES (?)').run(body)
  const draft = database.prepare(`
    INSERT INTO drafts (chapter_number,version,status,source,content_id,word_count)
    VALUES (?,1,?,'write',?,?)
  `).run(chapterNumber, options.finalized ? 'finalized' : 'draft', content.lastInsertRowid, 12)
  if (options.review) {
    const report = database.prepare('INSERT INTO contents (body) VALUES (?)').run('审稿意见')
    database.prepare(`
      INSERT INTO reviews (base_draft_id,review_index,source_draft_chapter_number,source_draft_version,source_draft_status,source_content,content_id)
      VALUES (?,1,?,1,?,?,?)
    `).run(draft.lastInsertRowid, chapterNumber, options.finalized ? 'finalized' : 'draft', body, report.lastInsertRowid)
  }
  if (options.finalized) {
    database.prepare(`
      INSERT INTO finalization_outbox (
        finalization_id,draft_id,chapter_number,chapter_title,content_hash,
        content_revision,content_snapshot,target_file_name,publication_status
      ) VALUES (?,?,?,?,?,?,?,?,'pending')
    `).run(
      `final-${chapterNumber}`,
      draft.lastInsertRowid,
      chapterNumber,
      `第${chapterNumber}章`,
      createHash('sha256').update(body).digest('hex'),
      1,
      body,
      `chapter-${chapterNumber}.txt`,
    )
  }
}

function sourceState(databasePath: string) {
  return Object.fromEntries(['', '-wal', '-shm'].filter(suffix => fs.existsSync(databasePath + suffix)).map(suffix => {
    const file = databasePath + suffix
    const stat = fs.statSync(file)
    return [suffix, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      hash: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    }]
  }))
}

function ready<T extends { state: string }>(overview: T): asserts overview is T & { state: 'ready' } {
  expect(overview.state).toBe('ready')
}

describe('ProjectPeekService source-zero-write overview', () => {
  it('accepts only a live opaque capability and invalidates it on revoke or manifest drift', () => {
    const f = fixture()
    const service = new ProjectPeekService({ scratchRoot: f.scratch })
    const capability = service.issueCapability(f.root)
    expect(capability).toEqual({ capabilityId: expect.any(String), projectId: f.projectId })
    expect(service.peek(`${capability!.capabilityId}-tampered`)).toEqual({ state: 'unavailable' })

    ready(service.peek(capability!.capabilityId))
    service.revokeCapability(capability!.capabilityId)
    expect(service.peek(capability!.capabilityId)).toEqual({ state: 'unavailable' })

    const replacement = service.issueCapability(f.root)!
    fs.writeFileSync(path.join(f.storage, 'project.json'), JSON.stringify(manifest(randomUUID())))
    expect(service.peek(replacement.capabilityId)).toEqual({ state: 'unavailable' })
  })

  it('never changes source DB/WAL/SHM, creates no source sidecar, and cleans its exact attempt', () => {
    const f = fixture({ journalMode: 'wal' })
    addChapter(f.database, 1, { blueprint: true, draft: true, review: true, finalized: true })
    const userVersion = f.database.pragma('user_version', { simple: true })
    const outbox = f.database.prepare('SELECT COUNT(*) AS count FROM finalization_outbox').get()
    const before = sourceState(f.databasePath)
    expect(Object.keys(before)).toEqual(['', '-wal', '-shm'])
    const service = new ProjectPeekService({ scratchRoot: f.scratch })
    const overview = service.peek(service.issueCapability(f.root)!.capabilityId)

    ready(overview)
    expect(sourceState(f.databasePath)).toEqual(before)
    expect(f.database.pragma('user_version', { simple: true })).toBe(userVersion)
    expect(f.database.prepare('SELECT COUNT(*) AS count FROM finalization_outbox').get()).toEqual(outbox)
    expect(fs.readdirSync(f.storage).sort()).toEqual(['project.db', 'project.db-shm', 'project.db-wal', 'project.json'])
    expect(fs.readdirSync(f.scratch)).toEqual([])
  })

  it('creates no WAL/SHM beside a source database that had none', () => {
    const f = fixture()
    const before = sourceState(f.databasePath)
    expect(Object.keys(before)).toEqual([''])
    const service = new ProjectPeekService({ scratchRoot: f.scratch })
    ready(service.peek(service.issueCapability(f.root)!.capabilityId))
    expect(sourceState(f.databasePath)).toEqual(before)
    expect(fs.existsSync(`${f.databasePath}-wal`)).toBe(false)
    expect(fs.existsSync(`${f.databasePath}-shm`)).toBe(false)
  })

  it('refuses legacy roots plus old, future, and forked desktop schemas', { timeout: 20_000 }, () => {
    const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-project-peek-legacy-'))
    roots.push(legacyRoot)
    fs.mkdirSync(path.join(legacyRoot, '.vela'))
    const service = new ProjectPeekService({ scratchRoot: path.join(legacyRoot, 'scratch') })
    expect(service.issueCapability(legacyRoot)).toBeNull()

    const old = fixture({ schemaVersion: 5 })
    const future = fixture()
    future.database.pragma('user_version = 8')
    const fork = fixture()
    fork.database.exec('CREATE TABLE unrecognized_fork (id INTEGER PRIMARY KEY)')
    for (const candidate of [old, future, fork]) {
      const candidateService = new ProjectPeekService({ scratchRoot: candidate.scratch })
      const capability = candidateService.issueCapability(candidate.root)!
      expect(candidateService.peek(capability.capabilityId)).toEqual({ state: 'unavailable' })
    }
  })

  it('reports conservative counts and never marks one chapter as a completed multi-chapter plan', () => {
    const f = fixture()
    f.database.prepare("UPDATE project_core SET premise='前提', worldbuilding='世界观'").run()
    f.database.prepare("INSERT INTO characters (character_id,name,retired) VALUES ('c1','林舟',0),('c2','已退场',1)").run()
    addChapter(f.database, 1, { blueprint: true, draft: true, review: true, finalized: true })
    const service = new ProjectPeekService({ scratchRoot: f.scratch })
    const overview = service.peek(service.issueCapability(f.root)!.capabilityId)

    ready(overview)
    expect(overview).toMatchObject({
      projectId: f.projectId,
      revision: expect.any(String),
      name: '雨夜来信',
      totalWords: 12,
      characters: 1,
      finalizedChapters: 1,
    })
    expect(overview).not.toHaveProperty('path')
    expect(overview).not.toHaveProperty('excerpt')
    expect(JSON.stringify(overview)).not.toContain(f.root)
    expect(overview.stages).toEqual([
      { id: 'configuration', status: 'completed', count: 9 },
      { id: 'architecture', status: 'in-progress', count: 2 },
      { id: 'blueprint', status: 'in-progress', count: 1 },
      { id: 'drafting', status: 'in-progress', count: 1 },
      { id: 'review', status: 'in-progress', count: 1 },
      { id: 'finalization', status: 'in-progress', count: 1 },
    ])
  })

  it('does not count a finalized status whose frozen outbox fact is inconsistent', () => {
    const f = fixture()
    f.database.prepare('UPDATE project_core SET total_chapters=1').run()
    addChapter(f.database, 1, { draft: true, finalized: true })
    f.database.prepare("UPDATE finalization_outbox SET content_hash='not-the-content-hash'").run()
    const service = new ProjectPeekService({ scratchRoot: f.scratch })
    const overview = service.peek(service.issueCapability(f.root)!.capabilityId)

    ready(overview)
    expect(overview.finalizedChapters).toBe(0)
    expect(overview.stages[5]).toEqual({ id: 'finalization', status: 'not-started', count: 0 })
  })

  it('uses unknown for an unknown plan, in-progress once data exists, and only completes full planned coverage', () => {
    const unknown = fixture()
    unknown.database.prepare('UPDATE project_core SET total_chapters=0').run()
    const unknownService = new ProjectPeekService({ scratchRoot: unknown.scratch })
    const empty = unknownService.peek(unknownService.issueCapability(unknown.root)!.capabilityId)
    ready(empty)
    expect(empty.stages.slice(2).map(stage => stage.status)).toEqual(['unknown', 'unknown', 'unknown', 'unknown'])
    unknown.database.prepare("INSERT INTO blueprints (chapter_number,title) VALUES (7,'片段')").run()
    const withData = unknownService.peek(unknownService.issueCapability(unknown.root)!.capabilityId)
    ready(withData)
    expect(withData.stages[2]).toEqual({ id: 'blueprint', status: 'in-progress', count: 1 })

    const complete = fixture()
    complete.database.prepare('UPDATE project_core SET total_chapters=2').run()
    addChapter(complete.database, 1, { blueprint: true, draft: true, review: true, finalized: true })
    addChapter(complete.database, 2, { blueprint: true, draft: true, review: true, finalized: true })
    const completeService = new ProjectPeekService({ scratchRoot: complete.scratch })
    const overview = completeService.peek(completeService.issueCapability(complete.root)!.capabilityId)
    ready(overview)
    expect(overview.stages.slice(2).map(stage => stage.status)).toEqual(['completed', 'completed', 'completed', 'completed'])
  })

  it('does not count a finalized draft without an authoritative outbox receipt', () => {
    const f = fixture()
    const content = f.database.prepare('INSERT INTO contents (body) VALUES (?)').run('缺少定稿回执的正文')
    f.database.prepare(`
      INSERT INTO drafts (chapter_number,version,status,source,content_id,word_count)
      VALUES (1,1,'finalized','write',?,10)
    `).run(content.lastInsertRowid)
    const service = new ProjectPeekService({ scratchRoot: f.scratch })

    const external = service.peek(service.issueCapability(f.root)!.capabilityId)
    const current = service.readCurrent(f.projectId, f.database)
    ready(external)
    ready(current)
    expect(external.finalizedChapters).toBe(0)
    expect(current.finalizedChapters).toBe(0)
    expect(external.stages[5]).toEqual({ id: 'finalization', status: 'not-started', count: 0 })
  })

  it('allows an excerpt only for the already-open current database and performs SELECT-only aggregation', () => {
    const f = fixture()
    addChapter(f.database, 1, { draft: true })
    const beforeChanges = f.database.prepare('SELECT total_changes()').pluck().get()
    const service = new ProjectPeekService({ scratchRoot: f.scratch })
    const current = service.readCurrent(f.projectId, f.database)
    const external = service.peek(service.issueCapability(f.root)!.capabilityId)

    ready(current)
    ready(external)
    expect(current.excerpt).toContain('雨落在旧车站')
    expect(external).not.toHaveProperty('excerpt')
    expect(f.database.prepare('SELECT total_changes()').pluck().get()).toBe(beforeChanges)
  })
})
