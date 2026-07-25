/**
 * ProjectService — 项目生命周期与跨 Store 协调的单例调度层
 *
 * 职责：
 * 1. 项目打开/关闭时统一初始化/清空 Layer 2 Store（character、draft）
 * 2. 监听 EventBus 事件，驱动 Store 数据刷新
 * 3. 同步 editor-store 中已打开 Tab 的内容（定稿后磁盘文件已变更的场景）
 *
 * 设计原则：
 * - 组件不再自行 useEffect 加载数据、不再监听 window 事件
 * - 所有跨 Store 联动都经过此 Service
 * - Store 只暴露纯数据 + 操作方法，不包含生命周期逻辑
 */

import { globalEventBus, type EventPayloadMap } from '../shared/event-bus'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import { useProjectStore } from '../stores/project-store'
import { useCharacterStore } from '../stores/character-store'
import { useDraftStore } from '../stores/draft-store'
import { useEditorStore } from '../stores/editor-store'
import { useWorkflowStore } from '../stores/workflow-store'
import { useLocaleStore } from '../stores/locale-store'
import {
  projectSessionContextFromProject,
  sameProjectSessionContext,
} from '../shared/project-session-context'
import {
  reconcileFinalizationCompletion,
  type FinalizationCompletion,
  type FinalizationSnapshot,
} from './finalization-snapshot'

/** 存放解绑函数，用于 dispose 时清理 */
let disposers: Array<() => void> = []

function runProjectEventTask(label: () => string, task: () => Promise<void>): void {
  void task().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    const locale = useLocaleStore.getState().locale
    const localizedLabel = label()
    console.error(`[ProjectService] ${localizedLabel}:`, error)
    globalEventBus.emit('SYSTEM_NOTICE', {
      level: 'error',
      message: locale === 'zh-CN' ? `${localizedLabel}：${message}` : localizedLabel,
    })
  })
}

/**
 * Project-scoped events and opening work are owned by the complete frozen
 * session, never by a path alone.  Reopening the same folder produces a new
 * lease and must make every old event/result a no-op.
 */
function isProjectSessionCurrent(projectSession: ProjectSessionContext): boolean {
  return sameProjectSessionContext(
    projectSession,
    projectSessionContextFromProject(useProjectStore.getState().currentProject),
  )
}

function isActiveWorkflowForProjectSession(
  runId: string,
  projectSession: ProjectSessionContext,
): boolean {
  return useWorkflowStore.getState().activeRuns.some(run => (
    run.id === runId
    && sameProjectSessionContext(run.projectSession, projectSession)
  ))
}

/**
 * 初始化 ProjectService — 注册所有事件监听
 * 应在 App 挂载时调用一次
 */
