import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'

import { getCurrentProjectPath, getProjectDb } from '../../database'
import { BlueprintRepository } from '../blueprint-repository'
import { CharacterRosterRepository } from '../character-roster-repository'
import { DraftRepository } from '../draft-repository'
import { ProjectClearRepository } from '../project-clear-repository'
import { ProjectCoreRepository } from '../project-core-repository'
import type { CharacterRosterCommitRequest } from '../../../src/shared/character-roster'

vi.mock('../../database', () => ({
  getCurrentProjectPath: vi.fn(),
  getProjectDb: vi.fn(),
}))

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')

function createMockDb() {
  const run = vi.fn()
  const all = vi.fn(() => [{ name: 'fact_hash' }])
  const get = vi.fn(() => ({ present: true }))
  const prepare = vi.fn((sql: string) => ({ sql, run, all, get }))
  const transaction = vi.fn((fn: () => void) => () => fn())
  const exec = vi.fn()
  return { prepare, transaction, run, exec }
}

function rosterCommitRequest(operationId: string, expectedRevision: number): CharacterRosterCommitRequest {
  return {
    operationId,
    expectedRevision,
    schemaVersion: 1,
    entries: [{
      name: '清除前角色',
      role: 'protagonist',
      gender: '女',
      age: '二十五岁',
      appearance: '黑色风衣',
      personality: '冷静',
      background: '旧城区调查员',
      abilities: '线索分析',
      motivation: '找回失踪同伴',
      relationships: [],
      arc: '学会信任同伴',
      notes: '应随故事架构一起清除',
    }],
  }
}

