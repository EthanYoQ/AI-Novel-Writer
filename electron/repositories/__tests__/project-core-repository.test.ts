import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getProjectDb } from '../../database'
import { ProjectCoreRepository } from '../project-core-repository'

vi.mock('../../database', () => ({
  getProjectDb: vi.fn(),
}))

beforeEach(() => {
  vi.mocked(getProjectDb).mockReturnValue(null)
})

describe('ProjectCoreRepository without an opened project DB', () => {
  it('throws when updating project core data', () => {
    expect(() => ProjectCoreRepository.update({ writingStyle: '冷峻紧凑' })).toThrow(/项目数据库未打开/)
  })
})

const expectedSynopsisSource = {
  synopsis: 'Original outline',
  premise: 'Premise v1',
  charactersArch: 'Characters v1',
  worldbuilding: 'World v1',
  genre: 'mystery',
  totalChapters: 80,
  wordsPerChapter: 2500,
  writingLanguage: 'zh-CN' as const,
  plotStructure: 'three_act',
  narrativePov: 'third_limited',
  globalGuidance: 'Keep the reveal private.',
}

describe('ProjectCoreRepository synopsis compare-and-set', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE project_core (
        id TEXT PRIMARY KEY,
        synopsis TEXT,
        premise TEXT,
        characters_arch TEXT,
        worldbuilding TEXT,
        genre TEXT,
        total_chapters INTEGER,
        words_per_chapter INTEGER,
        writing_language TEXT,
        plot_structure TEXT,
        narrative_pov TEXT,
        global_guidance TEXT,
        updated_at TEXT
      );
    `)
    db.prepare(`
      INSERT INTO project_core (
        id, synopsis, premise, characters_arch, worldbuilding, genre,
        total_chapters, words_per_chapter, writing_language, plot_structure,
        narrative_pov, global_guidance, updated_at
      ) VALUES ('main', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'before')
    `).run(
      expectedSynopsisSource.synopsis,
      expectedSynopsisSource.premise,
      expectedSynopsisSource.charactersArch,
      expectedSynopsisSource.worldbuilding,
      expectedSynopsisSource.genre,
      expectedSynopsisSource.totalChapters,
      expectedSynopsisSource.wordsPerChapter,
      expectedSynopsisSource.writingLanguage,
      expectedSynopsisSource.plotStructure,
      expectedSynopsisSource.narrativePov,
      expectedSynopsisSource.globalGuidance,
    )
    vi.mocked(getProjectDb).mockReturnValue(db)
  })

  afterEach(() => db.close())

  it('updates synopsis when the body and every prompt source still match exactly', () => {
    expect(ProjectCoreRepository.commitSynopsis({
      synopsis: 'Replacement outline',
      expected: expectedSynopsisSource,
    })).toBe(true)

    expect(db.prepare("SELECT synopsis FROM project_core WHERE id = 'main'").get())
      .toEqual({ synopsis: 'Replacement outline' })
  })

  it('does not treat unrelated updated_at churn as a source conflict', () => {
    db.prepare("UPDATE project_core SET updated_at = 'changed elsewhere' WHERE id = 'main'").run()

    expect(ProjectCoreRepository.commitSynopsis({
      synopsis: 'Replacement outline',
      expected: expectedSynopsisSource,
    })).toBe(true)
  })

  it.each([
    ['synopsis', 'Changed outline'],
    ['premise', 'Premise v2'],
    ['characters_arch', 'Characters v2'],
    ['worldbuilding', 'World v2'],
    ['genre', 'romance'],
    ['total_chapters', 81],
    ['words_per_chapter', 2600],
    ['writing_language', 'en-US'],
    ['plot_structure', 'multi_thread'],
    ['narrative_pov', 'first_person'],
    ['global_guidance', 'Reveal everything.'],
  ])('does not overwrite a synopsis after %s changes', (column, changedValue) => {
    db.prepare(`UPDATE project_core SET ${column} = ? WHERE id = 'main'`).run(changedValue)

    expect(ProjectCoreRepository.commitSynopsis({
      synopsis: 'Replacement outline',
      expected: expectedSynopsisSource,
    })).toBe(false)
    expect(db.prepare("SELECT synopsis FROM project_core WHERE id = 'main'").get())
      .not.toEqual({ synopsis: 'Replacement outline' })
  })

  it.each([null, ''])('accepts legacy writing_language=%j when the read model resolves it to zh-CN', (legacyValue) => {
    db.prepare("UPDATE project_core SET writing_language = ? WHERE id = 'main'").run(legacyValue)
    expect(ProjectCoreRepository.get()?.writingLanguage).toBe('zh-CN')

    expect(ProjectCoreRepository.commitSynopsis({
      synopsis: 'Replacement outline',
      expected: expectedSynopsisSource,
    })).toBe(true)
  })
})
