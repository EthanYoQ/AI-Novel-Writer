/**
 * StickyNoteRepository / StickyDrawRepository / StickyCandidateRepository
 *
 * 便利贴三张表一体，因此同处一个文件（同 world-setting-repository 管多表的分法）。
 *
 * ── 一条必须说清的边界 ────────────────────────────────────────────────────
 * 本文件里**没有**任何供 AI 创作链路调用的读取接口，也不该有。
 * 写稿上下文（chapter-materials.ts / generate-draft.command.ts）、定稿后处理、
 * 助手工具一处都不 import 这里 —— 契约测试 src/shared/__tests__/sticky-isolation.test.ts
 * 会去那些文件里搜 "sticky"，搜到就红。
 */
import { randomUUID } from 'node:crypto'

import type {
  StickyCandidate,
  StickyCandidateStatus,
  StickyDraw,
  StickyDrawRecordRequest,
  StickyFolder,
  StickyIdeaAppendRequest,
  StickyMentionRef,
  StickyNote,
} from '../../src/shared/sticky-note'
import {
  STICKY_DRAW_DEFAULT_COUNT,
  STICKY_DRAW_MAX_COUNT,
  STICKY_TITLE_MAX_CHARS,
  appendStickyBlock,
  clampStickyIdea,
  composeStickyIdeaBlock,
} from '../../src/shared/sticky-note'
import { getProjectDb } from '../database'

interface StickyNoteRow {
  note_id: string
  title: string
  body: string
  folder_id: string | null
  created_at: string
  updated_at: string
}

interface StickyFolderRow {
  folder_id: string
  name: string
  created_at: string
}

interface StickyDrawRow {
  draw_id: string
  include_premise: number
  include_characters: number
  include_worldbuilding: number
  include_synopsis: number
  mentions: string
  idea: string
  requested_count: number
  created_at: string
}

interface StickyCandidateRow {
  candidate_id: string
  draw_id: string
  content: string
  ordinal: number
  status: StickyCandidateStatus
  note_id: string | null
  created_at: string
  used_at: string | null
}

function requireDb() {
  const db = getProjectDb()
  if (!db) throw new Error('项目数据库未打开')
  return db
}

function assertId(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 160) throw new Error(`${label}无效`)
  return normalized
}

function toNote(row: StickyNoteRow): StickyNote {
  return {
    noteId: row.note_id,
    title: row.title,
    body: row.body,
    folderId: row.folder_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toFolder(row: StickyFolderRow): StickyFolder {
  return {
    folderId: row.folder_id,
    name: row.name,
    createdAt: row.created_at,
  }
}

function toDraw(row: StickyDrawRow): StickyDraw {
  return {
    drawId: row.draw_id,
    includePremise: row.include_premise === 1,
    includeCharacters: row.include_characters === 1,
    includeWorldbuilding: row.include_worldbuilding === 1,
    includeSynopsis: row.include_synopsis === 1,
    mentions: parseMentions(row.mentions),
    idea: row.idea,
    requestedCount: row.requested_count,
    createdAt: row.created_at,
  }
}

function toCandidate(row: StickyCandidateRow): StickyCandidate {
  return {
    candidateId: row.candidate_id,
    drawId: row.draw_id,
    content: row.content,
    ordinal: row.ordinal,
    status: row.status,
    noteId: row.note_id,
    createdAt: row.created_at,
    usedAt: row.used_at,
  }
}

/**
 * 引用项的解析**绝不抛错**。
 *
 * 存档字段是给人看的追溯信息，不是事实源：一行写坏的 JSON 不该让整箱待选
 * 点子打不开。坏行按「没有引用」处理，作者照样能把卡找回去。
 */
function parseMentions(raw: string): StickyMentionRef[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item) => {
      if (typeof item !== 'object' || item === null) return []
      const record = item as { type?: unknown; name?: unknown }
      const type = record.type
      const name = typeof record.name === 'string' ? record.name.trim() : ''
      if (!name) return []
      if (type !== 'character' && type !== 'world-setting' && type !== 'blueprint') return []
      return [{ type, name }]
    })
  } catch {
    return []
  }
}

