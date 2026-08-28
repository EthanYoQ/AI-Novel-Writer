import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../database'
import { ProjectCoreRepository } from '../repositories/project-core-repository'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
const roots: string[] = []

afterEach(() => {
  closeProjectDatabase()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('project writing language persistence', () => {
  it('initializes and reopens a new project with its selected writing language', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-writing-language-new-'))
    roots.push(projectRoot)

    initProjectDatabase(projectRoot)
    ProjectCoreRepository.init('English novel', 'en-US')
    expect(ProjectCoreRepository.get()).toMatchObject({ writingLanguage: 'en-US' })

    closeProjectDatabase()
    initProjectDatabase(projectRoot)
    expect(ProjectCoreRepository.get()).toMatchObject({ writingLanguage: 'en-US' })
  })

  it('keeps a legacy project in Chinese and restores an explicitly saved language', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-writing-language-'))
    roots.push(projectRoot)
    const velaRoot = path.join(projectRoot, '.vela')
    fs.mkdirSync(velaRoot, { recursive: true })
    const legacyDb = new Database(path.join(velaRoot, 'vela.db'))
    legacyDb.exec(`
      CREATE TABLE project_core (
        id TEXT PRIMARY KEY,
        project_name TEXT NOT NULL DEFAULT '',
        genre TEXT DEFAULT '',
        sub_genre TEXT DEFAULT '',
        target_audience TEXT DEFAULT '',
        total_chapters INTEGER DEFAULT 100,
        words_per_chapter INTEGER DEFAULT 3000,
        plot_structure TEXT DEFAULT 'three_act',
        narrative_pov TEXT DEFAULT 'third_limited',
        writing_style TEXT DEFAULT '',
        reference_works TEXT DEFAULT '',
        global_guidance TEXT DEFAULT '',
        golden_finger TEXT DEFAULT '',
        core_outline TEXT DEFAULT '',
        world_setting TEXT DEFAULT '',
        protagonist_profile TEXT DEFAULT '',
        premise TEXT DEFAULT '',
        worldbuilding TEXT DEFAULT '',
        characters_arch TEXT DEFAULT '',
        synopsis TEXT DEFAULT '',
        character_states TEXT DEFAULT '',
        created_at TEXT,
        updated_at TEXT
      );
      INSERT INTO project_core (id, project_name) VALUES ('main', 'Legacy novel');
    `)
    legacyDb.close()

    initProjectDatabase(projectRoot)
    expect(ProjectCoreRepository.get()).toMatchObject({ writingLanguage: 'zh-CN' })

    ProjectCoreRepository.update({ writingLanguage: 'en-US' } as never)
    closeProjectDatabase()
    initProjectDatabase(projectRoot)

    expect(ProjectCoreRepository.get()).toMatchObject({ writingLanguage: 'en-US' })
    expect(getProjectDb()!.prepare(
      "SELECT writing_language FROM project_core WHERE id = 'main'",
    ).get()).toEqual({ writing_language: 'en-US' })

    ProjectCoreRepository.update({ writingLanguage: 'zh-CN' })
    closeProjectDatabase()
    initProjectDatabase(projectRoot)
    expect(ProjectCoreRepository.get()).toMatchObject({ writingLanguage: 'zh-CN' })
  })
})
