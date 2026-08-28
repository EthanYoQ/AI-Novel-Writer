import { create } from 'zustand'
import { ipc } from '../services/ipc-client'
import type {
  ProjectChannels,
  ProjectData,
  ProjectSessionContext,
  NovelConfig,
  FileNode,
} from '../shared/ipc-channels'
import { alertError } from '../components/ui/AlertDialog'
import { appErrorMessage } from '../i18n/app-errors'
import { useEditorStore } from './editor-store'
import { useLocaleStore } from './locale-store'
import { requireIpcSuccess } from '../services/ipc-result'
import {
  projectPathKey,
  projectSessionContextFromProject,
  sameProjectPathKey,
  sameProjectSessionContext,
  setActiveProjectSessionContext,
} from '../shared/project-session-context'
import {
  CONFIG_DRAFT_TAB,
  discardProjectEditorDraft,
  getProjectEditorDraft,
  mergeObjectDraftWithRemote,
  parseProjectEditorDraftLedger,
  persistProjectEditorDraftLedger,
  rebaseProjectEditorDraft,
  recordProjectEditorEdit,
  settleProjectEditorSave,
} from './project-editor-draft-ledger'

let refreshFileTreeRequestSequence = 0
let openProjectRequestSequence = 0
let recentProjectsRequestSequence = 0
let closeProjectInFlight: Promise<boolean> | null = null
let projectRecoveryInFlight: Promise<void> | null = null

type LocalizedProjectCopy = Readonly<{
  zhCNText: string
  enUSText: string
}>

function projectText(zhCNText: string, enUSText: string): string {
  return useLocaleStore.getState().text(zhCNText, enUSText)
}

function projectCopy(zhCNText: string, enUSText: string): LocalizedProjectCopy {
  return { zhCNText, enUSText }
}

function joinProjectCopy(
  separator: string,
  ...copies: LocalizedProjectCopy[]
): LocalizedProjectCopy {
  return projectCopy(
    copies.map(copy => copy.zhCNText).join(separator),
    copies.map(copy => copy.enUSText).join(separator),
  )
}

function projectError(
  error: unknown,
  fallbackZhCN = '发生未知错误。',
  fallbackEnUS = 'Something went wrong.',
): string {
  if (error === undefined || error === null || error === '') {
    return projectText(fallbackZhCN, fallbackEnUS)
  }
  return appErrorMessage(useLocaleStore.getState().locale, error)
}

function projectErrorCopy(
  error: unknown,
  fallbackZhCN = '发生未知错误。',
  fallbackEnUS = 'Something went wrong.',
): LocalizedProjectCopy {
  if (error === undefined || error === null || error === '') {
    return projectCopy(fallbackZhCN, fallbackEnUS)
  }
  return projectCopy(
    appErrorMessage('zh-CN', error),
    appErrorMessage('en-US', error),
  )
}

function projectOperationCopy(operation: 'create' | 'open'): LocalizedProjectCopy {
  return operation === 'create'
    ? projectCopy('创建', 'create')
    : projectCopy('打开', 'open')
}

function readConfigDraftLedger() {
  return parseProjectEditorDraftLedger<NovelConfig>(
    useEditorStore.getState().draftLedgers[CONFIG_DRAFT_TAB.id],
  )
}

function persistConfigDraftLedger(ledger: ReturnType<typeof readConfigDraftLedger>) {
  persistProjectEditorDraftLedger(useEditorStore.getState(), CONFIG_DRAFT_TAB, ledger)
}

/**
 * 从 currentProject 中提取纯净的 ProjectData 字段，
 * 防止 Zustand 状态中混入非序列化属性导致 Electron IPC structured clone 挂起。
 */
function toPlainProjectData(p: ProjectData): ProjectData {
  return {
    id: p.id,
    name: p.name,
    path: p.path,
    sessionLease: p.sessionLease,
    novelConfig: p.novelConfig ? { ...p.novelConfig } : p.novelConfig,
    characterStates: p.characterStates,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }
}

