/**
 * BlueprintRepository — 章节蓝图 (blueprints 表)
 *
 * 取代旧的 chapter-repository.ts，管理章节的规划元数据。
 */
import { createHash } from 'node:crypto'

import { getProjectDb } from '../database'
import { CharacterRosterRepository } from './character-roster-repository'
import { blueprintCharacterSyncFactError } from '../../src/shared/blueprint-character-sync-evidence'

/** 蓝图行类型（DB 蛇形命名） */
export interface BlueprintRow {
    chapter_number: number
    title: string
    role: string
    purpose: string
    key_events: string
    characters: string
    suspense_hook: string
    user_guidance: string
    notes: string
    notes_updated_at: string
    created_at: string
    updated_at: string
}

/** 前端使用的驼峰接口 */
export interface BlueprintData {
    chapterNumber: number
    title: string
    role: string
    purpose: string
    keyEvents: string
    characters: string[]
    /**
     * Relationship payload from the just-generated blueprint. It is not part
     * of the editable blueprints table; an atomic range commit retains it in
     * the immutable operation receipt so character sync can be replayed.
     */
    relationshipHints?: unknown
    suspenseHook: string
    userGuidance: string
    notes: string
    notesUpdatedAt: string
}

export type BlueprintRangeCommitMode = 'full' | 'replace-range'

export interface BlueprintRangeCommitRequest {
    mode: BlueprintRangeCommitMode
    operationId: string
    startChapter: number
    endChapter: number
    blueprints: BlueprintData[]
}

export interface BlueprintRangeCommitReceipt {
    mode: BlueprintRangeCommitMode
    operationId: string
    payloadHash: string
    idempotent: boolean
    startChapter: number
    endChapter: number
    chapterNumbers: number[]
    snapshot: BlueprintData[]
    /** Frozen generation facts required to replay character-candidate sync. */
    characterSyncInput: BlueprintData[]
    /** Durable post-commit work item; it survives renderer/app restarts. */
    characterSyncOperation: BlueprintCharacterSyncOperation
}

export interface BlueprintCharacterSyncCompletionReceipt {
    blueprintCommitOperationId: string
    operationId: string
    status: 'committed' | 'already-satisfied'
    /** Hash/revision evidence only; the authoritative roster snapshot stays in its fact tables. */
    rosterReceipt?: {
        operationId: string
        payloadHash: string
        revision: number
        idempotent: boolean
    }
}

export interface BlueprintCharacterSyncOperation {
    operationId: string
    blueprintCommitOperationId: string
    blueprintCommitPayloadHash: string
    status: 'pending' | 'completed'
    startChapter: number
    endChapter: number
    characterSyncInput: BlueprintData[]
    completionReceipt?: BlueprintCharacterSyncCompletionReceipt
    createdAt: string
    updatedAt: string
    completedAt?: string
}

interface BlueprintCommitOperationRow {
    operation_id: string
    payload_hash: string
    mode: BlueprintRangeCommitMode
    start_chapter: number
    end_chapter: number
    character_sync_input: string
}

interface BlueprintCharacterSyncOperationRow {
    operation_id: string
    blueprint_commit_operation_id: string
    blueprint_commit_payload_hash: string
    status: 'pending' | 'completed'
    start_chapter: number
    end_chapter: number
    character_sync_input: string
    completion_receipt: string | null
    created_at: string
    updated_at: string
    completed_at: string | null
}

interface CharacterRosterOperationEvidenceRow {
    operation_id: string
    payload_hash: string
    committed_revision: number
    projection_hash: string
}

const SHA256_HEX = /^[a-f0-9]{64}$/u

function rowToData(row: BlueprintRow): BlueprintData {
    let chars: string[] = []
    try { chars = JSON.parse(row.characters) } catch { /* 容错 */ }
    return {
        chapterNumber: row.chapter_number,
        title: row.title,
        role: row.role,
        purpose: row.purpose,
        keyEvents: row.key_events,
        characters: chars,
        suspenseHook: row.suspense_hook,
        userGuidance: row.user_guidance,
        notes: row.notes,
        notesUpdatedAt: row.notes_updated_at,
    }
}

function requireProjectDb(): NonNullable<ReturnType<typeof getProjectDb>> {
    const db = getProjectDb()
    if (!db) throw new Error('项目数据库未打开')
    return db
}