export function initProjectService(): void {
  const text = useLocaleStore.getState().text
  // 防止重复初始化
  if (disposers.length > 0) return

  // === 监听 EventBus 事件 ===

  // 工作流完成 → 刷新文件树 + 草稿（覆盖所有工作流类型）
  disposers.push(
    globalEventBus.on('WORKFLOW_COMPLETE', (payload) => runProjectEventTask(
      () => text('工作流完成后的项目刷新失败', 'Could not refresh project data after workflow completion'),
      async () => {
      console.log('[ProjectService] WORKFLOW_COMPLETE 事件触发:', payload.type)
      if (!isProjectSessionCurrent(payload.projectSession)) return

      // config_generation 类型只需要轻量刷新（避免不必要的文件扫描）
      if (payload.type === 'config_generation') {
        console.log('[ProjectService] config_generation 完成，跳过资源刷新')
        return
      }

      // 刷新文件树（所有工作流完成后都需要）
      console.log('[ProjectService] 开始刷新文件树...')
      await useProjectStore.getState().refreshFileTree(
        payload.projectPath,
        undefined,
        payload.projectSession,
      )
      if (!isProjectSessionCurrent(payload.projectSession)) return
      console.log('[ProjectService] 文件树刷新完成')

      // 根据工作流类型精准刷新
      if (payload.type === 'chapter_creation') {
        // 章节创作完成 → 刷新草稿 + 角色卡（定稿后处理会更新角色状态）
        console.log('[ProjectService] 刷新草稿和角色卡...')
        await Promise.all([
          useDraftStore.getState().loadAllDrafts(payload.projectPath, payload.projectSession),
          useCharacterStore.getState().load(payload.projectPath, payload.projectSession),
        ])
        if (!isProjectSessionCurrent(payload.projectSession)) return
        console.log('[ProjectService] 草稿和角色卡刷新完成')
      } else if (payload.type === 'architecture_generation') {
        // 架构生成完成 → 角色卡可能被提取
        console.log('[ProjectService] 刷新角色卡...')
        await useCharacterStore.getState().load(payload.projectPath, payload.projectSession)
        if (!isProjectSessionCurrent(payload.projectSession)) return
        console.log('[ProjectService] 角色卡刷新完成')
      }
      },
    ))
  )

  // 定稿完成 → 刷新草稿 + 角色 + 文件树 + 同步编辑器 Tab
  disposers.push(
    globalEventBus.on('FINALIZE_COMPLETE', (payload) => runProjectEventTask(
      () => text('定稿后的项目刷新失败', 'Could not refresh project data after finalization'),
      async () => {
      const project = useProjectStore.getState().currentProject
      if (!project || !sameProjectSessionContext(
        projectSessionContextFromProject(project),
        payload.projectSession,
      )) return

      // 只用完成事件携带的不可变快照结算 tab。不得为此回读数据库正文，
      // 否则完成事件可能覆盖用户在定稿等待期间的新编辑。
      syncFinalizedDraftTab(payload)

      await Promise.all([
        useDraftStore.getState().loadChapterDrafts(
          payload.chapterNumber,
          payload.projectPath,
          payload.projectSession,
        ),
        useCharacterStore.getState().load(payload.projectPath, payload.projectSession),
        useProjectStore.getState().refreshFileTree(
          payload.projectPath,
          undefined,
          payload.projectSession,
        ),
      ])
      if (!isProjectSessionCurrent(payload.projectSession)) return
      },
    ))
  )

  // 架构后处理完成 → 刷新角色卡
  disposers.push(
    globalEventBus.on('ARCH_POSTPROCESS_UPDATED', (payload) => runProjectEventTask(
      () => text('架构后处理刷新失败', 'Could not refresh character cards after architecture post-processing'),
      async () => {
      if (
        !isProjectSessionCurrent(payload.projectSession)
        || !isActiveWorkflowForProjectSession(payload.runId, payload.projectSession)
      ) return
      await useCharacterStore.getState().load(payload.projectPath, payload.projectSession)
      if (!isProjectSessionCurrent(payload.projectSession)) return
      },
    ))
  )

  // 角色卡提取失败 → 也刷新角色卡（确保 UI 状态一致）
  disposers.push(
    globalEventBus.on('CHARACTER_EXTRACT_FAILED', (payload) => runProjectEventTask(
      () => text('角色卡失败状态刷新失败', 'Could not refresh character-card failure status'),
      async () => {
      if (
        !isProjectSessionCurrent(payload.projectSession)
        || !isActiveWorkflowForProjectSession(payload.runId, payload.projectSession)
      ) return
      await useCharacterStore.getState().load(payload.projectPath, payload.projectSession)
      if (!isProjectSessionCurrent(payload.projectSession)) return
      },
    ))
  )

  // 资源刷新请求（由知识库等模块触发）
  disposers.push(
    globalEventBus.on('REFRESH_RESOURCE', (payload) => runProjectEventTask(
      () => text('项目资源刷新失败', 'Could not refresh project resources'),
      async () => {
      const projectPath = payload.projectPath
      if (!isProjectSessionCurrent(payload.projectSession)) return
      const resources = payload.resources
      if (resources.includes('all') || resources.includes('characterCards')) {
        await useCharacterStore.getState().load(projectPath, payload.projectSession)
        if (!isProjectSessionCurrent(payload.projectSession)) return
      }
      if (resources.includes('all') || resources.includes('drafts')) {
        await useDraftStore.getState().loadAllDrafts(projectPath, payload.projectSession)
        if (!isProjectSessionCurrent(payload.projectSession)) return
      }
      if (resources.includes('all') || resources.includes('fileTree')) {
        await useProjectStore.getState().refreshFileTree(
          projectPath,
          undefined,
          payload.projectSession,
        )
        if (!isProjectSessionCurrent(payload.projectSession)) return
      }
      },
    ))
  )

  console.log('[ProjectService] 已初始化，事件监听已注册')
}

/**
 * 主进程已经成功切换项目、renderer 即将发布新的 currentProject 前调用。
 * 先解除角色数组与旧项目的绑定，避免新项目页面短暂复用旧项目数据。
 */
