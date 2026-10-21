import type { CharacterStateTextField } from '../../shared/character-roster'
import { EMPTY_STATE, type CharacterCard, type CharacterCurrentState } from '../../stores/character-store'

export const CHARACTER_STATE_FIELDS: readonly (readonly [CharacterStateTextField, string, string])[] = [
  ['location', '当前位置/阵营', 'Location / faction'],
  ['powerLevel', '修为境界/能力等级', 'Power or ability level'],
  ['physicalState', '身体状态（伤势/BUFF/外貌）', 'Physical state (injuries, effects, appearance)'],
  ['mentalState', '心理状态（愿望/恐惧/心态）', 'Mental state (goals, fears, mindset)'],
  ['keyItems', '关键道具/资源', 'Key items / resources'],
  ['recentEvents', '最近重要事件', 'Recent important events'],
]

export type StateFieldSource = 'historical' | 'author' | 'derived' | 'unknown'

/**
 * 当前状态档案的一个字段：定稿派生、但已不在当前派生集合里的值是历史记录，编辑框留空，原值只作参考显示。
 */
export function stateFieldView(
  card: CharacterCard,
  field: CharacterStateTextField,
  currentDerivedFields: Record<string, CharacterStateTextField[]>,
): { value: string; history: string; source: StateFieldSource } {
  const provenance = card.currentState?.provenance?.[field]
  const historical = provenance?.kind === 'derived' && !currentDerivedFields[card.characterId ?? '']?.includes(field)
  const raw = card.currentState?.[field]?.toString() ?? ''
  return {
    value: historical ? '' : raw,
    history: historical ? raw : '',
    source: historical ? 'historical' : provenance?.kind === 'author' ? 'author' : provenance?.kind === 'derived' ? 'derived' : 'unknown',
  }
}

/** 作者手改一个状态字段：记为作者输入，章节号沿用最后更新的那一章。 */
export function authorStateEdit(card: CharacterCard, field: CharacterStateTextField, value: string): CharacterCurrentState {
  return {
    ...(card.currentState ?? EMPTY_STATE),
    [field]: value,
    provenance: {
      ...card.currentState?.provenance,
      [field]: { kind: 'author', chapterNumber: card.currentState?.updatedAtChapter ?? 0 },
    },
  }
}
