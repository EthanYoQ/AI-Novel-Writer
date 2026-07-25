export const LEGACY_VECTOR_MIGRATION_BLOCKED = 'LEGACY_VECTOR_MIGRATION_BLOCKED' as const

/**
 * A lightweight error module so IPC can map a blocked legacy migration without
 * eagerly loading the native LanceDB knowledge-base module.
 */
export class LegacyVectorMigrationBlockedError extends Error {
  readonly code = LEGACY_VECTOR_MIGRATION_BLOCKED

  constructor(readonly migrationError: string) {
    super(migrationError)
    this.name = 'LegacyVectorMigrationBlockedError'
  }
}
