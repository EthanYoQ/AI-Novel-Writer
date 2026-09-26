import { createRequire } from 'node:module'
import { createMigrationRegistry, type MigrationRegistry, type SchemaReader } from './registry'
import { createM01Migration, M01_GENERATION_SQL } from './m01-generation-runs'
import { applyM02CharacterIdentity, createM02Migration, verifyM02CharacterIdentity } from './m02-character-identity'
import { applyM03ReviewCycle, applyM06ReviewCycleMerge, createM03Migration, createM06Migration,
  verifyM03ReviewCycle } from './m03-review-cycle'
import { applyM04ImportEffectLedger, createM04Migration } from './m04-import-effect-ledger'
import { applyM05CharacterAssets, createM05Migration } from './m05-character-assets'
import { createM00Migration } from './m00-baseline'
import { initializeLegacyBaselineSchema, applyBaselineTables } from './baseline-schema'
import { ensureBaselineBlueprintTables } from './baseline-blueprint-schema'
import { SqliteSchemaAdapter, sqliteSchemaFingerprint } from './sqlite-schema-adapter'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
export const CURRENT_DESKTOP_SCHEMA_VERSION = 7
let installed: MigrationRegistry | undefined

function installKnownDonorAvatarColumn(db: import('better-sqlite3').Database): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='characters'").get() as { sql: string }
  const marker = "      cs_location TEXT DEFAULT '',"
  if (!row.sql.includes(marker)) throw new Error('DONOR_CHARACTER_SCHEMA_MARKER_MISSING')
  const donorSql = row.sql.replace(marker, "      avatar TEXT NOT NULL DEFAULT '',\n" + marker)
  db.exec('ALTER TABLE characters RENAME TO characters_without_avatar')
  db.exec(donorSql)
  db.exec('DROP TABLE characters_without_avatar')
}

/** Single installed desktop lane. Its source catalog is generated solely from
 * the checked-in baseline DDL in an empty in-memory DB, never from author files.
 * S04 recognizes the current baseline with/without the two legacy lazy tables.
 * Historical binaries and other schema variants require their own qualification.
 */
export function getDesktopMigrationRegistry(): MigrationRegistry {
  if (installed) return installed
  const reference = new Database(':memory:'), donor = new Database(':memory:')
  try {
    const references = [reference, donor]
    for (const db of references) { db.pragma('foreign_keys = ON'); initializeLegacyBaselineSchema(db) }
    installKnownDonorAvatarColumn(donor)
    const schemas = (version: number) => references.map(db => ({ version, fingerprint: sqliteSchemaFingerprint(db) }))
    const sourceSchemas = schemas(0)
    for (const db of references) ensureBaselineBlueprintTables(db)
    const baselineSchemas = schemas(1), baselineFingerprints = new Set(baselineSchemas.map(item => item.fingerprint))
    const native = (db: SchemaReader) => {
      if (!(db instanceof SqliteSchemaAdapter)) throw new Error('SQLITE_SCHEMA_ADAPTER_REQUIRED')
      return db.database
    }
    const m00 = createM00Migration({
      applyKnownBaseline(db) {
        applyBaselineTables(native(db))
        ensureBaselineBlueprintTables(native(db))
      },
      verifyKnownBaseline(db) { return baselineFingerprints.has(sqliteSchemaFingerprint(native(db))) },
    })
    for (const db of references) db.exec(M01_GENERATION_SQL)
    const generationSchemas = schemas(2), generationFingerprints = new Set(generationSchemas.map(item => item.fingerprint))
    const m01 = createM01Migration(db => generationFingerprints.has(sqliteSchemaFingerprint(native(db))))
    for (const db of references) db.transaction(() => applyM02CharacterIdentity(db))()
    const identitySchemas = schemas(3), identityFingerprints = new Set(identitySchemas.map(item => item.fingerprint))
    const m02 = createM02Migration({ database: native, verifyKnownSchema: db => identityFingerprints.has(sqliteSchemaFingerprint(native(db))) })
    for (const db of references) db.transaction(() => applyM03ReviewCycle(db))()
    const reviewCycleSchemas = schemas(4), reviewCycleFingerprints = new Set(reviewCycleSchemas.map(item => item.fingerprint))
    const m03 = createM03Migration({ database: native,
      verifyKnownSchema: db => reviewCycleFingerprints.has(sqliteSchemaFingerprint(native(db))) && verifyM02CharacterIdentity(native(db)) })
    for (const db of references) db.transaction(() => applyM04ImportEffectLedger(db))()
    const importEffectSchemas = schemas(5), importEffectFingerprints = new Set(importEffectSchemas.map(item => item.fingerprint))
    const m04 = createM04Migration({ database: native,
      verifyKnownSchema: db => importEffectFingerprints.has(sqliteSchemaFingerprint(native(db)))
        && verifyM02CharacterIdentity(native(db)) && verifyM03ReviewCycle(native(db)) })
    for (const db of references) db.transaction(() => applyM05CharacterAssets(db))()
    const characterAssetSchemas = schemas(6), characterAssetFingerprints = new Set(characterAssetSchemas.map(item => item.fingerprint))
    const m05 = createM05Migration({ database: native,
      verifyKnownSchema: db => characterAssetFingerprints.has(sqliteSchemaFingerprint(native(db)))
        && verifyM02CharacterIdentity(native(db)) && verifyM03ReviewCycle(native(db)) })
    for (const db of references) db.transaction(() => applyM06ReviewCycleMerge(db))()
    const mergeSnapshotSchemas = schemas(7), mergeSnapshotFingerprints = new Set(mergeSnapshotSchemas.map(item => item.fingerprint))
    const m06 = createM06Migration({ database: native,
      verifyKnownSchema: db => mergeSnapshotFingerprints.has(sqliteSchemaFingerprint(native(db)))
        && verifyM02CharacterIdentity(native(db)) })
    installed = createMigrationRegistry([m00, m01, m02, m03, m04, m05, m06], [
      ...sourceSchemas, ...baselineSchemas.map(schema => ({ ...schema, version: 0 })),
      ...baselineSchemas, ...generationSchemas, ...identitySchemas,
      ...reviewCycleSchemas, ...importEffectSchemas, ...characterAssetSchemas, ...mergeSnapshotSchemas,
    ])
    return installed
  } finally { reference.close(); donor.close() }
}
