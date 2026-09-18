/**
 * WorldSettingRepository 的字段级来源保护与定稿追加更新。
 *
 * 这个文件守的是先生拍板的那条保护线：
 *   · **自动写入**（writeMode: 'auto'）不得改写作者手写（author）与架构拆出
 *     （architecture）的字段；
 *   · 但**作者本人在界面的保存永远放行** —— 保护线保护的是作者，不能反锁作者；
 *   · 定稿后的自动更新**只追加、不改写**，且必须留下章节来源；
 *   · 同一章重复跑不会把同一句追加两遍。
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

function seedEntry(overrides: {
  name: string
  summary?: string
  content?: string
  provenance?: Record<string, unknown>
}): number {
  const result = db.prepare(`
    INSERT INTO world_settings (category, name, aliases, summary, content, tags, importance, related, source, status, provenance)
    VALUES ('faction', ?, '[]', ?, ?, '[]', 'side', '[]', 'manual', 'confirmed', ?)
  `).run(
    overrides.name,
    overrides.summary ?? '',
    overrides.content ?? '',
    JSON.stringify(overrides.provenance ?? {}),
  )
  return Number(result.lastInsertRowid)
}

describe('WorldSettingRepository field provenance protection', () => {
  /**
   * 先生报的 bug 回归：条目在界面上写过一次之后，第二次起就再也改不动
   * （文本域里改了、点保存后内容原样返回）。根因是字段保护没区分写入者，
   * 界面保存也被 author 标记拦住 —— 这里连同后续两条一起锁住新行为。
   */
  it('回写第二次、第三次界面保存，不再出现「只能编辑一次」', () => {
    const created = WorldSettingRepository.save({
      category: 'faction',
      name: '归墟盟',
      summary: '第一版摘要',
      content: '第一版正文',
    })
    expect(created).not.toBeNull()

    const second = WorldSettingRepository.save({
      id: created!.id,
      category: 'faction',
      name: '归墟盟',
      summary: '第二版摘要',
      content: '第二版正文',
    })
    expect(second?.summary).toBe('第二版摘要')
    expect(second?.content).toBe('第二版正文')

    const third = WorldSettingRepository.save({
      id: created!.id,
      category: 'faction',
      name: '归墟盟',
      summary: '第三版摘要',
      content: '第三版正文',
    })
    expect(third?.summary).toBe('第三版摘要')
    expect(third?.content).toBe('第三版正文')
  })

  it('lets the author rewrite the content they wrote earlier', () => {
    const id = seedEntry({
      name: '青云宗',
      summary: '北方第一大宗。',
      content: '青云宗以灵脉立宗。',
      provenance: { summary: { kind: 'author' }, content: { kind: 'author' } },
    })

    const saved = WorldSettingRepository.save({
      id,
      category: 'faction',
      name: '青云宗',
      summary: '改过的摘要',
      content: '改过的正文',
    })

    // 作者本人的保存不受任何来源标记阻挡
    expect(saved?.summary).toBe('改过的摘要')
    expect(saved?.content).toBe('改过的正文')
    expect(saved?.provenance?.content).toEqual({ kind: 'author' })
  })

  it('lets the author rewrite fields that were split out of the architecture', () => {
    const id = seedEntry({
      name: '玄阳子',
      content: '架构拆出来的旧设定。',
      provenance: { content: { kind: 'architecture' } },
    })

    const saved = WorldSettingRepository.save({
      id,
      category: 'faction',
      name: '玄阳子',
      content: '作者改过的设定。',
    })

    expect(saved?.content).toBe('作者改过的设定。')
  })

  it('keeps author-written content when an automatic write tries to rewrite it', () => {
    const id = seedEntry({
      name: '青云宗',
      summary: '北方第一大宗。',
      content: '青云宗以灵脉立宗。',
      provenance: { summary: { kind: 'author' }, content: { kind: 'author' } },
    })

    const saved = WorldSettingRepository.save({
      id,
      category: 'faction',
      name: '青云宗',
      summary: '被改写的摘要',
      content: '被改写的正文',
      writeMode: 'auto',
    })

    // 自动写入下，作者手写的内容一个字都不能变
    expect(saved?.summary).toBe('北方第一大宗。')
    expect(saved?.content).toBe('青云宗以灵脉立宗。')
    // 保护标记保持原样
    expect(saved?.provenance?.content).toEqual({ kind: 'author' })
  })

  it('allows replacing fields that are only derived', () => {
    const id = seedEntry({
      name: '玄阳子',
      summary: '旧摘要',
      provenance: { summary: { kind: 'derived', chapterNumber: 10 } },
    })

    const saved = WorldSettingRepository.save({
      id,
      category: 'faction',
      name: '玄阳子',
      summary: '新摘要',
    })

    expect(saved?.summary).toBe('新摘要')
    // 改写后来源回到「作者手写」（作者在界面确认的新内容）
    expect(saved?.provenance?.summary).toEqual({ kind: 'author' })
  })

  it('treats entries without provenance as legacy and allows updating them', () => {
    const id = seedEntry({ name: '无标记条目', summary: '旧值' })

    const saved = WorldSettingRepository.save({
      id,
      category: 'faction',
      name: '无标记条目',
      summary: '新值',
    })

    expect(saved?.summary).toBe('新值')
  })

  it('records author provenance when the caller declares none', () => {
    const saved = WorldSettingRepository.save({
      category: 'faction',
      name: '新建条目',
      summary: '作者写的摘要',
      content: '作者写的正文',
    })

    expect(saved?.provenance?.summary).toEqual({ kind: 'author' })
    expect(saved?.provenance?.content).toEqual({ kind: 'author' })
  })

  it('records the declared provenance when the caller supplies one', () => {
    const saved = WorldSettingRepository.save({
      category: 'faction',
      name: 'AI 生成条目',
      summary: 'AI 摘要',
      source: 'ai',
      status: 'pending',
      provenance: { summary: { kind: 'architecture' } },
    })

    expect(saved?.summary).toBe('AI 摘要')
    expect(saved?.provenance?.summary).toEqual({ kind: 'architecture' })
    expect(saved?.status).toBe('pending')
  })
})

