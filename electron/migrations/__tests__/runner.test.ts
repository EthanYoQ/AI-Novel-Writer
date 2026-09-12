import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { initProjectDatabase, getProjectDb, closeProjectDatabase } from '../../database'
import { BlueprintRepository } from '../../repositories/blueprint-repository'
import storageContract from '../../../docs/research/novel-quality-modernization/s01-storage-contract.json'
import {
  MIGRATION_LANE, createMigrationRegistry, migrationRegistry,
  type MigrationImplementation, type SchemaWriter,
} from '../registry'
import { migrateSchema, probeSchema, verifySchema } from '../runner'

class FixtureDatabase implements SchemaWriter {
  version = 0
  fingerprint = 'fixture-schema-0'
  rows = ['作者原文']
  integrity = true
  foreignKeys = true
  transactions = 0
  writes = 0
  rollbackCount = 0
  failCommit = false
  beforeTransaction?: () => void
  readUserVersion() { return this.version }
  readSchemaFingerprint() { return this.fingerprint }
  integrityCheck() { return this.integrity }
  foreignKeyCheck() { return this.foreignKeys }
  writeUserVersion(version: number) { this.writes++; this.version = version }
  executeMigrationSql(sql: string) { this.writes++; this.rows.push(sql) }
  transaction<T>(operation: () => T): T {
    this.beforeTransaction?.()
    const snapshot = { version: this.version, fingerprint: this.fingerprint,
      rows: [...this.rows], integrity: this.integrity, foreignKeys: this.foreignKeys }
    this.transactions++
    try {
      const result = operation()
      if (this.failCommit) throw new Error('fixture-commit-failure')
      return result
    } catch (error) {
      Object.assign(this, snapshot)
      this.rollbackCount++
      throw error
    }
  }
}

const identities = Array.from({ length: 7 }, (_, version) => ({ version, fingerprint: `fixture-schema-${version}` }))
function implementations(): MigrationImplementation[] {
  return MIGRATION_LANE.map(slot => ({ ...slot,
    migrate(db) {
      db.executeMigrationSql(`fixture-domain-step-${slot.id}`)
      ;(db as FixtureDatabase).fingerprint = `fixture-schema-${slot.to}`
    },
    verify: db => db.readSchemaFingerprint() === `fixture-schema-${slot.to}`,
  }))
}

