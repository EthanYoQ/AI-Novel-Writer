import { ipcMain, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { readJsonFile, writeJsonFile, RECENT_PROJECTS_PATH } from '../utils/config-utils'
import { removeDirectoryWithWindowsRetry } from '../utils/remove-directory'
import { ProjectData, type ProjectSessionContext } from '../../src/shared/ipc-channels'
import { DIR_PROMPTS } from '../../src/shared/project-paths'
import { sameProjectPathKey } from '../../src/shared/project-session-context'
import {
  closeProjectDatabase,
  getCurrentProjectPath,
  getProjectDb,
  initProjectDatabase,
} from '../database'
import { closeConnection as closeVectorConnection } from '../vector-store'
import { ProjectCoreRepository } from '../repositories/project-core-repository'
import { projectAccess, type ProjectSessionLease } from '../services/project-access'
import { assertExpectedProjectPath, assertRequiredExpectedProjectPath } from '../utils/project-context'
import { sanitizeProjectName } from './project-path'
import { projectStoragePreflightFailure } from '../services/project-storage-preflight'

interface RecentProject {
  name: string
  path: string
  updatedAt: string
}

let latestProjectOpenRequestToken: string | null = null
let projectOpenQueue: Promise<void> = Promise.resolve()

function serializeProjectOpen<T>(operation: () => Promise<T>): Promise<T> {
  const result = projectOpenQueue.then(operation, operation)
  projectOpenQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

function yieldToPendingOpenRequests(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

interface ProjectDatabaseState {
  databaseRestored: boolean
  dbReady: boolean
  activeProjectPath: string | null
}

/**
 * A rollback boundary may only use authority observed and validated by the
 * main process before this create/open operation changes the database. The
 * renderer's remembered path is response metadata, never restoration input.
 */
interface TrustedProjectRollbackSnapshot {
  session: ProjectSessionLease
  rootPath: string
  databaseRoot: string
}

type ProjectRollbackBoundary =
  | { kind: 'trusted'; snapshot: TrustedProjectRollbackSnapshot }
  | { kind: 'neutral' }
  | { kind: 'untrusted' }

function sameProjectPath(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right
  return projectAccess.sameCanonicalProjectRoot(left, right)
}

// 最近项目是导航元数据，删除后目录可能已经不存在，不能只依赖 realpath。
// 用主进程 canonical root 优先，失败时退回与渲染端一致的 Windows 词法路径键。
function sameRecentProjectPath(left: string, right: string): boolean {
  return sameProjectPath(left, right) || sameProjectPathKey(left, right)
}

/** 项目配置读写必须显式携带当前会话租约，路径本身不是授权。 */
function assertRequiredProjectSession(
  projectId: string,
  data: Partial<ProjectData>,
  currentProjectPath: string | null,
  context: ProjectSessionContext | undefined,
): void {
  if (!context) {
    throw new Error('缺少项目会话上下文，已拒绝操作')
  }
  if (
    !projectId
    || context.projectId !== projectId
    || (data.id && data.id !== projectId)
    || (data.sessionLease !== undefined && data.sessionLease !== context.leaseId)
  ) {
    throw new Error('项目身份不匹配，已拒绝操作')
  }
  const active = projectAccess.assertCurrentProjectContext(context, currentProjectPath)
  if (
    !sameProjectPath(active.rootPath, currentProjectPath)
    || (data.path !== undefined && !sameProjectPath(active.rootPath, data.path))
  ) {
    throw new Error('项目会话根目录不匹配，已拒绝操作')
  }
}

function databaseStateFor(expectedProjectPath: string | null): ProjectDatabaseState {
  const activeProjectPath = getCurrentProjectPath()
  const dbReady = getProjectDb() !== null
    && sameProjectPath(activeProjectPath, expectedProjectPath)
  return {
    databaseRestored: dbReady,
    dbReady,
    activeProjectPath,
  }
}

function failedDatabaseState(): ProjectDatabaseState {
  // 回滚快照缺失、过期或恢复失败时，不能留下指向半切换项目的数据库或租约。
  // close 先于 invalidate，避免后续 IPC 将旧租约误认为仍可写。
  try {
    closeProjectDatabase()
  } catch (closeError) {
    console.error('[Project] 关闭不可信项目数据库失败:', closeError)
  } finally {
    projectAccess.invalidateCurrentSession()
  }
  return {
    databaseRestored: false,
    dbReady: false,
    activeProjectPath: getCurrentProjectPath(),
  }
}

function neutralDatabaseState(): ProjectDatabaseState {
  const activeProjectPath = getCurrentProjectPath()
  const neutral = activeProjectPath === null
    && getProjectDb() === null
    && projectAccess.captureCurrentSession() === null
  return {
    databaseRestored: neutral,
    dbReady: neutral,
    activeProjectPath,
  }
}

function requireReadyDatabase(
  databaseState: ProjectDatabaseState,
  message: string,
): ProjectDatabaseState {
  if (!databaseState.databaseRestored || !databaseState.dbReady) {
    throw new Error(message)
  }
  return databaseState
}

function captureProjectRollbackBoundary(): ProjectRollbackBoundary {
  const databaseRoot = getCurrentProjectPath()
  const database = getProjectDb()
  const capturedSession = projectAccess.captureCurrentSession()
  if (!databaseRoot && !database && !capturedSession) return { kind: 'neutral' }
  if (!databaseRoot || !database || !capturedSession) return { kind: 'untrusted' }

  try {
    const activeSession = projectAccess.assertCurrentSession(capturedSession)
    if (
      !sameProjectPath(activeSession.rootPath, capturedSession.rootPath)
      || !sameProjectPath(activeSession.rootPath, databaseRoot)
    ) {
      return { kind: 'untrusted' }
    }

    return {
      kind: 'trusted',
      snapshot: Object.freeze({
        session: Object.freeze({ ...activeSession }),
        rootPath: activeSession.rootPath,
        databaseRoot,
      }),
    }
  } catch {
    return { kind: 'untrusted' }
  }
}

function restoreTrustedProjectDatabase(
  snapshot: TrustedProjectRollbackSnapshot,
): ProjectDatabaseState {
  // A matching path is not enough: reopening it creates a fresh lease. Check
  // the frozen lease before any filesystem/database side effect.
  const activeSession = projectAccess.assertCurrentSession(snapshot.session)
  if (
    !sameProjectPath(activeSession.rootPath, snapshot.rootPath)
    || !sameProjectPath(snapshot.databaseRoot, snapshot.rootPath)
  ) {
    throw new Error('项目回滚快照已失效，已拒绝恢复数据库')
  }

  initProjectDatabase(snapshot.rootPath)
  const restoredSession = projectAccess.assertCurrentProjectContext({
    projectId: snapshot.session.projectId,
    leaseId: snapshot.session.leaseId,
    projectPath: snapshot.rootPath,
  }, getCurrentProjectPath())
  if (!sameProjectPath(restoredSession.rootPath, snapshot.rootPath)) {
    throw new Error('项目回滚会话根目录不匹配，已拒绝恢复数据库')
  }
  return databaseStateFor(snapshot.rootPath)
}

function databaseStateForRollbackBoundary(
  boundary: ProjectRollbackBoundary,
): ProjectDatabaseState {
  if (boundary.kind === 'trusted') return databaseStateFor(boundary.snapshot.rootPath)
  if (boundary.kind === 'neutral') return neutralDatabaseState()
  return failedDatabaseState()
}

function restoreProjectRollbackBoundary(
  boundary: ProjectRollbackBoundary,
): ProjectDatabaseState {
  if (boundary.kind === 'trusted') {
    return restoreTrustedProjectDatabase(boundary.snapshot)
  }
  if (boundary.kind === 'untrusted') {
    throw new Error('缺少可信项目回滚快照，已拒绝恢复数据库')
  }

  // 首次启动没有旧项目可恢复。创建只负责落盘，因此显式关闭刚创建的
  // 数据库并清空租约，保持 renderer 随后调用 project:open 前的中立态。
  closeProjectDatabase()
  projectAccess.invalidateCurrentSession()
  const databaseState = neutralDatabaseState()
  if (!databaseState.databaseRestored || !databaseState.dbReady) {
    throw new Error('未能恢复无项目数据库与无租约的中立态')
  }
  return databaseState
}

function loadRecentProjects(): RecentProject[] {
  return readJsonFile<RecentProject[]>(RECENT_PROJECTS_PATH, [])
}

function addRecentProject(project: RecentProject) {
  const list = loadRecentProjects()
  const filtered = list.filter((p) => !sameRecentProjectPath(p.path, project.path))
  filtered.unshift(project)
  const trimmed = filtered.slice(0, 20)
  writeJsonFile(RECENT_PROJECTS_PATH, trimmed)
}

function removeRecentProject(projectPath: string) {
  const filtered = loadRecentProjects().filter((p) => !sameRecentProjectPath(p.path, projectPath))
  writeJsonFile(RECENT_PROJECTS_PATH, filtered)
}

export function registerProjectController() {
  ipcMain.handle('project:get-runtime-context', async () => {
    const activeProjectPath = getCurrentProjectPath()
    const database = getProjectDb()
    return {
      activeProjectPath,
      dbReady: activeProjectPath === null ? database === null : database !== null,
    }
  })

  ipcMain.handle('project:smoke-open-request', async () => {
    const projectPath = process.env.AI_NOVEL_SMOKE_OPEN_PROJECT?.trim()
    const markerPath = process.env.AI_NOVEL_SMOKE_PROJECT_MARKER?.trim()
    return projectPath && markerPath ? { projectPath, markerPath } : null
  })

  ipcMain.handle('project:smoke-open-confirm', async (_event, projectPath: string) => {
    try {
      const requestedProjectPath = process.env.AI_NOVEL_SMOKE_OPEN_PROJECT?.trim()
      const markerPath = process.env.AI_NOVEL_SMOKE_PROJECT_MARKER?.trim()
      const currentProjectPath = getCurrentProjectPath()
      if (
        !requestedProjectPath
        || !markerPath
        || !currentProjectPath
        || path.resolve(projectPath) !== path.resolve(requestedProjectPath)
        || path.resolve(currentProjectPath) !== path.resolve(requestedProjectPath)
      ) {
        return { success: false, error: '烟测项目未在应用中成功打开' }
      }
      fs.writeFileSync(markerPath, JSON.stringify({
        projectPath: path.resolve(currentProjectPath),
        openedAt: new Date().toISOString(),
      }), 'utf8')
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // 创建新项目
  ipcMain.handle('project:create', async (
    _event,
    config: {
      name: string; path: string; genre: string; targetAudience: string
    },
    requestToken: string,
  ) => {
    latestProjectOpenRequestToken = requestToken
    return serializeProjectOpen(async () => {
      await yieldToPendingOpenRequests()
      const isLatestRequest = () => latestProjectOpenRequestToken === requestToken
      const rollbackBoundary = captureProjectRollbackBoundary()
      if (!isLatestRequest()) {
        const databaseState = databaseStateForRollbackBoundary(rollbackBoundary)
        return {
          success: false,
          projectId: '',
          requestToken,
          stale: true,
          ...databaseState,
        }
      }

      try {
        const projectName = sanitizeProjectName(config.name)
        const createdProject = projectAccess.createProject(config.path, projectName)
        const projectId = createdProject.projectId
        const projectDir = createdProject.rootPath

        fs.mkdirSync(path.join(projectDir, DIR_PROMPTS), { recursive: true })
        initProjectDatabase(projectDir)
        ProjectCoreRepository.init(projectName)
        ProjectCoreRepository.update({
          genre: config.genre,
          targetAudience: config.targetAudience,
        })

        const updatedAt = new Date().toISOString()
        if (!isLatestRequest()) {
          let databaseState: ProjectDatabaseState
          try {
            databaseState = requireReadyDatabase(
              restoreProjectRollbackBoundary(rollbackBoundary),
              '过期创建请求未能恢复可信项目数据库',
            )
          } catch (restoreError) {
            databaseState = failedDatabaseState()
            return {
              success: false,
              projectId: '',
              requestToken,
              stale: true,
              ...databaseState,
              error: String(restoreError),
            }
          }
          return {
            success: false,
            projectId: '',
            requestToken,
            stale: true,
            ...databaseState,
          }
        }

        addRecentProject({
          name: projectName,
          path: projectDir,
          updatedAt,
        })
        // 创建只提交磁盘数据；渲染进程随后通过同一串行队列执行打开。
        // 在此之前恢复旧项目，避免主进程与仍显示旧项目的界面身份分裂。
        const databaseState = requireReadyDatabase(
          restoreProjectRollbackBoundary(rollbackBoundary),
          '创建项目后未能恢复可信项目数据库',
        )
        return {
          success: true,
          projectId,
          projectPath: projectDir,
          requestToken,
          ...databaseState,
        }
      } catch (error) {
        let rollbackError: unknown
        let databaseState: ProjectDatabaseState
        try {
          databaseState = requireReadyDatabase(
            restoreProjectRollbackBoundary(rollbackBoundary),
            '创建失败后未能恢复可信项目数据库',
          )
        } catch (restoreError) {
          rollbackError = restoreError
          databaseState = failedDatabaseState()
        }
        return {
          success: false,
          projectId: '',
          requestToken,
          ...databaseState,
          ...(projectStoragePreflightFailure(error) ?? {}),
          error: rollbackError
            ? `${String(error)}；回滚失败：${String(rollbackError)}`
            : String(error),
        }
      }
    })
  })

  // 打开现有项目
  ipcMain.handle('project:open', async (
    _event,
    projectPath: string,
    requestToken: string,
  ) => {
    latestProjectOpenRequestToken = requestToken
    return serializeProjectOpen(async () => {
      // 让已经发出的后续打开请求先登记身份，避免旧请求抢先切换全局数据库。
      await yieldToPendingOpenRequests()
      const isLatestRequest = () => latestProjectOpenRequestToken === requestToken
      const rollbackBoundary = captureProjectRollbackBoundary()
      if (!isLatestRequest()) {
        const databaseState = databaseStateForRollbackBoundary(rollbackBoundary)
        return {
          success: false,
          project: null,
          requestToken,
          stale: true,
          ...databaseState,
        }
      }

      try {
        // Probe 是只读的：普通目录不能因一次打开被初始化成项目。
        const trustedProject = projectAccess.adoptLegacyProject(
          projectAccess.probeExistingProject(projectPath),
        )
        const resolvedProjectPath = trustedProject.rootPath
        initProjectDatabase(resolvedProjectPath)

        // 从数据库读取配置
        const coreData = ProjectCoreRepository.get()
        if (!coreData) {
          // 如果是从空目录新建并打开，尝试初始化
          const folderName = path.basename(resolvedProjectPath)
          ProjectCoreRepository.init(folderName)
        }

        // 组装返回给前端的数据结构
        const updatedCoreData = ProjectCoreRepository.get()!
        const projectData: ProjectData = {
          id: trustedProject.projectId,
          name: updatedCoreData.projectName,
          path: resolvedProjectPath,
          novelConfig: {
            genre: updatedCoreData.genre,
            subGenre: updatedCoreData.subGenre,
            targetAudience: updatedCoreData.targetAudience,
            totalChapters: updatedCoreData.totalChapters,
            wordsPerChapter: updatedCoreData.wordsPerChapter,
            creativeStrategy: updatedCoreData.creativeStrategy,
            plotStructure: updatedCoreData.plotStructure as 'three_act' | 'heros_journey' | 'save_the_cat' | 'kishotenketsu' | 'multi_thread' | 'freeform',
            narrativePOV: updatedCoreData.narrativePov as 'third_limited' | 'first_person' | 'third_omniscient' | 'multi_pov',
            coreOutline: updatedCoreData.coreOutline,
            worldSetting: updatedCoreData.worldSetting,
            goldenFinger: updatedCoreData.goldenFinger,
            protagonistProfile: updatedCoreData.protagonistProfile,
            globalGuidance: updatedCoreData.globalGuidance,
            writingStyle: updatedCoreData.writingStyle,
            referenceWorks: updatedCoreData.referenceWorks,
          },
          characterStates: updatedCoreData.characterStates,
          createdAt: new Date().toISOString(), // 数据库中实际上有，但这里先提供时间值避免前端报错
          updatedAt: new Date().toISOString(),
        }

        // 初始化与读取期间若同步触发了更新请求，旧事务必须恢复渲染进程仍展示的项目。
        // 此处不再主动让出事件循环，避免其他项目级进程通信观察到尚未提交的数据库连接。
        if (!isLatestRequest()) {
          let databaseState: ProjectDatabaseState
          try {
            databaseState = requireReadyDatabase(
              restoreProjectRollbackBoundary(rollbackBoundary),
              '过期打开请求未能恢复可信项目数据库',
            )
          } catch (restoreError) {
            databaseState = failedDatabaseState()
            return {
              success: false,
              project: null,
              requestToken,
              stale: true,
              ...databaseState,
              error: String(restoreError),
            }
          }
          return {
            success: false,
            project: null,
            requestToken,
            stale: true,
            ...databaseState,
          }
        }

        addRecentProject({
          name: projectData.name,
          path: resolvedProjectPath,
          updatedAt: projectData.updatedAt,
        })

        const databaseState = requireReadyDatabase(
          databaseStateFor(resolvedProjectPath),
          '项目数据库初始化后未处于可用状态',
        )
        const session = projectAccess.beginSession(trustedProject)
        projectData.sessionLease = session.leaseId
        return {
          success: true,
          project: projectData,
          requestToken,
          ...databaseState,
        }
      } catch (error) {
        let rollbackError: unknown
        let databaseState: ProjectDatabaseState
        try {
          databaseState = requireReadyDatabase(
            restoreProjectRollbackBoundary(rollbackBoundary),
            '打开失败后未能恢复可信项目数据库',
          )
        } catch (restoreError) {
          rollbackError = restoreError
          databaseState = failedDatabaseState()
        }
        const errorMessage = rollbackError
          ? `${String(error)}；回滚失败：${String(rollbackError)}`
          : String(error)
        return {
          success: false,
          project: null,
          requestToken,
          ...databaseState,
          ...(projectStoragePreflightFailure(error) ?? {}),
          error: errorMessage,
        }
      }
    })
  })

  // 保存/更新项目配置
  // 注意：这个接口前端可能还传入许多小说配置字段，需要映射到数据库。
  ipcMain.handle('project:save', async (
    _event,
    _projectId: string,
    data: Partial<ProjectData>,
    expectedProjectPath?: string,
    context?: ProjectSessionContext,
  ) => {
    try {
      if (!data.path) return { success: false, error: '缺少项目路径' }
      assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
      assertExpectedProjectPath(data.path, expectedProjectPath)
      assertRequiredProjectSession(_projectId, data, getCurrentProjectPath(), context)

      const coreUpdate: Parameters<typeof ProjectCoreRepository.update>[0] = {}
      if (data.novelConfig) {
        Object.assign(coreUpdate, {
          genre: data.novelConfig.genre,
          subGenre: data.novelConfig.subGenre,
          targetAudience: data.novelConfig.targetAudience,
          totalChapters: data.novelConfig.totalChapters,
          wordsPerChapter: data.novelConfig.wordsPerChapter,
          ...(data.novelConfig.creativeStrategy
            ? { creativeStrategy: data.novelConfig.creativeStrategy }
            : {}),
          plotStructure: data.novelConfig.plotStructure,
          narrativePov: data.novelConfig.narrativePOV,
          goldenFinger: data.novelConfig.goldenFinger,
          globalGuidance: data.novelConfig.globalGuidance,
          coreOutline: data.novelConfig.coreOutline,
          worldSetting: data.novelConfig.worldSetting,
          protagonistProfile: data.novelConfig.protagonistProfile,
          writingStyle: data.novelConfig.writingStyle ?? '',
          referenceWorks: data.novelConfig.referenceWorks ?? '',
        })
      }

      if (data.name) {
        coreUpdate.projectName = data.name
      }

      if (data.characterStates !== undefined) {
        coreUpdate.characterStates = data.characterStates
      }

      const db = getProjectDb()
      if (!db) throw new Error('项目数据库未打开')
      db.transaction(() => {
        ProjectCoreRepository.update(coreUpdate)
      })()

      // 最近项目是导航便利数据，不属于项目核心提交。写入失败不能把已经
      // 已提交的数据库保存即使被误报为失败，也不能让渲染进程保留过期草稿。
      try {
        addRecentProject({
          name: data.name ?? ProjectCoreRepository.get()?.projectName ?? 'Unknown',
          path: data.path,
          updatedAt: new Date().toISOString(),
        })
        return { success: true, recentProjectUpdated: true }
      } catch (recentProjectError) {
        console.warn('[Project] 项目核心数据已保存，但最近项目列表更新失败:', recentProjectError)
        return {
          success: true,
          recentProjectUpdated: false,
          warning: '项目已保存，但最近项目列表暂未更新',
        }
      }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // 项目配置更新遵循相同规则。
  ipcMain.handle('project:update-config', async (
    _event,
    _projectId: string,
    data: Partial<ProjectData>,
    expectedProjectPath?: string,
    context?: ProjectSessionContext,
  ) => {
    try {
      assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
      assertRequiredProjectSession(_projectId, data, getCurrentProjectPath(), context)
      if (data.novelConfig) {
        ProjectCoreRepository.update({
          genre: data.novelConfig.genre,
          subGenre: data.novelConfig.subGenre,
          targetAudience: data.novelConfig.targetAudience,
          totalChapters: data.novelConfig.totalChapters,
          wordsPerChapter: data.novelConfig.wordsPerChapter,
          ...(data.novelConfig.creativeStrategy
            ? { creativeStrategy: data.novelConfig.creativeStrategy }
            : {}),
          plotStructure: data.novelConfig.plotStructure,
          narrativePov: data.novelConfig.narrativePOV,
          goldenFinger: data.novelConfig.goldenFinger,
          globalGuidance: data.novelConfig.globalGuidance,
          coreOutline: data.novelConfig.coreOutline,
          worldSetting: data.novelConfig.worldSetting,
          protagonistProfile: data.novelConfig.protagonistProfile,
          writingStyle: data.novelConfig.writingStyle ?? '',
          referenceWorks: data.novelConfig.referenceWorks ?? '',
        })
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('project:recent-list', async () => {
    return loadRecentProjects()
  })

  ipcMain.handle(
    'project:delete',
    async (
      _event,
      projectPath: string,
      _legacyProjectId: string,
      _legacySessionLease: string,
      context?: ProjectSessionContext,
    ) => {
    let resolvedPath: string
    let deletingCurrentProject = false
    let databaseClosed = false
    try {
      const activeSession = projectAccess.assertCurrentProjectContext(
        context,
        getCurrentProjectPath(),
      )
      resolvedPath = projectAccess.authorizeDeletion({
        projectId: activeSession.projectId,
        leaseId: activeSession.leaseId,
      }, projectPath)
      const currentProjectPath = getCurrentProjectPath()
      if (!sameProjectPath(currentProjectPath, resolvedPath)) {
        throw new Error('项目会话与当前数据库不匹配，已拒绝删除')
      }
      deletingCurrentProject = true

      if (deletingCurrentProject) {
        closeVectorConnection(resolvedPath)
        closeProjectDatabase()
        databaseClosed = true
      }
    } catch (error) {
      return {
        success: false,
        directoryDeleted: false,
        databaseRestored: true,
        error: String(error),
      }
    }

    let deletionError: unknown
    try {
      await removeDirectoryWithWindowsRetry(resolvedPath)
    } catch (error) {
      deletionError = error
    }

    // 删除目录是不可逆提交点。rmSync 即使抛错也可能已经完成删除，
    // 因此必须以磁盘事实决定返回语义，而不是只看异常。
    const directoryDeleted = !fs.existsSync(resolvedPath)
    if (!directoryDeleted) {
      let restoreError: unknown
      let databaseRestored = !deletingCurrentProject || !databaseClosed
      if (deletingCurrentProject && databaseClosed) {
        try {
          initProjectDatabase(resolvedPath)
          databaseRestored = true
        } catch (error) {
          restoreError = error
          databaseRestored = false
        }
      }
      const error = restoreError
        ? `${String(deletionError ?? '项目目录删除失败')}；恢复项目数据库失败：${String(restoreError)}`
        : String(deletionError ?? '项目目录删除失败')
      return { success: false, directoryDeleted: false, databaseRestored, error }
    }

    projectAccess.invalidateCurrentSession()
    try {
      removeRecentProject(resolvedPath)
      return {
        success: true,
        directoryDeleted: true,
        databaseRestored: false,
        ...(deletionError ? { warning: `项目目录已删除：${String(deletionError)}` } : {}),
      }
    } catch (recentProjectError) {
      return {
        success: true,
        directoryDeleted: true,
        databaseRestored: false,
        warning: `项目目录已删除，但最近项目列表更新失败：${String(recentProjectError)}`,
      }
    }
    },
  )

  ipcMain.handle('dialog:select-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '选择项目保存位置',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}
