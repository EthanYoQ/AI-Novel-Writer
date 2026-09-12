/**
 * Vela SQLite 数据库服务 — 主进程使用
 *
 * 负责 SQLite 实例的连接、生命周期与建表。
 * 具体业务逻辑由 /repositories 提供。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import { initializeLegacyBaselineSchema } from './migrations/baseline-schema'
import { getDesktopMigrationRegistry } from './migrations/desktop-registry'
import { migrateSchema, verifySchema } from './migrations/runner'
import { SqliteSchemaAdapter } from './migrations/sqlite-schema-adapter'
import { activateCanonicalProjectData, deactivateProjectData, getNewProjectDatabasePath, getProjectDatabasePath } from './services/project-data-locator'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
import type BetterSqlite3 from 'better-sqlite3'

let projectDb: BetterSqlite3.Database | null = null
let currentProjectPath: string | null = null

/** 初始化项目数据库（打开项目时调用） */
export function createProjectDatabase(projectPath: string, importSourceSecret?: Buffer): void {
  const file = getNewProjectDatabasePath(projectPath)
  const fd = fs.openSync(file, 'wx', 0o600); fs.closeSync(fd)
  const database = new Database(file, { fileMustExist: true })
  try {
    database.pragma('foreign_keys = ON')
    initializeLegacyBaselineSchema(database, importSourceSecret)
    migrateSchema(new SqliteSchemaAdapter(database), getDesktopMigrationRegistry(), 1)
  } finally { database.close() }
}

/** Existing projects are verified before acquiring a writable handle or fencing. */
export function initProjectDatabase(projectPath: string): void {
  closeProjectDatabase()
  let database: BetterSqlite3.Database | undefined
  try {
    activateCanonicalProjectData(projectPath)
    database = new Database(getProjectDatabasePath(projectPath), { fileMustExist: true })
    const adapter = new SqliteSchemaAdapter(database)
    verifySchema(adapter, getDesktopMigrationRegistry(), 1)
    database.pragma('journal_mode = WAL')
    database.pragma('foreign_keys = ON')
    fenceProjectSession(database)
    projectDb = database
    currentProjectPath = projectPath
  } catch (error) {
    database?.close(); deactivateProjectData(projectPath); throw error
  }
}

/** 关闭项目数据库 */
export function closeProjectDatabase(): void {
  // Clear the process-visible identity before closing the native handle. If
  // the close itself throws, callers still fail closed instead of treating a
  // half-closed database as the active project.
  const closingDatabase = projectDb
  const closingProjectPath = currentProjectPath
  projectDb = null
  currentProjectPath = null
  if (closingProjectPath) deactivateProjectData(closingProjectPath)
  closingDatabase?.close()
}

/** 获取当前数据库实例 */
export function getProjectDb(): BetterSqlite3.Database | null {
  return projectDb
}

/** 获取当前已打开项目路径 */
export function getCurrentProjectPath(): string | null {
  return currentProjectPath
}

/** Session ownership changes are separate from schema migration. */
export function fenceProjectSession(db: BetterSqlite3.Database): void {
  db.exec(`
    UPDATE import_runs
    SET execution_owner = '', execution_epoch = execution_epoch + 1, lease_expires_at = 0,
        updated_at = datetime('now')
    WHERE status = 'running' AND (execution_owner <> '' OR lease_expires_at <> 0)
  `)

}
