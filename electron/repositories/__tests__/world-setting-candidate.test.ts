/**
 * WorldSettingRepository.createCandidate 的存储边界。
 *
 * 守的是 review P1 点名的那条线：**候选创建只新增，绝不更新既有条目**。
 *
 * 反例（review 给的具体输入）：库里 `Nova` 与 `NOVA` 两条已确认条目并存
 * （`UNIQUE(name)` 区分大小写，所以这两行合法）；模型报 `Nova`，引文根本不在正文里。
 * 旧的「降级为待确认候选」路径调用 `world-setting:save`，仓储按**精确同名**找到
 * `Nova`，默认 `author` 权限放行字段保护 → UPDATE 覆盖作者原文；而 UPDATE 分支
 * 有意不写 status，于是原条目仍是 confirmed、待确认队列一条没多，调用方却把
 * `pendingCount` 加了 1。
 *
 * 这里不用 mock 替身，直接跑真实仓储 + 真实 SQLite：只有真库才能证明
 * 「候选创建没有 UPDATE 任何既有行」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import type BetterSqlite3 from 'better-sqlite3'

import { getProjectDb } from '../../database'
import { WorldSettingRepository } from '../world-setting-repository'

vi.mock('../../database', () => ({
  getProjectDb: vi.fn(),
}))

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')

let db: BetterSqlite3.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE world_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL DEFAULT 'world',
      name TEXT NOT NULL,
      aliases TEXT NOT NULL DEFAULT '[]',
      summary TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      importance TEXT NOT NULL DEFAULT 'side',
      related TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'confirmed',
      provenance TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(name)
    );
    CREATE TABLE world_setting_conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chapter_number INTEGER NOT NULL,
      setting_id INTEGER NOT NULL,
      setting_name TEXT NOT NULL DEFAULT '',
      setting_content_snapshot TEXT NOT NULL DEFAULT '',
      evidence TEXT NOT NULL DEFAULT '',
      statement TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      resolution TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      resolved_at TEXT
    );
  `)
  vi.mocked(getProjectDb).mockReturnValue(db)
})

afterEach(() => {
  db.close()
  vi.restoreAllMocks()
})

/** 造一条作者已确认的条目（author 原文 + author provenance）。 */
function seedConfirmedEntry(overrides: {
  name: string
  category?: string
  summary?: string
  content?: string
  aliases?: string[]
  tags?: string[]
  importance?: string
}): number {
  const result = db.prepare(`
    INSERT INTO world_settings (category, name, aliases, summary, content, tags, importance, related, source, status, provenance)
    VALUES (?, ?, ?, ?, ?, ?, ?, '[]', 'manual', 'confirmed', ?)
  `).run(
    overrides.category ?? 'faction',
    overrides.name,
    JSON.stringify(overrides.aliases ?? []),
    overrides.summary ?? '作者手写的摘要',
    overrides.content ?? '作者手写的原文',
    JSON.stringify(overrides.tags ?? ['作者标签']),
    overrides.importance ?? 'main',
    JSON.stringify({
      content: { kind: 'author' },
      summary: { kind: 'author' },
      tags: { kind: 'author' },
      aliases: { kind: 'author' },
      importance: { kind: 'author' },
    }),
  )
  return Number(result.lastInsertRowid)
}

/** 整行原始取值：断言「一个字节都没动」时用它，避免只比对自己关心的那几个字段。 */
function rawRow(id: number): Record<string, unknown> {
  return db.prepare('SELECT * FROM world_settings WHERE id = ?').get(id) as Record<string, unknown>
}

function allRows(): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM world_settings ORDER BY id ASC').all() as Array<Record<string, unknown>>
}