function normalizeMentions(mentions: readonly StickyMentionRef[]): StickyMentionRef[] {
  const seen = new Set<string>()
  const result: StickyMentionRef[] = []
  for (const mention of mentions) {
    const name = mention.name.trim()
    if (!name) continue
    const key = `${mention.type}\u0000${name}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ type: mention.type, name })
  }
  return result
}

/**
 * 校验文件夹身份并归一（null = 根下）。
 *
 * 目标不存在时**抛错**，绝不静默退回根下 —— 那样作者会以为拖成功了，
 * 回头在根下翻半天找不到本子。
 */
function assertFolder(
  db: ReturnType<typeof requireDb>,
  folderId: string | null | undefined,
): string | null {
  if (!folderId) return null
  const id = assertId(folderId, '文件夹身份')
  const exists = db.prepare('SELECT 1 FROM sticky_folders WHERE folder_id = ?').get(id)
  if (!exists) throw new Error('文件夹不存在或已被删除')
  return id
}

function readNote(noteId: string): StickyNoteRow {
  const row = requireDb().prepare(`
    SELECT * FROM sticky_notes WHERE note_id = ?
  `).get(noteId) as StickyNoteRow | undefined
  if (!row) throw new Error('便利贴不存在或已被删除')
  return row
}

export class StickyNoteRepository {
  /** 全部便利贴，按创建时间正序 —— 本子按写下次序摊开，不因改动而跳动。 */
  static list(): StickyNote[] {
    const rows = requireDb().prepare(`
      SELECT * FROM sticky_notes ORDER BY created_at ASC, rowid ASC
    `).all() as StickyNoteRow[]
    return rows.map(toNote)
  }

  static getById(noteId: string): StickyNote | null {
    const row = requireDb().prepare(`
      SELECT * FROM sticky_notes WHERE note_id = ?
    `).get(assertId(noteId, '便利贴身份')) as StickyNoteRow | undefined
    return row ? toNote(row) : null
  }

  /**
   * 新建便利贴。
   *
   * @param folderId 放进哪个文件夹；null / 缺省 = 根下。
   *   先生站在哪个文件夹里点新建，新本子就落在那儿。
   */
  static create(title = '', folderId: string | null = null): StickyNote {
    const db = requireDb()
    const noteId = randomUUID()
    const folder = assertFolder(db, folderId)
    db.prepare(`
      INSERT INTO sticky_notes (note_id, title, body, folder_id) VALUES (?, ?, '', ?)
    `).run(noteId, title.trim().slice(0, STICKY_TITLE_MAX_CHARS), folder)
    return toNote(readNote(noteId))
  }

  /**
   * 把便利贴挪进某个文件夹（`folderId = null` 即挪回根下）。
   *
   * 先生要的「拖入文件夹」。目标文件夹不存在时**抛错而不是静默落到根下** ——
   * 静默会让作者以为拖成功了，回头在根下找不到本子。
   */
  static move(noteId: string, folderId: string | null): StickyNote {
    const db = requireDb()
    const id = assertId(noteId, '便利贴身份')
    readNote(id)
    const folder = assertFolder(db, folderId)
    db.prepare(`
      UPDATE sticky_notes SET folder_id = ?, updated_at = datetime('now') WHERE note_id = ?
    `).run(folder, id)
    return toNote(readNote(id))
  }

  static rename(noteId: string, title: string): StickyNote {
    const id = assertId(noteId, '便利贴身份')
    const db = requireDb()
    readNote(id)
    db.prepare(`
      UPDATE sticky_notes SET title = ?, updated_at = datetime('now') WHERE note_id = ?
    `).run(title.trim().slice(0, STICKY_TITLE_MAX_CHARS), id)
    return toNote(readNote(id))
  }

  /** 编辑器整份覆盖保存。 */
  static saveBody(noteId: string, body: string): StickyNote {
    const id = assertId(noteId, '便利贴身份')
    const db = requireDb()
    readNote(id)
    db.prepare(`
      UPDATE sticky_notes SET body = ?, updated_at = datetime('now') WHERE note_id = ?
    `).run(body, id)
    return toNote(readNote(id))
  }

  /**
   * 按给定次序把一个或多个点子追加进正文。
   *
   * 次序就是数组次序 —— 抽卡结果面板传进来时按卡片**从左到右**排好，
   * 这里不再排序，也不去重（同一段想法想留两遍是作者的自由）。
   *
   * better-sqlite3 是同步的：读-拼接-写整段在一个同步调用里跑完，
   * 中途不会插进另一个写者，因此不需要额外的乐观锁。
   * 数组为空时原样返回，不刷新 updated_at —— 空动作不该让便利贴跳到侧栏顶上。
   */
  static appendIdeas(noteId: string, requests: readonly StickyIdeaAppendRequest[]): StickyNote {
    const id = assertId(noteId, '便利贴身份')
    const db = requireDb()
    const row = readNote(id)

    let body = row.body
    let appended = false
    for (const request of requests) {
      const at = request.at ?? new Date().toISOString()
      const block = composeStickyIdeaBlock({
        idea: request.idea,
        at,
        mentions: normalizeMentions(request.mentions),
      })
      if (!block) continue
      body = appendStickyBlock(body, block)
      appended = true
    }
    if (!appended) return toNote(row)

    db.prepare(`
      UPDATE sticky_notes SET body = ?, updated_at = datetime('now') WHERE note_id = ?
    `).run(body, id)
    return toNote(readNote(id))
  }

  /**
   * 删除便利贴。不可撤销（先生 2026-09-20 批准：二次确认，不做回收站）。
   *
   * 指向它的已用候选把 note_id 清空 —— status 保持 used，于是它**不会**
   * 因为便利贴被删而重新冒回待选箱；只是留下了「曾用过、用在哪张上已不可考」
   * 的痕迹，这比留一个指向幽灵的悬空 id 诚实。
   */
  static remove(noteId: string): void {
    const id = assertId(noteId, '便利贴身份')
    const db = requireDb()
    const run = db.transaction(() => {
      readNote(id)
      db.prepare('UPDATE sticky_candidates SET note_id = NULL WHERE note_id = ?').run(id)
      db.prepare('DELETE FROM sticky_notes WHERE note_id = ?').run(id)
    })
    run()
  }
}

export class StickyDrawRepository {
  static record(request: StickyDrawRecordRequest): StickyDraw {
    const db = requireDb()
    const requested = Number.isFinite(request.requestedCount)
      ? Math.floor(request.requestedCount)
      : STICKY_DRAW_DEFAULT_COUNT
    const requestedCount = Math.min(Math.max(requested, 1), STICKY_DRAW_MAX_COUNT)
    const drawId = randomUUID()
    db.prepare(`
      INSERT INTO sticky_draws (
        draw_id, include_premise, include_characters, include_worldbuilding,
        include_synopsis, mentions, idea, requested_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      drawId,
      request.includePremise ? 1 : 0,
      request.includeCharacters ? 1 : 0,
      request.includeWorldbuilding ? 1 : 0,
      request.includeSynopsis ? 1 : 0,
      JSON.stringify(normalizeMentions(request.mentions)),
      request.idea.trim(),
      requestedCount,
    )
    return toDraw(db.prepare(`
      SELECT * FROM sticky_draws WHERE draw_id = ?
    `).get(drawId) as StickyDrawRow)
  }

  static getById(drawId: string): StickyDraw | null {
    const row = requireDb().prepare(`
      SELECT * FROM sticky_draws WHERE draw_id = ?
    `).get(assertId(drawId, '抽卡身份')) as StickyDrawRow | undefined
    return row ? toDraw(row) : null
  }
}

