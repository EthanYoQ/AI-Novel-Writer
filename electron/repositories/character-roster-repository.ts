import { createHash } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'

import {
  CHARACTER_ROSTER_ROLES,
  CHARACTER_ROSTER_SCHEMA_VERSION,
  CHARACTER_STATE_TEXT_FIELDS,
  characterRosterIdentityKey,
  type CharacterRosterCharacterState,
  type CharacterRosterCommitReceipt,
  type CharacterRosterCommitIntent,
  type CharacterRosterCommitRequest,
  type CharacterRosterEntry,
  type CharacterRosterRename,
  type CharacterRosterMigrationState,
  type CharacterRosterStatus,
  type CharacterRosterRelationship,
  type CharacterRosterRole,
  type CharacterRosterSnapshot,
  type CharacterStateFieldProvenance,
} from '../../src/shared/character-roster'
import type { FinalizedSourceIdentity } from '../../src/shared/finalized-continuity'
import { getProjectDb } from '../database'
import { CharacterRepository, type CharacterData } from './character-repository'
import { ensureCharacterRosterSchema } from './character-roster-schema'
import { CHARACTER_ROLE_LABELS, normalizeCharacterRole } from '../../src/shared/character-role'
import { DEFAULT_WRITING_LANGUAGE, type WritingLanguage } from '../../src/shared/writing-language'
import { ProjectCoreRepository } from './project-core-repository'

interface CharacterRosterMetaRow {
  schema_version: number
  revision: number
  migration_state: CharacterRosterMigrationState
  legacy_markdown: string
  projection_hash: string
  fact_hash: string
}

interface CharacterRosterOperationRow {
  operation_id: string
  payload_hash: string
  committed_revision: number
  projection_hash: string
}

const ROLE_ORDER: Record<CharacterRosterRole, number> = {
  protagonist: 0,
  supporting: 1,
  antagonist: 2,
  minor: 3,
}

