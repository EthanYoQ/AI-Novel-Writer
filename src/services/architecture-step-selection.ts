import type { OutlineProgress } from '../shared/plot-outline-checkpoint'

export type ArchStepKey = 'premise' | 'characters' | 'worldbuilding' | 'synopsis'

type ArchCoreKey = Exclude<ArchStepKey, 'characters'>

/** 一节有没有内容：去掉空白后不为空，作者写的短内容也算（要显示出来，生成时会被覆盖）。 */
export function archSectionHasContent(value: string | null | undefined): boolean {
  return Boolean(value?.trim())
}

/**
 * 前提、世界观、情节大纲三节「有内容」与「已确认」的唯一判定，架构页、架构文档页的生成对话框与流程脊共用；角色名单由调用方按名单是否就绪补上。
 * 有内容见 archSectionHasContent。
 * 已确认：有内容，且前提、世界观超过 50 字，情节大纲按分批进度写满全书。
 */
export function judgeArchCore(
  core: Partial<Record<ArchCoreKey, string | null>> | null | undefined,
  synopsisProgress: OutlineProgress['kind'],
): { hasContent: Record<ArchCoreKey, boolean>; confirmed: Record<ArchCoreKey, boolean> } {
  const confirmedProse = (value: string | null | undefined) => archSectionHasContent(value) && (value ?? '').length > 50
  return {
    hasContent: {
      premise: archSectionHasContent(core?.premise),
      worldbuilding: archSectionHasContent(core?.worldbuilding),
      synopsis: archSectionHasContent(core?.synopsis),
    },
    confirmed: {
      premise: confirmedProse(core?.premise),
      worldbuilding: confirmedProse(core?.worldbuilding),
      synopsis: archSectionHasContent(core?.synopsis) && synopsisProgress === 'complete',
    },
  }
}

const ARCH_STEP_ORDER: ArchStepKey[] = ['premise', 'characters', 'worldbuilding', 'synopsis']

/** 架构四节的名字（中、英）。架构页、生成对话框、提交提示与单节文档标签共用这一张；名单页的图形视图叫「关系图谱」，不与名单混名。 */
export const ARCH_STEP_NAMES: Record<ArchStepKey, readonly [string, string]> = {
  premise: ['故事前提', 'Premise'],
  characters: ['角色名单', 'Cast'],
  worldbuilding: ['世界观', 'World'],
  synopsis: ['情节大纲', 'Outline'],
}

export function createDefaultArchitectureSelection(
  archStatus: Record<string, boolean>,
  initialSelectedSteps?: ArchStepKey[],
): Record<ArchStepKey, boolean> {
  const selected = new Set<ArchStepKey>()

  for (const step of ARCH_STEP_ORDER) {
    if (!archStatus[step]) selected.add(step)
  }

  if (initialSelectedSteps) {
    for (const step of initialSelectedSteps) {
      selected.add(step)
    }
  }

  return {
    premise: selected.has('premise'),
    characters: selected.has('characters'),
    worldbuilding: selected.has('worldbuilding'),
    synopsis: selected.has('synopsis'),
  }
}