describe('WorldSettingRepository.appendDerived', () => {
  it('appends the new development without touching the author original', () => {
    const id = seedEntry({
      name: '青云宗',
      content: '青云宗以灵脉立宗，掌门玄阳子闭关三百年。',
      provenance: { content: { kind: 'author' } },
    })

    const updated = WorldSettingRepository.appendDerived(
      id,
      { content: '玄阳子出关，主持宗门大典。' },
      30,
    )

    expect(updated?.appended).toBe(true)
    // 原文完整保留 + 新进展追加在后面
    expect(updated?.entry.content).toContain('青云宗以灵脉立宗，掌门玄阳子闭关三百年。')
    expect(updated?.entry.content).toContain('（第30章：玄阳子出关，主持宗门大典。）')
    // 追加不降低保护级别：author 内容追加后仍是 author，后续 auto save 无法覆盖原文
    expect(updated?.entry.provenance?.content).toEqual({ kind: 'author' })
  })

  it('updates the chapter marker when appending to an already-derived field', () => {
    const id = seedEntry({
      name: '玄阳子',
      content: '旧进展。',
      provenance: { content: { kind: 'derived', chapterNumber: 10 } },
    })

    const updated = WorldSettingRepository.appendDerived(id, { content: '新进展。' }, 30)

    // derived 字段追加后仍是 derived，只推进证据章节
    expect(updated?.entry.provenance?.content).toEqual({ kind: 'derived', chapterNumber: 30 })
  })

  it('does not append the same development twice when the chapter is re-run', () => {
    const id = seedEntry({ name: '青云宗', content: '原文。' })

    WorldSettingRepository.appendDerived(id, { content: '玄阳子出关。' }, 30)
    const second = WorldSettingRepository.appendDerived(id, { content: '玄阳子出关。' }, 30)
    const occurrences = (second?.entry.content.match(/玄阳子出关。/g) ?? []).length

    expect(occurrences).toBe(1)
    // 第二次没有实际写入，如实回报 appended=false
    expect(second?.appended).toBe(false)
  })

  it('leaves the entry untouched when there is nothing to append', () => {
    const id = seedEntry({ name: '青云宗', content: '原文。' })
    const before = WorldSettingRepository.getById(id)

    const after = WorldSettingRepository.appendDerived(id, {}, 30)

    expect(after?.appended).toBe(false)
    expect(after?.entry.content).toBe(before?.content)
    expect(after?.entry.updatedAt).toBe(before?.updatedAt)
  })

  it('returns null for an unknown id instead of creating anything', () => {
    expect(WorldSettingRepository.appendDerived(9999, { content: 'x' }, 1)).toBeNull()
  })

  it('survives a corrupt provenance column by treating it as legacy', () => {
    const id = seedEntry({ name: '脏数据条目', summary: '旧值' })
    db.prepare('UPDATE world_settings SET provenance = ? WHERE id = ?').run('{不是 JSON', id)

    const entry = WorldSettingRepository.getById(id)
    expect(entry?.summary).toBe('旧值')
    expect(entry?.provenance).toBeUndefined()
  })
})

