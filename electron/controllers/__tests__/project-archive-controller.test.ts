import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'

import type {
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

const roots: string[] = []
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

beforeAll(() => {
  registerProjectArchiveController()
})

beforeEach(() => {
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
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('project archive controller', () => {
  it('selects constrained archive paths and a fresh restore-copy target', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b01-controller-picker-'))
    roots.push(root)
    const archive = path.join(root, 'selected.ainovel')
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: archive })
    await expect(handler('dialog:select-project-archive-export')({}, '项目<>副本'))
      .resolves.toBe(archive)
    expect(mocks.showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({
      defaultPath: '项目--副本.ainovel',
      filters: [{ name: 'AI Novel Archive', extensions: ['ainovel'] }],
    }))

    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [archive] })
    await expect(handler('dialog:select-project-archive')({})).resolves.toBe(archive)

    fs.mkdirSync(path.join(root, '恢复副本'))
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [root] })
    await expect(handler('dialog:select-project-restore-target')({}, '恢复副本'))
      .resolves.toBe(path.join(root, '恢复副本-2'))
  })

  it('returns null when an archive picker is cancelled', async () => {
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: true })
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    await expect(handler('dialog:select-project-archive-export')({}, '项目')).resolves.toBeNull()
    await expect(handler('dialog:select-project-archive')({})).resolves.toBeNull()
  })

  it('registers typed explicit-path archive and restore channels', () => {
    expect(mocks.handlers.has('project:archive-export')).toBe(true)
    expect(mocks.handlers.has('project:archive-restore')).toBe(true)
    expect(mocks.handlers.has('dialog:select-project-archive-export')).toBe(true)
    expect(mocks.handlers.has('dialog:select-project-archive')).toBe(true)
    expect(mocks.handlers.has('dialog:select-project-restore-target')).toBe(true)
    expectTypeOf<ProjectChannels['project:archive-export']['args']>()
      .toEqualTypeOf<[request: PortableProjectExportRequest]>()
    expectTypeOf<ProjectChannels['project:archive-restore']['args']>()
      .toEqualTypeOf<[request: PortableProjectRestoreRequest]>()
  })

  it('binds export to the current session and consumes the production asset provider', async () => {
    mocks.exportPortableProject.mockImplementation(async (input) => {
      expect(await input.assertCurrentContext(input.projectSession, input.sourceProjectRoot)).toBe(true)
      return archiveReceipt
    })
    const sessionBefore = { ...mocks.activeSession }
    const databaseBefore = mocks.database
    const targetArchivePath = path.resolve('C:/backups/current.ai-novel-project')

    await expect(handler('project:archive-export')({}, {
      targetArchivePath,
      projectSession: {
        projectId: mocks.activeSession.projectId,
        leaseId: mocks.activeSession.leaseId,
        projectPath: mocks.activeSession.projectPath,
      },
    })).resolves.toEqual({ success: true, receipt: archiveReceipt })

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

  it('rejects a stale export context before creating an archive', async () => {
    mocks.assertCurrentProjectContext.mockImplementationOnce(() => {
      throw new Error('项目会话已失效，已拒绝操作')
    })

    await expect(handler('project:archive-export')({}, {
      targetArchivePath: path.resolve('C:/backups/current.ai-novel-project'),
      projectSession: {
        projectId: mocks.activeSession.projectId,
        leaseId: 'stale-lease',
        projectPath: mocks.activeSession.projectPath,
      },
    })).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('项目会话已失效'),
    })
    expect(mocks.exportPortableProject).not.toHaveBeenCalled()
  })

  it('rejects export when the active database root no longer matches the leased project', async () => {
    mocks.currentProjectPath = path.resolve('C:/projects/other')

    await expect(handler('project:archive-export')({}, {
      targetArchivePath: path.resolve('C:/backups/current.ai-novel-project'),
      projectSession: {
        projectId: mocks.activeSession.projectId,
        leaseId: mocks.activeSession.leaseId,
        projectPath: mocks.activeSession.projectPath,
      },
    })).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('项目会话已失效'),
    })
    expect(mocks.exportPortableProject).not.toHaveBeenCalled()
  })

  it('returns the service target-under-source refusal without publishing success', async () => {
    mocks.exportPortableProject.mockRejectedValueOnce(Object.assign(
      new Error('PORTABLE_TARGET_INSIDE_SOURCE'),
      { code: 'PORTABLE_TARGET_INSIDE_SOURCE' },
    ))
    const targetArchivePath = path.join(mocks.activeSession.rootPath, 'backup.ai-novel-project')

    await expect(handler('project:archive-export')({}, {
      targetArchivePath,
      projectSession: {
        projectId: mocks.activeSession.projectId,
        leaseId: mocks.activeSession.leaseId,
        projectPath: mocks.activeSession.projectPath,
      },
    })).resolves.toEqual({
      success: false,
      error: 'PORTABLE_TARGET_INSIDE_SOURCE',
      errorCode: 'PORTABLE_TARGET_INSIDE_SOURCE',
    })
  })

  it('preserves an exact schema refusal as a typed IPC error code', async () => {
    mocks.exportPortableProject.mockRejectedValueOnce(new Error('PORTABLE_SCHEMA_UNSUPPORTED'))

    await expect(handler('project:archive-export')({}, {
      targetArchivePath: path.resolve('C:/backups/current.ai-novel-project'),
      projectSession: {
        projectId: mocks.activeSession.projectId,
        leaseId: mocks.activeSession.leaseId,
        projectPath: mocks.activeSession.projectPath,
      },
    })).resolves.toEqual({
      success: false,
      error: 'PORTABLE_SCHEMA_UNSUPPORTED',
      errorCode: 'PORTABLE_SCHEMA_UNSUPPORTED',
    })
  })

  it('restores without opening the copy and registers its readonly database name as recent', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b01-controller-'))
    roots.push(root)
    const targetProjectRoot = path.join(root, 'restored')
    mocks.restorePortableProject.mockImplementationOnce(async () => {
      createRestoredDatabase(targetProjectRoot)
      return restoreReceipt(targetProjectRoot)
    })
    const sessionBefore = { ...mocks.activeSession }
    const databaseBefore = mocks.database

    await expect(handler('project:archive-restore')({}, {
      archivePath: path.join(root, 'source.ai-novel-project'),
      targetProjectRoot,
    })).resolves.toMatchObject({
      success: true,
      receipt: restoreReceipt(targetProjectRoot),
      recentProjectUpdated: true,
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

  it('keeps restored data and returns a warning when recent registration fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b01-controller-warning-'))
    roots.push(root)
    const targetProjectRoot = path.join(root, 'restored')
    const restoredMarker = path.join(targetProjectRoot, 'restored-data.txt')
    mocks.restorePortableProject.mockImplementationOnce(async () => {
      createRestoredDatabase(targetProjectRoot)
      fs.writeFileSync(restoredMarker, 'restored', 'utf8')
      return restoreReceipt(targetProjectRoot)
    })
    mocks.registerRecentProject.mockImplementationOnce(() => {
      throw new Error('recent-projects locked')
    })

    await expect(handler('project:archive-restore')({}, {
      archivePath: path.join(root, 'source.ai-novel-project'),
      targetProjectRoot,
    })).resolves.toEqual({
      success: true,
      receipt: restoreReceipt(targetProjectRoot),
      recentProjectUpdated: false,
      warning: '项目已恢复，但最近项目列表暂未更新',
    })
    expect(fs.readFileSync(restoredMarker, 'utf8')).toBe('restored')
  })
})