/** 给 Promise 包裹超时保护，防止 IPC 调用永远不返回 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[${label}] 超时 (${ms}ms)`))
    }, ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}
// 延迟导入 ProjectService，避免循环依赖
let _onProjectOpened: ((projectSession: ProjectSessionContext) => Promise<{ warnings: string[] }>) | null = null
let _onProjectOpening: ((projectSession: ProjectSessionContext) => void | Promise<void>) | null = null
let _onProjectClosed: ((projectPath: string | null) => Promise<void>) | null = null
let _disableProjectBindingsPreservingDrafts: ((projectPath: string | null) => void) | null = null
async function callProjectOpening(projectSession: ProjectSessionContext) {
  if (!_onProjectOpening) {
    const { onProjectOpening } = await import('../services/project-service')
    _onProjectOpening = onProjectOpening
  }
  await _onProjectOpening(projectSession)
}
async function callProjectOpened(projectSession: ProjectSessionContext) {
  if (!_onProjectOpened) {
    const { onProjectOpened } = await import('../services/project-service')
    _onProjectOpened = onProjectOpened
  }
  return _onProjectOpened(projectSession)
}
async function callProjectClosed(projectPath: string | null) {
  if (!_onProjectClosed) {
    const { onProjectClosed } = await import('../services/project-service')
    _onProjectClosed = onProjectClosed
  }
  await _onProjectClosed(projectPath)
}

async function callDisableProjectBindingsPreservingDrafts(projectPath: string | null) {
  if (!_disableProjectBindingsPreservingDrafts) {
    const { disableProjectBindingsPreservingDrafts } = await import('../services/project-service')
    _disableProjectBindingsPreservingDrafts = disableProjectBindingsPreservingDrafts
  }
  _disableProjectBindingsPreservingDrafts(projectPath)
}

async function detachProjectBindings(options: {
  projectPath: string | null
  detachRenderer: () => void
  message: LocalizedProjectCopy
  title: LocalizedProjectCopy
  shouldNotify?: () => boolean
}): Promise<void> {
  options.detachRenderer()
  const cleanup = callDisableProjectBindingsPreservingDrafts(options.projectPath).catch((cleanupError) => {
    console.error('[Project] 数据库失效后的界面清理失败:', cleanupError)
  })
  projectRecoveryInFlight = cleanup
  try {
    await cleanup
  } finally {
    if (projectRecoveryInFlight === cleanup) projectRecoveryInFlight = null
  }
  if (options.shouldNotify?.() === false) return
  const message = projectText(options.message.zhCNText, options.message.enUSText)
  const title = projectText(options.title.zhCNText, options.title.enUSText)
  alertError(
    `${message}\n${projectText(
      '未保存的编辑和草稿已保留；重新打开正确项目后可以继续处理。',
      'Unsaved edits and drafts were kept. Reopen the correct project to continue.',
    )}`,
    { title },
  )
}

function projectDatabaseMatchesRenderer(
  runtimeContext: ProjectChannels['project:get-runtime-context']['return'],
  rendererProjectPath: string | null,
): boolean {
  return (
    runtimeContext.dbReady
    && sameProjectPathKey(runtimeContext.activeProjectPath, rendererProjectPath)
  )
}

/** UI 身份比较可容忍 Windows 路径表现差异；写入授权仍必须依赖 frozen lease。 */
function sameRendererProject(
  left: ProjectData | null | undefined,
  right: ProjectData | null | undefined,
): boolean {
  if (!left || !right) return left === right
  const leftContext = projectSessionContextFromProject(left)
  const rightContext = projectSessionContextFromProject(right)
  return leftContext && rightContext
    ? sameProjectSessionContext(leftContext, rightContext)
    : sameProjectPathKey(left.path, right.path)
}

async function reconcileStaleProjectResponse(options: {
  getRendererProjectPath: () => string | null
  detachRenderer: () => void
  operation: 'create' | 'open'
}): Promise<boolean> {
  let runtimeContext: ProjectChannels['project:get-runtime-context']['return']
  const operation = projectOperationCopy(options.operation)
  try {
    runtimeContext = await ipc.invoke('project:get-runtime-context')
  } catch (error) {
    const rendererProjectPath = options.getRendererProjectPath()
    await detachProjectBindings({
      projectPath: rendererProjectPath,
      detachRenderer: options.detachRenderer,
      message: joinProjectCopy(
        '\n',
        projectCopy(
          `无法确认过期项目${operation.zhCNText}后的主进程数据库状态。`,
          `Could not verify the main-process database after an obsolete ${operation.enUSText} request.`,
        ),
        projectErrorCopy(error, '项目数据库状态未知。', 'The project database state is unknown.'),
      ),
      title: projectCopy(
        '无法确认项目数据库状态，已停用项目',
        'Could not verify project database state; the project was disabled',
      ),
    })
    return true
  }
  const rendererProjectPath = options.getRendererProjectPath()
  if (projectDatabaseMatchesRenderer(runtimeContext, rendererProjectPath)) return false
  await detachProjectBindings({
    projectPath: rendererProjectPath,
    detachRenderer: options.detachRenderer,
    message: projectCopy(
      `过期的项目${operation.zhCNText}结果表明主进程数据库与当前界面项目不一致。`,
      `The obsolete ${operation.enUSText} result indicates that the main-process database does not match the current project.`,
    ),
    title: projectCopy(
      '项目数据库状态不一致，已停用项目',
      'Project database state does not match; the project was disabled',
    ),
  })
  return true
}