function ensureBlueprintCommitSchema(db: NonNullable<ReturnType<typeof getProjectDb>>): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS blueprint_commit_operations (
        operation_id TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('full', 'replace-range')),
        start_chapter INTEGER NOT NULL,
        end_chapter INTEGER NOT NULL,
        character_sync_input TEXT NOT NULL,
        committed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS blueprint_character_sync_operations (
        operation_id TEXT PRIMARY KEY,
        blueprint_commit_operation_id TEXT NOT NULL UNIQUE,
        blueprint_commit_payload_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'completed')),
        start_chapter INTEGER NOT NULL,
        end_chapter INTEGER NOT NULL,
        character_sync_input TEXT NOT NULL,
        completion_receipt TEXT DEFAULT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT DEFAULT NULL,
        FOREIGN KEY (blueprint_commit_operation_id)
          REFERENCES blueprint_commit_operations(operation_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_blueprint_character_sync_status
        ON blueprint_character_sync_operations(status, created_at);

      INSERT OR IGNORE INTO blueprint_character_sync_operations (
        operation_id,
        blueprint_commit_operation_id,
        blueprint_commit_payload_hash,
        start_chapter,
        end_chapter,
        character_sync_input
      )
      SELECT
        'blueprint-sync-' || operation_id,
        operation_id,
        payload_hash,
        start_chapter,
        end_chapter,
        character_sync_input
      FROM blueprint_commit_operations;
    `)
}

/** Caller owns the surrounding transaction when composing a multi-fact project clear. */
export function clearBlueprintFactsWithinTransaction(
    db: NonNullable<ReturnType<typeof getProjectDb>>,
): void {
    ensureBlueprintCommitSchema(db)
    db.prepare('DELETE FROM blueprint_character_sync_operations').run()
    db.prepare('DELETE FROM blueprint_commit_operations').run()
    db.prepare('DELETE FROM blueprints').run()
}

function characterSyncOperationId(blueprintCommitOperationId: string): string {
    return `blueprint-sync-${blueprintCommitOperationId}`
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .filter(([, entry]) => entry !== undefined)
            .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
            .map(([key, entry]) => [key, canonicalize(entry)]),
    )
}

function commitPayloadHash(request: BlueprintRangeCommitRequest): string {
    return createHash('sha256').update(JSON.stringify(canonicalize({
        mode: request.mode,
        startChapter: request.startChapter,
        endChapter: request.endChapter,
        blueprints: request.blueprints,
    }))).digest('hex')
}

function assertExactRange(request: BlueprintRangeCommitRequest): void {
    const { operationId, startChapter, endChapter, blueprints } = request
    if (!operationId.trim()) throw new Error('蓝图提交缺少操作 ID')
    if (request.mode !== 'full' && request.mode !== 'replace-range') {
        throw new Error('蓝图提交模式无效')
    }
    if (
        !Number.isInteger(startChapter)
        || !Number.isInteger(endChapter)
        || startChapter < 1
        || endChapter < startChapter
    ) {
        throw new Error('蓝图提交范围无效')
    }
    if (request.mode === 'full' && startChapter !== 1) {
        throw new Error('全量蓝图提交必须从第 1 章开始')
    }

    const expectedNumbers = Array.from(
        { length: endChapter - startChapter + 1 },
        (_, index) => startChapter + index,
    )
    const actualNumbers = blueprints.map(item => item.chapterNumber)
    if (
        actualNumbers.length !== expectedNumbers.length
        || new Set(actualNumbers).size !== actualNumbers.length
        || expectedNumbers.some(chapterNumber => !actualNumbers.includes(chapterNumber))
    ) {
        throw new Error(`蓝图提交必须完整且唯一地覆盖第 ${startChapter}–${endChapter} 章`)
    }
}

function readExactRange(
    db: NonNullable<ReturnType<typeof getProjectDb>>,
    request: Pick<BlueprintRangeCommitRequest, 'mode' | 'operationId' | 'startChapter' | 'endChapter'>,
): BlueprintData[] {
    const rows = db.prepare(`
      SELECT * FROM blueprints
      WHERE chapter_number BETWEEN ? AND ?
      ORDER BY chapter_number ASC
    `).all(request.startChapter, request.endChapter) as BlueprintRow[]
    const snapshot = rows.map(rowToData)
    assertExactRange({ ...request, blueprints: snapshot })
    return snapshot
}

function readCharacterSyncInput(row: BlueprintCommitOperationRow): BlueprintData[] {
    let parsed: unknown
    try {
        parsed = JSON.parse(row.character_sync_input)
    } catch {
        throw new Error('蓝图提交幂等回执损坏')
    }
    if (!Array.isArray(parsed)) throw new Error('蓝图提交幂等回执格式无效')
    return parsed as BlueprintData[]
}

function parseCharacterSyncInput(serialized: string): BlueprintData[] {
    let parsed: unknown
    try {
        parsed = JSON.parse(serialized)
    } catch {
        throw new Error('蓝图角色同步操作的冻结输入已损坏')
    }
    if (!Array.isArray(parsed)) throw new Error('蓝图角色同步操作的冻结输入格式无效')
    return parsed as BlueprintData[]
}

function parseCompletionReceipt(
    serialized: string | null,
): BlueprintCharacterSyncCompletionReceipt | undefined {
    if (serialized === null) return undefined
    let parsed: unknown
    try {
        parsed = JSON.parse(serialized)
    } catch {
        throw new Error('蓝图角色同步完成回执已损坏')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('蓝图角色同步完成回执格式无效')
    }
    return parsed as BlueprintCharacterSyncCompletionReceipt
}

function rowToCharacterSyncOperation(
    row: BlueprintCharacterSyncOperationRow,
): BlueprintCharacterSyncOperation {
    const completionReceipt = parseCompletionReceipt(row.completion_receipt)
    if (row.status === 'pending' && completionReceipt) {
        throw new Error('待处理蓝图角色同步操作不应包含完成回执')
    }
    if (row.status === 'completed' && !completionReceipt) {
        throw new Error('已完成蓝图角色同步操作缺少完成回执')
    }
    return {
        operationId: row.operation_id,
        blueprintCommitOperationId: row.blueprint_commit_operation_id,
        blueprintCommitPayloadHash: row.blueprint_commit_payload_hash,
        status: row.status,
        startChapter: row.start_chapter,
        endChapter: row.end_chapter,
        characterSyncInput: parseCharacterSyncInput(row.character_sync_input),
        ...(completionReceipt ? { completionReceipt } : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    }
}

function readCharacterSyncOperation(
    db: NonNullable<ReturnType<typeof getProjectDb>>,
    operationId: string,
): BlueprintCharacterSyncOperation | null {
    const row = db.prepare(`
      SELECT
        operation_id,
        blueprint_commit_operation_id,
        blueprint_commit_payload_hash,
        status,
        start_chapter,
        end_chapter,
        character_sync_input,
        completion_receipt,
        created_at,
        updated_at,
        completed_at
      FROM blueprint_character_sync_operations
      WHERE operation_id = ?
    `).get(operationId) as BlueprintCharacterSyncOperationRow | undefined
    return row ? rowToCharacterSyncOperation(row) : null
}

function authoritativeCharacterSyncCompletionReceipt(
    db: NonNullable<ReturnType<typeof getProjectDb>>,
    operation: BlueprintCharacterSyncOperation,
): BlueprintCharacterSyncCompletionReceipt {
    const roster = CharacterRosterRepository.read()
    if (roster.status !== 'ready' && roster.status !== 'empty') {
        throw new Error('角色名单当前不可验证，已拒绝完成蓝图角色同步')
    }
    const factError = blueprintCharacterSyncFactError(operation.characterSyncInput, roster.entries)
    if (factError) throw new Error(`${factError}，已拒绝完成蓝图角色同步`)

    const rosterOperation = db.prepare(`
      SELECT operation_id, payload_hash, committed_revision, projection_hash
      FROM character_roster_operations
      WHERE operation_id = ?
    `).get(operation.operationId) as CharacterRosterOperationEvidenceRow | undefined
    if (!rosterOperation) {
        return {
            blueprintCommitOperationId: operation.blueprintCommitOperationId,
            operationId: operation.operationId,
            status: 'already-satisfied',
        }
    }
    if (
        rosterOperation.operation_id !== operation.operationId
        || rosterOperation.committed_revision < 1
        || rosterOperation.committed_revision > roster.revision
        || !SHA256_HEX.test(rosterOperation.payload_hash)
        || !SHA256_HEX.test(rosterOperation.projection_hash)
    ) {
        throw new Error('角色名单操作证据与当前事实不匹配，已拒绝完成蓝图角色同步')
    }
    return {
        blueprintCommitOperationId: operation.blueprintCommitOperationId,
        operationId: operation.operationId,
        status: 'committed',
        rosterReceipt: {
            operationId: rosterOperation.operation_id,
            payloadHash: rosterOperation.payload_hash,
            revision: rosterOperation.committed_revision,
            idempotent: false,
        },
    }
}

function snapshotWithRelationshipHints(
    persisted: readonly BlueprintData[],
    characterSyncInput: readonly BlueprintData[],
): BlueprintData[] {
    const inputByChapter = new Map(
        characterSyncInput.map(blueprint => [blueprint.chapterNumber, blueprint] as const),
    )
    return persisted.map((blueprint) => {
        const relationshipHints = inputByChapter.get(blueprint.chapterNumber)?.relationshipHints
        return relationshipHints === undefined ? blueprint : { ...blueprint, relationshipHints }
    })
}

function samePersistedBlueprint(left: BlueprintData, right: BlueprintData): boolean {
    return left.chapterNumber === right.chapterNumber
        && left.title === right.title
        && left.role === right.role
        && left.purpose === right.purpose
        && left.keyEvents === right.keyEvents
        && JSON.stringify(left.characters) === JSON.stringify(right.characters)
        && left.suspenseHook === right.suspenseHook
        && left.userGuidance === right.userGuidance
        && left.notes === right.notes
        && left.notesUpdatedAt === right.notesUpdatedAt
}

export class BlueprintRepository {
    /** 获取所有蓝图（按章节号排序） */
    static getAll(): BlueprintData[] {
        const db = requireProjectDb()

        const rows = db.prepare(
            'SELECT * FROM blueprints ORDER BY chapter_number ASC'
        ).all() as BlueprintRow[]

        return rows.map(rowToData)
    }

    /** 获取单个蓝图 */
    static getByChapter(chapterNumber: number): BlueprintData | null {
        const db = requireProjectDb()

        const row = db.prepare(
            'SELECT * FROM blueprints WHERE chapter_number = ?'
        ).get(chapterNumber) as BlueprintRow | undefined

        return row ? rowToData(row) : null
    }

    /** 获取蓝图总数 */
    static count(): number {
        const db = requireProjectDb()

        const row = db.prepare(
            'SELECT COUNT(*) as cnt FROM blueprints'
        ).get() as { cnt: number }

        return row.cnt
    }

    /** 插入或更新蓝图 */
    static upsert(data: BlueprintData): void {
        const db = requireProjectDb()

        db.prepare(`
      INSERT INTO blueprints (
        chapter_number, title, role, purpose, key_events, characters,
        suspense_hook, user_guidance, notes, notes_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chapter_number) DO UPDATE SET
        title = excluded.title,
        role = excluded.role,
        purpose = excluded.purpose,
        key_events = excluded.key_events,
        characters = excluded.characters,
        suspense_hook = excluded.suspense_hook,
        user_guidance = excluded.user_guidance,
        notes = excluded.notes,
        notes_updated_at = excluded.notes_updated_at,
        updated_at = datetime('now')
    `).run(
            data.chapterNumber,
            data.title,
            data.role,
            data.purpose,
            data.keyEvents,
            JSON.stringify(data.characters),
            data.suspenseHook,
            data.userGuidance,
            data.notes,
            data.notesUpdatedAt,
        )
    }

    /** 批量插入/更新蓝图（事务） */
    static upsertMany(items: BlueprintData[]): void {
        const db = requireProjectDb()

        const tx = db.transaction(() => {
            for (const item of items) {
                BlueprintRepository.upsert(item)
            }
        })
        tx()
    }

    /** Pure read-back of the operation ledger and its currently bound range/sync evidence. */
    static getCommittedRangeOperation(operationId: string): BlueprintRangeCommitReceipt | null {
        if (!operationId.trim()) throw new Error('蓝图提交缺少操作 ID')
        const db = requireProjectDb()
        ensureBlueprintCommitSchema(db)
        const operation = db.prepare(`
          SELECT operation_id, payload_hash, mode, start_chapter, end_chapter, character_sync_input
          FROM blueprint_commit_operations
          WHERE operation_id = ?
        `).get(operationId) as BlueprintCommitOperationRow | undefined
        if (!operation) return null
        const characterSyncInput = readCharacterSyncInput(operation)
        const persisted = readExactRange(db, {
            mode: operation.mode,
            operationId: operation.operation_id,
            startChapter: operation.start_chapter,
            endChapter: operation.end_chapter,
        })
        const snapshot = snapshotWithRelationshipHints(persisted, characterSyncInput)
        const characterSyncOperation = readCharacterSyncOperation(
            db,
            characterSyncOperationId(operation.operation_id),
        )
        if (!characterSyncOperation) throw new Error('蓝图提交缺少可恢复的角色同步操作')
        return {
            mode: operation.mode,
            operationId: operation.operation_id,
            payloadHash: operation.payload_hash,
            idempotent: false,
            startChapter: operation.start_chapter,
            endChapter: operation.end_chapter,
            chapterNumbers: snapshot.map(blueprint => blueprint.chapterNumber),
            snapshot,
            characterSyncInput,
            characterSyncOperation,
        }
    }

    /** 完整逻辑范围只提交一次，并在同一事务内回读验证后返回收据。 */
    static commitRange(request: BlueprintRangeCommitRequest): BlueprintRangeCommitReceipt {
        assertExactRange(request)
        const db = requireProjectDb()
        ensureBlueprintCommitSchema(db)
        const payloadHash = commitPayloadHash(request)
        const tx = db.transaction(() => {
            const existingOperation = db.prepare(`
              SELECT operation_id, payload_hash, mode, start_chapter, end_chapter, character_sync_input
              FROM blueprint_commit_operations
              WHERE operation_id = ?
            `).get(request.operationId) as BlueprintCommitOperationRow | undefined
            if (existingOperation) {
                if (existingOperation.payload_hash !== payloadHash) {
                    throw new Error('操作 ID 已被用于不同的蓝图提交，已拒绝覆盖')
                }
                const characterSyncInput = readCharacterSyncInput(existingOperation)
                const persisted = readExactRange(db, {
                    mode: existingOperation.mode,
                    operationId: existingOperation.operation_id,
                    startChapter: existingOperation.start_chapter,
                    endChapter: existingOperation.end_chapter,
                })
                const snapshot = snapshotWithRelationshipHints(persisted, characterSyncInput)
                const characterSyncOperation = readCharacterSyncOperation(
                    db,
                    characterSyncOperationId(existingOperation.operation_id),
                )
                if (!characterSyncOperation) throw new Error('蓝图提交缺少可恢复的角色同步操作')
                return {
                    mode: existingOperation.mode,
                    operationId: existingOperation.operation_id,
                    payloadHash,
                    idempotent: true,
                    startChapter: existingOperation.start_chapter,
                    endChapter: existingOperation.end_chapter,
                    chapterNumbers: snapshot.map(blueprint => blueprint.chapterNumber),
                    snapshot,
                    characterSyncInput,
                    characterSyncOperation,
                }
            }

            if (request.mode === 'full') {
                db.prepare(
                    'DELETE FROM blueprints WHERE chapter_number < ? OR chapter_number > ?',
                ).run(request.startChapter, request.endChapter)
            }
            for (const blueprint of request.blueprints) {
                BlueprintRepository.upsert(blueprint)
            }

            const persisted = readExactRange(db, request)

            const expectedByChapter = new Map(
                request.blueprints.map(blueprint => [blueprint.chapterNumber, blueprint] as const),
            )
            for (const saved of persisted) {
                const expected = expectedByChapter.get(saved.chapterNumber)
                if (!expected || !samePersistedBlueprint(saved, expected)) {
                    throw new Error(`蓝图提交回读不一致：第 ${saved.chapterNumber} 章`)
                }
            }

            const characterSyncInput = request.blueprints.map(blueprint => ({ ...blueprint }))
            db.prepare(`
              INSERT INTO blueprint_commit_operations (
                operation_id, payload_hash, mode, start_chapter, end_chapter, character_sync_input
              ) VALUES (?, ?, ?, ?, ?, ?)
            `).run(
                request.operationId,
                payloadHash,
                request.mode,
                request.startChapter,
                request.endChapter,
                JSON.stringify(characterSyncInput),
            )
            const syncOperationId = characterSyncOperationId(request.operationId)
            db.prepare(`
              INSERT INTO blueprint_character_sync_operations (
                operation_id,
                blueprint_commit_operation_id,
                blueprint_commit_payload_hash,
                start_chapter,
                end_chapter,
                character_sync_input
              ) VALUES (?, ?, ?, ?, ?, ?)
            `).run(
                syncOperationId,
                request.operationId,
                payloadHash,
                request.startChapter,
                request.endChapter,
                JSON.stringify(characterSyncInput),
            )
            const snapshot = snapshotWithRelationshipHints(persisted, characterSyncInput)
            const characterSyncOperation = readCharacterSyncOperation(db, syncOperationId)
            if (!characterSyncOperation) throw new Error('蓝图提交未创建可恢复的角色同步操作')

            return {
                mode: request.mode,
                operationId: request.operationId,
                payloadHash,
                idempotent: false,
                startChapter: request.startChapter,
                endChapter: request.endChapter,
                chapterNumbers: snapshot.map(blueprint => blueprint.chapterNumber),
                snapshot,
                characterSyncInput,
                characterSyncOperation,
            }
        })
        return tx()
    }

    /** Lists durable post-commit work that can be resumed after an app restart. */
    static listPendingCharacterSyncOperations(): BlueprintCharacterSyncOperation[] {
        const db = requireProjectDb()
        ensureBlueprintCommitSchema(db)
        const rows = db.prepare(`
          SELECT
            operation_id,
            blueprint_commit_operation_id,
            blueprint_commit_payload_hash,
            status,
            start_chapter,
            end_chapter,
            character_sync_input,
            completion_receipt,
            created_at,
            updated_at,
            completed_at
          FROM blueprint_character_sync_operations
          WHERE status = 'pending'
          ORDER BY created_at ASC, operation_id ASC
        `).all() as BlueprintCharacterSyncOperationRow[]
        return rows.map(rowToCharacterSyncOperation)
    }

    static getCharacterSyncOperation(operationId: string): BlueprintCharacterSyncOperation | null {
        if (!operationId.trim()) throw new Error('蓝图角色同步操作 ID 不能为空')
        const db = requireProjectDb()
        ensureBlueprintCommitSchema(db)
        return readCharacterSyncOperation(db, operationId)
    }

    static completeCharacterSyncOperation(
        operationId: string,
    ): BlueprintCharacterSyncOperation {
        if (!operationId.trim()) throw new Error('蓝图角色同步操作 ID 不能为空')
        const db = requireProjectDb()
        ensureBlueprintCommitSchema(db)
        const tx = db.transaction(() => {
            const operation = readCharacterSyncOperation(db, operationId)
            if (!operation) throw new Error('待处理蓝图角色同步操作不存在')
            if (operation.status === 'completed') return operation
            const completionReceipt = authoritativeCharacterSyncCompletionReceipt(db, operation)
            const result = db.prepare(`
              UPDATE blueprint_character_sync_operations
              SET
                status = 'completed',
                completion_receipt = ?,
                completed_at = datetime('now'),
                updated_at = datetime('now')
              WHERE operation_id = ? AND status = 'pending'
            `).run(JSON.stringify(canonicalize(completionReceipt)), operationId)
            if (result.changes !== 1) throw new Error('蓝图角色同步完成状态更新失败')
            const completed = readCharacterSyncOperation(db, operationId)
            if (!completed || completed.status !== 'completed' || !completed.completionReceipt) {
                throw new Error('蓝图角色同步完成回执回读失败')
            }
            return completed
        })
        return tx()
    }

    /** 删除蓝图 */
    static delete(chapterNumber: number): void {
        const db = requireProjectDb()

        db.prepare('DELETE FROM blueprints WHERE chapter_number = ?').run(chapterNumber)
    }

    /** 删除所有章节蓝图 */
    static clearAll(): void {
        const db = requireProjectDb()
        const tx = db.transaction(() => {
            clearBlueprintFactsWithinTransaction(db)
        })
        tx()
    }

    /** 仅更新 notes 字段 */
    static updateNotes(chapterNumber: number, notes: string): boolean {
        const db = requireProjectDb()

        const result = db.prepare(`
      UPDATE blueprints
      SET notes = ?, notes_updated_at = datetime('now'), updated_at = datetime('now')
      WHERE chapter_number = ?
    `).run(notes, chapterNumber)
        return result.changes > 0
    }
}
