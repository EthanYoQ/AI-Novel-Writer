import { createRequire } from 'node:module'
import { createMigrationRegistry, type MigrationRegistry, type SchemaReader } from './registry'
import { createM01Migration, M01_GENERATION_SQL } from './m01-generation-runs'
import { createM00Migration } from './m00-baseline'
import { initializeLegacyBaselineSchema, applyBaselineTables } from './baseline-schema'
import { ensureBaselineBlueprintTables } from './baseline-blueprint-schema'
import { SqliteSchemaAdapter, sqliteSchemaFingerprint } from './sqlite-schema-adapter'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
export const CURRENT_DESKTOP_SCHEMA_VERSION = 2
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
    reference.exec(M01_GENERATION_SQL)
    const generationTarget = sqliteSchemaFingerprint(reference)
    const m01 = createM01Migration(db => sqliteSchemaFingerprint(native(db)) === generationTarget)
    installed = createMigrationRegistry([m00, m01], [
      ...new Set([source, target]),
    ].map(fingerprint => ({ version: 0, fingerprint })).concat([{ version: 1, fingerprint: target }, { version: 2, fingerprint: generationTarget }]))
    return installed
  } finally { reference.close() }
}
