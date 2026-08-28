import { create } from 'zustand'
import { randomUUID } from '../utils/id'
import { globalEventBus } from '../shared/event-bus'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import type { WritingLanguage } from '../shared/writing-language'
import { resolveWritingLanguage } from '../shared/writing-language'
import type { Locale } from '../i18n/types'
import {
  getBoundedCompletionFailureCode,
  type BoundedCompletionFailureCode,
} from '../services/workflows/bounded-completion'
import {
  promptBudgetFailureFromError,
  type PromptBudgetFailureCode,
} from '../services/generation/prompt-budget-failure'
import type { PromptBudgetReport } from '../services/generation/generation-harness'
import {
  isProjectSessionContext,
  projectSessionContextFromProject,
  sameProjectPathKey,
  sameProjectSessionContext,
} from '../shared/project-session-context'
import { useProjectStore } from './project-store'
import { useLocaleStore } from './locale-store'

// ===== 工作流数据模型 =====

/** 工作流步骤状态 */
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

/** 工作流运行状态 */
export type WorkflowStatus =
  | 'idle'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'waiting'

/** Stable non-success terminal state supplied by a bounded model completion. */
export type WorkflowFailureCode = BoundedCompletionFailureCode | PromptBudgetFailureCode

/** 工作流步骤 */
export interface WorkflowStep {
  id: string
  name: string
  description: string
  status: StepStatus
  progress?: number
  result?: string
  error?: string
  /** Structured failure cause when a bounded model completion stopped early. */
  failureCode?: WorkflowFailureCode
  /** Safe structured byte attribution for a prompt-budget preflight failure. */
  promptBudgetReport?: PromptBudgetReport
  startedAt?: string
  completedAt?: string
  logs: string[]
}

/** 工作流运行实例 */
export interface WorkflowRun {
  id: string
  /** 工作流启动时冻结的项目身份。 */
  projectPath: string
  /** 启动时从当前项目冻结；缺失时该 run 只能失败，不能执行项目级副作用。 */
  projectSession: ProjectSessionContext | null
  /** Agent 明确选择并随本次写稿工作流冻结的模型；缺失时使用默认模型。 */
  generationModelId?: string
  /** Project writing language frozen when the workflow starts. */
  writingLanguage: WritingLanguage
  /** Visible interface locale frozen when the workflow starts. */
  uiLocale: Locale
  type: WorkflowType
  title: string
  status: WorkflowStatus
  steps: WorkflowStep[]
  currentStepIndex: number
  createdAt: string
  completedAt?: string
  error?: string
  /** Structured terminal cause mirrored from the failed current step. */
  failureCode?: WorkflowFailureCode
  /** Safe structured byte attribution mirrored from the failed current step. */
  promptBudgetReport?: PromptBudgetReport
  /** 已请求在当前步骤完成后的安全边界暂停 */
  pauseRequested?: boolean
}

/** 工作流类型 */
export type WorkflowType =
  | 'new_project_setup'       // 新项目初始化（配置→架构→目录）
  | 'architecture_generation' // 架构生成（故事前提→角色图谱→世界观→情节大纲）
  | 'directory'               // 目录/蓝图生成
  | 'chapter_creation'        // 章节创作（写稿→修稿→审稿→定稿）
  | 'batch_generate'          // 批量生成
  | 'config_generation'       // 智能配置生成
  | 'post_process'            // 后处理任务（角色卡提取等）
  | 'novel_import'            // 导入已有小说（逆向推演全流程）

/** 工作流步骤执行器 */
export type StepExecutor = (
  step: WorkflowStep,
  context: WorkflowContext,
  callbacks: StepCallbacks,
) => Promise<string | void>

/** 工作流上下文（共享数据） */
export interface WorkflowContext {
  /** 本次运行的稳定身份，供事件消费者排除其他并发任务。 */
  runId: string
  /** 工作流启动时冻结的项目身份。 */
  projectPath: string
  /** 工作流启动时冻结的 IPC 会话，禁止在执行器内重新读取 currentProject。 */
  projectSession: ProjectSessionContext
  /** Agent 明确选择并随本次写稿工作流冻结的模型；缺失时使用默认模型。 */
  generationModelId?: string
  /** Project writing language frozen when the workflow starts. */
  writingLanguage: WritingLanguage
  /** Visible interface locale frozen when the workflow starts. */
  uiLocale: Locale
  /** 步骤间传递的数据 */
  data: Record<string, unknown>
  /** 是否已取消 */
  cancelled: boolean
  /** 是否已请求在当前步骤完成后的安全边界暂停 */
  pauseRequested?: boolean
}

