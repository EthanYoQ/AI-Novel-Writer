/**
 * 结构化角色名单的跨进程契约。
 *
 * 角色的持久化事实仍只存在于 SQLite characters 表；本文件只定义读写
 * seam 的数据形状，不引入第二份 roster JSON 事实源。
 */
export const CHARACTER_ROSTER_SCHEMA_VERSION = 1 as const

export const CHARACTER_ROSTER_ROLES = [
  'protagonist',
  'antagonist',
  'supporting',
  'minor',
] as const

export type CharacterRosterRole = typeof CHARACTER_ROSTER_ROLES[number]

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
  target: string
  relation: string
}

export interface CharacterRosterCharacterState {
  location: string
  powerLevel: string
  physicalState: string
  mentalState: string
  keyItems: string
  recentEvents: string
  updatedAtChapter: number
}

/**
 * 角色名单中的一个结构化事实条目。关系以 names 为临时稳定标识；本轮不
 * 引入 UUID，后续收口 ticket 会处理手工写入和长期身份演进。
 */
export interface CharacterRosterEntry {
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
  schemaVersion: typeof CHARACTER_ROSTER_SCHEMA_VERSION
  revision: number
  migrationState: CharacterRosterMigrationState
  status: CharacterRosterStatus
  entries: CharacterRosterEntry[]
  renderedMarkdown: string
  projectionHash: string
  /** 覆盖角色资料、结构化关系与 currentState 的完整事实哈希。 */
  factHash: string
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
  /** 章节定稿后角色状态与新出场角色的原子推进。 */
  | 'chapter_progress'

export interface CharacterRosterRename {
  originalName: string
  newName: string
}

export interface CharacterRosterCommitRequest {
  operationId: string
  expectedRevision: number
  schemaVersion: typeof CHARACTER_ROSTER_SCHEMA_VERSION
  entries: CharacterRosterEntry[]
  intent?: CharacterRosterCommitIntent
  /** 仅 manual_edit 使用；由角色管理的草稿账本明确给出身份映射。 */
  renames?: CharacterRosterRename[]
  /**
   * legacy_repair / legacy_cards_adoption 使用。它是从只读快照回传的原始
   * 证据，用来拒绝把旧 Markdown A 的候选提交到后来已变为 Markdown B 的项目中。
   */
  expectedLegacyMarkdown?: string
}

export interface CharacterRosterCommitReceipt {
  operationId: string
  payloadHash: string
  revision: number
  idempotent: boolean
  snapshot: CharacterRosterSnapshot
}
