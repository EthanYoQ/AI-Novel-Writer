import { StructuredContractDiagnostic } from './structured-contract-diagnostic'
import type { WritingLanguage } from './writing-language'

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
  outputLimits: Object.freeze({
    titleCharacters: 60,
    roleCharacters: 120,
    purposeCharacters: 240,
    keyEventsCharacters: 1_200,
    suspenseHookCharacters: 160,
    characterItems: 12,
    characterNameCharacters: 32,
    relationshipItems: 8,
    relationshipCharacters: 80,
  } as const),
  exactChapterCoverage: true,
} as const)

export function blueprintSemanticGenerationContract(writingLanguage: WritingLanguage): string {
  if (writingLanguage === 'en-US') {
    return `[Immutable blueprint JSON contract]
Output {"blueprints":[...]} only. Every item must contain all of these fields: ${BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.requiredFields.join(', ')}.
chapterNumber must cover every target chapter exactly once, without duplicates or out-of-range values. title, role, purpose, keyEvents, and suspenseHook must be non-empty strings.
suspenseHook is always required; even without a mystery, state one concrete unresolved decision, threat, revelation, or consequence that creates forward pressure.
characters must be an array containing at least one unique, non-empty full character name.
relationships is required and may be []; every item must contain non-empty from, to, and relation fields. from and to must exactly copy full names from the same item's characters array and may not self-reference.
Keep keyEvents concise; aim for no more than 900 characters and never exceed the hard maximum of 1,200.
Limits: title ${BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.titleCharacters} characters; role ${BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.roleCharacters}; purpose ${BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.purposeCharacters}; keyEvents ${BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.keyEventsCharacters}; suspenseHook ${BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.suspenseHookCharacters}; characters at most ${BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.characterItems} items with names at most ${BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.characterNameCharacters} characters; relationships at most ${BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.relationshipItems} items with relation at most ${BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.relationshipCharacters} characters.
Do not omit fields, combine chapters, rename fields, explain, or output Markdown or code fences.`
  }
  return `【不可变蓝图 JSON 合同】
只输出 {"blueprints":[...]}，每项必须完整包含：${BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.requiredFields.join('、')}。
chapterNumber 必须覆盖本批每个目标章节且不得重复或越界；title、role、purpose、keyEvents、suspenseHook 必须是非空字符串。
suspenseHook 始终必填；即使本章没有谜团，也要写明一个制造推进压力的具体未决决定、威胁、揭示或后果。
characters 必须是至少含一个唯一非空角色名的字符串数组。
relationships 必须是数组，无关系时传 []；每项必须含非空 from、to、relation，from/to 必须精确出现在同项 characters 中且不能自指。
from/to 必须逐字复制同一项 characters 中的完整字符串；任一端点不在 characters 时，删除该关系或使用 []，不得发明别名、简称或补写角色。
keyEvents 保持精炼，目标为 100–150 字符，绝不得超过 1200 字符硬上限。
每项长度上限：title ${BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.titleCharacters} 字符、role ${BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.roleCharacters} 字符、purpose ${BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.purposeCharacters} 字符、keyEvents ${BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.keyEventsCharacters} 字符、suspenseHook ${BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.suspenseHookCharacters} 字符；characters 最多 ${BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.characterItems} 项且姓名最多 ${BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.characterNameCharacters} 字符；relationships 最多 ${BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.relationshipItems} 项且 relation 最多 ${BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.relationshipCharacters} 字符。
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

function characterCount(value: string): number {
  return Array.from(value).length
}

function requiredText(value: unknown, path: string, maxCharacters?: number): string {
  if (value === undefined) throw new StructuredContractDiagnostic('missing_field', path)
  if (typeof value !== 'string') throw new StructuredContractDiagnostic('invalid_type', path)
  if (!value.trim()) throw new StructuredContractDiagnostic('empty_value', path)
  const normalized = value.trim()
  const actualCharacters = characterCount(normalized)
  if (maxCharacters !== undefined && actualCharacters > maxCharacters) {
    throw new StructuredContractDiagnostic('value_too_long', path, actualCharacters, maxCharacters)
  }
  return normalized
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
  if (value.length > BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.characterItems) {
    throw new StructuredContractDiagnostic('invalid_value', path)
  }
  const characters = value.map((candidate, index) => {
    return requiredText(
      candidate,
      `${path}[${index}]`,
      BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.characterNameCharacters,
    )
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
  if (value.length > BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.relationshipItems) {
    throw new StructuredContractDiagnostic('invalid_value', path)
  }
  const characterSet = new Set(characters)
  const seen = new Set<string>()
  return value.map((candidate, index) => {
    const relationshipPath = `${path}[${index}]`
    if (!isRecord(candidate)) {
      throw new StructuredContractDiagnostic('invalid_type', relationshipPath)
    }
    const from = requiredText(fieldValue(candidate, 'from', ['source']), `${relationshipPath}.from`)
    const to = requiredText(fieldValue(candidate, 'to', ['target']), `${relationshipPath}.to`)
    const relation = requiredText(
      candidate.relation,
      `${relationshipPath}.relation`,
      BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.relationshipCharacters,
    )
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
    title: requiredText(value.title, `${path}.title`, BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.titleCharacters),
    role: requiredText(value.role, `${path}.role`, BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.roleCharacters),
    purpose: requiredText(value.purpose, `${path}.purpose`, BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.purposeCharacters),
    keyEvents: requiredText(
      fieldValue(value, 'keyEvents', ['key_events']),
      `${path}.keyEvents`,
      BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.keyEventsCharacters,
    ),
    characters,
    relationshipHints,
    suspenseHook: requiredText(
      fieldValue(value, 'suspenseHook', ['suspense_hook']),
      `${path}.suspenseHook`,
      BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.suspenseHookCharacters,
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
