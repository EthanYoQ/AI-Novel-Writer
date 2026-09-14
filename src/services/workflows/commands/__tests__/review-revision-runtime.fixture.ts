import { createHash } from 'node:crypto'
import type { WorkflowGenerationRuntimeDependencies } from '../base-command'
import type { ReviewRevisionCommandSource } from '../review-revision-command'
import type { PrepareReviewRevisionRequest, PreparedReviewRevisionContext, ReviewRevisionRecovery } from '../../../../shared/review-revision-generation'
import type { MainGenerationSnapshot } from '../../../generation/generation-runtime'
import { freezeChapterGoals } from '../../../../shared/chapter-goal-review'
import { buildReviewGenerationReport } from '../../../../shared/review-generation-report'
import { findBlueprintContinuityRisks } from '../../../../shared/consistency-preflight'
import { parseHumanConfirmedReviewSnapshot, serializeHumanConfirmedReviewSnapshot, hasIncludedReviewItems } from '../../../../shared/human-confirmed-review'
import { composeVisibleContinuation } from '../../../../shared/visible-continuation'
import { redactVisibleCompletionText } from '../../bounded-completion'
import { useProjectStore } from '../../../../stores/project-store'
import type { ExpectedDraftSource } from '../../../../shared/ipc-channels'

const digest = (text: string) => createHash('sha256').update(text).digest('hex')
type Backend = (channel: string, ...args: unknown[]) => Promise<unknown>

/** Consumer-only transport double. Legacy backend callbacks retain their existing domain assertions;
 * actual main authority/SQLite/ledger tests live in the Electron suites, not in this adapter. */
export class ReviewRevisionRuntimeFixture {
  selected?: ReviewRevisionCommandSource
  writingLanguage: 'zh-CN' | 'en-US' = 'zh-CN'
  parentModelId = 'model-a'
  parentRootActionId = 'fixture-review-root'
  prepared?: PreparedReviewRevisionContext
  recovery?: ReviewRevisionRecovery
  selections: unknown[] = []
  calls: Array<{ channel: string; args: unknown[] }> = []
  artifacts = new Map<string, MainGenerationSnapshot>()
  private sequence = 0
  private activeHandle?: ReviewRevisionRecovery['handle']
  constructor(private readonly backend: Backend) {}

  private async optional<T>(channel: string, fallback: T, ...args: unknown[]): Promise<T> {
    try { return await this.backend(channel, ...args) as T ?? fallback } catch (error) {
      if (error instanceof Error && /unexpected|unhandled|not mocked/iu.test(error.message)) return fallback
      throw error
    }
  }

