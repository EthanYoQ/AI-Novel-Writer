import { createHash } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'

import {
  CHARACTER_ROSTER_ROLES,
  CHARACTER_ROSTER_SCHEMA_VERSION,
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
} from '../../src/shared/character-roster'
import { getProjectDb } from '../database'
import { CharacterRepository, type CharacterData } from './character-repository'
import { ensureCharacterRosterSchema } from './character-roster-schema'
import { CHARACTER_ROLE_LABELS, normalizeCharacterRole } from '../../src/shared/character-role'

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

function normalizeState(value: unknown): CharacterRosterCharacterState | undefined {
  if (value === undefined) return undefined
  if (!isObject(value)) throw new Error('角色动态状态格式无效')
  const updatedAtChapter = value.updatedAtChapter
  if (!Number.isSafeInteger(updatedAtChapter) || (updatedAtChapter as number) < 0) {
    throw new Error('角色动态状态章节号无效')
  }
  return {
    location: requiredText(value.location, '角色当前位置'),
    powerLevel: requiredText(value.powerLevel, '角色修为境界'),
    physicalState: requiredText(value.physicalState, '角色身体状态'),
    mentalState: requiredText(value.mentalState, '角色心理状态'),
    keyItems: requiredText(value.keyItems, '角色关键道具'),
    recentEvents: requiredText(value.recentEvents, '角色最近事件'),
    updatedAtChapter: updatedAtChapter as number,
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
  allowLegacyRelationshipNotes: boolean,
): CharacterRosterEntry {
  if (!isObject(value)) throw new Error('角色名单条目格式无效')
  const name = requiredText(value.name, '角色名')
  if (!name) throw new Error('角色名不能为空')
  if (!isRosterRole(value.role)) throw new Error(`角色「${name}」的定位无效`)

  if (Object.hasOwn(value, 'legacyRelationshipNotes') && !allowLegacyRelationshipNotes) {
    throw new Error('只有手工角色管理可以提交自由文本关系')
  }
  const legacyRelationshipNotes = allowLegacyRelationshipNotes && typeof value.legacyRelationshipNotes === 'string'
    ? value.legacyRelationshipNotes.trim()
    : undefined
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
    ...(legacyRelationshipNotes ? { legacyRelationshipNotes } : {}),
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

  const entries = value.entries.map(entry => normalizeEntry(entry, isManualEditIntent(intent)))
  const names = new Set(entries.map(entry => entry.name))
  if (names.size !== entries.length) throw new Error('角色名必须唯一')
  // 批量生成/导入/蓝图/定稿的增量候选可以引用“本次没有变化”的既有角色；
  // 手工候选还可能带着改名前或刚删除的目标。它们都必须先由深 module 与
  // 当前事实合并/转换，再用完整名单校验闭包。只有空项目初始化和旧图谱
  // 修复需要在候选本身上直接闭合。
  if (intent === 'initialize' || intent === 'legacy_repair') {
    for (const entry of entries) {
      for (const relationship of entry.relationships) {
        if (!names.has(relationship.target)) {
          throw new Error(`角色「${entry.name}」引用了不存在的关系目标「${relationship.target}」`)
        }
      }
    }
  }
  const renames = normalizeRenames(value.renames, intent)
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
    intent,
    ...(renames?.length ? { renames } : {}),
    ...(isLegacyEvidenceIntent(intent)
      ? { expectedLegacyMarkdown }
      : {}),
  }
}

function canonicalEntries(entries: CharacterRosterEntry[]): CharacterRosterEntry[] {
  return [...entries]
    .map(entry => ({
      ...entry,
      relationships: [...entry.relationships].sort((left, right) => (
        compareText(left.target, right.target) || compareText(left.relation, right.relation)
      )),
    }))
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
    ...(hasStructuredRelationships || !character.relationships
      ? {}
      : { legacyRelationshipNotes: character.relationships }),
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
    // 旧手工卡的自由文本关系尚无安全的字段级迁移；安全重生成时必须原样
    // 保留，不能为了写入新候选而把它静默替换为 JSON。
    relationships: entry.legacyRelationshipNotes?.trim()
      ? entry.legacyRelationshipNotes
      : JSON.stringify(entry.relationships),
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
  merged.relationships = existing.legacyRelationshipNotes?.trim() || existing.relationships.length > 0
    ? existing.relationships
    : generated.relationships
  merged.currentState = mergeCurrentStateManualWins(existing.currentState, generated.currentState)
  return merged
}

function assertRelationshipClosure(entries: readonly CharacterRosterEntry[]): void {
  const names = new Set(entries.map(entry => entry.name))
  if (names.size !== entries.length || entries.some(entry => !entry.name.trim())) {
    throw new Error('已有角色身份不安全，已拒绝合并')
  }
  for (const entry of entries) {
    const relationshipKeys = new Set<string>()
    for (const relationship of entry.relationships) {
      if (!relationship.target.trim() || !relationship.relation.trim() || relationship.target === entry.name || !names.has(relationship.target)) {
        throw new Error('已有角色关系不完整，已拒绝合并')
      }
      const key = `${relationship.target}\u0000${relationship.relation}`
      if (relationshipKeys.has(key)) throw new Error('已有角色关系存在重复，已拒绝合并')
      relationshipKeys.add(key)
    }
  }
}

/**
 * 正常架构重新生成延续旧的 manual-wins 安全规则：非空旧字段和未出现在
 * 本轮候选中的旧角色都保留；空字段才由新候选补齐。该策略不猜测字段来源。
 */
