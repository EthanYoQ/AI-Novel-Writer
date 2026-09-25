import fs, { createReadStream } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

import type { ProjectSessionContext } from '../../src/shared/ipc-channels'
import {
  CANONICAL_PROJECT_DATABASE,
  CANONICAL_PROJECT_DIRECTORY,
  parseCanonicalProjectManifest,
} from '../../src/shared/project-format'
import { readPortableCharacterAvatarRows } from '../repositories/character-asset-repository'
import {
  PORTABLE_FIELD_POLICY_COUNTS,
  PORTABLE_PROJECT_FORMAT_VERSION,
  PORTABLE_SOURCE_SCHEMA_VERSION,
  assertPortableSourceSchema,
  getPortableFieldPolicy,
  listPortableFieldPolicyKeys,
  portablePathKey,
  type PortableEntryDisposition,
  type PortableOmissionReason,
  type PortableProjectManifest,
  type PortableProjectManifestEntry,
} from './portable-project-format'
import {
  PortableProjectArchiveError,
  writePortableProjectArchive,
  type PortableArchiveSource,
} from './portable-project-archive'
import { backupProjectSqlite, type ProjectSqliteEvidence } from './sqlite-project-migration'
import {
  PORTABLE_TRANSFER_AUTHORITY_PATH,
  createPortableTransferAuthority,
  serializePortableTransferAuthority,
} from './portable-transfer-authority'

const require = createRequire(import.meta.url)
const BetterSqlite = require('better-sqlite3') as typeof import('better-sqlite3')
const HASH = /^[a-f0-9]{64}$/u
const SAFE_ID = /^[\p{L}\p{N}._:@+-]{1,512}$/u
const SAFE_CODE = /^[a-z][a-z0-9_.-]{0,63}$/u
const PROVIDED_DISPOSITIONS = new Set<PortableEntryDisposition>([
  'author-content', 'knowledge-source', 'prompt', 'skill', 'transfer-receipt', 'history-projection',
])
const JSON_NEUTRAL = new Set([
  'blueprint_character_sync_operations.character_sync_input',
  'blueprint_character_sync_operations.completion_receipt',
  'blueprint_commit_operations.character_sync_input',
  'character_identity_approvals.receipt_json',
  'character_relationships.provenance_json',
  'finalized_draft_import_operations.receipt_json',
  'generation_attempts.attempt_json',
  'generation_attempts.usage_receipt_json',
  'generation_roots.action_json',
  'generation_roots.budget_json',
  'generation_runs.binding_json',
  'import_global_fact_operations.receipt_json',
  'import_run_receipts.payload_json',
  'import_run_receipts.effect_receipt_json',
])
const REQUIRED_JSON_PROJECTORS = new Set([
  'drafts.source_dependencies',
  'generation_artifacts.artifact_json',
  'generation_attempts.attempt_json',
  'generation_roots.action_json',
  'generation_roots.budget_json',
  'import_run_sources.display_json',
  'import_runs.source_display_json',
  'recovery_candidates.source_snapshot',
])
const REVIEW_FINGERPRINT_FIELDS = [
  'chapterBriefHash', 'authorGuidanceHash', 'dependencyHash', 'contextSnapshotHash', 'templateHash',
  'skillSnapshotHash', 'modelLeaseRevision', 'policyHash', 'outputContractHash',
] as const
const REVIEW_CONTEXT_FIELDS = [
  'version', 'operation', 'source', 'sourceHash', 'config', 'writingLanguage', 'uiLocale', 'authorInputs',
  'characterStates', 'worldbuilding', 'history', 'blueprints', 'frozenGoals', 'preflightFindings',
  'confirmation', 'recheck',
] as const
const HISTORY_ID_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  blueprint_character_sync_operations: ['operation_id'],
  blueprint_commit_operations: ['operation_id'],
  chapter_deletion_operations: ['operation_id'],
  character_identity_approvals: ['operation_id'],
  character_relationships: ['relationship_id'],
  drafts: ['id'],
  finalization_outbox: ['finalization_id'],
  finalized_draft_import_operations: ['operation_id'],
  generation_artifacts: ['artifact_id'],
  generation_attempts: ['attempt_id'],
  generation_roots: ['root_action_id'],
  generation_runs: ['run_id'],
  import_effect_ledger: ['run_id', 'stage', 'batch_id'],
  import_global_fact_operations: ['operation_id'],
  import_run_receipts: ['run_id', 'stage', 'batch_id'],
  import_run_sources: ['run_id', 'source_id'],
  import_runs: ['id'],
  llm_calls: ['id'],
  post_process_runs: ['id'],
  post_process_steps: ['id'],
  recovery_candidates: ['candidate_id'],
  review_cycles: ['cycle_id'],
  review_findings: ['cycle_id', 'finding_id'],
})
const HISTORY_STATE_COLUMNS = [
  'status', 'state', 'publication_status', 'manuscript_status', 'knowledge_status', 'revision_status',
] as const

export type ProjectArchiveServiceErrorCode =
  | 'PORTABLE_ASSET_MISSING'
  | 'PORTABLE_ASSET_UNSAFE'
  | 'PORTABLE_CONTEXT_INVALID'
  | 'PORTABLE_SOURCE_CHANGED'
  | 'PORTABLE_TARGET_INSIDE_SOURCE'
  | 'PORTABLE_UNSAFE_PROJECTION'

export class ProjectArchiveServiceError extends Error {
  constructor(readonly code: ProjectArchiveServiceErrorCode) {
    super(code)
    this.name = 'ProjectArchiveServiceError'
  }
}

export interface PortableProvidedFile {
  id: string
  archivePath: string
  /** Empty only for provider-generated immutable bytes. */
  sourcePath: string
  bytes?: Buffer
  byteSize: number
  sha256: string
  disposition: Exclude<PortableEntryDisposition, 'portable-database' | 'avatar-asset'>
}

export interface PortableAssetSnapshot {
  files: readonly PortableProvidedFile[]
  semanticCounts?: Readonly<Record<string, number>>
  omittedItems?: readonly { id: string; reason: PortableOmissionReason }[]
  transferReceiptIds?: readonly string[]
  historyProjectionIds?: readonly string[]
  verifyUnchanged(): boolean | void | Promise<boolean | void>
}

export interface PortableAssetProvider {
  snapshot(input: {
    sourceProjectRoot: string
    sourceDatabasePath: string
    projectSession: Readonly<ProjectSessionContext>
    snapshotGeneration: string
  }): PortableAssetSnapshot | Promise<PortableAssetSnapshot>
}

export interface ExportPortableProjectInput {
  sourceProjectRoot: string
  projectSession: ProjectSessionContext
  targetArchivePath: string
  attemptParentPath: string
  assertCurrentContext(context: Readonly<ProjectSessionContext>, sourceProjectRoot: string): boolean | void | Promise<boolean | void>
  assets: PortableAssetProvider
  now?: () => Date
  snapshotGeneration?: string
  /** @internal Deterministic mutation/failure injection. */
  __testHooks?: {
    afterPortableDatabaseCreated?(attemptRoot: string): void
    afterArchiveBuilt?(stagedArchivePath: string): void
  }
}

export interface ExportPortableProjectReceipt {
  originProjectId: string
  snapshotGeneration: string
  targetSha256: string
  targetByteSize: number
  sourceEvidence: {
    schemaVersion: number
    schemaFingerprint: string
    tableCount: number
    fieldCount: number
  }
  entryCount: number
  requiresRuntimeFreezeGuard: true
}

interface HistoryProjection {
  projectionId: string
  table: string
  recordId: string
  terminalState: string
  projection: Record<string, unknown>
  projectionHash: string
  excludedFields: string[]
  nonReplayable: true
  originalReceiptVerified: false
}

