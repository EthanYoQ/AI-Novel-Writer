import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'

import type {
  ExternalFileGrant,
  PortableProjectExportRequest,
  PortableProjectRestoreRequest,
  ProjectChannels,
} from '../../../src/shared/ipc-channels'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  currentProjectPath: 'C:\\projects\\current',
  database: { identity: 'active-database' },
  activeSession: {
    projectId: '11111111-1111-4111-8111-111111111111',
    leaseId: 'lease-current',
    projectPath: 'C:\\projects\\current',
    rootPath: 'C:\\projects\\current',
  },
  exportPortableProject: vi.fn(),
  restorePortableProject: vi.fn(),
  portableAssets: { snapshot: vi.fn() },
  createPortableProjectAssetProvider: vi.fn(),
  registerRecentProject: vi.fn(),
  assertCurrentProjectContext: vi.fn(),
  sameCanonicalProjectRoot: vi.fn(),
  beginSession: vi.fn(),
  invalidateCurrentSession: vi.fn(),
  initProjectDatabase: vi.fn(),
  createProjectDatabase: vi.fn(),
  showSaveDialog: vi.fn(),
  showOpenDialog: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => mocks.handlers.set(channel, handler)),
  },
  dialog: {
    showSaveDialog: mocks.showSaveDialog,
    showOpenDialog: mocks.showOpenDialog,
  },
}))
vi.mock('../../database', () => ({
  getCurrentProjectPath: () => mocks.currentProjectPath,
  getProjectDb: () => mocks.database,
  initProjectDatabase: mocks.initProjectDatabase,
  createProjectDatabase: mocks.createProjectDatabase,
}))
vi.mock('../../services/project-access', () => ({
  projectAccess: {
    assertCurrentProjectContext: mocks.assertCurrentProjectContext,
    sameCanonicalProjectRoot: mocks.sameCanonicalProjectRoot,
    beginSession: mocks.beginSession,
    invalidateCurrentSession: mocks.invalidateCurrentSession,
  },
}))
vi.mock('../../services/project-archive-service', () => ({
  exportPortableProject: mocks.exportPortableProject,
}))
vi.mock('../../services/project-restore-service', () => ({
  restorePortableProject: mocks.restorePortableProject,
}))
vi.mock('../../services/portable-project-assets', () => ({
  createPortableProjectAssetProvider: mocks.createPortableProjectAssetProvider
    .mockReturnValue(mocks.portableAssets),
}))
vi.mock('../project-controller', () => ({
  registerRecentProject: mocks.registerRecentProject,
}))

import { registerProjectArchiveController } from '../project-archive-controller'
import { ExternalFileGrantService } from '../../services/external-file-grant-service'

const SENDER_ID = 17
const OTHER_SENDER_ID = 18
const GRANT_TTL_MS = 10 * 60 * 1_000
const roots: string[] = []
let now = 1_000
const grants = new ExternalFileGrantService({ now: () => now })
const archiveReceipt = {
  originProjectId: '11111111-1111-4111-8111-111111111111',
  snapshotGeneration: 'snapshot-1',
  targetSha256: 'a'.repeat(64),
  targetByteSize: 42,
  sourceEvidence: { schemaVersion: 6, schemaFingerprint: 'schema', tableCount: 1, fieldCount: 2 },
  entryCount: 3,
  requiresRuntimeFreezeGuard: true as const,
}

function handler(channel: keyof ProjectChannels): IpcHandler {
  const registered = mocks.handlers.get(channel)
  if (!registered) throw new Error(`Missing IPC handler: ${channel}`)
  return registered
}

function event(webContentsId = SENDER_ID) {
  return { sender: { id: webContentsId, once: vi.fn() } }
}

function tempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  roots.push(root)
  return root
}

function projectSession() {
  return {
    projectId: mocks.activeSession.projectId,
    leaseId: mocks.activeSession.leaseId,
    projectPath: mocks.activeSession.projectPath,
  }
}

function newTargetGrant(target: string, webContentsId = SENDER_ID): string {
  return grants.issueNewChild({
    webContentsId, filePath: target, operations: ['create'], ttlMs: GRANT_TTL_MS,
  }).grantId
}

