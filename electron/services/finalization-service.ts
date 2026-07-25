import { createHash, randomUUID } from 'node:crypto'

import {
  FinalizationRepository,
  type FinalizationRecord,
  type PublicationStatus,
} from '../repositories/finalization-repository'
import {
  manuscriptPublisher,
  resolveManuscriptTarget,
  type PublishManuscriptInput,
} from './manuscript-publisher'

export interface FinalizationRequest {
  /** 已由 ProjectAccess 验证并 canonicalize 的项目根目录。 */
  projectRoot: string
  draftId: number
  chapterNumber: number
  chapterTitle: string
  content: string
  contentRevision: number
}

export interface FinalizationRetryRequest {
  /** 已由 ProjectAccess 验证并 canonicalize 的项目根目录。 */
  projectRoot: string
  finalizationId: string
}

export interface FinalizationResult {
  success: boolean
  /** false 代表数据库事务从未提交；true 则数据库定稿事实已存在。 */
  committed: boolean
  finalizationId?: string
  contentHash?: string
  contentRevision?: number
  draftId?: number
  publicationStatus?: PublicationStatus
  error?: string
}

export interface FinalizationPublisher {
  publish(input: PublishManuscriptInput): Promise<void>
}

export interface FinalizationServiceOptions {
  createFinalizationId?: () => string
  publisher?: FinalizationPublisher
}

function toResult(record: FinalizationRecord, success: boolean, error?: string): FinalizationResult {
  return {
    success,
    committed: true,
    finalizationId: record.finalizationId,
    contentHash: record.contentHash,
    contentRevision: record.contentRevision,
    draftId: record.draftId,
    publicationStatus: record.publicationStatus,
    ...(error ? { error } : {}),
  }
}

function snapshotHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function hasSameFrozenRequest(
  record: FinalizationRecord,
  request: FinalizationRequest,
  contentHash: string,
): boolean {
  return record.draftId === request.draftId
    && record.chapterNumber === request.chapterNumber
    && record.chapterTitle === request.chapterTitle
    && record.contentRevision === request.contentRevision
    && record.contentHash === contentHash
    && record.contentSnapshot === request.content
}

function snapshotIntegrityError(record: FinalizationRecord): string | null {
  return snapshotHash(record.contentSnapshot) === record.contentHash
    ? null
    : '已提交定稿的不可变正文快照与内容哈希不一致，已拒绝发布'
}

/**
 * 主进程定稿应用服务：SQLite transaction 是事实源，实体稿仅为可恢复投影。
 * retry 只接收 finalizationId，正文、标题和目标文件名都只从已提交 outbox 读取。
 */
export class FinalizationService {
  private readonly createFinalizationId: () => string
  private readonly publisher: FinalizationPublisher

  constructor(options: FinalizationServiceOptions = {}) {
    this.createFinalizationId = options.createFinalizationId ?? randomUUID
    this.publisher = options.publisher ?? manuscriptPublisher
  }

  async finalize(request: FinalizationRequest): Promise<FinalizationResult> {
    const finalizationId = this.createFinalizationId()
    const contentHash = snapshotHash(request.content)
    let record: FinalizationRecord
    try {
      const existing = FinalizationRepository.getByDraftId(request.draftId)
      if (existing) {
        if (!hasSameFrozenRequest(existing, request, contentHash)) {
          return {
            success: false,
            committed: false,
            error: '该草稿已有内容不同的不可替换定稿提交',
          }
        }
        // 上次响应可能在客户端收到前丢失。复用既有 finalizationId 与目标文件名，
        // 而不是因新的 UUID 或文件碰撞创建第二次提交。
        return this.publishCommitted(request.projectRoot, existing)
      }
      const target = resolveManuscriptTarget({
        projectRoot: request.projectRoot,
        chapterNumber: request.chapterNumber,
        chapterTitle: request.chapterTitle,
        finalizationId,
      })
      record = FinalizationRepository.commit({
        finalizationId,
        draftId: request.draftId,
        chapterNumber: request.chapterNumber,
        chapterTitle: request.chapterTitle,
        content: request.content,
        contentHash,
        contentRevision: request.contentRevision,
        targetFileName: target.fileName,
      })
    } catch (error) {
      return {
        success: false,
        committed: false,
        finalizationId,
        contentHash,
        contentRevision: request.contentRevision,
        draftId: request.draftId,
        error: String(error),
      }
    }
    return this.publishCommitted(request.projectRoot, record)
  }

  async retry(request: FinalizationRetryRequest): Promise<FinalizationResult> {
    let record: FinalizationRecord | null
    try {
      record = FinalizationRepository.get(request.finalizationId)
    } catch (error) {
      return { success: false, committed: false, error: String(error) }
    }
    if (!record) {
      return {
        success: false,
        committed: false,
        finalizationId: request.finalizationId,
        error: '未找到可重试的定稿提交',
      }
    }
    const integrityError = snapshotIntegrityError(record)
    if (integrityError) {
      return toResult(record, false, integrityError)
    }
    if (record.publicationStatus === 'published') {
      return toResult(record, true)
    }
    return this.publishCommitted(request.projectRoot, record)
  }

  private async publishCommitted(projectRoot: string, record: FinalizationRecord): Promise<FinalizationResult> {
    try {
      const integrityError = snapshotIntegrityError(record)
      if (integrityError) throw new Error(integrityError)
      if (record.publicationStatus === 'published') {
        return toResult(record, true)
      }
      await this.publisher.publish({
        projectRoot,
        targetFileName: record.targetFileName,
        chapterNumber: record.chapterNumber,
        chapterTitle: record.chapterTitle,
        content: record.contentSnapshot,
      })
      return toResult(FinalizationRepository.markPublished(record.finalizationId), true)
    } catch (error) {
      const message = String(error)
      try {
        const pending = FinalizationRepository.markPublicationPending(record.finalizationId, message)
        return toResult(pending, false, `定稿已提交、实体稿待发布：${message}`)
      } catch (markError) {
        // outbox 在事务内已经以 pending 创建；即使补记错误失败，也不能把已提交事实伪装为回滚。
        return toResult(record, false, `定稿已提交、实体稿待发布：${message}；待发布状态记录失败：${String(markError)}`)
      }
    }
  }
}
