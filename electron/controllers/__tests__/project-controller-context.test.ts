import path from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  currentProjectPath: '',
  existingPaths: new Set<string>(),
  initCalls: [] as string[],
  createdVelaDirectories: new Set<string>(),
  failCorePaths: new Set<string>(),
  failInitPaths: new Set<string>(),
  onCoreGet: null as null | (() => void),
  projectCoreGet: vi.fn(),
  projectCoreInit: vi.fn(),
  projectCoreUpdate: vi.fn(),
  closeProjectDatabase: vi.fn(),
  transaction: vi.fn((operation: () => void) => operation),
  writeJsonFile: vi.fn(),
  recentProjects: [] as Array<{ name: string; path: string; updatedAt: string }>,
  rmSync: vi.fn(),
  removeDirectoryWithWindowsRetry: vi.fn(),
  projectAccess: {
    createProject: vi.fn(),
    probeExistingProject: vi.fn(),
    adoptLegacyProject: vi.fn(),
    beginSession: vi.fn(),
    captureCurrentSession: vi.fn(),
    sameCanonicalProjectRoot: vi.fn(),
    assertCurrentSession: vi.fn(),
    assertCurrentProjectContext: vi.fn(),
    authorizeDeletion: vi.fn(),
    invalidateCurrentSession: vi.fn(),
  },
  activeSession: null as null | {
    kind: 'manifest'
    projectId: string
    rootPath: string
    leaseId: string
  },
  leaseSequence: 0,
}))

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler)
    }),
  },
}))

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn((target: string) => mocks.existingPaths.has(path.resolve(target))),
    mkdirSync: vi.fn(),
    rmSync: mocks.rmSync,
    statSync: vi.fn(() => ({ isDirectory: () => true })),
    writeFileSync: vi.fn(),
  },
}))

vi.mock('../../database', () => ({
  closeProjectDatabase: mocks.closeProjectDatabase.mockImplementation(() => {
    mocks.currentProjectPath = ''
  }),
  getCurrentProjectPath: () => mocks.currentProjectPath || null,
  getProjectDb: () => mocks.currentProjectPath
    ? { transaction: mocks.transaction }
    : null,
  initProjectDatabase: vi.fn((projectPath: string) => {
    const resolved = path.resolve(projectPath)
    mocks.initCalls.push(resolved)
    // Mirrors the production initializer's `.vela/vela.db` parent creation.
    mocks.createdVelaDirectories.add(path.join(resolved, '.vela'))
    if (mocks.failInitPaths.has(resolved)) {
      throw new Error(`cannot initialize ${resolved}`)
    }
    mocks.currentProjectPath = resolved
  }),
}))

vi.mock('../../vector-store', () => ({
  closeConnection: vi.fn(),
}))

vi.mock('../../utils/remove-directory', () => ({
  removeDirectoryWithWindowsRetry: mocks.removeDirectoryWithWindowsRetry,
}))

vi.mock('../../utils/config-utils', () => ({
  RECENT_PROJECTS_PATH: 'recent-projects.json',
  readJsonFile: vi.fn(() => mocks.recentProjects),
  writeJsonFile: mocks.writeJsonFile,
}))

vi.mock('../../repositories/project-core-repository', () => ({
  ProjectCoreRepository: {
    get: mocks.projectCoreGet.mockImplementation(() => {
      const callback = mocks.onCoreGet
      if (callback) {
        mocks.onCoreGet = null
        callback()
      }
      if (mocks.failCorePaths.has(mocks.currentProjectPath)) {
        throw new Error(`cannot read ${mocks.currentProjectPath}`)
      }
      return {
        projectName: path.basename(mocks.currentProjectPath),
        genre: '',
        subGenre: '',
        targetAudience: '',
        totalChapters: 100,
        wordsPerChapter: 3000,
        plotStructure: 'three_act',
        narrativePov: 'third_limited',
        coreOutline: '独立核心大纲',
        worldSetting: '独立世界设定',
        protagonistProfile: '独立主角设定',
        synopsis: '',
        worldbuilding: '',
        goldenFinger: '',
        charactersArch: '',
        globalGuidance: '',
        writingStyle: '',
        referenceWorks: '',
        characterStates: '',
      }
    }),
    init: mocks.projectCoreInit,
    update: mocks.projectCoreUpdate,
  },
}))

