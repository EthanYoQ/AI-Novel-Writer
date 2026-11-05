import { randomUUID } from 'node:crypto'

import type {
  ChapterDeletionOperation,
  ChapterDeletionResult,
  ChapterTrashListResult,
  DeleteFinalizedChapterRequest,
  PurgeTrashRequest,
  PurgeTrashResult,
  RestoreTrashedChapterRequest,
  RestoreTrashedChapterResult,
} from '../../src/shared/chapter-deletion'
import { CHAPTER_RESTORE_MODES } from '../../src/shared/chapter-deletion'
import { CHAPTER_RESTORED_REPROJECTION_PENDING } from '../../src/shared/finalization-step-error'
import { getCurrentProjectPath, getProjectDb } from '../database'
import { assertRequiredExpectedProjectPath } from '../utils/project-context'
import { ChapterDeletionRepository } from '../repositories/chapter-deletion-repository'
import { FinalizationRepository } from '../repositories/finalization-repository'
import { GenerationRunRepository } from '../repositories/generation-run-repository'
import { PostProcessRepository } from '../repositories/post-process-repository'
import { FinalizationService } from './finalization-service'
import { GenerationDraftEffects } from './generation-draft-effects'
import { knowledgeBaseLoader } from './knowledge-base-loader'
import { removeManuscriptIfUnchanged, republishTarget, serializeManuscript } from './manuscript-publisher'
import { readPortableRuntimeFreeze } from './portable-runtime-freeze'

export interface ChapterDeletionProjectionCleaner {
  /** published 是这次定稿发布出的实体稿内容；文件内容不在其中就不是这份定稿的，保留不删。 */
  removeManuscript(projectRoot: string, targetFileName: string, published: readonly string[]): Promise<void>
  removeKnowledgeDocument(projectRoot: string, documentId: string): Promise<void>
}

export interface ChapterDeletionServiceOptions {
  createOperationId?: () => string
  cleaner?: ChapterDeletionProjectionCleaner
  finalizations?: Pick<FinalizationService, 'retry'>
}

/** 删除清理删实体稿：只删内容仍是这份定稿发布出的那份，其余（作者的文件、改过的、别的定稿）原样保留。 */
export async function removeDeletedManuscript(projectRoot: string, targetFileName: string, published: readonly string[]): Promise<void> {
  removeManuscriptIfUnchanged(projectRoot, targetFileName, published)
}

const defaultCleaner: ChapterDeletionProjectionCleaner = {
  removeManuscript: removeDeletedManuscript,
  async removeKnowledgeDocument(projectRoot, documentId) {
    const result = await knowledgeBaseLoader.run((kb) => kb.removeDocument(documentId, projectRoot))
    if (result !== true) {
      if (result && typeof result === 'object' && 'errorCode' in result) {
        throw new Error('KNOWLEDGE_BASE_NATIVE_UNAVAILABLE')
      }
      throw new Error('CHAPTER_DELETE_KNOWLEDGE_NOT_REMOVED')
    }
  },
}

/**
 * 这次删除要清理的实体稿当初发布出的内容。同名文件可能已经不是它：作者删后放了别的文件，
 * 或作为旧版本放回的行还记着旧文件名。只删内容一致的；行已彻底删除、读不到快照时一律保留。
 */
function publishedManuscripts(operation: ChapterDeletionOperation): string[] {
  const snapshot = ChapterDeletionRepository.publishedSnapshot(operation.finalizationId)
  return snapshot ? [serializeManuscript(snapshot)] : []
}

/** 每项投影各自的失败原因留在 operation 的 manuscriptError、knowledgeError 上，由删除清理提示逐项显示。 */
function operationError(operation: ChapterDeletionOperation): string | undefined {
  return operation.status === 'failed' ? 'CHAPTER_DELETE_CLEANUP_INCOMPLETE' : undefined
}

