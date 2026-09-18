/**
 * WorldSettingCategoryRepository — 世界观设定分类的读写。
 *
 * 分类**不是封闭枚举**：内置八条由 database.ts 初始化（builtin = 1），作者可自建。
 * key 是稳定标识（条目按它归类），名字与说明随时可改 —— 改名不会动到任何条目。
 *
 * 两道防护：
 *   · 内置分类不可删（删了会让整个侧栏结构塌掉）；
 *   · 仍有条目引用的分类不可删（否则那些条目变成找不到家的孤儿）。
 */
import crypto from 'node:crypto'

import { getProjectDb } from '../database'
import {
  CUSTOM_CATEGORY_KEY_PREFIX,
  MAX_CATEGORY_NAME_LENGTH,
  builtinCategoryRecords,
} from '../../src/shared/world-setting'
import type {
  WorldSettingCategoryDraft,
  WorldSettingCategoryRecord,
} from '../../src/shared/world-setting'

interface CategoryRow {
  key: string
  name_zh: string
  name_en: string
  description_zh: string
  description_en: string
  builtin: number
  sort_order: number
}

function projectDb(): NonNullable<ReturnType<typeof getProjectDb>> {
  const db = getProjectDb()
  if (!db) throw new Error('PROJECT_NOT_OPEN')
  return db
}

function toRecord(row: CategoryRow): WorldSettingCategoryRecord {
  return {
    key: row.key,
    zhCN: row.name_zh || row.key,
    enUS: row.name_en || row.name_zh || row.key,
    descriptionZhCN: row.description_zh ?? '',
    descriptionEnUS: row.description_en ?? '',
    builtin: row.builtin === 1,
    sortOrder: row.sort_order,
  }
}

function cleanName(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_CATEGORY_NAME_LENGTH) : ''
}

export class WorldSettingCategoryRepository {
  /** 内置分类写入（幂等）。database.ts 初始化时用，这里也留一个兜底入口。 */
  static ensureBuiltins(): void {
    const db = projectDb()
    const insert = db.prepare(`
      INSERT OR IGNORE INTO world_setting_categories
        (key, name_zh, name_en, description_zh, description_en, builtin, sort_order)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `)
    for (const category of builtinCategoryRecords()) {
      insert.run(
        category.key,
        category.zhCN,
        category.enUS,
        category.descriptionZhCN,
        category.descriptionEnUS,
        category.sortOrder,
      )
    }
  }

  /** 全部分类：内置在前、自建在后（sort_order 决定顺序）。 */
  static list(): WorldSettingCategoryRecord[] {
    const db = projectDb()
    // 兜底：分类表为空（极老的库或直接拷来的 db）时先补内置，别让侧栏空空如也。
    const total = (db.prepare('SELECT COUNT(*) AS total FROM world_setting_categories').get() as { total: number }).total
    if (total === 0) WorldSettingCategoryRepository.ensureBuiltins()
    const rows = db
      .prepare('SELECT * FROM world_setting_categories ORDER BY sort_order ASC, key ASC')
      .all() as CategoryRow[]
    return rows.map(toRecord)
  }

  static getByKey(key: string): WorldSettingCategoryRecord | null {
    if (!key) return null
    const db = projectDb()
    const row = db.prepare('SELECT * FROM world_setting_categories WHERE key = ?').get(key) as CategoryRow | undefined
    return row ? toRecord(row) : null
  }

  /**
   * 新建自建分类。
   *
   * key 由主进程生成（`cat_` + 8 位随机），作者只给名字与说明 ——
   * 让作者填 key 既没必要，也会因为中文名直接当 key 而埋下改名的隐患。
   * 中文名重复时直接返回已有那条：作者多半是忘了自己建过。
   */
  static create(draft: WorldSettingCategoryDraft): WorldSettingCategoryRecord | null {
    const nameZh = cleanName(draft?.zhCN)
    if (!nameZh) return null
    const db = projectDb()

    const existing = db
      .prepare('SELECT key FROM world_setting_categories WHERE name_zh = ?')
      .get(nameZh) as { key: string } | undefined
    if (existing) return WorldSettingCategoryRepository.getByKey(existing.key)

    const maxOrder = (db.prepare('SELECT MAX(sort_order) AS value FROM world_setting_categories').get() as { value: number | null }).value
    const key = `${CUSTOM_CATEGORY_KEY_PREFIX}${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`
    db.prepare(`
      INSERT INTO world_setting_categories
        (key, name_zh, name_en, description_zh, description_en, builtin, sort_order)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `).run(
      key,
      nameZh,
      cleanName(draft.enUS) || nameZh,
      typeof draft.descriptionZhCN === 'string' ? draft.descriptionZhCN.trim() : '',
      typeof draft.descriptionEnUS === 'string' ? draft.descriptionEnUS.trim() : '',
      (maxOrder ?? 0) + 1,
    )
    return WorldSettingCategoryRepository.getByKey(key)
  }

  /** 改名 / 改说明。内置分类也允许改名（作者想叫「法宝」而不是「物品」），但不可删。 */
  static update(key: string, draft: WorldSettingCategoryDraft): WorldSettingCategoryRecord | null {
    const current = WorldSettingCategoryRepository.getByKey(key)
    if (!current) return null
    const nameZh = cleanName(draft?.zhCN) || current.zhCN
    const db = projectDb()
    db.prepare(`
      UPDATE world_setting_categories
      SET name_zh = ?, name_en = ?, description_zh = ?, description_en = ?, updated_at = datetime('now')
      WHERE key = ?
    `).run(
      nameZh,
      cleanName(draft.enUS) || current.enUS,
      typeof draft.descriptionZhCN === 'string' ? draft.descriptionZhCN.trim() : current.descriptionZhCN,
      typeof draft.descriptionEnUS === 'string' ? draft.descriptionEnUS.trim() : current.descriptionEnUS,
      key,
    )
    return WorldSettingCategoryRepository.getByKey(key)
  }

  /** 该分类下的条目数（含待确认候选）—— 删除前的检查、侧栏计数都用它。 */
  static countEntries(key: string): number {
    const db = projectDb()
    const row = db
      .prepare('SELECT COUNT(*) AS total FROM world_settings WHERE category = ?')
      .get(key) as { total: number } | undefined
    return row?.total ?? 0
  }

  /**
   * 删除自建分类。
   *
   * 不返回 boolean 而是带原因的结果 —— 界面要据此说清「为什么删不掉」：
   * 是内置分类，还是里面还有条目。
   */
  static remove(key: string): { removed: boolean; reason?: 'builtin' | 'in-use' } {
    const current = WorldSettingCategoryRepository.getByKey(key)
    if (!current) return { removed: false }
    if (current.builtin) return { removed: false, reason: 'builtin' }
    if (WorldSettingCategoryRepository.countEntries(key) > 0) return { removed: false, reason: 'in-use' }
    const db = projectDb()
    const result = db.prepare('DELETE FROM world_setting_categories WHERE key = ?').run(key)
    return { removed: result.changes > 0 }
  }
}