function archiveFileGrant(archive: string, operations: Array<'read' | 'create'> = ['read'], webContentsId = SENDER_ID): string {
  fs.writeFileSync(archive, 'archive')
  return grants.issueFile({
    webContentsId, filePath: archive, operations, ttlMs: GRANT_TTL_MS, maxUses: 1,
  }).grantId
}

function createRestoredDatabase(projectRoot: string, projectName = '恢复后的小说'): void {
  const storageRoot = path.join(projectRoot, '.ai-novel')
  fs.mkdirSync(storageRoot, { recursive: true })
  const database = new Database(path.join(storageRoot, 'project.db'))
  try {
    database.exec('CREATE TABLE project_core(id TEXT PRIMARY KEY, project_name TEXT NOT NULL)')
    database.prepare('INSERT INTO project_core(id, project_name) VALUES (?, ?)').run('main', projectName)
  } finally {
    database.close()
  }
}

function restoreReceipt(targetProjectRoot: string) {
  return {
    originProjectId: '11111111-1111-4111-8111-111111111111',
    targetProjectId: '22222222-2222-4222-8222-222222222222',
    targetProjectRoot,
    snapshotGeneration: 'snapshot-1',
    portableDatabaseSha256: 'b'.repeat(64),
    requiresRuntimeFreezeGuard: true as const,
  }
}

const GRANT_REFUSAL = { success: false, error: 'PORTABLE_GRANT_INVALID', errorCode: 'PORTABLE_GRANT_INVALID' }

beforeAll(() => {
  registerProjectArchiveController(grants)
})

beforeEach(() => {
  now = 1_000
  mocks.currentProjectPath = path.resolve('C:/projects/current')
  mocks.database = { identity: 'active-database' }
  mocks.activeSession = {
    projectId: archiveReceipt.originProjectId,
    leaseId: 'lease-current',
    projectPath: mocks.currentProjectPath,
    rootPath: mocks.currentProjectPath,
  }
  mocks.exportPortableProject.mockReset()
  mocks.restorePortableProject.mockReset()
  mocks.registerRecentProject.mockReset()
  mocks.assertCurrentProjectContext.mockReset().mockImplementation((context, currentProjectPath) => {
    if (context.projectId !== mocks.activeSession.projectId
      || context.leaseId !== mocks.activeSession.leaseId
      || context.projectPath !== mocks.activeSession.projectPath
      || currentProjectPath !== mocks.activeSession.rootPath) {
      throw new Error('项目会话已失效，已拒绝操作')
    }
    return mocks.activeSession
  })
  mocks.sameCanonicalProjectRoot.mockReset().mockImplementation((left: string, right: string) => (
    path.resolve(left).toLocaleLowerCase('en-US') === path.resolve(right).toLocaleLowerCase('en-US')
  ))
  mocks.beginSession.mockReset()
  mocks.invalidateCurrentSession.mockReset()
  mocks.initProjectDatabase.mockReset()
  mocks.createProjectDatabase.mockReset()
  mocks.showSaveDialog.mockReset()
  mocks.showOpenDialog.mockReset()
})

