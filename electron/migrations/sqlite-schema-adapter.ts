import { createHash } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import type { SchemaWriter } from './registry'

export function sqliteSchemaFingerprint(db: BetterSqlite3.Database): string {
  const schema = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
  // Exact DDL, including constraints, indexes, triggers and views. Unknown forks
  // cannot be admitted merely because selected table/column names look familiar.
  return createHash('sha256').update(JSON.stringify(schema)).digest('hex')
}

export class SqliteSchemaAdapter implements SchemaWriter {
  constructor(readonly database: BetterSqlite3.Database) {}
  readUserVersion(): number { return this.database.pragma('user_version', { simple: true }) as number }
  readSchemaFingerprint(): string { return sqliteSchemaFingerprint(this.database) }
  integrityCheck(): boolean { return this.database.pragma('integrity_check', { simple: true }) === 'ok' }
  foreignKeyCheck(): boolean { return (this.database.pragma('foreign_key_check') as unknown[]).length === 0 }
  transaction<T>(operation: () => T): T { return this.database.transaction(operation)() }
  writeUserVersion(version: number): void {
    if (!Number.isSafeInteger(version) || version < 0) throw new Error('INVALID_SCHEMA_VERSION')
    this.database.pragma(`user_version = ${version}`)
  }
  executeMigrationSql(sql: string): void { this.database.exec(sql) }
}
