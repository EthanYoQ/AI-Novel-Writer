import { randomUUID } from 'node:crypto'

import type {
  ChapterDeletionOperation,
  ChapterDeletionResult,
  DeleteFinalizedChapterRequest,
} from '../../src/shared/chapter-deletion'
import { ChapterDeletionRepository } from '../repositories/chapter-deletion-repository'
import { FinalizationRepository } from '../repositories/finalization-repository'
import { PostProcessRepository } from '../repositories/post-process-repository'
import { knowledgeBaseLoader } from './knowledge-base-loader'
import { removePublishedManuscript } from './manuscript-publisher'
import { readPortableRuntimeFreeze } from './portable-runtime-freeze'

export interface ChapterDeletionProjectionCleaner {
  removeManuscript(projectRoot: string, targetFileName: string): Promise<void>
  removeKnowledgeDocument(projectRoot: string, documentId: string): Promise<void>
}

export interface ChapterDeletionServiceOptions {
  createOperationId?: () => string
  cleaner?: ChapterDeletionProjectionCleaner
}

const defaultCleaner: ChapterDeletionProjectionCleaner = {
  removeManuscript: removePublishedManuscript,
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

export class ChapterDeletionService {
  private readonly createOperationId: () => string
  private readonly cleaner: ChapterDeletionProjectionCleaner

  constructor(options: ChapterDeletionServiceOptions = {}) {
    this.createOperationId = options.createOperationId ?? randomUUID
    this.cleaner = options.cleaner ?? defaultCleaner
  }

  async delete(
    projectRoot: string,
    request: DeleteFinalizedChapterRequest,
  ): Promise<ChapterDeletionResult> {
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
  }

  private requiresLegacyKnowledgeAuthorization(request: DeleteFinalizedChapterRequest): boolean {
    const finalization = FinalizationRepository.getByDraftId(request.draftId)
    if (!finalization || finalization.knowledgeDocumentId) return false
    const run = PostProcessRepository.getLatestRun('chapter_finalize', String(request.chapterNumber))
    const hasKnowledgeProjection = !run || PostProcessRepository.getSteps(run.id)
      .some(step => step.stepKey === 'kb_import')
    return hasKnowledgeProjection
  }

  async confirmLegacyKnowledgeAbsent(
    projectRoot: string,
    operationId: string,
  ): Promise<ChapterDeletionResult> {
    const existing = ChapterDeletionRepository.get(operationId)
    if (existing) {
      const frozen = frozenLegacyOperation(projectRoot, existing)
      if (frozen) return frozen
    }
    const operation = ChapterDeletionRepository.confirmLegacyKnowledgeAbsent(operationId)
    return this.resume(projectRoot, operation.operationId)
  }

  async retry(projectRoot: string, operationId: string): Promise<ChapterDeletionResult> {
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
  }

  listIncomplete(projectRoot: string): ChapterDeletionOperation[] {
    const freeze = readPortableRuntimeFreeze(projectRoot)
    return ChapterDeletionRepository.listIncomplete().filter(operation => !freeze.isFrozen('chapter_deletion_operations', operation.operationId))
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
        await this.cleaner.removeManuscript(projectRoot, operation.targetFileName)
        ChapterDeletionRepository.markProjection(operationId, 'manuscript', 'completed')
      } catch (error) {
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
        ChapterDeletionRepository.markProjection(operationId, 'knowledge', 'completed')
      } catch (error) {
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
