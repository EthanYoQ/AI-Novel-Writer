/**
 * vela-protocol — 统一管理 vela:// 伪协议路径解析
 *
 * 所有 vela:// 路径的常量映射和解析逻辑集中在此，
 * 新增架构字段或路径协议时只需修改此文件。
 */

import type { ProjectSessionContext } from '../shared/ipc-channels'
import { ipc } from './ipc-client'

// ===== vela://core/ 架构字段映射 =====

/** 路径 key → ProjectCoreData 中的驼峰字段名 */
export const CORE_FIELD_MAP: Record<string, string> = {
    premise: 'premise',
    worldbuilding: 'worldbuilding',
    characters: 'charactersArch',
    synopsis: 'synopsis',
}

/** 从 vela://core/ 路径中解析出 DB 字段名 */
export function parseCoreField(velaPath: string): string | null {
    if (!velaPath.startsWith('vela://core/')) return null
    const key = velaPath.replace('vela://core/', '')
    return CORE_FIELD_MAP[key] ?? null
}

/** 从 DB 读取 vela://core/ 路径对应的内容 */
export async function readCoreContent(
    velaPath: string,
    projectSession: ProjectSessionContext,
): Promise<string> {
    const key = velaPath.replace('vela://core/', '')
    if (key === 'characters') {
        const roster = await ipc.invokeWithProjectSession(
            projectSession,
            'db:character-roster-read',
            projectSession.projectPath,
        )
        // 角色图谱是 roster 的只读投影；未 ready 时仅展示已存档的旧文本证据，
        // 绝不从 project_core.charactersArch 把不一致投影伪装成事实。
        return roster.status === 'ready'
            ? roster.renderedMarkdown
            : roster.legacyMarkdown ?? ''
    }
    const core = await ipc.invokeWithProjectSession(
        projectSession,
        'db:project-core-get',
        projectSession.projectPath,
    )
    if (!core) throw new Error('无法读取故事架构内容')
    const fieldMap: Record<string, string> = {
        premise: core.premise || '',
        worldbuilding: core.worldbuilding || '',
        synopsis: core.synopsis || '',
    }
    return fieldMap[key] || ''
}

/** 将内容写入 vela://core/ 对应的 DB 字段 */
export async function writeCoreContent(
    velaPath: string,
    content: string,
    projectSession: ProjectSessionContext,
): Promise<boolean> {
    if (velaPath === 'vela://core/characters') return false
    const dbField = parseCoreField(velaPath)
    if (!dbField) return false
    const res = await ipc.invokeWithProjectSession(
        projectSession,
        'db:project-core-update',
        { [dbField]: content },
        projectSession.projectPath,
    )
    return res.success === true
}

// ===== vela://draft/ | vela://revision/ | vela://review/ 内容读取 =====

/** 读取 vela:// 伪协议路径的内容（统一入口） */
export async function readVelaContent(
    filePath: string,
    projectSession: ProjectSessionContext,
): Promise<string> {
    if (filePath.startsWith('vela://draft/') || filePath.startsWith('vela://manuscript/')) {
        const prefix = filePath.startsWith('vela://draft/') ? 'vela://draft/' : 'vela://manuscript/'
        const draftId = parseInt(filePath.replace(prefix, ''))
        const full = await ipc.invokeWithProjectSession(
            projectSession,
            'db:draft-get-full',
            draftId,
            projectSession.projectPath,
        )
        if (!full) throw new Error('虚拟草稿不存在或无法读取')
        return full.content
    }

    if (filePath.startsWith('vela://revision/')) {
        const revId = parseInt(filePath.replace('vela://revision/', ''))
        const full = await ipc.invokeWithProjectSession(
            projectSession,
            'db:revision-get-full',
            revId,
            projectSession.projectPath,
        )
        if (!full) throw new Error('虚拟修稿不存在或无法读取')
        return full.content
    }

    if (filePath.startsWith('vela://review/')) {
        const revId = parseInt(filePath.replace('vela://review/', ''))
        const full = await ipc.invokeWithProjectSession(
            projectSession,
            'db:review-get-full',
            revId,
            projectSession.projectPath,
        )
        if (!full) throw new Error('虚拟审稿不存在或无法读取')
        return full.content
    }

    if (filePath.startsWith('vela://core/')) {
        return readCoreContent(filePath, projectSession)
    }

    console.warn('[readVelaContent] 不支持的路径协议:', filePath)
    return ''
}

/** 判断路径是否为 vela:// 伪协议 */
export function isVelaProtocol(path: string): boolean {
    return path.startsWith('vela://')
}