interface ProjectState {
  /** 当前打开的项目 */
  currentProject: ProjectData | null
  /** 项目文件树 */
  fileTree: FileNode[]
  /** 最近项目列表 */
  recentProjects: Array<{ name: string; path: string; updatedAt: string }>
  /** 是否正在加载 */
  loading: boolean
  /** 每次成功打开项目都递增；同一路径重开也属于新的渲染进程项目会话。 */
  projectSessionEpoch: number

  // ===== 操作 =====
  /** 新建项目 */
  createProject: (config: {
    name: string
    path: string
    genre: string
    targetAudience: string
    writingLanguage?: NovelConfig['writingLanguage']
  }) => Promise<boolean>
  /** 打开项目 */
  openProject: (projectPath: string) => Promise<boolean>
  /** 保存项目 */
  saveProject: (expectedProjectSession?: ProjectSessionContext) => Promise<boolean>
  /** 更新小说配置 */
  updateNovelConfig: (config: Partial<NovelConfig>, expectedProjectSession?: ProjectSessionContext) => void
  /** 放弃指定项目的配置草稿并恢复到已保存基准。 */
  discardNovelConfigDraft: (
    projectPath: string,
    expectedProjectSession: ProjectSessionContext,
  ) => void
  /** 刷新文件树 */
  refreshFileTree: (
    expectedProjectPath?: string,
    expectedProjectSessionEpoch?: number,
    expectedProjectSession?: ProjectSessionContext,
  ) => Promise<void>
  /** 加载最近项目 */
  loadRecentProjects: () => Promise<void>
  /** 删除项目目录和项目数据 */
  deleteProject: (projectPath: string) => Promise<boolean>
  /** 关闭项目 */
  closeProject: () => Promise<boolean>
  /** 更新角色状态（内存 + 持久化） */
  updateCharacterStates: (states: string) => Promise<void>
}

