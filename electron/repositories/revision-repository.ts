/**
 * RevisionRepository — 修稿 (revisions 表 + contents 联动)
 *
 * 修稿是基于某一版草稿的探索分支。
 * 状态流转：pending → merged / discarded
 */
import { getProjectDb } from '../database'
import { ContentRepository } from './content-repository'
import type { ExpectedDraftSource } from '../../src/shared/ipc-channels'
import { assertExpectedDraftSource } from './draft-source-guard'

/** 修稿元数据（不含正文） */
export interface RevisionMeta {
    id: number
    baseDraftId: number
    revisionIndex: number
    revisionType: string
    status: string
    mergedToDraftId: number | null
    userPrompt: string
    reviewSourceId: number | null
    contentId: number
    wordCount: number
    createdAt: string
    updatedAt: string
}

/** 修稿完整数据（含正文） */
export interface RevisionFull extends RevisionMeta {
    content: string
}

export interface MergeRevisionRequest {
    revisionId: number
    targetDraftId: number
    expectedDraftContent: string
    mergedContent: string
    wordCount: number
}

export interface MergeRevisionReceipt {
    revisionId: number
    targetDraftId: number
    status: 'revised'
    wordCount: number
    idempotent: boolean
}

function rowToMeta(row: Record<string, unknown>): RevisionMeta {
    return {
        id: row.id as number,
        baseDraftId: row.base_draft_id as number,
        revisionIndex: row.revision_index as number,
        revisionType: row.revision_type as string,
        status: row.status as string,
        mergedToDraftId: (row.merged_to_draft_id as number | null) ?? null,
        userPrompt: (row.user_prompt as string) ?? '',
        reviewSourceId: (row.review_source_id as number | null) ?? null,
        contentId: row.content_id as number,
        wordCount: row.word_count as number,
        createdAt: row.created_at as string,
        updatedAt: row.updated_at as string,
    }
}