interface OwnedAttempt {
  root: string
  rootIdentity: fs.BigIntStats
  files: Map<string, fs.BigIntStats>
}

function fail(code: ProjectArchiveServiceErrorCode): never {
  throw new ProjectArchiveServiceError(code)
}

function quote(value: string): string { return `"${value.replaceAll('"', '""')}"` }

function normalizedPath(value: string): string {
  const resolved = path.resolve(value).replace(/^\\\\\?\\/u, '')
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function normalizedContained(root: string, candidate: string): boolean {
  return contained(normalizedPath(root), normalizedPath(candidate))
}

function sameObject(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function safeDirectory(directory: string): void {
  const absolute = path.resolve(directory)
  let cursor = path.parse(absolute).root
  for (const segment of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment)
    let info: fs.Stats
    try { info = fs.lstatSync(cursor) } catch { return fail('PORTABLE_ASSET_UNSAFE') }
    if (!info.isDirectory() || info.isSymbolicLink()
      || normalizedPath(fs.realpathSync.native(cursor)) !== normalizedPath(cursor)) fail('PORTABLE_ASSET_UNSAFE')
  }
}

function regularFile(file: string, missingCode: ProjectArchiveServiceErrorCode): fs.Stats {
  try {
    const absolute = path.resolve(file)
    const info = fs.lstatSync(absolute)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
      || normalizedPath(fs.realpathSync.native(absolute)) !== normalizedPath(absolute)) fail('PORTABLE_ASSET_UNSAFE')
    return info
  } catch (error) {
    if (error instanceof ProjectArchiveServiceError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail(missingCode)
    fail('PORTABLE_ASSET_UNSAFE')
  }
}

function prepareAttempt(parent: string): OwnedAttempt {
  const root = fs.mkdtempSync(path.join(parent, '.pe-'))
  fs.chmodSync(root, 0o700)
  const rootIdentity = fs.lstatSync(root, { bigint: true })
  if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()
    || normalizedPath(fs.realpathSync.native(root)) !== normalizedPath(root)) fail('PORTABLE_ASSET_UNSAFE')
  return { root, rootIdentity, files: new Map() }
}

function recordOwnedFile(attempt: OwnedAttempt, file: string): void {
  const absolute = path.resolve(file)
  if (normalizedPath(path.dirname(absolute)) !== normalizedPath(attempt.root)) fail('PORTABLE_ASSET_UNSAFE')
  const info = fs.lstatSync(absolute, { bigint: true })
  if (!info.isFile() || info.isSymbolicLink()
    || normalizedPath(fs.realpathSync.native(absolute)) !== normalizedPath(absolute)) fail('PORTABLE_ASSET_UNSAFE')
  attempt.files.set(absolute, info)
}

function recordOwnedFileIfPresent(attempt: OwnedAttempt, file: string): void {
  try { fs.lstatSync(file) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  recordOwnedFile(attempt, file)
}

function cleanupAttempt(attempt: OwnedAttempt): void {
  for (const [file, identity] of [...attempt.files].reverse()) {
    try {
      const actual = fs.lstatSync(file, { bigint: true })
      if (actual.isFile() && !actual.isSymbolicLink() && sameObject(identity, actual)
        && normalizedPath(fs.realpathSync.native(file)) === normalizedPath(file)) fs.unlinkSync(file)
    } catch { /* Preserve missing, replaced, linked, or otherwise unknown content. */ }
  }
  try {
    const actual = fs.lstatSync(attempt.root, { bigint: true })
    if (actual.isDirectory() && !actual.isSymbolicLink() && sameObject(attempt.rootIdentity, actual)
      && normalizedPath(fs.realpathSync.native(attempt.root)) === normalizedPath(attempt.root)
      && fs.readdirSync(attempt.root).length === 0) fs.rmdirSync(attempt.root)
  } catch { /* Preserve a replaced or non-empty attempt root. */ }
}

function sha256(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex') }

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  return JSON.stringify(value)
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') fail('PORTABLE_UNSAFE_PROJECTION')
  try { return JSON.parse(value) }
  catch { return fail('PORTABLE_UNSAFE_PROJECTION') }
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('PORTABLE_UNSAFE_PROJECTION')
  const result = value as Record<string, unknown>
  if (Object.keys(result).some(key => !keys.includes(key))) fail('PORTABLE_UNSAFE_PROJECTION')
  return result
}

function safeId(value: unknown): string {
  const encoded = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  if (typeof encoded !== 'string' || !SAFE_ID.test(encoded) || /^[a-z]:/iu.test(encoded)) fail('PORTABLE_UNSAFE_PROJECTION')
  return encoded
}

function contentHash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) fail('PORTABLE_UNSAFE_PROJECTION')
  return value
}

function safeInteger(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail('PORTABLE_UNSAFE_PROJECTION')
  return value as number
}

function safeString(value: unknown, maximum = 16 * 1024 * 1024): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximum) fail('PORTABLE_UNSAFE_PROJECTION')
  return value
}

function projectSourceDependencies(value: unknown): unknown[] {
  const parsed = parseJson(value)
  if (!Array.isArray(parsed) || parsed.length > 500) fail('PORTABLE_UNSAFE_PROJECTION')
  return parsed.map(item => {
    const dependency = object(item, ['draftId', 'contentHash', 'kind', 'chapterNumber', 'finalizationId'])
    const kind = dependency.kind
    if (!(kind === undefined || kind === 'candidate' || kind === 'finalized' || kind === 'legacy-finalized')) {
      fail('PORTABLE_UNSAFE_PROJECTION')
    }
    const projected: Record<string, unknown> = {
      draftId: safeInteger(dependency.draftId, 1),
      contentHash: contentHash(dependency.contentHash),
    }
    if (kind !== undefined) projected.kind = kind
    if (kind === 'finalized' || kind === 'legacy-finalized') projected.chapterNumber = safeInteger(dependency.chapterNumber, 1)
    if (kind === 'finalized') projected.finalizationId = safeId(dependency.finalizationId)
    if (kind !== 'finalized' && dependency.finalizationId !== undefined) fail('PORTABLE_UNSAFE_PROJECTION')
    return projected
  })
}

function projectRecoverySource(value: unknown): Record<string, unknown> {
  const source = object(parseJson(value), [
    'chapterNumber', 'title', 'role', 'purpose', 'keyEvents', 'characters', 'suspenseHook', 'userGuidance',
  ])
  if (!Array.isArray(source.characters) || source.characters.length > 10_000
    || source.characters.some(item => typeof item !== 'string')) fail('PORTABLE_UNSAFE_PROJECTION')
  const projected: Record<string, unknown> = {
    chapterNumber: safeInteger(source.chapterNumber, 1),
    title: safeString(source.title),
    role: safeString(source.role),
    purpose: safeString(source.purpose),
    keyEvents: safeString(source.keyEvents),
    characters: source.characters.map(item => safeString(item)),
  }
  if (source.suspenseHook !== undefined) projected.suspenseHook = safeString(source.suspenseHook)
  if (source.userGuidance !== undefined) projected.userGuidance = safeString(source.userGuidance)
  return projected
}

function projectReviewFingerprint(value: unknown): Record<string, unknown> {
  const fingerprint = object(value, REVIEW_FINGERPRINT_FIELDS)
  if (Object.keys(fingerprint).length !== REVIEW_FINGERPRINT_FIELDS.length) fail('PORTABLE_UNSAFE_PROJECTION')
  for (const key of REVIEW_FINGERPRINT_FIELDS) contentHash(fingerprint[key])
  return fingerprint
}

function reviewArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 10_000) fail('PORTABLE_UNSAFE_PROJECTION')
  return value
}

function reviewTextFields(record: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of fields) if (field in record) safeString(record[field])
}

function reviewIntegerFields(record: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of fields) if (field in record) safeInteger(record[field])
}

function reviewSource(value: unknown): Record<string, unknown> {
  const source = object(value, ['id', 'chapterNumber', 'version', 'status', 'content'])
  if (Object.keys(source).length !== 5) fail('PORTABLE_UNSAFE_PROJECTION')
  reviewIntegerFields(source, ['id', 'chapterNumber', 'version'])
  reviewTextFields(source, ['status', 'content'])
  return source
}

function reviewRecheck(value: unknown): void {
  const recheck = object(value, ['version', 'cycleId', 'comparisonVersion', 'mergedHash', 'findingSetHash', 'findings'])
  if (Object.keys(recheck).length !== 6 || (recheck.version !== 1 && recheck.version !== 2)) fail('PORTABLE_UNSAFE_PROJECTION')
  safeId(recheck.cycleId)
  safeInteger(recheck.comparisonVersion, 1)
  contentHash(recheck.mergedHash)
  contentHash(recheck.findingSetHash)
  for (const value of reviewArray(recheck.findings)) {
    const finding = object(value, ['findingId', 'targetId', 'category', 'kind', 'problem', 'expected',
      'sourceSpan', 'occurrence', 'sourceExcerpt'])
    reviewTextFields(finding, ['findingId', 'targetId', 'category', 'kind', 'problem', 'expected', 'sourceExcerpt'])
    safeInteger(finding.occurrence)
    const span = object(finding.sourceSpan, ['start', 'end', 'unit'])
    reviewIntegerFields(span, ['start', 'end'])
    if (span.unit !== 'utf16-code-unit') fail('PORTABLE_UNSAFE_PROJECTION')
  }
}

function assertReviewContext(value: unknown): Record<string, unknown> {
  const context = object(value, REVIEW_CONTEXT_FIELDS)
  if (context.version !== 1 || !['review-chapter', 'refine-draft', 'refine-from-review'].includes(String(context.operation))) {
    fail('PORTABLE_UNSAFE_PROJECTION')
  }
  reviewSource(context.source)
  contentHash(context.sourceHash)
  const config = object(context.config, ['writingLanguage', 'creativeStrategy',
    'narrativeThreadDormantChapterThreshold', 'genre', 'subGenre', 'targetAudience', 'totalChapters',
    'wordsPerChapter', 'plotStructure', 'narrativePOV', 'coreOutline', 'worldSetting', 'goldenFinger',
    'protagonistProfile', 'globalGuidance', 'writingStyle', 'referenceWorks'])
  reviewTextFields(config, ['writingLanguage', 'creativeStrategy', 'genre', 'subGenre', 'targetAudience',
    'plotStructure', 'narrativePOV', 'coreOutline', 'worldSetting', 'goldenFinger', 'protagonistProfile',
    'globalGuidance', 'writingStyle', 'referenceWorks'])
  reviewIntegerFields(config, ['narrativeThreadDormantChapterThreshold', 'totalChapters', 'wordsPerChapter'])
  reviewTextFields(context, ['writingLanguage', 'uiLocale', 'characterStates', 'worldbuilding'])
  for (const value of reviewArray(context.authorInputs)) {
    const input = object(value, ['id', 'text'])
    reviewTextFields(input, ['id', 'text'])
  }
  for (const value of reviewArray(context.history)) {
    const item = object(value, ['draftId', 'chapterNumber', 'chapterTitle', 'content', 'source', 'projection', 'identity'])
    reviewIntegerFields(item, ['draftId', 'chapterNumber'])
    reviewTextFields(item, ['chapterTitle', 'content'])
    if (item.source !== undefined) {
      const source = object(item.source, ['draftId', 'finalizationId', 'chapterNumber', 'contentHash'])
      reviewIntegerFields(source, ['draftId', 'chapterNumber'])
      reviewTextFields(source, ['finalizationId'])
      contentHash(source.contentHash)
    }
    if (item.identity !== undefined) {
      const identity = object(item.identity, ['projectId', 'sourceId', 'revision', 'contentHash', 'provenance'])
      reviewTextFields(identity, ['projectId', 'sourceId', 'provenance'])
      reviewIntegerFields(identity, ['revision'])
      contentHash(identity.contentHash)
    }
    if (item.projection !== undefined) {
      const projection = object(item.projection, ['draftId', 'currentFinalizedDraftId', 'chapterNumber',
        'chapterTitle', 'chapterNotes', 'facts', 'characterStateCandidates', 'source', 'sourceStatus'])
      reviewIntegerFields(projection, ['draftId', 'currentFinalizedDraftId', 'chapterNumber'])
      reviewTextFields(projection, ['chapterTitle', 'chapterNotes', 'sourceStatus'])
      if (projection.source !== undefined) {
        const source = object(projection.source, ['draftId', 'finalizationId', 'chapterNumber', 'contentHash'])
        reviewIntegerFields(source, ['draftId', 'chapterNumber'])
        reviewTextFields(source, ['finalizationId'])
        contentHash(source.contentHash)
      }
      if (projection.facts !== undefined) for (const factValue of reviewArray(projection.facts)) {
        const fact = object(factValue, ['category', 'entities', 'statement', 'sourceChapter', 'evidence', 'characterRefs'])
        reviewTextFields(fact, ['category', 'statement', 'evidence'])
        reviewIntegerFields(fact, ['sourceChapter'])
        reviewArray(fact.entities).forEach(item => safeString(item))
        if (fact.characterRefs !== undefined) for (const refValue of reviewArray(fact.characterRefs)) {
          const ref = object(refValue, ['characterId', 'displayNameSnapshot'])
          reviewTextFields(ref, ['characterId', 'displayNameSnapshot'])
        }
      }
      if (projection.characterStateCandidates !== undefined) {
        for (const candidateValue of reviewArray(projection.characterStateCandidates)) {
          const candidate = object(candidateValue, ['characterId', 'characterName', 'field', 'value', 'evidence',
            'selectionKey', 'displayName', 'rawValue', 'reason', 'candidateKey', 'source',
            'expectedFieldRevision', 'expectedFieldValueHash'])
          reviewTextFields(candidate, ['characterId', 'characterName', 'field', 'value', 'selectionKey',
            'displayName', 'reason', 'candidateKey', 'expectedFieldValueHash', 'rawValue'])
          reviewIntegerFields(candidate, ['expectedFieldRevision'])
          if (candidate.evidence !== undefined) {
            const evidence = object(candidate.evidence, ['start', 'end', 'text'])
            reviewIntegerFields(evidence, ['start', 'end'])
            reviewTextFields(evidence, ['text'])
          }
          if (candidate.source !== undefined) {
            const source = object(candidate.source, ['draftId', 'finalizationId', 'chapterNumber', 'contentHash'])
            reviewIntegerFields(source, ['draftId', 'chapterNumber'])
            reviewTextFields(source, ['finalizationId'])
            contentHash(source.contentHash)
          }
        }
      }
    }
  }
  for (const value of reviewArray(context.blueprints)) {
    const blueprint = object(value, ['chapterNumber', 'title', 'role', 'purpose', 'keyEvents',
      'characters', 'suspenseHook', 'userGuidance', 'notes'])
    reviewIntegerFields(blueprint, ['chapterNumber'])
    reviewTextFields(blueprint, ['title', 'role', 'purpose', 'keyEvents', 'suspenseHook', 'userGuidance', 'notes'])
    reviewArray(blueprint.characters).forEach(item => safeString(item))
  }
  const goals = object(context.frozenGoals, ['chapterNumber', 'coverage', 'items'])
  reviewIntegerFields(goals, ['chapterNumber'])
  reviewTextFields(goals, ['coverage'])
  for (const value of reviewArray(goals.items)) reviewTextFields(object(value, ['id', 'text']), ['id', 'text'])
  for (const value of reviewArray(context.preflightFindings)) {
    const finding = object(value, ['stableFactKey', 'severity', 'sourceChapter', 'evidence', 'issue', 'suggestion'])
    reviewTextFields(finding, ['stableFactKey', 'severity', 'evidence'])
    reviewIntegerFields(finding, ['sourceChapter'])
    for (const field of ['issue', 'suggestion']) reviewTextFields(object(finding[field], ['zhCN', 'enUS']), ['zhCN', 'enUS'])
  }
  if (context.confirmation !== undefined) {
    const confirmation = object(context.confirmation, ['reviewSourceId', 'content', 'originalReviewContentHash', 'snapshot'])
    reviewIntegerFields(confirmation, ['reviewSourceId'])
    reviewTextFields(confirmation, ['content'])
    contentHash(confirmation.originalReviewContentHash)
    const snapshot = object(confirmation.snapshot, ['kind', 'schemaVersion', 'cycleId', 'sourceReviewId',
      'sourceDraft', 'summary', 'authorGuidance', 'items', 'goalReview'])
    reviewTextFields(snapshot, ['kind', 'cycleId', 'summary', 'authorGuidance'])
    reviewIntegerFields(snapshot, ['schemaVersion', 'sourceReviewId'])
    if (snapshot.sourceDraft !== undefined) reviewSource(snapshot.sourceDraft)
    for (const value of reviewArray(snapshot.items)) {
      const item = object(value, ['category', 'severity', 'description', 'quote', 'stableFactKey',
        'sourceChapter', 'goalId', 'findingId', 'decision', 'origin'])
      reviewTextFields(item, ['category', 'severity', 'description', 'quote', 'stableFactKey',
        'goalId', 'findingId', 'decision', 'origin'])
      reviewIntegerFields(item, ['sourceChapter'])
    }
    if (snapshot.goalReview !== undefined) {
      const goalReview = object(snapshot.goalReview, ['version', 'chapterNumber', 'coverage', 'items'])
      reviewIntegerFields(goalReview, ['version', 'chapterNumber'])
      reviewTextFields(goalReview, ['coverage'])
      for (const value of reviewArray(goalReview.items)) {
        const item = object(value, ['id', 'text', 'status', 'description', 'evidence'])
        reviewTextFields(item, ['id', 'text', 'status', 'description'])
        for (const evidenceValue of reviewArray(item.evidence)) {
          const evidence = object(evidenceValue, ['quote', 'start', 'end'])
          reviewTextFields(evidence, ['quote'])
          reviewIntegerFields(evidence, ['start', 'end'])
        }
      }
    }
  }
  if (context.recheck !== undefined) reviewRecheck(context.recheck)
  return context
}

