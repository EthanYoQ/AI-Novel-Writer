/**
 * CharacterRepository — 角色卡 (characters 表)
 *
 * currentState 子结构已拍平为 cs_* 前缀列，杜绝 JSON 大字段。
 */
import { getProjectDb } from '../database'
import {
    normalizeCharacterRole,
    type CharacterRole,
} from '../../src/shared/character-role'
import type {
    CharacterRosterCharacterState,
    CharacterStateFieldProvenance,
    CharacterStateTextField,
} from '../../src/shared/character-roster'

/** 角色卡动态状态 */
export type CharacterStateData = CharacterRosterCharacterState

function parseProvenance(value: unknown): Partial<Record<CharacterStateTextField, CharacterStateFieldProvenance>> {
    if (typeof value !== 'string' || !value.trim()) return {}
    try {
        const parsed = JSON.parse(value) as unknown
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Partial<Record<CharacterStateTextField, CharacterStateFieldProvenance>>
            : {}
    } catch {
        return {}
    }
}

/** 角色卡完整数据（前端驼峰接口） */
export interface CharacterData {
    name: string
    role: CharacterRole
    gender: string
    age: string
    appearance: string
    personality: string
    background: string
    abilities: string
    motivation: string
    relationships: string
    /**
     * 关系备注：作者填写的关系自由文本原话。它与 relationships 结构化边并存，
     * 由独立的 relationship_notes 列承载，因此改边不会丢原文、改原文也不会
     * 压掉边。任何通道都可写，但自动流程不得覆盖作者已有的非空备注。
     */
    relationshipNotes?: string
    arc: string
    notes: string
    /**
     * 自定义头像文件名（图片本体存 <项目>/.vela/avatars/）。空串 = 用姓名首字头像。
     * 它是作者的手工资产，不属于角色事实：刻意不出现在 upsert/saveAll 的写入
     * 与 ON CONFLICT 更新列表里，因此 AI 生成、蓝图同步、章节推进都覆盖不了它，
     * 也不会进入角色名单的投影哈希。
     * 声明为可选：只有 CharacterRepository 的读取会给它赋值，其余构造点（角色
     * 名单投影、仿写归一化、测试夹具）无需为此多写一个字段。
     */
    avatar?: string
    currentState?: CharacterStateData
}

export interface CharacterRenameData {
    originalName: string
    newName: string
}

function rowToData(row: Record<string, unknown>): CharacterData {
    const data: CharacterData = {
        name: row.name as string,
        role: normalizeCharacterRole(row.role),
        gender: (row.gender as string) || '',
        age: (row.age as string) || '',
        appearance: (row.appearance as string) || '',
        personality: (row.personality as string) || '',
        background: (row.background as string) || '',
        abilities: (row.abilities as string) || '',
        motivation: (row.motivation as string) || '',
        relationships: (row.relationships as string) || '',
        arc: (row.arc as string) || '',
        notes: (row.notes as string) || '',
        avatar: (row.avatar as string) || '',
    }

    // 关系备注只在有内容时出现：空备注不进入角色卡形状，避免污染逐字段比较。
    const relationshipNotes = ((row.relationship_notes as string) || '').trim()
    if (relationshipNotes) data.relationshipNotes = relationshipNotes

    // currentState 存在与否由列是否为 NULL 决定（chapter 0 为合法状态）
    const updatedChapter = row.cs_updated_at_chapter as number | null
    if (updatedChapter !== null && updatedChapter !== undefined) {
        const provenance = parseProvenance(row.cs_provenance)
        data.currentState = {
            location: (row.cs_location as string) || '',
            powerLevel: (row.cs_power_level as string) || '',
            physicalState: (row.cs_physical_state as string) || '',
            mentalState: (row.cs_mental_state as string) || '',
            keyItems: (row.cs_key_items as string) || '',
            recentEvents: (row.cs_recent_events as string) || '',
            updatedAtChapter: updatedChapter,
            // Pre-provenance ready rosters hashed the state without this key.
            // Keep an empty migrated column serialized in that legacy shape.
            ...(Object.keys(provenance).length > 0 ? { provenance } : {}),
        }
    }

    return data
}

export class CharacterRepository {
    /** 获取所有角色（按角色定位排序：主角→配角→反派→龙套） */
    static getAll(): CharacterData[] {
        const db = getProjectDb()
        if (!db) return []

        const rows = db.prepare(`
      SELECT * FROM characters
      ORDER BY
        CASE role
          WHEN 'protagonist' THEN 0
          WHEN 'supporting' THEN 1
          WHEN 'antagonist' THEN 2
          WHEN 'minor' THEN 3
          ELSE 9
        END ASC
    `).all() as Record<string, unknown>[]

        return rows.map(rowToData)
    }

