/**
 * architecture-service — 架构文件状态检查服务
 *
 * 全量 DB 化后，这里直接查 project_core 和 blueprints 表，不再读取文件。
 * 使用场景：Sidebar、流程脊
 */

import type { ProjectSessionContext } from '../shared/ipc-channels'
import { CANONICAL_PROJECT_DIRECTORY } from '../shared/project-format'
import { outlineProgress } from '../shared/plot-outline-checkpoint'
import { ipc } from './ipc-client'
import { judgeArchCore } from './architecture-step-selection'

/**
 * 检查所有架构块的生成状态
 * @returns key → boolean 映射，true 表示该块已有有效内容
 */
export async function checkArchStatus(
  projectSession: ProjectSessionContext,
): Promise<Record<string, boolean>> {
  const status: Record<string, boolean> = {
    premise: false,
    characters: false,
    worldbuilding: false,
    synopsis: false,
  }

  const [core, roster] = await Promise.all([
    ipc.invokeWithProjectSession(
      projectSession,
      'db:project-core-get',
      projectSession.projectPath,
    ),
    ipc.invokeWithProjectSession(
      projectSession,
      'db:character-roster-read',
      projectSession.projectPath,
    ),
  ])
  if (!core) return status

  // 长度 > 50 才算真正已生成，前端可以直接用长度判断
  status.premise = (core.premise?.length ?? 0) > 50
  status.characters = roster.status === 'ready'
  status.worldbuilding = (core.worldbuilding?.length ?? 0) > 50
  status.synopsis = (core.synopsis?.length ?? 0) > 50

  return status
}

/**
 * 流程脊的架构四节是否已确认：与架构页徽标同一判定（judgeArchCore），角色名单要结构化名单就绪。
 */
export async function checkArchConfirmed(
  projectSession: ProjectSessionContext,
): Promise<Record<string, boolean>> {
  const { projectPath } = projectSession
  const [core, roster, partial] = await Promise.all([
    ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', projectPath),
    ipc.invokeWithProjectSession(projectSession, 'db:character-roster-read', projectPath),
    ipc.invokeWithProjectSession(projectSession, 'fs:read-json', `${projectPath}/${CANONICAL_PROJECT_DIRECTORY}/partial_arch.json`, projectPath)
      .catch(() => null),
  ])
  if (!core) return { premise: false, characters: false, worldbuilding: false, synopsis: false }
  const checkpoint = partial?.success === true ? (partial as { data?: unknown }).data : undefined
  const progress = outlineProgress(core.synopsis ?? '', checkpoint, core.writingLanguage === 'en-US' ? 'en-US' : 'zh-CN', Number(core.totalChapters) || 0)
  return { ...judgeArchCore(core, progress.kind).confirmed, characters: roster.status === 'ready' }
}

/**
 * 获取蓝图数量
 */
export async function getBlueprintCount(projectSession: ProjectSessionContext): Promise<number> {
  try {
    const blueprints = await ipc.invokeWithProjectSession(
      projectSession,
      'db:blueprint-get-all',
      projectSession.projectPath,
    )
    return blueprints.length
  } catch {
    return 0
  }
}
