import type { CharacterData } from '../../electron/repositories/character-repository'
import type {
  CharacterRosterEntry,
  CharacterRosterRelationship,
} from '../shared/character-roster'
import { normalizeCharacterRole } from '../shared/character-role'
import { splitRelationshipEditorValue } from '../shared/relationship-presentation'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseStructuredRelationships(value: string): CharacterRosterRelationship[] | null {
  const text = value.trim()
  if (!text) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (Array.isArray(parsed)) {
    const relationships: CharacterRosterRelationship[] = []
    for (const raw of parsed) {
      if (!isRecord(raw) || typeof raw.target !== 'string' || typeof raw.relation !== 'string') return null
      relationships.push({ target: raw.target.trim(), relation: raw.relation.trim() })
    }
    return relationships
  }
  if (!isRecord(parsed) || 'target' in parsed || 'relation' in parsed) return null
  return Object.entries(parsed).flatMap(([target, relation]) => (
    target.trim() && typeof relation === 'string' && relation.trim()
      ? [{ target: target.trim(), relation: relation.trim() }]
      : []
  ))
}

/**
 * Renderer/workflow 侧只负责把现有角色卡形状送入唯一 roster seam；最终
 * schema、闭包与事务校验都留在主进程 CharacterRosterRepository。
 *
 * 关系字段是**编辑文本**：能结构化到已知角色的行走 relationships，剩下的原文
 * （包括关系目标不在名单里的行）作为关系备注一并提交 —— 一行解析不出来不再
 * 让整块降级，也不再让整批提交被拒。
 */
export function characterRosterEntryFromCard(
  card: CharacterData,
  knownNames: readonly string[] = [],
): CharacterRosterEntry {
  const structured = parseStructuredRelationships(card.relationships)
  const split = structured === null
    ? splitRelationshipEditorValue(card.relationships, {
      knownNames: [...knownNames.filter(name => name !== card.name), card.name],
      selfName: card.name,
    })
    : { edges: structured, notes: '' }
  // 两种输入的意图来源不同，必须分开对待：
  //   · 非空的 JSON 结构化输入（AI/导入候选）以 relationshipNotes 字段为准；
  //   · 编辑文本输入（角色档案文本框、名单读回）以文本为唯一意图源 ——
  //     包括被作者清空的文本，否则清空之后旧备注会被字段悄悄复活。
  const usesStructuredField = structured !== null && Boolean(card.relationships.trim())
  const relationshipNotes = split.notes.trim()
    || (usesStructuredField ? card.relationshipNotes?.trim() ?? '' : '')
  return {
    name: card.name.trim(),
    role: card.role,
    gender: card.gender,
    age: card.age,
    appearance: card.appearance,
    personality: card.personality,
    background: card.background,
    abilities: card.abilities,
    motivation: card.motivation,
    relationships: split.edges,
    arc: card.arc,
    notes: card.notes,
    ...(card.currentState ? { currentState: card.currentState } : {}),
    ...(relationshipNotes ? { relationshipNotes } : {}),
  }
}

export function characterCardFromRosterEntry(entry: CharacterRosterEntry): CharacterData {
  const relationshipNotes = entry.relationshipNotes?.trim() ?? ''
  // 编辑视图 = 结构化边逐行 + 关系备注原文：作者在同一个文本框里既能改边、也能
  // 改原话，保存时再由 characterRosterEntryFromCard 拆回两列。
  const editorLines = [
    ...entry.relationships.map(edge => `${edge.target}：${edge.relation}`),
    ...(relationshipNotes
      ? relationshipNotes.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
      : []),
  ]
  return {
    name: entry.name,
    role: normalizeCharacterRole(entry.role),
    gender: entry.gender,
    age: entry.age,
    appearance: entry.appearance,
    personality: entry.personality,
    background: entry.background,
    abilities: entry.abilities,
    motivation: entry.motivation,
    relationships: editorLines.join('\n'),
    ...(relationshipNotes ? { relationshipNotes } : {}),
    arc: entry.arc,
    notes: entry.notes,
    ...(entry.currentState ? { currentState: entry.currentState } : {}),
  }
}

export function characterRosterEntriesFromCards(cards: readonly CharacterData[]): CharacterRosterEntry[] {
  const knownNames = cards.map(card => card.name.trim()).filter(Boolean)
  return cards.map(card => characterRosterEntryFromCard(card, knownNames))
}
