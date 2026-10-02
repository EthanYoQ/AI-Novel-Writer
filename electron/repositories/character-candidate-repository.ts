/**
 * 正文新角色候选的落库。
 *
 * 与角色名单（characters / character_roster_*）**完全分家**：候选不是事实源，
 * 它只是一张「等人裁决的提名单」。作者在角色页点采纳之后，才由渲染进程走
 * 既有的角色卡新增通道（addNamedCharacters + saveAll）真正建档 —— 这里只负责
 * 记住提名、去重、以及记住作者最后一次裁决。
 *
 * 去重口径与角色名单一致：用 characterRosterIdentityKey 折叠大小写与空白，
 * 于是「林青檀」与「林青檀 」「LINQINGTAN」不会被当成三个人。
 */
import { getProjectDb } from '../database'
import { characterRosterIdentityKey } from '../../src/shared/character-roster'
import { normalizeCharacterRole } from '../../src/shared/character-role'
import {
  CHARACTER_CANDIDATE_EVIDENCE_MAX_CHARS,
  normalizeCharacterCandidateState,
  type CharacterCandidateInput,
  type CharacterCandidateRecord,
  type CharacterCandidateState,
  type CharacterCandidateStatus,
} from '../../src/shared/character-candidate'

const MAX_CANDIDATE_NAME_CHARS = 200

function requireChapterNumber(value: unknown): number {
  const parsed = Math.trunc(Number(value))
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('角色候选缺少有效的章节号')
  return parsed
}

function normalizeName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name) throw new Error('角色候选缺少名字')
  return name.slice(0, MAX_CANDIDATE_NAME_CHARS)
}

function normalizeEvidence(value: unknown): string {
  const evidence = typeof value === 'string' ? value.trim() : ''
  return evidence.slice(0, CHARACTER_CANDIDATE_EVIDENCE_MAX_CHARS)
}

/**
 * 状态以 JSON 文本入库。
 *
 * 空状态存**空串**而不是 `'{}'`：老库升级上来的条目、以及模型没写状态的那些提名，
 * 读出来都该是「没有状态」这一件事，`''` 是 SQLite 里最省事也最直白的表达
 * （列默认值也是它，于是迁移不需要回填）。
 */
function serializeState(state: CharacterCandidateState): string {
  return Object.keys(state).length > 0 ? JSON.stringify(state) : ''
}

function parseState(value: unknown, chapterNumber: number): CharacterCandidateState {
  if (typeof value !== 'string' || value.trim() === '') return {}
  try {
    // 收口仍走 shared 的那个函数：库里可能留着旧版本写下的、字段更多或更脏的 JSON。
    return normalizeCharacterCandidateState(JSON.parse(value), chapterNumber)
  } catch {
    return {}
  }
}

function rowToRecord(row: {
  id: number
  name: string
  role: string
  evidence: string
  chapterNumber: number
  currentState: string
  status: string
  createdAt: string
  decidedAt: string
}): CharacterCandidateRecord {
  return {
    id: row.id,
    name: row.name,
    role: normalizeCharacterRole(row.role),
    evidence: row.evidence,
    chapterNumber: row.chapterNumber,
    currentState: parseState(row.currentState, row.chapterNumber),
    status: (row.status === 'adopted' || row.status === 'dismissed' ? row.status : 'pending'),
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
  }
}

export class CharacterCandidateRepository {
  /**
   * 入队一批提名。
   *
   * 幂等：同一个名字（折叠大小写后）只要还有一条待裁决，就不再重复入队 ——
   * 定稿会一章一章地跑，同一个人物连着几章出场是常态，作者不该在待确认队列里
   * 看到一摞同名条目。
   *
   * 已经裁决过（采纳/忽略）的同名提名则**允许再次入队**：那说明作者忽略之后，
   * 后文又把它写了回来，值得再问一次。
   */
  static enqueue(items: readonly CharacterCandidateInput[]): { queued: number; skipped: number } {
    const db = getProjectDb()
    if (!db) throw new Error('项目数据库未打开')

    const pendingNames = new Set(
      (db.prepare("SELECT name FROM character_candidates WHERE status = 'pending'").all() as Array<{ name: string }>)
        .map(row => characterRosterIdentityKey(row.name))
        .filter(Boolean),
    )

    const insert = db.prepare(`
      INSERT INTO character_candidates (name, role, evidence, chapter_number, status, current_state)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `)

    let queued = 0
    let skipped = 0
    const writeAll = db.transaction((rows: readonly CharacterCandidateInput[]) => {
      for (const item of rows) {
        const name = normalizeName(item.name)
        const key = characterRosterIdentityKey(name)
        if (!key || pendingNames.has(key)) {
          skipped += 1
          continue
        }
        pendingNames.add(key)
        const chapterNumber = requireChapterNumber(item.chapterNumber)
        insert.run(
          name,
          normalizeCharacterRole(item.role),
          normalizeEvidence(item.evidence),
          chapterNumber,
          serializeState(normalizeCharacterCandidateState(item.currentState, chapterNumber)),
        )
        queued += 1
      }
    })
    writeAll(items)
    return { queued, skipped }
  }

  /** 待裁决队列，新的在前。 */
  static listPending(): CharacterCandidateRecord[] {
    const db = getProjectDb()
    if (!db) return []
    const rows = db.prepare(`
      SELECT id,
             name,
             role,
             evidence,
             chapter_number AS chapterNumber,
             current_state AS currentState,
             status,
             created_at AS createdAt,
             decided_at AS decidedAt
      FROM character_candidates
      WHERE status = 'pending'
      ORDER BY chapter_number DESC, id DESC
    `).all() as Array<Parameters<typeof rowToRecord>[0]>
    return rows.map(rowToRecord)
  }

  /**
   * 记下作者对若干条提名的裁决。
   *
   * 只动 pending 的那些：采纳与忽略各按一次就定案，重复点不会互相覆盖 ——
   * 这条约束同时挡住了「同一条被采纳了两次」这种脏写。
   */
  static resolve(ids: readonly number[], status: Exclude<CharacterCandidateStatus, 'pending'>): number {
    const db = getProjectDb()
    if (!db) throw new Error('项目数据库未打开')
    const normalizedIds = [...new Set(
      ids.map(id => Math.trunc(Number(id))).filter(id => Number.isSafeInteger(id) && id > 0),
    )]
    if (normalizedIds.length === 0) return 0

    const placeholders = normalizedIds.map(() => '?').join(', ')
    const result = db.prepare(`
      UPDATE character_candidates
      SET status = ?, decided_at = datetime('now')
      WHERE status = 'pending' AND id IN (${placeholders})
    `).run(status, ...normalizedIds)
    return Number(result.changes ?? 0)
  }
}
