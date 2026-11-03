import type { ChapterPhase } from '../../../stores/navigation/stage-progress'

/**
 * 单章视图所处的一步，决定主按钮：待写写作此章，草稿 AI 审稿，已审稿按意见修稿，有待合并修稿完成合并，已修稿定稿。
 * 与流程脊同一个 chapterPhase；另有已归档的旧稿，只读。
 */
export type ChapterStage = ChapterPhase | 'archived' | 'superseded'

/** 生命周期条上当前高亮的一步：0 写作、1 审稿、2 修稿、3 定稿、4 全部完成。 */
export const STAGE_STEP: Record<ChapterStage, number> = {
  todo: 0,
  draft: 1,
  reviewed: 2,
  merge: 2,
  revised: 3,
  final: 4,
  archived: 4,
  superseded: 4,
}