    /** 获取单个角色 */
    static getByName(name: string): CharacterData | null {
        const db = getProjectDb()
        if (!db) return null

        const row = db.prepare(
            'SELECT * FROM characters WHERE name = ?'
        ).get(name) as Record<string, unknown> | undefined

        return row ? rowToData(row) : null
    }

    /** 获取角色数量 */
    static count(): number {
        const db = getProjectDb()
        if (!db) return 0

        const row = db.prepare(
            'SELECT COUNT(*) as cnt FROM characters'
        ).get() as { cnt: number }

        return row.cnt
    }

    /** 插入或更新角色 */
    static upsert(data: CharacterData): void {
        const db = getProjectDb()
        if (!db) return

        const cs = data.currentState
        db.prepare(`
      INSERT INTO characters (
        name, role, gender, age, appearance, personality, background,
        abilities, motivation, relationships, relationship_notes, arc, notes,
        cs_location, cs_power_level, cs_physical_state, cs_mental_state,
        cs_key_items, cs_recent_events, cs_updated_at_chapter
        , cs_provenance
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        role = excluded.role,
        gender = excluded.gender,
        age = excluded.age,
        appearance = excluded.appearance,
        personality = excluded.personality,
        background = excluded.background,
        abilities = excluded.abilities,
        motivation = excluded.motivation,
        relationships = excluded.relationships,
        relationship_notes = excluded.relationship_notes,
        arc = excluded.arc,
        notes = excluded.notes,
        cs_location = excluded.cs_location,
        cs_power_level = excluded.cs_power_level,
        cs_physical_state = excluded.cs_physical_state,
        cs_mental_state = excluded.cs_mental_state,
        cs_key_items = excluded.cs_key_items,
        cs_recent_events = excluded.cs_recent_events,
        cs_updated_at_chapter = excluded.cs_updated_at_chapter,
        cs_provenance = excluded.cs_provenance,
        updated_at = datetime('now')
    `).run(
            data.name,
            data.role,
            data.gender,
            data.age,
            data.appearance,
            data.personality,
            data.background,
            data.abilities,
            data.motivation,
            data.relationships,
            data.relationshipNotes ?? '',
            data.arc,
            data.notes,
            cs?.location ?? '',
            cs?.powerLevel ?? '',
            cs?.physicalState ?? '',
            cs?.mentalState ?? '',
            cs?.keyItems ?? '',
            cs?.recentEvents ?? '',
            cs?.updatedAtChapter ?? null,
            JSON.stringify(cs?.provenance ?? {}),
        )
    }

