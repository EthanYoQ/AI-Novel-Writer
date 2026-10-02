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
  /**
   * 自由文本关系备注（作者的原始措辞）。
   *
   * 它与 relationships 结构化边**并存**、互不压制：能解析成边的部分同时写进
   * relationships 供关系图谱与提示词使用，原文完整保留在这里供作者阅读与修改。
   * 任何通道（手工编辑、角色卡导入、蓝图同步、架构生成、章节推进）都可以提交
   * 本字段；自动流程不得覆盖已有的非空备注，作者可在角色档案里直接改写或清空。
   */
  relationshipNotes?: string
  currentState?: CharacterRosterCharacterState
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
 * `architecture_generation`，它以本轮生成的名单为完整事实源：未列入的旧角色
 * 会被移除，同名条目上已存在的手工字段仍然保留。
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
  originalName: string
  newName: string
}

export interface CharacterRosterCommitRequest {
  operationId: string
  expectedRevision: number
  schemaVersion: typeof CHARACTER_ROSTER_SCHEMA_VERSION
  entries: CharacterRosterEntry[]
  intent?: CharacterRosterCommitIntent
  /**
   * 仅 novel_import 允许。作者已在候选面板里对同名角色做出选择（直接覆盖、或
   * 在合并窗口里逐项确认过），因此本次提交的同名条目以**候选内容为准**：候选
   * 非空的字段生效，候选没写的字段仍保留原值 —— 不再走「旧值一律优先」的保守
   * 合并。未携带时保持原本的保守语义。
   */
  overwriteExisting?: boolean
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
  operationId: string
  payloadHash: string
  /** 始终等于 snapshot.revision；幂等 replay 返回当前无写入观察，不重放历史 payload。 */
  revision: number
  idempotent: boolean
  snapshot: CharacterRosterSnapshot
}