export class StickyCandidateRepository {
  /** 待选箱内容：只列还在箱里的，按抽卡次序排。 */
  static listPending(): StickyCandidate[] {
    const rows = requireDb().prepare(`
      SELECT * FROM sticky_candidates
      WHERE status = 'pending'
      ORDER BY created_at ASC, ordinal ASC
    `).all() as StickyCandidateRow[]
    return rows.map(toCandidate)
  }

  static countPending(): number {
    const row = requireDb().prepare(`
      SELECT COUNT(*) AS total FROM sticky_candidates WHERE status = 'pending'
    `).get() as { total: number }
    return row.total
  }

  /**
   * 把一次抽卡里**没被选中**的点子收进待选箱。
   *
   * ordinal 取数组下标 +1，也就是卡片在结果面板里从左到右的次序 ——
   * 先生日后打开箱子，卡片的排列与当时看到的一致。
   */
  static recordMany(drawId: string, contents: readonly string[]): StickyCandidate[] {
    const id = assertId(drawId, '抽卡身份')
    const db = requireDb()
    const draw = StickyDrawRepository.getById(id)
    if (!draw) throw new Error('抽卡记录不存在，已拒绝收进待选箱')

    const insert = db.prepare(`
      INSERT INTO sticky_candidates (candidate_id, draw_id, content, ordinal)
      VALUES (?, ?, ?, ?)
    `)
    const created: string[] = []
    const run = db.transaction(() => {
      contents.forEach((content, index) => {
        const idea = clampStickyIdea(content)
        if (!idea) return
        const candidateId = randomUUID()
        insert.run(candidateId, id, idea, index + 1)
        created.push(candidateId)
      })
    })
    run()
    if (created.length === 0) return []

    const placeholders = created.map(() => '?').join(', ')
    const rows = db.prepare(`
      SELECT * FROM sticky_candidates WHERE candidate_id IN (${placeholders})
      ORDER BY ordinal ASC
    `).all(...created) as StickyCandidateRow[]
    return rows.map(toCandidate)
  }

