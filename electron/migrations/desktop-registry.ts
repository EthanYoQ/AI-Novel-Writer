import { createRequire } from 'node:module'
import { createMigrationRegistry, type MigrationRegistry, type SchemaReader } from './registry'
import { createM00Migration } from './m00-baseline'
import { initializeLegacyBaselineSchema, applyBaselineTables } from './baseline-schema'
import { ensureBaselineBlueprintTables } from './baseline-blueprint-schema'
import { SqliteSchemaAdapter, sqliteSchemaFingerprint } from './sqlite-schema-adapter'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
let installed: MigrationRegistry | undefined

/** Single installed desktop lane. Its source catalog is generated solely from
 * the checked-in baseline DDL in an empty in-memory DB, never from author files.
 * S04 recognizes the current baseline with/without the two legacy lazy tables.
 * Historical binaries and other schema variants require their own qualification.
 */
export function getDesktopMigrationRegistry(): MigrationRegistry {
  if (installed) return installed
  const reference = new Database(':memory:')
  try {
    reference.pragma('foreign_keys = ON')
    initializeLegacyBaselineSchema(reference)
    const source = sqliteSchemaFingerprint(reference)
    ensureBaselineBlueprintTables(reference)
    const target = sqliteSchemaFingerprint(reference)
    const native = (db: SchemaReader) => {
      if (!(db instanceof SqliteSchemaAdapter)) throw new Error('SQLITE_SCHEMA_ADAPTER_REQUIRED')
      return db.database
    }
    const m00 = createM00Migration({
      applyKnownBaseline(db) {
        applyBaselineTables(native(db))
        ensureBaselineBlueprintTables(native(db))
      },
      verifyKnownBaseline(db) { return sqliteSchemaFingerprint(native(db)) === target },
    })
    installed = createMigrationRegistry([m00], [
      ...new Set([source, target]),
    ].map(fingerprint => ({ version: 0, fingerprint })).concat([{ version: 1, fingerprint: target }]))
    return installed
  } finally { reference.close() }
}