export class RevisionRepository {
    /**
     * 创建修稿（事务内原子分配 revision_index，再入内容池 + 元数据）
     * 不接受调用方传入序号，避免与落库结果不一致。
     */
    static create(params: {
        baseDraftId: number
        revisionType: 'refine' | 'review-fix'
        userPrompt?: string
        reviewSourceId?: number
        content: string
        wordCount: number
    }): { id: number; revisionIndex: number } {
        const db = getProjectDb()
        if (!db) throw new Error('[RevisionRepository] 数据库未连接')

        const tx = db.transaction(() => {
            const row = db.prepare(`
        SELECT MAX(revision_index) as maxIdx FROM revisions WHERE base_draft_id = ?
      `).get(params.baseDraftId) as { maxIdx: number | null }
            const revisionIndex = (row.maxIdx ?? 0) + 1

            const contentId = ContentRepository.create(params.content)
            const result = db.prepare(`
        INSERT INTO revisions (
          base_draft_id, revision_index, revision_type,
          user_prompt, review_source_id, content_id, word_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
                params.baseDraftId,
                revisionIndex,
                params.revisionType,
                params.userPrompt ?? '',
                params.reviewSourceId ?? null,
                contentId,
                params.wordCount,
            )
            return { id: Number(result.lastInsertRowid), revisionIndex }
        })

        return tx()
    }

    /**
     * 原子替换同一草稿的 pending 修稿：新修稿创建失败时，旧 pending
     * 状态与内容池分配会随整个 SQLite 事务一起回滚。
     */
    static replacePending(params: {
        baseDraftId: number
        revisionType: 'refine' | 'review-fix'
        userPrompt?: string
        reviewSourceId?: number
        content: string
        wordCount: number
        expectedSource?: ExpectedDraftSource
    }): { id: number; revisionIndex: number } {
        const db = getProjectDb()
        if (!db) throw new Error('[RevisionRepository] 数据库未连接')

        return db.transaction(() => {
            if (params.expectedSource) {
                assertExpectedDraftSource(db, params.baseDraftId, params.expectedSource)
            }
            const row = db.prepare(`
        SELECT MAX(revision_index) as maxIdx FROM revisions WHERE base_draft_id = ?
      `).get(params.baseDraftId) as { maxIdx: number | null }
            const revisionIndex = (row.maxIdx ?? 0) + 1
            const contentId = ContentRepository.create(params.content)
            const result = db.prepare(`
        INSERT INTO revisions (
          base_draft_id, revision_index, revision_type,
          user_prompt, review_source_id, content_id, word_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
                params.baseDraftId,
                revisionIndex,
                params.revisionType,
                params.userPrompt ?? '',
                params.reviewSourceId ?? null,
                contentId,
                params.wordCount,
            )
            const id = Number(result.lastInsertRowid)
            db.prepare(`
        UPDATE revisions SET status = 'discarded', updated_at = datetime('now')
        WHERE base_draft_id = ? AND status = 'pending' AND id <> ?
      `).run(params.baseDraftId, id)
            return { id, revisionIndex }
        })()
    }

    /** 列出某草稿的所有修稿 */
    static listByDraft(baseDraftId: number): RevisionMeta[] {
        const db = getProjectDb()
        if (!db) return []

        const rows = db.prepare(`
      SELECT * FROM revisions
      WHERE base_draft_id = ?
      ORDER BY revision_index ASC
    `).all(baseDraftId) as Record<string, unknown>[]

        return rows.map(rowToMeta)
    }

    /** 获取某草稿的所有 pending 修稿 */
    static getPending(baseDraftId: number): RevisionMeta[] {
        const db = getProjectDb()
        if (!db) return []

        const rows = db.prepare(`
      SELECT * FROM revisions
      WHERE base_draft_id = ? AND status = 'pending'
      ORDER BY revision_index ASC
    `).all(baseDraftId) as Record<string, unknown>[]

        return rows.map(rowToMeta)
    }

    /** 获取修稿完整数据 */
    static getFull(id: number): RevisionFull | null {
        const db = getProjectDb()
        if (!db) return null

        const row = db.prepare(
            'SELECT * FROM revisions WHERE id = ?'
        ).get(id) as Record<string, unknown> | undefined

        if (!row) return null
        const meta = rowToMeta(row)
        const body = ContentRepository.getBody(meta.contentId)
        return { ...meta, content: body ?? '' }
    }

    /** 获取下一个修稿序号 */
    static getNextIndex(baseDraftId: number): number {
        const db = getProjectDb()
        if (!db) return 1

        const row = db.prepare(`
      SELECT MAX(revision_index) as maxIdx FROM revisions WHERE base_draft_id = ?
    `).get(baseDraftId) as { maxIdx: number | null }

        return (row.maxIdx ?? 0) + 1
    }

    /**
     * 将人工确认的合并正文、草稿状态和修订关系作为一个 SQLite 提交写入。
     * revisionId 同时是天然的幂等身份：已完成的同一合并只返回读回结果，
     * 不会再次覆盖之后产生的正文。
     */
    static mergeIntoDraft(request: MergeRevisionRequest): MergeRevisionReceipt {
        const db = getProjectDb()
        if (!db) throw new Error('[RevisionRepository] 数据库未连接')

        return db.transaction((): MergeRevisionReceipt => {
            const target = db.prepare(`
              SELECT drafts.status, drafts.word_count, drafts.content_id, contents.body
              FROM drafts
              JOIN contents ON contents.id = drafts.content_id
              WHERE drafts.id = ?
            `).get(request.targetDraftId) as {
                status: string
                word_count: number
                content_id: number
                body: string
            } | undefined
            if (!target) throw new Error(`草稿不存在：${request.targetDraftId}`)

            const revision = db.prepare(`
              SELECT base_draft_id, status, merged_to_draft_id
              FROM revisions WHERE id = ?
            `).get(request.revisionId) as {
                base_draft_id: number
                status: string
                merged_to_draft_id: number | null
            } | undefined
            if (!revision) throw new Error(`修订稿不存在：${request.revisionId}`)
            if (revision.base_draft_id !== request.targetDraftId) {
                throw new Error('修订稿不属于目标草稿，已拒绝合并')
            }

            if (revision.status === 'merged') {
                if (
                    revision.merged_to_draft_id !== request.targetDraftId
                    || target.body !== request.mergedContent
                    || target.status !== 'revised'
                    || target.word_count !== request.wordCount
                ) {
                    throw new Error('修订稿已经合并，但目标草稿随后发生变化；已拒绝再次覆盖')
                }
                return {
                    revisionId: request.revisionId,
                    targetDraftId: request.targetDraftId,
                    status: 'revised',
                    wordCount: request.wordCount,
                    idempotent: true,
                }
            }
            if (revision.status !== 'pending') {
                throw new Error('修订稿已失效，不能继续合并')
            }
            if (!['draft', 'revised', 'reviewed'].includes(target.status)) {
                throw new Error('目标草稿不是可修改状态，已拒绝合并')
            }
            if (target.body !== request.expectedDraftContent) {
                throw new Error('目标草稿正文已变化，请重新打开修订对比')
            }

            db.prepare('UPDATE contents SET body = ? WHERE id = ?')
                .run(request.mergedContent, target.content_id)
            const draftUpdate = db.prepare(`
              UPDATE drafts
              SET status = 'revised', word_count = ?, updated_at = datetime('now')
              WHERE id = ? AND status IN ('draft', 'revised', 'reviewed')
            `).run(request.wordCount, request.targetDraftId)
            if (draftUpdate.changes !== 1) {
                throw new Error('目标草稿状态已变化，已拒绝合并')
            }
            const revisionUpdate = db.prepare(`
              UPDATE revisions
              SET status = 'merged', merged_to_draft_id = ?, updated_at = datetime('now')
              WHERE id = ? AND base_draft_id = ? AND status = 'pending'
            `).run(request.targetDraftId, request.revisionId, request.targetDraftId)
            if (revisionUpdate.changes !== 1) {
                throw new Error('修订稿状态已变化，已拒绝合并')
            }

            return {
                revisionId: request.revisionId,
                targetDraftId: request.targetDraftId,
                status: 'revised',
                wordCount: request.wordCount,
                idempotent: false,
            }
        })()
    }

    /** 标记为已合并（仅 pending → merged） */
    static markMerged(id: number, mergedToDraftId: number): void {
        const db = getProjectDb()
        if (!db) throw new Error('[RevisionRepository] 数据库未连接')

        const result = db.prepare(`
      UPDATE revisions
      SET status = 'merged', merged_to_draft_id = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'pending'
    `).run(mergedToDraftId, id)

        if (result.changes === 0) {
            throw new Error(`[RevisionRepository] 无法合并修稿 #${id}：不存在或非 pending 状态`)
        }
    }

    /** 标记为已弃用（仅 pending → discarded） */
    static markDiscarded(id: number): void {
        const db = getProjectDb()
        if (!db) throw new Error('[RevisionRepository] 数据库未连接')

        const result = db.prepare(`
      UPDATE revisions SET status = 'discarded', updated_at = datetime('now')
      WHERE id = ? AND status = 'pending'
    `).run(id)

        if (result.changes === 0) {
            throw new Error(`[RevisionRepository] 无法弃用修稿 #${id}：不存在或非 pending 状态`)
        }
    }
}
