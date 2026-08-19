import { lstat, mkdir, open, realpath, readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { WorkspaceId, type WorkspaceId as WorkspaceIdType } from '@deepseek-ai/dsh-workspace'
import type { CreativeStrategy, NovelProjectId } from './types.ts'

/**
 * Authoritative SQLite-backed project store for the AI Novel Writer DSH plugin.
 * @module @ethanyoq/dsh-ai-novel-writer/novel-store
 */
/** Stable SQLite application identity for the AI Novel Writer V2 project artifact. */
const APPLICATION_ID = 0x41_4e_4f_56
/** Stable V2 domain schema version. */
const USER_VERSION = 2
/** Exact ignore rules protecting SQLite sidecars and archived V1 sources from Git. */
const GITIGNORE_TEXT = [
  'novel.db',
  'novel.db-journal',
  'novel.db-wal',
  'novel.db-shm',
  'novel.db.lock',
  'v1-archive/',
  '',
].join('\n')

/** Project-level writing policy, independent of provider reasoning controls. */
export type NovelCreativeStrategy = CreativeStrategy
/** Narrative structure mode stored with project settings. */
export type NovelStructureMode = 'episodic' | 'three-act' | 'multi-thread'
/** Narrative point of view stored with project settings. */
export type NovelNarrativePov = 'first' | 'third-limited' | 'third-omniscient' | 'multi-pov'

/** Request that creates the authoritative project aggregate in an empty V2 store. */
export interface NovelStoreInitializeRequest {
  readonly workspaceId: WorkspaceIdType
  readonly title: string
  readonly language: string
  readonly genre: string
  readonly plannedChapters: number
  readonly targetWordsPerChapter: number
  readonly creativeStrategy: NovelCreativeStrategy
  readonly structureMode: NovelStructureMode
  readonly narrativePov: NovelNarrativePov
  readonly globalGuidance: string
}

/** Authoritative project settings aggregate. */
export interface NovelProjectAggregate {
  readonly revision: number
  readonly title: string
  readonly language: string
  readonly genre: string
  readonly plannedChapters: number
  readonly targetWordsPerChapter: number
  readonly creativeStrategy: NovelCreativeStrategy
  readonly structureMode: NovelStructureMode
  readonly narrativePov: NovelNarrativePov
  readonly globalGuidance: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** Complete replacement value for the project settings aggregate. */
export type NovelProjectNextValue = Omit<NovelProjectAggregate, 'revision'>

/** Authoritative story architecture aggregate. */
export interface NovelArchitectureAggregate {
  readonly revision: number
  readonly premise: string
  readonly characterGraph: string
  readonly world: string
  readonly plotOutline: string
  readonly styleConstraints: string
  readonly referenceWorks: readonly string[]
}

/** Complete replacement value for the story architecture aggregate. */
export type NovelArchitectureNextValue = Omit<NovelArchitectureAggregate, 'revision'>

/** One character card in the authoritative characters collection. */
export interface NovelCharacterItem {
  readonly characterId: string
  readonly name: string
  readonly role: string
  readonly summary: string
  readonly goal: string
  readonly currentState: string
  readonly notes: string
}

/** One relationship in the authoritative characters collection. */
export interface NovelCharacterRelationship {
  readonly fromCharacterId: string
  readonly toCharacterId: string
  readonly relation: string
  readonly notes: string
}

/** Authoritative characters collection aggregate. */
export interface NovelCharactersAggregate {
  readonly revision: number
  readonly items: readonly NovelCharacterItem[]
  readonly relationships: readonly NovelCharacterRelationship[]
}

/** Complete replacement value for the characters collection aggregate. */
export type NovelCharactersNextValue = Omit<NovelCharactersAggregate, 'revision'>

/** Lifecycle of one chapter in the authoritative chapter aggregate. */
export type NovelChapterStatus = 'planned' | 'drafting' | 'reviewing' | 'revising' | 'finalized'

/** Authoritative chapter blueprint aggregate. */
export interface NovelChapterAggregate {
  readonly revision: number
  readonly chapter: number
  readonly title: string
  readonly purpose: string
  readonly plotBeats: readonly string[]
  readonly characters: readonly string[]
  readonly keyEvents: readonly string[]
  readonly suspense: string
  readonly status: NovelChapterStatus
}

/** Complete replacement value for one chapter blueprint aggregate. */
export type NovelChapterNextValue = Omit<NovelChapterAggregate, 'revision'>

/** Kind of recoverable work represented by one task aggregate. */
export type NovelTaskKind = 'architecture' | 'chapter' | 'review' | 'revision' | 'finalization'
/** Progress state of one task aggregate. */
export type NovelTaskStatus = 'pending' | 'running' | 'blocked' | 'succeeded' | 'failed' | 'cancelled'

/** Authoritative task aggregate persisted in the project database. */
export interface NovelTaskAggregate {
  readonly revision: number
  readonly taskId: string
  readonly kind: NovelTaskKind
  readonly stage: string
  readonly status: NovelTaskStatus
  readonly failure: string
  readonly resumeCursor: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** Complete replacement value for one task aggregate. */
export type NovelTaskNextValue = Omit<NovelTaskAggregate, 'revision'>

/** Closed aggregate selector; arbitrary filesystem paths are intentionally absent. */
export type NovelAggregateRef =
  | { readonly kind: 'project' }
  | { readonly kind: 'architecture' }
  | { readonly kind: 'characters' }
  | { readonly kind: 'chapter'; readonly chapter: number }
  | { readonly kind: 'task'; readonly taskId: string }

/** Host-owned origin and model provenance attached to one ChangeSet. */
export type NovelChangeProvenance =
  | { readonly origin: 'manual' }
  | {
    readonly origin: 'model'
    readonly sessionId: string
    readonly callId: string
    readonly argsHash: string
  }

/** One authoritative single-aggregate replacement transaction. */
export type NovelChangeSet =
  | {
    readonly changeSetId: string
    readonly operation: 'replace'
    readonly aggregate: { readonly kind: 'project' }
    readonly baseAggregateRevision: number
    readonly baseGlobalRevision: number
    readonly nextValue: NovelProjectNextValue
    readonly provenance: NovelChangeProvenance
  }
  | {
    readonly changeSetId: string
    readonly operation: 'replace'
    readonly aggregate: { readonly kind: 'architecture' }
    readonly baseAggregateRevision: number
    readonly baseGlobalRevision: number
    readonly nextValue: NovelArchitectureNextValue
    readonly provenance: NovelChangeProvenance
  }
  | {
    readonly changeSetId: string
    readonly operation: 'replace'
    readonly aggregate: { readonly kind: 'characters' }
    readonly baseAggregateRevision: number
    readonly baseGlobalRevision: number
    readonly nextValue: NovelCharactersNextValue
    readonly provenance: NovelChangeProvenance
  }
  | {
    readonly changeSetId: string
    readonly operation: 'replace'
    readonly aggregate: { readonly kind: 'chapter'; readonly chapter: number }
    readonly baseAggregateRevision: number
    readonly baseGlobalRevision: number
    readonly nextValue: NovelChapterNextValue
    readonly provenance: NovelChangeProvenance
  }
  | {
    readonly changeSetId: string
    readonly operation: 'replace'
    readonly aggregate: { readonly kind: 'task'; readonly taskId: string }
    readonly baseAggregateRevision: number
    readonly baseGlobalRevision: number
    readonly nextValue: NovelTaskNextValue
    readonly provenance: NovelChangeProvenance
  }

/** Deterministic result of one committed or replayed ChangeSet. */
export interface NovelChangeReceipt {
  readonly changeSetId: string
  readonly projectId: NovelProjectId
  readonly aggregate: NovelAggregateRef
  readonly aggregateRevision: number
  readonly globalRevision: number
}

/** Public audit projection stored with each authoritative ChangeSet. */
export interface NovelChangeAuditRecord {
  readonly changeSetId: string
  readonly operation: 'replace'
  readonly aggregate: NovelAggregateRef
  readonly baseAggregateRevision: number
  readonly baseGlobalRevision: number
  readonly aggregateRevision: number
  readonly globalRevision: number
  readonly provenance: NovelChangeProvenance
  readonly status: 'committed'
}

/** Storage invariants exposed for diagnostics and qualification. */
export interface NovelStorageDiagnostics {
  readonly applicationId: number
  readonly userVersion: number
  readonly foreignKeys: boolean
  readonly journalMode: string
  readonly synchronous: string
  readonly lockingMode: string
}

/** Receipt for one explicit V1 project import published as a V2 database. */
export interface NovelMigrationReceipt {
  readonly projectId: NovelProjectId
  readonly fingerprint: string
  readonly archivePath: string
  readonly sourceCount: number
  readonly chapterCount: number
  readonly draftCount: number
  readonly migratedAt: string
}

/** Chapter text imported from V1 before the full V2 artifact projection is exposed. */
export interface NovelArtifactSeed {
  readonly artifactId: string
  readonly chapter: number
  readonly kind: 'draft'
  readonly content: string
  readonly createdAt: string
}

/** Complete initial V2 state imported from one fingerprinted V1 source set. */
export interface NovelMigrationSeed {
  readonly projectId: NovelProjectId
  readonly workspaceId: WorkspaceIdType
  readonly project: NovelProjectNextValue
  readonly architecture: NovelArchitectureNextValue
  readonly characters: NovelCharactersNextValue
  readonly chapters: readonly NovelChapterNextValue[]
  readonly artifacts: readonly NovelArtifactSeed[]
  readonly fingerprint: string
  readonly archivePath: string
  readonly sourceCount: number
  readonly migratedAt: string
}

/** Complete authoritative projection returned by {@link NovelStore.read}. */
export interface NovelStoreSnapshot {
  readonly projectId: NovelProjectId
  readonly workspaceId: WorkspaceIdType
  readonly workspacePath: string
  readonly globalRevision: number
  readonly readOnly: boolean
  readonly storage: NovelStorageDiagnostics
  readonly project: NovelProjectAggregate
  readonly architecture: NovelArchitectureAggregate
  readonly characters: NovelCharactersAggregate
  readonly chapters: readonly NovelChapterAggregate[]
  readonly tasks: readonly NovelTaskAggregate[]
  readonly changes: readonly NovelChangeAuditRecord[]
  readonly migration: NovelMigrationReceipt | undefined
}

/** Public domain interface for the V2 authoritative project store. */
export interface NovelStore {
  /**
   * Create the initial project aggregate in an empty V2 store.
   *
   * @param request Complete project identity, settings, and workspace binding.
   * @param signal Cancellation signal checked before the transaction.
   * @returns The initialized project identity and initial revision.
   * @throws {@link NovelStoreError} when the project exists or the request is invalid.
   */
  initialize(request: NovelStoreInitializeRequest, signal: AbortSignal): Promise<{ readonly projectId: NovelProjectId; readonly globalRevision: number }>
  /**
   * Read the complete authoritative project projection and storage diagnostics.
   *
   * @param signal Cancellation signal checked before reading.
   * @returns Project, architecture, characters, chapters, revisions, audit, and binding state.
   * @throws {@link NovelStoreError} when the store is not initialized or unreadable.
   */
  read(signal: AbortSignal): Promise<NovelStoreSnapshot>
  /**
   * Commit exactly one aggregate replacement transaction.
   *
   * @param change Closed single-aggregate ChangeSet with complete next value.
   * @param signal Cancellation signal checked before the transaction.
   * @returns The same receipt for both first commit and identical replay.
   * @throws {@link NovelStoreError} for stale revisions, idempotency conflicts, validation, lock, or write failures.
   */
  applyChange(change: NovelChangeSet, signal: AbortSignal): Promise<NovelChangeReceipt>
  /** Wait for queued operations, close SQLite, and release the exclusive write lock. */
  dispose(): Promise<void>
}

/** Stable machine-readable failures exposed by the V2 store. */
export type NovelStoreErrorCode =
  | 'NOT_INITIALIZED'
  | 'ALREADY_INITIALIZED'
  | 'UNSUPPORTED_FORMAT'
  | 'WORKSPACE_MISMATCH'
  | 'INVALID_CONTENT'
  | 'PATH_REJECTED'
  | 'STALE_REVISION'
  | 'IDEMPOTENCY_CONFLICT'
  | 'WRITE_LOCKED'
  | 'WRITE_FAILED'
  | 'CANCELLED'

/** Error carrying a stable V2 NovelStore failure code. */
export class NovelStoreError extends HarnessError {
  declare readonly code: NovelStoreErrorCode

  /**
   * Create a stable NovelStore failure.
   *
   * @param code Machine-readable failure code.
   * @param message Human-readable failure detail.
   * @param options Standard error cause options.
   */
  constructor(code: NovelStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, code, options)
  }
}

interface ProjectRow {
  readonly title: string
  readonly language: string
  readonly genre: string
  readonly planned_chapters: number
  readonly target_words_per_chapter: number
  readonly creative_strategy: string
  readonly structure_mode: string
  readonly narrative_pov: string
  readonly global_guidance: string
  readonly global_revision: number
  readonly project_revision: number
  readonly created_at: string
  readonly updated_at: string
}

interface ArchitectureRow {
  readonly premise: string
  readonly character_graph: string
  readonly world: string
  readonly plot_outline: string
  readonly style_constraints: string
  readonly reference_works: string
  readonly revision: number
}

interface ChapterRow {
  readonly chapter: number
  readonly title: string
  readonly purpose: string
  readonly plot_beats: string
  readonly key_events: string
  readonly suspense: string
  readonly status: string
  readonly revision: number
}

interface CharacterRecord {
  readonly character_id: string
  readonly name: string
  readonly role: string
  readonly summary: string
  readonly goal: string
  readonly current_state: string
  readonly notes: string
}

interface CharacterRelationshipRecord {
  readonly from_character_id: string
  readonly to_character_id: string
  readonly relation: string
  readonly notes: string
}

interface TaskRow {
  readonly task_id: string
  readonly kind: string
  readonly stage: string
  readonly status: string
  readonly failure: string | null
  readonly resume_cursor: string | null
  readonly revision: number
  readonly created_at: string
  readonly updated_at: string
}

interface ChangeRow {
  readonly change_set_id: string
  readonly aggregate_kind: string
  readonly aggregate_id: number | null
  readonly aggregate_key: string
  readonly operation: string
  readonly base_aggregate_revision: number
  readonly base_global_revision: number
  readonly result_aggregate_revision: number
  readonly result_global_revision: number
  readonly status: string
  readonly provenance: string
}

interface MetaBinding {
  readonly projectId: string
  readonly workspaceId: string
  readonly workspacePath: string
}

type Database = import('node:sqlite').DatabaseSync

const SCHEMA = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE project (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  title TEXT NOT NULL,
  language TEXT NOT NULL,
  genre TEXT NOT NULL,
  planned_chapters INTEGER NOT NULL CHECK (planned_chapters > 0),
  target_words_per_chapter INTEGER NOT NULL CHECK (target_words_per_chapter > 0),
  creative_strategy TEXT NOT NULL,
  structure_mode TEXT NOT NULL,
  narrative_pov TEXT NOT NULL,
  global_guidance TEXT NOT NULL,
  global_revision INTEGER NOT NULL CHECK (global_revision >= 0),
  project_revision INTEGER NOT NULL CHECK (project_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE architecture (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  premise TEXT NOT NULL,
  character_graph TEXT NOT NULL,
  world TEXT NOT NULL,
  plot_outline TEXT NOT NULL,
  style_constraints TEXT NOT NULL,
  reference_works TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0)
) STRICT;

CREATE TABLE character_collection (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL CHECK (revision >= 0)
) STRICT;

CREATE TABLE characters (
  character_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  summary TEXT NOT NULL,
  goal TEXT NOT NULL,
  current_state TEXT NOT NULL,
  notes TEXT NOT NULL
) STRICT;

CREATE TABLE character_relationships (
  from_character_id TEXT NOT NULL REFERENCES characters(character_id) ON DELETE CASCADE,
  to_character_id TEXT NOT NULL REFERENCES characters(character_id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  notes TEXT NOT NULL,
  PRIMARY KEY (from_character_id, to_character_id, relation)
) STRICT;

CREATE TABLE chapters (
  chapter INTEGER PRIMARY KEY CHECK (chapter > 0),
  title TEXT NOT NULL,
  purpose TEXT NOT NULL,
  plot_beats TEXT NOT NULL,
  key_events TEXT NOT NULL,
  suspense TEXT NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0)
) STRICT;

CREATE TABLE chapter_characters (
  chapter INTEGER NOT NULL REFERENCES chapters(chapter) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES characters(character_id),
  PRIMARY KEY (chapter, character_id)
) STRICT;

CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY,
  chapter INTEGER NOT NULL REFERENCES chapters(chapter) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  parent_artifact_id TEXT REFERENCES artifacts(artifact_id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  report TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE proposals (
  proposal_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  args_hash TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  canonical_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE proposal_changes (
  change_set_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(proposal_id) ON DELETE CASCADE,
  aggregate_kind TEXT NOT NULL,
  aggregate_id INTEGER,
  operation TEXT NOT NULL,
  next_value TEXT NOT NULL,
  base_aggregate_revision INTEGER NOT NULL,
  base_global_revision INTEGER NOT NULL
) STRICT;

CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  failure TEXT,
  resume_cursor TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE changes (
  change_set_id TEXT PRIMARY KEY,
  aggregate_kind TEXT NOT NULL,
  aggregate_id INTEGER,
  aggregate_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  next_value TEXT NOT NULL,
  base_aggregate_revision INTEGER NOT NULL,
  base_global_revision INTEGER NOT NULL,
  result_aggregate_revision INTEGER NOT NULL,
  result_global_revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  provenance TEXT NOT NULL,
  committed_at TEXT NOT NULL
) STRICT;
`

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function requireExactKeys(value: object, keys: readonly string[], field: string): Record<string, unknown> {
  const record = value as Record<string, unknown>
  const actual = Object.keys(record).sort().join('\0')
  const expected = [...keys].sort().join('\0')
  if (actual !== expected) throw new NovelStoreError('INVALID_CONTENT', `${field} must contain exactly ${keys.join(', ')}`)
  return record
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new NovelStoreError('INVALID_CONTENT', `${field} must be a non-empty string`)
  return value
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new NovelStoreError('INVALID_CONTENT', `${field} must be a string`)
  return value
}

function requireIsoTimestamp(value: unknown, field: string): string {
  const text = requireNonEmptyString(value, field)
  const time = Date.parse(text)
  if (!Number.isFinite(time) || new Date(time).toISOString() !== text) {
    throw new NovelStoreError('INVALID_CONTENT', `${field} must be a canonical UTC timestamp`)
  }
  return text
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new NovelStoreError('INVALID_CONTENT', `${field} must be a positive integer`)
  }
  return value
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new NovelStoreError('INVALID_CONTENT', `${field} must be a non-negative integer`)
  }
  return value
}

function requireEnum<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new NovelStoreError('INVALID_CONTENT', `${field} is not supported`)
  }
  return value as T
}

function requireStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new NovelStoreError('INVALID_CONTENT', `${field} must be an array of strings`)
  }
  return value as readonly string[]
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function validateProject(value: NovelProjectNextValue): NovelProjectNextValue {
  const record = requireExactKeys(value, [
    'title', 'language', 'genre', 'plannedChapters', 'targetWordsPerChapter',
    'creativeStrategy', 'structureMode', 'narrativePov', 'globalGuidance', 'createdAt', 'updatedAt',
  ], 'project nextValue')
  return {
    title: requireNonEmptyString(record.title, 'project.title'),
    language: requireNonEmptyString(record.language, 'project.language'),
    genre: requireNonEmptyString(record.genre, 'project.genre'),
    plannedChapters: requirePositiveInteger(record.plannedChapters, 'project.plannedChapters'),
    targetWordsPerChapter: requirePositiveInteger(record.targetWordsPerChapter, 'project.targetWordsPerChapter'),
    creativeStrategy: requireEnum(record.creativeStrategy, ['auto', 'fluent-drafting', 'consistency-first', 'deep-planning'], 'project.creativeStrategy'),
    structureMode: requireEnum(record.structureMode, ['episodic', 'three-act', 'multi-thread'], 'project.structureMode'),
    narrativePov: requireEnum(record.narrativePov, ['first', 'third-limited', 'third-omniscient', 'multi-pov'], 'project.narrativePov'),
    globalGuidance: requireString(record.globalGuidance, 'project.globalGuidance'),
    createdAt: requireIsoTimestamp(record.createdAt, 'project.createdAt'),
    updatedAt: requireIsoTimestamp(record.updatedAt, 'project.updatedAt'),
  }
}

function validateTask(value: NovelTaskNextValue): NovelTaskNextValue {
  const record = requireExactKeys(value, [
    'taskId', 'kind', 'stage', 'status', 'failure', 'resumeCursor', 'createdAt', 'updatedAt',
  ], 'task nextValue')
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(record.taskId))) {
    throw new NovelStoreError('INVALID_CONTENT', 'task.taskId is invalid')
  }
  return {
    taskId: String(record.taskId),
    kind: requireEnum(record.kind, ['architecture', 'chapter', 'review', 'revision', 'finalization'], 'task.kind'),
    stage: requireNonEmptyString(record.stage, 'task.stage'),
    status: requireEnum(record.status, ['pending', 'running', 'blocked', 'succeeded', 'failed', 'cancelled'], 'task.status'),
    failure: requireString(record.failure, 'task.failure'),
    resumeCursor: requireString(record.resumeCursor, 'task.resumeCursor'),
    createdAt: requireIsoTimestamp(record.createdAt, 'task.createdAt'),
    updatedAt: requireIsoTimestamp(record.updatedAt, 'task.updatedAt'),
  }
}

function validateProvenance(value: NovelChangeProvenance): NovelChangeProvenance {
  if (value.origin === 'manual') {
    requireExactKeys(value, ['origin'], 'manual provenance')
    return value
  }
  const record = requireExactKeys(value, ['origin', 'sessionId', 'callId', 'argsHash'], 'model provenance')
  const argsHash = requireNonEmptyString(record.argsHash, 'model provenance.argsHash')
  if (!/^[a-f0-9]{64}$/.test(argsHash)) {
    throw new NovelStoreError('INVALID_CONTENT', 'model provenance.argsHash must be a SHA-256 digest')
  }
  return {
    origin: 'model',
    sessionId: requireNonEmptyString(record.sessionId, 'model provenance.sessionId'),
    callId: requireNonEmptyString(record.callId, 'model provenance.callId'),
    argsHash,
  }
}

function validateArchitecture(value: NovelArchitectureNextValue): NovelArchitectureNextValue {
  const record = requireExactKeys(value, [
    'premise', 'characterGraph', 'world', 'plotOutline', 'styleConstraints', 'referenceWorks',
  ], 'architecture nextValue')
  return {
    premise: requireString(record.premise, 'architecture.premise'),
    characterGraph: requireString(record.characterGraph, 'architecture.characterGraph'),
    world: requireString(record.world, 'architecture.world'),
    plotOutline: requireString(record.plotOutline, 'architecture.plotOutline'),
    styleConstraints: requireString(record.styleConstraints, 'architecture.styleConstraints'),
    referenceWorks: requireStringArray(record.referenceWorks, 'architecture.referenceWorks'),
  }
}

function validateCharacters(value: NovelCharactersNextValue): NovelCharactersNextValue {
  const record = requireExactKeys(value, ['items', 'relationships'], 'characters nextValue')
  if (!Array.isArray(record.items) || !Array.isArray(record.relationships)) {
    throw new NovelStoreError('INVALID_CONTENT', 'characters items and relationships must be arrays')
  }
  const items = record.items.map(item => {
    const row = requireExactKeys(item, ['characterId', 'name', 'role', 'summary', 'goal', 'currentState', 'notes'], 'character')
    return {
      characterId: requireNonEmptyString(row.characterId, 'character.characterId'),
      name: requireNonEmptyString(row.name, 'character.name'),
      role: requireNonEmptyString(row.role, 'character.role'),
      summary: requireString(row.summary, 'character.summary'),
      goal: requireString(row.goal, 'character.goal'),
      currentState: requireString(row.currentState, 'character.currentState'),
      notes: requireString(row.notes, 'character.notes'),
    }
  })
  const ids = new Set(items.map(item => item.characterId))
  if (ids.size !== items.length) throw new NovelStoreError('INVALID_CONTENT', 'character.characterId must be unique')
  const relationships = record.relationships.map(item => {
    const row = requireExactKeys(item, ['fromCharacterId', 'toCharacterId', 'relation', 'notes'], 'relationship')
    const fromCharacterId = requireNonEmptyString(row.fromCharacterId, 'relationship.fromCharacterId')
    const toCharacterId = requireNonEmptyString(row.toCharacterId, 'relationship.toCharacterId')
    if (!ids.has(fromCharacterId) || !ids.has(toCharacterId)) {
      throw new NovelStoreError('INVALID_CONTENT', 'relationship references an unknown character')
    }
    return {
      fromCharacterId,
      toCharacterId,
      relation: requireNonEmptyString(row.relation, 'relationship.relation'),
      notes: requireString(row.notes, 'relationship.notes'),
    }
  })
  const relationshipKeys = new Set(relationships.map(item => `${item.fromCharacterId}\0${item.toCharacterId}\0${item.relation}`))
  if (relationshipKeys.size !== relationships.length) {
    throw new NovelStoreError('INVALID_CONTENT', 'relationship must be unique')
  }
  return { items, relationships }
}

function validateChapter(value: NovelChapterNextValue): NovelChapterNextValue {
  const record = requireExactKeys(value, [
    'chapter', 'title', 'purpose', 'plotBeats', 'characters', 'keyEvents', 'suspense', 'status',
  ], 'chapter nextValue')
  const validated = {
    chapter: requirePositiveInteger(record.chapter, 'chapter.chapter'),
    title: requireNonEmptyString(record.title, 'chapter.title'),
    purpose: requireNonEmptyString(record.purpose, 'chapter.purpose'),
    plotBeats: requireStringArray(record.plotBeats, 'chapter.plotBeats'),
    characters: requireStringArray(record.characters, 'chapter.characters'),
    keyEvents: requireStringArray(record.keyEvents, 'chapter.keyEvents'),
    suspense: requireString(record.suspense, 'chapter.suspense'),
    status: requireEnum(record.status, ['planned', 'drafting', 'reviewing', 'revising', 'finalized'], 'chapter.status'),
  }
  if (new Set(validated.characters).size !== validated.characters.length) {
    throw new NovelStoreError('INVALID_CONTENT', 'chapter.characters must be unique')
  }
  return validated
}

interface ValidatedInitialization {
  readonly projectId: NovelProjectId
  readonly workspaceId: WorkspaceIdType
  readonly project: NovelProjectNextValue
}

function validateInitialization(request: NovelStoreInitializeRequest): ValidatedInitialization {
  const record = requireExactKeys(request, [
    'workspaceId', 'title', 'language', 'genre', 'plannedChapters', 'targetWordsPerChapter',
    'creativeStrategy', 'structureMode', 'narrativePov', 'globalGuidance',
  ], 'initialization')
  const timestamp = new Date().toISOString()
  return {
    projectId: randomUUID() as NovelProjectId,
    workspaceId: request.workspaceId,
    project: validateProject({
      title: record.title,
      language: record.language,
      genre: record.genre,
      plannedChapters: record.plannedChapters,
      targetWordsPerChapter: record.targetWordsPerChapter,
      creativeStrategy: record.creativeStrategy,
      structureMode: record.structureMode,
      narrativePov: record.narrativePov,
      globalGuidance: record.globalGuidance,
      createdAt: timestamp,
      updatedAt: timestamp,
    } as NovelProjectNextValue),
  }
}

/**
 * Validate one complete ChangeSet against the authoritative single-aggregate semantics.
 *
 * This is the shared validation contract used both by {@link NovelStore.applyChange} and by
 * the loopback command RPC preview path, so a preview never accepts a command the store
 * would later reject.
 *
 * @param change Candidate ChangeSet to validate.
 * @returns The same ChangeSet once every field satisfies the store contract.
 * @throws {@link NovelStoreError} with code `INVALID_CONTENT` for any contract violation.
 */
export function validateNovelChangeSet(change: NovelChangeSet): NovelChangeSet {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(change.changeSetId)) {
    throw new NovelStoreError('INVALID_CONTENT', 'changeSetId is invalid')
  }
  if (change.operation !== 'replace') throw new NovelStoreError('INVALID_CONTENT', 'operation is not supported')
  validateProvenance(change.provenance)
  if (!Number.isSafeInteger(change.baseAggregateRevision) || change.baseAggregateRevision < 0
    || !Number.isSafeInteger(change.baseGlobalRevision) || change.baseGlobalRevision < 0) {
    throw new NovelStoreError('INVALID_CONTENT', 'ChangeSet base revisions must be non-negative integers')
  }
  if (isProjectChange(change)) {
    validateProject(change.nextValue)
    return change
  }
  if (isArchitectureChange(change)) {
    validateArchitecture(change.nextValue)
    return change
  }
  if (isCharactersChange(change)) {
    validateCharacters(change.nextValue)
    return change
  }
  if (isChapterChange(change)) {
    if (!Number.isSafeInteger(change.aggregate.chapter) || change.aggregate.chapter <= 0) {
      throw new NovelStoreError('INVALID_CONTENT', 'chapter aggregate id must be a positive integer')
    }
    const nextValue = validateChapter(change.nextValue)
    if (nextValue.chapter !== change.aggregate.chapter) {
      throw new NovelStoreError('INVALID_CONTENT', 'chapter nextValue must match the aggregate id')
    }
    return change
  }
  if (isTaskChange(change)) {
    const nextValue = validateTask(change.nextValue)
    if (nextValue.taskId !== change.aggregate.taskId) {
      throw new NovelStoreError('INVALID_CONTENT', 'task nextValue must match the aggregate id')
    }
    return change
  }
  throw new NovelStoreError('INVALID_CONTENT', 'unsupported aggregate')
}

function aggregateId(aggregate: NovelAggregateRef): number | null {
  return aggregate.kind === 'chapter' ? aggregate.chapter : null
}

function aggregateKey(aggregate: NovelAggregateRef): string {
  switch (aggregate.kind) {
    case 'project': return 'project'
    case 'architecture': return 'architecture'
    case 'characters': return 'characters'
    case 'chapter': return `chapter:${aggregate.chapter}`
    case 'task': return `task:${aggregate.taskId}`
    default: {
      const exhaustive: never = aggregate
      return String(exhaustive)
    }
  }
}

function isProjectChange(change: NovelChangeSet): change is Extract<NovelChangeSet, { readonly aggregate: { readonly kind: 'project' } }> {
  return change.aggregate.kind === 'project'
}

function isArchitectureChange(change: NovelChangeSet): change is Extract<NovelChangeSet, { readonly aggregate: { readonly kind: 'architecture' } }> {
  return change.aggregate.kind === 'architecture'
}

function isCharactersChange(change: NovelChangeSet): change is Extract<NovelChangeSet, { readonly aggregate: { readonly kind: 'characters' } }> {
  return change.aggregate.kind === 'characters'
}

function isChapterChange(change: NovelChangeSet): change is Extract<NovelChangeSet, { readonly aggregate: { readonly kind: 'chapter'; readonly chapter: number } }> {
  return change.aggregate.kind === 'chapter'
}

function isTaskChange(change: NovelChangeSet): change is Extract<NovelChangeSet, { readonly aggregate: { readonly kind: 'task'; readonly taskId: string } }> {
  return change.aggregate.kind === 'task'
}

function parseJson<T>(text: string, message: string): T {
  try {
    return JSON.parse(text) as T
  } catch (cause) {
    throw new NovelStoreError('UNSUPPORTED_FORMAT', message, { cause })
  }
}

function parseProject(row: ProjectRow): NovelProjectAggregate {
  const value = validateProject({
    title: row.title,
    language: row.language,
    genre: row.genre,
    plannedChapters: row.planned_chapters,
    targetWordsPerChapter: row.target_words_per_chapter,
    creativeStrategy: row.creative_strategy,
    structureMode: row.structure_mode,
    narrativePov: row.narrative_pov,
    globalGuidance: row.global_guidance,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as NovelProjectNextValue)
  return {
    revision: row.project_revision,
    ...value,
  }
}

function parseArchitecture(row: ArchitectureRow): NovelArchitectureAggregate {
  const value = validateArchitecture({
    premise: row.premise,
    characterGraph: row.character_graph,
    world: row.world,
    plotOutline: row.plot_outline,
    styleConstraints: row.style_constraints,
    referenceWorks: parseJson(row.reference_works, 'architecture.referenceWorks is invalid'),
  } as NovelArchitectureNextValue)
  return {
    revision: row.revision,
    ...value,
  }
}

function parseCharacters(
  collection: { readonly revision: number },
  characterRows: readonly CharacterRecord[],
  relationshipRows: readonly CharacterRelationshipRecord[],
): NovelCharactersAggregate {
  return {
    revision: collection.revision,
    ...validateCharacters({
      items: characterRows.map(row => ({
        characterId: row.character_id,
        name: row.name,
        role: row.role,
        summary: row.summary,
        goal: row.goal,
        currentState: row.current_state,
        notes: row.notes,
      })),
      relationships: relationshipRows.map(row => ({
        fromCharacterId: row.from_character_id,
        toCharacterId: row.to_character_id,
        relation: row.relation,
        notes: row.notes,
      })),
    }),
  }
}

function parseChapter(row: ChapterRow, characters: readonly string[]): NovelChapterAggregate {
  const value = validateChapter({
    chapter: row.chapter,
    title: row.title,
    purpose: row.purpose,
    plotBeats: parseJson(row.plot_beats, 'chapter.plotBeats is invalid'),
    characters,
    keyEvents: parseJson(row.key_events, 'chapter.keyEvents is invalid'),
    suspense: row.suspense,
    status: row.status,
  } as NovelChapterNextValue)
  return {
    revision: row.revision,
    ...value,
  }
}

function parseTask(row: TaskRow): NovelTaskAggregate {
  return {
    revision: row.revision,
    ...validateTask({
      taskId: row.task_id,
      kind: row.kind,
      stage: row.stage,
      status: row.status,
      failure: row.failure ?? '',
      resumeCursor: row.resume_cursor ?? '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } as NovelTaskNextValue),
  }
}

function parseChange(row: ChangeRow): NovelChangeAuditRecord {
  const aggregate: NovelAggregateRef = row.aggregate_kind === 'chapter'
    ? { kind: 'chapter', chapter: row.aggregate_id ?? 0 }
    : row.aggregate_kind === 'task'
      ? { kind: 'task', taskId: row.aggregate_key.slice('task:'.length) }
      : { kind: requireEnum(row.aggregate_kind, ['project', 'architecture', 'characters'], 'changes.aggregateKind') }
  if (aggregateKey(aggregate) !== row.aggregate_key || aggregateId(aggregate) !== row.aggregate_id) {
    throw new NovelStoreError('UNSUPPORTED_FORMAT', 'change audit aggregate identity is invalid')
  }
  return {
    changeSetId: row.change_set_id,
    operation: requireEnum(row.operation, ['replace'], 'changes.operation'),
    aggregate,
    baseAggregateRevision: row.base_aggregate_revision,
    baseGlobalRevision: row.base_global_revision,
    aggregateRevision: row.result_aggregate_revision,
    globalRevision: row.result_global_revision,
    status: requireEnum(row.status, ['committed'], 'changes.status'),
    provenance: validateProvenance(parseJson(row.provenance, 'changes.provenance is invalid')),
  }
}

function validateMigrationReceipt(value: unknown): NovelMigrationReceipt {
  if (typeof value !== 'object' || value === null) {
    throw new NovelStoreError('UNSUPPORTED_FORMAT', 'migration receipt is invalid')
  }
  const record = requireExactKeys(value, [
    'projectId', 'fingerprint', 'archivePath', 'sourceCount', 'chapterCount', 'draftCount', 'migratedAt',
  ], 'migration receipt')
  const projectId = requireNonEmptyString(record.projectId, 'migration receipt.projectId')
  if (!isUuid(projectId)) throw new NovelStoreError('UNSUPPORTED_FORMAT', 'migration receipt.projectId is invalid')
  const fingerprint = requireNonEmptyString(record.fingerprint, 'migration receipt.fingerprint')
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new NovelStoreError('UNSUPPORTED_FORMAT', 'migration receipt.fingerprint is invalid')
  }
  const archivePath = requireNonEmptyString(record.archivePath, 'migration receipt.archivePath')
  if (archivePath !== `.ai-novel/v1-archive/${fingerprint}`) {
    throw new NovelStoreError('UNSUPPORTED_FORMAT', 'migration receipt.archivePath is invalid')
  }
  return {
    projectId: projectId as NovelProjectId,
    fingerprint,
    archivePath,
    sourceCount: requirePositiveInteger(record.sourceCount, 'migration receipt.sourceCount'),
    chapterCount: requireNonNegativeInteger(record.chapterCount, 'migration receipt.chapterCount'),
    draftCount: requireNonNegativeInteger(record.draftCount, 'migration receipt.draftCount'),
    migratedAt: requireIsoTimestamp(record.migratedAt, 'migration receipt.migratedAt'),
  }
}

function requireStorage(db: Database, readOnly: boolean): NovelStorageDiagnostics {
  const pragma = (name: string): unknown => {
    const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>
    return row[name]
  }
  const applicationId = pragma('application_id')
  const userVersion = pragma('user_version')
  const foreignKeys = pragma('foreign_keys')
  const journalMode = pragma('journal_mode')
  const synchronousNumber = pragma('synchronous')
  const lockingMode = pragma('locking_mode')
  if (applicationId !== APPLICATION_ID || userVersion !== USER_VERSION || foreignKeys !== 1) {
    throw new NovelStoreError('UNSUPPORTED_FORMAT', 'novel.db is not an AI Novel Writer V2 database')
  }
  const expectedJournalMode = 'delete'
  const expectedLockingMode = readOnly ? 'normal' : 'exclusive'
  if (journalMode !== expectedJournalMode || lockingMode !== expectedLockingMode || synchronousNumber !== 2) {
    throw new NovelStoreError('UNSUPPORTED_FORMAT', 'novel.db storage settings are invalid')
  }
  return {
    applicationId: Number(applicationId),
    userVersion: Number(userVersion),
    foreignKeys: true,
    journalMode: String(journalMode),
    synchronous: 'full',
    lockingMode: String(lockingMode),
  }
}

export async function ensureProjectDirectory(root: string, createArtifact: boolean): Promise<string> {
  const projectDirectory = join(root, '.ai-novel')
  try {
    const existing = await lstat(projectDirectory)
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new NovelStoreError('PATH_REJECTED', '.ai-novel must be a real directory inside the workspace')
    }
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') {
      throw error
    }
    if (!createArtifact) {
      throw new NovelStoreError('PATH_REJECTED', '.ai-novel must already exist for an existing project database')
    }
    await mkdir(projectDirectory, { recursive: true, mode: 0o700 })
    const created = await lstat(projectDirectory)
    if (!created.isDirectory() || created.isSymbolicLink()) {
      throw new NovelStoreError('PATH_REJECTED', '.ai-novel must be a real directory inside the workspace')
    }
  }
  const gitignore = join(projectDirectory, '.gitignore')
  try {
    const existingIgnore = await lstat(gitignore)
    if (!existingIgnore.isFile() || existingIgnore.isSymbolicLink()) {
      throw new NovelStoreError('PATH_REJECTED', '.ai-novel/.gitignore must be a real file')
    }
    const existing = await readFile(gitignore, 'utf8')
    if (existing !== GITIGNORE_TEXT) throw new NovelStoreError('INVALID_CONTENT', '.ai-novel/.gitignore has unexpected content')
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      if (!createArtifact) {
        throw new NovelStoreError('INVALID_CONTENT', '.ai-novel/.gitignore is required for an existing project database')
      }
      await writeFileAtomic(gitignore, GITIGNORE_TEXT, { mode: 0o600, dirMode: 0o700 })
    } else {
      throw error
    }
  }
  return projectDirectory
}

function validateMigrationSeed(seed: NovelMigrationSeed): NovelMigrationSeed {
  requireExactKeys(seed, [
    'projectId', 'workspaceId', 'project', 'architecture', 'characters', 'chapters', 'artifacts',
    'fingerprint', 'archivePath', 'sourceCount', 'migratedAt',
  ], 'migration seed')
  const record = seed
  if (!isUuid(record.projectId)) throw new NovelStoreError('INVALID_CONTENT', 'migration seed.projectId is invalid')
  if (!/^[a-f0-9]{64}$/.test(record.fingerprint)) {
    throw new NovelStoreError('INVALID_CONTENT', 'migration seed.fingerprint must be a SHA-256 digest')
  }
  if (record.archivePath !== `.ai-novel/v1-archive/${record.fingerprint}`) {
    throw new NovelStoreError('INVALID_CONTENT', 'migration seed.archivePath is invalid')
  }
  requirePositiveInteger(record.sourceCount, 'migration seed.sourceCount')
  requireIsoTimestamp(record.migratedAt, 'migration seed.migratedAt')
  const project = validateProject(record.project)
  const architecture = validateArchitecture(record.architecture)
  const characters = validateCharacters(record.characters)
  const chapterValues = record.chapters.map(validateChapter)
  const chapterNumbers = new Set(chapterValues.map(chapter => chapter.chapter))
  if (chapterNumbers.size !== chapterValues.length) {
    throw new NovelStoreError('INVALID_CONTENT', 'migration seed chapter numbers must be unique')
  }
  const characterIds = new Set(characters.items.map(item => item.characterId))
  if (chapterValues.some(chapter => chapter.characters.some(id => !characterIds.has(id)))) {
    throw new NovelStoreError('INVALID_CONTENT', 'migration seed chapter references an unknown character')
  }
  const artifactIds = new Set<string>()
  for (const value of record.artifacts) {
    const artifact = requireExactKeys(value, ['artifactId', 'chapter', 'kind', 'content', 'createdAt'], 'migration artifact')
    const artifactId = requireNonEmptyString(artifact.artifactId, 'migration artifact.artifactId')
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(artifactId)) {
      throw new NovelStoreError('INVALID_CONTENT', 'migration artifact.artifactId is invalid')
    }
    if (artifactIds.has(artifactId)) throw new NovelStoreError('INVALID_CONTENT', 'migration artifact.artifactId must be unique')
    artifactIds.add(artifactId)
    const chapter = requirePositiveInteger(artifact.chapter, 'migration artifact.chapter')
    if (!chapterNumbers.has(chapter)) {
      throw new NovelStoreError('INVALID_CONTENT', 'migration artifact references an unknown chapter')
    }
    if (artifact.kind !== 'draft') throw new NovelStoreError('INVALID_CONTENT', 'migration artifact.kind is not supported')
    requireString(artifact.content, 'migration artifact.content')
    requireIsoTimestamp(artifact.createdAt, 'migration artifact.createdAt')
  }
  return {
    projectId: record.projectId,
    workspaceId: record.workspaceId,
    project,
    architecture,
    characters,
    chapters: chapterValues,
    artifacts: record.artifacts,
    fingerprint: record.fingerprint,
    archivePath: record.archivePath,
    sourceCount: record.sourceCount,
    migratedAt: record.migratedAt,
  }
}

async function removeDatabaseArtifact(path: string): Promise<void> {
  await Promise.all([
    rm(path, { force: true }),
    rm(`${path}-journal`, { force: true }),
    rm(`${path}-wal`, { force: true }),
    rm(`${path}-shm`, { force: true }),
  ])
}

/**
 * Create a fully initialized migration staging database in one import transaction.
 *
 * @param databasePath Real staging file path inside the fingerprinted V1 archive.
 * @param root Canonical final workspace root recorded in the database binding.
 * @param seed Validated complete V1 projection and migration receipt inputs.
 * @returns The deterministic migration receipt written inside the staging database.
 * @throws {@link NovelStoreError} when validation or the single import transaction fails.
 */
export async function createMigratedNovelStoreFile(
  databasePath: string,
  root: string,
  seed: NovelMigrationSeed,
): Promise<NovelMigrationReceipt> {
  const valid = validateMigrationSeed(seed)
  const receipt: NovelMigrationReceipt = {
    projectId: valid.projectId,
    fingerprint: valid.fingerprint,
    archivePath: valid.archivePath,
    sourceCount: valid.sourceCount,
    chapterCount: valid.chapters.length,
    draftCount: valid.artifacts.length,
    migratedAt: valid.migratedAt,
  }
  const created = await createDatabaseFile(databasePath)
  if (!created) throw new NovelStoreError('ALREADY_INITIALIZED', 'migration staging database already exists')
  const sqlite = await import('node:sqlite')
  const db = new sqlite.DatabaseSync(databasePath)
  try {
    configureWriteConnection(db)
    createSchema(db)
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare("INSERT INTO meta (key, value) VALUES ('project_id', ?), ('workspace_id', ?), ('workspace_path', ?), ('schema_version', '2'), ('attached_at', ?), ('migration_source_fingerprint', ?), ('migration_receipt', ?)")
        .run(valid.projectId, valid.workspaceId, root, valid.project.createdAt, valid.fingerprint, stableJson(receipt))
      db.prepare(`INSERT INTO project (
        id, title, language, genre, planned_chapters, target_words_per_chapter, creative_strategy,
        structure_mode, narrative_pov, global_guidance, global_revision, project_revision, created_at, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`)
        .run(
          valid.project.title, valid.project.language, valid.project.genre,
          valid.project.plannedChapters, valid.project.targetWordsPerChapter,
          valid.project.creativeStrategy, valid.project.structureMode,
          valid.project.narrativePov, valid.project.globalGuidance,
          valid.project.createdAt, valid.project.updatedAt,
        )
      db.prepare(`INSERT INTO architecture (
        id, premise, character_graph, world, plot_outline, style_constraints, reference_works, revision
      ) VALUES (1, ?, ?, ?, ?, ?, '[]', 0)`)
        .run(
          valid.architecture.premise, valid.architecture.characterGraph, valid.architecture.world,
          valid.architecture.plotOutline, valid.architecture.styleConstraints,
        )
      db.prepare('INSERT INTO character_collection (id, revision) VALUES (1, 0)').run()
      const insertCharacter = db.prepare(`INSERT INTO characters (
        character_id, name, role, summary, goal, current_state, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      for (const character of valid.characters.items) {
        insertCharacter.run(
          character.characterId, character.name, character.role, character.summary,
          character.goal, character.currentState, character.notes,
        )
      }
      const insertRelationship = db.prepare(`INSERT INTO character_relationships (
        from_character_id, to_character_id, relation, notes
      ) VALUES (?, ?, ?, ?)`)
      for (const relationship of valid.characters.relationships) {
        insertRelationship.run(
          relationship.fromCharacterId, relationship.toCharacterId, relationship.relation, relationship.notes,
        )
      }
      const insertChapter = db.prepare(`INSERT INTO chapters (
        chapter, title, purpose, plot_beats, key_events, suspense, status, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`)
      const insertChapterCharacter = db.prepare('INSERT INTO chapter_characters (chapter, character_id) VALUES (?, ?)')
      for (const chapter of valid.chapters) {
        insertChapter.run(
          chapter.chapter, chapter.title, chapter.purpose, stableJson(chapter.plotBeats),
          stableJson(chapter.keyEvents), chapter.suspense, chapter.status,
        )
        for (const characterId of chapter.characters) insertChapterCharacter.run(chapter.chapter, characterId)
      }
      const insertArtifact = db.prepare(`INSERT INTO artifacts (
        artifact_id, chapter, kind, parent_artifact_id, content, report, created_at
      ) VALUES (?, ?, 'draft', NULL, ?, NULL, ?)`)
      for (const artifact of valid.artifacts) {
        insertArtifact.run(artifact.artifactId, artifact.chapter, artifact.content, artifact.createdAt)
      }
      db.exec('COMMIT')
      db.close()
      return receipt
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK')
      throw error
    }
  } catch (error) {
    if (db.isOpen) db.close()
    try {
      await removeDatabaseArtifact(databasePath)
    } catch (cleanupError) {
      throw new NovelStoreError('WRITE_FAILED', 'migration staging database failed and could not be cleaned up', {
        cause: new AggregateError([error, cleanupError]),
      })
    }
    if (error instanceof NovelStoreError) throw error
    throw new NovelStoreError('WRITE_FAILED', 'migration staging database import failed', { cause: error })
  }
}

async function createDatabaseFile(path: string): Promise<boolean> {
  try {
    const handle = await open(path, 'wx', 0o600)
    await handle.close()
    return true
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') return false
    throw error
  }
}

function configureWriteConnection(db: Database): void {
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA journal_mode = DELETE')
  db.exec('PRAGMA synchronous = FULL')
  db.exec('PRAGMA locking_mode = EXCLUSIVE')
}

function configureReadConnection(db: Database): void {
  db.exec('PRAGMA query_only = ON')
  db.exec('PRAGMA foreign_keys = ON')
}

function tableExists(db: Database, table: string): boolean {
  return db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) !== undefined
}

function readMetaBinding(db: Database): MetaBinding | undefined {
  if (!tableExists(db, 'meta')) return undefined
  const get = (key: string): string | undefined => {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value
  }
  const projectId = get('project_id')
  const workspaceId = get('workspace_id')
  const workspacePath = get('workspace_path')
  if (projectId === undefined || workspaceId === undefined || workspacePath === undefined) return undefined
  if (!isUuid(projectId) || workspaceId.trim() === '' || !isAbsolute(workspacePath)) {
    throw new NovelStoreError('UNSUPPORTED_FORMAT', 'novel.db workspace binding metadata is invalid')
  }
  return { projectId, workspaceId, workspacePath }
}

function hasProjectAggregate(db: Database): boolean {
  if (!tableExists(db, 'project')) return false
  return db.prepare('SELECT 1 FROM project WHERE id = 1').get() !== undefined
}

function createSchema(db: Database): void {
  db.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
  db.exec(`PRAGMA user_version = ${USER_VERSION}`)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(SCHEMA)
    db.exec('COMMIT')
  } catch (cause) {
    db.exec('ROLLBACK')
    throw new NovelStoreError('WRITE_FAILED', 'novel.db schema initialization failed', { cause })
  }
}

function acquireExclusiveLock(db: Database): void {
  db.exec('BEGIN IMMEDIATE')
  db.exec('COMMIT')
}

class SqliteNovelStore implements NovelStore {
  readonly #db: Database
  readonly #root: string
  readonly #workspaceId: WorkspaceIdType
  readonly #readOnly: boolean
  #tail: Promise<unknown> = Promise.resolve()
  #closing = false
  #disposePromise: Promise<void> | undefined

  constructor(db: Database, root: string, workspaceId: WorkspaceIdType, readOnly: boolean) {
    this.#db = db
    this.#root = root
    this.#workspaceId = workspaceId
    this.#readOnly = readOnly
  }

  async initialize(request: NovelStoreInitializeRequest, signal: AbortSignal): Promise<{ readonly projectId: NovelProjectId; readonly globalRevision: number }> {
    requireNotAborted(signal)
    const initialization = validateInitialization(request)
    return this.#enqueue(() => {
      this.#requireWritable()
      if (initialization.workspaceId !== this.#workspaceId) {
        throw new NovelStoreError('WORKSPACE_MISMATCH', 'initialization workspace does not match the opened store')
      }
      if (this.#projectRow() !== undefined) throw new NovelStoreError('ALREADY_INITIALIZED', 'novel project is already initialized')
      this.#db.exec('BEGIN IMMEDIATE')
      try {
        this.#db.prepare("INSERT INTO meta (key, value) VALUES ('project_id', ?), ('workspace_id', ?), ('workspace_path', ?), ('schema_version', '2'), ('attached_at', ?)")
          .run(initialization.projectId, initialization.workspaceId, this.#root, initialization.project.createdAt)
        this.#db.prepare(`INSERT INTO project (
          id, title, language, genre, planned_chapters, target_words_per_chapter, creative_strategy,
          structure_mode, narrative_pov, global_guidance, global_revision, project_revision, created_at, updated_at
          ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`)
          .run(
            initialization.project.title, initialization.project.language, initialization.project.genre,
            initialization.project.plannedChapters, initialization.project.targetWordsPerChapter,
            initialization.project.creativeStrategy, initialization.project.structureMode,
            initialization.project.narrativePov, initialization.project.globalGuidance,
            initialization.project.createdAt, initialization.project.updatedAt,
          )
        this.#db.prepare(`INSERT INTO architecture (
          id, premise, character_graph, world, plot_outline, style_constraints, reference_works, revision
        ) VALUES (1, '', '', '', '', '', '[]', 0)`).run()
        this.#db.prepare('INSERT INTO character_collection (id, revision) VALUES (1, 0)').run()
        this.#db.exec('COMMIT')
        return { projectId: initialization.projectId, globalRevision: 0 }
      } catch (error) {
        this.#rollback()
        throw error
      }
    })
  }

  async read(signal: AbortSignal): Promise<NovelStoreSnapshot> {
    requireNotAborted(signal)
    return this.#enqueue(() => this.#snapshot())
  }

  async applyChange(change: NovelChangeSet, signal: AbortSignal): Promise<NovelChangeReceipt> {
    requireNotAborted(signal)
    const valid = validateNovelChangeSet(change)
    return this.#enqueue(() => {
      this.#requireWritable()
      const existing = this.#existingChange(valid)
      if (existing !== undefined) return existing
      return this.#commitChange(valid)
    })
  }

  async dispose(): Promise<void> {
    this.#closing = true
    this.#disposePromise ??= this.#tail.then(() => {
      if (this.#db.isOpen) this.#db.close()
    }).catch(() => {
      this.#closing = true
      if (this.#db.isOpen) this.#db.close()
    })
    return this.#disposePromise
  }

  #enqueue<T>(operation: () => T): Promise<T> {
    if (this.#closing) throw new NovelStoreError('WRITE_FAILED', 'NovelStore is disposed')
    const result = this.#tail.then(() => {
      if (this.#closing) throw new NovelStoreError('WRITE_FAILED', 'NovelStore is disposed')
      return operation()
    })
    this.#tail = result.catch(() => {})
    return result
  }

  #requireWrittenBinding(): MetaBinding {
    const binding = readMetaBinding(this.#db)
    if (binding === undefined) throw new NovelStoreError('NOT_INITIALIZED', 'novel project is not initialized')
    return binding
  }

  #requireWritable(): void {
    if (this.#readOnly) throw new NovelStoreError('WORKSPACE_MISMATCH', 'novel project is read-only until it is re-attached')
  }

  #projectRow(): ProjectRow | undefined {
    return this.#db.prepare(`SELECT title, language, genre, planned_chapters, target_words_per_chapter,
      creative_strategy, structure_mode, narrative_pov, global_guidance, global_revision, project_revision, created_at, updated_at
      FROM project WHERE id = 1`).get() as ProjectRow | undefined
  }

  #snapshot(): NovelStoreSnapshot {
    this.#db.exec('BEGIN')
    try {
      const snapshot = this.#readSnapshot()
      this.#db.exec('COMMIT')
      return snapshot
    } catch (error) {
      this.#rollback()
      throw error
    }
  }

  #readSnapshot(): NovelStoreSnapshot {
    const binding = this.#requireWrittenBinding()
    const projectRow = this.#projectRow()
    if (projectRow === undefined) throw new NovelStoreError('NOT_INITIALIZED', 'novel project is not initialized')
    const architectureRow = this.#db.prepare(`SELECT premise, character_graph, world, plot_outline,
      style_constraints, reference_works, revision FROM architecture WHERE id = 1`).get() as unknown as ArchitectureRow | undefined
    const characterCollectionRow = this.#db.prepare('SELECT revision FROM character_collection WHERE id = 1').get() as { revision: number } | undefined
    if (architectureRow === undefined || characterCollectionRow === undefined) {
      throw new NovelStoreError('UNSUPPORTED_FORMAT', 'novel.db initial aggregates are incomplete')
    }
    const characterRows = this.#db.prepare(`SELECT character_id, name, role, summary, goal, current_state, notes
      FROM characters ORDER BY character_id`).all() as unknown as CharacterRecord[]
    const relationshipRows = this.#db.prepare(`SELECT from_character_id, to_character_id, relation, notes
      FROM character_relationships ORDER BY from_character_id, to_character_id, relation`).all() as unknown as CharacterRelationshipRecord[]
    const chapterRows = this.#db.prepare(`SELECT chapter, title, purpose, plot_beats, key_events,
      suspense, status, revision FROM chapters ORDER BY chapter`).all() as unknown as ChapterRow[]
    const chapterCharacterRows = this.#db.prepare(`SELECT chapter, character_id FROM chapter_characters
      ORDER BY chapter, character_id`).all() as unknown as Array<{ chapter: number; character_id: string }>
    const chapterCharacters = new Map<number, string[]>()
    for (const row of chapterCharacterRows) {
      const existing = chapterCharacters.get(row.chapter) ?? []
      existing.push(row.character_id)
      chapterCharacters.set(row.chapter, existing)
    }
    const taskRows = this.#db.prepare(`SELECT task_id, kind, stage, status, failure, resume_cursor, revision,
      created_at, updated_at FROM tasks ORDER BY task_id`).all() as unknown as TaskRow[]
    const changeRows = this.#db.prepare(`SELECT change_set_id, aggregate_kind, aggregate_id, aggregate_key, operation,
      base_aggregate_revision, base_global_revision, result_aggregate_revision, result_global_revision, status, provenance
      FROM changes ORDER BY committed_at, change_set_id`).all() as unknown as ChangeRow[]
    const migrationRow = this.#db.prepare("SELECT value FROM meta WHERE key = 'migration_receipt'").get() as { value: string } | undefined
    return {
      projectId: binding.projectId as NovelProjectId,
      workspaceId: WorkspaceId(binding.workspaceId),
      workspacePath: binding.workspacePath,
      globalRevision: projectRow.global_revision,
      readOnly: this.#readOnly,
      storage: requireStorage(this.#db, this.#readOnly),
      project: parseProject(projectRow),
      architecture: parseArchitecture(architectureRow),
      characters: parseCharacters(characterCollectionRow, characterRows, relationshipRows),
      chapters: chapterRows.map(row => parseChapter(row, chapterCharacters.get(row.chapter) ?? [])),
      tasks: taskRows.map(parseTask),
      changes: changeRows.map(parseChange),
      migration: migrationRow === undefined ? undefined : validateMigrationReceipt(parseJson(migrationRow.value, 'migration receipt is invalid')),
    }
  }

  #existingChange(change: NovelChangeSet): NovelChangeReceipt | undefined {
    const row = this.#db.prepare(`SELECT next_value, provenance, aggregate_kind, aggregate_id, aggregate_key,
      base_aggregate_revision, base_global_revision, result_aggregate_revision, result_global_revision
      FROM changes WHERE change_set_id = ?`)
      .get(change.changeSetId) as {
        next_value: string
        provenance: string
        aggregate_kind: string
        aggregate_id: number | null
        aggregate_key: string
        base_aggregate_revision: number
        base_global_revision: number
        result_aggregate_revision: number
        result_global_revision: number
      } | undefined
    if (row === undefined) return undefined
    if (row.next_value !== stableJson(change.nextValue)
      || row.provenance !== stableJson(change.provenance)
      || row.aggregate_kind !== change.aggregate.kind
      || row.aggregate_id !== aggregateId(change.aggregate)
      || row.aggregate_key !== aggregateKey(change.aggregate)
      || row.base_aggregate_revision !== change.baseAggregateRevision
      || row.base_global_revision !== change.baseGlobalRevision) {
      throw new NovelStoreError('IDEMPOTENCY_CONFLICT', 'changeSetId was already used with a different ChangeSet')
    }
    return {
      changeSetId: change.changeSetId,
      projectId: this.#requireWrittenBinding().projectId as NovelProjectId,
      aggregate: change.aggregate,
      aggregateRevision: row.result_aggregate_revision,
      globalRevision: row.result_global_revision,
    }
  }

  #currentRevisions(aggregate: NovelAggregateRef): { aggregate: number; global: number } {
    const project = this.#projectRow()
    if (project === undefined) throw new NovelStoreError('NOT_INITIALIZED', 'novel project is not initialized')
    if (aggregate.kind === 'project') return { aggregate: project.project_revision, global: project.global_revision }
    if (aggregate.kind === 'architecture') {
      const row = this.#db.prepare('SELECT revision FROM architecture WHERE id = 1').get() as { revision: number }
      return { aggregate: row.revision, global: project.global_revision }
    }
    if (aggregate.kind === 'characters') {
      const row = this.#db.prepare('SELECT revision FROM character_collection WHERE id = 1').get() as { revision: number }
      return { aggregate: row.revision, global: project.global_revision }
    }
    if (aggregate.kind === 'task') {
      const row = this.#db.prepare('SELECT revision FROM tasks WHERE task_id = ?').get(aggregate.taskId) as { revision: number } | undefined
      if (row === undefined) return { aggregate: 0, global: project.global_revision }
      return { aggregate: row.revision, global: project.global_revision }
    }
    const row = this.#db.prepare('SELECT revision FROM chapters WHERE chapter = ?').get(aggregate.chapter) as { revision: number } | undefined
    if (row === undefined) return { aggregate: 0, global: project.global_revision }
    return { aggregate: row.revision, global: project.global_revision }
  }

  #commitChange(change: NovelChangeSet): NovelChangeReceipt {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.#currentRevisions(change.aggregate)
      if (current.aggregate !== change.baseAggregateRevision || current.global !== change.baseGlobalRevision) {
        throw new NovelStoreError('STALE_REVISION', 'novel aggregate changed since it was read')
      }
      const nextGlobal = current.global + 1
      const nextRevision = current.aggregate + 1
      if (isProjectChange(change)) {
          const value = change.nextValue
          this.#db.prepare(`UPDATE project SET title = ?, language = ?, genre = ?, planned_chapters = ?,
            target_words_per_chapter = ?, creative_strategy = ?, structure_mode = ?, narrative_pov = ?,
            global_guidance = ?, global_revision = ?, project_revision = ?, updated_at = ? WHERE id = 1`)
            .run(
              value.title, value.language, value.genre, value.plannedChapters, value.targetWordsPerChapter,
              value.creativeStrategy, value.structureMode, value.narrativePov, value.globalGuidance,
              nextGlobal, nextRevision, value.updatedAt,
            )
      } else if (isArchitectureChange(change)) {
          const value = change.nextValue
          this.#db.prepare(`UPDATE architecture SET premise = ?, character_graph = ?, world = ?,
            plot_outline = ?, style_constraints = ?, reference_works = ?, revision = ? WHERE id = 1`)
            .run(value.premise, value.characterGraph, value.world, value.plotOutline, value.styleConstraints, stableJson(value.referenceWorks), nextRevision)
          this.#db.prepare('UPDATE project SET global_revision = ? WHERE id = 1').run(nextGlobal)
      } else if (isCharactersChange(change)) {
          const value = change.nextValue
          const retained = new Set(value.items.map(item => item.characterId))
          const referencedCharacters = this.#db.prepare(`SELECT DISTINCT character_id
            FROM chapter_characters ORDER BY character_id`).all() as Array<{ character_id: string }>
          if (referencedCharacters.some(item => !retained.has(item.character_id))) {
            throw new NovelStoreError('INVALID_CONTENT', 'characters collection still has chapter references')
          }
          const existingCharacters = this.#db.prepare('SELECT character_id FROM characters').all() as Array<{ character_id: string }>
          this.#db.exec('DELETE FROM character_relationships')
          const upsertCharacter = this.#db.prepare(`INSERT INTO characters (
            character_id, name, role, summary, goal, current_state, notes
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(character_id) DO UPDATE SET name = excluded.name, role = excluded.role,
            summary = excluded.summary, goal = excluded.goal, current_state = excluded.current_state,
            notes = excluded.notes`)
          for (const item of value.items) {
            upsertCharacter.run(
              item.characterId, item.name, item.role, item.summary, item.goal, item.currentState, item.notes,
            )
          }
          const deleteCharacter = this.#db.prepare('DELETE FROM characters WHERE character_id = ?')
          for (const item of existingCharacters) {
            if (!retained.has(item.character_id)) deleteCharacter.run(item.character_id)
          }
          const insertRelationship = this.#db.prepare(`INSERT INTO character_relationships (
            from_character_id, to_character_id, relation, notes
          ) VALUES (?, ?, ?, ?)`)
          for (const item of value.relationships) {
            insertRelationship.run(item.fromCharacterId, item.toCharacterId, item.relation, item.notes)
          }
          this.#db.prepare('UPDATE character_collection SET revision = ? WHERE id = 1').run(nextRevision)
          this.#db.prepare('UPDATE project SET global_revision = ? WHERE id = 1').run(nextGlobal)
      } else if (isChapterChange(change)) {
          const value = change.nextValue
          this.#db.prepare(`INSERT INTO chapters (chapter, title, purpose, plot_beats, key_events, suspense, status, revision)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(chapter) DO UPDATE SET title = excluded.title, purpose = excluded.purpose,
              plot_beats = excluded.plot_beats, key_events = excluded.key_events,
              suspense = excluded.suspense, status = excluded.status, revision = excluded.revision`)
            .run(
              value.chapter, value.title, value.purpose, stableJson(value.plotBeats), stableJson(value.keyEvents),
              value.suspense, value.status, nextRevision,
            )
          const exists = this.#db.prepare('SELECT 1 AS present FROM characters WHERE character_id = ?')
          for (const characterId of value.characters) {
            if (exists.get(characterId) === undefined) {
              throw new NovelStoreError('INVALID_CONTENT', 'chapter characters must already exist')
            }
          }
          this.#db.prepare('DELETE FROM chapter_characters WHERE chapter = ?').run(value.chapter)
          const insertChapterCharacter = this.#db.prepare(`INSERT INTO chapter_characters (chapter, character_id)
            VALUES (?, ?)`)
          for (const characterId of value.characters) {
            insertChapterCharacter.run(value.chapter, characterId)
          }
          this.#db.prepare('UPDATE project SET global_revision = ? WHERE id = 1').run(nextGlobal)
      } else if (isTaskChange(change)) {
          const value = change.nextValue
          this.#db.prepare(`INSERT INTO tasks (
            task_id, kind, stage, status, failure, resume_cursor, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(task_id) DO UPDATE SET kind = excluded.kind, stage = excluded.stage,
            status = excluded.status, failure = excluded.failure, resume_cursor = excluded.resume_cursor,
            revision = excluded.revision, updated_at = excluded.updated_at`)
            .run(
              value.taskId, value.kind, value.stage, value.status, value.failure || null,
              value.resumeCursor || null, nextRevision, value.createdAt, value.updatedAt,
            )
          this.#db.prepare('UPDATE project SET global_revision = ? WHERE id = 1').run(nextGlobal)
      }
      this.#db.prepare(`INSERT INTO changes (
        change_set_id, aggregate_kind, aggregate_id, aggregate_key, operation, next_value, base_aggregate_revision,
        base_global_revision, result_aggregate_revision, result_global_revision, status, error, provenance, committed_at
      ) VALUES (?, ?, ?, ?, 'replace', ?, ?, ?, ?, ?, 'committed', NULL, ?, ?)`)
        .run(
          change.changeSetId, change.aggregate.kind, aggregateId(change.aggregate), aggregateKey(change.aggregate),
          stableJson(change.nextValue),
          change.baseAggregateRevision, change.baseGlobalRevision, nextRevision, nextGlobal,
          stableJson(change.provenance), new Date().toISOString(),
        )
      this.#db.exec('COMMIT')
      return {
        changeSetId: change.changeSetId,
        projectId: this.#requireWrittenBinding().projectId as NovelProjectId,
        aggregate: change.aggregate,
        aggregateRevision: nextRevision,
        globalRevision: nextGlobal,
      }
    } catch (error) {
      this.#rollback()
      if (error instanceof NovelStoreError) throw error
      throw new NovelStoreError('WRITE_FAILED', 'novel ChangeSet failed', { cause: error })
    }
  }

  #rollback(): void {
    if (this.#db.isTransaction) this.#db.exec('ROLLBACK')
  }
}

function requireNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new NovelStoreError('CANCELLED', 'novel store operation was cancelled')
}

/** Options controlling whether opening a store may create its on-disk artifact. */
export interface NovelStoreOpenOptions {
  /**
   * When false, a missing `.ai-novel` or `novel.db` fails with `NOT_INITIALIZED` and creates
   * nothing on disk. Defaults to true, preserving the initialization path.
   */
  readonly create?: boolean
}

/**
 * Open the per-workspace authoritative NovelStore artifact.
 *
 * @param root Canonical workspace directory containing `.ai-novel`.
 * @param workspaceId Opaque DSH Workspace identity to bind or verify.
 * @param options Pass `{ create: false }` for read paths that must not create V2 artifacts.
 * @returns A read-write store for a matching binding, or a read-only store after workspace/path drift.
 * @throws {@link NovelStoreError} when the format is unsupported, another writer holds the exclusive
 *   lock, or `{ create: false }` meets an uninitialized workspace.
 */
export async function openNovelStore(
  root: string,
  workspaceId: WorkspaceIdType,
  options: NovelStoreOpenOptions = {},
): Promise<NovelStore> {
  if (!isAbsolute(root)) {
    throw new NovelStoreError('PATH_REJECTED', 'workspace root must be absolute')
  }
  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(root)
  } catch (cause) {
    throw new NovelStoreError('PATH_REJECTED', 'workspace root does not exist', { cause })
  }
  const candidateDatabasePath = join(canonicalRoot, '.ai-novel', 'novel.db')
  const sqlite = await import('node:sqlite')
  let databaseExists = false
  try {
    const databaseFile = await lstat(candidateDatabasePath)
    if (!databaseFile.isFile() || databaseFile.isSymbolicLink()) {
      throw new NovelStoreError('PATH_REJECTED', '.ai-novel/novel.db must be a real file')
    }
    databaseExists = true
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') {
      throw error
    }
  }
  if (!databaseExists && options.create === false) {
    throw new NovelStoreError('NOT_INITIALIZED', 'novel project is not initialized')
  }
  const projectDirectory = await ensureProjectDirectory(canonicalRoot, !databaseExists)
  const databasePath = join(projectDirectory, 'novel.db')

  if (!databaseExists) {
    const createdThisCall = await createDatabaseFile(databasePath)
    if (!createdThisCall) {
      throw new NovelStoreError('WRITE_LOCKED', 'novel.db appeared concurrently; retry opening the project')
    }
    const db = new sqlite.DatabaseSync(databasePath)
    try {
      configureWriteConnection(db)
      createSchema(db)
      acquireExclusiveLock(db)
      requireStorage(db, false)
      return new SqliteNovelStore(db, canonicalRoot, workspaceId, false)
    } catch (error) {
      if (db.isOpen) db.close()
      if (createdThisCall) {
        try {
          await Promise.all([
            rm(databasePath, { force: true }),
            rm(`${databasePath}-journal`, { force: true }),
            rm(`${databasePath}-wal`, { force: true }),
            rm(`${databasePath}-shm`, { force: true }),
          ])
        } catch (cleanupError) {
          throw new NovelStoreError('WRITE_FAILED', 'novel.db failed and could not be cleaned up', {
            cause: new AggregateError([error, cleanupError]),
          })
        }
      }
      if (error instanceof NovelStoreError) throw error
      throw new NovelStoreError('WRITE_FAILED', 'novel.db could not be created', { cause: error })
    }
  }

  const openReadOnlyStore = (): NovelStore => {
    const db = new sqlite.DatabaseSync(databasePath, { readOnly: true })
    try {
      configureReadConnection(db)
      requireStorage(db, true)
      return new SqliteNovelStore(db, canonicalRoot, workspaceId, true)
    } catch (error) {
      if (db.isOpen) db.close()
      throw error
    }
  }

  const openReadWriteStore = (): NovelStore => {
    const db = new sqlite.DatabaseSync(databasePath)
    try {
      configureWriteConnection(db)
      const binding = readMetaBinding(db)
      if (binding === undefined) {
        if (hasProjectAggregate(db)) {
          throw new NovelStoreError('UNSUPPORTED_FORMAT', 'novel.db has a project without workspace binding metadata')
        }
        if (!tableExists(db, 'meta')) createSchema(db)
      } else if (binding.workspaceId !== workspaceId || binding.workspacePath !== canonicalRoot) {
        db.close()
        return openReadOnlyStore()
      }
      requireStorage(db, false)
      acquireExclusiveLock(db)
      return new SqliteNovelStore(db, canonicalRoot, workspaceId, false)
    } catch (error) {
      if (db.isOpen) db.close()
      throw error
    }
  }

  let diagnostic: Database | undefined
  try {
    diagnostic = new sqlite.DatabaseSync(databasePath, { readOnly: true })
    configureReadConnection(diagnostic)
    requireStorage(diagnostic, true)
    const binding = readMetaBinding(diagnostic)
    if (binding === undefined) {
      if (hasProjectAggregate(diagnostic)) {
        diagnostic.close()
        throw new NovelStoreError('UNSUPPORTED_FORMAT', 'novel.db has a project without workspace binding metadata')
      }
      diagnostic.close()
      return openReadWriteStore()
    }
    diagnostic.close()
    if (binding.workspaceId !== workspaceId || binding.workspacePath !== canonicalRoot) {
      return openReadOnlyStore()
    }
    return openReadWriteStore()
  } catch (error) {
    if (diagnostic !== undefined && diagnostic.isOpen) diagnostic.close()
    if (error instanceof NovelStoreError) throw error
    throw new NovelStoreError('WRITE_LOCKED', 'novel.db is locked by another writer or cannot be opened', { cause: error })
  }
}