function createRealProjectDb(): BetterSqlite3.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE project_core (
      id TEXT PRIMARY KEY,
      writing_style TEXT DEFAULT '',
      reference_works TEXT DEFAULT '',
      global_guidance TEXT DEFAULT '',
      golden_finger TEXT DEFAULT '',
      premise TEXT DEFAULT '',
      worldbuilding TEXT DEFAULT '',
      characters_arch TEXT DEFAULT '',
      synopsis TEXT DEFAULT '',
      character_states TEXT DEFAULT '',
      plot_tree_snapshot TEXT NOT NULL DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now'))
    );
    INSERT INTO project_core (id, writing_style, premise, characters_arch)
    VALUES ('main', '旧文风', '旧故事前提', '');
    CREATE TABLE characters (
      name TEXT PRIMARY KEY,
      role TEXT DEFAULT 'supporting',
      gender TEXT DEFAULT '',
      age TEXT DEFAULT '',
      appearance TEXT DEFAULT '',
      personality TEXT DEFAULT '',
      background TEXT DEFAULT '',
      abilities TEXT DEFAULT '',
      motivation TEXT DEFAULT '',
      relationships TEXT DEFAULT '',
      arc TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      cs_location TEXT DEFAULT '',
      cs_power_level TEXT DEFAULT '',
      cs_physical_state TEXT DEFAULT '',
      cs_mental_state TEXT DEFAULT '',
      cs_key_items TEXT DEFAULT '',
      cs_recent_events TEXT DEFAULT '',
      cs_updated_at_chapter INTEGER DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `)
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('project clear repositories', () => {
  it('clears all blueprints in one call', () => {
    const db = createMockDb()
    vi.mocked(getProjectDb).mockReturnValue(db as never)

    BlueprintRepository.clearAll()

    expect(db.prepare).toHaveBeenCalledWith('DELETE FROM blueprint_character_sync_operations')
    expect(db.prepare).toHaveBeenCalledWith('DELETE FROM blueprint_commit_operations')
    expect(db.prepare).toHaveBeenCalledWith('DELETE FROM blueprints')
    expect(db.run).toHaveBeenCalledTimes(3)
  })

  it('clears generated drafts, review artifacts, summaries, and content in dependency order', () => {
    const db = createMockDb()
    vi.mocked(getProjectDb).mockReturnValue(db as never)

    DraftRepository.clearAll()

    const statements = db.prepare.mock.calls.map(([sql]) => sql)
    expect(statements).toEqual([
      'DELETE FROM finalized_draft_import_operations',
      'DELETE FROM post_process_steps',
      'DELETE FROM post_process_runs',
      'DELETE FROM reviews',
      'DELETE FROM revisions',
      'DELETE FROM drafts',
      'DELETE FROM contents',
      'DELETE FROM summary_snapshots',
    ])
    expect(db.run).toHaveBeenCalledTimes(8)
  })

  it('resets generated architecture fields without clearing project identity or sizing fields', () => {
    const db = createMockDb()
    vi.mocked(getProjectDb).mockReturnValue(db as never)

    ProjectCoreRepository.resetCreativeFields()

    const sql = db.prepare.mock.calls[0]?.[0]
    expect(sql).toContain('writing_style =')
    expect(sql).toContain('synopsis =')
    expect(sql).toContain('character_states =')
    expect(sql).not.toContain('project_name')
    expect(sql).not.toContain('genre')
    expect(sql).not.toContain('target_audience')
    expect(sql).not.toContain('total_chapters')
    expect(sql).not.toContain('words_per_chapter')
    expect(db.run).toHaveBeenCalledOnce()
  })

  it('clears selected generated project data in one database transaction', () => {
    const db = createMockDb()
    vi.mocked(getProjectDb).mockReturnValue(db as never)
    vi.mocked(getCurrentProjectPath).mockReturnValue(null)

    const result = ProjectClearRepository.clearGeneratedData({
      creativeFields: true,
      blueprints: true,
      generatedText: false,
    })

    expect(db.transaction).toHaveBeenCalledOnce()
    const statements = db.prepare.mock.calls.map(([sql]) => sql)
    expect(statements).toEqual(expect.arrayContaining([
      'DELETE FROM blueprint_character_sync_operations',
      'DELETE FROM blueprint_commit_operations',
      'DELETE FROM blueprints',
      'DELETE FROM character_roster_operations',
      'DELETE FROM character_roster_meta',
      'DELETE FROM characters',
      expect.stringContaining('UPDATE project_core') as unknown as string,
    ]))
    expect(statements).not.toContain("UPDATE project_core SET plot_tree_snapshot = '' WHERE id = 'main'")
    expect(result.cleared).toEqual(['blueprints', 'creativeFields'])
  })

  it('clears creative roster facts while preserving the previous plot tree as a stale snapshot', () => {
    const db = createRealProjectDb()
    vi.mocked(getProjectDb).mockReturnValue(db as never)
    vi.mocked(getCurrentProjectPath).mockReturnValue(null)

    try {
      const previousPlotTree = JSON.stringify({ schemaVersion: 1, sourceRevision: 'before-clear' })
      db.prepare("UPDATE project_core SET plot_tree_snapshot = ? WHERE id = 'main'").run(previousPlotTree)
      const beforeClear = CharacterRosterRepository.commit(rosterCommitRequest('roster-before-clear', 0))
      expect(beforeClear.snapshot).toMatchObject({ status: 'ready', entries: [expect.objectContaining({ name: '清除前角色' })] })
      expect(db.prepare('SELECT COUNT(*) AS count FROM character_roster_operations').get()).toEqual({ count: 1 })

      expect(ProjectClearRepository.clearGeneratedData({ creativeFields: true })).toMatchObject({
        cleared: ['creativeFields'],
      })

      expect(db.prepare('SELECT characters_arch FROM project_core WHERE id = ?').get('main')).toEqual({ characters_arch: '' })
      expect(db.prepare('SELECT plot_tree_snapshot FROM project_core WHERE id = ?').get('main'))
        .toEqual({ plot_tree_snapshot: previousPlotTree })
      expect(db.prepare('SELECT COUNT(*) AS count FROM characters').get()).toEqual({ count: 0 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM character_roster_meta').get()).toEqual({ count: 0 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM character_roster_operations').get()).toEqual({ count: 0 })
      expect(CharacterRosterRepository.read()).toMatchObject({
        revision: 0,
        migrationState: 'empty',
        status: 'empty',
        entries: [],
        renderedMarkdown: '',
      })

      const regenerated = CharacterRosterRepository.commit(rosterCommitRequest('roster-after-clear', 0))
      expect(regenerated).toMatchObject({
        idempotent: false,
        revision: 1,
        snapshot: { status: 'ready', entries: [expect.objectContaining({ name: '清除前角色' })] },
      })
    } finally {
      db.close()
    }
  })

  it('removes generated root chapter txt files when generated text is cleared', () => {
    const db = createMockDb()
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-clear-'))
    fs.mkdirSync(path.join(projectPath, '.vela'), { recursive: true })
    const generatedFile = path.join(projectPath, '第1章 夜航.txt')
    const generatedFileWithoutTitle = path.join(projectPath, '第2章.txt')
    const userFile = path.join(projectPath, '参考小说.txt')
    fs.writeFileSync(generatedFile, 'chapter one')
    fs.writeFileSync(generatedFileWithoutTitle, 'chapter two')
    fs.writeFileSync(userFile, 'reference')
    vi.mocked(getProjectDb).mockReturnValue(db as never)
    vi.mocked(getCurrentProjectPath).mockReturnValue(projectPath)

    try {
      const result = ProjectClearRepository.clearGeneratedData({ generatedText: true })

      expect(fs.existsSync(generatedFile)).toBe(false)
      expect(fs.existsSync(generatedFileWithoutTitle)).toBe(false)
      expect(fs.existsSync(userFile)).toBe(true)
      expect(fs.existsSync(path.join(projectPath, '.vela', 'trash'))).toBe(true)
      expect(result.physicalFilesDeleted).toBe(2)
    } finally {
      fs.rmSync(projectPath, { recursive: true, force: true })
    }
  })

  it('restores moved chapter txt files if database clear fails', () => {
    const run = vi.fn()
    const db = {
      prepare: vi.fn((sql: string) => ({ sql, run })),
      transaction: vi.fn(() => () => { throw new Error('db failed') }),
    }
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-clear-rollback-'))
    fs.mkdirSync(path.join(projectPath, '.vela'), { recursive: true })
    const generatedFile = path.join(projectPath, '第3章 回滚.txt')
    fs.writeFileSync(generatedFile, 'chapter three')
    vi.mocked(getProjectDb).mockReturnValue(db as never)
    vi.mocked(getCurrentProjectPath).mockReturnValue(projectPath)

    try {
      expect(() => ProjectClearRepository.clearGeneratedData({ generatedText: true })).toThrow('db failed')
      expect(fs.existsSync(generatedFile)).toBe(true)
    } finally {
      fs.rmSync(projectPath, { recursive: true, force: true })
    }
  })
})
