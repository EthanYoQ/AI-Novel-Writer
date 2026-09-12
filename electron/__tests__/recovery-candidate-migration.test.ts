import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { closeLegacyNormalizationFixture as closeProjectDatabase, getLegacyNormalizationFixtureDb as getProjectDb, openLegacyNormalizationFixture } from '../../test/helpers/legacy-baseline-fixture'

// Historical normalization regressions use an explicit fixture handle. Production
// rejects these unqualified old roots; canonical activation is tested separately.
vi.mock('../database', async () => {
  const actual = await vi.importActual<typeof import('../database')>('../database')
  const fixture = await import('../../test/helpers/legacy-baseline-fixture')
  return { ...actual, getProjectDb: fixture.getLegacyNormalizationFixtureDb, getCurrentProjectPath: fixture.getLegacyNormalizationFixturePath }
})
import { BlueprintRepository } from '../repositories/blueprint-repository'
import { RecoveryCandidateRepository } from '../repositories/recovery-candidate-repository'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
const roots: string[] = []
const source = {
  chapterNumber: 1,
  title: '第一章',
  role: '开端',
  purpose: '建立冲突',
  keyEvents: '列车失控',
  characters: ['林岚'],
  suspenseHook: '',
  userGuidance: '',
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function makeLegacyProject(): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-legacy-recovery-'))
  roots.push(projectRoot)
  const velaRoot = path.join(projectRoot, '.vela')
  fs.mkdirSync(velaRoot, { recursive: true })
  const db = new Database(path.join(velaRoot, 'vela.db'))
  const snapshot = JSON.stringify(source)
  db.exec(`
    CREATE TABLE recovery_candidates (
      candidate_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      chapter_number INTEGER NOT NULL,
      chapter_title TEXT NOT NULL DEFAULT '',
      source_snapshot TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      visible_text TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      failure_code TEXT NOT NULL DEFAULT '',
      failure_reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      replaces_candidate_id TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT DEFAULT NULL
    );
  `)
  db.prepare(`
    INSERT INTO recovery_candidates (
      candidate_id, run_id, step_id, project_id, chapter_number, chapter_title,
      source_snapshot, source_hash, visible_text, content_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'legacy-candidate',
    'legacy-run',
    'generate-draft',
    'legacy-project',
    1,
    source.title,
    snapshot,
    hash(snapshot),
    '旧候选正文',
    hash('旧候选正文'),
  )
  db.close()
  return projectRoot
}

afterEach(() => {
  closeProjectDatabase()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('recovery candidate source-draft migration', () => {
  it('leaves legacy draft identity unknown and fails closed', () => {
    const projectRoot = makeLegacyProject()
    openLegacyNormalizationFixture(projectRoot)
    BlueprintRepository.upsert({ ...source, notes: '', notesUpdatedAt: '' })

    const db = getProjectDb()!
    expect(db.prepare(`
      SELECT source_draft_id, source_draft_version, source_draft_identity_captured
      FROM recovery_candidates WHERE candidate_id = 'legacy-candidate'
    `).get()).toEqual({
      source_draft_id: null,
      source_draft_version: null,
      source_draft_identity_captured: 0,
    })
    expect(RecoveryCandidateRepository.listPending()[0]?.sourceCurrent).toBe(false)
    expect(() => RecoveryCandidateRepository.updatePending('legacy-candidate', '编辑正文'))
      .toThrow(/源章节已变化/u)
    expect(() => RecoveryCandidateRepository.resolve('legacy-candidate', 'continued'))
      .toThrow(/源章节已变化/u)
  })
})
