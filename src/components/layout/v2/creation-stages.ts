/**
 * 「墨纸书斋」的六道工序（常量与类型）。
 *
 * 单独成文件是为了让 FlowStages.tsx 只导出组件 —— 组件文件里同时导出常量会
 * 破坏 Fast Refresh（react-refresh/only-export-components），而项目 lint 卡零告警。
 *
 * 工序与 demo 的阶段条同构，数据侧来自产品既有的工作流类型，不引入新的业务状态。
 */
export type CreationStage = 'config' | 'arch' | 'bp' | 'draft' | 'review' | 'final'

export const CREATION_STAGE_ORDER: readonly CreationStage[] = ['config', 'arch', 'bp', 'draft', 'review', 'final']

export const STAGE_LABEL: Record<CreationStage, { zh: string; en: string }> = {
  config: { zh: '配置', en: 'Setup' },
  arch: { zh: '架构', en: 'Architecture' },
  bp: { zh: '蓝图', en: 'Blueprints' },
  draft: { zh: '草稿', en: 'Draft' },
  review: { zh: '审稿', en: 'Review' },
  final: { zh: '定稿', en: 'Final' },
}

/**
 * 每道工序「是干什么的」—— 先生要求顶栏把工序的作用显示出来，
 * 鼠标停在阶段上就能看到这条说明。
 */
export const STAGE_HINT: Record<CreationStage, { zh: string; en: string }> = {
  config: {
    zh: '配置：题材、视角、总章数等写作参数',
    en: 'Setup: genre, point of view and the writing parameters',
  },
  arch: {
    zh: '架构：故事前提、人物、世界观与梗概',
    en: 'Architecture: premise, cast, worldbuilding and synopsis',
  },
  bp: {
    zh: '蓝图：每一章的定位、冲突与末尾钩子',
    en: 'Blueprints: each chapter’s role, conflict and hook',
  },
  draft: {
    zh: '草稿：按蓝图把正文写出来',
    en: 'Draft: write the prose from the blueprint',
  },
  review: {
    zh: '审稿：一致性与文风检查，产出审稿报告',
    en: 'Review: consistency and style check with a report',
  },
  final: {
    zh: '定稿：锁定这一章并回填章节要点',
    en: 'Final: lock the chapter and backfill its key beats',
  },
}