export const useProjectStore = create<ProjectState>()((set, get) => ({
  currentProject: null,
  fileTree: [],
  recentProjects: [],
  loading: false,
  projectSessionEpoch: 0,

  createProject: async (config) => {
    const requestSequence = ++openProjectRequestSequence
    const isLatestRequest = () => requestSequence === openProjectRequestSequence
    set({ loading: true })
    try {
      if (closeProjectInFlight) {
        const closed = await closeProjectInFlight
        if (!isLatestRequest() || !closed) return false
        set({ loading: true })
      }
      if (projectRecoveryInFlight) {
        await projectRecoveryInFlight
        if (!isLatestRequest()) return false
      }
      const rendererProject = get().currentProject
      const rendererProjectPath = rendererProject?.path ?? null
      if (rendererProjectPath) {
        const { useWorkflowStore } = await import('./workflow-store')
        await useWorkflowStore.getState().cancelProjectWorkflowsAndWait(rendererProjectPath)
      }
      // 创建与打开共享同一渲染进程请求序列。若等待工作流退出期间已有更新的
      // 打开/创建请求提交，或当前项目已经变化，旧创建请求不得再切换主进程数据库。
      if (
        !isLatestRequest()
        || !sameRendererProject(rendererProject, get().currentProject)
      ) return false
      const requestToken = `create-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const result = await ipc.invoke(
        'project:create',
        config,
        requestToken,
        rendererProjectPath,
      )
      if (
        !isLatestRequest()
        || result.stale
        || result.requestToken !== requestToken
      ) {
        await reconcileStaleProjectResponse({
          getRendererProjectPath: () => get().currentProject?.path ?? null,
          detachRenderer: () => set({ currentProject: null, fileTree: [] }),
          operation: 'create',
        })
        return false
      }
      if (result.databaseRestored === false || result.dbReady === false) {
        const unsafeProjectPath = get().currentProject?.path ?? rendererProjectPath
        await detachProjectBindings({
          projectPath: unsafeProjectPath,
          detachRenderer: () => set({ currentProject: null, fileTree: [] }),
          message: joinProjectCopy(
            '\n',
            projectErrorCopy(
              result.error,
              '新项目创建后未能恢复原项目数据库。',
              'Could not restore the previous project database after creating the new project.',
            ),
            projectCopy(
              '已解除项目界面的可编辑状态以防止继续写入。',
              'The project editor was disabled to prevent further writes.',
            ),
          ),
          title: projectCopy(
            '创建失败，项目数据库不可用',
            'Project creation failed; the project database is unavailable',
          ),
          shouldNotify: isLatestRequest,
        })
        return false
      }
      if (!result.success) {
        console.error('[Project] 创建失败:', result.error)
        alertError(
          projectError(result.errorCode ? result : result.error),
          { title: projectText('创建项目失败', 'Failed to create project') },
        )
        return false
      }
      // 使用主进程返回的实际项目路径（跨平台安全，避免路径分隔符问题）
      const projectDir = result.projectPath ?? `${config.path}/${config.name}`
      return await get().openProject(projectDir)
    } catch (e) {
      if (!isLatestRequest()) return false
      console.error('[Project] createProject 异常:', e)
      alertError(
        projectError(e),
        { title: projectText('创建项目异常', 'Unexpected project creation error') },
      )
      return false
    } finally {
      if (isLatestRequest()) set({ loading: false })
    }
  },


  openProject: async (projectPath) => {
    const requestSequence = ++openProjectRequestSequence
    const requestToken = `${Date.now()}-${requestSequence}-${Math.random().toString(36).slice(2)}`
    const isLatestRequest = () => requestSequence === openProjectRequestSequence
    let rendererProject = get().currentProject
    let rendererProjectPath = rendererProject?.path ?? null
    let mainOpenWasAccepted = false
    set({ loading: true })
    try {
      if (closeProjectInFlight) {
        const closed = await closeProjectInFlight
        if (!isLatestRequest() || !closed) return false
        rendererProject = get().currentProject
        rendererProjectPath = rendererProject?.path ?? null
        set({ loading: true })
      }
      if (projectRecoveryInFlight) {
        await projectRecoveryInFlight
        if (!isLatestRequest()) return false
        rendererProject = get().currentProject
        rendererProjectPath = rendererProject?.path ?? null
      }
      const activeProjectPath = get().currentProject?.path
      // 同一路径重开同样会签发新 lease；旧工作流必须先退出，不能因路径相同而漏掉。
      if (activeProjectPath) {
        const { useWorkflowStore } = await import('./workflow-store')
        await useWorkflowStore.getState().cancelProjectWorkflowsAndWait(activeProjectPath)
        if (!isLatestRequest() || !sameRendererProject(rendererProject, get().currentProject)) return false
      }
      const result = await ipc.invoke('project:open', projectPath, requestToken, rendererProjectPath)
      if (!isLatestRequest() || result.stale || result.requestToken !== requestToken) {
        await reconcileStaleProjectResponse({
          getRendererProjectPath: () => get().currentProject?.path ?? null,
          detachRenderer: () => set({ currentProject: null, fileTree: [] }),
          operation: 'open',
        })
        return false
      }
      const activeProjectMismatch = Boolean(
        result.success
        && result.project
        && !sameProjectPathKey(result.activeProjectPath, result.project.path),
      )
      if (
        result.databaseRestored === false
        || result.dbReady === false
        || activeProjectMismatch
      ) {
        const unsafeProjectPath = get().currentProject?.path ?? rendererProjectPath
        await detachProjectBindings({
          projectPath: unsafeProjectPath,
          detachRenderer: () => set({ currentProject: null, fileTree: [] }),
          message: joinProjectCopy(
            '\n',
            projectErrorCopy(
              result.error,
              '主进程项目数据库与打开结果不一致。',
              'The main-process project database does not match the open result.',
            ),
            projectCopy(
              '已解除项目界面的可编辑状态以防止继续写入。',
              'The project editor was disabled to prevent further writes.',
            ),
          ),
          title: projectCopy(
            '打开失败，项目数据库不可用',
            'Project opening failed; the project database is unavailable',
          ),
          shouldNotify: isLatestRequest,
        })
        return false
      }
      if (result.success && result.project) {
        mainOpenWasAccepted = true
        const openedProjectSession = projectSessionContextFromProject(result.project)
        if (!openedProjectSession) {
          throw new Error(projectText(
            '主进程未返回有效项目会话，已拒绝绑定项目数据。',
            'The main process did not return a valid project session, so project data was not bound.',
          ))
        }
        const draftLedger = readConfigDraftLedger()
        const restored = rebaseProjectEditorDraft(
          draftLedger,
          result.project.path,
          result.project.novelConfig,
          mergeObjectDraftWithRemote,
        )
        if (getProjectEditorDraft(draftLedger, result.project.path)) {
          persistConfigDraftLedger(restored.ledger)
        }
        // 必须先解除第二层数据与旧项目的绑定，再向界面发布新项目身份。
        await callProjectOpening(openedProjectSession)
        if (!isLatestRequest()) {
          await reconcileStaleProjectResponse({
            getRendererProjectPath: () => get().currentProject?.path ?? null,
            detachRenderer: () => set({ currentProject: null, fileTree: [] }),
            operation: 'open',
          })
          return false
        }
        set((state) => ({
          currentProject: { ...result.project!, novelConfig: restored.value },
          projectSessionEpoch: state.projectSessionEpoch + 1,
        }))
        const partialLoadWarnings: string[] = []
        // 核心项目身份已经提交。文件树属于可降级的第二层视图，
        // 失败不能再把这个已打开的项目报告成整体打开失败。
        try {
          await get().refreshFileTree(result.project.path)
        } catch (fileTreeError) {
          if (
            !isLatestRequest()
            || !sameRendererProject(get().currentProject, result.project)
          ) {
            // 已返回项目已经提交到渲染进程；旧请求不再拥有后续视图刷新，
            // 但主进程与当前界面已由当前请求或更新请求负责保持一致。
            return false
          }
          console.error('[Project] 项目文件树加载失败:', fileTreeError)
          partialLoadWarnings.push(String(fileTreeError))
          set({ fileTree: [] })
        }
        // 此后渲染进程已经提交返回项目；过期状态只影响派生视图，可以安全退出。
        if (!isLatestRequest()) return false
        // 自动展开侧边栏并切换到项目结构视图
        const { useLayoutStore } = await import('./layout-store')
        if (!isLatestRequest()) return false
        useLayoutStore.setState({ sidebarOpen: true, sidebarView: 'project' })
        // 统一初始化第二层状态仓库（角色卡、草稿等）
        let layer2Warnings: string[] = []
        try {
          const layer2Result = await callProjectOpened(openedProjectSession)
          layer2Warnings = layer2Result?.warnings ?? []
        } catch (layer2Error) {
          console.error('[Project] 项目资源初始化失败:', layer2Error)
          layer2Warnings = [String(layer2Error)]
        }
        if (!isLatestRequest()) return false
        const warnings = [...partialLoadWarnings, ...layer2Warnings]
          .map(warning => projectError(warning))
        if (warnings.length > 0) {
          alertError(warnings.join('\n'), {
            title: projectText('项目已打开，部分数据加载失败', 'Project opened with some data unavailable'),
          })
        }
        return true
      }
      if (!isLatestRequest()) return false
      console.error('[Project] 打开失败:', result.error)
      alertError(
        projectError(result.errorCode ? result : result.error),
        { title: projectText('打开项目失败', 'Failed to open project') },
      )
      return false
    } catch (e) {
      if (mainOpenWasAccepted) {
        const detached = await reconcileStaleProjectResponse({
          getRendererProjectPath: () => get().currentProject?.path ?? null,
          detachRenderer: () => set({ currentProject: null, fileTree: [] }),
          operation: 'open',
        })
        if (detached) return false
      }
      if (!isLatestRequest()) return false
      console.error('[Project] IPC 通信异常:', e)
      if (!isLatestRequest()) return false
      alertError(
        projectError(e),
        { title: projectText('打开项目异常', 'Unexpected project opening error') },
      )
      return false
    } finally {
      if (isLatestRequest()) set({ loading: false })
    }
  },

  saveProject: async (expectedProjectSession) => {
    const project = get().currentProject
    console.log('[project-store.saveProject] 开始保存，项目ID:', project?.id)
    if (!project) {
      console.log('[project-store.saveProject] 项目为空，跳过保存')
      return false
    }
    const projectSession = projectSessionContextFromProject(project)
    if (!projectSession) {
      console.error('[project-store.saveProject] 缺少项目会话，拒绝保存')
      return false
    }
    if (
      expectedProjectSession
      && !sameProjectSessionContext(expectedProjectSession, projectSession)
    ) {
      console.warn('[project-store.saveProject] 项目会话已变化，拒绝保存')
      return false
    }
    try {
      // 提取纯净数据，防止 structured clone 序列化异常属性
      const plainData = toPlainProjectData(project)
      console.log('[project-store.saveProject] 准备调用 IPC，数据大小:', JSON.stringify(plainData).length)
      const result = await withTimeout(
        ipc.invokeWithProjectSession(
          projectSession,
          'project:save',
          plainData.id,
          plainData,
          project.path,
        ),
        15_000,
        'project:save',
      )
      console.log('[project-store.saveProject] IPC 调用完成，结果:', result)
      if (!result.success) return false
      if (!sameProjectSessionContext(
        projectSession,
        projectSessionContextFromProject(get().currentProject),
      )) return false
      const ledger = readConfigDraftLedger()
      const currentValue = get().currentProject?.novelConfig
      persistConfigDraftLedger(settleProjectEditorSave(
        ledger,
        project.path,
        plainData.novelConfig,
        currentValue ?? plainData.novelConfig,
      ))
      return true
    } catch (err) {
      console.error('[project-store.saveProject] 保存失败:', err)
      return false
    }
  },

  updateNovelConfig: (config, expectedProjectSession) => {
    const project = get().currentProject
    if (!project) return
    if (
      expectedProjectSession
      && !sameProjectSessionContext(
        expectedProjectSession,
        projectSessionContextFromProject(project),
      )
    ) return
    const nextConfig = { ...project.novelConfig, ...config }
    set({
      currentProject: {
        ...project,
        novelConfig: nextConfig,
      },
    })
    persistConfigDraftLedger(recordProjectEditorEdit(
      readConfigDraftLedger(),
      project.path,
      project.novelConfig,
      nextConfig,
    ))
  },

  discardNovelConfigDraft: (projectPath, expectedProjectSession) => {
    if (
      !sameProjectPathKey(expectedProjectSession.projectPath, projectPath)
      || !sameProjectSessionContext(
        expectedProjectSession,
        projectSessionContextFromProject(get().currentProject),
      )
    ) return
    const ledger = readConfigDraftLedger()
    const projectDraft = getProjectEditorDraft(ledger, projectPath)
    if (!projectDraft) return
    if (sameProjectSessionContext(
      expectedProjectSession,
      projectSessionContextFromProject(get().currentProject),
    )) {
      set((state) => ({
        currentProject: state.currentProject
          ? { ...state.currentProject, novelConfig: projectDraft.baseValue }
          : null,
      }))
    }
    persistConfigDraftLedger(discardProjectEditorDraft(ledger, projectPath))
  },

  refreshFileTree: async (expectedProjectPath, expectedProjectSessionEpoch, expectedProjectSession) => {
    const state = get()
    const project = state.currentProject
    if (
      !project
      || (expectedProjectPath && !sameProjectPathKey(project.path, expectedProjectPath))
      || (
        expectedProjectSessionEpoch !== undefined
        && state.projectSessionEpoch !== expectedProjectSessionEpoch
      )
    ) return
    const projectSession = projectSessionContextFromProject(project)
    if (!projectSession) return
    if (
      expectedProjectSession
      && !sameProjectSessionContext(expectedProjectSession, projectSession)
    ) return
    const projectPath = project.path
    const projectSessionEpoch = expectedProjectSessionEpoch ?? state.projectSessionEpoch
    const requestId = ++refreshFileTreeRequestSequence
    const tree = await ipc.invokeWithProjectSession(
      projectSession,
      'fs:list-dir',
      projectPath,
      projectPath,
    )
    if (
      requestId !== refreshFileTreeRequestSequence
      || !sameProjectSessionContext(
        projectSession,
        projectSessionContextFromProject(get().currentProject),
      )
      || get().projectSessionEpoch !== projectSessionEpoch
    ) return
    set({ fileTree: tree })
  },

  loadRecentProjects: async () => {
    const requestId = ++recentProjectsRequestSequence
    const list = await ipc.invoke('project:recent-list')
    if (requestId !== recentProjectsRequestSequence) return
    const seenProjectPaths = new Set<string>()
    const recentProjects = list.filter((project) => {
      const key = projectPathKey(project.path) ?? project.path
      if (seenProjectPaths.has(key)) return false
      seenProjectPaths.add(key)
      return true
    })
    set({ recentProjects })
  },

  deleteProject: async (projectPath) => {
    const activeProject = get().currentProject
    const projectSession = projectSessionContextFromProject(activeProject)
    if (
      !activeProject
      || !sameProjectPathKey(activeProject.path, projectPath)
      || !projectSession
    ) {
      alertError(
        projectText('只能删除当前已验证项目；请先打开目标项目。', 'Only the currently verified project can be deleted. Open the target project first.'),
        { title: projectText('删除项目失败', 'Failed to delete project') },
      )
      return false
    }
    set({ loading: true })
    try {
      const { useWorkflowStore } = await import('./workflow-store')
      await useWorkflowStore.getState().cancelProjectWorkflowsAndWait(activeProject.path)
      if (!sameProjectSessionContext(
        projectSession,
        projectSessionContextFromProject(get().currentProject),
      )) return false
      const result = await ipc.invokeWithProjectSession(
        projectSession,
        'project:delete',
        projectPath,
        activeProject.id,
        projectSession.leaseId,
      )
      if (!sameProjectSessionContext(
        projectSession,
        projectSessionContextFromProject(get().currentProject),
      )) return false
      if (!result.success) {
        if (
          result.databaseRestored === false
          && sameProjectSessionContext(
            projectSession,
            projectSessionContextFromProject(get().currentProject),
          )
        ) {
          // 删除失败后主进程数据库也未能恢复，继续保留可写界面会制造
          // “看似打开、实际无数据库”的危险半状态。先解除所有项目绑定。
          set({ currentProject: null, fileTree: [] })
          try {
            await callProjectClosed(projectPath)
          } catch (cleanupError) {
            console.error('[project-store.deleteProject] 数据库恢复失败后的界面清理失败:', cleanupError)
          }
          alertError(`${projectError(
            result.error,
            '项目目录删除失败。',
            'Could not delete the project directory.',
          )}\n${projectText(
            '项目数据库未能恢复，已关闭当前项目以防止继续写入。',
            'The project database could not be restored. The current project was closed to prevent further writes.',
          )}`, {
            title: projectText('删除失败，项目已停用', 'Deletion failed; the project was disabled'),
          })
          return false
        }
        alertError(
          projectError(result.error),
          { title: projectText('删除项目失败', 'Failed to delete project') },
        )
        return false
      }
      if (result.warning) {
        alertError(
          projectError(result.warning),
          { title: projectText('项目已删除，部分清理未完成', 'Project deleted with some cleanup incomplete') },
        )
      }

      const currentProject = get().currentProject
      if (sameProjectSessionContext(projectSession, projectSessionContextFromProject(currentProject))) {
        set({ currentProject: null, fileTree: [] })
        try {
          await callProjectClosed(projectPath)
        } catch (cleanupError) {
          console.error('[project-store.deleteProject] 项目已删除，但界面清理失败:', cleanupError)
          alertError(
            projectError(cleanupError),
            { title: projectText('项目已删除，界面清理未完成', 'Project deleted with editor cleanup incomplete') },
          )
        }
      }

      try {
        await get().loadRecentProjects()
      } catch (recentProjectError) {
        console.error('[project-store.deleteProject] 项目已删除，但刷新最近项目失败:', recentProjectError)
        alertError(
          projectError(recentProjectError),
            { title: projectText('项目已删除，最近项目列表刷新失败', 'Project deleted with recent-project refresh failed') },
        )
      }
      return true
    } catch (e) {
      alertError(
        projectError(e),
        { title: projectText('删除项目异常', 'Unexpected project deletion error') },
      )
      return false
    } finally {
      const currentSession = projectSessionContextFromProject(get().currentProject)
      if (!currentSession || sameProjectSessionContext(projectSession, currentSession)) {
        set({ loading: false })
      }
    }
  },

  closeProject: async () => {
    if (closeProjectInFlight) return closeProjectInFlight
    if (get().loading) {
      alertError(
        projectText('项目正在切换，请稍后再关闭。', 'The project is switching. Try closing it again shortly.'),
        { title: projectText('暂时无法关闭项目', 'Cannot close project yet') },
      )
      return false
    }
    const project = get().currentProject
    const projectPath = project?.path
    if (!projectPath) return true
    const projectSession = projectSessionContextFromProject(project)
    if (!projectSession) {
      alertError(
        projectText(
          '当前项目缺少有效会话，已拒绝关闭数据库。',
          'The current project has no valid session, so its database was not closed.',
        ),
        { title: projectText('关闭项目失败', 'Failed to close project') },
      )
      return false
    }

    const closeOperation = (async () => {
      set({ loading: true })
      try {
        const { useWorkflowStore } = await import('./workflow-store')
        await useWorkflowStore.getState().cancelProjectWorkflowsAndWait(projectPath)
        if (!sameProjectSessionContext(
          projectSession,
          projectSessionContextFromProject(get().currentProject),
        )) {
          throw new Error(projectText(
            '项目上下文已变化，关闭操作已取消。',
            'The project context changed, so the close operation was cancelled.',
          ))
        }
        const result = await ipc.invokeWithProjectSession(projectSession, 'db:close', projectPath)
        requireIpcSuccess(result, '关闭项目数据库')
        if (!sameProjectSessionContext(
          projectSession,
          projectSessionContextFromProject(get().currentProject),
        )) return false
        set({ currentProject: null, fileTree: [] })
        try {
          await callProjectClosed(projectPath)
        } catch (cleanupError) {
          console.error('[project-store.closeProject] 项目已关闭，但界面清理失败:', cleanupError)
          alertError(
            projectError(cleanupError),
            { title: projectText('项目已关闭，界面清理未完成', 'Project closed with editor cleanup incomplete') },
          )
        }
        return true
      } catch (error) {
        console.error('[project-store.closeProject] 关闭失败:', error)
        alertError(
          projectError(error),
          { title: projectText('关闭项目失败', 'Failed to close project') },
        )
        return false
      } finally {
        const currentSession = projectSessionContextFromProject(get().currentProject)
        if (!currentSession || sameProjectSessionContext(projectSession, currentSession)) {
          set({ loading: false })
        }
      }
    })()
    closeProjectInFlight = closeOperation
    try {
      return await closeOperation
    } finally {
      if (closeProjectInFlight === closeOperation) closeProjectInFlight = null
    }
  },

  updateCharacterStates: async (states) => {
    const project = get().currentProject
    if (!project) return
    const projectSession = projectSessionContextFromProject(project)
    if (!projectSession) return
    const updated = { ...project, characterStates: states }
    try {
      const result = await withTimeout(
        ipc.invokeWithProjectSession(
          projectSession,
          'project:save',
          project.id,
          toPlainProjectData(updated),
          project.path,
        ),
        15_000,
        'project:save(characterStates)',
      )
      requireIpcSuccess(result, '保存角色状态')
      if (sameProjectSessionContext(
        projectSession,
        projectSessionContextFromProject(get().currentProject),
      )) {
        set({ currentProject: updated })
      }
    } catch (err) {
      console.error('[project-store.updateCharacterStates] 持久化失败:', err)
      alertError(
        projectError(err),
        { title: projectText('保存角色状态失败', 'Failed to save character states') },
      )
    }
    // 【迁移优化】: project:save 已经持久化到 project_core 表的 characterStates 字段，
    // 此处无需为了全局（-1）再进行一次 db:save-summary-snapshot 的冗余调用。
    // try {
    //   await ipc.invoke('db:save-summary-snapshot', -1, states)
    // } catch { /* SQLite 可能未初始化 */ }
  },
}))

// 任何 currentProject 提交都会同步刷新 IPC 的默认会话；工作流另行持有自己的冻结副本。
useProjectStore.subscribe((state) => {
  setActiveProjectSessionContext(projectSessionContextFromProject(state.currentProject))
})
