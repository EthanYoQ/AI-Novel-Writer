/**
 * DraftRepository — 草稿 (drafts 表 + contents 联动)
 *
 * 草稿是创作栈的主线。status='finalized' 代表定稿。
 * 正文统一存储在 contents 表中，drafts 只持有 content_id 外键。
 */
import { createHash } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import { getProjectDb } from '../database'
import { ContentRepository } from './content-repository'
import type { DraftSourceDependency } from '../../src/shared/draft-source-dependency'

const DRAFT_META_SELECT = `
  SELECT drafts.*, finalization_outbox.chapter_title
  FROM drafts
  LEFT JOIN finalization_outbox
    ON drafts.status = 'finalized' AND finalization_outbox.draft_id = drafts.id
`

/** 草稿元数据（不含正文，适合列表查询） */
export interface DraftMeta {
    id: number
    chapterNumber: number
    chapterTitle?: string
    version: number
    status: string
    source: string
    contentId: number
    wordCount: number
    sourceDependencies: DraftSourceDependency[]
    dependenciesStale: boolean
    createdAt: string
    updatedAt: string
}

/** 草稿完整数据（含正文） */
export interface DraftFull extends DraftMeta {
    content: string
}

function sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex')
}

function parseDependencies(value: unknown): { dependencies: DraftSourceDependency[]; valid: boolean } {
    if (typeof value !== 'string') return { dependencies: [], valid: false }
    try {
        const parsed = JSON.parse(value) as unknown
        if (!Array.isArray(parsed) || parsed.length > 500) return { dependencies: [], valid: false }
        const dependencies: DraftSourceDependency[] = []
        const seen = new Set<number>()
        for (const raw of parsed) {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { dependencies: [], valid: false }
            const dependency = raw as Record<string, unknown>
            if (
                !Number.isSafeInteger(dependency.draftId)
                || (dependency.draftId as number) < 1
                || typeof dependency.contentHash !== 'string'
                || !/^[a-f0-9]{64}$/u.test(dependency.contentHash)
                || seen.has(dependency.draftId as number)
            ) return { dependencies: [], valid: false }
            seen.add(dependency.draftId as number)
            dependencies.push({
                draftId: dependency.draftId as number,
                contentHash: dependency.contentHash,
            })
        }
        return { dependencies, valid: true }
    } catch {
        return { dependencies: [], valid: false }
    }
}

function dependencyHashes(
    db: BetterSqlite3.Database,
    dependencyIds: readonly number[],
): Map<number, string> {
    const hashes = new Map<number, string>()
    const uniqueIds = [...new Set(dependencyIds)]
    for (let offset = 0; offset < uniqueIds.length; offset += 500) {
        const chunk = uniqueIds.slice(offset, offset + 500)
        if (chunk.length === 0) continue
        const placeholders = chunk.map(() => '?').join(', ')
        const rows = db.prepare(`
          SELECT drafts.id, contents.body
          FROM drafts
          JOIN contents ON contents.id = drafts.content_id
          WHERE drafts.id IN (${placeholders})
        `).all(...chunk) as Array<{ id: number; body: string }>
        for (const row of rows) hashes.set(row.id, sha256(row.body))
    }
    return hashes
}

function rowsToMeta(db: BetterSqlite3.Database, rows: Record<string, unknown>[]): DraftMeta[] {
    const parsed = rows.map(row => ({ row, ...parseDependencies(row.source_dependencies) }))
    const hashes = dependencyHashes(
        db,
        parsed.flatMap(item => item.dependencies.map(dependency => dependency.draftId)),
    )
    return parsed.map(({ row, dependencies, valid }) => rowToMeta(row, dependencies, valid, hashes))
}

/** DB 行 → DraftMeta */
function rowToMeta(
    row: Record<string, unknown>,
    sourceDependencies: DraftSourceDependency[],
    dependenciesValid: boolean,
    hashes: ReadonlyMap<number, string>,
): DraftMeta {
    const chapterTitle = typeof row.chapter_title === 'string' && row.chapter_title.trim()
        ? row.chapter_title
        : undefined
    return {
        id: row.id as number,
        chapterNumber: row.chapter_number as number,
        ...(chapterTitle ? { chapterTitle } : {}),
        version: row.version as number,
        status: row.status as string,
        source: row.source as string,
        contentId: row.content_id as number,
        wordCount: row.word_count as number,
        sourceDependencies,
        dependenciesStale: !dependenciesValid || sourceDependencies.some(dependency => (
            hashes.get(dependency.draftId) !== dependency.contentHash
        )),
        createdAt: row.created_at as string,
        updatedAt: row.updated_at as string,
    }
}

