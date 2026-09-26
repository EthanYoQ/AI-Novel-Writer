import type { MigrationImplementation, SchemaReader, SchemaWriter } from './registry'

/** Central database owner supplies the single baseline schema implementation.
 * This slice owns only the M00 business slot, never a second copy of its DDL.
 */
export function createM00Migration(baseline: {
  applyKnownBaseline(db: SchemaWriter): void
  verifyKnownBaseline(db: SchemaReader): boolean
}): MigrationImplementation {
  return Object.freeze({ id: 'M00', from: 0, to: 1, owner: 'S04',
    migrate: baseline.applyKnownBaseline, verify: baseline.verifyKnownBaseline })
}