vi.mock('../../services/project-access', () => ({
  projectAccess: mocks.projectAccess,
}))

import { registerProjectController } from '../project-controller'

function handler(channel: string): IpcHandler {
  const registered = mocks.handlers.get(channel)
  if (!registered) throw new Error(`Missing IPC handler: ${channel}`)
  return registered
}

function projectSession(
  projectId = 'project-A',
  projectPath = projectA,
  leaseId = 'lease-project-A',
) {
  return { projectId, leaseId, projectPath }
}

const projectA = path.resolve('C:/projects/A')
const projectB = path.resolve('C:/projects/B')
const projectC = path.resolve('C:/projects/C')
const projectD = path.resolve('C:/projects/D')
const ordinaryDirectory = path.resolve('C:/ordinary-directory')

beforeAll(() => {
  registerProjectController()
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.currentProjectPath = projectA
  mocks.existingPaths = new Set([
    projectA,
    projectB,
    projectD,
    path.join(projectA, '.vela'),
    path.join(projectB, '.vela'),
    path.join(projectD, '.vela'),
  ])
  mocks.initCalls = []
  mocks.createdVelaDirectories = new Set()
  mocks.failCorePaths = new Set()
  mocks.failInitPaths = new Set()
  mocks.onCoreGet = null
  mocks.leaseSequence = 0
  mocks.activeSession = {
    kind: 'manifest',
    projectId: 'project-A',
    rootPath: projectA,
    leaseId: 'lease-project-A',
  }
  mocks.recentProjects = []
  mocks.rmSync.mockImplementation(() => undefined)
  mocks.removeDirectoryWithWindowsRetry.mockImplementation(async () => undefined)
  mocks.writeJsonFile.mockImplementation((_target: string, data: unknown) => {
    mocks.recentProjects = data as Array<{ name: string; path: string; updatedAt: string }>
  })
  mocks.projectAccess.createProject.mockImplementation((parentPath: string, name: string) => ({
    kind: 'manifest',
    projectId: `project-${name}`,
    rootPath: path.resolve(parentPath, name),
  }))
  mocks.projectAccess.probeExistingProject.mockImplementation((projectPath: string) => ({
    kind: 'manifest',
    projectId: `project-${path.basename(projectPath)}`,
    rootPath: path.resolve(projectPath),
  }))
  mocks.projectAccess.adoptLegacyProject.mockImplementation((project: unknown) => project)
  mocks.projectAccess.beginSession.mockImplementation((project: {
    projectId: string
    rootPath: string
  }) => {
    const session = {
      kind: 'manifest' as const,
      ...project,
      leaseId: `lease-${project.projectId}-${++mocks.leaseSequence}`,
    } as const
    mocks.activeSession = session
    return session
  })
  mocks.projectAccess.captureCurrentSession.mockImplementation(() => (
    mocks.activeSession ? { ...mocks.activeSession } : null
  ))
  mocks.projectAccess.sameCanonicalProjectRoot.mockImplementation((left: string, right: string) => (
    path.resolve(left).toLocaleLowerCase('en-US')
      === path.resolve(right).toLocaleLowerCase('en-US')
  ))
  mocks.projectAccess.assertCurrentSession.mockImplementation((lease: {
    projectId?: string
    leaseId?: string
  }) => {
    const active = mocks.activeSession
    if (
      !active
      || !lease.projectId
      || !lease.leaseId
      || active.projectId !== lease.projectId
      || active.leaseId !== lease.leaseId
    ) {
      throw new Error('项目会话已失效，已拒绝操作')
    }
    return { ...active }
  })
  mocks.projectAccess.assertCurrentProjectContext.mockImplementation((context: {
    projectId?: string
    leaseId?: string
    projectPath?: string
  } | undefined, currentProjectPath: string | null) => {
    if (!context?.projectId || !context.leaseId || !context.projectPath) {
      throw new Error('缺少项目会话上下文，已拒绝操作')
    }
    const active = mocks.activeSession
    if (
      !active
      || active.projectId !== context.projectId
      || active.leaseId !== context.leaseId
      || !mocks.projectAccess.sameCanonicalProjectRoot(active.rootPath, context.projectPath)
    ) {
      throw new Error('项目会话已失效，已拒绝操作')
    }
    if (!currentProjectPath || !mocks.projectAccess.sameCanonicalProjectRoot(context.projectPath, currentProjectPath)) {
      throw new Error('项目会话与当前数据库不匹配，已拒绝操作')
    }
    return { ...active }
  })
  mocks.projectAccess.authorizeDeletion.mockImplementation((lease: unknown, projectPath: string) => {
    const credential = lease as { projectId?: string; leaseId?: string }
    if (!credential.projectId || !credential.leaseId) {
      throw new Error('项目会话已失效，已拒绝操作')
    }
    return path.resolve(projectPath)
  })
  mocks.projectAccess.invalidateCurrentSession.mockImplementation(() => {
    mocks.activeSession = null
  })
})