export class DraftRepository {
    /**
     * 创建草稿（先写 contents 再建 draft 记录）
     * 返回新建的 draft ID
     */
    static create(params: {
        chapterNumber: number
        version?: number
        source: 'write' | 'rewrite'
        content: string
        wordCount: number
        sourceDependencies?: DraftSourceDependency[]
    }): number {
        const db = getProjectDb()
        if (!db) throw new Error('[DraftRepository] 数据库未连接')

        // 事务内原子分配 version，避免 getNextVersion + create 竞态
        const tx = db.transaction(() => {
            const serializedDependencies = JSON.stringify(params.sourceDependencies ?? [])
            const parsedDependencies = parseDependencies(serializedDependencies)
            if (!parsedDependencies.valid) throw new Error('草稿来源依赖无效')
            const hashes = dependencyHashes(
                db,
                parsedDependencies.dependencies.map(dependency => dependency.draftId),
            )
            if (parsedDependencies.dependencies.some(dependency => (
                hashes.get(dependency.draftId) !== dependency.contentHash
            ))) throw new Error('草稿来源依赖已变化，已拒绝保存')

            const row = db.prepare(`
        SELECT MAX(version) as maxVer FROM drafts WHERE chapter_number = ?
      `).get(params.chapterNumber) as { maxVer: number | null }
            const version = (row.maxVer ?? 0) + 1

            const contentId = ContentRepository.create(params.content)
            const result = db.prepare(`
        INSERT INTO drafts (
          chapter_number, version, source, content_id, word_count, source_dependencies
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
                params.chapterNumber,
                version,
                params.source,
                contentId,
                params.wordCount,
                serializedDependencies,
            )
            return Number(result.lastInsertRowid)
        })

        return tx()
    }

    /** 列出章节的所有草稿（不含正文，按版本升序） */
    static listByChapter(chapterNumber: number): DraftMeta[] {
        const db = getProjectDb()
        if (!db) return []

        const rows = db.prepare(`
      ${DRAFT_META_SELECT}
      WHERE drafts.chapter_number = ?
      ORDER BY drafts.version ASC
    `).all(chapterNumber) as Record<string, unknown>[]

        return rowsToMeta(db, rows)
    }

    /** 列出全部章节的草稿元数据（按章节、版本升序） */
    static listAll(): DraftMeta[] {
        const db = getProjectDb()
        if (!db) return []

        const rows = db.prepare(`
      ${DRAFT_META_SELECT}
      ORDER BY drafts.chapter_number ASC, drafts.version ASC
    `).all() as Record<string, unknown>[]

        return rowsToMeta(db, rows)
    }

    /** 获取草稿元数据 */
    static getMeta(id: number): DraftMeta | null {
        const db = getProjectDb()
        if (!db) return null

        const row = db.prepare(`
          ${DRAFT_META_SELECT}
          WHERE drafts.id = ?
        `).get(id) as Record<string, unknown> | undefined

        return row ? rowsToMeta(db, [row])[0] ?? null : null
    }

    /** 获取草稿完整数据（含正文） */
    static getFull(id: number): DraftFull | null {
        const meta = DraftRepository.getMeta(id)
        if (!meta) return null

        const body = ContentRepository.getBody(meta.contentId)
        return { ...meta, content: body ?? '' }
    }

    /** 获取章节最新版本的草稿 */
    static getLatestByChapter(chapterNumber: number): DraftMeta | null {
        const db = getProjectDb()
        if (!db) return null

        const row = db.prepare(`
      ${DRAFT_META_SELECT}
      WHERE drafts.chapter_number = ?
      ORDER BY drafts.version DESC LIMIT 1
    `).get(chapterNumber) as Record<string, unknown> | undefined

        return row ? rowsToMeta(db, [row])[0] ?? null : null
    }

    /** 获取章节已定稿的草稿 */
    static getFinalizedByChapter(chapterNumber: number): DraftMeta | null {
        const db = getProjectDb()
        if (!db) return null

        const row = db.prepare(`
      ${DRAFT_META_SELECT}
      WHERE drafts.chapter_number = ? AND drafts.status = 'finalized'
      ORDER BY drafts.version DESC LIMIT 1
    `).get(chapterNumber) as Record<string, unknown> | undefined

        return row ? rowsToMeta(db, [row])[0] ?? null : null
    }

    /** 获取下一个可用版本号 */
    static getNextVersion(chapterNumber: number): number {
        const db = getProjectDb()
        if (!db) return 1

        const row = db.prepare(`
      SELECT MAX(version) as maxVer FROM drafts WHERE chapter_number = ?
    `).get(chapterNumber) as { maxVer: number | null }

        return (row.maxVer ?? 0) + 1
    }

    /** 获取最大的已定稿章节号，如果没有则返回 0 */
    static getMaxFinalizedChapter(): number {
        const db = getProjectDb()
        if (!db) return 0
        const row = db.prepare(`
            SELECT MAX(chapter_number) as maxChapter
            FROM drafts
            WHERE status = 'finalized'
        `).get() as { maxChapter: number | null }
        return row?.maxChapter ?? 0
    }

    /** 更新草稿状态 */
    static updateStatus(id: number, status: string, wordCount?: number): void {
        const db = getProjectDb()
        if (!db) return
        const meta = DraftRepository.getMeta(id)
        if (!meta) return
        if (meta.status === 'finalized' && status !== 'finalized') {
            throw new Error('已定稿正文为不可变事实；如需再编辑，请创建新草稿或处理定稿冲突')
        }
        if (meta.status !== 'finalized' && status === 'finalized') {
            throw new Error('定稿必须通过原子定稿提交，不能单独更新草稿状态')
        }

        if (wordCount !== undefined) {
            db.prepare(`
        UPDATE drafts SET status = ?, word_count = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(status, wordCount, id)
        } else {
            db.prepare(`
        UPDATE drafts SET status = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(status, id)
        }
    }

    /** 更新草稿正文（同时更新 contents 表） */
    static updateContent(id: number, content: string, wordCount: number): void {
        const meta = DraftRepository.getMeta(id)
        if (!meta) return
        if (meta.status === 'finalized') {
            throw new Error('已定稿正文为不可变事实；如需再编辑，请创建新草稿或处理定稿冲突')
        }

        ContentRepository.updateBody(meta.contentId, content)

        const db = getProjectDb()
        if (!db) return

        db.prepare(`
      UPDATE drafts SET word_count = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(wordCount, id)
    }

    /** 删除草稿（级联删除 revisions/reviews，但 contents 需手动清理） */
    static delete(id: number): void {
        const db = getProjectDb()
        if (!db) return

        db.transaction(() => {
            // 状态必须与 DELETE 位于同一权威事务；菜单打开时的 renderer 状态
            // 不能授权删除在确认期间已经定稿的事实。
            const target = db.prepare(`
              SELECT status, content_id FROM drafts WHERE id = ?
            `).get(id) as { status: string; content_id: number } | undefined
            if (!target) return
            if (target.status === 'finalized') {
                throw Object.assign(
                    new Error('草稿已定稿，请通过定稿删除入口清理正文及派生投影'),
                    { code: 'FINALIZED_DRAFT_DELETE_REQUIRED' as const },
                )
            }

            db.prepare('DELETE FROM drafts WHERE id = ?').run(id)

            // 【DB 迁移备注】：如果 contents.id 仍被 revision 或 review 引用，
            // SQLite 外键约束会阻止删除；此处保留原有孤立内容兼容策略。
            try { ContentRepository.delete(target.content_id) } catch { /* 被外键保护 */ }
        })()
    }

    /** 清空所有生成正文与派生产物，不删除角色卡或项目配置 */
    static clearAll(): void {
        const db = getProjectDb()
        if (!db) throw new Error('[DraftRepository] 数据库未连接')

        const tx = db.transaction(() => {
            db.prepare('DELETE FROM finalized_draft_import_operations').run()
            db.prepare('DELETE FROM post_process_steps').run()
            db.prepare('DELETE FROM post_process_runs').run()
            db.prepare('DELETE FROM reviews').run()
            db.prepare('DELETE FROM revisions').run()
            db.prepare('DELETE FROM drafts').run()
            db.prepare('DELETE FROM contents').run()
            db.prepare('DELETE FROM summary_snapshots').run()
        })

        tx()
    }
}