describe('WorldSettingRepository candidate creation is insert-only', () => {
  it('creates a real pending row when the name does not exist yet', () => {
    const result = WorldSettingRepository.createCandidate({
      category: 'world',
      name: '变身',
      content: '男身看见女性产生性兴奋会变成该女性。\n\n依据（第1章）：看见女人并产生性兴奋，就可能变成该女性。',
      source: 'ai',
      status: 'pending',
      provenance: { content: { kind: 'derived', chapterNumber: 1 } },
    })

    expect(result.created).toBe(true)
    const rows = allRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      name: '变身',
      status: 'pending',
      source: 'ai',
    })
  })

  it('refuses a candidate whose name already belongs to a confirmed entry, leaving every field untouched', () => {
    const existingId = seedConfirmedEntry({ name: '青云宗' })
    const before = rawRow(existingId)

    const result = WorldSettingRepository.createCandidate({
      category: 'world',
      name: '青云宗',
      content: '青云宗已覆灭。\n\n依据（第3章）：青云宗已经彻底覆灭。',
      source: 'ai',
      status: 'pending',
    })

    expect(result).toEqual({
      created: false,
      reason: 'duplicate-name',
      existingId,
      existingName: '青云宗',
      existingStatus: 'confirmed',
    })
    // 原文、摘要、分类、标签、重要度、状态、来源标记 —— 一处都不能变。
    expect(rawRow(existingId)).toEqual(before)
    expect(allRows()).toHaveLength(1)
  })

  it('treats a case-folded name collision as a conflict instead of overwriting (Nova / NOVA)', () => {
    const upperId = seedConfirmedEntry({ name: 'Nova', content: 'Nova 的作者原文' })
    const lowerId = seedConfirmedEntry({ name: 'NOVA', content: 'NOVA 的作者原文' })
    const beforeUpper = rawRow(upperId)
    const beforeLower = rawRow(lowerId)

    // 大小写折叠口径与名称解析一致：三种写法都必须被拒。
    for (const name of ['Nova', 'NOVA', 'nova']) {
      const result = WorldSettingRepository.createCandidate({
        category: 'world',
        name,
        content: `${name} 已覆灭。\n\n依据（第3章）：Nova has already been destroyed.`,
        source: 'ai',
        status: 'pending',
      })
      expect(result.created).toBe(false)
      expect(result).toMatchObject({ reason: 'duplicate-name' })
    }

    expect(rawRow(upperId)).toEqual(beforeUpper)
    expect(rawRow(lowerId)).toEqual(beforeLower)
    expect(allRows()).toHaveLength(2)
  })

  it('still refuses when the same-named entry appeared after the workflow read its snapshot', () => {
    // 模拟过期快照：工作流读列表时库里还是空的（解析判定「无命中」），
    // 等模型返回的这段时间里数据库新增了同名条目；候选创建必须在存储层挡住它。
    expect(WorldSettingRepository.getAll()).toHaveLength(0)
    const appearedId = seedConfirmedEntry({ name: '变身' })
    const before = rawRow(appearedId)

    const result = WorldSettingRepository.createCandidate({
      category: 'world',
      name: '变身',
      content: '男身看见女性产生性兴奋会变成该女性。',
      source: 'ai',
      status: 'pending',
    })

    expect(result).toMatchObject({ created: false, reason: 'duplicate-name', existingId: appearedId })
    expect(rawRow(appearedId)).toEqual(before)
  })

  it('cannot self-promote: a candidate always lands as pending', () => {
    const result = WorldSettingRepository.createCandidate({
      category: 'world',
      name: '新设定',
      content: '正文引出的新设定。',
      source: 'ai',
      // 调用方乱传 confirmed 也不行 —— 候选的转正只能由作者显式采纳（setStatus）。
      status: 'confirmed',
    })

    expect(result.created).toBe(true)
    expect(WorldSettingRepository.getAll()[0]).toMatchObject({ name: '新设定', status: 'pending' })
  })

  it('rejects an invalid name without writing anything', () => {
    expect(WorldSettingRepository.createCandidate({ category: 'world', name: '   ' }))
      .toEqual({ created: false, reason: 'invalid-name' })
    expect(WorldSettingRepository.createCandidate({ category: 'world', name: 'x'.repeat(201) }))
      .toEqual({ created: false, reason: 'invalid-name' })
    expect(allRows()).toHaveLength(0)
  })

  it('never falls back to the overwriting save path', () => {
    // 对照组：save 本身仍是覆盖式（作者在界面上的编辑走它，这是有意保留的保护线）。
    // 候选创建则必须只在同名不存在时新增，任何情况下都不更新既有行。
    const existingId = seedConfirmedEntry({ name: 'ABC' })
    const before = rawRow(existingId)

    WorldSettingRepository.createCandidate({
      category: 'world',
      name: 'ABC',
      summary: '候选摘要',
      content: '候选正文',
      tags: ['候选标签'],
      importance: 'background',
      source: 'ai',
      status: 'pending',
      provenance: { content: { kind: 'derived', chapterNumber: 2 } },
    })

    expect(rawRow(existingId)).toEqual(before)
    expect(WorldSettingRepository.getById(existingId)).toMatchObject({
      category: 'faction',
      summary: '作者手写的摘要',
      content: '作者手写的原文',
      tags: ['作者标签'],
      importance: 'main',
      status: 'confirmed',
    })
  })
})
