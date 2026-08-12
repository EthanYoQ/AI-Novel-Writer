export interface BlueprintRelationshipFact {
  from: string
  to: string
  relation: string
}

/** Stable provenance input; validation code and qualification hash this same manifest. */
export const BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST = Object.freeze({
  schemaVersion: 1,
  requiredFields: Object.freeze([
    'chapterNumber',
    'title',
    'role',
    'purpose',
    'keyEvents',
    'characters',
    'relationships',
    'suspenseHook',
  ] as const),
  characters: Object.freeze({ minimumItems: 1, unique: true } as const),
  relationships: Object.freeze({
    required: true,
    emptyAllowed: true,
    requiredFields: Object.freeze(['from', 'to', 'relation'] as const),
    endpointsMustAppearInCharacters: true,
  } as const),
  exactChapterCoverage: true,
} as const)

/**
 * Provider-neutral generation fact. Persistence-only fields are deliberately
 * absent: callers add those after the model result has crossed this seam.
 */
export interface BlueprintSemanticItem {
  chapterNumber: number
  title: string
  role: string
  purpose: string
  keyEvents: string
  characters: string[]
  relationshipHints: BlueprintRelationshipFact[]
  suspenseHook: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function fieldValue(
  value: Record<string, unknown>,
  canonical: string,
  aliases: readonly string[] = [],
): unknown {
  if (Object.hasOwn(value, canonical)) return value[canonical]
  for (const alias of aliases) {
    if (Object.hasOwn(value, alias)) return value[alias]
  }
  return undefined
}

function requiredText(value: unknown, label: string, chapterNumber?: number): string {
  const prefix = chapterNumber === undefined ? '' : `第 ${chapterNumber} 章`
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${prefix}${label}不能为空`)
  }
  return value.trim()
}

function normalizedChapterNumber(value: Record<string, unknown>): number {
  const candidate = fieldValue(value, 'chapterNumber', ['chapter_number'])
  const chapterNumber = Number(candidate)
  if (!Number.isSafeInteger(chapterNumber) || chapterNumber < 1) {
    throw new Error('蓝图章节号必须是正整数')
  }
  return chapterNumber
}

function normalizedCharacters(value: unknown, chapterNumber: number): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`第 ${chapterNumber} 章出场角色必须是非空列表`)
  }
  const characters = value.map((candidate) => {
    if (typeof candidate !== 'string' || !candidate.trim()) {
      throw new Error(`第 ${chapterNumber} 章出场角色名不能为空`)
    }
    return candidate.trim()
  })
  if (new Set(characters).size !== characters.length) {
    throw new Error(`第 ${chapterNumber} 章出场角色包含重复名字`)
  }
  return characters
}

function normalizedRelationships(
  value: unknown,
  chapterNumber: number,
  characters: readonly string[],
): BlueprintRelationshipFact[] {
  if (!Array.isArray(value)) {
    throw new Error(`第 ${chapterNumber} 章角色关系必须是列表（无关系时传空列表）`)
  }
  const characterSet = new Set(characters)
  const seen = new Set<string>()
  return value.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new Error(`第 ${chapterNumber} 章第 ${index + 1} 条角色关系格式无效`)
    }
    const from = requiredText(fieldValue(candidate, 'from', ['source']), '关系来源', chapterNumber)
    const to = requiredText(fieldValue(candidate, 'to', ['target']), '关系目标', chapterNumber)
    const relation = requiredText(candidate.relation, '关系说明', chapterNumber)
    if (!characterSet.has(from) || !characterSet.has(to)) {
      throw new Error(`第 ${chapterNumber} 章角色关系只能引用本章出场角色`)
    }
    if (from === to) throw new Error(`第 ${chapterNumber} 章角色关系不能自指`)
    const key = `${from}\u0000${to}\u0000${relation}`
    if (seen.has(key)) throw new Error(`第 ${chapterNumber} 章包含重复角色关系`)
    seen.add(key)
    return { from, to, relation }
  })
}

export function validateBlueprintSemanticItem(value: unknown): string | undefined {
  try {
    normalizeBlueprintSemanticItem(value)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export function normalizeBlueprintSemanticItem(value: unknown): BlueprintSemanticItem {
  if (!isRecord(value)) throw new Error('蓝图条目必须是对象')
  const chapterNumber = normalizedChapterNumber(value)
  const characters = normalizedCharacters(value.characters, chapterNumber)
  const relationshipHints = normalizedRelationships(
    fieldValue(value, 'relationships', ['relationshipHints', 'relations']),
    chapterNumber,
    characters,
  )
  return {
    chapterNumber,
    title: requiredText(value.title, '标题', chapterNumber),
    role: requiredText(value.role, '章节功能', chapterNumber),
    purpose: requiredText(value.purpose, '核心目的', chapterNumber),
    keyEvents: requiredText(fieldValue(value, 'keyEvents', ['key_events']), '关键事件', chapterNumber),
    characters,
    relationshipHints,
    suspenseHook: requiredText(
      fieldValue(value, 'suspenseHook', ['suspense_hook']),
      '悬念钩子',
      chapterNumber,
    ),
  }
}

export function decodeBlueprintSemanticPayload(
  payload: unknown,
  expectedChapterNumbers: readonly number[],
): BlueprintSemanticItem[] {
  const candidates = isRecord(payload) && Object.hasOwn(payload, 'blueprints')
    ? payload.blueprints
    : payload
  if (!Array.isArray(candidates)) throw new Error('蓝图响应必须包含 blueprints 列表')

  const expected = new Set(expectedChapterNumbers)
  if (
    expected.size !== expectedChapterNumbers.length
    || expectedChapterNumbers.some(chapter => !Number.isSafeInteger(chapter) || chapter < 1)
  ) {
    throw new Error('目标章节清单无效')
  }

  const decoded = candidates.map(normalizeBlueprintSemanticItem)
  const seen = new Set<number>()
  for (const blueprint of decoded) {
    if (seen.has(blueprint.chapterNumber)) {
      throw new Error(`蓝图包含重复章节：第 ${blueprint.chapterNumber} 章`)
    }
    seen.add(blueprint.chapterNumber)
    if (!expected.has(blueprint.chapterNumber)) {
      throw new Error(`蓝图包含非目标章节：第 ${blueprint.chapterNumber} 章`)
    }
  }
  const missing = expectedChapterNumbers.filter(chapter => !seen.has(chapter))
  if (missing.length > 0) {
    throw new Error(`蓝图缺少目标章节：第 ${missing.join('、')} 章`)
  }
  return decoded.sort((left, right) => left.chapterNumber - right.chapterNumber)
}

/**
 * Accepts exactly one JSON root or one complete Markdown JSON fence. It never
 * searches narrative prose for a nested JSON fragment.
 */
export function parseBlueprintSemanticResponseText(
  text: string,
  expectedChapterNumbers: readonly number[],
): BlueprintSemanticItem[] {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed)
  const candidate = fenced ? fenced[1].trim() : trimmed
  if (!candidate || !/^[{[]/u.test(candidate)) {
    throw new Error('蓝图响应必须是单一 JSON 根对象或 JSON 代码块')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    throw new Error('蓝图响应必须是单一 JSON 根对象或 JSON 代码块')
  }
  return decodeBlueprintSemanticPayload(parsed, expectedChapterNumbers)
}
