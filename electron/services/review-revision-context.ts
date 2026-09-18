import type Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import type { ExpectedDraftSource, NovelConfig } from '../../src/shared/ipc-channels'
import type { PrepareReviewRevisionRequest, ReviewMaterialIdentity, ReviewRevisionContext } from '../../src/shared/review-revision-generation'
import { parseHumanConfirmedReviewSnapshot, serializeHumanConfirmedReviewSnapshot } from '../../src/shared/human-confirmed-review'
import { freezeChapterGoals } from '../../src/shared/chapter-goal-review'
import { findBlueprintContinuityRisks } from '../../src/shared/consistency-preflight'
import { CHARACTER_STATE_TEXT_FIELDS } from '../../src/shared/character-roster'
import { ProjectCoreRepository } from '../repositories/project-core-repository'
import { CharacterRepository } from '../repositories/character-repository'
import { BlueprintRepository } from '../repositories/blueprint-repository'
import { SummaryRepository } from '../repositories/summary-repository'
import { ConsistencyExemptionRepository } from '../repositories/consistency-exemption-repository'
import { ReviewRepository } from '../repositories/review-repository'
import { textHash } from '../repositories/generation-run-repository'

export const REVIEW_REVISION_OPERATIONS = ['review-chapter', 'refine-draft', 'refine-from-review'] as const
const fail = (): never => { throw new Error('GENERATION_REVIEW_CONTEXT_INVALID') }

/** Reconstruct only the original author selection, never a newer manuscript or confirmation. */
export function reviewRevisionRequest(context: ReviewRevisionContext): PrepareReviewRevisionRequest {
  return { operation: context.operation, draftId: context.source.id,
    expectedDraft: { chapterNumber: context.source.chapterNumber, version: context.source.version,
      status: context.source.status, contentHash: context.sourceHash },
    authorInputs: structuredClone(context.authorInputs), uiLocale: context.uiLocale,
    ...(context.confirmation ? { reviewSourceId: context.confirmation.reviewSourceId, confirmedReviewContent: context.confirmation.content } : {}) }
}

/**
 * Captured DB is the authority. The returned material is also re-read on dispatch/resume/save.
 *
 * Only the project id enters the captured identity: the session lease (`epoch`) is deliberately
 * NOT an input, so the result is a pure function of `(db, request)` and therefore identical across
 * a reopen. The live lease is attached to the `SourceRef` at the point of use instead.
 */
