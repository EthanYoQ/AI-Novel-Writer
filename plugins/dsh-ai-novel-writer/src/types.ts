import type { Branded } from '@deepseek-ai/dsh-brand'
import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Stable identity stored in one Harness novel project manifest. */
export type NovelProjectId = Branded<'NovelProjectId'>

/** SHA-256 revision of normalized file bytes, or the explicit missing value. */
export type Revision = Branded<'Revision'> | 'absent'

/** Project-level writing policy. It does not configure provider reasoning. */
export type CreativeStrategy = 'auto' | 'fluent-drafting' | 'consistency-first' | 'deep-planning'

/** A project-owned asset. Arbitrary filesystem paths are intentionally absent. */
export type AssetRef =
  | { readonly kind: 'project' }
  | { readonly kind: 'characters' }
  | { readonly kind: 'story-blueprint' }
  | { readonly kind: 'chapter-blueprint'; readonly chapter: number }
  | { readonly kind: 'chapter-draft'; readonly chapter: number }

/** Initialization data supplied by the model-facing mutation tool. */
export interface NovelInitializeRequest {
  readonly kind: 'initialize'
  readonly projectId: NovelProjectId
  readonly title: string
  readonly language: string
  readonly genre: string
  readonly plannedChapters: number
  readonly targetWordsPerChapter: number
  readonly creativeStrategy: CreativeStrategy
  readonly createdAt: string
  readonly updatedAt: string
}

/** Compare-and-replace request for one novel asset. */
export interface NovelReplaceRequest {
  readonly kind: 'replace'
  readonly target: AssetRef
  readonly baseRevision: Revision
  readonly baseText: string
  readonly replacement: string
  readonly summary: string
}

/** Every mutation accepted by a {@link NovelProject}. */
export type NovelApplyRequest = NovelInitializeRequest | NovelReplaceRequest

/** Every bounded read accepted by a {@link NovelProject}. */
export type NovelReadRequest =
  | { readonly kind: 'asset'; readonly target: AssetRef }
  | { readonly kind: 'working-set'; readonly chapter?: number }
  | { readonly kind: 'query'; readonly text: string; readonly limit?: number }

/** One exact asset read. */
export interface NovelAssetReadResult {
  readonly kind: 'asset'
  readonly target: AssetRef
  readonly source: string
  readonly revision: Revision
  readonly text: string
  readonly bytes: number
  readonly truncated: boolean
  readonly omitted: boolean
}

/** A bounded group of project assets used for one writing step. */
export interface NovelWorkingSetResult {
  readonly kind: 'working-set'
  readonly assets: readonly NovelAssetReadResult[]
  readonly bytes: number
  readonly truncated: boolean
  readonly omittedSources: readonly string[]
}

/** One textual match from a bounded query. */
export interface NovelQueryMatch {
  readonly source: string
  readonly revision: Revision
  readonly excerpt: string
  readonly truncated: boolean
}

/** A bounded text query result. */
export interface NovelQueryResult {
  readonly kind: 'query'
  readonly matches: readonly NovelQueryMatch[]
  readonly truncated: boolean
}

/** Canonical result of a project read. */
export type NovelReadResult = NovelAssetReadResult | NovelWorkingSetResult | NovelQueryResult

/** Deterministic evidence that one asset replacement committed. */
export interface CommitReceipt {
  readonly projectId: NovelProjectId
  readonly target: AssetRef
  readonly oldRevision: Revision
  readonly newRevision: Revision
  readonly bytes: number
}

/** The complete public domain interface exposed to tools and tests. */
export interface NovelProject {
  /**
   * Read one bounded projection of the current project state.
   *
   * @param request Asset, working-set, or bounded-query selection.
   * @param signal Cancellation signal checked before filesystem work and while reading.
   * @returns The normalized text, revision, sources, and omission metadata for the selection.
   * @throws {@link NovelProjectError} when the project or durable asset is invalid, unsafe, too large, or unavailable.
   */
  read(request: NovelReadRequest, signal: AbortSignal): Promise<NovelReadResult>
  /**
   * Atomically initialize or compare-and-replace one project asset.
   *
   * @param request Initialization data or a one-asset revision-checked replacement.
   * @param signal Cancellation signal honored until the atomic replacement starts.
   * @returns A receipt containing the project identity and committed old and new revisions.
   * @throws {@link NovelProjectError} when validation, approval state, revision checks, cancellation, or the atomic write fails.
   */
  apply(request: NovelApplyRequest, signal: AbortSignal): Promise<CommitReceipt>
}

/** Stable domain failures exposed by the project module. */
export type NovelProjectErrorCode =
  | 'NOT_INITIALIZED'
  | 'ALREADY_INITIALIZED'
  | 'UNSUPPORTED_FORMAT'
  | 'ASSET_NOT_FOUND'
  | 'INVALID_CONTENT'
  | 'PATH_REJECTED'
  | 'SIZE_LIMIT_EXCEEDED'
  | 'STALE_REVISION'
  | 'APPROVAL_REJECTED'
  | 'WRITE_FAILED'
  | 'CANCELLED'

/** Error carrying a stable machine-readable novel-project code. */
export class NovelProjectError extends HarnessError {
  declare readonly code: NovelProjectErrorCode

  /**
   * Create a stable novel-project failure.
   *
   * @param code Machine-readable failure code.
   * @param message Human-readable failure detail.
   * @param options Standard error cause options.
   */
  constructor(code: NovelProjectErrorCode, message: string, options?: ErrorOptions) {
    super(message, code, options)
  }
}