function projectReviewBinding(value: unknown): Record<string, unknown> {
  const binding = object(parseJson(value), [
    'projectId', 'epoch', 'fingerprint', 'contextSnapshotId', 'sourceManifest', 'sourceRefs',
  ])
  const projected: Record<string, unknown> = {
    projectId: safeId(binding.projectId), epoch: safeId(binding.epoch),
    fingerprint: projectReviewFingerprint(binding.fingerprint),
  }
  const manifest = binding.sourceManifest as Record<string, unknown> | undefined
  if (manifest?.reviewRevisionContext === undefined) return projected
  const context = assertReviewContext(manifest.reviewRevisionContext)
  const encoded = JSON.stringify(context)
  const source = object(context.source, ['id', 'chapterNumber', 'version', 'status', 'content'])
  if (Buffer.byteLength(encoded, 'utf8') > 16 * 1024 * 1024
    || contentHash(context.sourceHash) !== sha256(safeString(source.content))
    || contentHash(manifest.reviewRevisionContextHash) !== sha256(encoded)
    || JSON.stringify(manifest.authorInputs) !== JSON.stringify([{ id: 'review-revision-context', text: encoded }])) {
    fail('PORTABLE_UNSAFE_PROJECTION')
  }
  projected.sourceManifest = { operation: safeId(manifest.operation), reviewRevisionContext: context,
    reviewRevisionContextHash: manifest.reviewRevisionContextHash, authorInputs: manifest.authorInputs }
  return projected
}

function projectReviewArtifactRef(value: unknown): Record<string, unknown> {
  const ref = object(value, ['artifactId', 'revision', 'textHash'])
  return { artifactId: safeId(ref.artifactId), revision: safeInteger(ref.revision),
    textHash: contentHash(ref.textHash) }
}

function projectReviewRecheckReceipt(value: unknown): Record<string, unknown> {
  const receipt = object(value, ['version', 'cycleId', 'comparisonVersion', 'mergedHash', 'findingSetHash', 'findings'])
  if (Object.keys(receipt).length !== 6 || (receipt.version !== 1 && receipt.version !== 2)) fail('PORTABLE_UNSAFE_PROJECTION')
  return { version: receipt.version, cycleId: safeId(receipt.cycleId),
    comparisonVersion: safeInteger(receipt.comparisonVersion, 1), mergedHash: contentHash(receipt.mergedHash),
    findingSetHash: contentHash(receipt.findingSetHash), findings: reviewArray(receipt.findings).map(value => {
      const finding = object(value, ['findingId', 'targetId', 'reviewItemIndex', 'evidenceHash', 'resolved'])
      if (Object.keys(finding).length !== 5 || typeof finding.resolved !== 'boolean') fail('PORTABLE_UNSAFE_PROJECTION')
      return { findingId: safeId(finding.findingId), targetId: safeId(finding.targetId),
        reviewItemIndex: safeInteger(finding.reviewItemIndex), evidenceHash: contentHash(finding.evidenceHash),
        resolved: finding.resolved }
    }) }
}

function projectReviewUsage(value: unknown): Record<string, unknown> | null {
  if (value === null) return null
  const usage = parseJson(value) as Record<string, unknown>
  if (!usage || typeof usage !== 'object' || Array.isArray(usage) || !usage.reviewRevisionEffect) return null
  const identity = object(usage.artifactIdentity, ['artifactId', 'epoch', 'fingerprint'])
  const result = object(usage.result, ['usage', 'finishReason', 'failureCode'])
  const effect = object(usage.reviewRevisionEffect, [
    'kind', 'id', 'index', 'contentHash', 'contextHash', 'artifact', 'compositionHash',
  ])
  if (effect.kind !== 'review' && effect.kind !== 'revision') fail('PORTABLE_UNSAFE_PROJECTION')
  const projected: Record<string, unknown> = {
    artifactIdentity: { artifactId: safeId(identity.artifactId), epoch: safeId(identity.epoch),
      fingerprint: projectReviewFingerprint(identity.fingerprint) },
    result: { finishReason: safeId(result.finishReason) },
    reviewRevisionEffect: { kind: effect.kind, id: safeInteger(effect.id, 1), index: safeInteger(effect.index, 1),
      contentHash: contentHash(effect.contentHash), contextHash: contentHash(effect.contextHash),
      artifact: projectReviewArtifactRef(effect.artifact),
      ...(effect.kind === 'revision' ? { compositionHash: contentHash(effect.compositionHash) } : {}) },
  }
  if (usage.visibleComposition !== undefined) {
    const composition = object(usage.visibleComposition, ['algorithm', 'textHash', 'artifactIds', 'sources'])
    if (composition.algorithm !== 'visible-append-v1' || !Array.isArray(composition.artifactIds)
      || !Array.isArray(composition.sources) || composition.artifactIds.length > 32
      || composition.artifactIds.length !== composition.sources.length) fail('PORTABLE_UNSAFE_PROJECTION')
    projected.visibleComposition = { algorithm: composition.algorithm, textHash: contentHash(composition.textHash),
      artifactIds: composition.artifactIds.map(safeId), sources: composition.sources.map(projectReviewArtifactRef) }
  }
  if (usage.reviewCycleRecheck !== undefined) {
    projected.reviewCycleRecheck = projectReviewRecheckReceipt(usage.reviewCycleRecheck)
  }
  return projected
}