  private async source(): Promise<ExpectedDraftSource> {
    const selected = this.selected
    if (!selected) throw new Error('fixture selected source required')
    const fallback = { id: 1, chapterNumber: selected.chapterNumber, version: 1, status: 'draft' as const,
      ...selected.sourceDraft, content: selected.draftContent }
    const row = await this.optional('db:draft-get-full', fallback, fallback.id)
    return { id: row.id, chapterNumber: row.chapterNumber, version: row.version, status: row.status, content: row.content }
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    this.calls.push({ channel, args })
    if (channel === 'db:draft-get-meta') {
      const source = await this.source()
      return this.optional(channel, { ...source, source: 'write' }, ...args)
    }
    if (channel === 'db:draft-get-full') return this.source()
    if (channel === 'review-revision:prepare') {
      const request = args[0] as PrepareReviewRevisionRequest
      const source = await this.source()
      if (source.id !== request.draftId || source.version !== request.expectedDraft.version
        || source.status !== request.expectedDraft.status || source.chapterNumber !== request.expectedDraft.chapterNumber
        || digest(source.content) !== request.expectedDraft.contentHash) throw new Error('源草稿已变化 / source draft changed')
      const currentConfig = useProjectStore.getState().currentProject?.novelConfig
      if (!currentConfig) throw new Error('Review runtime fixture requires a project config')
      const config = structuredClone(currentConfig)
      const core = await this.optional<Record<string, string>>('db:project-core-get', {})
      const blueprints = await this.optional<PreparedReviewRevisionContext['context']['blueprints']>('db:blueprint-get-all', [])
      const blueprint = await this.optional<PreparedReviewRevisionContext['context']['blueprints'][number] | null>('db:blueprint-get', null, source.chapterNumber)
      if (!blueprints.length && blueprint) blueprints.push(blueprint)
      const projections = await this.optional<NonNullable<PreparedReviewRevisionContext['context']['history'][number]['projection']>[]>('db:continuity-list-before', []).catch(() => [])
      const exemptions = await this.optional<Parameters<typeof findBlueprintContinuityRisks>[2]>('db:consistency-exemption-list', [])
      const characters = await this.optional<Array<{ name: string; role?: string; currentState?: Record<string, unknown> }>>('db:character-get-all', [])
      const frozen: PreparedReviewRevisionContext['context'] = {
        version: 1, operation: request.operation, source, sourceHash: digest(source.content), config,
        writingLanguage: config.writingLanguage ?? this.writingLanguage, uiLocale: request.uiLocale,
        authorInputs: request.authorInputs, characterStates: characters.map(c => `${c.name} (${c.role || 'unknown'})`).join('\n'),
        worldbuilding: core.worldbuilding || '', history: projections.map(p => ({ draftId: p.draftId,
          chapterNumber: p.chapterNumber, chapterTitle: p.chapterTitle, content: p.chapterNotes, projection: p })),
        blueprints: blueprints.filter(b => b.chapterNumber >= source.chapterNumber && b.chapterNumber <= source.chapterNumber + 5),
        frozenGoals: freezeChapterGoals(source.chapterNumber, blueprints.find(b => b.chapterNumber === source.chapterNumber)?.keyEvents ?? null),
        preflightFindings: blueprint ? findBlueprintContinuityRisks(projections, blueprint, exemptions) : [],
      }
      if (request.operation === 'refine-from-review') {
        const row = await this.optional<{ id: number; baseDraftId: number; content: string; sourceDraft: ExpectedDraftSource } | null>('db:review-get-full', null, request.reviewSourceId)
        const snapshot = row ? parseHumanConfirmedReviewSnapshot(row.content) : null
        const requested = request.confirmedReviewContent ? parseHumanConfirmedReviewSnapshot(request.confirmedReviewContent) : null
        if (!row || row.id !== request.reviewSourceId || row.baseDraftId !== source.id || !snapshot?.sourceDraft || !requested
          || !hasIncludedReviewItems(snapshot) || serializeHumanConfirmedReviewSnapshot(snapshot) !== serializeHumanConfirmedReviewSnapshot(requested)
          || JSON.stringify(row.sourceDraft) !== JSON.stringify(snapshot.sourceDraft)
          || JSON.stringify(snapshot.sourceDraft) !== JSON.stringify(source)) throw new Error('缺少有效的已确认审稿清单 / A confirmed review checklist is required')
        frozen.confirmation = { reviewSourceId: row.id, content: row.content, originalReviewContentHash: 'a'.repeat(64), snapshot }
      }
      this.prepared = { contextId: 'fixture-context', context: structuredClone(frozen),
        ...(request.operation === 'refine-from-review' ? { parentRootActionId: this.parentRootActionId, modelId: this.parentModelId } : {}) }
      this.recovery = undefined
      return structuredClone(this.prepared)
    }
    if (channel === 'review-revision:read-recovery') {
      if (!this.recovery) throw new Error('fixture recovery absent')
      return structuredClone(this.recovery)
    }
    if (channel === 'generation:read-visible-composition') return this.recovery?.composition ?? null
    if (channel === 'generation:compose-visible') {
      const ids = args[1] as string[]
      let text = ''
      const artifacts = ids.map(id => this.artifacts.get(id)!)
      for (const artifact of artifacts) text = text ? composeVisibleContinuation(text, artifact.text) : artifact.text.trim()
      if (digest(text) !== args[2] || !this.recovery) throw new Error('fixture composition mismatch')
      this.recovery.composition = { algorithm: 'visible-append-v1', text, textHash: digest(text), artifactIds: ids,
        sources: artifacts.map(a => ({ artifactId: a.artifactId, revision: a.revision, textHash: a.textHash })) }
      this.recovery.lastCompositionFinishReason = this.recovery.latestArtifactFinishReason
      return structuredClone(this.recovery.composition)
    }
    if (channel === 'review-revision:commit-review' || channel === 'review-revision:commit-revision') {
      const recovery = this.recovery!
      const frozen = recovery.context
      if (recovery.saved) return structuredClone(recovery.saved)
      const content = channel === 'review-revision:commit-review'
        ? JSON.stringify(buildReviewGenerationReport({ content: recovery.latestArtifact!.text, sourceContent: frozen.source.content,
          frozenGoals: frozen.frozenGoals, writingLanguage: frozen.writingLanguage, uiLocale: frozen.uiLocale, preflightFindings: frozen.preflightFindings }), null, 2)
        : recovery.composition!.text
      const review = channel === 'review-revision:commit-review'
      const result = await this.backend(review ? 'db:review-create' : 'db:revision-replace-pending', {
        baseDraftId: frozen.source.id, content, expectedSource: frozen.source,
        ...(review ? {} : { revisionType: frozen.operation === 'refine-draft' ? 'refine' : 'review-fix', wordCount: content.length,
          ...(frozen.confirmation ? { reviewSourceId: frozen.confirmation.reviewSourceId, userPrompt: frozen.confirmation.snapshot.authorGuidance || undefined } : {}) }),
      }) as { success: boolean; id?: number; reviewIndex?: number; revisionIndex?: number; error?: string; errorCode?: string }
      if (!result.success) throw new Error(result.errorCode === 'SOURCE_DRAFT_CHANGED' ? 'SOURCE_DRAFT_CHANGED' : result.error)
      recovery.saved = { success: true, kind: review ? 'review' : 'revision', id: result.id ?? 9,
        index: result.reviewIndex ?? result.revisionIndex ?? 1, content, contentHash: digest(content), source: frozen.source,
        ...(review ? {} : { revisionStatus: 'pending' }) }
      return structuredClone(recovery.saved)
    }
    return this.backend(channel, ...args)
  }