describe('desktop single schema lane', () => {
  it('matches the signed field set to a current synthetic baseline DB, including delegated roster tables', () => {
    const cache = path.resolve('.runtime/.cache/novel-quality-modernization')
    fs.mkdirSync(cache, { recursive: true })
    const root = fs.mkdtempSync(path.join(cache, 's01-schema-fixture-'))
    try {
      initProjectDatabase(root)
      const db = getProjectDb()!
      // The existing legacy read entry also creates two known blueprint ledgers lazily.
      expect(BlueprintRepository.listPendingCharacterSyncOperations()).toEqual([])
      expect(db.pragma('user_version', { simple: true })).toBe(0)
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]
      const fields = tables.flatMap(({ name }) => {
        const columns = db.pragma(`table_info(${name})`) as { name: string }[]
        return columns.map(column => `${name}.${column.name}`)
      }).sort()
      expect(fields).toEqual(storageContract.fieldDispositions.map(row => `${row.table}.${row.field}`).sort())
      expect(tables).toHaveLength(storageContract.baselineTableCount)
    } finally {
      closeProjectDatabase()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('reserves exactly six consecutive versions with a single declared owner for each', () => {
    expect(MIGRATION_LANE.map(s => [s.id, s.from, s.to, s.owner])).toEqual([
      ['M00', 0, 1, 'S04'], ['M01', 1, 2, 'S05'], ['M02', 2, 3, 'S08'],
      ['M03', 3, 4, 'S11'], ['M04', 4, 5, 'S12'], ['M05', 5, 6, 'F03'],
    ])
    expect(migrationRegistry.implementations).toEqual([])
    expect(migrationRegistry.recognizedSchemas).toEqual([])
  })

  it.each(['duplicate', 'owner', 'gap', 'unknown'] as const)('rejects invalid registration: %s', kind => {
    const steps = implementations()
    if (kind === 'duplicate') steps.push(steps[0])
    if (kind === 'owner') steps[0] = { ...steps[0], owner: 'S05' }
    if (kind === 'gap') steps[0] = { ...steps[0], to: 2 }
    if (kind === 'unknown') steps[0] = { ...steps[0], id: 'M99' as 'M00' }
    expect(() => createMigrationRegistry(steps, identities)).toThrow('INVALID_MIGRATION_REGISTRATION')
  })

  it.each(['newer', 'unknown', 'corrupt', 'foreign-key', 'invalid'] as const)('refuses %s during read-only probe without a transaction', kind => {
    const db = new FixtureDatabase()
    if (kind === 'newer') db.version = 99
    if (kind === 'unknown') db.fingerprint = 'unknown-fork'
    if (kind === 'corrupt') db.integrity = false
    if (kind === 'foreign-key') db.foreignKeys = false
    if (kind === 'invalid') db.version = -1
    expect(() => migrateSchema(db, createMigrationRegistry(implementations(), identities))).toThrow()
    expect(db.transactions).toBe(0)
    expect(db.writes).toBe(0)
    expect(db.rows).toEqual(['作者原文'])
  })

  it('refuses all missing steps before writing even when the first step is installed', () => {
    const db = new FixtureDatabase()
    expect(() => migrateSchema(db, createMigrationRegistry(implementations().slice(0, 1), identities))).toThrow('MIGRATION_NOT_INSTALLED')
    expect(db.transactions).toBe(0)
    expect(db.version).toBe(0)
  })

  it('does not accept a bare version 0 in the empty production registry', () => {
    const db = new FixtureDatabase()
    expect(() => probeSchema(db, migrationRegistry)).toThrow('UNRECOGNIZED_SCHEMA')
    expect(db.writes).toBe(0)
  })

  it.each(['ddl', 'verify', 'fingerprint', 'version', 'commit'] as const)('rolls back current step and version on %s failure', fault => {
    const db = new FixtureDatabase()
    const steps = implementations()
    const original = steps[0].migrate
    steps[0] = { ...steps[0], migrate(adapter) {
      original(adapter)
      if (fault === 'ddl') throw new Error('fixture-ddl-failure')
      if (fault === 'fingerprint') db.fingerprint = 'wrong-schema'
      if (fault === 'version') db.version = 6
    }, verify: fault === 'verify' ? () => false : steps[0].verify }
    db.failCommit = fault === 'commit'
    expect(() => migrateSchema(db, createMigrationRegistry(steps, identities), 1)).toThrow()
    expect(db.version).toBe(0)
    expect(db.fingerprint).toBe('fixture-schema-0')
    expect(db.rows).toEqual(['作者原文'])
    expect(db.rollbackCount).toBe(1)
  })

  it('restarts from last committed step without repeating earlier effects', () => {
    const db = new FixtureDatabase()
    const broken = implementations()
    broken[1] = { ...broken[1], verify: () => false }
    expect(() => migrateSchema(db, createMigrationRegistry(broken, identities), 2)).toThrow()
    expect(db.version).toBe(1)
    const result = migrateSchema(db, createMigrationRegistry(implementations(), identities), 2)
    expect(result.completedSteps).toEqual(['M01'])
    expect(db.rows).toEqual(['作者原文', 'fixture-domain-step-M00', 'fixture-domain-step-M01'])
    expect(result.sessionFenced).toBe(false)
    expect(result.repositoriesOpened).toBe(false)
    const transactions = db.transactions
    expect(migrateSchema(db, createMigrationRegistry(implementations(), identities), 2).completedSteps).toEqual([])
    expect(db.transactions).toBe(transactions)
  })

  it('rejects schema changes between probe and transaction', () => {
    const db = new FixtureDatabase()
    db.beforeTransaction = () => { db.fingerprint = 'unknown-concurrent-change' }
    expect(() => migrateSchema(db, createMigrationRegistry(implementations(), identities), 1)).toThrow()
    expect(db.writes).toBe(0)
  })

  it('rechecks current domain invariants on same-schema reopen without rerunning backfill', () => {
    const db = new FixtureDatabase()
    const steps = implementations()
    migrateSchema(db, createMigrationRegistry(steps, identities), 1)
    const transactions = db.transactions
    const writes = db.writes
    steps[0] = { ...steps[0], verify: () => false }
    const registry = createMigrationRegistry(steps, identities)
    expect(() => migrateSchema(db, registry, 1)).toThrow('MIGRATION_VERIFICATION_FAILED')
    expect(() => migrateSchema(db, registry, 2)).toThrow('MIGRATION_VERIFICATION_FAILED')
    expect(() => verifySchema(db, registry, 1)).toThrow('MIGRATION_VERIFICATION_FAILED')
    expect(db.transactions).toBe(transactions)
    expect(db.writes).toBe(writes)
    expect(db.version).toBe(1)
  })

  it('verifies separately, rejects downgrade, and leaves fencing to the integration owner', () => {
    const db = new FixtureDatabase()
    const registry = createMigrationRegistry(implementations(), identities)
    const result = migrateSchema(db, registry)
    expect(result.version).toBe(6)
    expect(verifySchema(db, registry, 6)).toEqual({ version: 6, fingerprint: 'fixture-schema-6' })
    expect(() => migrateSchema(db, registry, 5)).toThrow('SCHEMA_DOWNGRADE_REFUSED')
    expect(() => verifySchema(db, registry, 5)).toThrow('SCHEMA_VERSION_MISMATCH')
    expect(result.sessionFenced).toBe(false)
    expect(result.repositoriesOpened).toBe(false)
  })
})