function projectArtifact(value: unknown, reviewProof = false): Record<string, unknown> {
  const artifact = object(parseJson(value), [
    'artifactId', 'attemptId', 'rootActionId', 'projectId', 'epoch', 'fingerprint', 'revision', 'text', 'textHash',
  ])
  return {
    artifactId: safeId(artifact.artifactId),
    attemptId: safeId(artifact.attemptId),
    rootActionId: safeId(artifact.rootActionId),
    revision: safeInteger(artifact.revision),
    text: safeString(artifact.text),
    textHash: contentHash(artifact.textHash),
    ...(reviewProof ? { projectId: safeId(artifact.projectId), epoch: safeId(artifact.epoch),
      fingerprint: projectReviewFingerprint(artifact.fingerprint) } : {}),
  }
}

function projectGenerationAttempt(value: unknown): Record<string, unknown> {
  const attempt = object(parseJson(value), [
    'attemptId', 'reservationId', 'rootActionId', 'status', 'reservedTokens', 'requestedOutputTokens', 'actualTokens',
  ])
  const status = safeString(attempt.status, 64)
  if (!['reserved', 'dispatch-marked', 'settled', 'unknown', 'cancelled-before-dispatch'].includes(status)) {
    fail('PORTABLE_UNSAFE_PROJECTION')
  }
  const projected: Record<string, unknown> = {
    attemptId: safeId(attempt.attemptId),
    rootActionId: safeId(attempt.rootActionId),
    status,
    reservedTokens: safeInteger(attempt.reservedTokens, 1),
    requestedOutputTokens: safeInteger(attempt.requestedOutputTokens, 1),
  }
  if (attempt.actualTokens !== undefined) projected.actualTokens = safeInteger(attempt.actualTokens)
  return projected
}

function projectGenerationAction(value: unknown, reviewProof = false): Record<string, unknown> {
  const action = object(parseJson(value), [
    'projectId', 'epoch', 'operation', 'uiActionNonce', 'frozenInputHash', 'rootActionId', 'status',
    'secretRef', 'credential', 'path', 'grantId', 'apiKey', 'token',
  ])
  const status = safeString(action.status, 64)
  if (!['active', 'paused', 'cancelled', 'sealed'].includes(status)) fail('PORTABLE_UNSAFE_PROJECTION')
  return { rootActionId: safeId(action.rootActionId), operation: safeId(action.operation), status,
    ...(reviewProof ? { projectId: safeId(action.projectId), epoch: safeId(action.epoch) } : {}) }
}

function projectGenerationBudget(value: unknown): Record<string, unknown> {
  const budget = object(parseJson(value), [
    'maxPhysicalRequests', 'maxTokenLiability', 'maxOutputPerRequest', 'maxActiveElapsedMs',
  ])
  return {
    maxPhysicalRequests: safeInteger(budget.maxPhysicalRequests, 1),
    maxTokenLiability: safeInteger(budget.maxTokenLiability, 1),
    maxOutputPerRequest: safeInteger(budget.maxOutputPerRequest, 1),
    maxActiveElapsedMs: safeInteger(budget.maxActiveElapsedMs, 1),
  }
}

function projectDisplay(value: unknown, many: boolean): unknown {
  const parsed = parseJson(value)
  const values = many ? parsed : [parsed]
  if (!Array.isArray(values) || values.length > 256) fail('PORTABLE_UNSAFE_PROJECTION')
  const projected = values.map(item => {
    const display = object(item, ['displayName', 'mediaType', 'size'])
    const displayName = safeString(display.displayName, 1024)
    const mediaType = safeString(display.mediaType, 255)
    if (path.isAbsolute(displayName) || displayName.includes('/') || displayName.includes('\\')
      || !/^[\w.+-]+\/[\w.+-]+$/u.test(mediaType)) fail('PORTABLE_UNSAFE_PROJECTION')
    return { displayName, mediaType, size: safeInteger(display.size) }
  })
  return many ? projected : projected[0]
}

function requiredProjection(key: string, value: unknown): unknown {
  switch (key) {
    case 'drafts.source_dependencies': return projectSourceDependencies(value)
    case 'generation_artifacts.artifact_json': return projectArtifact(value)
    case 'generation_attempts.attempt_json': return projectGenerationAttempt(value)
    case 'generation_roots.action_json': return projectGenerationAction(value)
    case 'generation_roots.budget_json': return projectGenerationBudget(value)
    case 'import_run_sources.display_json': return projectDisplay(value, false)
    case 'import_runs.source_display_json': return projectDisplay(value, true)
    case 'recovery_candidates.source_snapshot': return projectRecoverySource(value)
    default: return fail('PORTABLE_UNSAFE_PROJECTION')
  }
}

function neutralValue(key: string, column: { type: string; notnull: number }, value: unknown,
  reviewProof = false): unknown {
  if (reviewProof) {
    if (key === 'generation_roots.action_json') return JSON.stringify(projectGenerationAction(value, true))
    if (key === 'generation_runs.binding_json') return JSON.stringify(projectReviewBinding(value))
    if (key === 'generation_attempts.usage_receipt_json') {
      const usage = projectReviewUsage(value)
      return usage === null ? null : JSON.stringify(usage)
    }
    if (key === 'generation_artifacts.artifact_json') return JSON.stringify(projectArtifact(value, true))
  }
  if (REQUIRED_JSON_PROJECTORS.has(key)) return JSON.stringify(requiredProjection(key, value))
  if (JSON_NEUTRAL.has(key)) {
    if (value !== null) parseJson(value)
    return key === 'blueprint_character_sync_operations.completion_receipt'
      || key === 'generation_attempts.usage_receipt_json'
      || key === 'import_run_receipts.effect_receipt_json' ? null : '{}'
  }
  if (!column.notnull) return null
  return /INT|REAL|NUM|DEC|BOOL/u.test(column.type.toUpperCase()) ? 0 : ''
}

function recordId(table: string, row: Record<string, unknown>, rowid: number): string {
  const fields = HISTORY_ID_COLUMNS[table] ?? []
  if (!fields.length) return `${table}:${rowid}`
  return fields.map(field => safeId(row[field])).join(':')
}

function terminalState(row: Record<string, unknown>): string {
  const value = HISTORY_STATE_COLUMNS.map(field => row[field]).find(item => typeof item === 'string')
  if (typeof value === 'string' && SAFE_CODE.test(value)) return value
  if (typeof row.attempt_json === 'string') {
    const attempt = projectGenerationAttempt(row.attempt_json)
    if (typeof attempt.status === 'string') return attempt.status
  }
  if (typeof row.action_json === 'string') {
    const action = projectGenerationAction(row.action_json)
    if (typeof action.status === 'string') return action.status
  }
  return 'historical'
}

