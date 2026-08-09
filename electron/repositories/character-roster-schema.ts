import type BetterSqlite3 from 'better-sqlite3'
import type { CharacterRosterMigrationState } from '../../src/shared/character-roster'

/**
 * 结构化角色名单只保存并发控制、迁移和投影元数据。
 * 角色条目本身始终留在已有的 characters 表中，避免建立并列 JSON 事实源。
 */
export function ensureCharacterRosterSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS character_roster_meta (
      id TEXT PRIMARY KEY CHECK (id = 'main'),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      migration_state TEXT NOT NULL CHECK (
        migration_state IN (
          'empty',
          'legacy_cards_preserved',
          'legacy_markdown_pending',
          'ready'
        )
      ),
      legacy_markdown TEXT NOT NULL DEFAULT '',
      projection_hash TEXT NOT NULL DEFAULT '',
      fact_hash TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS character_roster_operations (
      operation_id TEXT PRIMARY KEY,
      payload_hash TEXT NOT NULL,
      committed_revision INTEGER NOT NULL,
      projection_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  // SQLite 旧项目已经有第一版 roster 元数据时，补上完整事实哈希。不能依赖
  // CREATE TABLE IF NOT EXISTS 迁移既有表结构。
  const metaColumns = db.prepare('PRAGMA table_info(character_roster_meta)').all() as Array<{ name: string }>
  if (!metaColumns.some(column => column.name === 'fact_hash')) {
    db.exec("ALTER TABLE character_roster_meta ADD COLUMN fact_hash TEXT NOT NULL DEFAULT ''")
  }

  const hasMeta = db.prepare(
    "SELECT 1 FROM character_roster_meta WHERE id = 'main'",
  ).get()
  if (hasMeta) return

  const characterCount = (db.prepare(
    'SELECT COUNT(*) AS count FROM characters',
  ).get() as { count: number }).count
  const legacyMarkdown = (db.prepare(
    "SELECT COALESCE(characters_arch, '') AS characters_arch FROM project_core WHERE id = 'main'",
  ).get() as { characters_arch?: string } | undefined)?.characters_arch ?? ''

  const migrationState: CharacterRosterMigrationState = characterCount > 0
    ? 'legacy_cards_preserved'
    : legacyMarkdown.trim()
      ? 'legacy_markdown_pending'
      : 'empty'

  db.prepare(`
    INSERT INTO character_roster_meta (
      id, schema_version, revision, migration_state, legacy_markdown, projection_hash, fact_hash
    ) VALUES ('main', 1, 0, ?, ?, '', '')
  `).run(migrationState, legacyMarkdown)
}