/** 步骤回调 */
export interface StepCallbacks {
  /** 追加日志 */
  log: (message: string) => void
  /** 更新进度 (0-100) */
  setProgress: (progress: number) => void
  /** 流式文本追加 */
  appendText: (text: string) => void
  /** 用一份安全的临时或终态文本替换当前步骤输出。 */
  replaceText?: (text: string) => void
}

// ===== 工作流定义 =====

/** 工作流完成后的通知/跳转动作 */
export interface WorkflowCompleteAction {
  /** 通知策略：open=直接打开 | silent=仅内部状态不额外动作 */
  mode: 'open' | 'silent'
  /** 成功时的提示文案（备用，供日志用） */
  message?: string
  /** 打开结果的回调（open 模式直接调用） */
  openResult?: () => void | Promise<void>
}

export interface WorkflowDefinition {
  /** 可由需要同步订阅事件的调用方预先分配。 */
  runId?: string
  type: WorkflowType
  title: string
  /** 工作流启动时冻结的项目身份。 */
  projectPath: string
  /**
   * 工作流来源会话。缺失、过期或与项目路径不匹配的定义必须在执行前被拒绝，
   * 禁止按路径借用当前项目的新 lease。
   */
  projectSession: ProjectSessionContext
  /**
   * Renderer-owned model selection for a draft workflow. It must never be
   * populated from LLM tool arguments.
   */
  generationModelId?: string
  steps: Array<{
    name: string
    description: string
    executor: StepExecutor
  }>
  /** 工作流完成后的通知/跳转动作（可选） */
  onComplete?: WorkflowCompleteAction
}

function isCurrentWorkflowSession(
  projectPath: string,
  projectSession: ProjectSessionContext,
): boolean {
  if (!sameProjectPathKey(projectSession.projectPath, projectPath)) return false
  return sameProjectSessionContext(
    projectSession,
    projectSessionContextFromProject(useProjectStore.getState().currentProject),
  )
}

function normalizeGenerationModelId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function uiText(locale: Locale, zhCNText: string, enUSText: string): string {
  return locale === 'en-US' ? enUSText : zhCNText
}

// ===== Store =====

interface WorkflowState {
  /** 所有活跃的工作流（支持多任务并发） */
  activeRuns: WorkflowRun[]
  /** 历史工作流记录 */
  history: WorkflowRun[]
  /** 全局日志（下方面板用） */
  globalLogs: Array<{ time: string; level: 'info' | 'warn' | 'error'; message: string }>

  /** 兼容属性：第一个活跃工作流（供旧代码平稳过渡） */
  currentRun: WorkflowRun | null

  /** 步进模式：各工作流的等待状态 */
  waitingRuns: Record<string, { waitingForConfirm: boolean; waitingAfterStepIndex: number }>

  // ===== 旧接口兼容（映射到第一个 activeRun） =====
  waitingForConfirm: boolean
  waitingAfterStepIndex: number

  // ===== 便捷查询 =====
  /** 检查指定类型的工作流是否有在运行 */
  isTypeRunning: (type: WorkflowType) => boolean
  /** 是否有任何工作流在运行 */
  hasActiveRun: () => boolean
  /** 活跃任务数量 */
  activeCount: () => number
  /** 获取当前正在流式输出的活跃工作流（供 AI 输出面板消费） */
  getActiveStreamingRun: () => WorkflowRun | null
  /** 获取当前最活跃任务的步骤信息（供 StatusBar 胶囊显示） */
  getActiveStepInfo: () => { title: string; stepName: string; progress: number; total: number; completed: number } | null

