import { prepareCanonicalStorageFixture } from '../../../test/helpers/canonical-project-fixture'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CANONICAL_PROJECT_DATABASE, CANONICAL_PROJECT_DIRECTORY } from '../../../src/shared/project-format'

import { getCurrentProjectPath, getProjectDb } from '../../database'
import { BlueprintRepository } from '../blueprint-repository'
import { CharacterRosterRepository } from '../character-roster-repository'
import { DraftRepository } from '../draft-repository'
import { ProjectClearRepository } from '../project-clear-repository'
import { ProjectCoreRepository } from '../project-core-repository'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { initializeCharacterRosterMetadata } from '../character-roster-schema'
import { migrateSchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../../migrations/desktop-registry'

vi.mock('../../database', async importOriginal => ({
  ...await importOriginal<typeof import('../../database')>(),
  getCurrentProjectPath: vi.fn(),
  getProjectDb: vi.fn(),
}))

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')

function createMockDb() {
  const run = vi.fn()
  const all = vi.fn(() => [{ name: 'fact_hash' }])
  const get = vi.fn(() => ({ present: true }))
  const prepare = vi.fn((sql: string) => ({ sql, run, all, get: sql.includes('character_identity_meta') ? () => undefined : get }))
  const transaction = vi.fn((fn: () => void) => () => fn())
  const exec = vi.fn()
  return { prepare, transaction, run, exec }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('project clear repositories', () => {
  it.each([
    ['empty', false, '', 'empty'],
    ['legacy cards', true, '', 'legacy_cards_preserved'],
    ['legacy cards with old architecture text', true, '# 旧角色图谱', 'legacy_cards_preserved'],
    ['old architecture text only', false, '# 旧角色图谱', 'legacy_markdown_pending'],
  ] as const)('clears character cards and architecture through the roster owner: %s', (_case, card, architecture, migrationState) => {
    const db = new Database(':memory:')
    try {
      initializeLegacyBaselineSchema(db)
      db.prepare("INSERT INTO project_core(id,premise,characters_arch,plot_tree_snapshot) VALUES('main','清空前提',?,'plot-tree-before')").run(architecture)
      if (card) db.exec("INSERT INTO characters(name,notes) VALUES('旧角色','保留原文')")
      db.exec('DELETE FROM character_roster_meta')
      initializeCharacterRosterMetadata(db)
      migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
      db.pragma('foreign_keys=ON')
      vi.mocked(getProjectDb).mockReturnValue(db)
      expect(CharacterRosterRepository.read(db)).toMatchObject({ migrationState, entries: card ? [expect.anything()] : [] })
      const aliasRows = () => db.prepare('SELECT character_id,name,source_key,valid_from FROM character_aliases').all()
      const aliases = aliasRows()
      const origins = db.prepare('SELECT * FROM character_identity_origins').all()
      ProjectClearRepository.clearGeneratedData({ creativeFields: true }, { projectId: 'project', epoch: 'lease' })
      const after = CharacterRosterRepository.read(db)
      expect(after).toMatchObject({ status: 'empty', entries: [] })
      expect(after.legacyMarkdown ?? '').toBe('')
      expect(db.prepare('SELECT characters_arch FROM project_core').pluck().get()).toBe(after.renderedMarkdown)
      expect(after.renderedMarkdown).not.toContain('旧')
      expect(db.prepare('SELECT plot_tree_snapshot FROM project_core').pluck().get()).toBe('plot-tree-before')
      expect(db.prepare('SELECT COUNT(*) FROM characters WHERE retired=0').pluck().get()).toBe(0)
      expect(aliasRows()).toEqual(aliases)
      expect(db.prepare('SELECT COUNT(*) FROM character_aliases WHERE valid_through IS NULL').pluck().get()).toBe(0)
      expect(db.prepare('SELECT * FROM character_identity_origins').all()).toEqual(origins)
      expect(db.pragma('foreign_key_check')).toEqual([])
    } finally { db.close() }
  })
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
      expect.stringContaining('UPDATE project_core') as unknown as string,
    ]))
    expect(statements).not.toContain("UPDATE project_core SET plot_tree_snapshot = '' WHERE id = 'main'")
    expect(result.cleared).toEqual(['blueprints', 'creativeFields'])
  })

  it('removes generated root chapter txt files when generated text is cleared', () => {
    const db = createMockDb()
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-clear-'))
    prepareCanonicalStorageFixture(projectPath)
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
      expect(fs.existsSync(path.join(projectPath, '.ai-novel', 'trash'))).toBe(true)
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
    prepareCanonicalStorageFixture(projectPath)
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

  it('does not restore chapter files after a committed clear when trash cleanup fails', () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-clear-committed-'))
    prepareCanonicalStorageFixture(projectPath)
    const db = new Database(path.join(projectPath, CANONICAL_PROJECT_DIRECTORY, CANONICAL_PROJECT_DATABASE))
    const generatedFile = path.join(projectPath, '第1章 夜航.txt')
    fs.writeFileSync(generatedFile, 'chapter one')
    DraftRepository.create({ chapterNumber: 1, source: 'write', content: 'chapter one', wordCount: 11 }, db)
    vi.mocked(getProjectDb).mockReturnValue(db)
    vi.mocked(getCurrentProjectPath).mockReturnValue(projectPath)
    const remove = fs.rmSync.bind(fs)
    let cleanupAttempted = false
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const removeSpy = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (String(target).startsWith(path.join(projectPath, '.ai-novel', 'trash'))) {
        cleanupAttempted = true
        throw new Error('trash cleanup denied')
      }
      return remove(target, options)
    })

    try {
      let failure: unknown
      let result: ReturnType<typeof ProjectClearRepository.clearGeneratedData> | undefined
      try { result = ProjectClearRepository.clearGeneratedData({ generatedText: true }) } catch (error) { failure = error }
      expect(cleanupAttempted).toBe(true)
      expect(db.prepare('SELECT COUNT(*) AS count FROM drafts').get()).toEqual({ count: 0 })
      expect(fs.existsSync(generatedFile)).toBe(false)
      expect(failure).toBeUndefined()
      expect(result?.physicalFilesDeleted).toBe(0)
    } finally {
      removeSpy.mockRestore()
      warnSpy.mockRestore()
      db.close()
      fs.rmSync(projectPath, { recursive: true, force: true })
    }
  })
})
