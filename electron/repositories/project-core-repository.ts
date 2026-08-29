/**
 * ProjectCoreRepository — 项目主台账 (project_core 表)
 *
 * 合并 NovelConfig + 架构四大件的统一读写。
 * 始终只有一行数据 (id = 'main')。
 */
import { getProjectDb } from '../database'
import { CREATIVE_STRATEGIES, type CreativeStrategy } from '../../src/shared/reasoning-types'
import {
    DEFAULT_WRITING_LANGUAGE,
    resolveWritingLanguage,
    type WritingLanguage,
} from '../../src/shared/writing-language'
import { resolveNarrativeThreadDormantThreshold } from '../../src/shared/narrative-thread'

/** project_core 表行类型 */
export interface ProjectCoreRow {
    id: string
    project_name: string
    genre: string
    sub_genre: string
    target_audience: string
    total_chapters: number
    words_per_chapter: number
    writing_language: string
    creative_strategy: string
    narrative_thread_dormant_threshold: number
    plot_structure: string
    narrative_pov: string
    writing_style: string
    reference_works: string
    global_guidance: string
    golden_finger: string
    core_outline: string
    world_setting: string
    protagonist_profile: string
    premise: string
    worldbuilding: string
    characters_arch: string
    synopsis: string
    character_states: string
    created_at: string
    updated_at: string
}

/** 前端使用的驼峰命名接口 */
export interface ProjectCoreData {
    projectName: string
    genre: string
    subGenre: string
    targetAudience: string
    totalChapters: number
    wordsPerChapter: number
    writingLanguage: WritingLanguage
    creativeStrategy: CreativeStrategy
    narrativeThreadDormantChapterThreshold: number
    plotStructure: string
    narrativePov: string
    writingStyle: string
    referenceWorks: string
    globalGuidance: string
    goldenFinger: string
    coreOutline: string
    worldSetting: string
    protagonistProfile: string
    premise: string
    worldbuilding: string
    charactersArch: string
    synopsis: string
    characterStates: string
}

/** 数据库行 → 前端数据 */
function rowToData(row: ProjectCoreRow): ProjectCoreData {
    return {
        projectName: row.project_name,
        genre: row.genre,
        subGenre: row.sub_genre,
        targetAudience: row.target_audience,
        totalChapters: row.total_chapters,
        wordsPerChapter: row.words_per_chapter,
        writingLanguage: resolveWritingLanguage(row.writing_language),
        creativeStrategy: (
            CREATIVE_STRATEGIES.includes(row.creative_strategy as CreativeStrategy)
                ? row.creative_strategy
                : 'auto'
        ) as CreativeStrategy,
        narrativeThreadDormantChapterThreshold: resolveNarrativeThreadDormantThreshold(
            row.narrative_thread_dormant_threshold,
        ),
        plotStructure: row.plot_structure,
        narrativePov: row.narrative_pov,
        writingStyle: row.writing_style,
        referenceWorks: row.reference_works,
        globalGuidance: row.global_guidance,
        goldenFinger: row.golden_finger,
        coreOutline: row.core_outline,
        worldSetting: row.world_setting,
        protagonistProfile: row.protagonist_profile,
        premise: row.premise,
        worldbuilding: row.worldbuilding,
        charactersArch: row.characters_arch,
        synopsis: row.synopsis,
        characterStates: row.character_states,
    }
}

export class ProjectCoreRepository {
    /** 获取项目配置（不存在则返回 null） */
    static get(): ProjectCoreData | null {
        const db = getProjectDb()
        if (!db) return null

        const row = db.prepare(
            'SELECT * FROM project_core WHERE id = ?'
        ).get('main') as ProjectCoreRow | undefined

        return row ? rowToData(row) : null
    }

    /** 初始化项目配置（创建项目时调用） */
    static init(
        projectName: string,
        writingLanguage: WritingLanguage = DEFAULT_WRITING_LANGUAGE,
    ): void {
        const db = getProjectDb()
        if (!db) return

        db.prepare(`
      INSERT OR IGNORE INTO project_core (id, project_name, writing_language)
      VALUES ('main', ?, ?)
    `).run(projectName, writingLanguage)
    }

    /** 更新项目配置（传入部分字段即可） */
    static update(data: Partial<ProjectCoreData>): void {
        const db = getProjectDb()
        if (!db) throw new Error('项目数据库未打开')
        if (Object.hasOwn(data, 'charactersArch')) {
            throw new Error('角色图谱由角色名单自动生成；请通过角色管理修改角色资料')
        }

        // 构建动态 SET 子句，只更新传入的字段
        const fieldMap: Record<string, string> = {
            projectName: 'project_name',
            genre: 'genre',
            subGenre: 'sub_genre',
            targetAudience: 'target_audience',
            totalChapters: 'total_chapters',
            wordsPerChapter: 'words_per_chapter',
            writingLanguage: 'writing_language',
            creativeStrategy: 'creative_strategy',
            narrativeThreadDormantChapterThreshold: 'narrative_thread_dormant_threshold',
            plotStructure: 'plot_structure',
            narrativePov: 'narrative_pov',
            writingStyle: 'writing_style',
            referenceWorks: 'reference_works',
            globalGuidance: 'global_guidance',
            goldenFinger: 'golden_finger',
            coreOutline: 'core_outline',
            worldSetting: 'world_setting',
            protagonistProfile: 'protagonist_profile',
            premise: 'premise',
            worldbuilding: 'worldbuilding',
            synopsis: 'synopsis',
            characterStates: 'character_states',
        }

        const setClauses: string[] = []
        const values: unknown[] = []

        for (const [camel, col] of Object.entries(fieldMap)) {
            if (camel in data) {
                setClauses.push(`${col} = ?`)
                const value = (data as Record<string, unknown>)[camel]
                values.push(camel === 'narrativeThreadDormantChapterThreshold'
                    ? resolveNarrativeThreadDormantThreshold(value)
                    : value)
            }
        }

        if (setClauses.length === 0) return

        // 追加 updated_at
        setClauses.push("updated_at = datetime('now')")
        values.push('main')

        db.prepare(`
      UPDATE project_core SET ${setClauses.join(', ')} WHERE id = ?
    `).run(...values)
    }

    /** 清空由架构/导入/AI 分析生成的创作字段，保留项目名、章节规模与基础偏好 */
    static resetCreativeFields(): void {
        ProjectCoreRepository.update({
            writingStyle: '',
            referenceWorks: '',
            globalGuidance: '',
            goldenFinger: '',
            coreOutline: '',
            worldSetting: '',
            protagonistProfile: '',
            premise: '',
            worldbuilding: '',
            synopsis: '',
            characterStates: '',
        })
    }
}