function mergeGeneratedEntriesWithExisting(
  generatedEntries: CharacterRosterEntry[],
  existingEntries: CharacterRosterEntry[],
): CharacterRosterEntry[] {
  const generatedByName = new Map(generatedEntries.map(entry => [entry.name, entry]))
  const mergedExisting = existingEntries.map((existing) => {
    const generated = generatedByName.get(existing.name)
    return generated ? mergeExistingEntryManualWins(existing, generated) : { ...existing }
  })
  const existingNames = new Set(existingEntries.map(entry => entry.name))
  const additions = generatedEntries.filter(entry => !existingNames.has(entry.name))
  const merged = [...mergedExisting, ...additions]
  assertRelationshipClosure(merged)
  return merged
}

function mergeIncrementalEntriesWithExisting(
  candidates: CharacterRosterEntry[],
  existingEntries: CharacterRosterEntry[],
  intent: Extract<CharacterRosterCommitIntent, 'blueprint_sync' | 'chapter_progress'>,
): CharacterRosterEntry[] {
  const candidateByName = new Map(candidates.map(entry => [entry.name, entry]))
  const mergedExisting = existingEntries.map((existing) => {
    const candidate = candidateByName.get(existing.name)
    if (!candidate) return { ...existing }

    // 蓝图同步只附加结构化关系；章节定稿则以本轮已验证的状态补丁推进
    // currentState。其他资料保留已有事实，避免工作流重写人工档案。
    const merged: CharacterRosterEntry = {
      ...existing,
      relationships: candidate.relationships.length > 0
        ? candidate.relationships
        : existing.relationships,
      ...(intent === 'chapter_progress' && candidate.currentState
        ? { currentState: candidate.currentState }
        : {}),
    }
    return merged
  })
  const existingNames = new Set(existingEntries.map(entry => entry.name))
  const additions = candidates.filter(candidate => !existingNames.has(candidate.name))
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
    return existing?.legacyRelationshipNotes && !mapped.legacyRelationshipNotes
      ? { ...mapped, legacyRelationshipNotes: existing.legacyRelationshipNotes }
      : mapped
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
export function renderCharacterRosterMarkdown(entries: CharacterRosterEntry[]): string {
  const canonical = sortedEntries(entries)
  if (canonical.length === 0) return ''

  const blocks = canonical.map(entry => {
    const lines = [`## ${CHARACTER_ROLE_LABELS[entry.role].zhCN}：${entry.name}`]
    const fields: Array<[string, string]> = [
      ['性别', entry.gender],
      ['年龄', entry.age],
      ['外貌', entry.appearance],
      ['性格', entry.personality],
      ['背景', entry.background],
      ['能力', entry.abilities],
      ['动机', entry.motivation],
      ['弧光', entry.arc],
      ['备注', entry.notes],
    ]
    for (const [label, value] of fields) {
      if (value) lines.push(`- ${label}：${value}`)
    }
    for (const relationship of entry.relationships) {
      lines.push(`- 关系：${relationship.target}（${relationship.relation}）`)
    }
    if (entry.legacyRelationshipNotes) {
      lines.push(`- 关系备注：${entry.legacyRelationshipNotes}`)
    }
    return lines.join('\n')
  })
  return ['# 角色图谱', ...blocks].join('\n\n')
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
      // #83 起，read/commit 是唯一写入 seam。投影和包含 currentState 的
      // 完整事实哈希都必须与表内事实一致，才能让 UI/工作流继续写入。
      if (
        meta.projection_hash !== hashText(renderedMarkdown)
        || meta.fact_hash !== fullFactHash([...entries])
        || currentProjection !== renderedMarkdown
      ) return 'inconsistent'
      return entries.length > 0 ? 'ready' : 'empty'
  }
}

function readSnapshot(db: BetterSqlite3.Database): CharacterRosterSnapshot {
  const meta = readMeta(db)
  const entries = sortedEntries(CharacterRepository.getAll().map(entryFromCharacter))
  const renderedMarkdown = renderCharacterRosterMarkdown(entries)
  const projectionHash = hashText(renderedMarkdown)
  const currentProjection = readCurrentProjection(db)
  return {
    schemaVersion: CHARACTER_ROSTER_SCHEMA_VERSION,
    revision: meta.revision,
    migrationState: meta.migration_state,
    status: deriveRosterStatus(meta, entries, renderedMarkdown, currentProjection),
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
          : maySafelyRegenerate || isNovelImport
            ? mergeGeneratedEntriesWithExisting(request.entries, existingEntries)
            : isIncremental
              ? mergeIncrementalEntriesWithExisting(
                  request.entries,
                  existingEntries,
                  intent as Extract<CharacterRosterCommitIntent, 'blueprint_sync' | 'chapter_progress'>,
                )
              : request.entries
      const projection = renderCharacterRosterMarkdown(committedEntries)
      const projectionHash = hashText(projection)
      const factHash = fullFactHash(committedEntries)
      const nextRevision = meta.revision + 1

      // adoption 的唯一职责是以已有结构化卡片重建只读投影。它不能重写
      // cards 表，否则“采用已有卡片”会变成一次隐式数据迁移。
      if (isManualEdit) {
        // 手工保存提交的是完整名单快照。先清空再回填使删除、改名（包括交换）
        // 与资料变更受同一事务保护；transaction 回滚时不会留下半个名单。
        db.prepare('DELETE FROM characters').run()
        for (const entry of committedEntries) {
          CharacterRepository.upsert(characterFromEntry(entry))
        }
        updateBlueprintReferencesForManualEdit(
          db,
          renameByOriginal,
          new Set(committedEntries.map(entry => entry.name)),
        )
      } else if (!isLegacyCardsAdoption) {
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
