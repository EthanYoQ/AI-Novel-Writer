import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import type BetterSqlite3 from 'better-sqlite3'

import { getProjectDb } from '../../database'
import { PostProcessRepository } from '../post-process-repository'

vi.mock('../../database', () => ({ getProjectDb: vi.fn() }))

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
let db: BetterSqlite3.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE post_process_runs (
      id TEXT PRIMARY KEY,
      trigger_source_type TEXT NOT NULL,
      trigger_source_id TEXT NOT NULL,
      source_label TEXT DEFAULT '',
      all_critical_passed INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE post_process_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      step_key TEXT NOT NULL,
      label TEXT DEFAULT '',
      critical INTEGER DEFAULT 0,
      ok INTEGER DEFAULT 0,
      error_msg TEXT DEFAULT '',
      attempt_count INTEGER DEFAULT 0,
      completed_at TEXT DEFAULT '',
      last_attempt_at TEXT DEFAULT '',
      FOREIGN KEY (run_id) REFERENCES post_process_runs(id) ON DELETE CASCADE
    );
  `)
  vi.mocked(getProjectDb).mockReturnValue(db)
})

afterEach(() => db.close())

function createCriticalRun(): string {
  return PostProcessRepository.createRun({
    triggerSourceType: 'chapter_finalize',
    triggerSourceId: 'chapter-1',
    sourceLabel: '第1章定稿',
    steps: [{ key: 'kb_import', label: '导入知识库', critical: true }],
  })
}

describe('PostProcessRepository retry receipts', () => {
  it('rejects an unknown success step without refreshing the run summary', () => {
    const runId = createCriticalRun()

    expect(() => PostProcessRepository.markStepOk(runId, 'missing_step'))
      .toThrow('后处理步骤不存在')

    expect(PostProcessRepository.getLatestRun('chapter_finalize', 'chapter-1')?.allCriticalPassed).toBe(false)
    expect(PostProcessRepository.getSteps(runId)).toEqual([
      expect.objectContaining({ stepKey: 'kb_import', ok: false, attemptCount: 0 }),
    ])
  })

  it('rejects an unknown failure step without refreshing the run summary', () => {
    const runId = createCriticalRun()
    PostProcessRepository.markStepOk(runId, 'kb_import')

    expect(() => PostProcessRepository.markStepFailed(runId, 'missing_step', '安全错误'))
      .toThrow('后处理步骤不存在')

    expect(PostProcessRepository.getLatestRun('chapter_finalize', 'chapter-1')?.allCriticalPassed).toBe(true)
    expect(PostProcessRepository.getSteps(runId)).toEqual([
      expect.objectContaining({ stepKey: 'kb_import', ok: true, attemptCount: 1 }),
    ])
  })

  it.each([
    ['success receipt', () => PostProcessRepository.markStepOk('missing-run', 'kb_import')],
    ['failure receipt', () => PostProcessRepository.markStepFailed('missing-run', 'kb_import', '安全错误')],
  ])('rejects an unknown run for a %s with one redacted error', (_label, action) => {
    expect(action).toThrowError(new Error('后处理步骤不存在或已失效'))
    expect(PostProcessRepository.getLatestRun('chapter_finalize', 'chapter-1')).toBeNull()
  })

  it('atomically clears the previous failure when the same step retry succeeds', () => {
    const runId = createCriticalRun()
    PostProcessRepository.markStepFailed(runId, 'kb_import', '第一次安全错误')

    PostProcessRepository.markStepOk(runId, 'kb_import')

    expect(PostProcessRepository.getSteps(runId)).toEqual([
      expect.objectContaining({
        stepKey: 'kb_import',
        ok: true,
        errorMsg: '',
        attemptCount: 2,
        completedAt: expect.any(String),
        lastAttemptAt: expect.any(String),
      }),
    ])
    expect(PostProcessRepository.getSteps(runId)[0]?.completedAt).not.toBe('')
    expect(PostProcessRepository.getSteps(runId)[0]?.lastAttemptAt).not.toBe('')
    expect(PostProcessRepository.getLatestRun('chapter_finalize', 'chapter-1')?.allCriticalPassed).toBe(true)
  })

  it('replaces stale errors with the latest safe failure and clears prior success evidence', () => {
    const runId = createCriticalRun()
    PostProcessRepository.markStepOk(runId, 'kb_import')
    PostProcessRepository.markStepFailed(runId, 'kb_import', '较早的安全错误')
    PostProcessRepository.markStepFailed(runId, 'kb_import', '最新的安全错误')

    expect(PostProcessRepository.getSteps(runId)).toEqual([
      expect.objectContaining({
        stepKey: 'kb_import',
        ok: false,
        errorMsg: '最新的安全错误',
        attemptCount: 3,
        completedAt: '',
        lastAttemptAt: expect.any(String),
      }),
    ])
    expect(PostProcessRepository.getLatestRun('chapter_finalize', 'chapter-1')?.allCriticalPassed).toBe(false)
  })
})
