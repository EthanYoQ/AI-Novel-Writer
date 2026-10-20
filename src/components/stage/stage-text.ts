import type { EditorTab } from '../../stores/editor-store'
import type { ResourcePage, WorkStage } from '../../stores/navigation/navigation-intents'
import type { ChapterPhase } from '../../stores/navigation/stage-progress'

type Text = (zh: string, en: string) => string

export const STAGE_NAMES: Record<WorkStage, [string, string]> = {
  setup: ['设定', 'Setup'],
  architecture: ['架构', 'Architecture'],
  blueprint: ['蓝图', 'Blueprint'],
  manuscript: ['正文', 'Manuscript'],
}

/** 章节状态在流程脊与 Ctrl K 里的说明：写出下一步，定稿章写「定稿」。 */
export const CHAPTER_PHASE_TEXT: Record<ChapterPhase, [string, string]> = {
  todo: ['待写', 'To write'],
  draft: ['待审稿', 'To review'],
  reviewed: ['待修稿', 'To revise'],
  merge: ['待合并', 'To merge'],
  revised: ['待定稿', 'To finalize'],
  final: ['定稿', 'Final'],
}

export const CHAPTER_RUNNING_TEXT: [string, string] = ['生成中', 'Writing']

export const RESOURCE_NAMES: Record<ResourcePage, [string, string]> = {
  plot: ['剧情与伏笔', 'Plot & threads'],
  knowledge: ['知识库', 'Knowledge base'],
  history: ['版本历史', 'Version history'],
}

/** 阶段、资料页与角色名单的标签用固定的名字（阶段与资料页取流程脊上的名字），同一个页面只有一个名字。 */
const PAGE_TAB_NAMES: Partial<Record<EditorTab['type'], [string, string]>> = {
  config: STAGE_NAMES.setup,
  'world-building': STAGE_NAMES.architecture,
  character: ['角色名单', 'Cast'],
  'chapter-card': STAGE_NAMES.blueprint,
  'narrative-thread': RESOURCE_NAMES.plot,
  knowledge: RESOURCE_NAMES.knowledge,
  'version-history': RESOURCE_NAMES.history,
}

/** 标签显示的名字。正文、审稿报告与恢复草稿等标签沿用各自的名字。 */
export function stageTabName(tab: Pick<EditorTab, 'type' | 'name' | 'planningRecovery'>, text: Text): string {
  const name = tab.planningRecovery ? undefined : PAGE_TAB_NAMES[tab.type]
  return name ? text(...name) : tab.name
}