function requiredDb(): BetterSqlite3.Database {
  const db = getProjectDb()
  if (!db) throw new Error('项目数据库未打开')
  return db
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label}必须是文本`)
  return value.trim()
}

/** Only fields whose domain explicitly permits numeric scalar expression use this normalizer. */
function requiredTextOrFiniteNumber(value: unknown, label: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return requiredText(value, label)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isRosterRole(value: unknown): value is CharacterRosterRole {
  return typeof value === 'string'
    && (CHARACTER_ROSTER_ROLES as readonly string[]).includes(value)
}

function normalizeFinalizedSource(value: unknown): FinalizedSourceIdentity {
  if (!isObject(value)) throw new Error('定稿来源收据格式无效')
  const finalizationId = requiredText(value.finalizationId, '定稿来源 ID')
  const contentHash = requiredText(value.contentHash, '定稿正文哈希')
  if (
    !Number.isSafeInteger(value.draftId) || (value.draftId as number) < 1
    || !Number.isSafeInteger(value.chapterNumber) || (value.chapterNumber as number) < 1
    || !finalizationId
    || !/^[a-f0-9]{64}$/u.test(contentHash)
  ) throw new Error('定稿来源收据格式无效')
  return {
    draftId: value.draftId as number,
    finalizationId,
    chapterNumber: value.chapterNumber as number,
    contentHash,
  }
}

function normalizeFieldProvenance(value: unknown): CharacterStateFieldProvenance {
  if (!isObject(value)) throw new Error('角色状态来源格式无效')
  if (value.kind === 'legacy') return { kind: 'legacy' }
  if (value.kind === 'author') {
    if (!Number.isSafeInteger(value.chapterNumber) || (value.chapterNumber as number) < 0) {
      throw new Error('作者角色状态章节无效')
    }
    return { kind: 'author', chapterNumber: value.chapterNumber as number }
  }
  if (value.kind === 'derived') {
    return { kind: 'derived', source: normalizeFinalizedSource(value.source) }
  }
  throw new Error('角色状态来源类型无效')
}

function normalizeState(value: unknown): CharacterRosterCharacterState | undefined {
  if (value === undefined) return undefined
  if (!isObject(value)) throw new Error('角色动态状态格式无效')
  const updatedAtChapter = value.updatedAtChapter
  if (!Number.isSafeInteger(updatedAtChapter) || (updatedAtChapter as number) < 0) {
    throw new Error('角色动态状态章节号无效')
  }
  const rawProvenance = value.provenance === undefined ? {} : value.provenance
  if (!isObject(rawProvenance)) throw new Error('角色状态来源格式无效')
  const provenance: NonNullable<CharacterRosterCharacterState['provenance']> = {}
  for (const field of CHARACTER_STATE_TEXT_FIELDS) {
    const normalizedValue = requiredText(value[field], `角色状态 ${field}`)
    if (Object.hasOwn(rawProvenance, field)) {
      provenance[field] = normalizeFieldProvenance(rawProvenance[field])
    } else if (normalizedValue) {
      // Pre-v2 and non-manual generation values stay visible but never become author facts.
      provenance[field] = { kind: 'legacy' }
    }
  }
  return {
    location: requiredText(value.location, '角色当前位置'),
    powerLevel: requiredText(value.powerLevel, '角色修为境界'),
    physicalState: requiredText(value.physicalState, '角色身体状态'),
    mentalState: requiredText(value.mentalState, '角色心理状态'),
    keyItems: requiredText(value.keyItems, '角色关键道具'),
    recentEvents: requiredText(value.recentEvents, '角色最近事件'),
    updatedAtChapter: updatedAtChapter as number,
    ...(Object.keys(provenance).length > 0 ? { provenance } : {}),
  }
}

function hasManualValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0
  return Boolean(value)
}

function isCommitIntent(value: unknown): value is CharacterRosterCommitIntent {
  return value === 'initialize'
    || value === 'architecture_generation'
    || value === 'legacy_repair'
    || value === 'legacy_cards_adoption'
    || value === 'manual_edit'
    || value === 'novel_import'
    || value === 'blueprint_sync'
    || value === 'chapter_progress'
}

function isManualEditIntent(intent: CharacterRosterCommitIntent): boolean {
  return intent === 'manual_edit'
}

function isLegacyEvidenceIntent(intent: CharacterRosterCommitIntent): boolean {
  return intent === 'legacy_repair' || intent === 'legacy_cards_adoption'
}

function normalizeRelationships(value: unknown, ownerName: string): CharacterRosterRelationship[] {
  if (!Array.isArray(value)) throw new Error(`角色「${ownerName}」的关系必须是列表`)
  const seen = new Set<string>()
  return value.map((relationship, index) => {
    if (!isObject(relationship)) {
      throw new Error(`角色「${ownerName}」的第 ${index + 1} 条关系格式无效`)
    }
    const target = requiredText(relationship.target, `角色「${ownerName}」的关系目标`)
    const relation = requiredText(relationship.relation, `角色「${ownerName}」的关系说明`)
    if (!target) throw new Error(`角色「${ownerName}」的关系目标不能为空`)
    if (!relation) throw new Error(`角色「${ownerName}」的关系说明不能为空`)
    if (target === ownerName) throw new Error(`角色「${ownerName}」不能建立自指关系`)
    const key = `${target}\u0000${relation}`
    if (seen.has(key)) throw new Error(`角色「${ownerName}」存在重复关系`)
    seen.add(key)
    return { target, relation }
  }).sort((left, right) => (
    compareText(left.target, right.target) || compareText(left.relation, right.relation)
  ))
}

function normalizeEntry(
  value: unknown,
): CharacterRosterEntry {
  if (!isObject(value)) throw new Error('角色名单条目格式无效')
  const name = requiredText(value.name, '角色名')
  if (!name) throw new Error('角色名不能为空')
  if (!isRosterRole(value.role)) throw new Error(`角色「${name}」的定位无效`)

  // 关系备注是一等事实：任何通道（手工编辑、角色卡导入、蓝图同步、架构生成、
  // 章节推进）都可以提交。旧调用方沿用 legacyRelationshipNotes 键名提交的
  // 是同一份数据，这里一并接受，避免升级期出现两套语义。
  const rawRelationshipNotes = typeof value.relationshipNotes === 'string'
    ? value.relationshipNotes
    : typeof value.legacyRelationshipNotes === 'string'
      ? value.legacyRelationshipNotes
      : undefined
  const relationshipNotes = rawRelationshipNotes?.trim()
  return {
    name,
    role: value.role,
    gender: requiredText(value.gender, `角色「${name}」的性别`),
    age: requiredTextOrFiniteNumber(value.age, `角色「${name}」的年龄`),
    appearance: requiredText(value.appearance, `角色「${name}」的外貌`),
    personality: requiredText(value.personality, `角色「${name}」的性格`),
    background: requiredText(value.background, `角色「${name}」的背景`),
    abilities: requiredText(value.abilities, `角色「${name}」的能力`),
    motivation: requiredText(value.motivation, `角色「${name}」的动机`),
    relationships: normalizeRelationships(value.relationships, name),
    arc: requiredText(value.arc, `角色「${name}」的弧光`),
    notes: requiredText(value.notes, `角色「${name}」的备注`),
    currentState: normalizeState(value.currentState),
    ...(relationshipNotes ? { relationshipNotes } : {}),
  }
}

function normalizeRenames(value: unknown, intent: CharacterRosterCommitIntent): CharacterRosterRename[] | undefined {
  if (value === undefined) return undefined
  if (!isManualEditIntent(intent)) {
    throw new Error('只有手工角色管理可以提交角色改名映射')
  }
  if (!Array.isArray(value)) throw new Error('角色改名映射必须是列表')
  const renames = value.map((raw) => {
    if (!isObject(raw)) throw new Error('角色改名映射格式无效')
    const originalName = requiredText(raw.originalName, '角色改名原名')
    const newName = requiredText(raw.newName, '角色改名新名')
    if (!originalName || !newName) throw new Error('角色改名原名和新名不能为空')
    if (originalName === newName) throw new Error('角色改名必须产生新的身份')
    return { originalName, newName }
  })
  if (
    new Set(renames.map(rename => rename.originalName)).size !== renames.length
    || new Set(renames.map(rename => rename.newName)).size !== renames.length
  ) throw new Error('角色改名原名和目标名必须唯一')
  return renames
}

function normalizeRequest(value: unknown): CharacterRosterCommitRequest {
  if (!isObject(value)) throw new Error('角色名单提交请求格式无效')
  const operationId = requiredText(value.operationId, '操作 ID')
  if (!operationId) throw new Error('操作 ID 不能为空')
  if (value.schemaVersion !== CHARACTER_ROSTER_SCHEMA_VERSION) {
    throw new Error('角色名单 schema 版本不受支持')
  }
  if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) {
    throw new Error('角色名单 revision 无效')
  }
  const intent = value.intent === undefined ? 'initialize' : value.intent
  if (!isCommitIntent(intent)) throw new Error('角色名单提交意图无效')
  if (!Array.isArray(value.entries) || (value.entries.length === 0 && !isManualEditIntent(intent))) {
    throw new Error('角色名单不能为空')
  }

  const source = value.source === undefined ? undefined : normalizeFinalizedSource(value.source)
  if (intent === 'chapter_progress' && !source) throw new Error('章节状态更新缺少定稿来源收据')
  if (intent !== 'chapter_progress' && source) throw new Error('只有章节状态更新可携带定稿来源收据')
  const entries = value.entries.map(entry => normalizeEntry(entry))
  const names = new Set(entries.map(entry => characterRosterIdentityKey(entry.name)))
  if (names.size !== entries.length) throw new Error('角色名必须唯一')
  // 批量生成/导入/蓝图/定稿的增量候选可以引用“本次没有变化”的既有角色；
  // 手工候选还可能带着改名前或刚删除的目标。它们都必须先由深 module 与
  // 当前事实合并/转换，再用完整名单校验闭包。只有空项目初始化和旧图谱
  // 修复需要在候选本身上直接闭合。
  if (intent === 'initialize' || intent === 'legacy_repair') {
    for (const entry of entries) {
      for (const relationship of entry.relationships) {
        if (!names.has(characterRosterIdentityKey(relationship.target))) {
          throw new Error(`角色「${entry.name}」引用了不存在的关系目标「${relationship.target}」`)
        }
      }
    }
  }
  const renames = normalizeRenames(value.renames, intent)
  // 「同名条目以候选为准」只对角色卡导入开放：其他通道没有作者的逐条确认。
  const overwriteExisting = value.overwriteExisting === true
  if (overwriteExisting && intent !== 'novel_import') {
    throw new Error('只有角色卡导入可以按候选内容覆盖同名角色')
  }
  let expectedLegacyMarkdown: string | undefined
  if (isLegacyEvidenceIntent(intent)) {
    if (typeof value.expectedLegacyMarkdown !== 'string') {
      throw new Error('旧角色图谱证据缺失，已拒绝修复')
    }
    expectedLegacyMarkdown = value.expectedLegacyMarkdown
  }

  return {
    operationId,
    expectedRevision: value.expectedRevision as number,
    schemaVersion: CHARACTER_ROSTER_SCHEMA_VERSION,
    entries,
    ...(source ? { source } : {}),
    intent,
    ...(overwriteExisting ? { overwriteExisting } : {}),
    ...(renames?.length ? { renames } : {}),
    ...(isLegacyEvidenceIntent(intent)
      ? { expectedLegacyMarkdown }
      : {}),
  }
}

function canonicalEntries(entries: CharacterRosterEntry[]): CharacterRosterEntry[] {
  return [...entries]
    .map((entry) => {
      const canonical: CharacterRosterEntry = {
        ...entry,
        relationships: [...entry.relationships].sort((left, right) => (
          compareText(left.target, right.target) || compareText(left.relation, right.relation)
        )),
      }
      // 关系备注参与事实哈希：先归一到「有内容才存在」的形态，避免纯空白
      // 差异让同一份事实产生两个不同哈希。
      const relationshipNotes = entry.relationshipNotes?.trim()
      if (relationshipNotes) canonical.relationshipNotes = relationshipNotes
      else delete canonical.relationshipNotes
      return canonical
    })
    .sort((left, right) => compareText(left.name, right.name))
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function payloadHash(request: CharacterRosterCommitRequest): string {
  return hashText(JSON.stringify({
    schemaVersion: request.schemaVersion,
    intent: request.intent ?? 'initialize',
    ...(isLegacyEvidenceIntent(request.intent ?? 'initialize')
      ? { expectedLegacyMarkdown: request.expectedLegacyMarkdown }
      : {}),
    ...(request.intent === 'manual_edit' ? { renames: request.renames ?? [] } : {}),
    ...(request.overwriteExisting ? { overwriteExisting: true } : {}),
    ...(request.source ? { source: request.source } : {}),
    entries: canonicalEntries(request.entries),
  }))
}

function isStructuredRelationships(value: string): value is string {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every(relationship => (
      isObject(relationship)
      && typeof relationship.target === 'string'
      && typeof relationship.relation === 'string'
    ))
  } catch {
    return false
  }
}

function entryFromCharacter(character: CharacterData): CharacterRosterEntry {
  const hasStructuredRelationships = isStructuredRelationships(character.relationships)
  const relationships = hasStructuredRelationships
    ? JSON.parse(character.relationships) as CharacterRosterRelationship[]
    : []
  // 旧项目的自由文本直接躺在 relationships 列里：读取时按「关系备注」迁移到
  // 独立字段。原文一字不改，只是从此与结构化边各自独立存在。
  const legacyText = !hasStructuredRelationships && character.relationships.trim()
    ? character.relationships.trim()
    : ''
  const relationshipNotes = (character.relationshipNotes ?? '').trim() || legacyText
  return {
    name: character.name,
    role: normalizeCharacterRole(character.role),
    gender: character.gender,
    age: character.age,
    appearance: character.appearance,
    personality: character.personality,
    background: character.background,
    abilities: character.abilities,
    motivation: character.motivation,
    relationships: [...relationships].sort((left, right) => (
      compareText(left.target, right.target) || compareText(left.relation, right.relation)
    )),
    arc: character.arc,
    notes: character.notes,
    currentState: character.currentState,
    ...(relationshipNotes ? { relationshipNotes } : {}),
  }
}

function characterFromEntry(entry: CharacterRosterEntry): CharacterData {
  return {
    name: entry.name,
    role: entry.role,
    gender: entry.gender,
    age: entry.age,
    appearance: entry.appearance,
    personality: entry.personality,
    background: entry.background,
    abilities: entry.abilities,
    motivation: entry.motivation,
    // 结构化边恒以 JSON 数组落库，作者的关系原话落在独立的备注列：两者不再
    // 争用同一列，因此改边不会吞掉原话，改原话也不会压掉边。
    relationships: JSON.stringify(entry.relationships),
    relationshipNotes: entry.relationshipNotes?.trim() ?? '',
    arc: entry.arc,
    notes: entry.notes,
    currentState: entry.currentState,
  }
}

function mergeCurrentStateManualWins(
  existing: CharacterRosterCharacterState | undefined,
  generated: CharacterRosterCharacterState | undefined,
): CharacterRosterCharacterState | undefined {
  if (!existing && !generated) return undefined
  const merged = { ...(generated ?? {}), ...(existing ?? {}) } as CharacterRosterCharacterState
  const fields: Array<keyof CharacterRosterCharacterState> = [
    'location', 'powerLevel', 'physicalState', 'mentalState', 'keyItems', 'recentEvents', 'updatedAtChapter',
  ]
  for (const field of fields) {
    if (!hasManualValue(existing?.[field]) && generated?.[field] !== undefined) {
      Object.assign(merged, { [field]: generated[field] })
    }
  }
  return merged
}

function mergeExistingEntryManualWins(
  existing: CharacterRosterEntry,
  generated: CharacterRosterEntry,
): CharacterRosterEntry {
  const merged = { ...existing, name: existing.name.trim() }
  const fields: Array<keyof Pick<
    CharacterRosterEntry,
    'role' | 'gender' | 'age' | 'appearance' | 'personality' | 'background' | 'abilities' | 'motivation' | 'arc' | 'notes'
  >> = [
    'role', 'gender', 'age', 'appearance', 'personality', 'background', 'abilities', 'motivation', 'arc', 'notes',
  ]
  for (const field of fields) {
    if (!hasManualValue(existing[field]) && hasManualValue(generated[field])) {
      Object.assign(merged, { [field]: generated[field] })
    }
  }
  // 结构化边与关系备注各自独立合并：已有的一侧优先（作者事实不被自动流程
  // 覆盖），为空的一侧才接受本轮生成值。两者不再互相压制。
  merged.relationships = existing.relationships.length > 0
    ? existing.relationships
    : generated.relationships
  const mergedRelationshipNotes = existing.relationshipNotes?.trim() || generated.relationshipNotes?.trim()
  if (mergedRelationshipNotes) merged.relationshipNotes = mergedRelationshipNotes
  else delete merged.relationshipNotes
  merged.currentState = mergeCurrentStateManualWins(existing.currentState, generated.currentState)
  return merged
}

/**
 * 同名条目的「候选优先」合并。
 *
 * 作者在候选面板里明确选了覆盖（或在合并窗口里逐项确认过），于是候选**非空**
 * 的字段一律生效；候选没写的字段保留原值 —— 先生定的语义：「新卡没写年龄，
 * 18 岁就不会被抹掉；新卡写了 25 岁，才会被覆盖」。章节动态状态是运行时事实，
 * 导入永远不动它。
 */
function mergeExistingEntryIncomingWins(
  existing: CharacterRosterEntry,
  generated: CharacterRosterEntry,
): CharacterRosterEntry {
  const merged: CharacterRosterEntry = { ...existing, name: existing.name.trim() }
  const fields: Array<keyof Pick<
    CharacterRosterEntry,
    'role' | 'gender' | 'age' | 'appearance' | 'personality' | 'background' | 'abilities' | 'motivation' | 'arc' | 'notes'
  >> = [
    'role', 'gender', 'age', 'appearance', 'personality', 'background', 'abilities', 'motivation', 'arc', 'notes',
  ]
  for (const field of fields) {
    if (hasManualValue(generated[field])) Object.assign(merged, { [field]: generated[field] })
  }
  if (generated.relationships.length > 0) merged.relationships = generated.relationships
  const generatedNotes = generated.relationshipNotes?.trim()
  if (generatedNotes) merged.relationshipNotes = generatedNotes
  else if (!existing.relationshipNotes?.trim()) delete merged.relationshipNotes
  merged.currentState = existing.currentState
  return merged
}

/**
 * 架构重新生成是**替换**语义：本轮生成的名单就是完整事实源。
 *
 * 与 `mergeGeneratedEntriesWithExisting` 的区别只有一条，但它是决定性的：
 * 未出现在本轮候选中的旧角色会被移除，而不是被保留。UI 在「AI 生成故事架构」
 * 里把该步骤显示为「将覆盖」，保留旧角色会让多轮生成的设定同时留在名单里，
 * 下游（目录/蓝图、写稿注入、后处理）会同时读到两套互相矛盾的角色事实。
 *
 * 保留的保护：同名条目的非空人工字段仍然 manual-wins（沿用作者手写资料），
 * 但 relationships 一律取本轮生成的关系 —— 关系是设定结构，必须与替换后的
 * 名单自洽，否则被移除角色会留下悬空的关系端点。
 */
function replaceGeneratedEntriesWithExisting(
  generatedEntries: CharacterRosterEntry[],
  existingEntries: CharacterRosterEntry[],
): CharacterRosterEntry[] {
  const existingByName = new Map(
    existingEntries.map(entry => [characterRosterIdentityKey(entry.name), entry]),
  )
  const replaced = generatedEntries.map((generated) => {
    const existing = existingByName.get(characterRosterIdentityKey(generated.name))
    if (!existing) return generated
    const merged = mergeExistingEntryManualWins(existing, generated)
    // 关系是设定结构，必须与替换后的名单自洽：本轮生成的结构化边覆盖旧边。
    // 作者手写的关系原话是独立的作者事实，仍由 mergeExistingEntryManualWins
    // 按 manual-wins 保留。
    return { ...merged, relationships: generated.relationships }
  })
  assertRelationshipClosure(replaced)
  return replaced
}

function assertRelationshipClosure(entries: readonly CharacterRosterEntry[]): void {
  const names = new Set(entries.map(entry => characterRosterIdentityKey(entry.name)))
  if (names.size !== entries.length || entries.some(entry => !entry.name.trim())) {
    throw new Error('已有角色身份不安全，已拒绝合并')
  }
  for (const entry of entries) {
    const relationshipKeys = new Set<string>()
    for (const relationship of entry.relationships) {
      if (
        !relationship.target.trim()
        || !relationship.relation.trim()
        || characterRosterIdentityKey(relationship.target) === characterRosterIdentityKey(entry.name)
        || !names.has(characterRosterIdentityKey(relationship.target))
      ) {
        throw new Error('已有角色关系不完整，已拒绝合并')
      }
      const key = `${relationship.target}\u0000${relationship.relation}`
      if (relationshipKeys.has(key)) throw new Error('已有角色关系存在重复，已拒绝合并')
      relationshipKeys.add(key)
    }
  }
}

/**
 * 仿写导入（novel_import）的保守合并：非空旧字段和未出现在本轮候选中的旧
 * 角色都保留，空字段才由新候选补齐。该策略不猜测字段来源。
 *
 * 架构重新生成不走这里 —— 它必须让「将覆盖」名副其实，见
 * `replaceGeneratedEntriesWithExisting`。
 */
function mergeGeneratedEntriesWithExisting(
  generatedEntries: CharacterRosterEntry[],
  existingEntries: CharacterRosterEntry[],
  overwriteExisting = false,
): CharacterRosterEntry[] {
  const generatedByName = new Map(generatedEntries.map(entry => [characterRosterIdentityKey(entry.name), entry]))
  const mergedExisting = existingEntries.map((existing) => {
    const generated = generatedByName.get(characterRosterIdentityKey(existing.name))
    if (!generated) return { ...existing }
    return overwriteExisting
      ? mergeExistingEntryIncomingWins(existing, generated)
      : mergeExistingEntryManualWins(existing, generated)
  })
  const existingNames = new Set(existingEntries.map(entry => characterRosterIdentityKey(entry.name)))
  const additions = generatedEntries.filter(entry => !existingNames.has(characterRosterIdentityKey(entry.name)))
  const merged = [...mergedExisting, ...additions]
  assertRelationshipClosure(merged)
  return merged
}

function hasFinalizedDraft(db: BetterSqlite3.Database, chapterNumber: number): boolean {
  return db.prepare(`
    SELECT 1
    FROM drafts
    WHERE chapter_number = ? AND status = 'finalized'
    LIMIT 1
  `).get(chapterNumber) !== undefined
}

function assertCurrentFinalizedSource(
  db: BetterSqlite3.Database,
  source: FinalizedSourceIdentity,
): void {
  const row = db.prepare(`
    SELECT drafts.chapter_number AS chapterNumber, drafts.status,
           finalization_outbox.finalization_id AS finalizationId,
           finalization_outbox.content_hash AS contentHash
    FROM drafts
    JOIN finalization_outbox ON finalization_outbox.draft_id = drafts.id
    WHERE drafts.id = ?
  `).get(source.draftId) as {
    chapterNumber: number
    status: string
    finalizationId: string
    contentHash: string
  } | undefined
  if (
    !row
    || row.status !== 'finalized'
    || row.chapterNumber !== source.chapterNumber
    || row.finalizationId !== source.finalizationId
    || row.contentHash !== source.contentHash
  ) throw new Error('角色状态来源已失效，已拒绝过期后处理写入')
}

function mergeDerivedCurrentState(
  existing: CharacterRosterCharacterState | undefined,
  candidate: CharacterRosterCharacterState,
  source: FinalizedSourceIdentity,
): CharacterRosterCharacterState | undefined {
  const merged: CharacterRosterCharacterState = existing
    ? { ...existing, provenance: { ...existing.provenance } }
    : {
        location: '', powerLevel: '', physicalState: '', mentalState: '',
        keyItems: '', recentEvents: '', updatedAtChapter: source.chapterNumber,
      }
  let changed = false
  for (const field of CHARACTER_STATE_TEXT_FIELDS) {
    const provenance = candidate.provenance?.[field]
    if (provenance?.kind !== 'derived') continue
    if (
      provenance.source.draftId !== source.draftId
      || provenance.source.finalizationId !== source.finalizationId
      || provenance.source.chapterNumber !== source.chapterNumber
      || provenance.source.contentHash !== source.contentHash
    ) throw new Error('角色状态字段与定稿来源不一致')

    const previousSource = existing?.provenance?.[field]
    const previousValue = existing?.[field] ?? ''
    // Unknown legacy and explicit author values are never silently reclassified or overwritten.
    if (previousValue && previousSource?.kind !== 'derived') continue
    if (previousSource?.kind === 'author' || previousSource?.kind === 'legacy') continue
    merged[field] = candidate[field]
    merged.provenance ??= {}
    merged.provenance[field] = provenance
    changed = true
  }
  if (!changed) return existing
  merged.updatedAtChapter = source.chapterNumber
  return merged
}

function mergeIncrementalEntriesWithExisting(
  db: BetterSqlite3.Database,
  candidates: CharacterRosterEntry[],
  existingEntries: CharacterRosterEntry[],
  intent: Extract<CharacterRosterCommitIntent, 'blueprint_sync' | 'chapter_progress'>,
  source?: FinalizedSourceIdentity,
): CharacterRosterEntry[] {
  if (intent === 'chapter_progress') {
    if (!source) throw new Error('章节状态更新缺少定稿来源收据')
    assertCurrentFinalizedSource(db, source)
    for (const candidate of candidates) {
      if (
        !candidate.currentState
        || candidate.currentState.updatedAtChapter !== source.chapterNumber
      ) {
        throw new Error(`角色「${candidate.name}」的章节状态尚未定稿，已拒绝后处理写入`)
      }
    }
  }
  const candidateByName = new Map(candidates.map(entry => [characterRosterIdentityKey(entry.name), entry]))
  const mergedExisting = existingEntries.map((existing) => {
    const candidate = candidateByName.get(characterRosterIdentityKey(existing.name))
    if (!candidate) return { ...existing }
    if (
      intent === 'chapter_progress'
      && candidate.currentState
      && existing.currentState
      && candidate.currentState.updatedAtChapter < existing.currentState.updatedAtChapter
      && hasFinalizedDraft(db, existing.currentState.updatedAtChapter)
    ) {
      throw new Error(`角色「${existing.name}」已由较新章节更新，已拒绝旧章节后处理覆盖`)
    }

    // 蓝图同步只附加结构化关系；章节定稿则以本轮已验证的状态补丁推进
    // currentState。其他资料保留已有事实，避免工作流重写人工档案。
    const merged: CharacterRosterEntry = {
      ...existing,
      relationships: candidate.relationships.length > 0
        ? candidate.relationships
        : existing.relationships,
      ...(intent === 'chapter_progress' && candidate.currentState && source
        ? { currentState: mergeDerivedCurrentState(existing.currentState, candidate.currentState, source) }
        : {}),
    }
    return merged
  })
  const existingNames = new Set(existingEntries.map(entry => characterRosterIdentityKey(entry.name)))
  const additions = candidates.filter(candidate => !existingNames.has(characterRosterIdentityKey(candidate.name)))
  if (intent === 'chapter_progress' && additions.length > 0) {
    throw new Error(`章节定稿后处理不能创建未知角色「${additions[0].name}」`)
  }
  const merged = [...mergedExisting, ...additions]
  assertRelationshipClosure(merged)
  return merged
}

function mapManualRelationshipTargets(
  entry: CharacterRosterEntry,
  renameByOriginal: ReadonlyMap<string, string>,
  finalNames: ReadonlySet<string>,
): CharacterRosterEntry {
  const seen = new Set<string>()
  const relationships: CharacterRosterRelationship[] = []
  for (const relationship of entry.relationships) {
    const target = renameByOriginal.get(relationship.target) ?? relationship.target
    // Omitted manual entries are deletes. Their structural edges must be
    // removed in this same commit; no stale relationship can survive.
    if (!finalNames.has(target) || target === entry.name) continue
    const key = `${target}\u0000${relationship.relation}`
    if (seen.has(key)) continue
    seen.add(key)
    relationships.push({ target, relation: relationship.relation })
  }
  return {
    ...entry,
    relationships: relationships.sort((left, right) => (
      compareText(left.target, right.target) || compareText(left.relation, right.relation)
    )),
  }
}

function resolveManualEntries(
  request: CharacterRosterCommitRequest,
  existingEntries: CharacterRosterEntry[],
): { entries: CharacterRosterEntry[]; renameByOriginal: Map<string, string> } {
  const renames = request.renames ?? []
  const existingByName = new Map(existingEntries.map(entry => [entry.name, entry]))
  const finalNames = new Set(request.entries.map(entry => entry.name))
  const renameByOriginal = new Map(renames.map(rename => [rename.originalName, rename.newName]))
  const renameByNew = new Map(renames.map(rename => [rename.newName, rename.originalName]))

  for (const rename of renames) {
    if (!existingByName.has(rename.originalName)) {
      throw new Error(`角色「${rename.originalName}」不存在，无法改名`)
    }
    if (!finalNames.has(rename.newName)) {
      throw new Error(`角色改名「${rename.originalName} → ${rename.newName}」与保存内容不一致`)
    }
  }

  const entries = request.entries.map((candidate) => {
    const originalName = renameByNew.get(candidate.name) ?? candidate.name
    const existing = existingByName.get(originalName)
    const mapped = mapManualRelationshipTargets(candidate, renameByOriginal, finalNames)
    // 候选是作者的完整意图：结构化边与关系备注分列存放、各自独立落库，因此
    // 这里不再把库里的旧备注强行回注 —— 那会让「把自由文本改写成结构化关系」
    // 或「清空关系」的保存被旧值复活，甚至因回读不一致而整次回滚。
    if (!mapped.currentState) return mapped
    const provenance = { ...mapped.currentState.provenance }
    for (const field of CHARACTER_STATE_TEXT_FIELDS) {
      if ((existing?.currentState?.[field] ?? '') !== mapped.currentState[field]) {
        provenance[field] = {
          kind: 'author',
          chapterNumber: mapped.currentState.updatedAtChapter,
        }
      } else if (existing?.currentState?.provenance?.[field]) {
        provenance[field] = existing.currentState.provenance[field]
      }
    }
    return {
      ...mapped,
      currentState: { ...mapped.currentState, provenance },
    }
  })
  assertRelationshipClosure(entries)
  return { entries, renameByOriginal }
}

function updateBlueprintReferencesForManualEdit(
  db: BetterSqlite3.Database,
  renameByOriginal: ReadonlyMap<string, string>,
  finalNames: ReadonlySet<string>,
): void {
  const blueprints = db.prepare('SELECT chapter_number, characters FROM blueprints').all() as Array<{
    chapter_number: number
    characters: string
  }>
  const updateBlueprint = db.prepare(`
    UPDATE blueprints
    SET characters = ?, updated_at = datetime('now')
    WHERE chapter_number = ?
  `)
  for (const blueprint of blueprints) {
    let rawNames: unknown
    try {
      rawNames = JSON.parse(blueprint.characters)
    } catch {
      throw new Error(`第 ${blueprint.chapter_number} 章蓝图角色列表损坏`)
    }
    if (!Array.isArray(rawNames) || !rawNames.every(name => typeof name === 'string')) {
      throw new Error(`第 ${blueprint.chapter_number} 章蓝图角色列表格式错误`)
    }
    const nextNames = rawNames
      .map(name => renameByOriginal.get(name) ?? name)
      .filter(name => finalNames.has(name))
      .filter((name, index, values) => values.indexOf(name) === index)
    if (JSON.stringify(nextNames) !== JSON.stringify(rawNames)) {
      updateBlueprint.run(JSON.stringify(nextNames), blueprint.chapter_number)
    }
  }
}

function fullFactHash(entries: CharacterRosterEntry[]): string {
  return hashText(JSON.stringify(canonicalEntries(entries)))
}

function sortedEntries(entries: CharacterRosterEntry[]): CharacterRosterEntry[] {
  return [...entries].sort((left, right) => (
    ROLE_ORDER[left.role] - ROLE_ORDER[right.role] || compareText(left.name, right.name)
  ))
}

/**
 * 只从结构化角色名单生成展示 Markdown。此函数绝不读取或解释旧 Markdown。
 */
export function renderCharacterRosterMarkdown(
  entries: CharacterRosterEntry[],
  writingLanguage: WritingLanguage = DEFAULT_WRITING_LANGUAGE,
): string {
  const canonical = sortedEntries(entries)
  if (canonical.length === 0) return ''
  const english = writingLanguage === 'en-US'

  const blocks = canonical.map(entry => {
    const roleLabel = english
      ? CHARACTER_ROLE_LABELS[entry.role].enUS
      : CHARACTER_ROLE_LABELS[entry.role].zhCN
    const lines = [`## ${roleLabel}${english ? ': ' : '：'}${entry.name}`]
    const fields: Array<[string, string]> = [
      [english ? 'Gender' : '性别', entry.gender],
      [english ? 'Age' : '年龄', entry.age],
      [english ? 'Appearance' : '外貌', entry.appearance],
      [english ? 'Personality' : '性格', entry.personality],
      [english ? 'Background' : '背景', entry.background],
      [english ? 'Abilities' : '能力', entry.abilities],
      [english ? 'Motivation' : '动机', entry.motivation],
      [english ? 'Arc' : '弧光', entry.arc],
      [english ? 'Notes' : '备注', entry.notes],
    ]
    for (const [label, value] of fields) {
      if (value) lines.push(`- ${label}${english ? ': ' : '：'}${value}`)
    }
    for (const relationship of entry.relationships) {
      lines.push(english
        ? `- Relationship: ${relationship.target} (${relationship.relation})`
        : `- 关系：${relationship.target}（${relationship.relation}）`)
    }
    if (entry.relationshipNotes) {
      lines.push(english
        ? `- Relationship notes: ${entry.relationshipNotes}`
        : `- 关系备注：${entry.relationshipNotes}`)
    }
    return lines.join('\n')
  })
  return [english ? '# Character graph' : '# 角色图谱', ...blocks].join('\n\n')
}

