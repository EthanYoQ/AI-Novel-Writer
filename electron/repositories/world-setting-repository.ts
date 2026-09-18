/**
 * WorldSettingRepository — 世界观设定条目的读写。
 *
 * 一条设定一行；JSON 列（aliases / tags / related）在进出库时做严格归一，
 * 坏数据一律退化成空数组，绝不把解析异常抛到创作界面上。
 */
import { getProjectDb } from '../database'
import {
  MAX_WORLD_SETTING_NAME_LENGTH,
  WORLD_SETTING_PROVENANCE_FIELDS,
  normalizeWorldSettingCategory,
  normalizeWorldSettingImportance,
  normalizeWorldSettingProvenance,
  normalizeWorldSettingSource,
  normalizeWorldSettingStatus,
} from '../../src/shared/world-setting'
import type {
  ChapterWorldSettingRef,
  WorldSettingConflict,
  WorldSettingConflictDraft,
  WorldSettingConflictStatus,
  WorldSettingDraft,
  WorldSettingEntry,
  WorldSettingFieldProvenance,
  WorldSettingProvenanceField,
  WorldSettingRelation,
  WorldSettingStatus,
} from '../../src/shared/world-setting'

interface WorldSettingRow {
  id: number
  category: string
  name: string
  aliases: string
  summary: string
  content: string
  tags: string
  importance: string
  related: string
  source: string
  status: string
  provenance?: string
  created_at: string
  updated_at: string
}

/**
 * 字段级来源保护规则（先生拍板的保护线）。
 *
 * - `author`（作者本人在界面保存）：**一切来源标记都放行**。作者是唯一裁量者，
 *   「他手写过」这件事不该反过来把他锁在门外 —— 曾经这条规则没区分写入者，
 *   于是界面第二次保存起所有字段都被判为受保护，改动被静默丢弃（先生报的
 *   「文本域只能编辑一次」就是它）。
 * - `auto`（AI / 自动写入）：**只有** derived / legacy 的字段允许被改写；
 *   作者手写（author）与架构拆出（architecture）的内容一律保留。
 * - `append`（定稿后自动更新）：允许追加到任何字段，但**绝不改写** ——
 *   调用方负责把原文与新增内容拼好（见 appendDerived），这里只放行。
 */
type ProvenanceWriteMode = 'author' | 'auto' | 'append'

interface ConflictRow {
  id: number
  chapter_number: number
  setting_id: number
  setting_name: string
  setting_content_snapshot: string
  evidence: string
  statement: string
  status: string
  resolution: string | null
  created_at: string
  resolved_at: string | null
}

function toConflict(row: ConflictRow): WorldSettingConflict {
  const status: WorldSettingConflictStatus = row.status === 'resolved'
    ? 'resolved'
    : row.status === 'ignored'
      ? 'ignored'
      : 'open'
  return {
    id: row.id,
    chapterNumber: row.chapter_number,
    settingId: row.setting_id,
    settingName: row.setting_name ?? '',
    settingContentSnapshot: row.setting_content_snapshot ?? '',
    evidence: row.evidence ?? '',
    statement: row.statement ?? '',
    status,
    ...(row.resolution === 'adopted-draft' || row.resolution === 'kept-entry'
      ? { resolution: row.resolution }
      : {}),
    createdAt: row.created_at ?? '',
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
  }
}

/**
 * 判断某个字段能否被本次写入改动。
 *
 * 没有 provenance 记录 = 旧条目或该字段从未标记 → 按 legacy 处理（允许更新）。
 * 这是刻意的：provenance 是「部分记录」，漏标一个字段不该让内容永远改不动。
 */
function canWriteField(
  mode: ProvenanceWriteMode,
  existing: Partial<Record<WorldSettingProvenanceField, WorldSettingFieldProvenance>>,
  field: WorldSettingProvenanceField,
  nextValue: string,
  previousValue: string,
): boolean {
  // 作者本人在界面上保存：作者写的就是最终事实，来源标记一律不设障。
  if (mode === 'author') return true
  // append 模式只增不改：调用方保证 previousValue 被原样保留，所以这里永远放行。
  if (mode === 'append') return true
  if (nextValue === previousValue) return true
  const kind = existing[field]?.kind
  return kind !== 'author' && kind !== 'architecture'
}