/**
 * 组合场景（review P2-1）：作者原文 → 派生追加 → 后续 auto save，
 * 保护线必须仍然生效 —— 一次派生追加不得解除作者/架构内容的保护。
 */
describe('WorldSettingRepository derived append does not lower protection', () => {
  it('keeps author content protected after appendDerived, so a later auto save cannot overwrite', () => {
    const id = seedEntry({
      name: '青云宗',
      content: '青云宗以灵脉立宗。',
      provenance: { content: { kind: 'author' } },
    })

    const appended = WorldSettingRepository.appendDerived(id, { content: '玄阳子出关。' }, 30)
    expect(appended?.appended).toBe(true)
    expect(appended?.entry.provenance?.content).toEqual({ kind: 'author' })

    const saved = WorldSettingRepository.save({
      id,
      category: 'faction',
      name: '青云宗',
      content: '替换全文',
      writeMode: 'auto',
    })

    expect(saved?.content).toContain('青云宗以灵脉立宗。')
    expect(saved?.content).toContain('（第30章：玄阳子出关。）')
    expect(saved?.content).not.toContain('替换全文')
    expect(saved?.provenance?.content).toEqual({ kind: 'author' })
  })

  it('keeps architecture content protected after appendDerived', () => {
    const id = seedEntry({
      name: '玄阳子',
      content: '架构拆出的旧设定。',
      provenance: { content: { kind: 'architecture' } },
    })

    WorldSettingRepository.appendDerived(id, { content: '出关。' }, 30)

    const saved = WorldSettingRepository.save({
      id,
      category: 'faction',
      name: '玄阳子',
      content: '替换全文',
      writeMode: 'auto',
    })

    expect(saved?.content).toContain('架构拆出的旧设定。')
    expect(saved?.content).not.toContain('替换全文')
    expect(saved?.provenance?.content).toEqual({ kind: 'architecture' })
  })
})

/**
 * 冲突裁决队列。
 *
 * 定稿后 AI 能发现「正文与设定直接矛盾」，但它不知道该听哪边 ——
 * 所以只落记录，把裁决交给作者。这组测试守的是：
 * 冲突能进去、能一键裁决、且**裁决不会越过作者的保护线**。
 */
