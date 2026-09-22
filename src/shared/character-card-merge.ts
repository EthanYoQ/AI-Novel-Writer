/**
 * 角色卡合并窗口里「追加」这一档的语义。
 *
 * 先生的原话：有些用户想的是**往原设定里加新内容**，而不是把原来的换掉。
 * 于是这里定义「追加」的准确行为 —— 既不能重复堆叠同样的文本，也不能让关系
 * 出现重复的边。
 */
import type { CharacterRosterRelationship } from './character-roster'

/**
 * 追加文本：换行隔开。任一侧已经包含另一侧时直接返回较长的一侧，
 * 避免反复合并同一张卡时越堆越长。
 */
export function appendFieldText(before: string, after: string): string {
  const original = before.trim()
  const incoming = after.trim()
  if (!original) return incoming
  if (!incoming) return original
  if (original.includes(incoming)) return original
  if (incoming.includes(original)) return incoming
  return `${original}\n${incoming}`
}

/** 追加关系：并集语义，同目标同关系只保留一条。 */
export function appendRelationshipEdges(
  before: readonly CharacterRosterRelationship[],
  after: readonly CharacterRosterRelationship[],
): CharacterRosterRelationship[] {
  const merged = [...before]
  for (const edge of after) {
    const duplicated = merged.some(existing => (
      existing.target === edge.target && existing.relation === edge.relation
    ))
    if (!duplicated) merged.push(edge)
  }
  return merged
}