  // ===== Actions =====
  /** 启动一个工作流（可并发），返回 runId */
  startWorkflow: (definition: WorkflowDefinition, stepByStep?: boolean) => Promise<string>
  /** 步进模式下确认继续执行下一步（需指定 runId） */
  confirmContinue: (runId?: string) => void
  /** 取消工作流（传 runId 取消指定，不传取消全部） */
  cancelWorkflow: (runId?: string) => void
  /** 取消指定项目的全部工作流，并等待执行器真正退出 activeRuns。 */
  cancelProjectWorkflowsAndWait: (projectPath: string, timeoutMs?: number) => Promise<void>
  /** 请求在当前步骤完成后的安全边界暂停工作流 */
  pauseWorkflow: (runId: string) => void
  /** 继续已暂停或正在等待安全暂停的工作流 */
  resumeWorkflow: (runId: string) => void
  /** 添加全局日志 */
  addLog: (level: 'info' | 'warn' | 'error', message: string, locale?: Locale) => void
  /** 清空日志 */
  clearLogs: () => void
}

/** 工作流上下文实例 Map（runId → context） */
const activeContexts = new Map<string, WorkflowContext>()
/** 步进模式：存储「等待用户确认」的 Promise resolve（runId → resolve） */
const continueResolveRefs = new Map<string, () => void>()
/** 批量任务：存储「等待恢复」的 Promise resolve（runId → resolve） */
const pauseResolveRefs = new Map<string, () => void>()

/** 计算兼容字段的辅助函数 */
function computeCompat(activeRuns: WorkflowRun[], waitingRuns: Record<string, { waitingForConfirm: boolean; waitingAfterStepIndex: number }>) {
  const currentRun = activeRuns.length > 0 ? activeRuns[0] : null
  const firstRunId = currentRun?.id ?? ''
  const firstWaiting = waitingRuns[firstRunId]
  return {
    currentRun,
    waitingForConfirm: firstWaiting?.waitingForConfirm ?? false,
    waitingAfterStepIndex: firstWaiting?.waitingAfterStepIndex ?? -1,
  }
}

