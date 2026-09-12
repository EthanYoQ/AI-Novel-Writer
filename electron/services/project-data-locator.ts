import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { CANONICAL_PROJECT_DATABASE, CANONICAL_PROJECT_DIRECTORY, parseCanonicalProjectManifest } from '../../src/shared/project-format'
import { verifyProjectSqlite } from './sqlite-project-migration'

const admitted = new Map<string, { root: string; manifestHash: string }>()
const key = (root: string) => process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root)
function manifestState(projectPath: string) {
  const root = path.join(path.resolve(projectPath), CANONICAL_PROJECT_DIRECTORY)
  if (fs.existsSync(path.join(projectPath, '.vela'))) throw new Error('PROJECT_MIGRATION_REQUIRED')
  let cursor = root
  while (cursor !== path.dirname(cursor)) {
    const info = fs.lstatSync(cursor)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('PROJECT_STORAGE_UNSAFE_DIRECTORY')
    cursor = path.dirname(cursor)
  }
  const file = path.join(root, 'project.json'), info = fs.lstatSync(file)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('PROJECT_MANIFEST_INVALID')
  const bytes = fs.readFileSync(file), manifest = parseCanonicalProjectManifest(JSON.parse(bytes.toString('utf8')))
  const control = path.join(projectPath, '.ai-novel-migration')
  if (fs.existsSync(control)) {
    const controlInfo = fs.lstatSync(control)
    if (!controlInfo.isDirectory() || controlInfo.isSymbolicLink()) throw new Error('PROJECT_MIGRATION_RECOVERY_REQUIRED')
  }
  const journalFile = path.join(projectPath, '.ai-novel-migration', 'journal.json')
  if (fs.existsSync(journalFile)) {
    const journalInfo = fs.lstatSync(journalFile)
    if (!journalInfo.isFile() || journalInfo.isSymbolicLink() || journalInfo.nlink !== 1) throw new Error('PROJECT_MIGRATION_RECOVERY_REQUIRED')
    const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'))
    if (journal.version !== 1 || journal.phase !== 'switched' || journal.projectId !== manifest.projectId) throw new Error('PROJECT_MIGRATION_RECOVERY_REQUIRED')
  }
  return { root, manifestHash: createHash('sha256').update(bytes).digest('hex') }
}
/** New-project creation checks the canonical identity, but grants no DB access. */
export function getNewProjectDatabasePath(projectPath: string): string {
  const state = manifestState(projectPath)
  const file = path.join(state.root, CANONICAL_PROJECT_DATABASE)
  if (fs.existsSync(file)) throw new Error('PROJECT_DATABASE_ALREADY_EXISTS')
  return file
}
/** Admission always performs the real read-only SQLite verifier; shape-only
 * objects or a forged manifest cannot grant a business storage locator.
 */
export function activateCanonicalProjectData(projectPath: string): string {
  const before = manifestState(projectPath)
  verifyProjectSqlite({ databasePath: path.join(before.root, CANONICAL_PROJECT_DATABASE) })
  const after = manifestState(projectPath)
  if (before.manifestHash !== after.manifestHash) throw new Error('PROJECT_MANIFEST_CHANGED')
  admitted.set(key(projectPath), before)
  return before.root
}
export function getProjectDataRoot(projectPath: string): string {
  const ready = admitted.get(key(projectPath))
  if (!ready) throw new Error('PROJECT_DATA_NOT_READY')
  const current = manifestState(projectPath)
  if (current.root !== ready.root || current.manifestHash !== ready.manifestHash) throw new Error('PROJECT_MANIFEST_CHANGED')
  return ready.root
}
export function getProjectDatabasePath(projectPath: string): string { return path.join(getProjectDataRoot(projectPath), CANONICAL_PROJECT_DATABASE) }
export function deactivateProjectData(projectPath: string): void { admitted.delete(key(projectPath)) }