/** 「第 N 章」文案：中英各一份，供追加内容与界面标注复用。 */
export function chapterLabel(chapterNumber: number): string {
  return Number.isInteger(chapterNumber) && chapterNumber > 0 ? `第${chapterNumber}章` : ''
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== 'string' || !value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is string => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function parseRelations(value: unknown): WorldSettingRelation[] {
  if (typeof value !== 'string' || !value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    const relations: WorldSettingRelation[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      const target = typeof record.target === 'string' ? record.target.trim() : ''
      const relation = typeof record.relation === 'string' ? record.relation.trim() : ''
      if (target) relations.push({ target, relation })
    }
    return relations
  } catch {
    return []
  }
}

/** 渲染层与 AI 都可能回传脏数组：统一成去空、去重的字符串数组。 */
function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

function normalizeRelationList(value: unknown): WorldSettingRelation[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: WorldSettingRelation[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const target = typeof record.target === 'string' ? record.target.trim() : ''
    if (!target || seen.has(target)) continue
    seen.add(target)
    result.push({
      target,
      relation: typeof record.relation === 'string' ? record.relation.trim() : '',
    })
  }
  return result
}

function toEntry(row: WorldSettingRow): WorldSettingEntry {
  let parsedProvenance: unknown
  if (typeof row.provenance === 'string' && row.provenance) {
    try {
      parsedProvenance = JSON.parse(row.provenance)
    } catch {
      parsedProvenance = undefined
    }
  }
  const provenance = normalizeWorldSettingProvenance(parsedProvenance)
  return {
    id: row.id,
    category: normalizeWorldSettingCategory(row.category),
    name: row.name,
    aliases: parseStringArray(row.aliases),
    summary: row.summary ?? '',
    content: row.content ?? '',
    tags: parseStringArray(row.tags),
    importance: normalizeWorldSettingImportance(row.importance),
    related: parseRelations(row.related),
    source: normalizeWorldSettingSource(row.source),
    status: normalizeWorldSettingStatus(row.status),
    ...(Object.keys(provenance).length > 0 ? { provenance } : {}),
    createdAt: row.created_at ?? '',
    updatedAt: row.updated_at ?? '',
  }
}

/**
 * 库只在项目打开之后才存在。没项目时抛错，由 controller 统一翻译成人话 ——
 * 各方法自己判空会让「为什么读不到」这件事散落到十几个 return 里。
 */
function projectDb(): NonNullable<ReturnType<typeof getProjectDb>> {
  const db = getProjectDb()
  if (!db) throw new Error('PROJECT_NOT_OPEN')
  return db
}

export class WorldSettingRepository {
  /** 全量条目：按分类、再按名称排序，界面侧不必再排一次。 */
  static getAll(): WorldSettingEntry[] {
    const db = projectDb()
    const rows = db
      .prepare('SELECT * FROM world_settings ORDER BY category ASC, name ASC')
      .all() as WorldSettingRow[]
    return rows.map(toEntry)
  }

  static getById(id: number): WorldSettingEntry | null {
    if (!Number.isInteger(id)) return null
    const db = projectDb()
    const row = db.prepare('SELECT * FROM world_settings WHERE id = ?').get(id) as WorldSettingRow | undefined
    return row ? toEntry(row) : null
  }

  static count(): number {
    const db = projectDb()
    const row = db.prepare('SELECT COUNT(*) AS total FROM world_settings').get() as { total: number } | undefined
    return row?.total ?? 0
  }

  /**
   * 新建或更新。
   *
   * - 带 id：按 id 更新；
   * - 不带 id 但同名条目已存在：并入那一条（作者重复建同一个词条时不该得到两行）；
   * - 名字非法（空 / 超长）：返回 null，由调用方翻译成人话。
   */
  static save(draft: WorldSettingDraft): WorldSettingEntry | null {
    const name = typeof draft?.name === 'string' ? draft.name.trim() : ''
    if (!name || name.length > MAX_WORLD_SETTING_NAME_LENGTH) return null
    // 名字进 SQL 参数没问题，但会出现在提示词与列表中，挡掉控制字符。
    // 这个正则是**有意的安全防护**，no-control-regex 在此属误伤。
    // eslint-disable-next-line no-control-regex -- 有意拦截控制字符，见上一行注释
    if (/[\u0000-\u001f]/.test(name)) return null

    const db = projectDb()
    const category = normalizeWorldSettingCategory(draft.category)
    const importance = normalizeWorldSettingImportance(draft.importance)
    const source = normalizeWorldSettingSource(draft.source)
    const aliases = JSON.stringify(normalizeStringList(draft.aliases))
    const tags = JSON.stringify(normalizeStringList(draft.tags))
    const related = JSON.stringify(normalizeRelationList(draft.related))
    const summary = typeof draft.summary === 'string' ? draft.summary : ''
    const content = typeof draft.content === 'string' ? draft.content : ''

    const targetId = typeof draft.id === 'number' && Number.isInteger(draft.id)
      ? draft.id
      : (db.prepare('SELECT id FROM world_settings WHERE name = ?').get(name) as { id: number } | undefined)?.id

    // 调用方声明的来源；没声明就按「作者手写」处理（界面保存是唯一默认入口）。
    const declared = normalizeWorldSettingProvenance(draft.provenance)

    /**
     * 本次写入是谁发起的 —— 决定字段保护要不要生效。
     *
     * 界面保存（默认）走 `author`：作者改自己的东西永远放行；
     * 自动写入必须显式传 `writeMode: 'auto'` 才受保护线约束。
     */
    const writeMode: ProvenanceWriteMode = draft.writeMode === 'auto' ? 'auto' : 'author'

    if (typeof targetId === 'number') {
      const existingRow = db
        .prepare('SELECT * FROM world_settings WHERE id = ?')
        .get(targetId) as WorldSettingRow | undefined
      const existing = existingRow ? toEntry(existingRow) : undefined

      /**
       * 字段保护：**只对自动写入生效** —— author 写入（作者在界面保存）不设障，
       * 否则作者写过一次的条目就再也改不动（TextArea 里改了、保存后原样返回，
       * 且看不出是「被保护」还是「没保存成功」）。
       *
       * 拦住时保留旧值，并如实告诉调用方哪些字段被保护了 ——
       * 静默丢弃会让「为什么我的改动没生效」变成一个查不出来的谜。
       */
      const blockedFields: WorldSettingProvenanceField[] = []
      const existingProvenance = existing?.provenance ?? {}
      const nextValues: Record<WorldSettingProvenanceField, string> = {
        summary,
        content,
        aliases,
        tags,
        importance: String(draft.importance ?? ''),
      }
      const previousValues: Record<WorldSettingProvenanceField, string> = {
        summary: existing?.summary ?? '',
        content: existing?.content ?? '',
        aliases: JSON.stringify(existing?.aliases ?? []),
        tags: JSON.stringify(existing?.tags ?? []),
        importance: String(existing?.importance ?? ''),
      }
      for (const field of WORLD_SETTING_PROVENANCE_FIELDS) {
        if (!canWriteField(writeMode, existingProvenance, field, nextValues[field], previousValues[field])) {
          blockedFields.push(field)
        }
      }

      const finalSummary = blockedFields.includes('summary') ? (existing?.summary ?? '') : summary
      const finalContent = blockedFields.includes('content') ? (existing?.content ?? '') : content
      const finalAliases = blockedFields.includes('aliases')
        ? JSON.stringify(existing?.aliases ?? [])
        : aliases
      const finalTags = blockedFields.includes('tags') ? JSON.stringify(existing?.tags ?? []) : tags
      const finalImportance = blockedFields.includes('importance')
        ? String(existing?.importance ?? importance)
        : importance

      // 来源标记：被拦下的字段沿用旧标记；其余按「调用方声明 → 没声明就作者手写」记录。
      const provenance: Partial<Record<WorldSettingProvenanceField, WorldSettingFieldProvenance>> = {
        ...existingProvenance,
      }
      for (const field of WORLD_SETTING_PROVENANCE_FIELDS) {
        if (blockedFields.includes(field)) continue
        if (nextValues[field] === previousValues[field]) continue
        const declaredField = declared[field]
        provenance[field] = declaredField ?? { kind: 'author' }
      }

      // 注意：这里**有意不写 status** —— 编辑一条待确认候选不该让它悄悄转正，
      // 转正必须走 setStatus（作者显式采纳）。
      const result = db.prepare(`
        UPDATE world_settings
        SET category = ?, name = ?, aliases = ?, summary = ?, content = ?, tags = ?,
            importance = ?, related = ?, source = ?, provenance = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(
        category, name, finalAliases, finalSummary, finalContent, finalTags,
        finalImportance, related, source, JSON.stringify(provenance), targetId,
      )
      // 目标 id 已被别处删掉时，退回插入，别让作者的编辑静默丢失。
      if (result.changes > 0) return WorldSettingRepository.getById(targetId)
    }

    // 新条目：作者手写的默认记 author；调用方显式声明则用声明值。
    const insertProvenance: Partial<Record<WorldSettingProvenanceField, WorldSettingFieldProvenance>> = {}
    for (const field of WORLD_SETTING_PROVENANCE_FIELDS) {
      const hasValue = field === 'summary'
        ? Boolean(summary.trim())
        : field === 'content'
          ? Boolean(content.trim())
          : field === 'aliases'
            ? aliases !== '[]'
            : field === 'tags'
              ? tags !== '[]'
              : Boolean(String(draft.importance ?? '').trim())
      if (!hasValue) continue
      insertProvenance[field] = declared[field] ?? { kind: 'author' }
    }
    const inserted = db.prepare(`
      INSERT INTO world_settings (category, name, aliases, summary, content, tags, importance, related, source, status, provenance)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      category, name, aliases, summary, content, tags, importance, related, source,
      // 作者在界面上手写的新条目即已确认；AI 候选要显式传 pending。
      normalizeWorldSettingStatus(draft.status ?? 'confirmed'),
      JSON.stringify(insertProvenance),
    )
    return WorldSettingRepository.getById(Number(inserted.lastInsertRowid))
  }

  /**
   * 定稿后处理专用：把本章正文里的**新进展追加**到条目上（先生要的「落袋」）。
   *
   * 为什么单独一个方法，而不是复用 save：
   * 1. save 是**覆盖式**语义 —— 用它做自动更新，稍有不慎就把作者原文换掉；
   * 2. 这里强制**追加**：原内容一个字都不动，新增内容以「（第 N 章：…）」的形式补在后面。
   *    这样即使 AI 判断有偏差，作者要做的也只是删掉一句话，而不是复原整段。
   * 3. 追加是「只增不改」，因此对 author 字段也放行 —— 这正是先生要的保护线。
   *
   * @param chapterNumber 证据来源章节，会写进 provenance 供追溯
   */
  static appendDerived(
    id: number,
    update: { content?: string; summary?: string },
    chapterNumber: number,
  ): { entry: WorldSettingEntry; appended: boolean } | null {
    if (!Number.isInteger(id)) return null
    const db = projectDb()
    const row = db.prepare('SELECT * FROM world_settings WHERE id = ?').get(id) as WorldSettingRow | undefined
    if (!row) return null
    const existing = toEntry(row)
    const label = chapterLabel(chapterNumber)

    const appendedContent = typeof update.content === 'string' ? update.content.trim() : ''
    const appendedSummary = typeof update.summary === 'string' ? update.summary.trim() : ''
    // 两段都空 = 没有可落袋的内容，直接原样返回（不制造无意义的 updated_at 变动）。
    if (!appendedContent && !appendedSummary) return { entry: existing, appended: false }

    const joinBlock = (previous: string, addition: string): string => {
      if (!addition) return previous
      const line = label ? `（${label}：${addition}）` : `（${addition}）`
      // 已经包含过同一句就不重复追加（同一章重跑、或作者手动补过）。
      if (previous.includes(line)) return previous
      return previous ? `${previous}\n${line}` : line
    }

    const nextContent = joinBlock(existing.content, appendedContent)
    const nextSummary = joinBlock(existing.summary, appendedSummary)
    const appended = nextContent !== existing.content || nextSummary !== existing.summary
    if (!appended) return { entry: existing, appended: false }

    const provenance: Partial<Record<WorldSettingProvenanceField, WorldSettingFieldProvenance>> = {
      ...(existing.provenance ?? {}),
    }
    // 追加不降低保护级别：author / architecture 字段被追加后仍是受保护字段，
    // 否则一次派生追加会解除保护，让后续 auto save 获准覆盖作者原文（review P2-1）。
    const preservesProtection = (field: WorldSettingFieldProvenance | undefined): boolean => (
      field?.kind === 'author' || field?.kind === 'architecture'
    )
    if (nextContent !== existing.content && !preservesProtection(provenance.content)) {
      provenance.content = { kind: 'derived', chapterNumber }
    }
    if (nextSummary !== existing.summary && !preservesProtection(provenance.summary)) {
      provenance.summary = { kind: 'derived', chapterNumber }
    }

    db.prepare(`
      UPDATE world_settings
      SET content = ?, summary = ?, provenance = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(nextContent, nextSummary, JSON.stringify(provenance), id)
    const entry = WorldSettingRepository.getById(id)
    return entry ? { entry, appended: true } : null
  }

  /**
   * 采纳（转正）或退回待确认。
   *
   * 「忽略」候选直接走 delete —— AI 猜错的东西没有留在库里的理由。
   */
  static setStatus(id: number, status: WorldSettingStatus): WorldSettingEntry | null {
    if (!Number.isInteger(id)) return null
    const db = projectDb()
    const result = db.prepare(`
      UPDATE world_settings SET status = ?, updated_at = datetime('now') WHERE id = ?
    `).run(normalizeWorldSettingStatus(status), id)
    return result.changes > 0 ? WorldSettingRepository.getById(id) : null
  }

  static delete(id: number): boolean {
    if (!Number.isInteger(id)) return false
    const db = projectDb()
    const result = db.prepare('DELETE FROM world_settings WHERE id = ?').run(id)
    return result.changes > 0
  }

  /** 供 AI 取用：只给 id / 名称 / 分类 / 摘要，正文按需再读。 */
  static listBrief(): Array<Pick<WorldSettingEntry, 'id' | 'name' | 'category' | 'summary' | 'aliases'>> {
    const db = projectDb()
    const rows = db
      .prepare('SELECT id, category, name, aliases, summary FROM world_settings ORDER BY category ASC, name ASC')
      .all() as Array<Pick<WorldSettingRow, 'id' | 'category' | 'name' | 'aliases' | 'summary'>>
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      category: normalizeWorldSettingCategory(row.category),
      summary: row.summary ?? '',
      aliases: parseStringArray(row.aliases),
    }))
  }

  // ===== 章节引用 =====
  // 先生定的路线：写某一章时只带「明确引用过」的设定，绝不按章全量注入。

  /** 某章引用了哪些设定。 */
  static listChapterRefs(chapterNumber: number): ChapterWorldSettingRef[] {
    if (!Number.isInteger(chapterNumber)) return []
    const db = projectDb()
    const rows = db.prepare(`
      SELECT chapter_number, setting_id, source
      FROM chapter_world_settings
      WHERE chapter_number = ?
      ORDER BY setting_id ASC
    `).all(chapterNumber) as Array<{ chapter_number: number; setting_id: number; source: string }>
    return rows.map(row => ({
      chapterNumber: row.chapter_number,
      settingId: row.setting_id,
      source: row.source === 'ai' ? 'ai' as const : 'manual' as const,
    }))
  }

  /** 记录一条引用；已存在则原样保留（复合主键去重，重复 @ 不会叠加）。 */
  static addChapterRef(
    chapterNumber: number,
    settingId: number,
    source: 'manual' | 'ai' = 'manual',
  ): boolean {
    if (!Number.isInteger(chapterNumber) || !Number.isInteger(settingId)) return false
    // 引用必须指向真实存在的条目，避免留下指向虚空的行
    if (!WorldSettingRepository.getById(settingId)) return false
    const db = projectDb()
    db.prepare(`
      INSERT OR IGNORE INTO chapter_world_settings (chapter_number, setting_id, source)
      VALUES (?, ?, ?)
    `).run(chapterNumber, settingId, source === 'ai' ? 'ai' : 'manual')
    // 无论新插还是本来就有这条引用，对调用方而言都是「已经在里面了」
    return true
  }

  static removeChapterRef(chapterNumber: number, settingId: number): boolean {
    if (!Number.isInteger(chapterNumber) || !Number.isInteger(settingId)) return false
    const db = projectDb()
    const result = db.prepare(`
      DELETE FROM chapter_world_settings WHERE chapter_number = ? AND setting_id = ?
    `).run(chapterNumber, settingId)
    return result.changes > 0
  }

  // ===== 冲突裁决队列 =====
  //
  // 定稿后 AI 报告「正文与设定直接矛盾」，但**不自动改** —— 它不知道该听哪边。
  // 这里只落记录，让作者在界面上并排看到「正文说了什么 / 条目原写什么」后一键裁决。

  /**
   * 登记一条冲突。同一条目在同一章重复报同一冲突时不重复插行
   * （同一章重跑后处理、或作者手改后又跑一次都会走到这里）。
   */
  static createConflict(draft: WorldSettingConflictDraft): WorldSettingConflict | null {
    if (!Number.isInteger(draft.chapterNumber) || !Number.isInteger(draft.settingId)) return null
    const statement = typeof draft.statement === 'string' ? draft.statement.trim() : ''
    const evidence = typeof draft.evidence === 'string' ? draft.evidence.trim() : ''
    if (!statement || !evidence) return null
    const db = projectDb()
    const existing = db.prepare(`
      SELECT id FROM world_setting_conflicts
      WHERE chapter_number = ? AND setting_id = ? AND statement = ? AND status = 'open'
    `).get(draft.chapterNumber, draft.settingId, statement) as { id: number } | undefined
    if (existing) return WorldSettingRepository.getConflict(existing.id)

    const result = db.prepare(`
      INSERT INTO world_setting_conflicts
        (chapter_number, setting_id, setting_name, setting_content_snapshot, evidence, statement, status)
      VALUES (?, ?, ?, ?, ?, ?, 'open')
    `).run(
      draft.chapterNumber,
      draft.settingId,
      typeof draft.settingName === 'string' ? draft.settingName.trim() : '',
      typeof draft.settingContentSnapshot === 'string' ? draft.settingContentSnapshot : '',
      evidence,
      statement,
    )
    return WorldSettingRepository.getConflict(Number(result.lastInsertRowid))
  }

  static getConflict(id: number): WorldSettingConflict | null {
    if (!Number.isInteger(id)) return null
    const db = projectDb()
    const row = db.prepare('SELECT * FROM world_setting_conflicts WHERE id = ?').get(id) as ConflictRow | undefined
    return row ? toConflict(row) : null
  }

  /** 未裁决的冲突，最新的排前面（作者一打开就看最近产生的）。 */
  static listOpenConflicts(): WorldSettingConflict[] {
    const db = projectDb()
    const rows = db.prepare(`
      SELECT * FROM world_setting_conflicts
      WHERE status = 'open'
      ORDER BY chapter_number DESC, id DESC
    `).all() as ConflictRow[]
    return rows.map(toConflict)
  }

  /**
   * 裁决一条冲突。
   *
   * - \`adopted-draft\`：作者认可正文 → 把这条已确认事实**追加**进条目
   *   （仍然走 appendDerived 的只增不改，连裁决都不改写作者原文）；
   * - \`kept-entry\`：作者认定条目原文才对 → 只标记已解决，不动任何内容。
   *
   * 两种情况都不删记录：作者日后回看「这一章当初怎么裁的」有据可查。
   */
  static resolveConflict(
    id: number,
    resolution: 'adopted-draft' | 'kept-entry',
  ): { conflict: WorldSettingConflict; entry: WorldSettingEntry | null } | null {
    if (!Number.isInteger(id)) return null
    const db = projectDb()
    const row = db.prepare('SELECT * FROM world_setting_conflicts WHERE id = ?').get(id) as ConflictRow | undefined
    if (!row) return null
    const conflict = toConflict(row)
    if (conflict.status !== 'open') return { conflict, entry: null }

    let entry: WorldSettingEntry | null = null
    if (resolution === 'adopted-draft') {
      // 采纳正文 = 把正文这条已确认事实追加进条目。追加式保证原文不丢，
      // 也保证这次裁决不会把作者手写的内容换掉。
      const appended = WorldSettingRepository.appendDerived(
        conflict.settingId,
        { content: conflict.statement },
        conflict.chapterNumber,
      )
      entry = appended?.entry ?? WorldSettingRepository.getById(conflict.settingId)
    }

    db.prepare(`
      UPDATE world_setting_conflicts
      SET status = 'resolved', resolution = ?, resolved_at = datetime('now')
      WHERE id = ? AND status = 'open'
    `).run(resolution, id)
    return { conflict: WorldSettingRepository.getConflict(id)!, entry }
  }

  /** 忽略（作者判断这不是真冲突，或暂时不想处理）。只改状态，不动条目。 */
  static ignoreConflict(id: number): WorldSettingConflict | null {
    if (!Number.isInteger(id)) return null
    const db = projectDb()
    const result = db.prepare(`
      UPDATE world_setting_conflicts
      SET status = 'ignored', resolved_at = datetime('now')
      WHERE id = ? AND status = 'open'
    `).run(id)
    return result.changes > 0 ? WorldSettingRepository.getConflict(id) : null
  }

  /**
   * 一次裁决全部未决冲突（先生要的「一条条看很烦」的出口）。
   *
   * 全有或全无：任何一条失败都让整个事务回滚，绝不留下「一半采纳了」的
   * 难收拾状态。返回的 failedIds 要么是空（全部成功），要么是整批（全部回滚）。
   * 单条裁决里「先追加正文、后写冲突状态」的中间写入，在回滚时一并撤销。
   */
  static resolveAllConflicts(
    resolution: 'adopted-draft' | 'kept-entry',
  ): { resolved: number; failedIds: number[] } {
    const db = projectDb()
    const open = WorldSettingRepository.listOpenConflicts()
    if (open.length === 0) return { resolved: 0, failedIds: [] }
    const run = db.transaction(() => {
      for (const conflict of open) {
        const result = WorldSettingRepository.resolveConflict(conflict.id, resolution)
        if (!result) {
          throw new Error(`conflict ${conflict.id} could not be resolved`)
        }
      }
    })
    try {
      run()
      return { resolved: open.length, failedIds: [] }
    } catch {
      return { resolved: 0, failedIds: open.map(conflict => conflict.id) }
    }
  }
}

/** 供其它模块构造章节引用键（例如诊断日志）。 */
export function chapterRefKey(chapterNumber: number, settingId: number): string {
  return `${chapterNumber}:${settingId}`
}