afterEach(() => {
  grants.revokeWebContents(SENDER_ID)
  grants.revokeWebContents(OTHER_SENDER_ID)
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('project archive choosers issue sender-bound grants instead of raw paths', () => {
  it('selects constrained archive paths and a fresh restore-copy target as opaque grants', async () => {
    const root = tempRoot('b01-controller-picker-')
    const realRoot = fs.realpathSync.native(root)
    const archive = path.join(root, 'selected.ainovel')
    const sender = event()
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: archive })
    const exportGrant = await handler('dialog:select-project-archive-export')(sender, '项目<>副本') as ExternalFileGrant
    expect(exportGrant).toEqual({ grantId: expect.any(String), displayName: 'selected.ainovel' })
    expect(mocks.showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({
      defaultPath: '项目--副本.ainovel',
      filters: [{ name: 'AI Novel Archive', extensions: ['ainovel'] }],
    }))
    expect(grants.resolveExactPath({ grantId: exportGrant.grantId, webContentsId: SENDER_ID, operation: 'create' }))
      .toBe(path.join(realRoot, 'selected.ainovel'))

    fs.writeFileSync(archive, 'archive')
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [archive] })
    const archiveGrant = await handler('dialog:select-project-archive')(sender) as ExternalFileGrant
    expect(archiveGrant).toEqual({ grantId: expect.any(String), displayName: 'selected.ainovel' })
    expect(grants.resolveExactPath({ grantId: archiveGrant.grantId, webContentsId: SENDER_ID, operation: 'read' }))
      .toBe(path.join(realRoot, 'selected.ainovel'))

    fs.mkdirSync(path.join(root, '恢复副本'))
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [root] })
    const targetGrant = await handler('dialog:select-project-restore-target')(sender, '恢复副本') as ExternalFileGrant
    expect(targetGrant).toEqual({ grantId: expect.any(String), displayName: '恢复副本-2' })
    expect(grants.resolveExactPath({ grantId: targetGrant.grantId, webContentsId: SENDER_ID, operation: 'create' }))
      .toBe(path.join(realRoot, '恢复副本-2'))

    for (const result of [exportGrant, archiveGrant, targetGrant]) {
      expect(JSON.stringify(result)).not.toContain(root)
      expect(result).not.toHaveProperty('path')
    }
  })

  it('returns null and issues nothing when an archive picker is cancelled', async () => {
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: true })
    mocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    await expect(handler('dialog:select-project-archive-export')(event(), '项目')).resolves.toBeNull()
    await expect(handler('dialog:select-project-archive')(event())).resolves.toBeNull()
    await expect(handler('dialog:select-project-restore-target')(event(), '项目')).resolves.toBeNull()
    expect(grants.activeCount()).toBe(0)
  })

  it('revokes every archive grant of a window when that window is destroyed', async () => {
    const root = tempRoot('b01-controller-destroyed-')
    const sender = event()
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: path.join(root, 'selected.ainovel') })
    await handler('dialog:select-project-archive-export')(sender, '项目')
    expect(grants.activeCount()).toBe(1)

    const [eventName, onDestroyed] = sender.sender.once.mock.calls[0] as [string, () => void]
    expect(eventName).toBe('destroyed')
    onDestroyed()
    expect(grants.activeCount()).toBe(0)
  })

  it('registers typed grant-only archive and restore channels', () => {
    expect(mocks.handlers.has('project:archive-export')).toBe(true)
    expect(mocks.handlers.has('project:archive-restore')).toBe(true)
    expect(mocks.handlers.has('dialog:select-project-archive-export')).toBe(true)
    expect(mocks.handlers.has('dialog:select-project-archive')).toBe(true)
    expect(mocks.handlers.has('dialog:select-project-restore-target')).toBe(true)
    expectTypeOf<ProjectChannels['project:archive-export']['args']>()
      .toEqualTypeOf<[request: PortableProjectExportRequest]>()
    expectTypeOf<ProjectChannels['project:archive-restore']['args']>()
      .toEqualTypeOf<[request: PortableProjectRestoreRequest]>()
    expectTypeOf<PortableProjectExportRequest>().toEqualTypeOf<{
      targetArchiveGrantId: string
      projectSession: PortableProjectExportRequest['projectSession']
    }>()
    expectTypeOf<PortableProjectRestoreRequest>().toEqualTypeOf<{
      archiveGrantId: string
      targetGrantId: string
    }>()
    expectTypeOf<ProjectChannels['dialog:select-project-archive-export']['return']>()
      .toEqualTypeOf<ExternalFileGrant | null>()
    expectTypeOf<ProjectChannels['dialog:select-project-archive']['return']>()
      .toEqualTypeOf<ExternalFileGrant | null>()
    expectTypeOf<ProjectChannels['dialog:select-project-restore-target']['return']>()
      .toEqualTypeOf<ExternalFileGrant | null>()
  })
})