function readMeta(db: BetterSqlite3.Database): CharacterRosterMetaRow {
  const row = db.prepare(`
    SELECT schema_version, revision, migration_state, legacy_markdown, projection_hash, fact_hash
    FROM character_roster_meta
    WHERE id = 'main'
  `).get() as CharacterRosterMetaRow | undefined
  if (!row) throw new Error('角色名单元数据未初始化')
  return row
}

function readCurrentProjection(db: BetterSqlite3.Database): string {
  return (db.prepare(
    "SELECT COALESCE(characters_arch, '') AS characters_arch FROM project_core WHERE id = 'main'",
  ).get() as { characters_arch?: string } | undefined)?.characters_arch ?? ''
}

/**
 * 严格区分“可安全使用的既有角色卡”和“需要作者显式修复的旧 Markdown”。
 * 所有自动打开/读取路径只做分类，绝不在这里写入或解析旧文本。
 */
function deriveRosterStatus(
  meta: CharacterRosterMetaRow,
  entries: readonly CharacterRosterEntry[],
  renderedMarkdown: string,
  currentProjection: string,
  hasLegacyRelationshipText: boolean,
): CharacterRosterStatus {
  switch (meta.migration_state) {
    case 'empty':
      return entries.length === 0 && !meta.legacy_markdown.trim() && !currentProjection.trim()
        ? 'empty'
        : 'inconsistent'
    case 'legacy_cards_preserved':
      // 已有角色卡本身是受保护的结构化事实，但旧项目还未用这些事实重建
      // 确定性只读图谱。不能在打开项目时自动写入，也不能直接标记 ready。
      return 'inconsistent'
    case 'legacy_markdown_pending':
      return entries.length === 0 && !!meta.legacy_markdown.trim()
        ? 'legacy_repair_required'
        : 'inconsistent'
    case 'ready':
      // 「关系备注分列」迁移在读取时把旧项目的 relationships 自由文本迁到
      // relationshipNotes，会合法改变事实哈希与投影哈希。只要表里还留着旧格式
      // 自由文本（迁移尚未通过第一次 commit 回填完成），就不拿 fact_hash 卡门，
      // 否则旧项目会「不一致 → 拒绝 commit → 永远无法回填」的死锁。
      // 迁移完成（表内全为结构化 JSON）后，fact_hash 一旦与事实不符，只能是
      // 绕过 roster 的旁路直接写 —— 必须 fail-closed。
      if (!hasLegacyRelationshipText) {
        if (
          meta.projection_hash !== hashText(renderedMarkdown)
          || meta.fact_hash !== fullFactHash([...entries])
          || currentProjection !== renderedMarkdown
        ) return 'inconsistent'
      }
      return entries.length > 0 ? 'ready' : 'empty'
  }
}