function projectionForRow(
  table: string,
  row: Record<string, unknown>,
  columns: readonly { name: string; type: string; notnull: number }[],
): { projection: Record<string, unknown>; excludedFields: string[] } {
  const projection: Record<string, unknown> = {}
  const excludedFields: string[] = []
  for (const column of columns) {
    const key = `${table}.${column.name}`
    const policy = getPortableFieldPolicy(table, column.name)
    if (policy.disposition !== 'redacted-projection') continue
    if (REQUIRED_JSON_PROJECTORS.has(key)) projection[column.name] = requiredProjection(key, row[column.name])
    else excludedFields.push(column.name)
  }
  return { projection, excludedFields }
}

/** Shared C17 copy-only history projection. Call only on an isolated target staging DB. */
export function sanitizePortableDatabase(databasePath: string): {
  history: HistoryProjection[]
  tableCounts: Record<string, number>
} {
  const db = new BetterSqlite(databasePath, { fileMustExist: true })
  try {
    db.pragma('foreign_keys = ON')
    db.pragma('secure_delete = ON')
    assertPortableSourceSchema(db)
    const avatarRows = readPortableCharacterAvatarRows(db)
    const reviewRoots = new Set((db.prepare('SELECT root_action_id FROM review_cycles').all() as Array<{
      root_action_id: string }>).map(row => row.root_action_id))
    const reviewRuns = new Set((db.prepare('SELECT run_id,root_action_id FROM generation_runs').all() as Array<{
      run_id: string; root_action_id: string }>).filter(row => reviewRoots.has(row.root_action_id)).map(row => row.run_id))
    for (const row of avatarRows) {
      if ('recordId' in row) safeId(row.recordId)
      if ('characterId' in row) safeId(row.characterId)
      if ('candidateCharacterIds' in row) row.candidateCharacterIds.forEach(safeId)
      if ('sourceReference' in row) portablePathKey(row.sourceReference)
      if ('sourceRelativePath' in row) portablePathKey(row.sourceRelativePath)
      if ('relativePath' in row) portablePathKey(row.relativePath)
    }
    const history: HistoryProjection[] = []
    const tableCounts: Record<string, number> = {}
    db.transaction(() => {
      db.prepare('DELETE FROM import_legacy_identity_bridge').run()
      db.prepare('DELETE FROM text_metric_versions').run()
      db.prepare('DELETE FROM llm_calls').run()
      db.prepare("UPDATE character_avatar_assets SET source_reference='' ").run()
      const tables = db.prepare("SELECT name FROM pragma_table_list WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as Array<{ name: string }>
      let accountedFields = 0
      for (const { name: table } of tables) {
        const columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all() as Array<{
          name: string; type: string; notnull: number
        }>
        accountedFields += columns.length
        const policies = columns.map(column => getPortableFieldPolicy(table, column.name))
        const hasProjection = policies.some(policy => policy.disposition === 'redacted-projection')
        const hasHistory = policies.some(policy => policy.disposition === 'historical-nonreplayable')
        const rows = db.prepare(`SELECT rowid AS __portable_rowid__, * FROM ${quote(table)}`).all() as Array<Record<string, unknown>>
        tableCounts[`table.${table}`] = rows.length
        const updates = columns.filter((_column, index) => {
          const disposition = policies[index]!.disposition
          return disposition === 'redacted-projection' || disposition === 'exclude-machine-authority'
        })
        const update = updates.length
          ? db.prepare(`UPDATE ${quote(table)} SET ${updates.map(column => `${quote(column.name)}=?`).join(',')} WHERE rowid=?`)
          : null
        for (const row of rows) {
          const reviewProof = table === 'generation_artifacts' ? reviewRuns.has(String(row.run_id))
            : reviewRoots.has(String(row.root_action_id))
          if (hasProjection || hasHistory) {
            const safe = projectionForRow(table, row, columns)
            const id = recordId(table, row, Number(row.__portable_rowid__))
            const projectionId = `history:${table}:${id}`
            history.push({
              projectionId,
              table,
              recordId: id,
              terminalState: terminalState(row),
              projection: safe.projection,
              projectionHash: sha256(stableJson(safe.projection)),
              excludedFields: safe.excludedFields,
              nonReplayable: true,
              originalReceiptVerified: false,
            })
          }
          if (update) update.run(...updates.map(column => neutralValue(
            `${table}.${column.name}`, column, row[column.name],
            reviewProof,
          )), row.__portable_rowid__)
          for (const [index, column] of columns.entries()) {
            if (policies[index]!.disposition !== 'validated-relative') continue
            const value = row[column.name]
            if (typeof value !== 'string') fail('PORTABLE_UNSAFE_PROJECTION')
            portablePathKey(value)
          }
        }
      }
      if (tables.length !== PORTABLE_FIELD_POLICY_COUNTS.tables
        || accountedFields !== PORTABLE_FIELD_POLICY_COUNTS.fields
        || listPortableFieldPolicyKeys().length !== accountedFields) fail('PORTABLE_UNSAFE_PROJECTION')
    }).immediate()
    db.exec('VACUUM')
    db.pragma('wal_checkpoint(TRUNCATE)')
    assertPortableSourceSchema(db)
    return { history, tableCounts }
  } finally { db.close() }
}

function writePrivateFile(file: string, bytes: Buffer): void {
  const descriptor = fs.openSync(file, 'wx', 0o600)
  try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor) }
  finally { fs.closeSync(descriptor) }
}

async function verifyFile(file: PortableProvidedFile, allowedRoot: string): Promise<void> {
  if (!file.id || !PROVIDED_DISPOSITIONS.has(file.disposition) || !Number.isSafeInteger(file.byteSize)
    || file.byteSize < 0 || !HASH.test(file.sha256)) fail('PORTABLE_ASSET_UNSAFE')
  portablePathKey(file.archivePath)
  if (file.bytes !== undefined) {
    if (!Buffer.isBuffer(file.bytes) || file.bytes.length !== file.byteSize || sha256(file.bytes) !== file.sha256) {
      fail('PORTABLE_SOURCE_CHANGED')
    }
    return
  }
  const sourcePath = path.resolve(file.sourcePath)
  if (!normalizedContained(allowedRoot, sourcePath)) fail('PORTABLE_ASSET_UNSAFE')
  safeDirectory(allowedRoot)
  const info = regularFile(file.sourcePath, 'PORTABLE_ASSET_MISSING')
  if (!normalizedContained(fs.realpathSync.native(allowedRoot), fs.realpathSync.native(sourcePath))) {
    fail('PORTABLE_ASSET_UNSAFE')
  }
  if (info.size !== file.byteSize || await hashFile(file.sourcePath) !== file.sha256) fail('PORTABLE_SOURCE_CHANGED')
}

function sameEvidence(left: ProjectSqliteEvidence, right: ProjectSqliteEvidence): boolean {
  return left.schemaVersion === right.schemaVersion && left.fingerprint === right.fingerprint
    && stableJson(left.domain) === stableJson(right.domain)
    && stableJson(left.preIdentityDomain) === stableJson(right.preIdentityDomain)
    && stableJson(left.preAssetDomain) === stableJson(right.preAssetDomain)
}

async function hashFile(file: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(file)) digest.update(chunk as Buffer)
  return digest.digest('hex')
}