describe('project controller project identity', () => {
  it('reports the live main-process project database context', async () => {
    await expect(handler('project:get-runtime-context')({})).resolves.toEqual({
      activeProjectPath: projectA,
      dbReady: true,
    })
  })

  it('opens a probe-verified project with its stable identity and a fresh main-process lease', async () => {
    await expect(handler('project:open')({}, projectB, 'request-open-B', projectA))
      .resolves.toMatchObject({
        success: true,
        project: {
          id: 'project-B',
          path: projectB,
          sessionLease: 'lease-project-B-1',
          novelConfig: {
            coreOutline: '独立核心大纲',
            worldSetting: '独立世界设定',
            protagonistProfile: '独立主角设定',
          },
        },
      })
    expect(mocks.projectAccess.probeExistingProject).toHaveBeenCalledWith(projectB)
    expect(mocks.projectAccess.adoptLegacyProject).toHaveBeenCalled()
    expect(mocks.projectAccess.beginSession).toHaveBeenCalled()
  })

  it('reopens the same project with a new lease while preserving its stable ProjectId', async () => {
    const first = await handler('project:open')({}, projectB, 'request-open-B-1', projectA)
    const second = await handler('project:open')({}, projectB, 'request-open-B-2', projectB)

    expect(first).toMatchObject({
      success: true,
      project: { id: 'project-B', sessionLease: 'lease-project-B-1' },
    })
    expect(second).toMatchObject({
      success: true,
      project: { id: 'project-B', sessionLease: 'lease-project-B-2' },
    })
  })

  it('deduplicates recent projects across Windows path casing, separators, and trailing slashes', async () => {
    mocks.recentProjects = [{
      name: 'old A',
      path: 'c:/PROJECTS/A/',
      updatedAt: 'old',
    }]

    await expect(handler('project:open')({}, projectA, 'request-open-A', projectA))
      .resolves.toMatchObject({ success: true })

    expect(mocks.recentProjects).toEqual([
      expect.objectContaining({ path: projectA }),
    ])
  })

  it('serializes concurrent opens and rolls back when the latest request fails', async () => {
    let latestRequest: Promise<unknown> | null = null
    mocks.failCorePaths.add(projectD)
    mocks.onCoreGet = () => {
      latestRequest = handler('project:open')({}, projectD, 'request-D', projectA)
    }

    const olderRequest = handler('project:open')({}, projectB, 'request-B', projectA)
    const olderResult = await olderRequest
    expect(latestRequest).not.toBeNull()
    const latestResult = await latestRequest!

    expect(olderResult).toMatchObject({
      success: false,
      stale: true,
      requestToken: 'request-B',
    })
    expect(latestResult).toMatchObject({
      success: false,
      requestToken: 'request-D',
      activeProjectPath: projectA,
      databaseRestored: true,
      dbReady: true,
    })
    expect(mocks.initCalls).toEqual([projectB, projectA, projectD, projectA])
    expect(mocks.currentProjectPath).toBe(projectA)
  })

  it('rolls a failed open back only to the captured trusted lease root, never the renderer path', async () => {
    mocks.existingPaths.add(ordinaryDirectory)
    mocks.failCorePaths.add(projectD)

    await expect(handler('project:open')(
      {},
      projectD,
      'request-open-D-untrusted-renderer-path',
      ordinaryDirectory,
    )).resolves.toMatchObject({
      success: false,
      requestToken: 'request-open-D-untrusted-renderer-path',
      activeProjectPath: projectA,
      databaseRestored: true,
      dbReady: true,
    })

    // `initProjectDatabase` creates `<root>/.vela/vela.db` in production. A
    // renderer-supplied ordinary directory must never reach that authority.
    expect(mocks.initCalls).toEqual([projectD, projectA])
    expect(mocks.initCalls).not.toContain(ordinaryDirectory)
    expect(mocks.createdVelaDirectories).not.toContain(path.join(ordinaryDirectory, '.vela'))
    expect(mocks.projectAccess.captureCurrentSession).toHaveBeenCalledOnce()
    expect(mocks.activeSession).toMatchObject({
      rootPath: projectA,
      leaseId: 'lease-project-A',
    })
  })

  it('rolls a failed create back only to the captured trusted lease root, never the renderer path', async () => {
    mocks.existingPaths.add(ordinaryDirectory)
    mocks.projectCoreUpdate.mockImplementationOnce(() => {
      throw new Error('cannot initialize project core')
    })

    await expect(handler('project:create')(
      {},
      {
        name: 'C',
        path: path.resolve('C:/projects'),
        genre: 'fantasy',
        targetAudience: 'all',
      },
      'request-create-C-untrusted-renderer-path',
      ordinaryDirectory,
    )).resolves.toMatchObject({
      success: false,
      requestToken: 'request-create-C-untrusted-renderer-path',
      activeProjectPath: projectA,
      databaseRestored: true,
      dbReady: true,
    })

    expect(mocks.initCalls).toEqual([projectC, projectA])
    expect(mocks.initCalls).not.toContain(ordinaryDirectory)
    expect(mocks.createdVelaDirectories).not.toContain(path.join(ordinaryDirectory, '.vela'))
    expect(mocks.projectAccess.captureCurrentSession).toHaveBeenCalledOnce()
  })

  it('returns a typed storage-path error before initializing a rejected project database', async () => {
    mocks.projectAccess.createProject.mockImplementationOnce(() => {
      throw Object.assign(new Error('请改用更靠近磁盘根目录的位置'), {
        code: 'PROJECT_STORAGE_PATH_UNSUPPORTED',
      })
    })

    await expect(handler('project:create')(
      {},
      {
        name: 'C',
        path: path.resolve('C:/projects'),
        genre: 'fantasy',
        targetAudience: 'all',
      },
      'request-create-C-unsafe-storage-path',
      projectA,
    )).resolves.toMatchObject({
      success: false,
      errorCode: 'PROJECT_STORAGE_PATH_UNSUPPORTED',
      databaseRestored: true,
      dbReady: true,
    })

    expect(mocks.initCalls).toEqual([projectA])
    expect(mocks.initCalls).not.toContain(projectC)
  })

  it('creates from a first-ever neutral runtime, returns to no database or lease, then opens explicitly', async () => {
    mocks.currentProjectPath = ''
    mocks.activeSession = null

    const created = await handler('project:create')(
      {},
      {
        name: 'C',
        path: path.resolve('C:/projects'),
        genre: 'fantasy',
        targetAudience: 'all',
      },
      'request-create-C-first-ever',
    )

    expect(created).toMatchObject({
      success: true,
      projectId: 'project-C',
      projectPath: projectC,
      requestToken: 'request-create-C-first-ever',
      activeProjectPath: null,
      databaseRestored: true,
      dbReady: true,
    })
    expect(mocks.currentProjectPath).toBe('')
    expect(mocks.activeSession).toBeNull()
    await expect(handler('project:get-runtime-context')({})).resolves.toEqual({
      activeProjectPath: null,
      dbReady: true,
    })

    await expect(handler('project:open')({}, projectC, 'request-open-created-C'))
      .resolves.toMatchObject({
        success: true,
        project: {
          id: 'project-C',
          path: projectC,
          sessionLease: 'lease-project-C-1',
        },
        activeProjectPath: projectC,
        databaseRestored: true,
        dbReady: true,
      })
    expect(mocks.activeSession).toMatchObject({
      projectId: 'project-C',
      rootPath: projectC,
      leaseId: 'lease-project-C-1',
    })
  })

  it('restores a failed first-ever create to neutral without touching an ordinary renderer path or reviving a lease', async () => {
    mocks.currentProjectPath = ''
    mocks.activeSession = null
    mocks.existingPaths.add(ordinaryDirectory)
    mocks.projectCoreUpdate.mockImplementationOnce(() => {
      throw new Error('cannot initialize project core')
    })

    await expect(handler('project:create')(
      {},
      {
        name: 'C',
        path: path.resolve('C:/projects'),
        genre: 'fantasy',
        targetAudience: 'all',
      },
      'request-create-C-first-ever-failure',
      ordinaryDirectory,
    )).resolves.toMatchObject({
      success: false,
      requestToken: 'request-create-C-first-ever-failure',
      activeProjectPath: null,
      databaseRestored: true,
      dbReady: true,
      error: 'Error: cannot initialize project core',
    })

    expect(mocks.initCalls).toEqual([projectC])
    expect(mocks.initCalls).not.toContain(ordinaryDirectory)
    expect(mocks.createdVelaDirectories).not.toContain(path.join(ordinaryDirectory, '.vela'))
    expect(mocks.currentProjectPath).toBe('')
    expect(mocks.activeSession).toBeNull()
    expect(mocks.projectAccess.beginSession).not.toHaveBeenCalled()
  })

  it('uses the captured trusted root for a stale open instead of creating a database below rendererProjectPath', async () => {
    let latestRequest: Promise<unknown> | null = null
    mocks.existingPaths.add(ordinaryDirectory)
    mocks.failCorePaths.add(projectD)
    mocks.onCoreGet = () => {
      latestRequest = handler('project:open')({}, projectD, 'request-D-after-B', projectA)
    }

    const olderResult = await handler('project:open')(
      {},
      projectB,
      'request-B-before-D',
      ordinaryDirectory,
    )
    expect(latestRequest).not.toBeNull()
    await latestRequest!

    expect(olderResult).toMatchObject({
      success: false,
      stale: true,
      requestToken: 'request-B-before-D',
      activeProjectPath: projectA,
      databaseRestored: true,
      dbReady: true,
    })
    expect(mocks.initCalls).toEqual([projectB, projectA, projectD, projectA])
    expect(mocks.initCalls).not.toContain(ordinaryDirectory)
    expect(mocks.createdVelaDirectories).not.toContain(path.join(ordinaryDirectory, '.vela'))
  })

  it('fails closed rather than reviving an old same-root lease after that lease expires during recovery', async () => {
    mocks.failCorePaths.add(projectD)
    mocks.onCoreGet = () => {
      // Same root, but a later open has already issued a new lease. The old
      // operation's snapshot is no longer trusted even though its path matches.
      mocks.activeSession = {
        kind: 'manifest',
        projectId: 'project-A',
        rootPath: projectA,
        leaseId: 'lease-project-A-new',
      }
    }

    await expect(handler('project:open')(
      {},
      projectD,
      'request-open-D-expired-rollback',
      projectA,
    )).resolves.toMatchObject({
      success: false,
      requestToken: 'request-open-D-expired-rollback',
      activeProjectPath: null,
      databaseRestored: false,
      dbReady: false,
    })

    expect(mocks.initCalls).toEqual([projectD])
    expect(mocks.projectAccess.assertCurrentSession).toHaveBeenCalledWith(expect.objectContaining({
      leaseId: 'lease-project-A',
    }))
    expect(mocks.closeProjectDatabase).toHaveBeenCalledOnce()
    expect(mocks.projectAccess.invalidateCurrentSession).toHaveBeenCalledOnce()
    expect(mocks.activeSession).toBeNull()
  })

  it('fails closed when a failed open has no trusted rollback snapshot', async () => {
    mocks.activeSession = null
    mocks.existingPaths.add(ordinaryDirectory)
    mocks.failCorePaths.add(projectD)

    await expect(handler('project:open')(
      {},
      projectD,
      'request-open-D-no-rollback-snapshot',
      ordinaryDirectory,
    )).resolves.toMatchObject({
      success: false,
      requestToken: 'request-open-D-no-rollback-snapshot',
      activeProjectPath: null,
      databaseRestored: false,
      dbReady: false,
      error: expect.stringContaining('缺少可信项目回滚快照'),
    })

    expect(mocks.initCalls).toEqual([projectD])
    expect(mocks.createdVelaDirectories).not.toContain(path.join(ordinaryDirectory, '.vela'))
    expect(mocks.closeProjectDatabase).toHaveBeenCalledOnce()
    expect(mocks.projectAccess.invalidateCurrentSession).toHaveBeenCalledOnce()
  })

  it('serializes create with open and prevents a stale create from initializing a new database', async () => {
    const creating = handler('project:create')(
      {},
      {
        name: 'C',
        path: path.resolve('C:/projects'),
        genre: 'fantasy',
        targetAudience: 'all',
      },
      'request-create-C',
      projectA,
    )
    const opening = handler('project:open')({}, projectB, 'request-open-B', projectA)

    await expect(creating).resolves.toMatchObject({
      success: false,
      stale: true,
      requestToken: 'request-create-C',
    })
    await expect(opening).resolves.toMatchObject({
      success: true,
      requestToken: 'request-open-B',
      activeProjectPath: projectB,
      databaseRestored: true,
      dbReady: true,
    })
    expect(mocks.initCalls).not.toContain(projectC)
    expect(mocks.currentProjectPath).toBe(projectB)
  })

  it('fails closed when open fails and trusted rollback cannot restore the previous project', async () => {
    mocks.failCorePaths.add(projectD)
    mocks.failInitPaths.add(projectA)

    await expect(handler('project:open')(
      {},
      projectD,
      'request-open-D',
      projectA,
    )).resolves.toMatchObject({
      success: false,
      requestToken: 'request-open-D',
      activeProjectPath: null,
      databaseRestored: false,
      dbReady: false,
      error: expect.stringMatching(/cannot read[\s\S]*cannot initialize/),
    })
    expect(mocks.projectAccess.beginSession).not.toHaveBeenCalled()
    expect(mocks.closeProjectDatabase).toHaveBeenCalledOnce()
    expect(mocks.projectAccess.invalidateCurrentSession).toHaveBeenCalledOnce()
  })

  it('fails closed when create fails and trusted rollback cannot restore the previous project', async () => {
    mocks.projectCoreUpdate.mockImplementationOnce(() => {
      throw new Error('cannot initialize project core')
    })
    mocks.failInitPaths.add(projectA)

    await expect(handler('project:create')(
      {},
      {
        name: 'C',
        path: path.resolve('C:/projects'),
        genre: 'fantasy',
        targetAudience: 'all',
      },
      'request-create-C-fail',
      projectA,
    )).resolves.toMatchObject({
      success: false,
      requestToken: 'request-create-C-fail',
      activeProjectPath: null,
      databaseRestored: false,
      dbReady: false,
      error: expect.stringMatching(/cannot initialize project core[\s\S]*cannot initialize/),
    })
    expect(mocks.projectAccess.beginSession).not.toHaveBeenCalled()
    expect(mocks.closeProjectDatabase).toHaveBeenCalledOnce()
    expect(mocks.projectAccess.invalidateCurrentSession).toHaveBeenCalledOnce()
  })

  it('rejects missing or stale project identities before project config writes', async () => {
    const data = {
      path: projectA,
      sessionLease: 'lease-project-A',
      name: 'Project A',
      novelConfig: {
        genre: 'fantasy',
      },
    }

    const saveWithoutIdentity = await handler('project:save')({}, 'main', data)
    const saveWithStaleIdentity = await handler('project:save')({}, 'main', data, projectB)
    const saveWithMismatchedPayload = await handler('project:save')(
      {},
      'main',
      { ...data, path: projectB },
      projectA,
    )
    const updateWithoutIdentity = await handler('project:update-config')({}, 'main', data)
    const updateWithStaleIdentity = await handler('project:update-config')(
      {},
      'main',
      data,
      projectB,
    )

    expect(saveWithoutIdentity).toMatchObject({ success: false })
    expect(saveWithStaleIdentity).toMatchObject({ success: false })
    expect(saveWithMismatchedPayload).toMatchObject({ success: false })
    expect(updateWithoutIdentity).toMatchObject({ success: false })
    expect(updateWithStaleIdentity).toMatchObject({ success: false })
    expect(mocks.projectCoreUpdate).not.toHaveBeenCalled()
  })

  it('rejects a project config write that omits its session lease even when its path is current', async () => {
    const result = await handler('project:save')({}, 'project-A', {
      path: projectA,
      name: 'Project A',
      novelConfig: { genre: 'fantasy' },
    }, projectA)

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('项目会话'),
    })
    expect(mocks.projectCoreUpdate).not.toHaveBeenCalled()
  })

  it('allows project config writes only for the explicitly active project', async () => {
    const data = {
      path: projectA,
      sessionLease: 'lease-project-A',
      name: 'Project A',
      novelConfig: {
        genre: 'fantasy',
      },
    }

    await expect(handler('project:save')({}, 'project-A', data, projectA, projectSession()))
      .resolves.toMatchObject({ success: true, recentProjectUpdated: true })
    await expect(handler('project:update-config')({}, 'project-A', data, projectA, projectSession()))
      .resolves.toEqual({ success: true })
    expect(mocks.projectCoreUpdate).toHaveBeenCalled()
    expect(mocks.transaction).toHaveBeenCalled()
  })

  it('persists the project creative strategy independently from model settings', async () => {
    const data = {
      path: projectA,
      sessionLease: 'lease-project-A',
      name: 'Project A',
      novelConfig: {
        genre: 'fantasy',
        creativeStrategy: 'consistency-first',
      },
    }

    await expect(handler('project:save')({}, 'project-A', data, projectA, projectSession()))
      .resolves.toMatchObject({ success: true })
    expect(mocks.projectCoreUpdate).toHaveBeenCalledWith(expect.objectContaining({
      creativeStrategy: 'consistency-first',
    }))
  })

  it('does not reset a saved creative strategy during an unrelated partial config write', async () => {
    const data = {
      path: projectA,
      sessionLease: 'lease-project-A',
      novelConfig: { genre: 'mystery' },
    }

    await expect(handler('project:update-config')({}, 'project-A', data, projectA, projectSession()))
      .resolves.toEqual({ success: true })
    expect(mocks.projectCoreUpdate).toHaveBeenCalledOnce()
    expect(mocks.projectCoreUpdate.mock.calls[0]?.[0]).not.toHaveProperty('creativeStrategy')
  })

  it('rejects a supplied stale session lease before a project config write commits', async () => {
    mocks.projectAccess.assertCurrentProjectContext.mockImplementationOnce(() => {
      throw new Error('项目会话已失效，已拒绝操作')
    })
    const data = {
      path: projectA,
      sessionLease: 'stale-lease',
      novelConfig: { genre: 'fantasy' },
    }

    await expect(handler('project:save')({}, 'project-A', data, projectA, projectSession('project-A', projectA, 'stale-lease')))
      .resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('项目会话已失效'),
      })
    expect(mocks.projectCoreUpdate).not.toHaveBeenCalled()
  })

  it('reports the SQLite commit accurately when updating recent projects fails afterward', async () => {
    mocks.writeJsonFile.mockImplementationOnce(() => {
      throw new Error('recent list locked')
    })
    const data = {
      path: projectA,
      sessionLease: 'lease-project-A',
      name: 'Project A',
      characterStates: 'committed',
    }

    await expect(handler('project:save')({}, 'project-A', data, projectA, projectSession())).resolves.toMatchObject({
      success: true,
      recentProjectUpdated: false,
    })
    expect(mocks.projectCoreUpdate).toHaveBeenCalledWith(expect.objectContaining({
      projectName: 'Project A',
      characterStates: 'committed',
    }))
  })

  it('reopens the active database and reports failure when the project directory remains', async () => {
    mocks.removeDirectoryWithWindowsRetry.mockImplementationOnce(() => {
      throw new Error('directory locked')
    })

    await expect(handler('project:delete')({}, projectA, 'project-A', 'lease-project-A', projectSession())).resolves.toMatchObject({
      success: false,
      directoryDeleted: false,
      databaseRestored: true,
      error: expect.stringContaining('directory locked'),
    })
    expect(mocks.initCalls).toContain(projectA)
    expect(mocks.currentProjectPath).toBe(projectA)
    expect(mocks.projectAccess.invalidateCurrentSession).not.toHaveBeenCalled()
  })

  it('reports that the database was not restored after a failed active-project delete', async () => {
    mocks.removeDirectoryWithWindowsRetry.mockImplementationOnce(() => {
      throw new Error('directory locked')
    })
    mocks.failInitPaths.add(projectA)

    await expect(handler('project:delete')({}, projectA, 'project-A', 'lease-project-A', projectSession())).resolves.toMatchObject({
      success: false,
      directoryDeleted: false,
      databaseRestored: false,
      error: expect.stringMatching(/directory locked[\s\S]*cannot initialize/),
    })
    expect(mocks.currentProjectPath).toBe('')
  })

  it('reports deletion success when the directory commit succeeds but recent-list cleanup fails', async () => {
    mocks.removeDirectoryWithWindowsRetry.mockImplementationOnce((target: string) => {
      mocks.existingPaths.delete(path.resolve(target))
    })
    mocks.writeJsonFile.mockImplementationOnce(() => {
      throw new Error('recent list locked')
    })

    await expect(handler('project:delete')({}, projectA, 'project-A', 'lease-project-A', projectSession())).resolves.toMatchObject({
      success: true,
      directoryDeleted: true,
      databaseRestored: false,
      warning: expect.stringContaining('recent list locked'),
    })
    expect(mocks.currentProjectPath).toBe('')
    expect(mocks.projectAccess.invalidateCurrentSession).toHaveBeenCalledOnce()
    expect(mocks.removeDirectoryWithWindowsRetry).toHaveBeenCalledWith(projectA)
  })

  it('rejects deletion without a current project session context before touching the filesystem', async () => {
    await expect(handler('project:delete')({}, projectA)).resolves.toMatchObject({
      success: false,
      directoryDeleted: false,
      error: expect.stringContaining('缺少项目会话上下文'),
    })
    expect(mocks.removeDirectoryWithWindowsRetry).not.toHaveBeenCalled()
  })

  it('rejects a stale session context for deletion even when the same project path is still open', async () => {
    mocks.projectAccess.assertCurrentProjectContext.mockImplementationOnce(() => {
      throw new Error('项目会话已失效，已拒绝操作')
    })

    await expect(handler('project:delete')(
      {},
      projectA,
      'project-A',
      'legacy-lease-argument',
      projectSession('project-A', projectA, 'stale-lease'),
    )).resolves.toMatchObject({
      success: false,
      directoryDeleted: false,
      error: expect.stringContaining('项目会话已失效'),
    })
    expect(mocks.removeDirectoryWithWindowsRetry).not.toHaveBeenCalled()
  })

  it('rejects a leased deletion when its project is no longer the active database root', async () => {
    mocks.currentProjectPath = projectB

    await expect(handler('project:delete')({}, projectA, 'project-A', 'lease-project-A', projectSession('project-A', projectA)))
      .resolves.toMatchObject({
        success: false,
        directoryDeleted: false,
        error: expect.stringContaining('当前数据库'),
      })
    expect(mocks.removeDirectoryWithWindowsRetry).not.toHaveBeenCalled()
  })
})
