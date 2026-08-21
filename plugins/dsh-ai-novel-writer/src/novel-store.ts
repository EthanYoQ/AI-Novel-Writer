import { lstat, mkdir, open, realpath, readFile, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
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
const USER_VERSION = 4
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

/** Explicit recovery choices for a V2 project whose persisted binding has drifted. */
export type NovelStoreRecoveryMode = 'reattach' | 'clone'

/** Path-free evidence returned after an explicit binding recovery. */
export interface NovelStoreRecoveryReceipt {
  readonly mode: NovelStoreRecoveryMode
  readonly projectId: NovelProjectId
  readonly workspaceId: WorkspaceIdType
}

/** Chapter text imported from V1 before the full V2 artifact projection is exposed. */
export interface NovelArtifactSeed {
  readonly artifactId: string
  readonly chapter: number
  readonly kind: 'draft'
  readonly content: string
  readonly createdAt: string
}

/** A durable chapter artifact; its id never changes as later versions are added. */
export interface NovelArtifact {
  readonly artifactId: string
  readonly chapter: number
  readonly kind: 'draft' | 'review' | 'revision'
  readonly parentArtifactId?: string
  readonly content?: string
  readonly report?: string
  readonly summary: string
  readonly createdAt: string
}

/** Explicit user-selected final pointer; finalization never copies an artifact. */
export interface NovelChapterFinal {
  readonly chapter: number
  readonly artifactId: string
  readonly summary: string
  readonly selectedAt: string
}

/** Bounded handoff for drafting one chapter. It intentionally contains no other chapter history. */
export interface NovelChapterContext {
  readonly chapter: number
  readonly previousFinal?: {
    readonly chapter: number
    readonly artifactId: string
    readonly content: string
    readonly summary: string
  }
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
  readonly artifacts: readonly NovelArtifact[]
  readonly chapterFinals: readonly NovelChapterFinal[]
  readonly tasks: readonly NovelTaskAggregate[]
  readonly changes: readonly NovelChangeAuditRecord[]
  readonly proposals: readonly NovelProposalSummary[]
  readonly migration: NovelMigrationReceipt | undefined
}

/** Lifecycle state of one persisted non-authoritative proposal. */
export type NovelProposalStatus = 'pending' | 'partial' | 'stale' | 'applied' | 'discarded' | 'superseded' | 'failed'

/** Immutable model-provided single-aggregate replacement held by one proposal item. */
export type NovelAggregateProposalChange = Omit<NovelChangeSet, 'operation' | 'provenance'>

/** Closed artifact commands; all of them remain non-authoritative until a user applies a proposal. */
export type NovelArtifactProposalChange =
  | {
    readonly kind: 'artifact/draft'
    readonly artifactId: string
    readonly chapter: number
    readonly content: string
    readonly summary: string
  }
  | {
    readonly kind: 'artifact/review'
    readonly artifactId: string
    readonly chapter: number
    readonly parentArtifactId: string
    readonly report: string
    readonly summary: string
  }
  | {
    readonly kind: 'artifact/revision'
    readonly artifactId: string
    readonly chapter: number
    readonly parentArtifactId: string
    readonly content: string
    readonly summary: string
  }
  | {
    readonly kind: 'chapter/select-final'
    readonly chapter: number
    readonly artifactId: string
    readonly summary: string
  }

/** Immutable, typed model payload held by one proposal item. */
export type NovelProposalChange = NovelAggregateProposalChange | NovelArtifactProposalChange

/** Item-level lifecycle state. `partial` is a bundle-only projection. */
export type NovelProposalItemStatus = Exclude<NovelProposalStatus, 'partial'>

/** Derive a resume-aware bundle state from the durable state of its ordered items. */
function proposalStatusFromItems(statuses: readonly NovelProposalItemStatus[]): NovelProposalStatus {
  if (statuses.length === 0) throw new NovelStoreError('UNSUPPORTED_FORMAT', 'proposal has no items')
  if (statuses.every(status => status === 'applied')) return 'applied'
  const recoverable = statuses.find(status => status === 'pending' || status === 'stale' || status === 'failed')
  if (recoverable !== undefined) return statuses.includes('applied') ? 'partial' : recoverable
  return statuses.find(status => status !== 'applied')!
}

/** Path-free machine-readable failure retained after an item cannot be applied. */
export type NovelProposalItemFailure = NovelStoreErrorCode

/** Receipt retained atomically with a proposal item that has changed durable state. */
export type NovelProposalItemReceipt = NovelChangeReceipt | {
  readonly kind: NovelArtifactProposalChange['kind']
  readonly chapter: number
  readonly artifactId: string
}

/** One ordered immutable proposed change and its persistent lifecycle evidence. */
export interface NovelProposalItem {
  readonly itemId: string
  readonly itemOrder: number
  /** Immutable payload plus Host-derived model provenance for aggregate replacements. */
  readonly change: NovelProposalChange | NovelChangeSet
  readonly status: NovelProposalItemStatus
  readonly attemptCount: number
  readonly failure?: NovelProposalItemFailure
  readonly receipt?: NovelProposalItemReceipt
  readonly regenerationTicket?: string
  readonly supersededByProposalId?: string
  readonly supersededByItemId?: string
}

/** One persisted non-authoritative model proposal bundle available for human review. */
export interface NovelProposalSummary {
  readonly proposalId: string
  readonly sessionId: string
  readonly callId: string
  readonly argsHash: string
  readonly status: NovelProposalStatus
  readonly createdAt: string
  readonly updatedAt: string
  readonly parentProposalId?: string
  readonly parentItemId?: string
  /** Ordered immutable items retained across restarts for sidebar review and recovery. */
  readonly items: readonly NovelProposalItem[]
}

/** Complete proposal bundle accepted by the inbox. */
export interface NovelProposalRequest {
  readonly sessionId: string
  readonly callId: string
  readonly argsHash: string
  readonly payload: unknown
}

/** Result of submitting one proposal bundle. */
export interface NovelProposalReceipt {
  readonly proposal: NovelProposalSummary
  readonly duplicate: boolean
}

/** Result after applying every possible item in a persisted proposal bundle. */
export interface NovelProposalApplyResult {
  readonly proposal: NovelProposalSummary
  readonly appliedItemIds: readonly string[]
  readonly stoppedItemId?: string
}

/** Result of a non-writing item lifecycle transition. */
export interface NovelProposalItemMutationResult {
  readonly proposal: NovelProposalSummary
  readonly item: NovelProposalItem
}

/** Result of recording a regeneration ticket without invoking a model in the Host. */
export interface NovelProposalRegenerationResult extends NovelProposalItemMutationResult {
  readonly regenerationTicket: string
}

/** Deployment limits for the persistent proposal inbox. */
export interface NovelProposalOptions {
  readonly maxProposalBytes?: number
  readonly maxPendingProposals?: number
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
  /** Read only the selected final of the immediately preceding chapter for a new chapter handoff. */
  readChapterContext(chapter: number, signal: AbortSignal): Promise<NovelChapterContext>
  /**
   * Commit exactly one aggregate replacement transaction.
   *
   * @param change Closed single-aggregate ChangeSet with complete next value.
   * @param signal Cancellation signal checked before the transaction.
   * @returns The same receipt for both first commit and identical replay.
   * @throws {@link NovelStoreError} for stale revisions, idempotency conflicts, validation, lock, or write failures.
   */
  applyChange(change: NovelChangeSet, signal: AbortSignal): Promise<NovelChangeReceipt>
  /**
   * Persist one non-authoritative model proposal bundle into the inbox.
   *
   * The payload is stored verbatim; no authoritative aggregate, revision, or audit row changes.
   * Identical canonical args hashes replay as duplicates, and conflicting content for the same
   * hash fails closed.
   *
   * @param request Complete proposal bundle with Host-supplied provenance and canonical hash.
   * @param signal Cancellation signal checked before the transaction.
   * @returns The persisted proposal summary and whether the submission was a duplicate replay.
   * @throws {@link NovelStoreError} with `PROPOSAL_TOO_LARGE`, `PROPOSAL_LIMIT_REACHED`, or
   *   `PROPOSAL_CONFLICT` when the bundle violates the inbox contract.
   */
  submitProposal(request: NovelProposalRequest, signal: AbortSignal): Promise<NovelProposalReceipt>
  /** Apply a persisted bundle in item order, stopping at its first non-applicable item. */
  applyProposal(proposalId: string, signal: AbortSignal): Promise<NovelProposalApplyResult>
  /** Retry a failed item only when its retained failure code is retryable. */
  retryProposalItem(proposalId: string, itemId: string, signal: AbortSignal): Promise<NovelProposalApplyResult>
  /** Discard one unapplied item. Applied authoritative changes are never discarded. */
  discardProposalItem(proposalId: string, itemId: string, signal: AbortSignal): Promise<NovelProposalItemMutationResult>
  /** Persist an opaque regeneration ticket for one unapplied item without generating content. */
  requestProposalRegeneration(proposalId: string, itemId: string, signal: AbortSignal): Promise<NovelProposalRegenerationResult>
  /**
   * List every persisted proposal summary in insertion order.
   *
   * @param signal Cancellation signal checked before reading.
   * @returns The complete proposal inbox, empty when no proposal has been persisted.
   */
  listProposals(signal: AbortSignal): Promise<readonly NovelProposalSummary[]>
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
  | 'PROPOSAL_TOO_LARGE'
  | 'PROPOSAL_LIMIT_REACHED'
  | 'PROPOSAL_CONFLICT'
  | 'PROPOSAL_NOT_FOUND'
  | 'PROPOSAL_ITEM_NOT_FOUND'
  | 'PROPOSAL_ITEM_NOT_RETRYABLE'
  | 'PROPOSAL_ITEM_APPLIED'
  | 'REGENERATION_TICKET_INVALID'
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

interface ProposalRow {
  readonly proposal_id: string
  readonly session_id: string
  readonly call_id: string
  readonly args_hash: string
  readonly payload: string
  readonly canonical_hash: string
  readonly status: string
  readonly parent_proposal_id: string | null
  readonly parent_item_id: string | null
  readonly created_at: string
  readonly updated_at: string
}

interface LegacyProposalRow {
  readonly proposal_id: string
  readonly session_id: string
  readonly call_id: string
  readonly args_hash: string
  readonly payload: string
  readonly canonical_hash: string
  readonly status: string
  readonly created_at: string
  readonly updated_at: string
}

interface ProposalItemRow {
  readonly item_id: string
  readonly proposal_id: string
  readonly item_order: number
  readonly change_payload: string
  readonly status: string
  readonly attempt_count: number
  readonly failure_code: string | null
  readonly receipt: string | null
  readonly regeneration_ticket: string | null
  readonly regeneration_consumed_at: string | null
  readonly superseded_by_proposal_id: string | null
  readonly superseded_by_item_id: string | null
  readonly created_at: string
  readonly updated_at: string
}

interface ArtifactRow {
  readonly artifact_id: string
  readonly chapter: number
  readonly kind: string
  readonly parent_artifact_id: string | null
  readonly content: string
  readonly report: string | null
  readonly summary: string
  readonly created_at: string
}

interface ChapterFinalRow {
  readonly chapter: number
  readonly artifact_id: string
  readonly summary: string
  readonly selected_at: string
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
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE chapter_finals (
  chapter INTEGER PRIMARY KEY REFERENCES chapters(chapter) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE RESTRICT,
  summary TEXT NOT NULL,
  selected_at TEXT NOT NULL
) STRICT;

CREATE TABLE proposals (
  proposal_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  args_hash TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  canonical_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  parent_proposal_id TEXT REFERENCES proposals(proposal_id),
  parent_item_id TEXT,
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

CREATE TABLE proposal_items (
  item_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(proposal_id) ON DELETE CASCADE,
  item_order INTEGER NOT NULL CHECK (item_order >= 0),
  change_payload TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
  failure_code TEXT,
  receipt TEXT,
  regeneration_ticket TEXT UNIQUE,
  regeneration_consumed_at TEXT,
  superseded_by_proposal_id TEXT REFERENCES proposals(proposal_id),
  superseded_by_item_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (proposal_id, item_order)
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

/** Canonical JSON used for proposal deduplication and integrity hashing. */
function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).filter(key => record[key] !== undefined).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return 'null'
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Hash model-facing proposal arguments with the store's canonical JSON encoding.
 *
 * @param value Losslessly JSON-serializable tool arguments.
 * @returns SHA-256 digest of the canonical argument encoding.
 */
export function novelProposalArgsHash(value: unknown): string {
  return sha256Hex(canonicalJson(value))
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

function validateProposalRequest(value: NovelProposalRequest): NovelProposalRequest {
  const record = requireExactKeys(value, ['sessionId', 'callId', 'argsHash', 'payload'], 'proposal request')
  const sessionId = requireNonEmptyString(record.sessionId, 'proposal request.sessionId')
  const callId = requireNonEmptyString(record.callId, 'proposal request.callId')
  const argsHash = requireNonEmptyString(record.argsHash, 'proposal request.argsHash')
  if (!/^[a-f0-9]{64}$/.test(argsHash)) {
    throw new NovelStoreError('INVALID_CONTENT', 'proposal request.argsHash must be a SHA-256 digest')
  }
  return { sessionId, callId, argsHash, payload: record.payload }
}

function requireArtifactId(value: unknown, field: string): string {
  const artifactId = requireNonEmptyString(value, field)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(artifactId)) {
    throw new NovelStoreError('INVALID_CONTENT', `${field} is invalid`)
  }
  return artifactId
}

function isAggregateProposalChange(change: NovelProposalChange): change is NovelAggregateProposalChange {
  return 'changeSetId' in change
}

function validateArtifactProposalChange(value: unknown): NovelArtifactProposalChange {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NovelStoreError('INVALID_CONTENT', 'artifact proposal command must be an object')
  }
  const record = value as Record<string, unknown>
  const kind = record.kind
  if (kind === 'artifact/draft') {
    const row = requireExactKeys(record, ['kind', 'artifactId', 'chapter', 'content', 'summary'], 'artifact draft command')
    return {
      kind,
      artifactId: requireArtifactId(row.artifactId, 'artifact draft.artifactId'),
      chapter: requirePositiveInteger(row.chapter, 'artifact draft.chapter'),
      content: requireNonEmptyString(row.content, 'artifact draft.content'),
      summary: requireNonEmptyString(row.summary, 'artifact draft.summary'),
    }
  }
  if (kind === 'artifact/review') {
    const row = requireExactKeys(record, ['kind', 'artifactId', 'chapter', 'parentArtifactId', 'report', 'summary'], 'artifact review command')
    return {
      kind,
      artifactId: requireArtifactId(row.artifactId, 'artifact review.artifactId'),
      chapter: requirePositiveInteger(row.chapter, 'artifact review.chapter'),
      parentArtifactId: requireArtifactId(row.parentArtifactId, 'artifact review.parentArtifactId'),
      report: requireNonEmptyString(row.report, 'artifact review.report'),
      summary: requireNonEmptyString(row.summary, 'artifact review.summary'),
    }
  }
  if (kind === 'artifact/revision') {
    const row = requireExactKeys(record, ['kind', 'artifactId', 'chapter', 'parentArtifactId', 'content', 'summary'], 'artifact revision command')
    return {
      kind,
      artifactId: requireArtifactId(row.artifactId, 'artifact revision.artifactId'),
      chapter: requirePositiveInteger(row.chapter, 'artifact revision.chapter'),
      parentArtifactId: requireArtifactId(row.parentArtifactId, 'artifact revision.parentArtifactId'),
      content: requireNonEmptyString(row.content, 'artifact revision.content'),
      summary: requireNonEmptyString(row.summary, 'artifact revision.summary'),
    }
  }
  if (kind === 'chapter/select-final') {
    const row = requireExactKeys(record, ['kind', 'chapter', 'artifactId', 'summary'], 'chapter final command')
    return {
      kind,
      chapter: requirePositiveInteger(row.chapter, 'chapter final.chapter'),
      artifactId: requireArtifactId(row.artifactId, 'chapter final.artifactId'),
      summary: requireNonEmptyString(row.summary, 'chapter final.summary'),
    }
  }
  throw new NovelStoreError('INVALID_CONTENT', 'artifact proposal command kind is not supported')
}

/**
 * Validate a complete non-authoritative proposal bundle at the durable boundary.
 *
 * @param value Unknown tool payload received by the Host.
 * @returns Validated replacement commands, including internal operation and provenance fields.
 * @throws {@link NovelStoreError} with `INVALID_CONTENT` when the bundle shape or any command is invalid.
 */
interface ValidatedProposalPayload {
  readonly changes: readonly NovelProposalChange[]
  readonly regenerationTicket: string | undefined
}

function validateProposalPayload(value: unknown): ValidatedProposalPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NovelStoreError('INVALID_CONTENT', 'proposal payload must be an object')
  }
  const record = value as Record<string, unknown>
  const allowed = Object.keys(record).sort().join('\0')
  const expected = ['changes', 'regenerationTicket'].filter(key => record[key] !== undefined).sort().join('\0')
  if (allowed !== expected) throw new NovelStoreError('INVALID_CONTENT', 'proposal payload has unsupported fields')
  if (!Array.isArray(record.changes) || record.changes.length === 0) {
    throw new NovelStoreError('INVALID_CONTENT', 'proposal payload changes must be a non-empty array')
  }
  const regenerationTicket = record.regenerationTicket === undefined
    ? undefined
    : requireNonEmptyString(record.regenerationTicket, 'proposal payload.regenerationTicket')
  if (regenerationTicket !== undefined && !isUuid(regenerationTicket)) {
    throw new NovelStoreError('INVALID_CONTENT', 'proposal payload.regenerationTicket is invalid')
  }
  const changeSetIds = new Set<string>()
  const artifactIds = new Set<string>()
  const changes = record.changes.map(change => {
    if (typeof change !== 'object' || change === null || Array.isArray(change)) {
      throw new NovelStoreError('INVALID_CONTENT', 'proposal change must be an object')
    }
    const candidate = change as Record<string, unknown>
    if ('kind' in candidate) {
      const valid = validateArtifactProposalChange(change)
      if (valid.kind !== 'chapter/select-final') {
        if (artifactIds.has(valid.artifactId)) {
          throw new NovelStoreError('INVALID_CONTENT', 'proposal artifactId values must be unique')
        }
        artifactIds.add(valid.artifactId)
      }
      return valid
    }
    const row = requireExactKeys(change, [
      'changeSetId', 'aggregate', 'baseAggregateRevision', 'baseGlobalRevision', 'nextValue',
    ], 'proposal change')
    const valid = validateNovelChangeSet({
      changeSetId: row.changeSetId,
      operation: 'replace',
      aggregate: row.aggregate,
      baseAggregateRevision: row.baseAggregateRevision,
      baseGlobalRevision: row.baseGlobalRevision,
      nextValue: row.nextValue,
      provenance: { origin: 'manual' },
    } as NovelChangeSet)
    if (changeSetIds.has(valid.changeSetId)) {
      throw new NovelStoreError('INVALID_CONTENT', 'proposal changeSetId values must be unique')
    }
    changeSetIds.add(valid.changeSetId)
    return {
      changeSetId: valid.changeSetId,
      aggregate: valid.aggregate,
      baseAggregateRevision: valid.baseAggregateRevision,
      baseGlobalRevision: valid.baseGlobalRevision,
      nextValue: valid.nextValue,
    } as NovelAggregateProposalChange
  })
  if (regenerationTicket !== undefined && changes.length !== 1) {
    throw new NovelStoreError('INVALID_CONTENT', 'a regenerated proposal must contain exactly one item')
  }
  return { changes, regenerationTicket }
}

/** Validate the opaque model proposal payload kept by the persistent inbox. */
export function validateNovelProposalPayload(value: unknown): readonly NovelProposalChange[] {
  return validateProposalPayload(value).changes
}

function storedProposalChange(row: ProposalItemRow): NovelProposalChange {
  const payload = parseJson(row.change_payload, 'proposal item change payload is invalid')
  try {
    return validateProposalPayload({ changes: [payload] }).changes[0]!
  } catch (error) {
    if (error instanceof NovelStoreError) throw new NovelStoreError('UNSUPPORTED_FORMAT', 'proposal item change payload is invalid', { cause: error })
    throw error
  }
}

function parseProposalItem(row: ProposalItemRow, proposal: ProposalRow): NovelProposalItem {
  const itemId = requireNonEmptyString(row.item_id, 'proposal items.itemId')
  if (!isUuid(itemId)) throw new NovelStoreError('UNSUPPORTED_FORMAT', 'proposal items.itemId is invalid')
  if (!Number.isSafeInteger(row.item_order) || row.item_order < 0) {
    throw new NovelStoreError('UNSUPPORTED_FORMAT', 'proposal items.itemOrder is invalid')
  }
  if (!Number.isSafeInteger(row.attempt_count) || row.attempt_count < 0) {
    throw new NovelStoreError('UNSUPPORTED_FORMAT', 'proposal items.attemptCount is invalid')
  }
  const stored = storedProposalChange(row)
  const change: NovelProposalItem['change'] = isAggregateProposalChange(stored)
    ? {
      ...stored,
      operation: 'replace',
      provenance: { origin: 'model', sessionId: proposal.session_id, callId: proposal.call_id, argsHash: proposal.args_hash },
    } as NovelChangeSet
    : stored
  const status = requireEnum(row.status, ['pending', 'stale', 'applied', 'discarded', 'superseded', 'failed'], 'proposal items.status')
  const failure = row.failure_code === null ? undefined
    : requireEnum(row.failure_code, [
      'NOT_INITIALIZED', 'ALREADY_INITIALIZED', 'UNSUPPORTED_FORMAT', 'WORKSPACE_MISMATCH', 'INVALID_CONTENT',
      'PATH_REJECTED', 'STALE_REVISION', 'IDEMPOTENCY_CONFLICT', 'PROPOSAL_TOO_LARGE', 'PROPOSAL_LIMIT_REACHED',
      'PROPOSAL_CONFLICT', 'PROPOSAL_NOT_FOUND', 'PROPOSAL_ITEM_NOT_FOUND', 'PROPOSAL_ITEM_NOT_RETRYABLE',
      'PROPOSAL_ITEM_APPLIED', 'REGENERATION_TICKET_INVALID', 'WRITE_LOCKED', 'WRITE_FAILED', 'CANCELLED',
    ], 'proposal items.failureCode') as NovelStoreErrorCode
  const receipt = row.receipt === null ? undefined : parseProposalReceipt(row.receipt, stored)
  if ((status === 'applied') !== (receipt !== undefined)) {
    throw new NovelStoreError('UNSUPPORTED_FORMAT', 'proposal item application receipt is invalid')
  }
  const ticket = row.regeneration_ticket === null ? undefined : requireTicket(row.regeneration_ticket, 'proposal items.regenerationTicket')
  const supersededByProposalId = row.superseded_by_proposal_id === null ? undefined : requireTicket(row.superseded_by_proposal_id, 'proposal items.supersededByProposalId')
  const supersededByItemId = row.superseded_by_item_id === null ? undefined : requireTicket(row.superseded_by_item_id, 'proposal items.supersededByItemId')
  if ((status === 'superseded') !== (supersededByProposalId !== undefined && supersededByItemId !== undefined)) {
    throw new NovelStoreError('UNSUPPORTED_FORMAT', 'proposal item supersession is invalid')
  }
  return {
    itemId,
    itemOrder: row.item_order,
    change,
    status,
    attemptCount: row.attempt_count,
    ...(failure === undefined ? {} : { failure }),
    ...(receipt === undefined ? {} : { receipt }),
    ...(ticket === undefined ? {} : { regenerationTicket: ticket }),
    ...(supersededByProposalId === undefined ? {} : { supersededByProposalId }),
    ...(supersededByItemId === undefined ? {} : { supersededByItemId }),
  }
}

function parseProposal(row: ProposalRow, items: readonly ProposalItemRow[]): NovelProposalSummary {
  const proposalId = requireNonEmptyString(row.proposal_id, 'proposals.proposal_id')
  if (!isUuid(proposalId)) {
    throw new NovelStoreError('UNSUPPORTED_FORMAT', 'proposals.proposal_id is invalid')
  }
  const sessionId = requireNonEmptyString(row.session_id, 'proposals.sessionId')
  const callId = requireNonEmptyString(row.call_id, 'proposals.callId')
  const argsHash = requireNonEmptyString(row.args_hash, 'proposals.argsHash')
  const canonicalHash = requireNonEmptyString(row.canonical_hash, 'proposals.canonicalHash')
  if (!/^[a-f0-9]{64}$/.test(argsHash) || !/^[a-f0-9]{64}$/.test(canonicalHash)) {
    throw new NovelStoreError('UNSUPPORTED_FORMAT', 'proposal identity hashes are invalid')
  }
  const rawPayload = parseJson(row.payload, 'proposals.payload is invalid')
  let payload: ValidatedProposalPayload
  try {
    payload = validateProposalPayload(rawPayload)
  } catch (error) {
    if (error instanceof NovelStoreError && error.code === 'INVALID_CONTENT') {
      throw new NovelStoreError('UNSUPPORTED_FORMAT', 'proposals.payload is invalid', { cause: error })
    }
    throw error
  }
  const durableCanonicalPayload = canonicalJson(rawPayload)
  if (sha256Hex(durableCanonicalPayload) !== canonicalHash || canonicalHash !== argsHash) {
    throw new NovelStoreError('UNSUPPORTED_FORMAT', 'proposal payload does not match its durable identity hashes')
  }
  const parsedItems = items.map(item => parseProposalItem(item, row))
  if (parsedItems.length !== payload.changes.length
    || parsedItems.some((item, index) => item.itemOrder !== index || canonicalJson(storedProposalChange(items[index]!)) !== canonicalJson(payload.changes[index]))) {
    throw new NovelStoreError('UNSUPPORTED_FORMAT', 'proposal items do not match the durable payload')
  }
  const parentProposalId = row.parent_proposal_id === null ? undefined : requireTicket(row.parent_proposal_id, 'proposals.parentProposalId')
  const parentItemId = row.parent_item_id === null ? undefined : requireTicket(row.parent_item_id, 'proposals.parentItemId')
  if ((parentProposalId === undefined) !== (parentItemId === undefined)) {
    throw new NovelStoreError('UNSUPPORTED_FORMAT', 'proposal parent link is invalid')
  }
  const persistedStatus = requireEnum(row.status, ['pending', 'partial', 'stale', 'applied', 'discarded', 'superseded', 'failed'], 'proposals.status') as NovelProposalStatus
  const derivedStatus = proposalStatusFromItems(parsedItems.map(item => item.status))
  if (persistedStatus !== derivedStatus) {
    throw new NovelStoreError('UNSUPPORTED_FORMAT', 'proposal status does not match durable item statuses')
  }
  return {
    proposalId,
    sessionId,
    callId,
    argsHash,
    status: derivedStatus,
    createdAt: requireIsoTimestamp(row.created_at, 'proposals.createdAt'),
    updatedAt: requireIsoTimestamp(row.updated_at, 'proposals.updatedAt'),
    ...(parentProposalId === undefined ? {} : { parentProposalId }),
    ...(parentItemId === undefined ? {} : { parentItemId }),
    items: parsedItems,
  }
}

/** Stable opaque stand-in used only while a legacy V2 inbox is held read-only before recovery. */
function legacyProposalItemId(proposalId: string, itemOrder: number): string {
  const hash = sha256Hex(`ai-novel-v2-proposal-item:${proposalId}:${itemOrder}`)
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

/** Project an immutable V2 proposal payload without writing the V3 item table before explicit recovery. */
function parseLegacyV2Proposal(row: LegacyProposalRow): NovelProposalSummary {
  const proposal: ProposalRow = { ...row, parent_proposal_id: null, parent_item_id: null }
  const rawPayload = parseJson(row.payload, 'proposals.payload is invalid')
  let payload: ValidatedProposalPayload
  try {
    payload = validateProposalPayload(rawPayload)
  } catch (error) {
    if (error instanceof NovelStoreError && error.code === 'INVALID_CONTENT') {
      throw new NovelStoreError('UNSUPPORTED_FORMAT', 'proposals.payload is invalid', { cause: error })
    }
    throw error
  }
  return parseProposal(proposal, payload.changes.map((change, itemOrder): ProposalItemRow => ({
    item_id: legacyProposalItemId(row.proposal_id, itemOrder),
    proposal_id: row.proposal_id,
    item_order: itemOrder,
    change_payload: stableJson(change),
    status: 'pending',
    attempt_count: 0,
    failure_code: null,
    receipt: null,
    regeneration_ticket: null,
    regeneration_consumed_at: null,
    superseded_by_proposal_id: null,
    superseded_by_item_id: null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  })))
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

function requireTicket(value: unknown, field: string): string {
  const ticket = requireNonEmptyString(value, field)
  if (!isUuid(ticket)) throw new NovelStoreError('UNSUPPORTED_FORMAT', `${field} is invalid`)
  return ticket
}

function parseProposalReceipt(text: string, change: NovelProposalChange): NovelProposalItemReceipt {
  const value = parseJson<unknown>(text, 'proposal item receipt is invalid')
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NovelStoreError('UNSUPPORTED_FORMAT', 'proposal item receipt is invalid')
  }
  if (!isAggregateProposalChange(change)) {
    const record = requireExactKeys(value, ['kind', 'chapter', 'artifactId'], 'artifact proposal item receipt')
    const kind = record.kind
    if (kind !== change.kind
      || requirePositiveInteger(record.chapter, 'artifact proposal item receipt.chapter') !== change.chapter
      || requireArtifactId(record.artifactId, 'artifact proposal item receipt.artifactId') !== change.artifactId) {
      throw new NovelStoreError('UNSUPPORTED_FORMAT', 'artifact proposal item receipt is invalid')
    }
    return { kind: change.kind, chapter: change.chapter, artifactId: change.artifactId }
  }
  const record = requireExactKeys(value, [
    'changeSetId', 'projectId', 'aggregate', 'aggregateRevision', 'globalRevision',
  ], 'proposal item receipt')
  const aggregate = record.aggregate
  if (typeof aggregate !== 'object' || aggregate === null || Array.isArray(aggregate)) {
    throw new NovelStoreError('UNSUPPORTED_FORMAT', 'proposal item receipt.aggregate is invalid')
  }
  const aggregateRecord = aggregate as Record<string, unknown>
  let parsedAggregate: NovelAggregateRef
  if (aggregateRecord.kind === 'chapter' && Object.keys(aggregateRecord).length === 2) {
    parsedAggregate = { kind: 'chapter', chapter: requirePositiveInteger(aggregateRecord.chapter, 'proposal item receipt.aggregate.chapter') }
  } else if (aggregateRecord.kind === 'task' && Object.keys(aggregateRecord).length === 2) {
    parsedAggregate = { kind: 'task', taskId: requireNonEmptyString(aggregateRecord.taskId, 'proposal item receipt.aggregate.taskId') }
  } else if (['project', 'architecture', 'characters'].includes(String(aggregateRecord.kind)) && Object.keys(aggregateRecord).length === 1) {
    parsedAggregate = { kind: aggregateRecord.kind as 'project' | 'architecture' | 'characters' }
  } else {
    throw new NovelStoreError('UNSUPPORTED_FORMAT', 'proposal item receipt.aggregate is invalid')
  }
  return {
    changeSetId: requireNonEmptyString(record.changeSetId, 'proposal item receipt.changeSetId'),
    projectId: requireTicket(record.projectId, 'proposal item receipt.projectId') as NovelProjectId,
    aggregate: parsedAggregate,
    aggregateRevision: requireNonNegativeInteger(record.aggregateRevision, 'proposal item receipt.aggregateRevision'),
    globalRevision: requireNonNegativeInteger(record.globalRevision, 'proposal item receipt.globalRevision'),
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

function parseArtifact(row: ArtifactRow): NovelArtifact {
  const artifactId = requireArtifactId(row.artifact_id, 'artifacts.artifactId')
  const chapter = requirePositiveInteger(row.chapter, 'artifacts.chapter')
  const kind = requireEnum(row.kind, ['draft', 'review', 'revision'], 'artifacts.kind')
  const summary = requireNonEmptyString(row.summary, 'artifacts.summary')
  const createdAt = requireIsoTimestamp(row.created_at, 'artifacts.createdAt')
  if (kind === 'draft') {
    if (row.parent_artifact_id !== null || row.report !== null) {
      throw new NovelStoreError('UNSUPPORTED_FORMAT', 'draft artifact chain is invalid')
    }
    return { artifactId, chapter, kind, content: requireNonEmptyString(row.content, 'artifacts.content'), summary, createdAt }
  }
  const parentArtifactId = row.parent_artifact_id === null
    ? undefined
    : requireArtifactId(row.parent_artifact_id, 'artifacts.parentArtifactId')
  if (parentArtifactId === undefined) throw new NovelStoreError('UNSUPPORTED_FORMAT', 'artifact parent is required')
  if (kind === 'review') {
    return { artifactId, chapter, kind, parentArtifactId, report: requireNonEmptyString(row.report, 'artifacts.report'), summary, createdAt }
  }
  if (row.report !== null) throw new NovelStoreError('UNSUPPORTED_FORMAT', 'revision artifact report is invalid')
  return { artifactId, chapter, kind, parentArtifactId, content: requireNonEmptyString(row.content, 'artifacts.content'), summary, createdAt }
}

function parseChapterFinal(row: ChapterFinalRow): NovelChapterFinal {
  return {
    chapter: requirePositiveInteger(row.chapter, 'chapter finals.chapter'),
    artifactId: requireArtifactId(row.artifact_id, 'chapter finals.artifactId'),
    summary: requireNonEmptyString(row.summary, 'chapter finals.summary'),
    selectedAt: requireIsoTimestamp(row.selected_at, 'chapter finals.selectedAt'),
  }
}

/** Reject a corrupt durable chain before it can be presented as authoritative history. */
function validateArtifactProjection(artifacts: readonly NovelArtifact[], chapterFinals: readonly NovelChapterFinal[]): void {
  const byId = new Map(artifacts.map(artifact => [artifact.artifactId, artifact]))
  for (const artifact of artifacts) {
    if (artifact.kind === 'draft') continue
    const parent = artifact.parentArtifactId === undefined ? undefined : byId.get(artifact.parentArtifactId)
    const expectedKind = artifact.kind === 'review' ? 'draft' : 'review'
    if (parent === undefined || parent.chapter !== artifact.chapter || parent.kind !== expectedKind) {
      throw new NovelStoreError('UNSUPPORTED_FORMAT', 'artifact version chain is invalid')
    }
  }
  for (const final of chapterFinals) {
    const target = byId.get(final.artifactId)
    if (target === undefined || target.chapter !== final.chapter || (target.kind !== 'draft' && target.kind !== 'revision')) {
      throw new NovelStoreError('UNSUPPORTED_FORMAT', 'chapter final selection is invalid')
    }
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
  if (applicationId !== APPLICATION_ID || (userVersion !== USER_VERSION && userVersion !== 3 && (!readOnly || userVersion !== 2)) || foreignKeys !== 1) {
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
      db.prepare("INSERT INTO meta (key, value) VALUES ('project_id', ?), ('workspace_id', ?), ('workspace_path', ?), ('schema_version', '4'), ('attached_at', ?), ('migration_source_fingerprint', ?), ('migration_receipt', ?)")
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
        artifact_id, chapter, kind, parent_artifact_id, content, report, summary, created_at
      ) VALUES (?, ?, 'draft', NULL, ?, NULL, 'Migrated V1 draft.', ?)`)
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

/** Upgrade the durable inbox from the immutable V2 bundle payload to V3 item lifecycle rows. */
function migrateSchemaV2ToV3(db: Database): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec('ALTER TABLE proposals ADD COLUMN parent_proposal_id TEXT')
    db.exec('ALTER TABLE proposals ADD COLUMN parent_item_id TEXT')
    db.exec(`CREATE TABLE proposal_items (
      item_id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL REFERENCES proposals(proposal_id) ON DELETE CASCADE,
      item_order INTEGER NOT NULL CHECK (item_order >= 0),
      change_payload TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
      failure_code TEXT,
      receipt TEXT,
      regeneration_ticket TEXT UNIQUE,
      regeneration_consumed_at TEXT,
      superseded_by_proposal_id TEXT REFERENCES proposals(proposal_id),
      superseded_by_item_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (proposal_id, item_order)
    ) STRICT`)
    const proposals = db.prepare(`SELECT proposal_id, session_id, call_id, args_hash, payload, canonical_hash,
      status, parent_proposal_id, parent_item_id, created_at, updated_at FROM proposals ORDER BY created_at, proposal_id`)
      .all() as unknown as ProposalRow[]
    const insertItem = db.prepare(`INSERT INTO proposal_items (
      item_id, proposal_id, item_order, change_payload, status, attempt_count, failure_code, receipt,
      regeneration_ticket, regeneration_consumed_at, superseded_by_proposal_id, superseded_by_item_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`)
    for (const proposal of proposals) {
      const payload = validateProposalPayload(parseJson(proposal.payload, 'proposals.payload is invalid'))
      if (proposal.status !== 'pending') {
        throw new NovelStoreError('UNSUPPORTED_FORMAT', 'V2 proposal lifecycle state cannot be migrated')
      }
      for (const [itemOrder, change] of payload.changes.entries()) {
        insertItem.run(randomUUID(), proposal.proposal_id, itemOrder, stableJson(change), 'pending', proposal.created_at, proposal.updated_at)
      }
    }
    db.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run()
    db.exec('PRAGMA user_version = 3')
    db.exec('COMMIT')
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    if (error instanceof NovelStoreError) throw error
    throw new NovelStoreError('WRITE_FAILED', 'novel.db V2 to V3 schema migration failed', { cause: error })
  }
}

/** Promote existing V3 artifacts into auditable version-chain records and add final selectors. */
function migrateSchemaV3ToV4(db: Database): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec("ALTER TABLE artifacts ADD COLUMN summary TEXT NOT NULL DEFAULT ''")
    db.prepare("UPDATE artifacts SET summary = 'Migrated V1 draft.' WHERE summary = ''").run()
    db.exec(`CREATE TABLE chapter_finals (
      chapter INTEGER PRIMARY KEY REFERENCES chapters(chapter) ON DELETE CASCADE,
      artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE RESTRICT,
      summary TEXT NOT NULL,
      selected_at TEXT NOT NULL
    ) STRICT`)
    db.prepare("UPDATE meta SET value = '4' WHERE key = 'schema_version'").run()
    db.exec(`PRAGMA user_version = ${USER_VERSION}`)
    db.exec('COMMIT')
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    if (error instanceof NovelStoreError) throw error
    throw new NovelStoreError('WRITE_FAILED', 'novel.db V3 to V4 schema migration failed', { cause: error })
  }
}

/** Migrate every supported durable schema in order; mismatch readers never reach this write path. */
function migrateSchema(db: Database): void {
  let version = Number((db.prepare('PRAGMA user_version').get() as { user_version: unknown }).user_version)
  if (version === USER_VERSION) return
  if (version === 2) {
    migrateSchemaV2ToV3(db)
    version = 3
  }
  if (version === 3) {
    migrateSchemaV3ToV4(db)
    return
  }
  throw new NovelStoreError('UNSUPPORTED_FORMAT', 'novel.db schema version is not supported')
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
  readonly #options: Required<NovelProposalOptions>
  #tail: Promise<unknown> = Promise.resolve()
  #closing = false
  #disposePromise: Promise<void> | undefined

  constructor(db: Database, root: string, workspaceId: WorkspaceIdType, readOnly: boolean, options: Required<NovelProposalOptions>) {
    this.#db = db
    this.#root = root
    this.#workspaceId = workspaceId
    this.#readOnly = readOnly
    this.#options = options
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
        this.#db.prepare("INSERT INTO meta (key, value) VALUES ('project_id', ?), ('workspace_id', ?), ('workspace_path', ?), ('schema_version', '4'), ('attached_at', ?)")
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

  async readChapterContext(chapter: number, signal: AbortSignal): Promise<NovelChapterContext> {
    requireNotAborted(signal)
    requirePositiveInteger(chapter, 'chapter context.chapter')
    return this.#enqueue(() => this.#chapterContext(chapter))
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

  async submitProposal(request: NovelProposalRequest, signal: AbortSignal): Promise<NovelProposalReceipt> {
    requireNotAborted(signal)
    const valid = validateProposalRequest(request)
    const canonicalPayload = canonicalJson(valid.payload)
    const canonicalHash = sha256Hex(canonicalPayload)
    if (valid.argsHash !== canonicalHash) {
      throw new NovelStoreError('INVALID_CONTENT', 'proposal request.argsHash must be the canonical payload SHA-256 digest')
    }
    const payloadText = canonicalPayload
    const payloadBytes = Buffer.byteLength(payloadText, 'utf8')
    if (payloadBytes > this.#options.maxProposalBytes) {
      throw new NovelStoreError('PROPOSAL_TOO_LARGE', 'proposal bundle exceeds the configured byte limit')
    }
    const payload = validateProposalPayload(valid.payload)
    return this.#enqueue(() => {
      this.#requireWritable()
      this.#requireWrittenBinding()
      const existing = this.#db.prepare('SELECT proposal_id FROM proposals WHERE args_hash = ?').get(valid.argsHash) as { proposal_id: string } | undefined
      if (existing !== undefined) {
        const existingRow = this.#proposalRow(existing.proposal_id)
        if (existingRow.canonical_hash !== canonicalHash) {
          throw new NovelStoreError('PROPOSAL_CONFLICT', 'proposal argsHash was already used with different content')
        }
        return { proposal: this.#proposalSummary(existing.proposal_id), duplicate: true }
      }
      const pending = this.#db.prepare("SELECT COUNT(*) AS count FROM proposals WHERE status IN ('pending', 'partial')").get() as { count: number }
      if (pending.count >= this.#options.maxPendingProposals) {
        throw new NovelStoreError('PROPOSAL_LIMIT_REACHED', 'proposal inbox has reached the configured pending limit')
      }
      const now = new Date().toISOString()
      const proposalId = randomUUID()
      this.#db.exec('BEGIN IMMEDIATE')
      try {
        const regenerated = payload.regenerationTicket === undefined
          ? undefined
          : this.#regenerationSource(payload.regenerationTicket)
        if (regenerated !== undefined && regenerated.status !== 'pending' && regenerated.status !== 'stale' && regenerated.status !== 'failed') {
          throw new NovelStoreError('REGENERATION_TICKET_INVALID', 'regeneration ticket does not reference an eligible proposal item')
        }
        this.#db.prepare(`INSERT INTO proposals (
          proposal_id, session_id, call_id, args_hash, payload, canonical_hash, status,
          parent_proposal_id, parent_item_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
          .run(
            proposalId, valid.sessionId, valid.callId, valid.argsHash, payloadText, canonicalHash,
            regenerated?.proposal_id ?? null, regenerated?.item_id ?? null, now, now,
          )
        const insertItem = this.#db.prepare(`INSERT INTO proposal_items (
          item_id, proposal_id, item_order, change_payload, status, attempt_count, failure_code, receipt,
          regeneration_ticket, regeneration_consumed_at, superseded_by_proposal_id, superseded_by_item_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`)
        const itemIds: string[] = []
        for (const [itemOrder, change] of payload.changes.entries()) {
          const itemId = randomUUID()
          itemIds.push(itemId)
          insertItem.run(itemId, proposalId, itemOrder, stableJson(change), now, now)
        }
        if (regenerated !== undefined) {
          this.#db.prepare(`UPDATE proposal_items SET status = 'superseded', regeneration_consumed_at = ?,
            superseded_by_proposal_id = ?, superseded_by_item_id = ?, updated_at = ? WHERE item_id = ?`)
            .run(now, proposalId, itemIds[0], now, regenerated.item_id)
          this.#setProposalStatus(regenerated.proposal_id, now)
        }
        this.#db.exec('COMMIT')
      } catch (error) {
        this.#rollback()
        if (error instanceof NovelStoreError) throw error
        throw new NovelStoreError('WRITE_FAILED', 'proposal inbox write failed', { cause: error })
      }
      return { proposal: this.#proposalSummary(proposalId), duplicate: false }
    })
  }

  async listProposals(signal: AbortSignal): Promise<readonly NovelProposalSummary[]> {
    requireNotAborted(signal)
    return this.#enqueue(() => {
      if (this.#legacyReadOnlyV2()) return this.#legacyV2Proposals()
      const rows = this.#db.prepare('SELECT proposal_id FROM proposals ORDER BY created_at, proposal_id').all() as Array<{ proposal_id: string }>
      return rows.map(row => this.#proposalSummary(row.proposal_id))
    })
  }

  async applyProposal(proposalId: string, signal: AbortSignal): Promise<NovelProposalApplyResult> {
    requireNotAborted(signal)
    return this.#enqueue(() => {
      this.#requireWritable()
      this.#requireWrittenBinding()
      return this.#applyProposal(proposalId, signal)
    })
  }

  async retryProposalItem(proposalId: string, itemId: string, signal: AbortSignal): Promise<NovelProposalApplyResult> {
    requireNotAborted(signal)
    return this.#enqueue(() => {
      this.#requireWritable()
      const item = this.#proposalItem(proposalId, itemId)
      if (item.status !== 'failed' || item.failure_code === null || !isRetryableFailure(item.failure_code)) {
        throw new NovelStoreError('PROPOSAL_ITEM_NOT_RETRYABLE', 'proposal item is not retryable')
      }
      const now = new Date().toISOString()
      this.#db.exec('BEGIN IMMEDIATE')
      try {
        this.#db.prepare("UPDATE proposal_items SET status = 'pending', failure_code = NULL, updated_at = ? WHERE item_id = ?").run(now, itemId)
        this.#setProposalStatus(proposalId, now)
        this.#db.exec('COMMIT')
      } catch (error) {
        this.#rollback()
        throw error
      }
      return this.#applyProposal(proposalId, signal)
    })
  }

  async discardProposalItem(proposalId: string, itemId: string, signal: AbortSignal): Promise<NovelProposalItemMutationResult> {
    requireNotAborted(signal)
    return this.#enqueue(() => {
      this.#requireWritable()
      const item = this.#proposalItem(proposalId, itemId)
      if (item.status === 'applied') throw new NovelStoreError('PROPOSAL_ITEM_APPLIED', 'applied proposal items cannot be discarded')
      if (item.status === 'superseded') throw new NovelStoreError('INVALID_CONTENT', 'superseded proposal items cannot be discarded')
      const now = new Date().toISOString()
      this.#db.exec('BEGIN IMMEDIATE')
      try {
        this.#db.prepare("UPDATE proposal_items SET status = 'discarded', updated_at = ? WHERE item_id = ?").run(now, itemId)
        this.#setProposalStatus(proposalId, now)
        this.#db.exec('COMMIT')
      } catch (error) {
        this.#rollback()
        throw error
      }
      const proposal = this.#proposalSummary(proposalId)
      return { proposal, item: proposal.items.find(candidate => candidate.itemId === itemId)! }
    })
  }

  async requestProposalRegeneration(proposalId: string, itemId: string, signal: AbortSignal): Promise<NovelProposalRegenerationResult> {
    requireNotAborted(signal)
    return this.#enqueue(() => {
      this.#requireWritable()
      const item = this.#proposalItem(proposalId, itemId)
      if (item.status === 'applied' || item.status === 'discarded' || item.status === 'superseded') {
        throw new NovelStoreError('PROPOSAL_ITEM_APPLIED', 'proposal item cannot be regenerated in its current state')
      }
      const ticket = item.regeneration_ticket ?? randomUUID()
      if (item.regeneration_ticket === null) {
        this.#db.prepare('UPDATE proposal_items SET regeneration_ticket = ?, updated_at = ? WHERE item_id = ?')
          .run(ticket, new Date().toISOString(), itemId)
      }
      const proposal = this.#proposalSummary(proposalId)
      return { proposal, item: proposal.items.find(candidate => candidate.itemId === itemId)!, regenerationTicket: ticket }
    })
  }

  #proposalRow(proposalId: string): ProposalRow {
    if (!isUuid(proposalId)) throw new NovelStoreError('PROPOSAL_NOT_FOUND', 'proposal id is invalid')
    const row = this.#db.prepare(`SELECT proposal_id, session_id, call_id, args_hash, payload, canonical_hash,
      status, parent_proposal_id, parent_item_id, created_at, updated_at FROM proposals WHERE proposal_id = ?`)
      .get(proposalId) as ProposalRow | undefined
    if (row === undefined) throw new NovelStoreError('PROPOSAL_NOT_FOUND', 'proposal was not found')
    return row
  }

  #proposalItems(proposalId: string): readonly ProposalItemRow[] {
    return this.#db.prepare(`SELECT item_id, proposal_id, item_order, change_payload, status, attempt_count,
      failure_code, receipt, regeneration_ticket, regeneration_consumed_at, superseded_by_proposal_id,
      superseded_by_item_id, created_at, updated_at FROM proposal_items WHERE proposal_id = ? ORDER BY item_order`)
      .all(proposalId) as unknown as ProposalItemRow[]
  }

  #proposalItem(proposalId: string, itemId: string): ProposalItemRow {
    this.#proposalRow(proposalId)
    if (!isUuid(itemId)) throw new NovelStoreError('PROPOSAL_ITEM_NOT_FOUND', 'proposal item id is invalid')
    const item = this.#proposalItems(proposalId).find(candidate => candidate.item_id === itemId)
    if (item === undefined) throw new NovelStoreError('PROPOSAL_ITEM_NOT_FOUND', 'proposal item was not found')
    return item
  }

  #proposalSummary(proposalId: string): NovelProposalSummary {
    return parseProposal(this.#proposalRow(proposalId), this.#proposalItems(proposalId))
  }

  #legacyReadOnlyV2(): boolean {
    return this.#readOnly && Number((this.#db.prepare('PRAGMA user_version').get() as { user_version: unknown }).user_version) === 2
  }

  #legacyReadOnlyArtifactSchema(): boolean {
    const version = Number((this.#db.prepare('PRAGMA user_version').get() as { user_version: unknown }).user_version)
    return this.#readOnly && version < USER_VERSION
  }

  #legacyV2Proposals(): readonly NovelProposalSummary[] {
    const rows = this.#db.prepare(`SELECT proposal_id, session_id, call_id, args_hash, payload, canonical_hash,
      status, created_at, updated_at FROM proposals ORDER BY created_at, proposal_id`).all() as unknown as LegacyProposalRow[]
    return rows.map(parseLegacyV2Proposal)
  }

  #regenerationSource(ticket: string): ProposalItemRow {
    const item = this.#db.prepare(`SELECT item_id, proposal_id, item_order, change_payload, status, attempt_count,
      failure_code, receipt, regeneration_ticket, regeneration_consumed_at, superseded_by_proposal_id,
      superseded_by_item_id, created_at, updated_at FROM proposal_items WHERE regeneration_ticket = ?`)
      .get(ticket) as ProposalItemRow | undefined
    if (item === undefined || item.regeneration_consumed_at !== null) {
      throw new NovelStoreError('REGENERATION_TICKET_INVALID', 'regeneration ticket is unknown or already consumed')
    }
    return item
  }

  #setProposalStatus(proposalId: string, now: string): void {
    const next = proposalStatusFromItems(this.#proposalItems(proposalId).map(item => item.status as NovelProposalItemStatus))
    this.#db.prepare('UPDATE proposals SET status = ?, updated_at = ? WHERE proposal_id = ?').run(next, now, proposalId)
  }

  #proposalCommand(item: ProposalItemRow, proposal: ProposalRow): NovelProposalItem['change'] {
    return parseProposalItem(item, proposal).change
  }

  #artifactRow(artifactId: string): ArtifactRow {
    const row = this.#db.prepare(`SELECT artifact_id, chapter, kind, parent_artifact_id, content, report, summary,
      created_at FROM artifacts WHERE artifact_id = ?`).get(artifactId) as ArtifactRow | undefined
    if (row === undefined) throw new NovelStoreError('INVALID_CONTENT', 'artifact parent or final target was not found')
    return row
  }

  #requireChapter(chapter: number): void {
    if (this.#db.prepare('SELECT 1 AS present FROM chapters WHERE chapter = ?').get(chapter) === undefined) {
      throw new NovelStoreError('INVALID_CONTENT', 'artifact references an unknown chapter blueprint')
    }
  }

  /** Commit a closed artifact command and its non-empty summary inside the caller transaction. */
  #commitArtifactCommandInTransaction(change: NovelArtifactProposalChange): NovelProposalItemReceipt {
    this.#requireWrittenBinding()
    this.#requireChapter(change.chapter)
    const now = new Date().toISOString()
    if (change.kind === 'chapter/select-final') {
      const target = parseArtifact(this.#artifactRow(change.artifactId))
      if (target.chapter !== change.chapter || (target.kind !== 'draft' && target.kind !== 'revision')) {
        throw new NovelStoreError('INVALID_CONTENT', 'chapter final must select a prose artifact from the same chapter')
      }
      this.#db.prepare(`INSERT INTO chapter_finals (chapter, artifact_id, summary, selected_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(chapter) DO UPDATE SET artifact_id = excluded.artifact_id, summary = excluded.summary,
        selected_at = excluded.selected_at`).run(change.chapter, change.artifactId, change.summary, now)
      return { kind: change.kind, chapter: change.chapter, artifactId: change.artifactId }
    }
    const existing = this.#db.prepare('SELECT 1 AS present FROM artifacts WHERE artifact_id = ?').get(change.artifactId)
    if (existing !== undefined) throw new NovelStoreError('IDEMPOTENCY_CONFLICT', 'artifactId was already used')
    if (change.kind === 'artifact/draft') {
      this.#db.prepare(`INSERT INTO artifacts (
        artifact_id, chapter, kind, parent_artifact_id, content, report, summary, created_at
      ) VALUES (?, ?, 'draft', NULL, ?, NULL, ?, ?)`).run(
        change.artifactId, change.chapter, change.content, change.summary, now,
      )
      return { kind: change.kind, chapter: change.chapter, artifactId: change.artifactId }
    }
    const parent = parseArtifact(this.#artifactRow(change.parentArtifactId))
    const expectedParentKind = change.kind === 'artifact/review' ? 'draft' : 'review'
    if (parent.chapter !== change.chapter || parent.kind !== expectedParentKind) {
      throw new NovelStoreError('INVALID_CONTENT', `${change.kind} must reference a same-chapter ${expectedParentKind}`)
    }
    if (change.kind === 'artifact/review') {
      this.#db.prepare(`INSERT INTO artifacts (
        artifact_id, chapter, kind, parent_artifact_id, content, report, summary, created_at
      ) VALUES (?, ?, 'review', ?, '', ?, ?, ?)`).run(
        change.artifactId, change.chapter, change.parentArtifactId, change.report, change.summary, now,
      )
    } else {
      this.#db.prepare(`INSERT INTO artifacts (
        artifact_id, chapter, kind, parent_artifact_id, content, report, summary, created_at
      ) VALUES (?, ?, 'revision', ?, ?, NULL, ?, ?)`).run(
        change.artifactId, change.chapter, change.parentArtifactId, change.content, change.summary, now,
      )
    }
    return { kind: change.kind, chapter: change.chapter, artifactId: change.artifactId }
  }

  #applyProposal(proposalId: string, signal: AbortSignal): NovelProposalApplyResult {
    const proposal = this.#proposalRow(proposalId)
    const appliedItemIds: string[] = []
    for (const item of this.#proposalItems(proposalId)) {
      if (item.status === 'applied' || item.status === 'discarded' || item.status === 'superseded') continue
      if (item.status !== 'pending') {
        return { proposal: this.#proposalSummary(proposalId), appliedItemIds, stoppedItemId: item.item_id }
      }
      requireNotAborted(signal)
      try {
        this.#db.exec('BEGIN IMMEDIATE')
        const command = this.#proposalCommand(item, proposal)
        const receipt = isAggregateProposalChange(command)
          ? this.#existingChange({
            ...command,
            operation: 'replace',
            provenance: { origin: 'model', sessionId: proposal.session_id, callId: proposal.call_id, argsHash: proposal.args_hash },
          } as NovelChangeSet) ?? this.#commitChangeInTransaction({
            ...command,
            operation: 'replace',
            provenance: { origin: 'model', sessionId: proposal.session_id, callId: proposal.call_id, argsHash: proposal.args_hash },
          } as NovelChangeSet)
          : this.#commitArtifactCommandInTransaction(command)
        const now = new Date().toISOString()
        this.#db.prepare(`UPDATE proposal_items SET status = 'applied', attempt_count = attempt_count + 1,
          failure_code = NULL, receipt = ?, updated_at = ? WHERE item_id = ?`)
          .run(stableJson(receipt), now, item.item_id)
        this.#setProposalStatus(proposalId, now)
        this.#db.exec('COMMIT')
        appliedItemIds.push(item.item_id)
      } catch (error) {
        this.#rollback()
        if (error instanceof NovelStoreError && error.code === 'CANCELLED') throw error
        const code: NovelStoreErrorCode = error instanceof NovelStoreError ? error.code : 'WRITE_FAILED'
        const status: NovelProposalItemStatus = code === 'STALE_REVISION' ? 'stale' : 'failed'
        const now = new Date().toISOString()
        this.#db.exec('BEGIN IMMEDIATE')
        try {
          this.#db.prepare(`UPDATE proposal_items SET status = ?, attempt_count = attempt_count + 1,
            failure_code = ?, updated_at = ? WHERE item_id = ?`).run(status, code, now, item.item_id)
          this.#setProposalStatus(proposalId, now)
          this.#db.exec('COMMIT')
        } catch (recordFailure) {
          this.#rollback()
          if (recordFailure instanceof NovelStoreError) throw recordFailure
          throw new NovelStoreError('WRITE_FAILED', 'proposal item failure could not be recorded', { cause: recordFailure })
        }
        return { proposal: this.#proposalSummary(proposalId), appliedItemIds, stoppedItemId: item.item_id }
      }
    }
    return { proposal: this.#proposalSummary(proposalId), appliedItemIds }
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

  #chapterContext(chapter: number): NovelChapterContext {
    this.#db.exec('BEGIN')
    try {
      this.#requireWrittenBinding()
      if (chapter <= 1 || this.#legacyReadOnlyArtifactSchema()) {
        this.#db.exec('COMMIT')
        return { chapter }
      }
      const row = this.#db.prepare(`SELECT a.artifact_id, a.chapter, a.kind, a.parent_artifact_id, a.content,
        a.report, a.summary, a.created_at, f.summary AS final_summary
        FROM chapter_finals f JOIN artifacts a ON a.artifact_id = f.artifact_id WHERE f.chapter = ?`)
        .get(chapter - 1) as (ArtifactRow & { readonly final_summary: string }) | undefined
      if (row === undefined) {
        this.#db.exec('COMMIT')
        return { chapter }
      }
      const artifact = parseArtifact(row)
      if (artifact.chapter !== chapter - 1 || (artifact.kind !== 'draft' && artifact.kind !== 'revision') || artifact.content === undefined) {
        throw new NovelStoreError('UNSUPPORTED_FORMAT', 'chapter final does not reference readable prose')
      }
      const summary = requireNonEmptyString(row.final_summary, 'chapter final summary')
      this.#db.exec('COMMIT')
      return {
        chapter,
        previousFinal: { chapter: artifact.chapter, artifactId: artifact.artifactId, content: artifact.content, summary },
      }
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
    const legacyArtifactSchema = this.#legacyReadOnlyArtifactSchema()
    const artifactRows = (legacyArtifactSchema
      ? this.#db.prepare(`SELECT artifact_id, chapter, kind, parent_artifact_id, content, report,
          'Migrated V1 draft.' AS summary, created_at FROM artifacts ORDER BY created_at, artifact_id`).all()
      : this.#db.prepare(`SELECT artifact_id, chapter, kind, parent_artifact_id, content, report, summary,
          created_at FROM artifacts ORDER BY created_at, artifact_id`).all()) as unknown as ArtifactRow[]
    const chapterFinalRows = legacyArtifactSchema
      ? []
      : this.#db.prepare(`SELECT chapter, artifact_id, summary, selected_at FROM chapter_finals ORDER BY chapter`)
        .all() as unknown as ChapterFinalRow[]
    const artifacts = artifactRows.map(parseArtifact)
    const chapterFinals = chapterFinalRows.map(parseChapterFinal)
    validateArtifactProjection(artifacts, chapterFinals)
    const taskRows = this.#db.prepare(`SELECT task_id, kind, stage, status, failure, resume_cursor, revision,
      created_at, updated_at FROM tasks ORDER BY task_id`).all() as unknown as TaskRow[]
    const changeRows = this.#db.prepare(`SELECT change_set_id, aggregate_kind, aggregate_id, aggregate_key, operation,
      base_aggregate_revision, base_global_revision, result_aggregate_revision, result_global_revision, status, provenance
      FROM changes ORDER BY committed_at, change_set_id`).all() as unknown as ChangeRow[]
    const legacyReadOnlyV2 = this.#legacyReadOnlyV2()
    const proposalRows = legacyReadOnlyV2 ? [] : this.#db.prepare(`SELECT proposal_id, session_id, call_id, args_hash, payload, canonical_hash,
      status, parent_proposal_id, parent_item_id, created_at, updated_at FROM proposals ORDER BY created_at, proposal_id`).all() as unknown as ProposalRow[]
    const proposalItemRows = legacyReadOnlyV2 ? [] : this.#db.prepare(`SELECT item_id, proposal_id, item_order, change_payload, status, attempt_count,
      failure_code, receipt, regeneration_ticket, regeneration_consumed_at, superseded_by_proposal_id,
      superseded_by_item_id, created_at, updated_at FROM proposal_items ORDER BY proposal_id, item_order`).all() as unknown as ProposalItemRow[]
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
      artifacts,
      chapterFinals,
      tasks: taskRows.map(parseTask),
      changes: changeRows.map(parseChange),
      proposals: legacyReadOnlyV2 ? this.#legacyV2Proposals() : proposalRows.map(row => parseProposal(row, proposalItemRows.filter(item => item.proposal_id === row.proposal_id))),
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
      const receipt = this.#commitChangeInTransaction(change)
      this.#db.exec('COMMIT')
      return receipt
    } catch (error) {
      this.#rollback()
      if (error instanceof NovelStoreError) throw error
      throw new NovelStoreError('WRITE_FAILED', 'novel ChangeSet failed', { cause: error })
    }
  }

  /** Apply a checked replacement inside the caller's already-open SQLite transaction. */
  #commitChangeInTransaction(change: NovelChangeSet): NovelChangeReceipt {
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
      return {
        changeSetId: change.changeSetId,
        projectId: this.#requireWrittenBinding().projectId as NovelProjectId,
        aggregate: change.aggregate,
        aggregateRevision: nextRevision,
        globalRevision: nextGlobal,
      }
  }

  #rollback(): void {
    if (this.#db.isTransaction) this.#db.exec('ROLLBACK')
  }
}

function requireNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new NovelStoreError('CANCELLED', 'novel store operation was cancelled')
}

function isRetryableFailure(code: string): boolean {
  return code === 'WRITE_LOCKED' || code === 'WRITE_FAILED' || code === 'CANCELLED'
}

function requireRecoveryMode(mode: NovelStoreRecoveryMode): NovelStoreRecoveryMode {
  if (mode !== 'reattach' && mode !== 'clone') {
    throw new NovelStoreError('INVALID_CONTENT', 'novel store recovery mode is not supported')
  }
  return mode
}

/**
 * Explicitly replace a moved database's workspace binding, or clone its project identity.
 *
 * This recovery seam never runs while opening a normal store: a binding mismatch remains
 * read-only until a Host-selected recovery mode reaches this function. `clone` preserves every
 * aggregate and audit row while assigning a new project identity to the copied database.
 *
 * @param root Canonical workspace directory currently containing the copied or moved artifact.
 * @param workspaceId Opaque current Workspace identity resolved by the Host.
 * @param mode `reattach` retains the project identity; `clone` generates a new project identity.
 * @param signal Cancellation signal checked before any recovery write.
 * @returns Path-free recovery evidence for the Host RPC projection.
 */
export async function recoverNovelStoreBinding(
  root: string,
  workspaceId: WorkspaceIdType,
  mode: NovelStoreRecoveryMode,
  signal: AbortSignal,
): Promise<NovelStoreRecoveryReceipt> {
  requireNotAborted(signal)
  const recovery = requireRecoveryMode(mode)
  if (!isAbsolute(root)) {
    throw new NovelStoreError('PATH_REJECTED', 'workspace root must be absolute')
  }
  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(root)
  } catch (cause) {
    throw new NovelStoreError('PATH_REJECTED', 'workspace root does not exist', { cause })
  }
  await ensureProjectDirectory(canonicalRoot, false)
  const databasePath = join(canonicalRoot, '.ai-novel', 'novel.db')
  try {
    const databaseFile = await lstat(databasePath)
    if (!databaseFile.isFile() || databaseFile.isSymbolicLink()) {
      throw new NovelStoreError('PATH_REJECTED', '.ai-novel/novel.db must be a real file')
    }
  } catch (error) {
    if (error instanceof NovelStoreError) throw error
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      throw new NovelStoreError('NOT_INITIALIZED', 'novel project is not initialized')
    }
    throw error
  }

  const sqlite = await import('node:sqlite')
  const db = new sqlite.DatabaseSync(databasePath)
  try {
    configureWriteConnection(db)
    migrateSchema(db)
    requireStorage(db, false)
    acquireExclusiveLock(db)
    const binding = readMetaBinding(db)
    if (binding === undefined || !hasProjectAggregate(db)) {
      throw new NovelStoreError('NOT_INITIALIZED', 'novel project is not initialized')
    }
    if (binding.workspaceId === workspaceId && binding.workspacePath === canonicalRoot) {
      throw new NovelStoreError('WORKSPACE_MISMATCH', 'novel project is already attached to this workspace')
    }
    const projectId = recovery === 'clone' ? randomUUID() as NovelProjectId : binding.projectId as NovelProjectId
    const attachedAt = new Date().toISOString()
    db.exec('BEGIN IMMEDIATE')
    try {
      const updateMeta = db.prepare('UPDATE meta SET value = ? WHERE key = ?')
      updateMeta.run(projectId, 'project_id')
      updateMeta.run(workspaceId, 'workspace_id')
      updateMeta.run(canonicalRoot, 'workspace_path')
      updateMeta.run(attachedAt, 'attached_at')
      if (recovery === 'clone') {
        const row = db.prepare("SELECT value FROM meta WHERE key = 'migration_receipt'").get() as { value: string } | undefined
        if (row !== undefined) {
          const receipt = validateMigrationReceipt(parseJson(row.value, 'migration receipt is invalid'))
          updateMeta.run(stableJson({ ...receipt, projectId }), 'migration_receipt')
        }
        const proposalReceipts = db.prepare("SELECT item_id, receipt, change_payload FROM proposal_items WHERE receipt IS NOT NULL")
          .all() as Array<{ item_id: string; receipt: string; change_payload: string }>
        const updateProposalReceipt = db.prepare('UPDATE proposal_items SET receipt = ? WHERE item_id = ?')
        for (const item of proposalReceipts) {
          const change = validateProposalPayload({ changes: [parseJson(item.change_payload, 'proposal item change payload is invalid')] }).changes[0]!
          const receipt = parseProposalReceipt(item.receipt, change)
          if ('changeSetId' in receipt) updateProposalReceipt.run(stableJson({ ...receipt, projectId }), item.item_id)
        }
      }
      db.exec('COMMIT')
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK')
      if (error instanceof NovelStoreError) throw error
      throw new NovelStoreError('WRITE_FAILED', 'novel workspace recovery failed', { cause: error })
    }
    return { mode: recovery, projectId, workspaceId }
  } catch (error) {
    if (error instanceof NovelStoreError) throw error
    throw new NovelStoreError('WRITE_LOCKED', 'novel.db is locked by another writer or cannot be recovered', { cause: error })
  } finally {
    if (db.isOpen) db.close()
  }
}

/** Options controlling whether opening a store may create its on-disk artifact. */
export interface NovelStoreOpenOptions {
  /**
   * When false, a missing `.ai-novel` or `novel.db` fails with `NOT_INITIALIZED` and creates
   * nothing on disk. Defaults to true, preserving the initialization path.
   */
  readonly create?: boolean
  /** Maximum UTF-8 byte size accepted for one proposal bundle. */
  readonly maxProposalBytes?: number
  /** Maximum number of unresolved (pending or resumable partial) proposals in the inbox. */
  readonly maxPendingProposals?: number
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
  const proposalOptions: Required<NovelProposalOptions> = {
    maxProposalBytes: options.maxProposalBytes ?? 2 * 1024 * 1024,
    maxPendingProposals: options.maxPendingProposals ?? 20,
  }
  requirePositiveInteger(proposalOptions.maxProposalBytes, 'maxProposalBytes')
  requirePositiveInteger(proposalOptions.maxPendingProposals, 'maxPendingProposals')
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
      return new SqliteNovelStore(db, canonicalRoot, workspaceId, false, proposalOptions)
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
      return new SqliteNovelStore(db, canonicalRoot, workspaceId, true, proposalOptions)
    } catch (error) {
      if (db.isOpen) db.close()
      throw error
    }
  }

  const openReadWriteStore = (): NovelStore => {
    const db = new sqlite.DatabaseSync(databasePath)
    try {
      configureWriteConnection(db)
      migrateSchema(db)
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
      return new SqliteNovelStore(db, canonicalRoot, workspaceId, false, proposalOptions)
    } catch (error) {
      if (db.isOpen) db.close()
      throw error
    }
  }

  let diagnostic: Database | undefined
  try {
    diagnostic = new sqlite.DatabaseSync(databasePath, { readOnly: true })
    configureReadConnection(diagnostic)
    const schemaVersion = Number((diagnostic.prepare('PRAGMA user_version').get() as { user_version: unknown }).user_version)
    if (schemaVersion === 2) {
      const binding = readMetaBinding(diagnostic)
      diagnostic.close()
      if (binding === undefined || binding.workspaceId !== workspaceId || binding.workspacePath !== canonicalRoot) {
        return openReadOnlyStore()
      }
      return openReadWriteStore()
    }
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