function publishStagedArchive(stagedArchivePath: string, targetPath: string): fs.BigIntStats {
  const staged = fs.lstatSync(stagedArchivePath, { bigint: true })
  if (!staged.isFile() || staged.isSymbolicLink()
    || normalizedPath(fs.realpathSync.native(stagedArchivePath)) !== normalizedPath(stagedArchivePath)) {
    fail('PORTABLE_ASSET_UNSAFE')
  }
  safeDirectory(path.dirname(targetPath))
  try { fs.linkSync(stagedArchivePath, targetPath) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new PortableProjectArchiveError('PORTABLE_ARCHIVE_TARGET_EXISTS')
    }
    throw new PortableProjectArchiveError('PORTABLE_ARCHIVE_PUBLISH_UNSUPPORTED')
  }
  const published = fs.lstatSync(targetPath, { bigint: true })
  if (!published.isFile() || published.isSymbolicLink() || !sameObject(staged, published)
    || normalizedPath(fs.realpathSync.native(targetPath)) !== normalizedPath(targetPath)) {
    try {
      const current = fs.lstatSync(targetPath, { bigint: true })
      if (current.isFile() && !current.isSymbolicLink() && sameObject(staged, current)
        && normalizedPath(fs.realpathSync.native(targetPath)) === normalizedPath(targetPath)) fs.unlinkSync(targetPath)
    } catch { /* Preserve an unknown replacement. */ }
    throw new PortableProjectArchiveError('PORTABLE_ARCHIVE_INVALID')
  }
  return published
}

function assertContextShape(context: ProjectSessionContext, sourceRoot: string): void {
  if (!context || typeof context.projectId !== 'string' || !context.projectId || typeof context.leaseId !== 'string'
    || !context.leaseId || typeof context.projectPath !== 'string'
    || normalizedPath(context.projectPath) !== normalizedPath(sourceRoot)) fail('PORTABLE_CONTEXT_INVALID')
}

async function assertCurrentContext(input: ExportPortableProjectInput, context: Readonly<ProjectSessionContext>, sourceRoot: string): Promise<void> {
  try {
    if (await input.assertCurrentContext(context, sourceRoot) === false) fail('PORTABLE_SOURCE_CHANGED')
  }
  catch { fail('PORTABLE_SOURCE_CHANGED') }
}

function mapSourceChange(error: unknown): never {
  if (error instanceof ProjectArchiveServiceError) throw error
  if (error instanceof Error && error.message === 'PROJECT_MIGRATION_SOURCE_CHANGED') fail('PORTABLE_SOURCE_CHANGED')
  if (error instanceof Error && ['UNRECOGNIZED_SCHEMA', 'NEWER_SCHEMA_READ_ONLY'].includes(error.message)) {
    throw new Error('PORTABLE_SCHEMA_UNSUPPORTED')
  }
  throw error
}