  /**
   * 从待选箱找回一条点子：把它追加进给定便利贴，并标记为已用。
   *
   * 两件事必须在同一个事务里 —— 追加成功而标记失败会让它同时「在箱里」和
   * 「已经写进本子」，下次找回就多出一段重复；反过来则直接丢一条。
   *
   * 来源行用**找回时刻**，引用项取当初那次抽卡的存档 —— 即便抽卡已经过去
   * 两周，找回来的这条仍然带着「当时参考了什么」。
   */
  static useIntoNote(candidateId: string, noteId: string): { note: StickyNote; candidate: StickyCandidate } {
    const id = assertId(candidateId, '待选点子身份')
    const target = assertId(noteId, '便利贴身份')
    const db = requireDb()

    /**
     * 三件事（读候选 → 追加进正文 → 标记已用）包在同一个事务里。
     *
     * 光靠「better-sqlite3 是同步的、中间插不进别的写者」不足以自保：
     * 第二条 UPDATE 万一自己失败（磁盘满、触发器报错），前一步已经落盘的追加
     * 就留下来了 —— 这条点子会同时「还在箱里」和「已经写进本子」，下次找回
     * 就多出一段重复。回滚整组才是对的。
     */
    const run = db.transaction(() => {
      const row = db.prepare(`
        SELECT * FROM sticky_candidates WHERE candidate_id = ? AND status = 'pending'
      `).get(id) as StickyCandidateRow | undefined
      if (!row) throw new Error('这条点子已不在待选箱里')

      const draw = StickyDrawRepository.getById(row.draw_id)
      const note = StickyNoteRepository.appendIdeas(target, [{
        idea: row.content,
        drawId: row.draw_id,
        mentions: draw?.mentions ?? [],
        at: new Date().toISOString(),
      }])

      // 用 changes 复核一次：并发下（同一张卡被两处同时找回）只有一方能改到这一行。
      const marked = db.prepare(`
        UPDATE sticky_candidates
        SET status = 'used', note_id = ?, used_at = datetime('now')
        WHERE candidate_id = ? AND status = 'pending'
      `).run(target, id)
      if (marked.changes !== 1) throw new Error('这条点子已不在待选箱里')

      const updated = db.prepare(`
        SELECT * FROM sticky_candidates WHERE candidate_id = ?
      `).get(id) as StickyCandidateRow
      return { note, candidate: toCandidate(updated) }
    })

    return run()
  }

  /**
   * 清空待选箱 —— 物理删除，清完不再找回。
   *
   * 先生 2026-09-20 明确批准：「一旦用户使用了，就自然不找回了」。
   * 这是全便利贴功能里唯一一处硬删除，因此界面上必须二次确认、
   * 并写明不可撤销（不许做成「顺手一点」）。
   */
  static clear(): number {
    const result = requireDb().prepare(`
      DELETE FROM sticky_candidates WHERE status = 'pending'
    `).run()
    return result.changes
  }
}

/** 便利贴文件夹。只做一层 —— 侧栏窄，套两层反而是折磨。 */
export class StickyFolderRepository {
  static list(): StickyFolder[] {
    const rows = requireDb().prepare(`
      SELECT * FROM sticky_folders ORDER BY created_at ASC, rowid ASC
    `).all() as StickyFolderRow[]
    return rows.map(toFolder)
  }

  static create(name = ''): StickyFolder {
    const db = requireDb()
    const folderId = randomUUID()
    db.prepare(`
      INSERT INTO sticky_folders (folder_id, name) VALUES (?, ?)
    `).run(folderId, name.trim().slice(0, STICKY_TITLE_MAX_CHARS))
    return toFolder(db.prepare(`
      SELECT * FROM sticky_folders WHERE folder_id = ?
    `).get(folderId) as StickyFolderRow)
  }

  static rename(folderId: string, name: string): StickyFolder {
    const db = requireDb()
    const id = assertId(folderId, '文件夹身份')
    const exists = db.prepare('SELECT 1 FROM sticky_folders WHERE folder_id = ?').get(id)
    if (!exists) throw new Error('文件夹不存在或已被删除')
    db.prepare(`
      UPDATE sticky_folders SET name = ? WHERE folder_id = ?
    `).run(name.trim().slice(0, STICKY_TITLE_MAX_CHARS), id)
    return toFolder(db.prepare(`
      SELECT * FROM sticky_folders WHERE folder_id = ?
    `).get(id) as StickyFolderRow)
  }

  /**
   * 删除文件夹。
   *
   * **里面的便利贴一条都不删** —— 它们回到根下，与「没分过类」的本子并列。
   * 文件夹是收纳工具，不是容器；顺手毁掉作者写的东西是不可接受的。
   * 两件事在同一个事务里，免得出现「夹子没了、本子还指着一个幽灵」。
   */
  static remove(folderId: string): void {
    const db = requireDb()
    const id = assertId(folderId, '文件夹身份')
    const run = db.transaction(() => {
      const exists = db.prepare('SELECT 1 FROM sticky_folders WHERE folder_id = ?').get(id)
      if (!exists) throw new Error('文件夹不存在或已被删除')
      db.prepare('UPDATE sticky_notes SET folder_id = NULL WHERE folder_id = ?').run(id)
      db.prepare('DELETE FROM sticky_folders WHERE folder_id = ?').run(id)
    })
    run()
  }
}
