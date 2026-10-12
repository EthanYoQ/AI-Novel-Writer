import type Database from 'better-sqlite3'

import type { MigrationImplementation, SchemaReader } from './registry'

/** 作者逐章场景级大纲（章节细纲）。加列即可，历史行留空表示"未填写"。 */
export const M07_BLUEPRINT_CHAPTER_OUTLINE_SQL = `ALTER TABLE blueprints
  ADD COLUMN chapter_outline TEXT NOT NULL DEFAULT '';`

export function applyM07BlueprintChapterOutline(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('BLUEPRINT_CHAPTER_OUTLINE_MIGRATION_TRANSACTION_REQUIRED')
  const columns = db.prepare('PRAGMA table_info(blueprints)').all() as Array<{ name: string }>
  if (!columns.some(column => column.name === 'chapter_number')) {
    throw new Error('BLUEPRINT_CHAPTER_OUTLINE_MIGRATION_SCHEMA_UNRECOGNIZED')
  }
  if (columns.some(column => column.name === 'chapter_outline')) {
    throw new Error('BLUEPRINT_CHAPTER_OUTLINE_MIGRATION_COLUMN_ALREADY_PRESENT')
  }
  db.exec(M07_BLUEPRINT_CHAPTER_OUTLINE_SQL)
}

export function verifyM07BlueprintChapterOutline(db: Database.Database): boolean {
  try {
    const columns = db.prepare('PRAGMA table_info(blueprints)').all() as Array<{ name: string; notnull: number; dflt_value: unknown }>
    const column = columns.find(item => item.name === 'chapter_outline')
    return Boolean(column) && column!.notnull === 1
  } catch { return false }
}

export function createM07Migration(deps: {
  database: (reader: SchemaReader) => Database.Database
  verifyKnownSchema: (reader: SchemaReader) => boolean
}): MigrationImplementation {
  return { id: 'M07', from: 7, to: 8, owner: 'chapter-outline', migrate: reader => applyM07BlueprintChapterOutline(deps.database(reader)),
    verify: reader => deps.verifyKnownSchema(reader) && verifyM07BlueprintChapterOutline(deps.database(reader)) }
}