describe('project:archive-export', () => {
  it('binds export to the current session, the chooser grant, and the production asset provider', async () => {
    const root = tempRoot('b01-export-flow-')
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: path.join(root, 'current.ainovel') })
    const selected = await handler('dialog:select-project-archive-export')(event(), '项目') as ExternalFileGrant
    mocks.exportPortableProject.mockImplementation(async (input) => {
      expect(await input.assertCurrentContext(input.projectSession, input.sourceProjectRoot)).toBe(true)
      return archiveReceipt
    })
    const sessionBefore = { ...mocks.activeSession }
    const databaseBefore = mocks.database
    const targetArchivePath = path.join(fs.realpathSync.native(root), 'current.ainovel')

    await expect(handler('project:archive-export')(event(), {
      targetArchiveGrantId: selected.grantId,
      projectSession: projectSession(),
    })).resolves.toEqual({ success: true, receipt: archiveReceipt })

    expect(mocks.exportPortableProject).toHaveBeenCalledTimes(1)
    expect(mocks.exportPortableProject).toHaveBeenCalledWith(expect.objectContaining({
      sourceProjectRoot: mocks.activeSession.rootPath,
      targetArchivePath,
      attemptParentPath: path.dirname(targetArchivePath),
      assets: mocks.portableAssets,
    }))
    expect(mocks.createPortableProjectAssetProvider).toHaveBeenCalledTimes(1)
    expect(mocks.assertCurrentProjectContext).toHaveBeenCalledTimes(2)
    expect(mocks.activeSession).toEqual(sessionBefore)
    expect(mocks.database).toBe(databaseBefore)
    expect(mocks.beginSession).not.toHaveBeenCalled()
    expect(mocks.invalidateCurrentSession).not.toHaveBeenCalled()
    expect(mocks.initProjectDatabase).not.toHaveBeenCalled()
    expect(mocks.createProjectDatabase).not.toHaveBeenCalled()
  })

  it('refuses a renderer-supplied raw path and never reaches the export service', async () => {
    const root = tempRoot('b01-export-raw-')
    const rawTarget = path.join(root, 'raw.ainovel')

    await expect(handler('project:archive-export')(event(), {
      targetArchivePath: rawTarget,
      projectSession: projectSession(),
    })).resolves.toEqual(GRANT_REFUSAL)
    await expect(handler('project:archive-export')(event(), {
      targetArchivePath: rawTarget,
      targetArchiveGrantId: 'forged-grant',
      projectSession: projectSession(),
    })).resolves.toEqual(GRANT_REFUSAL)

    expect(mocks.exportPortableProject).not.toHaveBeenCalled()
    expect(fs.existsSync(rawTarget)).toBe(false)
  })

  it('ignores a raw path that accompanies a valid grant and exports only to the granted target', async () => {
    const root = tempRoot('b01-export-ignore-')
    const other = tempRoot('b01-export-other-')
    const grantId = newTargetGrant(path.join(root, 'chosen.ainovel'))
    mocks.exportPortableProject.mockResolvedValueOnce(archiveReceipt)

    await expect(handler('project:archive-export')(event(), {
      targetArchivePath: path.join(other, 'attacker.ainovel'),
      targetArchiveGrantId: grantId,
      projectSession: projectSession(),
    })).resolves.toEqual({ success: true, receipt: archiveReceipt })

    expect(mocks.exportPortableProject).toHaveBeenCalledTimes(1)
    expect(mocks.exportPortableProject).toHaveBeenCalledWith(expect.objectContaining({
      targetArchivePath: path.join(fs.realpathSync.native(root), 'chosen.ainovel'),
    }))
  })

  const invalidGrantCases: Array<{
    name: string
    arrange(root: string): { grantId: string; sender: ReturnType<typeof event> }
  }> = [
    {
      name: 'a grant issued to another window',
      arrange: root => ({ grantId: newTargetGrant(path.join(root, 'a.ainovel')), sender: event(OTHER_SENDER_ID) }),
    },
    {
      name: 'an import-style read grant used for export',
      arrange: root => ({ grantId: archiveFileGrant(path.join(root, 'a.ainovel')), sender: event() }),
    },
    {
      name: 'a directory-scope export grant issued for another purpose',
      arrange: root => ({
        grantId: grants.issueDirectory({
          webContentsId: SENDER_ID, directoryPath: root, operations: ['write', 'create'], ttlMs: GRANT_TTL_MS, maxUses: 4_096,
        }).grantId,
        sender: event(),
      }),
    },
    {
      name: 'an expired grant',
      arrange: root => {
        const grantId = newTargetGrant(path.join(root, 'a.ainovel'))
        now += GRANT_TTL_MS + 1
        return { grantId, sender: event() }
      },
    },
  ]
  it.each(invalidGrantCases)('refuses $name without reaching the export service', async ({ arrange }) => {
    const root = tempRoot('b01-export-negative-')
    const { grantId, sender } = arrange(root)
    const before = fs.readdirSync(root)

    await expect(handler('project:archive-export')(sender, {
      targetArchiveGrantId: grantId,
      projectSession: projectSession(),
    })).resolves.toEqual(GRANT_REFUSAL)

    expect(mocks.exportPortableProject).not.toHaveBeenCalled()
    expect(fs.readdirSync(root)).toEqual(before)
  })

  it('refuses to replay a grant that was already consumed by a successful export', async () => {
    const root = tempRoot('b01-export-replay-')
    const grantId = newTargetGrant(path.join(root, 'once.ainovel'))
    mocks.exportPortableProject.mockResolvedValue(archiveReceipt)
    const request = { targetArchiveGrantId: grantId, projectSession: projectSession() }

    await expect(handler('project:archive-export')(event(), request))
      .resolves.toEqual({ success: true, receipt: archiveReceipt })
    await expect(handler('project:archive-export')(event(), request)).resolves.toEqual(GRANT_REFUSAL)

    expect(mocks.exportPortableProject).toHaveBeenCalledTimes(1)
  })

  it('rejects a stale export context before creating an archive or consuming the grant', async () => {
    const root = tempRoot('b01-export-stale-')
    const grantId = newTargetGrant(path.join(root, 'current.ainovel'))
    mocks.assertCurrentProjectContext.mockImplementationOnce(() => {
      throw new Error('项目会话已失效，已拒绝操作')
    })

    await expect(handler('project:archive-export')(event(), {
      targetArchiveGrantId: grantId,
      projectSession: { ...projectSession(), leaseId: 'stale-lease' },
    })).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('项目会话已失效'),
    })
    expect(mocks.exportPortableProject).not.toHaveBeenCalled()
    expect(grants.activeCount()).toBe(1)
  })

  it('rejects export when the active database root no longer matches the leased project', async () => {
    const root = tempRoot('b01-export-root-')
    const grantId = newTargetGrant(path.join(root, 'current.ainovel'))
    mocks.currentProjectPath = path.resolve('C:/projects/other')

    await expect(handler('project:archive-export')(event(), {
      targetArchiveGrantId: grantId,
      projectSession: projectSession(),
    })).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('项目会话已失效'),
    })
    expect(mocks.exportPortableProject).not.toHaveBeenCalled()
  })

  it('returns the service target-under-source refusal without publishing success', async () => {
    const root = tempRoot('b01-export-inside-')
    mocks.exportPortableProject.mockRejectedValueOnce(Object.assign(
      new Error('PORTABLE_TARGET_INSIDE_SOURCE'),
      { code: 'PORTABLE_TARGET_INSIDE_SOURCE' },
    ))

    await expect(handler('project:archive-export')(event(), {
      targetArchiveGrantId: newTargetGrant(path.join(root, 'backup.ai-novel-project')),
      projectSession: projectSession(),
    })).resolves.toEqual({
      success: false,
      error: 'PORTABLE_TARGET_INSIDE_SOURCE',
      errorCode: 'PORTABLE_TARGET_INSIDE_SOURCE',
    })
  })

  it('preserves an exact schema refusal as a typed IPC error code', async () => {
    const root = tempRoot('b01-export-schema-')
    mocks.exportPortableProject.mockRejectedValueOnce(new Error('PORTABLE_SCHEMA_UNSUPPORTED'))

    await expect(handler('project:archive-export')(event(), {
      targetArchiveGrantId: newTargetGrant(path.join(root, 'current.ai-novel-project')),
      projectSession: projectSession(),
    })).resolves.toEqual({
      success: false,
      error: 'PORTABLE_SCHEMA_UNSUPPORTED',
      errorCode: 'PORTABLE_SCHEMA_UNSUPPORTED',
    })
  })
})

