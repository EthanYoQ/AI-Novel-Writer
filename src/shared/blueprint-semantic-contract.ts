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

export function blueprintSemanticGenerationContract(): string {
  return `【不可变蓝图 JSON 合同】
只输出 {"blueprints":[...]}，每项必须完整包含：${BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.requiredFields.join('、')}。
chapterNumber 必须覆盖本批每个目标章节且不得重复或越界；title、role、purpose、keyEvents、suspenseHook 必须是非空字符串。
characters 必须是至少含一个唯一非空角色名的字符串数组。
relationships 必须是数组，无关系时传 []；每项必须含非空 from、to、relation，from/to 必须精确出现在同项 characters 中且不能自指。
from/to 必须逐字复制同一项 characters 中的完整字符串；任一端点不在 characters 时，删除该关系或使用 []，不得发明别名、简称或补写角色。
不得省略字段、合并章节、输出近义字段、解释、Markdown 或代码围栏。`
}

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

function requiredText(value: unknown, path: string): string {
  if (value === undefined) throw new StructuredContractDiagnostic('missing_field', path)
  if (typeof value !== 'string') throw new StructuredContractDiagnostic('invalid_type', path)
  if (!value.trim()) throw new StructuredContractDiagnostic('invalid_value', path)
  return value.trim()
}

function normalizedChapterNumber(value: Record<string, unknown>, path: string): number {
  const candidate = fieldValue(value, 'chapterNumber', ['chapter_number'])
  if (candidate === undefined) throw new StructuredContractDiagnostic('missing_field', `${path}.chapterNumber`)
  if (typeof candidate !== 'number' && typeof candidate !== 'string') {
    throw new StructuredContractDiagnostic('invalid_type', `${path}.chapterNumber`)
  }
  const chapterNumber = Number(candidate)
  if (!Number.isSafeInteger(chapterNumber) || chapterNumber < 1) {
    throw new StructuredContractDiagnostic('invalid_value', `${path}.chapterNumber`)
  }
  return chapterNumber
}

function normalizedCharacters(value: unknown, path: string): string[] {
  if (value === undefined) throw new StructuredContractDiagnostic('missing_field', path)
  if (!Array.isArray(value)) throw new StructuredContractDiagnostic('invalid_type', path)
  if (value.length === 0) throw new StructuredContractDiagnostic('invalid_value', path)
  const characters = value.map((candidate, index) => {
    if (typeof candidate !== 'string') throw new StructuredContractDiagnostic('invalid_type', `${path}[${index}]`)
    if (!candidate.trim()) {
      throw new StructuredContractDiagnostic('invalid_value', `${path}[${index}]`)
    }
    return candidate.trim()
  })
  if (new Set(characters).size !== characters.length) {
    throw new StructuredContractDiagnostic('duplicate_item', path)
  }
  return characters
}

function normalizedRelationships(
  value: unknown,
  path: string,
  characters: readonly string[],
): BlueprintRelationshipFact[] {
  if (value === undefined) throw new StructuredContractDiagnostic('missing_field', path)
  if (!Array.isArray(value)) throw new StructuredContractDiagnostic('invalid_type', path)
  const characterSet = new Set(characters)
  const seen = new Set<string>()
  return value.map((candidate, index) => {
    const relationshipPath = `${path}[${index}]`
    if (!isRecord(candidate)) {
      throw new StructuredContractDiagnostic('invalid_type', relationshipPath)
    }
    const from = requiredText(fieldValue(candidate, 'from', ['source']), `${relationshipPath}.from`)
    const to = requiredText(fieldValue(candidate, 'to', ['target']), `${relationshipPath}.to`)
    const relation = requiredText(candidate.relation, `${relationshipPath}.relation`)
    if (from === to) {
      throw new StructuredContractDiagnostic('relationship_self_reference', relationshipPath)
    }
    if (!characterSet.has(from) || !characterSet.has(to)) {
      throw new StructuredContractDiagnostic('relationship_endpoint_not_in_characters', relationshipPath)
    }
    const key = `${from}\u0000${to}\u0000${relation}`
    if (seen.has(key)) throw new StructuredContractDiagnostic('duplicate_item', path)
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

export function normalizeBlueprintSemanticItem(value: unknown, path = 'blueprint'): BlueprintSemanticItem {
  if (!isRecord(value)) throw new StructuredContractDiagnostic('invalid_type', path)
  const chapterNumber = normalizedChapterNumber(value, path)
  const characters = normalizedCharacters(value.characters, `${path}.characters`)
  const relationshipHints = normalizedRelationships(
    fieldValue(value, 'relationships', ['relationshipHints', 'relations']),
    `${path}.relationships`,
    characters,
  )
  return {
    chapterNumber,
    title: requiredText(value.title, `${path}.title`),
    role: requiredText(value.role, `${path}.role`),
    purpose: requiredText(value.purpose, `${path}.purpose`),
    keyEvents: requiredText(fieldValue(value, 'keyEvents', ['key_events']), `${path}.keyEvents`),
    characters,
    relationshipHints,
    suspenseHook: requiredText(
      fieldValue(value, 'suspenseHook', ['suspense_hook']),
      `${path}.suspenseHook`,
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
  if (!Array.isArray(candidates)) throw new StructuredContractDiagnostic('invalid_envelope', 'blueprints')

  const expected = new Set(expectedChapterNumbers)
  if (
    expected.size !== expectedChapterNumbers.length
    || expectedChapterNumbers.some(chapter => !Number.isSafeInteger(chapter) || chapter < 1)
  ) {
    throw new StructuredContractDiagnostic('invalid_value', 'expectedChapterNumbers')
  }

  const decoded = candidates.map((candidate, index) => normalizeBlueprintSemanticItem(candidate, `blueprints[${index}]`))
  const seen = new Set<number>()
  for (const blueprint of decoded) {
    if (seen.has(blueprint.chapterNumber)) {
      throw new StructuredContractDiagnostic('duplicate_item', 'blueprints')
    }
    seen.add(blueprint.chapterNumber)
    if (!expected.has(blueprint.chapterNumber)) {
      throw new StructuredContractDiagnostic('unexpected_item', 'blueprints')
    }
  }
  const missing = expectedChapterNumbers.filter(chapter => !seen.has(chapter))
  if (missing.length > 0) {
    throw new StructuredContractDiagnostic('missing_item', 'blueprints')
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
    throw new StructuredContractDiagnostic('invalid_envelope', '$')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    throw new StructuredContractDiagnostic('invalid_json', '$')
  }
  return decodeBlueprintSemanticPayload(parsed, expectedChapterNumbers)
}
import { StructuredContractDiagnostic } from './structured-contract-diagnostic'