    /** 批量保存角色（事务） */
    static saveAll(characters: CharacterData[], renames: CharacterRenameData[] = []): void {
        const db = getProjectDb()
        if (!db) throw new Error('项目数据库未打开')

        const tx = db.transaction(() => {
            const normalizedCharacters = characters.map(character => ({
                ...character,
                name: character.name.trim(),
            }))
            const names = normalizedCharacters.map(character => character.name)
            if (names.some(name => !name)) throw new Error('角色名不能为空')
            if (new Set(names).size !== names.length) throw new Error('角色名必须唯一')

            const normalizedRenames = renames
                .map(rename => ({ originalName: rename.originalName, newName: rename.newName.trim() }))
                .filter(rename => rename.originalName !== rename.newName)
            if (normalizedRenames.some(rename => !rename.originalName || !rename.newName)) {
                throw new Error('角色改名的原名和新名不能为空')
            }
            const originalNames = normalizedRenames.map(rename => rename.originalName)
            const targetNames = normalizedRenames.map(rename => rename.newName)
            if (
                new Set(originalNames).size !== originalNames.length
                || new Set(targetNames).size !== targetNames.length
            ) {
                throw new Error('角色改名目标必须唯一')
            }

            for (const rename of normalizedRenames) {
                const original = db.prepare('SELECT 1 FROM characters WHERE name = ?').get(rename.originalName)
                if (!original) throw new Error(`角色「${rename.originalName}」不存在，无法改名`)
                const conflict = db.prepare('SELECT 1 FROM characters WHERE name = ?').get(rename.newName)
                if (conflict && !originalNames.includes(rename.newName)) {
                    throw new Error(`角色名「${rename.newName}」已存在`)
                }
                if (
                    !names.includes(rename.newName)
                    || (!targetNames.includes(rename.originalName) && names.includes(rename.originalName))
                ) {
                    throw new Error(`角色改名「${rename.originalName} → ${rename.newName}」与保存内容不一致`)
                }
            }

            // 两阶段改名先将全部原名移到事务内临时键，允许 A↔B 交换与
            // A→B、C→A 等链式改名，同时避免 SQLite 主键唯一约束中途冲突。
            const temporaryRenames = normalizedRenames.map((rename, index) => {
                let temporaryName = `__vela_rename_${Date.now()}_${index}__`
                while (
                    names.includes(temporaryName)
                    || targetNames.includes(temporaryName)
                    || db.prepare('SELECT 1 FROM characters WHERE name = ?').get(temporaryName)
                ) {
                    temporaryName += '_'
                }
                return { ...rename, temporaryName }
            })
            for (const rename of temporaryRenames) {
                db.prepare(`
                    UPDATE characters
                    SET name = ?, updated_at = datetime('now')
                    WHERE name = ?
                `).run(rename.temporaryName, rename.originalName)
            }
            for (const rename of temporaryRenames) {
                db.prepare(`
                    UPDATE characters
                    SET name = ?, updated_at = datetime('now')
                    WHERE name = ?
                `).run(rename.newName, rename.temporaryName)
            }

            if (normalizedRenames.length > 0) {
                const renameByOriginal = new Map(
                    normalizedRenames.map(rename => [rename.originalName, rename.newName]),
                )
                const blueprints = db.prepare(
                    'SELECT chapter_number, characters FROM blueprints'
                ).all() as Array<{ chapter_number: number; characters: string }>
                const updateBlueprint = db.prepare(`
                    UPDATE blueprints
                    SET characters = ?, updated_at = datetime('now')
                    WHERE chapter_number = ?
                `)
                for (const blueprint of blueprints) {
                    let characterNames: unknown
                    try {
                        characterNames = JSON.parse(blueprint.characters)
                    } catch {
                        throw new Error(`第 ${blueprint.chapter_number} 章蓝图角色列表损坏`)
                    }
                    if (
                        !Array.isArray(characterNames)
                        || !characterNames.every(name => typeof name === 'string')
                    ) {
                        throw new Error(`第 ${blueprint.chapter_number} 章蓝图角色列表格式错误`)
                    }
                    const renamed = characterNames.map(name => renameByOriginal.get(name) ?? name)
                    if (renamed.some((name, index) => name !== characterNames[index])) {
                        updateBlueprint.run(JSON.stringify(renamed), blueprint.chapter_number)
                    }
                }
            }

            for (const char of normalizedCharacters) {
                CharacterRepository.upsert(char)
            }
        })
        tx()
    }

    /** 删除角色 */
    static delete(name: string): void {
        const db = getProjectDb()
        if (!db) return

        db.prepare('DELETE FROM characters WHERE name = ?').run(name)
    }

    /** 读取自定义头像文件名；空串表示该角色使用姓名首字头像。 */
    static getAvatarFileName(name: string): string {
        const db = getProjectDb()
        if (!db) return ''

        const row = db.prepare('SELECT avatar FROM characters WHERE name = ?')
            .get(name) as { avatar?: string } | undefined
        return row?.avatar || ''
    }

    /**
     * 只写头像文件名。头像不进 upsert/saveAll：它是作者的手工资产，
     * 不属于角色事实，既不参与角色名单投影哈希，也不得被 AI 生成、
     * 蓝图同步或章节推进覆盖。角色改名时本列随主键行一起保留。
     */
    static setAvatar(name: string, fileName: string): boolean {
        const db = getProjectDb()
        if (!db) return false

        const result = db.prepare(`
      UPDATE characters SET avatar = ?, updated_at = datetime('now')
      WHERE name = ?
    `).run(fileName, name)
        return result.changes > 0
    }

    /** 仅更新角色动态状态（后处理时使用） */
    static updateState(name: string, state: CharacterStateData): void {
        const db = getProjectDb()
        if (!db) return

        db.prepare(`
      UPDATE characters SET
        cs_location = ?, cs_power_level = ?, cs_physical_state = ?,
        cs_mental_state = ?, cs_key_items = ?, cs_recent_events = ?,
        cs_updated_at_chapter = ?, updated_at = datetime('now')
        , cs_provenance = ?
      WHERE name = ?
    `).run(
            state.location,
            state.powerLevel,
            state.physicalState,
            state.mentalState,
            state.keyItems,
            state.recentEvents,
            state.updatedAtChapter,
            JSON.stringify(state.provenance ?? {}),
            name,
        )
    }
}
