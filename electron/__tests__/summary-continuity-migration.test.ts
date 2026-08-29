import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../database'
import { SummaryRepository } from '../repositories/summary-repository'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
const roots: string[] = []

afterEach(() => {
  closeProjectDatabase()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('summary continuity migration', () => {
  it('adds finalized continuity columns after opening a legacy character snapshot table', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-summary-migration-'))
    roots.push(projectRoot)
    const velaRoot = path.join(projectRoot, '.vela')
    fs.mkdirSync(velaRoot, { recursive: true })
    const legacyDb = new Database(path.join(velaRoot, 'vela.db'))
    legacyDb.exec(`
      CREATE TABLE summary_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chapter_number INTEGER NOT NULL,
        character_states TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO summary_snapshots (chapter_number, character_states)
      VALUES (3, 'legacy character state');
    `)
    legacyDb.close()

    expect(() => initProjectDatabase(projectRoot)).not.toThrow()
    expect(getProjectDb()!.prepare('PRAGMA table_info(summary_snapshots)').all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'draft_id' }),
        expect.objectContaining({ name: 'chapter_notes' }),
      ]))
    expect(SummaryRepository.getLatestSnapshot()).toEqual({
      chapterNumber: 3,
      characterStates: 'legacy character state',
    })
  })
})