function readSnapshot(db: BetterSqlite3.Database): CharacterRosterSnapshot {
  const meta = readMeta(db)
  const characters = CharacterRepository.getAll()
  const entries = sortedEntries(characters.map(entryFromCharacter))
  const hasLegacyRelationshipText = characters.some(
    character => character.relationships.trim() !== '' && !isStructuredRelationships(character.relationships),
  )
  const writingLanguage = ProjectCoreRepository.get()?.writingLanguage ?? DEFAULT_WRITING_LANGUAGE
  const currentProjection = readCurrentProjection(db)
  const localizedProjection = renderCharacterRosterMarkdown(entries, writingLanguage)
  const previousLanguageProjection = renderCharacterRosterMarkdown(
    entries,
    writingLanguage === 'en-US' ? 'zh-CN' : 'en-US',
  )
  // A project may change writing language after a ready roster was committed.
  // Keep that exact historical projection readable; the next roster commit
  // rewrites it in the current project language without changing facts.
  const renderedMarkdown = (
    meta.migration_state === 'ready'
    && currentProjection === previousLanguageProjection
    && meta.projection_hash === hashText(previousLanguageProjection)
  ) ? previousLanguageProjection : localizedProjection
  const projectionHash = hashText(renderedMarkdown)
  return {
    schemaVersion: CHARACTER_ROSTER_SCHEMA_VERSION,
    revision: meta.revision,
    migrationState: meta.migration_state,
    status: deriveRosterStatus(meta, entries, renderedMarkdown, currentProjection, hasLegacyRelationshipText),
    entries,
    renderedMarkdown,
    projectionHash,
    factHash: meta.fact_hash,
    ...(meta.legacy_markdown ? { legacyMarkdown: meta.legacy_markdown } : {}),
  }
}

