import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type BetterSqlite3 from 'better-sqlite3'

import { getProjectDb } from '../../database'
import { LLMHistoryRepository } from '../llm-repository'

vi.mock('../../database', () => ({ getProjectDb: vi.fn() }))

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
let db: BetterSqlite3.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE llm_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id TEXT NOT NULL,
      model_name TEXT DEFAULT '',
      purpose TEXT DEFAULT '',
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      duration_ms INTEGER DEFAULT 0,
      success INTEGER DEFAULT 1,
      error_message TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)
  vi.mocked(getProjectDb).mockReturnValue(db)
})

afterEach(() => db.close())

function log(success: boolean, errorMessage?: string): void {
  LLMHistoryRepository.logCall({
    modelId: 'model-1',
    modelName: 'Grok 4',
    purpose: 'chapter-draft',
    promptTokens: 10,
    completionTokens: 20,
    totalTokens: 30,
    durationMs: 500,
    success,
    errorMessage,
  })
}

describe('LLMHistoryRepository safe finish reasons', () => {
  it('returns only structured finish reasons without exposing raw provider errors', () => {
    log(true)
    log(false, 'finish:content_filter')
    log(false, 'Authorization: Bearer private-provider-error')

    const history = LLMHistoryRepository.getHistory() as Array<Record<string, unknown>>

    expect(history.map(row => row.finishReason)).toEqual([null, 'content_filter', 'stop'])
    expect(JSON.stringify(history)).not.toMatch(/Authorization|Bearer|private-provider-error/u)
  })
})
