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
        throw new Error('知识库原生模块不可用')
      }
      throw new Error('知识库未确认文档已删除')
    }
  },
}

function operationError(operation: ChapterDeletionOperation): string | undefined {
  const failures = [
    operation.manuscriptStatus === 'failed'
      ? `实体稿清理失败：${operation.manuscriptError || '未知错误'}`
      : '',
    operation.knowledgeStatus === 'failed'
      ? `知识库清理失败：${operation.knowledgeError || '未知错误'}`
      : '',
  ].filter(Boolean)
  return failures.length > 0 ? failures.join('；') : undefined
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
    if (existing) return this.resume(projectRoot, existing.operationId)
    await this.freezeLegacyKnowledgeDocument(projectRoot, request)
    const frozen = ChapterDeletionRepository.begin({
      operationId: this.createOperationId(),
      draftId: request.draftId,
      chapterNumber: request.chapterNumber,
    })
    return this.resume(projectRoot, frozen.operationId)
  }

  private async freezeLegacyKnowledgeDocument(
    projectRoot: string,
    request: DeleteFinalizedChapterRequest,
  ): Promise<void> {
    const finalization = FinalizationRepository.getByDraftId(request.draftId)
    if (!finalization || finalization.knowledgeDocumentId || !finalization.targetFileName) return
    const resolution = await knowledgeBaseLoader.run((kb) => kb.resolveFinalizedDocumentId(
      projectRoot,
      finalization.targetFileName,
      finalization.contentSnapshot,
    ))
    if (resolution && typeof resolution === 'object' && 'errorCode' in resolution) {
      throw new Error('无法加载知识库以冻结旧定稿文档身份')
    }
    if (resolution.status === 'found') {
      FinalizationRepository.linkKnowledgeDocument(request.draftId, resolution.documentId)
      return
    }
    if (resolution.status === 'ambiguous') {
      throw new Error(`旧定稿对应多个知识文档，已拒绝猜测：${resolution.documentIds.join('、')}`)
    }

    const run = PostProcessRepository.getLatestRun('chapter_finalize', String(request.chapterNumber))
    const knowledgeWasImported = !!run && PostProcessRepository.getSteps(run.id)
      .some(step => step.stepKey === 'kb_import' && step.ok)
    if (knowledgeWasImported) {
      throw new Error('旧定稿记录显示知识库导入成功，但无法按正文唯一定位文档；章节事实保持不变')
    }
  }

  async retry(projectRoot: string, operationId: string): Promise<ChapterDeletionResult> {
    const operation = ChapterDeletionRepository.get(operationId)
    if (!operation) {
      return { success: false, committed: false, error: '未找到可重试的章节删除操作' }
    }
    return this.resume(projectRoot, operationId)
  }

  get(operationId: string): ChapterDeletionOperation | null {
    return ChapterDeletionRepository.get(operationId)
  }

  listIncomplete(): ChapterDeletionOperation[] {
    return ChapterDeletionRepository.listIncomplete()
  }

  private async resume(projectRoot: string, operationId: string): Promise<ChapterDeletionResult> {
    let operation = ChapterDeletionRepository.get(operationId)
    if (!operation) return { success: false, committed: false, error: '章节删除操作不存在' }
    if (operation.status === 'completed') {
      return { success: true, committed: true, operation }
    }

    operation = ChapterDeletionRepository.startAttempt(operationId)
    if (operation.manuscriptStatus === 'pending' || operation.manuscriptStatus === 'failed') {
      try {
        await this.cleaner.removeManuscript(projectRoot, operation.targetFileName)
        operation = ChapterDeletionRepository.markProjection(operationId, 'manuscript', 'completed')
      } catch (error) {
        operation = ChapterDeletionRepository.markProjection(
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
        operation = ChapterDeletionRepository.markProjection(operationId, 'knowledge', 'completed')
      } catch (error) {
        operation = ChapterDeletionRepository.markProjection(
          operationId,
          'knowledge',
          'failed',
          error instanceof Error ? error.message : String(error),
        )
      }
    }

    operation = ChapterDeletionRepository.get(operationId) ?? operation
    const error = operationError(operation)
    return {
      success: operation.status === 'completed',
      committed: true,
      operation,
      ...(error ? { error } : {}),
    }
  }
}

export const chapterDeletionService = new ChapterDeletionService()
