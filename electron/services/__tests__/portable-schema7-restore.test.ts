import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { migrateSchema } from '../../migrations/runner'
import { SqliteSchemaAdapter, sqliteSchemaFingerprint } from '../../migrations/sqlite-schema-adapter'
import { removeDirectoryWithWindowsRetry } from '../../utils/remove-directory'
import { exportPortableProject } from '../project-archive-service'
import { restorePortableProject } from '../project-restore-service'
import { readPortableCurrentAuthority } from '../portable-current-authority'

// v1.4.0 的 master 代码导出的真实便携包：第 1、3 章已定稿，第 2 章已被硬删，只剩删章收据。
const SCHEMA7_ARCHIVE = path.resolve('test/fixtures/portable/schema7-hard-deleted-middle.ainovel')
const roots: string[] = []

afterEach(async () => {
  closeProjectDatabase()
  for (const root of roots.splice(0)) await removeDirectoryWithWindowsRetry(root)
})

function workspace(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'schema7-restore-'))
  roots.push(base)
  return base
}

describe('恢复 M07 之前导出的便携包（schema 7）', { timeout: 60_000 }, () => {
  it('解出的库迁到 v8 后安装，正文、删章收据与转移授权都在', async () => {
    const target = path.join(workspace(), '恢复')
    const receipt = await restorePortableProject({ archivePath: SCHEMA7_ARCHIVE, targetProjectRoot: target })
    initProjectDatabase(target)
    const db = getProjectDb()!
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_DESKTOP_SCHEMA_VERSION)
    expect(db.prepare("SELECT chapter_number FROM drafts WHERE status='finalized' ORDER BY chapter_number").pluck().all()).toEqual([1, 3])
    expect(db.prepare('SELECT chapter_number FROM chapter_deletion_operations').pluck().all()).toEqual([2])
    expect(db.prepare("SELECT COUNT(*) FROM drafts WHERE deletion_id <> ''").pluck().get()).toBe(0)
    const created = new (createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3'))(':memory:')
    try {
      created.transaction(() => initializeLegacyBaselineSchema(created))()
      migrateSchema(new SqliteSchemaAdapter(created), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
      expect(sqliteSchemaFingerprint(db), '与新建作品同形').toBe(sqliteSchemaFingerprint(created))
    } finally { created.close() }
    expect(readPortableCurrentAuthority({ database: db, projectStorageRoot: path.join(target, '.ai-novel'),
      projectId: receipt.targetProjectId })).not.toBeNull()
  })

  it('同一个包对同一目标再恢复一次，认出已装好的项目', async () => {
    const target = path.join(workspace(), '恢复')
    const first = await restorePortableProject({ archivePath: SCHEMA7_ARCHIVE, targetProjectRoot: target })
    const again = await restorePortableProject({ archivePath: SCHEMA7_ARCHIVE, targetProjectRoot: target })
    expect(again).toEqual(first)
  })

  it('恢复出的项目能再导出成 v8 包并恢复', async () => {
    const base = workspace()
    const target = path.join(base, '恢复')
    const receipt = await restorePortableProject({ archivePath: SCHEMA7_ARCHIVE, targetProjectRoot: target })
    const archive = path.join(base, 'again.ainovel')
    const attempts = path.join(base, 'attempts')
    fs.mkdirSync(attempts)
    await exportPortableProject({ sourceProjectRoot: target,
      projectSession: { projectId: receipt.targetProjectId, projectPath: target, leaseId: 'lease-again' },
      targetArchivePath: archive, attemptParentPath: attempts, assertCurrentContext: () => undefined,
      assets: { snapshot: () => ({ files: [], verifyUnchanged: () => undefined }) }, snapshotGeneration: 'after-schema7' })
    const second = path.join(base, '再恢复')
    await restorePortableProject({ archivePath: archive, targetProjectRoot: second })
    initProjectDatabase(second)
    expect(getProjectDb()!.prepare("SELECT chapter_number FROM drafts WHERE status='finalized' ORDER BY chapter_number")
      .pluck().all()).toEqual([1, 3])
  })
})
