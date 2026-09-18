/**
 * 结构化角色名单的跨进程契约。
 *
 * 角色的持久化事实仍只存在于 SQLite characters 表；本文件只定义读写
 * seam 的数据形状，不引入第二份 roster JSON 事实源。
 */
import { CHARACTER_ROLES, type CharacterRole } from './character-role'
import type { FinalizedSourceIdentity } from './finalized-continuity'

export const CHARACTER_ROSTER_SCHEMA_VERSION = 1 as const

export const CHARACTER_ROSTER_ROLES = CHARACTER_ROLES

export type CharacterRosterRole = CharacterRole

/** Canonical identity key shared by roster mutation boundaries. */
export function characterRosterIdentityKey(name: string): string {
  return name.trim().toLocaleLowerCase('en-US')
}

export type CharacterRosterMigrationState =
  | 'empty'
  | 'legacy_cards_preserved'
  | 'legacy_markdown_pending'
  | 'ready'

/**
 * 面向界面的可执行状态。migrationState 保留持久化来源，status 则把安全
 * 判断收敛为调用方真正需要处理的四种情形。
 */
export type CharacterRosterStatus =
  | 'empty'
  | 'ready'
  | 'legacy_repair_required'
  | 'inconsistent'

export interface CharacterRosterRelationship {
  /** Author editing on M02 requires an ID; target remains a display snapshot. */
  targetCharacterId?: string
  target: string
  relation: string
}

export const CHARACTER_STATE_TEXT_FIELDS = [
  'location',
  'powerLevel',
  'physicalState',
  'mentalState',
  'keyItems',
  'recentEvents',
] as const

export type CharacterStateTextField = typeof CHARACTER_STATE_TEXT_FIELDS[number]

export type CharacterStateFieldProvenance =
  | { kind: 'author'; chapterNumber: number }
  | { kind: 'derived'; source: FinalizedSourceIdentity }
  | { kind: 'legacy' }

export interface CharacterRosterCharacterState {
  location: string
  powerLevel: string
  physicalState: string
  mentalState: string
  keyItems: string
  recentEvents: string
  updatedAtChapter: number
  /** Field-level because one state object may contain author and derived values. */
  provenance?: Partial<Record<CharacterStateTextField, CharacterStateFieldProvenance>>
}

/**
 * Names remain readable in old candidates; M02 author edits require stable IDs.
 */
export interface CharacterRosterEntry {
  /** draft:<UUID> is a local author creation selection key, never a persisted ID. */
  characterId?: string
  name: string
  role: CharacterRosterRole
  gender: string
  age: string
  appearance: string
  personality: string
  background: string
  abilities: string
  motivation: string
  relationships: CharacterRosterRelationship[]
  arc: string
  notes: string
  currentState?: CharacterRosterCharacterState
  /**
   * 旧 characters.relationships 的自由文本证据。只会由 read 返回，或由
   * manual_edit 原样回写；模型生成、导入、蓝图同步、章节推进与旧图谱修复
   * 均不可提交此字段。
   */
  legacyRelationshipNotes?: string
}

export interface CharacterRosterSnapshot {
  identityRevision?: number
  aliases?: import('./character-proposal').CharacterIdentitySnapshot['aliases']
  schemaVersion: typeof CHARACTER_ROSTER_SCHEMA_VERSION
  revision: number
  migrationState: CharacterRosterMigrationState
  status: CharacterRosterStatus
  entries: CharacterRosterEntry[]
  renderedMarkdown: string
  projectionHash: string
  /**
   * 覆盖角色资料、结构化关系与 currentState 的完整事实哈希。
   * 身份 schema 项目按稳定 characterId 与关系目标 targetCharacterId 派生，
   * 因此角色改名或同名目标重指向都会改变它；旧项目沿用姓名版本，保持兼容。
   */
  factHash: string
  /**
   * 持久化在 `character_roster_meta.fact_hash` 的姓名版本哈希。
   * 身份 schema 项目升级后公开 `factHash` 会变成 ID 版本，但按姓名写入的历史
   * 收据（例如旧项目导入回执）只能与这个值比较；读取路径不改写它。
   *
   * 已知限制：同名角色之间的**纯 ID 变化**（例如 A→B 重指向同名目标）只体现在
   * `factHash` 上，不会改变这个值，因此按姓名写入的历史收据看不到它。这是按姓名
   * 记录回执本身的性质，不是本字段的缺陷；重放返回的是当前快照，不是历史事实。
   * 需要区分 ID 版本历史时，应改为按 facts 契约版本记录回执，而不是重定义本字段。
   */
  nameOnlyFactHash: string
  /** 升级前的 characters_arch 原文，仅作迁移证据，绝不反向解析为角色名单。 */
  legacyMarkdown?: string
}

/**
 * `initialize` 只允许空角色名单首次建档；正常角色架构重新生成使用
 * `architecture_generation`，并由主进程保守合并已存在的手工字段。
 */
export type CharacterRosterCommitIntent =
  | 'initialize'
  | 'architecture_generation'
  | 'legacy_repair'
  /** 旧项目已有卡片时，由用户显式确认后只重建只读图谱，不改写卡片。 */
  | 'legacy_cards_adoption'
  /** 角色管理的完整手工快照；允许新增、改名、删除和空名单。 */
  | 'manual_edit'
  /** 仿写导入产生的角色候选，保守合并到现有名单。 */
  | 'novel_import'
  /** 已落盘的一批蓝图发现角色或结构化关系后的增量同步。 */
  | 'blueprint_sync'
  /** 章节定稿后仅推进已确认角色的动态状态。 */
  | 'chapter_progress'

export interface CharacterRosterRename {
  characterId?: string
  originalName: string
  newName: string
}

export interface CharacterRosterCommitRequest {
  /** Required by the M02 author-edit boundary, alongside roster revision. */
  expectedIdentityRevision?: number
  generationRunHandle?: import('../services/generation/generation-runtime').MainGenerationRunHandle
  operationId: string
  expectedRevision: number
  schemaVersion: typeof CHARACTER_ROSTER_SCHEMA_VERSION
  entries: CharacterRosterEntry[]
  intent?: CharacterRosterCommitIntent
  /** Required for chapter_progress; validated against the immutable outbox receipt. */
  source?: FinalizedSourceIdentity
  /** 仅 manual_edit 使用；由角色管理的草稿账本明确给出身份映射。 */
  renames?: CharacterRosterRename[]
  /**
   * legacy_repair / legacy_cards_adoption 使用。它是从只读快照回传的原始
   * 证据，用来拒绝把旧 Markdown A 的候选提交到后来已变为 Markdown B 的项目中。
   */
  expectedLegacyMarkdown?: string
}

export interface CharacterRosterCommitReceipt {
  created?: { selectionKey: string; characterId: string }[]
  operationId: string
  payloadHash: string
  /** 始终等于 snapshot.revision；幂等 replay 返回当前无写入观察，不重放历史 payload。 */
  revision: number
  idempotent: boolean
  snapshot: CharacterRosterSnapshot
}
