import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import type BetterSqlite3 from 'better-sqlite3'
import { initializeLegacyBaselineSchema } from '../../electron/migrations/baseline-schema'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
let fixtureDb: BetterSqlite3.Database | null = null
let fixturePath: string | null = null
/** Explicit historical schema regression only. Tests inject this handle into
 * repositories; it never admits a production locator or qualifies old projects.
 */
export function openLegacyNormalizationFixture(projectPath: string): void {
  closeLegacyNormalizationFixture()
  const root = path.join(projectPath, '.vela'); fs.mkdirSync(root, { recursive: true })
  fixtureDb = new Database(path.join(root, 'vela.db'))
  fixtureDb.pragma('foreign_keys = ON')
  fixtureDb.transaction(() => initializeLegacyBaselineSchema(fixtureDb!))()
  fixturePath = projectPath
}
export function closeLegacyNormalizationFixture(): void {
  fixtureDb?.close(); fixtureDb = null; fixturePath = null
}
export function getLegacyNormalizationFixtureDb(): BetterSqlite3.Database | null { return fixtureDb }
export function getLegacyNormalizationFixturePath(): string | null { return fixturePath }
