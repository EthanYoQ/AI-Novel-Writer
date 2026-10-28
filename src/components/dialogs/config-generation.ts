import type { NovelConfig } from '../../shared/ipc-channels'
import { createConfigGenerationWorkflow } from '../../services/workflows/architecture-workflow'
import { routeModelId } from '../../services/model-routing'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore, workflowResourceConflictMessage } from '../../stores/workflow-store'
import { toast } from '../ui/Toast'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { pluralEn } from '../../shared/plural-en'

type Text = (zh: string, en: string) => string

/** 已有作者内容的长字段：AI 填充会保留原文并追加，开始前要让作者确认扩写。 */
export function configFieldsToExpand(config: Partial<NovelConfig> | undefined, text: Text): string[] {
  const fields: string[] = []
  if (config?.coreOutline?.trim()) fields.push(text('核心大纲', 'Core outline'))
  if (config?.worldSetting?.trim()) fields.push(text('世界观设定', 'World setting'))
  if (config?.goldenFinger?.trim()) fields.push(text('金手指体系', 'Special advantage'))
  if (config?.protagonistProfile?.trim()) fields.push(text('主角人设', 'Protagonist profile'))
  if (config?.globalGuidance?.trim()) fields.push(text('全局写作要求', 'Global writing guidance'))
  if (config?.subGenre?.trim()) fields.push(text('细分类型', 'Subgenre'))
  return fields
}

/**
 * 按创作脑洞与当前规模在后台启动 AI 填充配置。规划环节没有可用模型、与正在运行的任务冲突时不启动，返回 false。
 * 设定页的 AI 补全与单项生成用它。
 */
export function startConfigGeneration({ idea, projectSession, onGenerated }: {
  idea: string
  projectSession: ProjectSessionContext
  onGenerated: (config: Partial<NovelConfig>) => void
}): boolean {
  const text = useLocaleStore.getState().text
  const { addLog, startWorkflow } = useWorkflowStore.getState()
  if (!routeModelId('generate-global-config')) {
    addLog('error', text('请先在设置中配置 AI 模型', 'Configure an AI model in Settings first.'))
    return false
  }
  const config = useProjectStore.getState().currentProject?.novelConfig
  const totalChapters = config?.totalChapters || 100
  const wordsPerChapter = config?.wordsPerChapter || 3000
  const workflow = createConfigGenerationWorkflow({
    projectPath: projectSession.projectPath,
    projectSession,
    idea,
    totalChapters,
    wordsPerChapter,
    onGenerated,
  })
  const conflict = useWorkflowStore.getState().getResourceConflict(workflow)
  if (conflict) {
    toast.warning(workflowResourceConflictMessage(useLocaleStore.getState().locale, conflict.title))
    return false
  }
  toast.info(text('正在根据脑洞生成小说配置...', 'Generating novel configuration from your idea...'))
  addLog('info', text(`正在根据创作脑洞生成小说配置（规模：${totalChapters} 章 / ${wordsPerChapter} 字/章）...`, `Generating novel configuration (${totalChapters} ${pluralEn(totalChapters, 'chapter')} / ${wordsPerChapter} ${pluralEn(wordsPerChapter, 'word')} per chapter)...`))
  // 后台执行 LLM 调用，由 WorkflowEngine 接管并显示运行状态。
  void startWorkflow(workflow)
  return true
}