export function onProjectOpening(projectSession: ProjectSessionContext): void {
  useCharacterStore.getState().beginProjectLoad(projectSession.projectPath)
  useDraftStore.getState().beginProjectLoad(projectSession.projectPath)
}

/**
 * 项目打开后的初始化 — 并行加载所有 Layer 2 数据
 * 由 project-store.openProject 成功后调用
 */
export async function onProjectOpened(
  projectSession: ProjectSessionContext,
): Promise<{ warnings: string[] }> {
  const text = useLocaleStore.getState().text
  if (!isProjectSessionCurrent(projectSession)) return { warnings: [] }

  // 并行加载角色卡和草稿列表
  const results = await Promise.allSettled([
    useCharacterStore.getState().load(projectSession.projectPath, projectSession),
    useDraftStore.getState().loadAllDrafts(projectSession.projectPath, projectSession),
  ])
  if (!isProjectSessionCurrent(projectSession)) return { warnings: [] }
  const warnings: string[] = []
  const characterError = useCharacterStore.getState().lastError
  if (characterError) warnings.push(text(
    `角色卡读取失败：${characterError}`,
    'Could not load character cards.',
  ))
  if (results[0].status === 'rejected' && !characterError) {
    warnings.push(text(
      `角色卡读取失败：${String(results[0].reason)}`,
      'Could not load character cards.',
    ))
  }
  if (results[1].status === 'rejected') {
    warnings.push(text(
      `草稿列表读取失败：${String(results[1].reason)}`,
      'Could not load the draft list.',
    ))
  }

  // 广播项目已就绪事件
  globalEventBus.emit('PROJECT_CHANGED', {
    projectPath: projectSession.projectPath,
    projectSession,
  })

  console.log('[ProjectService] 项目数据加载完成:', projectSession.projectPath)
  return { warnings }
}

/**
 * 项目关闭时的清理 — 重置所有 Layer 2 Store
 * 由 project-store.closeProject 调用
 */
export async function onProjectClosed(projectPath: string | null): Promise<void> {
  const { useEditorStore } = await import('../stores/editor-store')
  if (projectPath) {
    // 正常关闭只清理对应项目，保留其他项目的未保存草稿。
    useEditorStore.getState().clearProjectTabs(projectPath)
  } else {
    // 数据库状态未知且 renderer 已无项目身份时，不能保留任何可编辑 Tab。
    useEditorStore.getState().clearTabs()
  }

  disableProjectBindingsPreservingDrafts(projectPath)

  console.log('[ProjectService] 项目已关闭，第二层状态仓库已重置')
}

/**
 * 数据库身份异常时解除可写数据绑定，但保留用户尚未保存的标签页和后台草稿。
 * 项目身份被清空后，这些标签页不会进入编辑器；恢复项目后仍可由用户处理。
 */
export function disableProjectBindingsPreservingDrafts(projectPath: string | null): void {
  useCharacterStore.getState().reset()
  useDraftStore.getState().reset()

  console.log('[ProjectService] 已停用项目数据绑定并保留未保存草稿:', projectPath)
}

/**
 * 将定稿完成事件与原始不可变快照进行精确 reconciliation。
 * 绝不回读数据库正文：完成事件晚到时必须保留用户后续编辑。
 */
function syncFinalizedDraftTab(payload: EventPayloadMap['FINALIZE_COMPLETE']): void {
  const snapshot: FinalizationSnapshot = {
    tabId: payload.tabId,
    projectPath: payload.projectPath,
    projectSession: payload.projectSession,
    draftId: payload.draftId,
    chapterNumber: payload.chapterNumber,
    chapterTitle: payload.chapterTitle,
    content: payload.snapshotContent,
    contentRevision: payload.contentRevision,
  }
  const completion: FinalizationCompletion = {
    finalizationId: payload.finalizationId,
    contentHash: payload.contentHash,
    contentRevision: payload.contentRevision,
    draftId: payload.draftId,
    projectPath: payload.projectPath,
    projectSession: payload.projectSession,
    publicationStatus: payload.publicationStatus,
  }
  useEditorStore.setState(state => ({
    tabs: state.tabs.map(tab => reconcileFinalizationCompletion(tab, snapshot, completion)),
  }))
}

/**
 * 销毁 ProjectService — 清理所有事件监听
 * 通常在 App 卸载时调用
 */
export function disposeProjectService(): void {
  for (const dispose of disposers) {
    dispose()
  }
  disposers = []
  console.log('[ProjectService] 已销毁')
}