describe('WorldSettingRepository conflict adjudication', () => {
  it('records a conflict and lists it as open', () => {
    const id = seedEntry({ name: '青云宗', content: '青云宗已覆灭。' })

    const conflict = WorldSettingRepository.createConflict({
      chapterNumber: 30,
      settingId: id,
      settingName: '青云宗',
      settingContentSnapshot: '青云宗已覆灭。',
      evidence: '青云宗派来援兵。',
      statement: '正文称青云宗仍有援兵，与「已覆灭」矛盾。',
    })

    expect(conflict?.status).toBe('open')
    expect(conflict?.chapterNumber).toBe(30)
    expect(WorldSettingRepository.listOpenConflicts()).toHaveLength(1)
  })

  it('does not duplicate the same open conflict when post-processing re-runs', () => {
    const id = seedEntry({ name: '青云宗', content: '青云宗已覆灭。' })
    const draft = {
      chapterNumber: 30,
      settingId: id,
      settingName: '青云宗',
      settingContentSnapshot: '青云宗已覆灭。',
      evidence: '青云宗派来援兵。',
      statement: '正文与设定矛盾。',
    }

    WorldSettingRepository.createConflict(draft)
    WorldSettingRepository.createConflict(draft)

    expect(WorldSettingRepository.listOpenConflicts()).toHaveLength(1)
  })

  it('rejects an incomplete conflict instead of storing a hollow record', () => {
    const id = seedEntry({ name: '青云宗', content: 'x' })
    expect(WorldSettingRepository.createConflict({
      chapterNumber: 1,
      settingId: id,
      settingName: '青云宗',
      evidence: '',
      statement: '没有证据的冲突',
    })).toBeNull()
  })

  it('adopting the draft appends to the entry without overwriting the author text', () => {
    const id = seedEntry({
      name: '青云宗',
      content: '青云宗以灵脉立宗。',
      provenance: { content: { kind: 'author' } },
    })
    const conflict = WorldSettingRepository.createConflict({
      chapterNumber: 30,
      settingId: id,
      settingName: '青云宗',
      settingContentSnapshot: '青云宗以灵脉立宗。',
      evidence: '青云宗派人来援。',
      statement: '青云宗已恢复元气，重新遣使。',
    })

    const result = WorldSettingRepository.resolveConflict(conflict!.id, 'adopted-draft')

    // 作者原文完整保留，正文这条事实以带章号的追加形式补上
    expect(result?.entry?.content).toContain('青云宗以灵脉立宗。')
    expect(result?.entry?.content).toContain('（第30章：青云宗已恢复元气，重新遣使。）')
    expect(result?.conflict.status).toBe('resolved')
    expect(result?.conflict.resolution).toBe('adopted-draft')
    // 裁决完就不该再出现在待裁决队列里
    expect(WorldSettingRepository.listOpenConflicts()).toHaveLength(0)
  })

  it('keeping the entry marks it resolved without touching any content', () => {
    const id = seedEntry({ name: '青云宗', content: '青云宗已覆灭。' })
    const before = WorldSettingRepository.getById(id)
    const conflict = WorldSettingRepository.createConflict({
      chapterNumber: 30,
      settingId: id,
      settingName: '青云宗',
      settingContentSnapshot: '青云宗已覆灭。',
      evidence: '青云宗派来援兵。',
      statement: '正文与设定矛盾。',
    })

    const result = WorldSettingRepository.resolveConflict(conflict!.id, 'kept-entry')

    expect(result?.conflict.resolution).toBe('kept-entry')
    expect(result?.entry).toBeNull()
    // 内容一个字都不能动 —— 这正是「保留条目原文」的语义
    const after = WorldSettingRepository.getById(id)
    expect(after?.content).toBe(before?.content)
    expect(after?.updatedAt).toBe(before?.updatedAt)
  })

  it('marks a conflict ignored without resolving it', () => {
    const id = seedEntry({ name: '青云宗', content: 'x' })
    const conflict = WorldSettingRepository.createConflict({
      chapterNumber: 30,
      settingId: id,
      settingName: '青云宗',
      settingContentSnapshot: 'x',
      evidence: 'e',
      statement: 's',
    })

    const ignored = WorldSettingRepository.ignoreConflict(conflict!.id)

    expect(ignored?.status).toBe('ignored')
    expect(ignored?.resolution).toBeUndefined()
    expect(WorldSettingRepository.listOpenConflicts()).toHaveLength(0)
  })

  it('does not resolve the same conflict twice', () => {
    const id = seedEntry({ name: '青云宗', content: '原文。' })
    const conflict = WorldSettingRepository.createConflict({
      chapterNumber: 30,
      settingId: id,
      settingName: '青云宗',
      settingContentSnapshot: '原文。',
      evidence: 'e',
      statement: '第二条事实。',
    })

    WorldSettingRepository.resolveConflict(conflict!.id, 'adopted-draft')
    const second = WorldSettingRepository.resolveConflict(conflict!.id, 'adopted-draft')

    // 第二次不再重复追加（entry 为 null 表示这次没动内容）
    expect(second?.entry).toBeNull()
    const occurrences = (WorldSettingRepository.getById(id)?.content.match(/第二条事实。/g) ?? []).length
    expect(occurrences).toBe(1)
  })

  /**
   * 批量裁决 —— 先生要的「有些用户觉得一条条看很烦」的出口。
   * 关键要求：一次处理全部未决，且每条都仍然只追加不覆盖。
   */
  it('resolves every open conflict at once, still appending instead of overwriting', () => {
    const first = seedEntry({ name: '青云宗', content: '青云宗以灵脉立宗。' })
    const second = seedEntry({ name: '玄阳子', content: '玄阳子闭关中。' })
    WorldSettingRepository.createConflict({
      chapterNumber: 30, settingId: first, settingName: '青云宗',
      settingContentSnapshot: '青云宗以灵脉立宗。', evidence: '援兵已至。', statement: '青云宗仍有援兵。',
    })
    WorldSettingRepository.createConflict({
      chapterNumber: 31, settingId: second, settingName: '玄阳子',
      settingContentSnapshot: '玄阳子闭关中。', evidence: '他推门而出。', statement: '玄阳子已出关。',
    })

    const result = WorldSettingRepository.resolveAllConflicts('adopted-draft')

    expect(result.resolved).toBe(2)
    expect(result.failedIds).toEqual([])
    expect(WorldSettingRepository.listOpenConflicts()).toHaveLength(0)
    // 两条各自的原文都完整保留，新事实以带章号的形式追加
    expect(WorldSettingRepository.getById(first)?.content).toContain('青云宗以灵脉立宗。')
    expect(WorldSettingRepository.getById(first)?.content).toContain('（第30章：青云宗仍有援兵。）')
    expect(WorldSettingRepository.getById(second)?.content).toContain('玄阳子闭关中。')
    expect(WorldSettingRepository.getById(second)?.content).toContain('（第31章：玄阳子已出关。）')
  })

  it('batch-keeping every conflict leaves all entry content untouched', () => {
    const id = seedEntry({ name: '青云宗', content: '青云宗已覆灭。' })
    const before = WorldSettingRepository.getById(id)
    WorldSettingRepository.createConflict({
      chapterNumber: 30, settingId: id, settingName: '青云宗',
      settingContentSnapshot: '青云宗已覆灭。', evidence: '援兵已至。', statement: '正文与设定矛盾。',
    })

    const result = WorldSettingRepository.resolveAllConflicts('kept-entry')

    expect(result.resolved).toBe(1)
    expect(WorldSettingRepository.listOpenConflicts()).toHaveLength(0)
    const after = WorldSettingRepository.getById(id)
    expect(after?.content).toBe(before?.content)
    expect(after?.updatedAt).toBe(before?.updatedAt)
  })

  it('reports zero when there is nothing to batch-resolve', () => {
    expect(WorldSettingRepository.resolveAllConflicts('adopted-draft')).toEqual({
      resolved: 0,
      failedIds: [],
    })
  })

  /**
   * 批量裁决的「全有或全无」语义（review P2-2）：
   * 任何一条失败都回滚整批，绝不留下「一半采纳了」的中间状态。
   */
  it('rolls back the whole batch when a later conflict fails', () => {
    const first = seedEntry({ name: '青云宗', content: '原文一。' })
    const second = seedEntry({ name: '玄阳子', content: '原文二。' })
    const c1 = WorldSettingRepository.createConflict({
      chapterNumber: 30, settingId: first, settingName: '青云宗',
      settingContentSnapshot: '原文一。', evidence: 'e1', statement: '第一条事实。',
    })!
    const c2 = WorldSettingRepository.createConflict({
      chapterNumber: 31, settingId: second, settingName: '玄阳子',
      settingContentSnapshot: '原文二。', evidence: 'e2', statement: '第二条事实。',
    })!

    // 让第二条裁决失败：抛错触发整批回滚，第一条的追加也要被撤销。
    const original = WorldSettingRepository.resolveConflict
    vi.spyOn(WorldSettingRepository, 'resolveConflict').mockImplementation((id, resolution) => {
      if (id === c2.id) throw new Error('status write failed')
      return original.call(WorldSettingRepository, id, resolution)
    })

    const result = WorldSettingRepository.resolveAllConflicts('adopted-draft')

    expect(result.resolved).toBe(0)
    expect([...result.failedIds].sort()).toEqual([c1.id, c2.id].sort())
    // 全有或全无：两条都还是 open，第一条的追加也被回滚
    expect(WorldSettingRepository.listOpenConflicts()).toHaveLength(2)
    expect(WorldSettingRepository.getById(first)?.content).toBe('原文一。')
    expect(WorldSettingRepository.getById(second)?.content).toBe('原文二。')
  })

  it('rolls back an appended entry when the conflict status write fails', () => {
    const id = seedEntry({ name: '青云宗', content: '原文。' })
    const conflict = WorldSettingRepository.createConflict({
      chapterNumber: 30, settingId: id, settingName: '青云宗',
      settingContentSnapshot: '原文。', evidence: 'e', statement: '第二条事实。',
    })!

    // 模拟「追加成功、但冲突状态写入失败」：appendDerived 真实写库后抛错。
    const originalAppend = WorldSettingRepository.appendDerived
    vi.spyOn(WorldSettingRepository, 'appendDerived').mockImplementation((...args) => {
      originalAppend.call(WorldSettingRepository, ...args)
      throw new Error('status write failed')
    })

    const result = WorldSettingRepository.resolveAllConflicts('adopted-draft')

    expect(result.resolved).toBe(0)
    expect(result.failedIds).toEqual([conflict.id])
    // 追加的写入已被回滚：原文不变，冲突仍待裁决
    expect(WorldSettingRepository.getById(id)?.content).toBe('原文。')
    expect(WorldSettingRepository.listOpenConflicts()).toHaveLength(1)
  })

  it('reports every conflict as failed and leaves everything untouched when all fail', () => {
    const first = seedEntry({ name: '青云宗', content: '原文一。' })
    const second = seedEntry({ name: '玄阳子', content: '原文二。' })
    const c1 = WorldSettingRepository.createConflict({
      chapterNumber: 30, settingId: first, settingName: '青云宗',
      settingContentSnapshot: '原文一。', evidence: 'e1', statement: '第一条事实。',
    })!
    const c2 = WorldSettingRepository.createConflict({
      chapterNumber: 31, settingId: second, settingName: '玄阳子',
      settingContentSnapshot: '原文二。', evidence: 'e2', statement: '第二条事实。',
    })!

    // 全失败：每一条裁决都抛错。
    vi.spyOn(WorldSettingRepository, 'resolveConflict').mockImplementation(() => {
      throw new Error('boom')
    })

    const result = WorldSettingRepository.resolveAllConflicts('adopted-draft')

    expect(result.resolved).toBe(0)
    expect([...result.failedIds].sort()).toEqual([c1.id, c2.id].sort())
    // 全部回滚：两条都还是 open，内容都没动
    expect(WorldSettingRepository.listOpenConflicts()).toHaveLength(2)
    expect(WorldSettingRepository.getById(first)?.content).toBe('原文一。')
    expect(WorldSettingRepository.getById(second)?.content).toBe('原文二。')
  })
})