function legacyKnowledgeAuthorizationRequired(
  operation: ChapterDeletionOperation,
): ChapterDeletionResult {
  return {
    success: false,
    committed: false,
    operation,
    error: 'CHAPTER_DELETE_LEGACY_KNOWLEDGE_CHECK_REQUIRED',
  }
}

function frozenLegacyOperation(projectRoot: string, operation: ChapterDeletionOperation): ChapterDeletionResult | null {
  if (!readPortableRuntimeFreeze(projectRoot).isFrozen('chapter_deletion_operations', operation.operationId)) return null
  return { success: false, committed: false, error: 'CHAPTER_DELETE_LEGACY_OPERATION_FROZEN' }
}

const isId = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

function validRestoreRequest(request: RestoreTrashedChapterRequest): boolean {
  return typeof request === 'object' && request !== null && isId(request.deletionId) && Number.isSafeInteger(request.draftId) && request.draftId > 0
    && CHAPTER_RESTORE_MODES.includes(request.expectedMode)
}

function purgeTargets(request: PurgeTrashRequest): readonly string[] | 'all' | null {
  if (typeof request !== 'object' || request === null) return null
  if ('all' in request) return request.all === true ? 'all' : null
  return Array.isArray(request.deletionIds) && request.deletionIds.length > 0 && request.deletionIds.every(isId)
    ? request.deletionIds
    : null
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

export class ChapterDeletionService {
  private readonly createOperationId: () => string
  private readonly cleaner: ChapterDeletionProjectionCleaner
  private readonly finalizations: Pick<FinalizationService, 'retry'>
  /** 删除、恢复、彻底删除串行：恢复后重发实体稿期间又删这一章，删除清理要排在重发之后，否则重发的文件留在已删章外面。 */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: ChapterDeletionServiceOptions = {}) {
    this.createOperationId = options.createOperationId ?? randomUUID
    this.cleaner = options.cleaner ?? defaultCleaner
    this.finalizations = options.finalizations ?? new FinalizationService()
  }

  /**
   * 排队等到的工作开始前、跨过 await 之后，都要确认打开的还是发起它的那部作品；作品换了就拒绝，不碰另一部作品的库。
   * 清理中途被拒时，原作品的收据停在待续跑，重新打开后照常重试（清理本身是幂等的）。
   */
  private assertOwner(projectRoot: string): void {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), projectRoot)
  }

  private exclusive<T>(projectRoot: string, work: () => Promise<T>): Promise<T> {
    const owned = () => { this.assertOwner(projectRoot); return work() }
    const run = this.queue.then(owned, owned)
    this.queue = run.catch(() => undefined)
    return run
  }

  delete(projectRoot: string, request: DeleteFinalizedChapterRequest): Promise<ChapterDeletionResult> {
    return this.exclusive(projectRoot, async () => {
      const existing = ChapterDeletionRepository.getByDraftId(request.draftId)
      if (existing) {
        if (existing.draftId !== request.draftId || existing.chapterNumber !== request.chapterNumber) {
          return { success: false, committed: false, error: 'CHAPTER_DELETE_REQUEST_MISMATCH' }
        }
        const frozen = frozenLegacyOperation(projectRoot, existing)
        if (frozen) return frozen
        if (existing.legacyKnowledgeAuthorization === 'required') {
          return legacyKnowledgeAuthorizationRequired(existing)
        }
        return this.resume(projectRoot, existing.operationId)
      }
      const requiresLegacyKnowledgeAuthorization = this.requiresLegacyKnowledgeAuthorization(request)
      const frozen = ChapterDeletionRepository.begin({
        operationId: this.createOperationId(),
        draftId: request.draftId,
        chapterNumber: request.chapterNumber,
        legacyKnowledgeAuthorizationRequired: requiresLegacyKnowledgeAuthorization,
      })
      if (requiresLegacyKnowledgeAuthorization) {
        return legacyKnowledgeAuthorizationRequired(frozen)
      }
      return this.resume(projectRoot, frozen.operationId)
    })
  }

  /** 从回收站恢复后、知识库重导前，kb_import 记着恢复码：确知没有知识投影，不该再要旧定稿知识授权。 */
  private requiresLegacyKnowledgeAuthorization(request: DeleteFinalizedChapterRequest): boolean {
    const finalization = FinalizationRepository.getByDraftId(request.draftId)
    if (!finalization || finalization.knowledgeDocumentId) return false
    const run = PostProcessRepository.getLatestRun('chapter_finalize', String(request.chapterNumber))
    const hasKnowledgeProjection = !run || PostProcessRepository.getSteps(run.id)
      .some(step => step.stepKey === 'kb_import' && step.errorMsg !== CHAPTER_RESTORED_REPROJECTION_PENDING)
    return hasKnowledgeProjection
  }

  confirmLegacyKnowledgeAbsent(projectRoot: string, operationId: string): Promise<ChapterDeletionResult> {
    return this.exclusive(projectRoot, async () => {
      const existing = ChapterDeletionRepository.get(operationId)
      if (existing) {
        const frozen = frozenLegacyOperation(projectRoot, existing)
        if (frozen) return frozen
      }
      const operation = ChapterDeletionRepository.confirmLegacyKnowledgeAbsent(operationId)
      return this.resume(projectRoot, operation.operationId)
    })
  }

  retry(projectRoot: string, operationId: string): Promise<ChapterDeletionResult> {
    return this.exclusive(projectRoot, async () => {
      const operation = ChapterDeletionRepository.get(operationId)
      if (!operation) {
        return { success: false, committed: false, error: 'CHAPTER_DELETE_OPERATION_NOT_FOUND' }
      }
      const frozen = frozenLegacyOperation(projectRoot, operation)
      if (frozen) return frozen
      if (operation.legacyKnowledgeAuthorization === 'required') {
        return legacyKnowledgeAuthorizationRequired(operation)
      }
      return this.resume(projectRoot, operationId)
    })
  }

  listIncomplete(projectRoot: string): ChapterDeletionOperation[] {
    const freeze = readPortableRuntimeFreeze(projectRoot)
    return ChapterDeletionRepository.listIncomplete().filter(operation => !freeze.isFrozen('chapter_deletion_operations', operation.operationId))
  }

  listTrash(): ChapterTrashListResult {
    return { success: true, ...ChapterDeletionRepository.listTrash() }
  }

  /**
   * 恢复回收站里的一项。这次删除的清理没完成时先续跑一次（G2），仍没完成就拒绝；放回原位时实体稿撞名就换目标（G9），
   * 事务提交后重发实体稿。重发失败只让实体稿停在待发布，章节页已有「重试发布」。
   */
  restore(projectRoot: string, projectId: string, request: RestoreTrashedChapterRequest): Promise<RestoreTrashedChapterResult> {
    return this.exclusive(projectRoot, async (): Promise<RestoreTrashedChapterResult> => {
      if (!validRestoreRequest(request)) return { success: false, error: 'CHAPTER_RESTORE_REQUEST_INVALID' }
      const receipt = ChapterDeletionRepository.get(request.deletionId)
      if (receipt && (receipt.status === 'pending' || receipt.status === 'failed') && !frozenLegacyOperation(projectRoot, receipt)) {
        const cleaned = await this.resume(projectRoot, receipt.operationId)
        if (!cleaned.success) return { success: false, error: 'CHAPTER_RESTORE_CLEANUP_INCOMPLETE', ...(cleaned.operation ? { operation: cleaned.operation } : {}) }
      }
      const final = ChapterDeletionRepository.trashedFinal(request.deletionId)
      let restored: Exclude<RestoreTrashedChapterResult, { success: false }>
      try {
        const target = final && request.expectedMode === 'into-gap'
          ? republishTarget({ projectRoot, targetFileName: final.targetFileName, chapterNumber: final.chapterNumber,
            chapterTitle: final.chapterTitle, content: final.contentSnapshot, finalizationId: final.finalizationId,
            reserved: ChapterDeletionRepository.reservedManuscriptTargets() })
          : undefined
        this.assertOwner(projectRoot)
        const db = getProjectDb()
        if (!db) throw new Error('PROJECT_NOT_OPEN')
        restored = db.transaction(() => {
          if (final && new GenerationDraftEffects(db, new GenerationRunRepository(() => db))
            .unfinishedBatchChapters(projectId).has(final.chapterNumber)) {
            throw new Error('CHAPTER_RESTORE_BATCH_UNFINISHED')
          }
          return ChapterDeletionRepository.restore(request, target)
        }).immediate()
      } catch (error) {
        return { success: false, error: messageOf(error) }
      }
      if (restored.outcome !== 'restored') return restored
      // 恢复已经提交，重发失败或抛错都只让实体稿停在待发布，不能把这次恢复报成没成功。
      try {
        const published = await this.finalizations.retry({ projectRoot, finalizationId: restored.finalizationId })
        return {
          ...restored,
          publicationStatus: published.publicationStatus ?? 'pending',
          ...(published.success ? {} : { publicationError: published.error ?? 'FINALIZATION_PUBLICATION_FAILED' }),
        }
      } catch (error) {
        return { ...restored, publicationStatus: 'pending', publicationError: messageOf(error) }
      }
    })
  }

  purge(projectRoot: string, request: PurgeTrashRequest): Promise<PurgeTrashResult> {
    return this.exclusive(projectRoot, async (): Promise<PurgeTrashResult> => {
      const targets = purgeTargets(request)
      if (!targets) return { success: false, error: 'CHAPTER_TRASH_REQUEST_INVALID' }
      try {
        return { success: true, ...ChapterDeletionRepository.purge(targets) }
      } catch (error) {
        return { success: false, error: messageOf(error) }
      }
    })
  }

  private async resume(projectRoot: string, operationId: string): Promise<ChapterDeletionResult> {
    let operation = ChapterDeletionRepository.get(operationId)
    if (!operation) return { success: false, committed: false, error: 'CHAPTER_DELETE_OPERATION_NOT_FOUND' }
    const frozen = frozenLegacyOperation(projectRoot, operation)
    if (frozen) return frozen
    if (operation.status === 'completed') {
      return { success: true, committed: true, operation }
    }

    ChapterDeletionRepository.startAttempt(operationId)
    for (const member of [...ChapterDeletionRepository.listCompanions(operationId), operation]) {
      await this.cleanProjections(projectRoot, member)
    }

    this.assertOwner(projectRoot)
    operation = ChapterDeletionRepository.settle(operationId)
    const error = operationError(operation)
    return {
      success: operation.status === 'completed',
      committed: true,
      operation,
      ...(error ? { error } : {}),
    }
  }

  private async cleanProjections(projectRoot: string, operation: ChapterDeletionOperation): Promise<void> {
    const { operationId } = operation
    if (operation.manuscriptStatus === 'pending' || operation.manuscriptStatus === 'failed') {
      try {
        await this.cleaner.removeManuscript(projectRoot, operation.targetFileName, publishedManuscripts(operation))
        this.assertOwner(projectRoot)
        ChapterDeletionRepository.markProjection(operationId, 'manuscript', 'completed')
      } catch (error) {
        this.assertOwner(projectRoot)
        ChapterDeletionRepository.markProjection(
          operationId,
          'manuscript',
          'failed',
          error instanceof Error ? error.message : String(error),
        )
      }
    }

    if (operation.knowledgeStatus === 'pending' || operation.knowledgeStatus === 'failed') {
      try {
        await this.cleaner.removeKnowledgeDocument(projectRoot, operation.knowledgeDocumentId)
        this.assertOwner(projectRoot)
        ChapterDeletionRepository.markProjection(operationId, 'knowledge', 'completed')
      } catch (error) {
        this.assertOwner(projectRoot)
        ChapterDeletionRepository.markProjection(
          operationId,
          'knowledge',
          'failed',
          error instanceof Error ? error.message : String(error),
        )
      }
    }
  }
}

export const chapterDeletionService = new ChapterDeletionService()