function assertReadBack(
  db: BetterSqlite3.Database,
  expectedRevision: number,
  expectedEntries: CharacterRosterEntry[],
  expectedProjection: string,
  expectedProjectionHash: string,
  expectedFactHash: string,
): CharacterRosterSnapshot {
  const snapshot = readSnapshot(db)
  const expectedStatus: CharacterRosterStatus = expectedEntries.length > 0 ? 'ready' : 'empty'
  if (
    snapshot.revision !== expectedRevision
    || snapshot.migrationState !== 'ready'
    || snapshot.status !== expectedStatus
    || snapshot.projectionHash !== expectedProjectionHash
    || snapshot.factHash !== expectedFactHash
    || snapshot.renderedMarkdown !== expectedProjection
    || JSON.stringify(canonicalEntries(snapshot.entries)) !== JSON.stringify(canonicalEntries(expectedEntries))
  ) {
    throw new Error('角色名单提交回读校验失败')
  }
  const core = db.prepare(
    "SELECT characters_arch FROM project_core WHERE id = 'main'",
  ).get() as { characters_arch?: string } | undefined
  if (core?.characters_arch !== expectedProjection) {
    throw new Error('角色图谱投影回读校验失败')
  }
  return snapshot
}

/**
 * 结构化角色名单的深 module。
 *
 * 外部 interface 只有 read/commit；校验、投影、幂等、事务与回读验证都留在
 * implementation 内。当前旧角色写入路径仍可兼容，后续 ticket 再统一收口。
 */
