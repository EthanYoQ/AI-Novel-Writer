import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createProjectDatabase, initProjectDatabase } from '../../electron/database'
import { CANONICAL_PROJECT_DIRECTORY, CANONICAL_PROJECT_DATABASE, createCanonicalProjectManifest } from '../../src/shared/project-format'
import { activateCanonicalProjectData } from '../../electron/services/project-data-locator'

/** Test-owned new-project setup. Reopen exercises the actual production verifier;
 * this helper never adopts legacy roots or silently normalizes an unknown schema.
 */
export function prepareCanonicalStorageFixture(projectPath: string, importSourceSecret?: Buffer): void {
  if (fs.existsSync(path.join(projectPath, '.vela'))) throw new Error('LEGACY_FIXTURE_REQUIRES_EXPLICIT_MIGRATION_TEST')
  const root = path.join(projectPath, CANONICAL_PROJECT_DIRECTORY)
  fs.mkdirSync(root, { recursive: true })
  const file = path.join(root, 'project.json')
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(createCanonicalProjectManifest({ projectId: randomUUID(), createdAt: new Date().toISOString() })), { flag: 'wx' })
  if (!fs.existsSync(path.join(root, CANONICAL_PROJECT_DATABASE))) createProjectDatabase(projectPath, importSourceSecret)
  activateCanonicalProjectData(projectPath)
}

export function openCanonicalProjectFixture(projectPath: string, importSourceSecret?: Buffer): void {
  prepareCanonicalStorageFixture(projectPath, importSourceSecret)
  initProjectDatabase(projectPath)
}