describe('project:archive-restore', () => {
  it('restores from chooser grants without opening the copy and registers its readonly database name as recent', async () => {
    const root = tempRoot('b01-controller-')
    const realRoot = fs.realpathSync.native(root)
    const archive = path.join(root, 'source.ainovel')
    fs.writeFileSync(archive, 'archive')
    const sender = event()
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [archive] })
    const archiveGrant = await handler('dialog:select-project-archive')(sender) as ExternalFileGrant
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [root] })
    const targetGrant = await handler('dialog:select-project-restore-target')(sender, 'restored') as ExternalFileGrant
    const targetProjectRoot = path.join(realRoot, 'restored')
    mocks.restorePortableProject.mockImplementationOnce(async () => {
      createRestoredDatabase(targetProjectRoot)
      return restoreReceipt(targetProjectRoot)
    })
    const sessionBefore = { ...mocks.activeSession }
    const databaseBefore = mocks.database

    await expect(handler('project:archive-restore')(sender, {
      archiveGrantId: archiveGrant.grantId,
      targetGrantId: targetGrant.grantId,
    })).resolves.toMatchObject({
      success: true,
      receipt: restoreReceipt(targetProjectRoot),
      recentProjectUpdated: true,
    })

    expect(mocks.restorePortableProject).toHaveBeenCalledTimes(1)
    expect(mocks.restorePortableProject).toHaveBeenCalledWith({
      archivePath: path.join(realRoot, 'source.ainovel'),
      targetProjectRoot,
    })
    expect(mocks.registerRecentProject).toHaveBeenCalledWith(expect.objectContaining({
      name: '恢复后的小说',
      path: targetProjectRoot,
    }))
    expect(mocks.activeSession).toEqual(sessionBefore)
    expect(mocks.database).toBe(databaseBefore)
    expect(mocks.beginSession).not.toHaveBeenCalled()
    expect(mocks.invalidateCurrentSession).not.toHaveBeenCalled()
    expect(mocks.initProjectDatabase).not.toHaveBeenCalled()
    expect(mocks.createProjectDatabase).not.toHaveBeenCalled()
  })

  it('refuses renderer-supplied raw paths and never reaches the restore service', async () => {
    const root = tempRoot('b01-restore-raw-')
    const archive = path.join(root, 'source.ainovel')
    fs.writeFileSync(archive, 'archive')
    const target = path.join(root, 'attacker-copy')

    await expect(handler('project:archive-restore')(event(), {
      archivePath: archive,
      targetProjectRoot: target,
    })).resolves.toEqual(GRANT_REFUSAL)
    await expect(handler('project:archive-restore')(event(), {
      archivePath: archive,
      targetProjectRoot: target,
      archiveGrantId: 'forged-archive',
      targetGrantId: 'forged-target',
    })).resolves.toEqual(GRANT_REFUSAL)
    await expect(handler('project:archive-restore')(event(), {
      archiveGrantId: archiveFileGrant(path.join(root, 'grant.ainovel')),
      targetProjectRoot: target,
    })).resolves.toEqual(GRANT_REFUSAL)

    expect(mocks.restorePortableProject).not.toHaveBeenCalled()
    expect(fs.existsSync(target)).toBe(false)
  })

  const invalidGrantCases: Array<{
    name: string
    arrange(root: string): { archiveGrantId: string; targetGrantId: string; sender: ReturnType<typeof event> }
  }> = [
    {
      name: 'grants issued to another window',
      arrange: root => ({
        archiveGrantId: archiveFileGrant(path.join(root, 'a.ainovel'), ['read'], OTHER_SENDER_ID),
        targetGrantId: newTargetGrant(path.join(root, 'copy'), OTHER_SENDER_ID),
        sender: event(),
      }),
    },
    {
      name: 'a create-only target grant used as the archive source',
      arrange: root => ({
        archiveGrantId: newTargetGrant(path.join(root, 'a.ainovel')),
        targetGrantId: newTargetGrant(path.join(root, 'copy')),
        sender: event(),
      }),
    },
    {
      name: 'a read-only archive grant used as the restore target',
      arrange: root => ({
        archiveGrantId: archiveFileGrant(path.join(root, 'a.ainovel')),
        targetGrantId: archiveFileGrant(path.join(root, 'b.ainovel')),
        sender: event(),
      }),
    },
    {
      name: 'a directory-scope grant used as the restore target',
      arrange: root => ({
        archiveGrantId: archiveFileGrant(path.join(root, 'a.ainovel')),
        targetGrantId: grants.issueDirectory({
          webContentsId: SENDER_ID, directoryPath: root, operations: ['create', 'read'], ttlMs: GRANT_TTL_MS, maxUses: 1,
        }).grantId,
        sender: event(),
      }),
    },
    {
      name: 'expired grants',
      arrange: root => {
        const archiveGrantId = archiveFileGrant(path.join(root, 'a.ainovel'))
        const targetGrantId = newTargetGrant(path.join(root, 'copy'))
        now += GRANT_TTL_MS + 1
        return { archiveGrantId, targetGrantId, sender: event() }
      },
    },
  ]
  it.each(invalidGrantCases)('refuses $name without reaching the restore service', async ({ arrange }) => {
    const root = tempRoot('b01-restore-negative-')
    const { archiveGrantId, targetGrantId, sender } = arrange(root)
    const before = fs.readdirSync(root)

    await expect(handler('project:archive-restore')(sender, { archiveGrantId, targetGrantId }))
      .resolves.toEqual(GRANT_REFUSAL)

    expect(mocks.restorePortableProject).not.toHaveBeenCalled()
    expect(fs.readdirSync(root)).toEqual(before)
    expect(fs.existsSync(path.join(root, 'copy'))).toBe(false)
  })

  it('requires a fresh selection after a restore attempt consumed its grants', async () => {
    const root = tempRoot('b01-restore-replay-')
    const request = {
      archiveGrantId: archiveFileGrant(path.join(root, 'a.ainovel')),
      targetGrantId: newTargetGrant(path.join(root, 'copy')),
    }
    mocks.restorePortableProject.mockRejectedValueOnce(Object.assign(
      new Error('PORTABLE_RESTORE_INVALID'), { code: 'PORTABLE_RESTORE_INVALID' },
    ))

    await expect(handler('project:archive-restore')(event(), request)).resolves.toEqual({
      success: false, error: 'PORTABLE_RESTORE_INVALID', errorCode: 'PORTABLE_RESTORE_INVALID',
    })
    await expect(handler('project:archive-restore')(event(), request)).resolves.toEqual(GRANT_REFUSAL)

    expect(mocks.restorePortableProject).toHaveBeenCalledTimes(1)
  })

  it('keeps restored data and returns a warning when recent registration fails', async () => {
    const root = tempRoot('b01-controller-warning-')
    const targetProjectRoot = path.join(fs.realpathSync.native(root), 'restored')
    const restoredMarker = path.join(targetProjectRoot, 'restored-data.txt')
    mocks.restorePortableProject.mockImplementationOnce(async () => {
      createRestoredDatabase(targetProjectRoot)
      fs.writeFileSync(restoredMarker, 'restored', 'utf8')
      return restoreReceipt(targetProjectRoot)
    })
    mocks.registerRecentProject.mockImplementationOnce(() => {
      throw new Error('recent-projects locked')
    })

    await expect(handler('project:archive-restore')(event(), {
      archiveGrantId: archiveFileGrant(path.join(root, 'source.ai-novel-project')),
      targetGrantId: newTargetGrant(path.join(root, 'restored')),
    })).resolves.toEqual({
      success: true,
      receipt: restoreReceipt(targetProjectRoot),
      recentProjectUpdated: false,
      warning: '项目已恢复，但最近项目列表暂未更新',
    })
    expect(fs.readFileSync(restoredMarker, 'utf8')).toBe('restored')
  })
})