export class CharacterRosterRepository {
  static read(): CharacterRosterSnapshot {
    const db = requiredDb()
    ensureCharacterRosterSchema(db)
    return readSnapshot(db)
  }

  static commit(candidate: CharacterRosterCommitRequest): CharacterRosterCommitReceipt {
    const db = requiredDb()
    ensureCharacterRosterSchema(db)
    const request = normalizeRequest(candidate)
    const requestPayloadHash = payloadHash(request)

    return db.transaction(() => {
      const existingOperation = db.prepare(`
        SELECT operation_id, payload_hash, committed_revision, projection_hash
        FROM character_roster_operations
        WHERE operation_id = ?
      `).get(request.operationId) as CharacterRosterOperationRow | undefined
      if (existingOperation) {
        if (existingOperation.payload_hash !== requestPayloadHash) {
          throw new Error('操作 ID 已被用于不同的角色名单，已拒绝覆盖')
        }
        // 幂等 replay 只是“该操作已被观察到”的无写入查询，不能把历史
        // committed_revision 冒充为当前事实。返回读取时的完整当前快照，保证
        // receipt.revision 始终与 receipt.snapshot.revision 一致，也不会暗示
        // 较早 payload 在后续提交后又重新生效。
        const snapshot = readSnapshot(db)
        return {
          operationId: request.operationId,
          payloadHash: requestPayloadHash,
          revision: snapshot.revision,
          idempotent: true,
          snapshot,
        }
      }

      const meta = readMeta(db)
      if (request.expectedRevision !== meta.revision) {
        throw new Error('角色名单 revision 已过期，已拒绝覆盖')
      }
      const existingEntries = CharacterRepository.getAll().map(entryFromCharacter)
      const currentSnapshot = readSnapshot(db)
      const intent = request.intent ?? 'initialize'
      const maySafelyRegenerate = intent === 'architecture_generation'
      const isLegacyRepair = intent === 'legacy_repair'
      const isLegacyCardsAdoption = intent === 'legacy_cards_adoption'
      const isManualEdit = isManualEditIntent(intent)
      const isIncremental = intent === 'blueprint_sync' || intent === 'chapter_progress'
      const isNovelImport = intent === 'novel_import'
      if (currentSnapshot.status === 'legacy_repair_required' && !isLegacyRepair) {
        throw new Error('检测到旧角色图谱且没有角色卡；只能通过显式旧角色图谱修复写入')
      }
      if (currentSnapshot.status === 'inconsistent' && !isLegacyCardsAdoption) {
        if (meta.migration_state === 'legacy_cards_preserved') {
          throw new Error('已有角色数据受到保护；请使用后续的显式迁移或编辑流程')
        }
        throw new Error('角色名单状态不一致，已拒绝覆盖；请保留原数据并联系支持')
      }
      if (isLegacyRepair) {
        if (currentSnapshot.status !== 'legacy_repair_required' || existingEntries.length > 0) {
          throw new Error('当前项目不需要旧角色图谱修复，已拒绝覆盖')
        }
        if (request.expectedLegacyMarkdown !== meta.legacy_markdown) {
          throw new Error('旧角色图谱已变更，已拒绝将过期修复结果写入项目')
        }
      } else if (isLegacyCardsAdoption) {
        if (meta.migration_state !== 'legacy_cards_preserved' || existingEntries.length === 0) {
          throw new Error('当前项目没有可安全采用的既有角色卡，已拒绝重建图谱')
        }
        if (request.expectedLegacyMarkdown !== meta.legacy_markdown) {
          throw new Error('旧角色图谱已变更，已拒绝使用过期快照重建图谱')
        }
        const candidateNames = new Set(request.entries.map(entry => entry.name))
        const existingNames = new Set(existingEntries.map(entry => entry.name))
        if (
          candidateNames.size !== existingNames.size
          || [...candidateNames].some(name => !existingNames.has(name))
        ) {
          throw new Error('既有角色卡已变更，已拒绝使用过期快照重建图谱')
        }
      } else if (
        !maySafelyRegenerate
        && !isManualEdit
        && !isIncremental
        && !isNovelImport
        && (meta.migration_state !== 'empty' || existingEntries.length > 0)
      ) {
        throw new Error('已有角色数据受到保护；请使用后续的显式迁移或编辑流程')
      }

      let renameByOriginal = new Map<string, string>()
      const committedEntries = isLegacyCardsAdoption
        ? existingEntries
        : isManualEdit
          ? (() => {
              const resolved = resolveManualEntries(request, existingEntries)
              renameByOriginal = resolved.renameByOriginal
              return resolved.entries
            })()
          : isNovelImport
            ? mergeGeneratedEntriesWithExisting(request.entries, existingEntries, request.overwriteExisting === true)
            : maySafelyRegenerate
              ? replaceGeneratedEntriesWithExisting(request.entries, existingEntries)
              : isIncremental
                ? mergeIncrementalEntriesWithExisting(
                    db,
                    request.entries,
                    existingEntries,
                    intent as Extract<CharacterRosterCommitIntent, 'blueprint_sync' | 'chapter_progress'>,
                    request.source,
                  )
                : request.entries
      const writingLanguage = ProjectCoreRepository.get()?.writingLanguage ?? DEFAULT_WRITING_LANGUAGE
      const projection = renderCharacterRosterMarkdown(committedEntries, writingLanguage)
      const projectionHash = hashText(projection)
      const factHash = fullFactHash(committedEntries)
      const nextRevision = meta.revision + 1

      // adoption 的唯一职责是以已有结构化卡片重建只读投影。它不能重写
      // cards 表，否则“采用已有卡片”会变成一次隐式数据迁移。
      if (isManualEdit) {
        // 手工保存提交的是完整名单快照。先清空再回填使删除、改名（包括交换）
        // 与资料变更受同一事务保护；transaction 回滚时不会留下半个名单。
        //
        // avatar 是作者的手工资产，刻意不在 upsert 的写入与 ON CONFLICT 更新
        // 列表里（见 CharacterRepository）。清表回填会把它连同旧行一起抹掉 ——
        // 于是「保存一个角色」就等于「清空全名单的头像」：给反派设好头像后，
        // 主角的头像就变空白。这里按回填前的名字取走、回填后按改名映射放回。
        const avatarByStoredName = new Map(
          CharacterRepository.getAll().map(character => [character.name, character.avatar ?? '']),
        )
        const storedNameByFinalName = new Map(
          [...renameByOriginal].map(([originalName, newName]) => [newName, originalName]),
        )
        db.prepare('DELETE FROM characters').run()
        for (const entry of committedEntries) {
          CharacterRepository.upsert(characterFromEntry(entry))
        }
        for (const entry of committedEntries) {
          const storedName = storedNameByFinalName.get(entry.name) ?? entry.name
          const avatar = avatarByStoredName.get(storedName)
          if (avatar) CharacterRepository.setAvatar(entry.name, avatar)
        }
        updateBlueprintReferencesForManualEdit(
          db,
          renameByOriginal,
          new Set(committedEntries.map(entry => entry.name)),
        )
      } else if (!isLegacyCardsAdoption) {
        if (maySafelyRegenerate) {
          // 替换语义的删除半边：本轮名单是完整事实源，未列入的角色必须移除，
          // 否则多轮生成的角色会同时留在 characters 表里（UI 已承诺「将覆盖」）。
          // 与 upsert 处于同一 transaction，失败时整体回滚，不会留下半个名单。
          const keptKeys = new Set(
            committedEntries.map(entry => characterRosterIdentityKey(entry.name)),
          )
          for (const entry of existingEntries) {
            if (!keptKeys.has(characterRosterIdentityKey(entry.name))) {
              CharacterRepository.delete(entry.name)
            }
          }
        }
        for (const entry of committedEntries) CharacterRepository.upsert(characterFromEntry(entry))
      }
      const coreUpdate = db.prepare(`
        UPDATE project_core
        SET characters_arch = ?
        WHERE id = 'main'
      `).run(projection)
      if (coreUpdate.changes !== 1) throw new Error('项目主台账未初始化，已拒绝提交角色名单')

      db.prepare(`
        UPDATE character_roster_meta
        SET revision = ?, migration_state = 'ready', projection_hash = ?, fact_hash = ?, updated_at = datetime('now')
        WHERE id = 'main'
      `).run(nextRevision, projectionHash, factHash)
      db.prepare(`
        INSERT INTO character_roster_operations (
          operation_id, payload_hash, committed_revision, projection_hash
        ) VALUES (?, ?, ?, ?)
      `).run(request.operationId, requestPayloadHash, nextRevision, projectionHash)

      const snapshot = assertReadBack(
        db,
        nextRevision,
        committedEntries,
        projection,
        projectionHash,
        factHash,
      )
      return {
        operationId: request.operationId,
        payloadHash: requestPayloadHash,
        revision: nextRevision,
        idempotent: false,
        snapshot,
      }
    })()
  }
}