export async function exportPortableProject(input: ExportPortableProjectInput): Promise<ExportPortableProjectReceipt> {
  const sourceRoot = path.resolve(input.sourceProjectRoot)
  const targetPath = path.resolve(input.targetArchivePath)
  const attemptParent = path.resolve(input.attemptParentPath)
  assertContextShape(input.projectSession, sourceRoot)
  if (contained(sourceRoot, targetPath) || contained(sourceRoot, attemptParent)) fail('PORTABLE_TARGET_INSIDE_SOURCE')
  safeDirectory(sourceRoot)
  safeDirectory(attemptParent)
  const frozenContext = Object.freeze({ ...input.projectSession })
  await assertCurrentContext(input, frozenContext, sourceRoot)
  const projectStorageRoot = path.join(sourceRoot, CANONICAL_PROJECT_DIRECTORY)
  safeDirectory(projectStorageRoot)
  const sourceDatabasePath = path.join(projectStorageRoot, CANONICAL_PROJECT_DATABASE)
  regularFile(sourceDatabasePath, 'PORTABLE_ASSET_MISSING')
  const canonicalManifestPath = path.join(projectStorageRoot, 'project.json')
  regularFile(canonicalManifestPath, 'PORTABLE_ASSET_MISSING')
  const canonicalManifest = parseCanonicalProjectManifest(JSON.parse(
    fs.readFileSync(canonicalManifestPath, 'utf8'),
  ))
  if (canonicalManifest.projectId !== frozenContext.projectId) fail('PORTABLE_CONTEXT_INVALID')
  const snapshotGeneration = input.snapshotGeneration ?? randomUUID()
  const createdAt = (input.now?.() ?? new Date()).toISOString()
  const attempt = prepareAttempt(attemptParent)
  const attemptRoot = attempt.root
  try {
    const sourceSnapshotPath = path.join(attemptRoot, 'source.db')
    let firstEvidence: ProjectSqliteEvidence
    try { firstEvidence = await backupProjectSqlite({ sourceDatabasePath, targetDatabasePath: sourceSnapshotPath }) }
    catch (error) { return mapSourceChange(error) }
    recordOwnedFile(attempt, sourceSnapshotPath)
    const sourceSnapshot = new BetterSqlite(sourceSnapshotPath, { readonly: true, fileMustExist: true })
    let avatarRows: ReturnType<typeof readPortableCharacterAvatarRows>
    try {
      assertPortableSourceSchema(sourceSnapshot)
      avatarRows = readPortableCharacterAvatarRows(sourceSnapshot)
    } finally { sourceSnapshot.close() }
    recordOwnedFileIfPresent(attempt, `${sourceSnapshotPath}-wal`)
    recordOwnedFileIfPresent(attempt, `${sourceSnapshotPath}-shm`)

    const portableDatabasePath = path.join(attemptRoot, 'project.db')
    fs.copyFileSync(sourceSnapshotPath, portableDatabasePath, fs.constants.COPYFILE_EXCL)
    recordOwnedFile(attempt, portableDatabasePath)
    const sanitized = sanitizePortableDatabase(portableDatabasePath)
    recordOwnedFile(attempt, portableDatabasePath)
    input.__testHooks?.afterPortableDatabaseCreated?.(attemptRoot)

    const provided = await input.assets.snapshot({
      sourceProjectRoot: sourceRoot,
      sourceDatabasePath: sourceSnapshotPath,
      projectSession: frozenContext,
      snapshotGeneration,
    })
    const sources: PortableArchiveSource[] = []
    const entryKeys = new Set<string>()
    const addSource = (entry: PortableProjectManifestEntry, sourcePath: string) => {
      const key = portablePathKey(entry.path)
      if (entryKeys.has(key)) fail('PORTABLE_ASSET_UNSAFE')
      entryKeys.add(key)
      sources.push({ entry, sourcePath })
    }
    const databaseInfo = regularFile(portableDatabasePath, 'PORTABLE_ASSET_MISSING')
    const portableDatabaseSha256 = await hashFile(portableDatabasePath)
    addSource({ path: CANONICAL_PROJECT_DATABASE, byteSize: databaseInfo.size,
      sha256: portableDatabaseSha256, disposition: 'portable-database' }, portableDatabasePath)

    const portableDatabase = new BetterSqlite(portableDatabasePath, { readonly: true, fileMustExist: true })
    let transferAuthority
    try {
      transferAuthority = createPortableTransferAuthority({
        database: portableDatabase,
        originProjectId: canonicalManifest.projectId,
        snapshotGeneration,
        portableDatabaseSha256,
      })
    } finally { portableDatabase.close() }
    recordOwnedFileIfPresent(attempt, `${portableDatabasePath}-wal`)
    recordOwnedFileIfPresent(attempt, `${portableDatabasePath}-shm`)
    const transferBytes = serializePortableTransferAuthority(transferAuthority)
    const transferPath = path.join(attemptRoot, 'portable-transfer-authority.json')
    writePrivateFile(transferPath, transferBytes)
    recordOwnedFile(attempt, transferPath)
    addSource({ path: PORTABLE_TRANSFER_AUTHORITY_PATH, byteSize: transferBytes.length,
      sha256: sha256(transferBytes), disposition: 'transfer-receipt' }, transferPath)

    const avatarReferenceProjections: Array<Record<string, unknown>> = []
    for (const row of avatarRows) {
      if (row.kind === 'unresolved-reference') {
        avatarReferenceProjections.push({ ...row, nonReplayable: true })
        continue
      }
      const relativePath = portablePathKey(row.relativePath)
      if (!relativePath) fail('PORTABLE_ASSET_UNSAFE')
      const sourcePath = path.resolve(projectStorageRoot, ...row.relativePath.split('/'))
      if (!contained(projectStorageRoot, sourcePath)) fail('PORTABLE_ASSET_UNSAFE')
      const info = regularFile(sourcePath, 'PORTABLE_ASSET_MISSING')
      if (info.size !== row.byteSize || await hashFile(sourcePath) !== row.contentHash) fail('PORTABLE_SOURCE_CHANGED')
      addSource({ path: row.relativePath, byteSize: row.byteSize, sha256: row.contentHash,
        disposition: 'avatar-asset' }, sourcePath)
    }

    for (const [index, file] of provided.files.entries()) {
      await verifyFile(file, projectStorageRoot)
      let sourcePath: string
      if (file.bytes !== undefined) {
        sourcePath = path.join(attemptRoot, `provided-${index}`)
        writePrivateFile(sourcePath, file.bytes)
        recordOwnedFile(attempt, sourcePath)
      } else sourcePath = file.sourcePath
      addSource({ path: file.archivePath, byteSize: file.byteSize, sha256: file.sha256,
        disposition: file.disposition }, sourcePath)
    }

    const historyDocument = {
      version: 1,
      originProjectId: canonicalManifest.projectId,
      snapshotGeneration,
      nonReplayable: true,
      requiresRuntimeFreezeGuard: true,
      records: sanitized.history,
      avatarReferenceProjections,
    }
    const historyBytes = Buffer.from(stableJson(historyDocument), 'utf8')
    const historyPath = path.join(attemptRoot, 'portable-runtime-freeze.json')
    writePrivateFile(historyPath, historyBytes)
    recordOwnedFile(attempt, historyPath)
    addSource({ path: 'portable-runtime-freeze.json', byteSize: historyBytes.length,
      sha256: sha256(historyBytes), disposition: 'history-projection' }, historyPath)

    await assertCurrentContext(input, frozenContext, sourceRoot)
    const verificationSnapshotPath = path.join(attemptRoot, 'source-verification.db')
    let secondEvidence: ProjectSqliteEvidence
    try { secondEvidence = await backupProjectSqlite({ sourceDatabasePath, targetDatabasePath: verificationSnapshotPath }) }
    catch (error) { return mapSourceChange(error) }
    recordOwnedFile(attempt, verificationSnapshotPath)
    if (!sameEvidence(firstEvidence, secondEvidence)) fail('PORTABLE_SOURCE_CHANGED')
    let providerUnchanged: boolean | void
    try { providerUnchanged = await provided.verifyUnchanged() }
    catch { fail('PORTABLE_SOURCE_CHANGED') }
    if (providerUnchanged === false) fail('PORTABLE_SOURCE_CHANGED')
    for (const file of provided.files) await verifyFile(file, projectStorageRoot)
    for (const source of sources.filter(item => item.entry.disposition === 'avatar-asset')) {
      const info = regularFile(source.sourcePath, 'PORTABLE_ASSET_MISSING')
      if (info.size !== source.entry.byteSize || await hashFile(source.sourcePath) !== source.entry.sha256) {
        fail('PORTABLE_SOURCE_CHANGED')
      }
    }

    const entries = sources.map(source => source.entry)
    const payloadBytes = entries.reduce((sum, entry) => sum + entry.byteSize, 0)
    const historyProjectionIds = [
      ...sanitized.history.map(item => item.projectionId),
      ...avatarReferenceProjections.map(item => `avatar-reference:${safeId(item.recordId)}`),
      ...(provided.historyProjectionIds ?? []),
    ]
    const manifest: PortableProjectManifest = {
      formatVersion: PORTABLE_PROJECT_FORMAT_VERSION,
      sourceSchemaVersion: PORTABLE_SOURCE_SCHEMA_VERSION,
      originProjectId: canonicalManifest.projectId,
      snapshotGeneration,
      createdAt,
      declaredUncompressedBytes: payloadBytes,
      declaredCompressedBytes: payloadBytes,
      entries,
      semanticCounts: {
        ...(provided.semanticCounts ?? {}),
        ...sanitized.tableCounts,
        avatars: avatarRows.filter(row => row.kind !== 'unresolved-reference').length,
        'avatar-references': avatarReferenceProjections.length,
      },
      omittedItems: [
        { id: 'vectors', reason: 'rebuild-stale' },
        { id: 'cache', reason: 'rebuild-stale' },
        { id: 'logs', reason: 'exclude-machine-authority' },
        { id: 'temp', reason: 'exclude-machine-authority' },
        { id: 'migration-backups', reason: 'exclude-machine-authority' },
        { id: 'machine-authority-fields', reason: 'exclude-machine-authority' },
        ...(provided.omittedItems ?? []),
      ],
      transferReceiptIds: [transferAuthority.receiptId, ...(provided.transferReceiptIds ?? [])],
      historyProjectionIds,
    }
    const stagedArchivePath = path.join(attemptRoot, 'portable-project.archive')
    const archiveReceipt = await writePortableProjectArchive({ manifest, sources, targetPath: stagedArchivePath })
    recordOwnedFile(attempt, stagedArchivePath)
    input.__testHooks?.afterArchiveBuilt?.(stagedArchivePath)

    await assertCurrentContext(input, frozenContext, sourceRoot)
    const finalVerificationSnapshotPath = path.join(attemptRoot, 'source-final-verification.db')
    let finalEvidence: ProjectSqliteEvidence
    try { finalEvidence = await backupProjectSqlite({
      sourceDatabasePath,
      targetDatabasePath: finalVerificationSnapshotPath,
    }) } catch (error) { return mapSourceChange(error) }
    recordOwnedFile(attempt, finalVerificationSnapshotPath)
    if (!sameEvidence(firstEvidence, finalEvidence)) fail('PORTABLE_SOURCE_CHANGED')
    let finalProviderUnchanged: boolean | void
    try { finalProviderUnchanged = await provided.verifyUnchanged() }
    catch { fail('PORTABLE_SOURCE_CHANGED') }
    if (finalProviderUnchanged === false) fail('PORTABLE_SOURCE_CHANGED')
    for (const file of provided.files) await verifyFile(file, projectStorageRoot)
    for (const source of sources.filter(item => item.entry.disposition === 'avatar-asset')) {
      const info = regularFile(source.sourcePath, 'PORTABLE_ASSET_MISSING')
      if (info.size !== source.entry.byteSize || await hashFile(source.sourcePath) !== source.entry.sha256) {
        fail('PORTABLE_SOURCE_CHANGED')
      }
    }
    const targetInfo = publishStagedArchive(stagedArchivePath, targetPath)
    return {
      originProjectId: canonicalManifest.projectId,
      snapshotGeneration,
      targetSha256: await hashFile(targetPath),
      targetByteSize: Number(targetInfo.size),
      sourceEvidence: {
        schemaVersion: firstEvidence.schemaVersion,
        schemaFingerprint: firstEvidence.fingerprint,
        tableCount: PORTABLE_FIELD_POLICY_COUNTS.tables,
        fieldCount: PORTABLE_FIELD_POLICY_COUNTS.fields,
      },
      entryCount: archiveReceipt.entryCount,
      requiresRuntimeFreezeGuard: true,
    }
  } finally {
    cleanupAttempt(attempt)
  }
}
