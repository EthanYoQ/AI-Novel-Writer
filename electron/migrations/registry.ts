import type { MigrationId } from '../../src/shared/project-storage'

/** The desktop-only schema lane. Version 0 is unversioned legacy, not a known schema. */
export const MIGRATION_LANE = Object.freeze([
  Object.freeze({ id: 'M00', from: 0, to: 1, owner: 'S04' }),
  Object.freeze({ id: 'M01', from: 1, to: 2, owner: 'S05' }),
  Object.freeze({ id: 'M02', from: 2, to: 3, owner: 'S08' }),
  Object.freeze({ id: 'M03', from: 3, to: 4, owner: 'S11' }),
  Object.freeze({ id: 'M04', from: 4, to: 5, owner: 'S12' }),
  Object.freeze({ id: 'M05', from: 5, to: 6, owner: 'F03' }),
] as const)

export const LATEST_SCHEMA_VERSION = 6
export type { MigrationId } from '../../src/shared/project-storage'

/** This adapter is supplied for an already authorized, exclusive staging DB by S04.
 * Read methods must not create files, take leases, fence sessions or run repositories.
 */
export interface SchemaReader {
  readUserVersion(): number
  readSchemaFingerprint(): string
  integrityCheck(): boolean
  foreignKeyCheck(): boolean
}

export interface SchemaWriter extends SchemaReader {
  /** All changes, including PRAGMA user_version, commit together or roll back on throw. */
  transaction<T>(operation: () => T): T
  writeUserVersion(version: number): void
  executeMigrationSql(sql: string): void
}

export interface MigrationImplementation {
  readonly id: MigrationId
  readonly from: number
  readonly to: number
  readonly owner: string
  readonly migrate: (db: SchemaWriter) => void
  /** Read-only domain invariants; failure rolls back this step and its version. */
  readonly verify: (db: SchemaReader) => boolean
}

export interface RecognizedSchema {
  readonly version: number
  /** Safe structural digest only, never user data, paths, secretRef or credential hashes. */
  readonly fingerprint: string
}

export interface MigrationRegistry {
  readonly implementations: readonly MigrationImplementation[]
  readonly recognizedSchemas: readonly RecognizedSchema[]
}

export class SchemaMigrationError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'SchemaMigrationError'
  }
}

/** Only the central integration owner installs the business functions and proven schemas. */
export function createMigrationRegistry(
  implementations: readonly MigrationImplementation[] = [],
  recognizedSchemas: readonly RecognizedSchema[] = [],
): MigrationRegistry {
  const seen = new Set<string>()
  for (const implementation of implementations) {
    const slot = MIGRATION_LANE.find(item => item.id === implementation.id)
    if (!slot || seen.has(implementation.id)
      || slot.owner !== implementation.owner
      || slot.from !== implementation.from || slot.to !== implementation.to
      || typeof implementation.migrate !== 'function' || typeof implementation.verify !== 'function') {
      throw new SchemaMigrationError('INVALID_MIGRATION_REGISTRATION')
    }
    seen.add(implementation.id)
  }
  const identities = new Set<string>()
  for (const identity of recognizedSchemas) {
    const key = `${identity.version}:${identity.fingerprint}`
    if (!Number.isInteger(identity.version) || identity.version < 0
      || identity.version > LATEST_SCHEMA_VERSION || !identity.fingerprint.trim()
      || identities.has(key)) throw new SchemaMigrationError('INVALID_SCHEMA_IDENTITY')
    identities.add(key)
  }
  return Object.freeze({
    implementations: Object.freeze(implementations.map(item => Object.freeze({ ...item }))),
    recognizedSchemas: Object.freeze(recognizedSchemas.map(item => Object.freeze({ ...item }))),
  })
}

// Installed business steps live exclusively in desktop-registry.ts. Tests can
// construct an empty registry with the same factory without a second runtime lane.