  record(content: string, finishReason = 'stop'): void {
    if (!this.recovery || !this.activeHandle) throw new Error('fixture runtime absent')
    const text = redactVisibleCompletionText(content)
    const artifact = { ...this.activeHandle, artifactId: 'fixture-artifact-' + (++this.sequence), attemptId: 'fixture-attempt-' + this.sequence,
      revision: 1, text, textHash: digest(text) } as MainGenerationSnapshot
    this.artifacts.set(artifact.artifactId, artifact)
    this.recovery.latestArtifact = artifact
    this.recovery.latestArtifactFinishReason = finishReason
  }

  wrap(dependencies: WorkflowGenerationRuntimeDependencies): WorkflowGenerationRuntimeDependencies {
    return { createRuntime: async (options, main) => {
      if (!main || !this.prepared && !this.recovery) throw new Error('fixture main preparation required')
      this.selections.push(main.selection)
      const handle = main.selection.resumeHandle ?? { projectId: main.context.projectSession!.projectId,
        epoch: main.context.projectSession!.leaseId, runId: 'fixture-run', rootActionId: this.prepared?.parentRootActionId ?? 'fixture-root' }
      this.activeHandle = handle
      main.context.mainGenerationRunHandle = handle
      main.context.mainGenerationRootHandle = handle
      if (!this.recovery) this.recovery = { handle, context: structuredClone(this.prepared!.context), contextId: this.prepared!.contextId,
        modelId: options.modelId ?? 'model-a', sourceStatus: 'current', attemptedPurposes: [] }
      await main.selection.onRunOpened?.(handle)
      const runtime = await dependencies.createRuntime(options)
      return { mainOwned: true, close: () => runtime.close(), execute: operation => runtime.execute(({ session }) => operation({ session: {
        budget: session.budget,
        complete: async (task, executionOptions) => {
          const current = await this.source()
          if (JSON.stringify(current) !== JSON.stringify(this.recovery!.context.source)) throw new Error('源草稿已变化 / source draft changed')
          this.recovery!.attemptedPurposes.push(task.purpose)
          const outcome = await session.complete(task, executionOptions)
          this.record(outcome.content, outcome.finishReason)
          main.callbacks.appendText(redactVisibleCompletionText(outcome.content))
          const artifact = this.recovery!.latestArtifact!
          return { ...outcome, receipt: { ...outcome.receipt, visibleArtifact: { artifactId: artifact.artifactId,
            attemptId: artifact.attemptId, revision: artifact.revision, textHash: artifact.textHash } } }
        },
      } })) }
    } }
  }
}