export const useWorkflowStore = create<WorkflowState>()((set, get) => ({
  activeRuns: [],
  history: [],
  globalLogs: [],
  waitingRuns: {},

  // 兼容属性初始值
  currentRun: null,
  waitingForConfirm: false,
  waitingAfterStepIndex: -1,

  // ===== 便捷查询 =====
  isTypeRunning: (type) => get().activeRuns.some(r =>
    r.type === type
    && (r.status === 'running' || r.status === 'waiting' || r.status === 'paused' || r.status === 'cancelling')
  ),
  hasActiveRun: () => get().activeRuns.length > 0,
  activeCount: () => get().activeRuns.length,

  getActiveStreamingRun: () => {
    const runs = get().activeRuns
    // 优先返回正在 running 的任务；其次 waiting 的
    return runs.find(r => r.status === 'running')
      || runs.find(r => r.status === 'waiting')
      || runs.find(r => r.status === 'paused')
      || runs.find(r => r.status === 'cancelling')
      || null
  },

  getActiveStepInfo: () => {
    const run = get().activeRuns.find(r =>
      r.status === 'running'
      || r.status === 'waiting'
      || r.status === 'paused'
      || r.status === 'cancelling')
    if (!run) return null
    const step = run.steps[run.currentStepIndex] || run.steps[0]
    const completed = run.steps.filter(s => s.status === 'completed').length
    return {
      title: run.title,
      stepName: step?.name || '',
      progress: step?.progress || 0,
      total: run.steps.length,
      completed,
    }
  },

  confirmContinue: (runId) => {
    // 如果未指定 runId，使用第一个等待中的
    const targetId = runId ?? Object.keys(get().waitingRuns).find(id => get().waitingRuns[id]?.waitingForConfirm)
    if (!targetId) return
    const resolve = continueResolveRefs.get(targetId)
    if (resolve) {
      resolve()
      continueResolveRefs.delete(targetId)
    }
    set(s => {
      const newWaiting = { ...s.waitingRuns }
      delete newWaiting[targetId]
      const compat = computeCompat(s.activeRuns, newWaiting)
      return { waitingRuns: newWaiting, ...compat }
    })
  },

  startWorkflow: async (definition, stepByStep = false) => {
    const currentProject = useProjectStore.getState().currentProject
    const currentProjectSession = projectSessionContextFromProject(currentProject)
    const suppliedProjectSession = definition.projectSession
    const projectSession = isProjectSessionContext(suppliedProjectSession)
      && currentProjectSession
      && sameProjectSessionContext(suppliedProjectSession, currentProjectSession)
      && sameProjectPathKey(suppliedProjectSession.projectPath, definition.projectPath)
      ? Object.freeze({ ...suppliedProjectSession })
      : null
    const runId = definition.runId ?? randomUUID()
    const generationModelId = normalizeGenerationModelId(definition.generationModelId)
    const writingLanguage = resolveWritingLanguage(currentProject?.novelConfig.writingLanguage)
    const uiLocale = useLocaleStore.getState().locale

    // Runtime callers can still deserialize a legacy definition that predates
    // the required TypeScript field. Reject it before adding an active run or
    // executing any project-level side effect; never borrow currentProject's
    // lease based on a matching path.
    if (!projectSession) {
      const rejectedRun: WorkflowRun = {
        id: runId,
        projectPath: definition.projectPath,
        projectSession: isProjectSessionContext(suppliedProjectSession)
          ? Object.freeze({ ...suppliedProjectSession })
          : null,
        writingLanguage,
        uiLocale,
        type: definition.type,
        title: definition.title,
        status: 'failed',
        currentStepIndex: 0,
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        error: uiText(
          uiLocale,
          '工作流缺少有效的冻结项目会话，已拒绝启动',
          'The workflow is missing a valid frozen project session and was not started.',
        ),
        steps: definition.steps.map((step) => ({
          id: randomUUID(),
          name: step.name,
          description: step.description,
          status: 'pending',
          logs: [],
        })),
      }
      set(state => ({
        history: [rejectedRun, ...state.history].slice(0, 50),
      }))
      get().addLog('error', uiText(
        uiLocale,
        `[拒绝] 工作流「${definition.title}」缺少有效冻结项目会话`,
        `[Rejected] Workflow "${definition.title}" is missing a valid frozen project session`,
      ), uiLocale)
      return runId
    }
    const run: WorkflowRun = {
      id: runId,
      projectPath: definition.projectPath,
      projectSession,
      writingLanguage,
      uiLocale,
      ...(generationModelId ? { generationModelId } : {}),
      type: definition.type,
      title: definition.title,
      status: 'running',
      currentStepIndex: 0,
      createdAt: new Date().toISOString(),
      steps: definition.steps.map((s) => ({
        id: randomUUID(),
        name: s.name,
        description: s.description,
        status: 'pending',
        logs: [],
      })),
    }

    // 添加到活跃列表
    set(s => {
      const newRuns = [...s.activeRuns, run]
      return { activeRuns: newRuns, ...computeCompat(newRuns, s.waitingRuns) }
    })
    get().addLog('info', uiText(
      uiLocale,
      `[开始] 工作流「${definition.title}」已启动`,
      `[Started] Workflow "${definition.title}" started`,
    ), uiLocale)

    // 自动联动：打开右侧面板的 AI 输出视图（非阻塞 import 避免循环依赖）
    import('./layout-store').then(m => m.useLayoutStore.getState().openRightPanel('ai-output')).catch(() => {})

    // 创建执行上下文
    const context: WorkflowContext = {
      runId: run.id,
      projectPath: definition.projectPath,
      projectSession,
      writingLanguage,
      uiLocale,
      ...(generationModelId ? { generationModelId } : {}),
      data: {},
      cancelled: false,
      pauseRequested: false,
    }
    activeContexts.set(run.id, context)

    const waitForResumeAtSafeBoundary = async () => {
      if (!context.pauseRequested || context.cancelled) return

      updateRunById(set, run.id, { status: 'paused', pauseRequested: false })
      get().addLog('info', uiText(
        context.uiLocale,
        `[暂停] 工作流「${definition.title}」已在当前步骤完成后暂停`,
        `[Paused] Workflow "${definition.title}" paused after the current step`,
      ), context.uiLocale)
      await new Promise<void>((resolve) => { pauseResolveRefs.set(run.id, resolve) })
      if (!context.cancelled) {
        updateRunById(set, run.id, { status: 'running', pauseRequested: false })
        get().addLog('info', uiText(
          context.uiLocale,
          `[继续] 工作流「${definition.title}」已继续`,
          `[Resumed] Workflow "${definition.title}" resumed`,
        ), context.uiLocale)
      }
    }

    // 逐步执行
    for (let i = 0; i < definition.steps.length; i++) {
      // 批量任务只在步骤之间暂停，避免中断一次正在进行的模型请求或后处理。
      await waitForResumeAtSafeBoundary()

      // 检查取消
      if (context.cancelled) {
        updateRunById(set, run.id, {
          status: 'failed',
          error: uiText(context.uiLocale, '工作流已取消', 'Workflow was cancelled.'),
        })
        get().addLog('warn', uiText(
          context.uiLocale,
          `[取消] 工作流「${definition.title}」已取消`,
          `[Cancelled] Workflow "${definition.title}" was cancelled`,
        ), context.uiLocale)
        break
      }

      if (!isCurrentWorkflowSession(definition.projectPath, context.projectSession)) {
        updateRunById(set, run.id, {
          status: 'failed',
          error: uiText(context.uiLocale, '项目会话已切换或失效', 'The project session changed or expired.'),
        })
        get().addLog('error', uiText(
          context.uiLocale,
          `[失败] 工作流「${definition.title}」已停止：项目会话已切换或失效`,
          `[Failed] Workflow "${definition.title}" stopped because the project session changed or expired`,
        ), context.uiLocale)
        break
      }

      const stepDef = definition.steps[i]

      // 标记当前步骤为运行中
      updateStepById(set, run.id, i, { status: 'running', startedAt: new Date().toISOString() })
      updateRunById(set, run.id, { currentStepIndex: i })
      get().addLog('info', uiText(
        context.uiLocale,
        `[执行] [${definition.title}] 步骤: ${stepDef.name}`,
        `[Running] [${definition.title}] Step: ${stepDef.name}`,
      ), context.uiLocale)

      // 创建步骤回调
      const callbacks: StepCallbacks = {
        log: (message) => {
          appendStepLogById(set, run.id, i, message)
          get().addLog('info', `  ${message}`, context.uiLocale)
        },
        setProgress: (progress) => {
          updateStepById(set, run.id, i, { progress })
        },
        appendText: (text) => {
          const activeRun = get().activeRuns.find(r => r.id === run.id)
          const step = activeRun?.steps[i]
          if (
            activeRun?.status !== 'running'
            || activeRun.currentStepIndex !== i
            || step?.status !== 'running'
          ) return
          updateStepById(set, run.id, i, { result: (step.result || '') + text })
        },
        replaceText: (text) => {
          const activeRun = get().activeRuns.find(r => r.id === run.id)
          const step = activeRun?.steps[i]
          if (
            !activeRun
            || activeRun.currentStepIndex !== i
            || step?.status !== 'running'
          ) return
          const isRunningMutation = activeRun.status === 'running'
          const isCancellationCleanup = activeRun.status === 'cancelling' && text === ''
          if (isRunningMutation || isCancellationCleanup) {
            updateStepById(set, run.id, i, { result: text })
          }
        },
      }

      try {
        const result = await stepDef.executor(run.steps[i], context, callbacks)
        if (context.cancelled) {
          throw new Error(uiText(context.uiLocale, '工作流已取消', 'Workflow was cancelled.'))
        }
        if (!isCurrentWorkflowSession(definition.projectPath, context.projectSession)) {
          throw new Error(uiText(
            context.uiLocale,
            '项目会话已切换或失效，工作流已停止以避免跨项目写入',
            'The project session changed or expired. The workflow stopped to prevent a cross-project write.',
          ))
        }
        updateStepById(set, run.id, i, {
          status: 'completed',
          completedAt: new Date().toISOString(),
          progress: 100,
          result: result || get().activeRuns.find(r => r.id === run.id)?.steps[i].result,
        })
        get().addLog('info', uiText(
          context.uiLocale,
          `[完成] [${definition.title}] 步骤: ${stepDef.name}`,
          `[Completed] [${definition.title}] Step: ${stepDef.name}`,
        ), context.uiLocale)

        // 步进模式：非最后一步，且未取消 → 暂停等待用户确认
        if (stepByStep && i < definition.steps.length - 1 && !context.cancelled) {
          updateRunById(set, run.id, { status: 'waiting' })
          set(s => {
            const newWaiting = { ...s.waitingRuns, [run.id]: { waitingForConfirm: true, waitingAfterStepIndex: i } }
            return { waitingRuns: newWaiting, ...computeCompat(s.activeRuns, newWaiting) }
          })
          get().addLog('info', uiText(
            context.uiLocale,
            `[暂停] [${definition.title}] 等待确认继续第 ${i + 2} 步：${definition.steps[i + 1].name}`,
            `[Paused] [${definition.title}] Waiting for confirmation before step ${i + 2}: ${definition.steps[i + 1].name}`,
          ), context.uiLocale)
          await new Promise<void>((resolve) => { continueResolveRefs.set(run.id, resolve) })
          if (context.cancelled) break
          updateRunById(set, run.id, { status: 'running' })
        }
      } catch (error) {
        const promptBudgetFailure = promptBudgetFailureFromError(error, context.uiLocale)
        const errorMsg = promptBudgetFailure?.message
          ?? (error instanceof Error ? error.message : String(error))
        const failureCode = getBoundedCompletionFailureCode(error)
          ?? promptBudgetFailure?.failureCode
        updateStepById(set, run.id, i, {
          status: 'failed',
          error: errorMsg,
          ...(failureCode ? { failureCode } : {}),
          ...(promptBudgetFailure ? { promptBudgetReport: promptBudgetFailure.report } : {}),
          completedAt: new Date().toISOString(),
        })
        updateRunById(set, run.id, {
          status: 'failed',
          error: errorMsg,
          ...(failureCode ? { failureCode } : {}),
          ...(promptBudgetFailure ? { promptBudgetReport: promptBudgetFailure.report } : {}),
        })
        get().addLog('error', uiText(
          context.uiLocale,
          `[失败] [${definition.title}] 步骤: ${stepDef.name} — ${errorMsg}`,
          `[Failed] [${definition.title}] Step: ${stepDef.name} — ${errorMsg}`,
        ), context.uiLocale)
        break
      }
    }

    // 检查是否全部完成
    let finalRun = get().activeRuns.find(r => r.id === run.id)
    if (finalRun?.status === 'cancelling' || context.cancelled) {
      updateRunById(set, run.id, {
        status: 'failed',
        error: uiText(context.uiLocale, '工作流已取消', 'Workflow was cancelled.'),
        completedAt: new Date().toISOString(),
      })
      finalRun = get().activeRuns.find(r => r.id === run.id)
    }
    if (finalRun && finalRun.status === 'running' && !isCurrentWorkflowSession(
      definition.projectPath,
      context.projectSession,
    )) {
      updateRunById(set, run.id, {
        status: 'failed',
        error: uiText(
          context.uiLocale,
          '项目会话已切换或失效，未提交工作流完成结果',
          'The project session changed or expired, so the workflow completion result was not committed.',
        ),
        completedAt: new Date().toISOString(),
      })
      finalRun = get().activeRuns.find(r => r.id === run.id)
    }
    if (finalRun && finalRun.status === 'running') {
      const projectSession = context.projectSession
      updateRunById(set, run.id, { status: 'completed', completedAt: new Date().toISOString() })
      get().addLog('info', uiText(
        context.uiLocale,
        `[完成] 工作流「${definition.title}」已完成`,
        `[Completed] Workflow "${definition.title}" completed`,
      ), context.uiLocale)

      // 同步广播，并且必须发生在 activeRuns 清理之前。
      // 消费者可用 runId/projectPath 精确识别本次完成，且不会因动态 import 延迟丢失事件。
      globalEventBus.emit('WORKFLOW_COMPLETE', {
        type: definition.type,
        projectPath: definition.projectPath,
        projectSession,
        runId: run.id,
      })

      // ===== 执行 onComplete 通知/跳转 =====
      if (definition.onComplete) {
        const { mode, openResult } = definition.onComplete
        try {
          if (mode === 'open' && openResult) {
            // 直接打开结果
            await openResult()
          }
          // silent 模式不做额外操作
        } catch (e) {
          get().addLog('warn', uiText(
            context.uiLocale,
            `[警告] onComplete 执行失败: ${e}`,
            `[Warning] onComplete failed: ${e}`,
          ), context.uiLocale)
        }
      }
    }

    // 从活跃列表移除，存入历史
    set(s => {
      const completedRun = s.activeRuns.find(r => r.id === run.id)
      const newRuns = s.activeRuns.filter(r => r.id !== run.id)
      const newWaiting = { ...s.waitingRuns }
      delete newWaiting[run.id]
      const newHistory = completedRun
        ? [completedRun, ...s.history].slice(0, 50)
        : s.history
      return {
        activeRuns: newRuns,
        history: newHistory,
        waitingRuns: newWaiting,
        ...computeCompat(newRuns, newWaiting),
      }
    })

    // 清理上下文
    activeContexts.delete(run.id)
    continueResolveRefs.delete(run.id)
    pauseResolveRefs.delete(run.id)

    return run.id
  },

  cancelWorkflow: (runId) => {
    if (runId) {
      // 取消指定工作流
      const ctx = activeContexts.get(runId)
      const targetRun = get().activeRuns.find(r => r.id === runId)
      if (!ctx || !targetRun || targetRun.status === 'completed' || targetRun.status === 'failed') {
        return
      }
      if (ctx) {
        ctx.cancelled = true
        ctx.pauseRequested = false
      }
      // 如果在步进等待，解除 Promise
      const resolve = continueResolveRefs.get(runId)
      if (resolve) { resolve(); continueResolveRefs.delete(runId) }
      const pauseResolve = pauseResolveRefs.get(runId)
      if (pauseResolve) { pauseResolve(); pauseResolveRefs.delete(runId) }
      // 保留在活跃列表中，直到当前执行器真正退出。项目切换/清空门禁据此继续生效。
      set(s => {
        const newWaiting = { ...s.waitingRuns }
        delete newWaiting[runId]
        const newRuns = s.activeRuns.map(r => r.id === runId
          ? {
              ...r,
              status: 'cancelling' as const,
              error: uiText(
                r.uiLocale,
                '正在取消，等待当前操作安全退出',
                'Cancellation requested; waiting for the current operation to exit safely.',
              ),
            }
          : r)
        return {
          activeRuns: newRuns,
          waitingRuns: newWaiting,
          ...computeCompat(newRuns, newWaiting),
        }
      })
      get().addLog('warn', uiText(
        targetRun.uiLocale,
        '[取消] 取消请求已提交，等待当前操作安全退出',
        '[Cancel requested] Waiting for the current operation to exit safely',
      ), targetRun.uiLocale)
    } else {
      // 取消全部
      const targetRuns = get().activeRuns.filter(run =>
        run.status !== 'completed' && run.status !== 'failed'
      )
      for (const [id, ctx] of activeContexts) {
        const run = get().activeRuns.find(item => item.id === id)
        if (!run || run.status === 'completed' || run.status === 'failed') continue
        ctx.cancelled = true
        ctx.pauseRequested = false
        const resolve = continueResolveRefs.get(id)
        if (resolve) { resolve(); continueResolveRefs.delete(id) }
        const pauseResolve = pauseResolveRefs.get(id)
        if (pauseResolve) { pauseResolve(); pauseResolveRefs.delete(id) }
      }
      set(s => {
        const cancellingRuns = s.activeRuns.map(r => ({
          ...r,
          ...(r.status === 'completed' || r.status === 'failed'
            ? {}
            : {
                status: 'cancelling' as const,
                error: uiText(
                  r.uiLocale,
                  '正在取消，等待当前操作安全退出',
                  'Cancellation requested; waiting for the current operation to exit safely.',
                ),
              }),
        }))
        return {
          activeRuns: cancellingRuns,
          waitingRuns: {},
          ...computeCompat(cancellingRuns, {}),
        }
      })
      for (const targetRun of targetRuns) {
        get().addLog('warn', uiText(
          targetRun.uiLocale,
          `[取消] 工作流「${targetRun.title}」的取消请求已提交，等待当前操作安全退出`,
          `[Cancel requested] Waiting for workflow "${targetRun.title}" to exit safely`,
        ), targetRun.uiLocale)
      }
    }
  },

  cancelProjectWorkflowsAndWait: async (projectPath, timeoutMs = 30_000) => {
    const targetRuns = get().activeRuns
      .filter(run => sameProjectPathKey(run.projectPath, projectPath))
    const targetIds = targetRuns.map(run => run.id)
    for (const runId of targetIds) {
      get().cancelWorkflow(runId)
    }
    if (targetIds.length === 0) return

    const deadline = Date.now() + timeoutMs
    while (get().activeRuns.some(run => sameProjectPathKey(run.projectPath, projectPath))) {
      if (Date.now() >= deadline) {
        throw new Error(uiText(
          targetRuns[0].uiLocale,
          '等待后台任务停止超时，项目保持打开状态',
          'Timed out waiting for background tasks to stop; the project remains open.',
        ))
      }
      await new Promise<void>(resolve => setTimeout(resolve, 50))
    }
  },

  pauseWorkflow: (runId) => {
    const context = activeContexts.get(runId)
    const run = get().activeRuns.find(item => item.id === runId)
    if (!context || !run || context.cancelled || run.status === 'paused') return

    context.pauseRequested = true
    updateRunById(set, runId, { pauseRequested: true })
    get().addLog('info', uiText(
      run.uiLocale,
      `[暂停] 已请求暂停「${run.title}」，将在当前章节完成后生效`,
      `[Pause requested] "${run.title}" will pause after the current chapter`,
    ), run.uiLocale)
  },

  resumeWorkflow: (runId) => {
    const context = activeContexts.get(runId)
    const run = get().activeRuns.find(item => item.id === runId)
    if (!context || !run || context.cancelled) return

    context.pauseRequested = false
    const resolve = pauseResolveRefs.get(runId)
    if (resolve) {
      resolve()
      pauseResolveRefs.delete(runId)
    } else {
      updateRunById(set, runId, { pauseRequested: false })
    }
  },

  addLog: (level, message, locale = useLocaleStore.getState().locale) => {
    const entry = { time: new Date().toLocaleTimeString(locale), level, message }
    set((s) => ({
      globalLogs: [...s.globalLogs, entry].slice(-500), // 保留最近 500 条
    }))
  },

  clearLogs: () => set({ globalLogs: [] }),
}))

