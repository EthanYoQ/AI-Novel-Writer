import { chapterLabel } from '../../../shared/chapter-label'
import type { ReadyProjectOverview } from '../../../shared/project-overview'
import type { NavigationIntent, WorkStage } from '../../../stores/navigation/navigation-intents'
import { focusChapter, landingStage, type ChapterRow, type StageStatus } from '../../../stores/navigation/stage-progress'
import { CHAPTER_PHASE_TEXT, STAGE_NAMES } from '../stage-text'

type Text = (zh: string, en: string) => string

/** 概览卡上一个阶段的进度条：完成为完成色，进行中按比例填强调色，未开始为轨道色。 */
export interface StageBar {
  stage: WorkStage
  state: 'done' | 'active' | 'todo'
  /** 进行中时的完成比例，0 到 1。 */
  ratio: number
  label: string
}

const bar = (stage: WorkStage, state: StageBar['state'], ratio: number, label: string): StageBar => ({ stage, state, ratio, label })

/** 当前作品：与流程脊同源，阶段状态完全一致。 */
export function barsFromStages(stages: readonly StageStatus[], text: Text): StageBar[] {
  return stages.map(status => {
    const name = text(...STAGE_NAMES[status.stage])
    const state = status.progress.state
    const ratio = status.progress.state === 'active' ? status.progress.ratio : state === 'done' ? 1 : 0
    switch (status.stage) {
      case 'setup':
        return bar('setup', state, ratio, state === 'done' ? name : text(`${name} 还差 ${status.missing.length} 项`, `${name}: ${status.missing.length} left`))
      case 'architecture':
        return bar('architecture', state, ratio, state === 'done' ? name : `${name} ${status.filled} / ${status.total}`)
      case 'blueprint':
        return bar('blueprint', state, ratio, status.planned > 0 ? text(`${name} ${status.planned} 章`, `${name} ${status.planned} ch.`) : name)
      case 'manuscript':
        return bar('manuscript', state, ratio, status.total > 0
          ? `${name} ${status.finalized} / ${status.total}`
          : text(`${name} ${status.finalized} 章定稿`, `${name} ${status.finalized} final`))
    }
  })
}

/**
 * 只预览、未打开的书：设定按主进程返回的必填是否齐全（与流程脊同一口径，只说齐没齐），
 * 架构按四节，蓝图有 1 章即完成，正文写定稿章数与规划章数，定稿达到规划章数即完成（同流程脊）。
 */
export function barsFromOverview(overview: ReadyProjectOverview, text: Text): StageBar[] {
  const find = (id: ReadyProjectOverview['stages'][number]['id']) => overview.stages.find(stage => stage.id === id)
  const configuration = find('configuration')
  const architecture = find('architecture')?.count ?? 0
  const blueprints = find('blueprint')?.count ?? 0
  const drafted = find('drafting')?.count ?? 0
  const finalized = find('finalization')?.count ?? 0
  const name = (stage: WorkStage) => text(...STAGE_NAMES[stage])
  const setupReady = overview.setupReady ?? configuration?.status === 'completed'
  const setupState = setupReady ? 'done' : configuration?.count ? 'active' : 'todo'
  const planned = overview.plannedChapters ?? 0
  const written = planned > 0 && finalized >= planned
  return [
    bar('setup', setupState, setupReady ? 1 : 0, setupReady ? name('setup') : text(`${name('setup')} 未齐`, `${name('setup')}: incomplete`)),
    bar('architecture', architecture >= 4 ? 'done' : architecture > 0 ? 'active' : 'todo', architecture / 4,
      architecture >= 4 ? name('architecture') : `${name('architecture')} ${architecture} / 4`),
    bar('blueprint', blueprints > 0 ? 'done' : 'todo', blueprints > 0 ? 1 : 0,
      blueprints > 0 ? text(`${name('blueprint')} ${blueprints} 章`, `${name('blueprint')} ${blueprints} ch.`) : name('blueprint')),
    bar('manuscript', written ? 'done' : finalized > 0 || drafted > 0 ? 'active' : 'todo', written ? 1 : planned > 0 ? finalized / planned : 0, planned > 0
      ? `${name('manuscript')} ${finalized} / ${planned}`
      : text(`${name('manuscript')} ${finalized} 章定稿`, `${name('manuscript')} ${finalized} final`)),
  ]
}

/** 「继续写作」去哪：第一个未完成的阶段；到了正文就是该写的那一章。 */
export function nextStep(stages: readonly StageStatus[], chapters: readonly ChapterRow[], text: Text): { label: string; intent: NavigationIntent } {
  const stage = landingStage(stages)
  const row = stage === 'manuscript' ? focusChapter(chapters) : null
  if (row) {
    return {
      label: `${chapterLabel(row.number, text)} · ${text(...CHAPTER_PHASE_TEXT[row.phase])}`,
      intent: { kind: 'chapter', chapterNumber: row.number },
    }
  }
  return { label: text(...STAGE_NAMES[stage]), intent: { kind: 'stage', stage } }
}
