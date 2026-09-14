import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_NARRATIVE_THREAD_DORMANT_THRESHOLD,
  resolveNarrativeThreadDormantThreshold,
} from '../../src/shared/narrative-thread'
import { closeLegacyNormalizationFixture as closeProjectDatabase, getLegacyNormalizationFixtureDb as getProjectDb, openLegacyNormalizationFixture } from '../../test/helpers/legacy-baseline-fixture'

// Historical normalization regressions use an explicit fixture handle. Production
// rejects these unqualified old roots; canonical activation is tested separately.
vi.mock('../database', async () => {
  const actual = await vi.importActual<typeof import('../database')>('../database')
  const fixture = await import('../../test/helpers/legacy-baseline-fixture')
  return { ...actual, getProjectDb: fixture.getLegacyNormalizationFixtureDb, getCurrentProjectPath: fixture.getLegacyNormalizationFixturePath }
})
import { ProjectCoreRepository } from '../repositories/project-core-repository'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
const roots: string[] = []

afterEach(() => {
  closeProjectDatabase()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('project narrative thread reminder setting', () => {
  it('migrates legacy projects to the product default and restores the saved project threshold', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-thread-setting-'))
    roots.push(projectRoot)
    const velaRoot = path.join(projectRoot, '.vela')
    fs.mkdirSync(velaRoot, { recursive: true })
    const legacyDb = new Database(path.join(velaRoot, 'vela.db'))
    legacyDb.exec(`
      CREATE TABLE project_core (
        id TEXT PRIMARY KEY, project_name TEXT NOT NULL DEFAULT '', genre TEXT DEFAULT '',
        sub_genre TEXT DEFAULT '', target_audience TEXT DEFAULT '', total_chapters INTEGER DEFAULT 100,
        words_per_chapter INTEGER DEFAULT 3000, plot_structure TEXT DEFAULT 'three_act',
        narrative_pov TEXT DEFAULT 'third_limited', writing_style TEXT DEFAULT '',
        reference_works TEXT DEFAULT '', global_guidance TEXT DEFAULT '', golden_finger TEXT DEFAULT '',
        core_outline TEXT DEFAULT '', world_setting TEXT DEFAULT '', protagonist_profile TEXT DEFAULT '',
        premise TEXT DEFAULT '', worldbuilding TEXT DEFAULT '', characters_arch TEXT DEFAULT '',
        synopsis TEXT DEFAULT '', character_states TEXT DEFAULT '', created_at TEXT, updated_at TEXT
      );
      INSERT INTO project_core (id, project_name) VALUES ('main', 'Legacy novel');
    `)
    legacyDb.close()

    openLegacyNormalizationFixture(projectRoot)
    expect(ProjectCoreRepository.get()?.narrativeThreadDormantChapterThreshold)
      .toBe(DEFAULT_NARRATIVE_THREAD_DORMANT_THRESHOLD)
    ProjectCoreRepository.update({ narrativeThreadDormantChapterThreshold: 7 })
    closeProjectDatabase()
    openLegacyNormalizationFixture(projectRoot)

    expect(ProjectCoreRepository.get()?.narrativeThreadDormantChapterThreshold).toBe(7)
    expect(getProjectDb()!.prepare(
      "SELECT narrative_thread_dormant_threshold FROM project_core WHERE id = 'main'",
    ).get()).toEqual({ narrative_thread_dormant_threshold: 7 })
  })

  it('resolves missing and out-of-range values to the documented effective range', () => {
    expect(resolveNarrativeThreadDormantThreshold(undefined)).toBe(DEFAULT_NARRATIVE_THREAD_DORMANT_THRESHOLD)
    expect(resolveNarrativeThreadDormantThreshold(0)).toBe(1)
    expect(resolveNarrativeThreadDormantThreshold(999)).toBe(50)
  })
})
