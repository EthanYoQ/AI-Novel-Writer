/**
 * 全局事件总线 — 统一解耦业务层（Service/Command/Workflow）与视图层（React/Zustand）
 *
 * 所有跨模块事件都通过此总线分发，组件不再直接使用 window.dispatchEvent。
 * 事件由 ProjectService 统一消费，驱动 Store 更新，组件只需订阅 Store 数据。
 */

import type { ProjectSessionContext } from './ipc-channels'

// ===== 事件类型定义 =====

export type GlobalEventType =
  // --- 资源刷新 ---
  | 'REFRESH_RESOURCE'
  // --- 工作流相关 ---
  | 'WORKFLOW_COMPLETE'
  | 'WORKFLOW_ERROR'
  // --- 架构后处理 ---
  | 'ARCH_POSTPROCESS_UPDATED'
  | 'CHARACTER_EXTRACT_FAILED'
  // --- 架构文件单步更新（每步生成完触发） ---
  | 'ARCH_FILE_UPDATED'
  // --- 定稿完成（替代原 vela:finalize-complete） ---
  | 'FINALIZE_COMPLETE'
  // --- 项目级事件 ---
  | 'PROJECT_CHANGED'
  // --- 系统通知 ---
  | 'SYSTEM_NOTICE'

export interface EventPayloadMap {
  'REFRESH_RESOURCE': {
    resources: Array<'fileTree' | 'characterCards' | 'drafts' | 'blueprints' | 'all'>
    /** 事件生产者开始操作时冻结的项目路径（只作显示/定位，不是身份）。 */
    projectPath: string
    /** 完整冻结身份；同路径重新打开后旧事件必须被丢弃。 */
    projectSession: ProjectSessionContext
  }
  'WORKFLOW_COMPLETE': {
    type: string
    /** 启动工作流时冻结的项目路径（只作显示/定位，不是身份）。 */
    projectPath: string
    /** 启动工作流时冻结的完整项目会话。 */
    projectSession: ProjectSessionContext
    /** 唯一工作流运行身份，用于排除同项目内的其他并发任务。 */
    runId: string
  }
  'WORKFLOW_ERROR': {
    title: string
    error: string
    stack?: string
  }
  'ARCH_POSTPROCESS_UPDATED': {
    projectPath: string
    projectSession: ProjectSessionContext
    runId: string
  }
  'CHARACTER_EXTRACT_FAILED': {
    projectPath: string
    projectSession: ProjectSessionContext
    runId: string
    error?: string
  }
  'ARCH_FILE_UPDATED': {
    fileName: string
    projectPath: string
    projectSession: ProjectSessionContext
    runId: string
  }
  'FINALIZE_COMPLETE': {
    /** 触发定稿的编辑器 Tab；完成事件只能结算这个冻结目标。 */
    tabId: string
    chapterNumber: number
    chapterTitle: string
    /** 定稿工作流启动时冻结的项目路径。 */
    projectPath: string
    /** 触发定稿时冻结的项目会话，防止同路径重开后的旧结果落到新会话。 */
    projectSession: ProjectSessionContext
    /** SQLite 事务中提交的草稿和定稿身份。 */
    draftId: number
    finalizationId: string
    contentHash: string
    contentRevision: number
    /** 绝不从数据库回读来替换编辑器；只用这个不可变快照结算。 */
    snapshotContent: string
    publicationStatus: 'pending' | 'published'
    /** 定稿来源；批量任务不应弹出单章的“下一章创作”对话框 */
    source?: 'manual' | 'batch'
  }
  'PROJECT_CHANGED': {
    projectPath: string
    projectSession: ProjectSessionContext
  }
  'SYSTEM_NOTICE': {
    level: 'info' | 'success' | 'warn' | 'error'
    message: string
  }
}

// ===== EventBus 实现 =====

class EventBus {
  private target = new EventTarget()

  emit<K extends GlobalEventType>(type: K, payload: EventPayloadMap[K]) {
    this.target.dispatchEvent(new CustomEvent(type, { detail: payload }))
  }

  on<K extends GlobalEventType>(type: K, handler: (payload: EventPayloadMap[K]) => void): () => void {
    const listener = (event: Event) => {
      handler((event as CustomEvent).detail)
    }
    this.target.addEventListener(type, listener)
    // 返回解绑函数，便于清理
    return () => this.target.removeEventListener(type, listener)
  }
}

export const globalEventBus = new EventBus()

// ===== 便捷日志工具 =====

export const AppLogger = {
  info: (msg: string) => globalEventBus.emit('SYSTEM_NOTICE', { level: 'info', message: msg }),
  warn: (msg: string) => globalEventBus.emit('SYSTEM_NOTICE', { level: 'warn', message: msg }),
  error: (title: string, err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack : undefined
    console.error(`[AppLogger] ${title}:`, err)
    globalEventBus.emit('WORKFLOW_ERROR', { title, error: message, stack })
    globalEventBus.emit('SYSTEM_NOTICE', { level: 'error', message: `${title}: ${message}` })
  }
}
