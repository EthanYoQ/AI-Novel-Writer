import fs from 'node:fs'
import path from 'node:path'

import { getCurrentProjectPath, getProjectDb } from '../database'
import { ensureCharacterRosterSchema } from './character-roster-schema'
import { clearBlueprintFactsWithinTransaction } from './blueprint-repository'

export type ProjectClearScope = 'creativeFields' | 'blueprints' | 'generatedText'

export interface ProjectClearOptions {
    creativeFields?: boolean
    blueprints?: boolean
    generatedText?: boolean
}

export interface ProjectClearResult {
    cleared: ProjectClearScope[]
    physicalFilesDeleted: number
}

interface MovedFile {
    from: string
    to: string
}

const FINALIZED_CHAPTER_FILE_RE = /^第\d+章(?: .*)?\.txt$/u

function listGeneratedChapterFiles(projectPath: string): string[] {
    if (!fs.existsSync(projectPath)) return []
    return fs.readdirSync(projectPath, { withFileTypes: true })
        .filter(entry => entry.isFile() && FINALIZED_CHAPTER_FILE_RE.test(entry.name))
        .map(entry => path.join(projectPath, entry.name))
}

function moveGeneratedFilesToTrash(projectPath: string): MovedFile[] {
    const files = listGeneratedChapterFiles(projectPath)
    if (files.length === 0) return []

    const trashDir = path.join(
        projectPath,
        '.vela',
        'trash',
        `clear-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    )
    fs.mkdirSync(trashDir, { recursive: true })

    const moved: MovedFile[] = []
    try {
        for (const file of files) {
            const target = path.join(trashDir, path.basename(file))
            fs.renameSync(file, target)
            moved.push({ from: file, to: target })
        }
        return moved
    } catch (error) {
        restoreMovedFiles(moved)
        throw error
    }
}

function restoreMovedFiles(moved: MovedFile[]): void {
    for (const item of [...moved].reverse()) {
        if (fs.existsSync(item.to) && !fs.existsSync(item.from)) {
            fs.renameSync(item.to, item.from)
        }
    }
}

function removeMovedFiles(moved: MovedFile[]): void {
    const dirs = new Set<string>()
    for (const item of moved) {
        dirs.add(path.dirname(item.to))
    }

    for (const dir of dirs) {
        fs.rmSync(dir, { recursive: true, force: true })
    }
}

export class ProjectClearRepository {
    static clearGeneratedData(options: ProjectClearOptions): ProjectClearResult {
        const db = getProjectDb()
        if (!db) throw new Error('项目数据库未打开')

        const projectPath = getCurrentProjectPath()
        if (options.generatedText && !projectPath) throw new Error('项目路径未初始化')

        const movedFiles = options.generatedText && projectPath
            ? moveGeneratedFilesToTrash(projectPath)
            : []
        // 清空创作字段会连同 characters 表一起清掉，自定义头像（只以文件名记在
        // 那一行里）若不删就留下永远无人引用的图片文件。
        const avatarDirectory = options.creativeFields && projectPath
            ? path.join(projectPath, '.vela', 'avatars')
            : null
        // 架构生成检查点保存着 premise / 世界观 / 情节大纲的片段与指纹。清空
        // 创作字段后它必然与新数据库正文不一致：残留会让下一次「情节大纲续批」
        // 直接以「检查点正文与数据库原文不一致，无法安全续写」失败。
        const architectureCheckpoint = options.creativeFields && projectPath
            ? path.join(projectPath, '.vela', 'partial_arch.json')
            : null
        const cleared: ProjectClearScope[] = []

        try {
            const tx = db.transaction(() => {
                if (options.generatedText) {
                    db.prepare('DELETE FROM finalized_draft_import_operations').run()
                    db.prepare('DELETE FROM post_process_steps').run()
                    db.prepare('DELETE FROM post_process_runs').run()
                    db.prepare('DELETE FROM reviews').run()
                    db.prepare('DELETE FROM revisions').run()
                    db.prepare('DELETE FROM drafts').run()
                    db.prepare('DELETE FROM contents').run()
                    db.prepare('DELETE FROM summary_snapshots').run()
                    cleared.push('generatedText')
                }

                if (options.blueprints) {
                    clearBlueprintFactsWithinTransaction(db)
                    cleared.push('blueprints')
                }

                if (options.creativeFields) {
                    // 即使项目是在 roster 元数据迁移前创建的，也必须先按唯一
                    // 迁移规则建立元数据表，再在同一 transaction 内清空角色事实
                    // 与 receipt。这样下次 read 会重新分类为空项目，而不会遗留
                    // ready 状态或旧角色参与新的架构生成。
                    ensureCharacterRosterSchema(db)
                    db.prepare('DELETE FROM character_roster_operations').run()
                    db.prepare('DELETE FROM character_roster_meta').run()
                    db.prepare('DELETE FROM characters').run()
                    db.prepare(`
                        UPDATE project_core
                        SET writing_style = '',
                            reference_works = '',
                            global_guidance = '',
                            golden_finger = '',
                            premise = '',
                            worldbuilding = '',
                            characters_arch = '',
                            synopsis = '',
                            character_states = '',
                            updated_at = datetime('now')
                        WHERE id = 'main'
                    `).run()
                    cleared.push('creativeFields')
                }
            })

            tx()
            removeMovedFiles(movedFiles)
            if (avatarDirectory) {
                // 文件删除发生在事务提交之后，无法回滚；失败时留一个孤儿目录
                // 只占磁盘、不影响创作事实，因此不让它把已完成的清除判成失败。
                try {
                    fs.rmSync(avatarDirectory, { recursive: true, force: true })
                } catch {
                    console.warn('[Vela ProjectClear] 头像目录清理失败，已跳过。')
                }
            }
            if (architectureCheckpoint) {
                // 同样在事务提交之后：失败不回滚，但必须留下可定位的告警路径，
                // 否则残留检查点会让「情节大纲续批」以不一致为由永久失败。
                try {
                    fs.rmSync(architectureCheckpoint, { force: true })
                } catch {
                    console.warn(
                        `[Vela ProjectClear] 架构检查点清理失败，请手工删除：${architectureCheckpoint}`,
                    )
                }
            }
            return { cleared, physicalFilesDeleted: movedFiles.length }
        } catch (error) {
            restoreMovedFiles(movedFiles)
            throw error
        }
    }
}
