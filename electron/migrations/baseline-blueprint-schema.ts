import type BetterSqlite3 from 'better-sqlite3'

/** The legacy lazy tables are installed once by M00 in canonical projects. */
export function ensureBaselineBlueprintTables(db: BetterSqlite3.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS blueprint_commit_operations (
        operation_id TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('full', 'replace-range')),
        start_chapter INTEGER NOT NULL,
        end_chapter INTEGER NOT NULL,
        character_sync_input TEXT NOT NULL,
        committed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS blueprint_character_sync_operations (
        operation_id TEXT PRIMARY KEY,
        blueprint_commit_operation_id TEXT NOT NULL UNIQUE,
        blueprint_commit_payload_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'completed')),
        start_chapter INTEGER NOT NULL,
        end_chapter INTEGER NOT NULL,
        character_sync_input TEXT NOT NULL,
        completion_receipt TEXT DEFAULT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT DEFAULT NULL,
        FOREIGN KEY (blueprint_commit_operation_id)
          REFERENCES blueprint_commit_operations(operation_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_blueprint_character_sync_status
        ON blueprint_character_sync_operations(status, created_at);
    `)
}