export function captureReviewRevisionContext(db: Database.Database, request: PrepareReviewRevisionRequest,
  projectId: string): ReviewRevisionContext {
  if (!request || Object.keys(request).some(key => !['operation', 'draftId', 'expectedDraft', 'reviewSourceId', 'confirmedReviewContent', 'authorInputs', 'uiLocale'].includes(key))
    || !REVIEW_REVISION_OPERATIONS.includes(request.operation) || !Number.isSafeInteger(request.draftId) || request.draftId < 1
    || !['zh-CN', 'en-US'].includes(request.uiLocale) || !request.expectedDraft
    || Object.keys(request.expectedDraft).some(key => !['chapterNumber', 'version', 'status', 'contentHash'].includes(key))
    || !Array.isArray(request.authorInputs) || request.authorInputs.length > 2) fail()
  const allowedInputs = request.operation === 'refine-draft' ? ['user-prompt', 'merged-guidance'] : request.operation === 'review-chapter' ? ['review-focus'] : []
  if (new Set(request.authorInputs.map(item => item?.id)).size !== request.authorInputs.length
    || request.authorInputs.some(item => !item || Object.keys(item).some(key => !['id', 'text'].includes(key))
      || !allowedInputs.includes(item.id) || typeof item.text !== 'string' || Buffer.byteLength(item.text) > 8 * 1024 * 1024)) fail()
  if (request.operation !== 'refine-from-review' && (request.reviewSourceId !== undefined || request.confirmedReviewContent !== undefined)) fail()
  return db.transaction((): ReviewRevisionContext => {
    const source = db.prepare('SELECT d.id,d.chapter_number AS chapterNumber,d.version,d.status,c.body AS content FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.id=?')
      .get(request.draftId) as ExpectedDraftSource | undefined
    const latest = source && db.prepare("SELECT id FROM drafts WHERE chapter_number=? AND status IN ('draft','revised','finalized') ORDER BY version DESC,id DESC LIMIT 1").pluck().get(source.chapterNumber)
    if (!source || latest !== source.id || !isDeepStrictEqual(request.expectedDraft,
      { chapterNumber: source.chapterNumber, version: source.version, status: source.status, contentHash: textHash(source.content) }))
      throw new Error('GENERATION_REVIEW_SOURCE_CHANGED')
    const core = ProjectCoreRepository.get(db)
    if (!core) throw new Error('GENERATION_REVIEW_CONTEXT_INVALID')
    const config: NovelConfig = { genre: core.genre, subGenre: core.subGenre, targetAudience: core.targetAudience,
      totalChapters: core.totalChapters, wordsPerChapter: core.wordsPerChapter, writingLanguage: core.writingLanguage,
      creativeStrategy: core.creativeStrategy, narrativeThreadDormantChapterThreshold: core.narrativeThreadDormantChapterThreshold,
      plotStructure: core.plotStructure as NovelConfig['plotStructure'], narrativePOV: core.narrativePov as NovelConfig['narrativePOV'],
      writingStyle: core.writingStyle, referenceWorks: core.referenceWorks, globalGuidance: core.globalGuidance,
      goldenFinger: core.goldenFinger, coreOutline: core.coreOutline, worldSetting: core.worldSetting, protagonistProfile: core.protagonistProfile }
    let confirmation: ReviewRevisionContext['confirmation']
    if (request.operation === 'refine-from-review') {
      if (!Number.isSafeInteger(request.reviewSourceId) || request.reviewSourceId! < 1 || typeof request.confirmedReviewContent !== 'string') fail()
      const stored = ReviewRepository.getFull(request.reviewSourceId!, db)
      const snapshot = stored && parseHumanConfirmedReviewSnapshot(stored.content)
      const requested = parseHumanConfirmedReviewSnapshot(request.confirmedReviewContent!)
      const original = snapshot && ReviewRepository.getFull(snapshot.sourceReviewId, db)
      if (!stored || !snapshot || !requested || !original || snapshot.sourceReviewId === stored.id
        || !isDeepStrictEqual(stored.sourceDraft, source) || !isDeepStrictEqual(snapshot.sourceDraft, source)
        || !isDeepStrictEqual(original.sourceDraft, source) || stored.baseDraftId !== source.id || original.baseDraftId !== source.id
        || !snapshot.items.some(item => item.decision === 'apply')
        || serializeHumanConfirmedReviewSnapshot(snapshot) !== serializeHumanConfirmedReviewSnapshot(requested))
        throw new Error('GENERATION_REVIEW_CONFIRMATION_CHANGED')
      confirmation = { reviewSourceId: stored.id, content: serializeHumanConfirmedReviewSnapshot(snapshot), snapshot,
        originalReviewContentHash: textHash(original.content) }
    }
    const blueprints = BlueprintRepository.getAll(db).filter(row => row.chapterNumber >= source.chapterNumber && row.chapterNumber <= source.chapterNumber + 5)
      .map(({ chapterNumber, title, role, purpose, keyEvents, characters, suspenseHook, userGuidance, notes }) =>
        ({ chapterNumber, title, role, purpose, keyEvents, characters, suspenseHook, userGuidance, notes }))
    const currentBlueprint = blueprints.find(row => row.chapterNumber === source.chapterNumber)
    const projections = SummaryRepository.listFinalizedContinuityBefore(source.chapterNumber, db)
    const rows = db.prepare("SELECT d.id,d.chapter_number,d.version,c.body,o.finalization_id,o.chapter_title,o.content_hash,o.content_snapshot FROM drafts d JOIN contents c ON c.id=d.content_id LEFT JOIN finalization_outbox o ON o.draft_id=d.id WHERE d.status='finalized' AND d.chapter_number < ? AND NOT EXISTS (SELECT 1 FROM drafts n WHERE n.chapter_number=d.chapter_number AND n.status='finalized' AND (n.version>d.version OR n.version=d.version AND n.id>d.id)) ORDER BY d.chapter_number,d.id")
      .all(source.chapterNumber) as { id: number; chapter_number: number; version: number; body: string; finalization_id: string | null; chapter_title: string | null; content_hash: string | null; content_snapshot: string | null }[]
    const history = rows.map(row => {
      if (row.finalization_id && (row.content_hash !== textHash(row.body) || row.content_snapshot !== row.body))
        throw new Error('GENERATION_REVIEW_HISTORY_CHANGED')
      const contentHash = textHash(row.body)
      const sourceIdentity = row.finalization_id ? { draftId: row.id, finalizationId: row.finalization_id, chapterNumber: row.chapter_number, contentHash } : undefined
      const projection = projections.find(item => item.draftId === row.id && item.sourceStatus === 'current' && isDeepStrictEqual(item.source, sourceIdentity))
      // 只增不减：身份走共享选择契约，不改变任何现有消费方读取的字段。
      // 有终稿 outbox 凭据的是已证明的定稿；否则是旧版定稿（legacy），两者都不是 author。
      // 身份**不含会话租约**：租约由使用方按当前会话补上，重开后同一份材料身份逐字段不变。
      const materialIdentity: ReviewMaterialIdentity = { projectId,
        sourceId: `finalized:${row.id}`, revision: row.id, contentHash,
        provenance: row.finalization_id ? 'finalized' : 'legacy' }
      return { draftId: row.id, chapterNumber: row.chapter_number, chapterTitle: row.chapter_title ?? '', content: row.body,
        identity: materialIdentity, ...(sourceIdentity ? { source: sourceIdentity } : {}), ...(projection ? { projection } : {}) }
    })
    const activeIds = new Set((db.prepare('SELECT character_id FROM characters WHERE retired=0').all() as { character_id: string }[]).map(row => row.character_id))
    const stateLines = CharacterRepository.getAll(db).filter(card => card.characterId && activeIds.has(card.characterId)).flatMap(card => {
      const state = card.currentState
      if (!state) return []
      const fields = Object.fromEntries(CHARACTER_STATE_TEXT_FIELDS.flatMap(field => {
        const provenance = state.provenance?.[field]
        return provenance?.kind === 'author' && state[field] ? [[field, `${state[field]} @ch${provenance.chapterNumber}`]] : []
      }))
      if (!Object.keys(fields).length) return []
      return [core.writingLanguage === 'en-US'
        ? `${card.name} (${card.role || 'unknown'}) author state (time-bound to the annotated chapter, not permanent): ${JSON.stringify(fields)}`
        : `${card.name}（${card.role || '未知'}）作者状态（按标注章节理解，非永久约束）: ${JSON.stringify(fields)}`]
    })
    return { version: 1, operation: request.operation, source, sourceHash: textHash(source.content), config,
      writingLanguage: core.writingLanguage, uiLocale: request.uiLocale, authorInputs: structuredClone(request.authorInputs),
      characterStates: stateLines.join('\n') || (core.writingLanguage === 'en-US' ? '(none)' : '（暂无）'),
      worldbuilding: core.worldbuilding, history, blueprints,
      frozenGoals: freezeChapterGoals(source.chapterNumber, currentBlueprint?.keyEvents),
      preflightFindings: currentBlueprint ? findBlueprintContinuityRisks(history.flatMap(item => item.projection ? [item.projection] : []), currentBlueprint, ConsistencyExemptionRepository.list(db)) : [],
      ...(confirmation ? { confirmation } : {}) }
  })()
}
