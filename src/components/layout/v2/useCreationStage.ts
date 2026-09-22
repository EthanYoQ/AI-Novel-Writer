import { useMemo } from 'react'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import type { WorkflowType } from '../../../stores/workflow-store'
import { sameProjectPathKey } from '../../../shared/project-session-context'
import { CREATION_STAGE_ORDER, type CreationStage } from '../../layout/v2/creation-stages'

/**
 * 工作流类型 → 创作工序的对应关系。
 *
 * 与 WorkflowType 的定义一一对应（见 stores/workflow-store.ts）：
 * 新项目初始化走「配置」，架构生成走「架构」，目录生成走「蓝图」，
 * 章节创作与批量生成落在「草稿」，导入小说是逆向推演全流程、从「配置」起步，
 * 后处理（角色卡提取等）发生在定稿之后，归入「定稿」。
 *
 * **故意写成 Partial**：便利贴的 AI 灵感抽卡（inspiration_draw）不在这里登记 ——
 * 它不是创作工序的一环，产物也不进正文。漏登记的结果正是我们要的：工序条整条
 * 置灰，而不是被一个私人灵感任务点亮点错。（下方的 includes 判定会兜住 undefined。）
 */
const STAGE_BY_WORKFLOW: Partial<Record<WorkflowType, CreationStage>> = {
  new_project_setup: 'config',
  config_generation: 'config',
  novel_import: 'config',
  architecture_generation: 'arch',
  directory: 'bp',
  chapter_creation: 'draft',
  batch_generate: 'draft',
  post_process: 'final',
}

/**
 * 章节创作内部会依次经过写稿 → 修稿 → 审稿 → 定稿，
 * 这些子阶段只体现在步骤名上，因此单独做一次线索识别，
 * 让工序条在跑长篇时能真实前进，而不是全程停在「草稿」。
 */
const STEP_STAGE_HINTS: ReadonlyArray<{ stage: CreationStage; pattern: RegExp }> = [
  { stage: 'final', pattern: /定稿|finali[sz]/i },
  { stage: 'review', pattern: /审稿|审校|review/i },
]

function stageFromStepName(name: string | undefined): CreationStage | null {
  if (!name) return null
  for (const hint of STEP_STAGE_HINTS) {
    if (hint.pattern.test(name)) return hint.stage
  }
  return null
}

export interface CreationStageView {
  /** 当前进行中的工序；无进行中任务时为 null（工序条整条置灰）。 */
  current: CreationStage | null
  /** 该工序是否来自真实运行中的工作流（false 表示只是保守推断）。 */
  live: boolean
}

/**
 * 从既有工作流状态派生「当前创作工序」。
 *
 * 只读现有 store，不引入任何新的持久化状态：界面换壳不应产生新的业务真相。
 */
export function useCreationStage(): CreationStageView {
  const currentProjectPath = useProjectStore((s) => s.currentProject?.path)
  const activeRuns = useWorkflowStore((s) => s.activeRuns)

  return useMemo(() => {
    const running = activeRuns.filter(
      (run) => run.status === 'running' || run.status === 'waiting',
    )
    // 优先认当前项目的运行，避免多项目并行时工序条指向别的作品
    const scoped = currentProjectPath
      ? running.filter((run) => sameProjectPathKey(run.projectPath, currentProjectPath))
      : running
    const run = scoped[0]
    if (!run) return { current: null, live: false }

    // 命令式读取：getActiveStepInfo() 每次返回**新对象**，
    // 绝不能进 useMemo 依赖（一旦被写成订阅型选择器就会触发 Zustand 的
    // 「getSnapshot should be cached」无限重渲染）。它的值只取决于 activeRuns，
    // 而 activeRuns 已在依赖里，所以这里不需要额外依赖。
    const byStep = stageFromStepName(useWorkflowStore.getState().getActiveStepInfo()?.stepName)
    const stage = byStep ?? STAGE_BY_WORKFLOW[run.type] ?? null
    if (!stage || !CREATION_STAGE_ORDER.includes(stage)) return { current: null, live: false }
    return { current: stage, live: true }
  }, [activeRuns, currentProjectPath])
}