// ===== 工具函数（按 runId 操作） =====

/** 更新指定工作流的运行状态 */
function updateRunById(
  set: (fn: (s: WorkflowState) => Partial<WorkflowState>) => void,
  runId: string,
  updates: Partial<WorkflowRun>
) {
  set((s) => {
    const newRuns = s.activeRuns.map(r =>
      r.id === runId ? { ...r, ...updates } : r
    )
    return { activeRuns: newRuns, ...computeCompat(newRuns, s.waitingRuns) }
  })
}

/** 更新指定工作流的指定步骤 */
function updateStepById(
  set: (fn: (s: WorkflowState) => Partial<WorkflowState>) => void,
  runId: string,
  stepIndex: number,
  updates: Partial<WorkflowStep>
) {
  set((s) => {
    const newRuns = s.activeRuns.map(r => {
      if (r.id !== runId) return r
      const steps = [...r.steps]
      steps[stepIndex] = { ...steps[stepIndex], ...updates }
      return { ...r, steps }
    })
    return { activeRuns: newRuns, ...computeCompat(newRuns, s.waitingRuns) }
  })
}

/** 追加指定工作流的指定步骤日志 */
function appendStepLogById(
  set: (fn: (s: WorkflowState) => Partial<WorkflowState>) => void,
  runId: string,
  stepIndex: number,
  message: string
) {
  set((s) => {
    const newRuns = s.activeRuns.map(r => {
      if (r.id !== runId) return r
      const steps = [...r.steps]
      steps[stepIndex] = {
        ...steps[stepIndex],
        logs: [...steps[stepIndex].logs, `[${new Date().toLocaleTimeString(r.uiLocale)}] ${message}`],
      }
      return { ...r, steps }
    })
    return { activeRuns: newRuns, ...computeCompat(newRuns, s.waitingRuns) }
  })
}
