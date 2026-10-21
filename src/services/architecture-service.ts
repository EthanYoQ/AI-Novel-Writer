/**
 * architecture-service — 架构文件状态检查服务
 *
 * 全量 DB 化后，这里直接查 project_core 和 blueprints 表，不再读取文件。
 * 使用场景：Sidebar、流程脊
 */

import type { NovelConfig, ProjectSessionContext } from '../shared/ipc-channels'
import { CANONICAL_PROJECT_DIRECTORY } from '../shared/project-format'
import { outlineProgress } from '../shared/plot-outline-checkpoint'
import type { PlotOutlineRangeSource } from '../shared/plot-outline-contract'
import { resolveWritingLanguage } from '../shared/writing-language'
import { ipc } from './ipc-client'
import { judgeArchCore } from './architecture-step-selection'

/** 读架构生成的分批检查点 partial_arch.json；没有、读不到或读失败都按没有检查点（undefined）。 */
export async function readArchCheckpoint(projectSession: ProjectSessionContext): Promise<Record<string, unknown> | undefined> {
  const { projectPath } = projectSession
  const result = await ipc.invokeWithProjectSession(projectSession, 'fs:read-json', `${projectPath}/${CANONICAL_PROJECT_DIRECTORY}/partial_arch.json`, projectPath)
    .catch(() => null)
  return result?.success === true ? (result as { data?: Record<string, unknown> }).data : undefined
}

/** 作品核心里情节大纲的范围来源：章数与写作语言以作品核心为准，作品核心读不到时用作品设置。 */
export function archOutlineSource(
  core: { synopsis?: string | null; totalChapters?: number | null; writingLanguage?: string | null } | null | undefined,
  novelConfig?: Pick<NovelConfig, 'totalChapters' | 'writingLanguage'>,
): PlotOutlineRangeSource {
  return {
    synopsis: core?.synopsis ?? '',
    totalChapters: Number(core?.totalChapters ?? novelConfig?.totalChapters) || 0,
    writingLanguage: resolveWritingLanguage(core?.writingLanguage ?? novelConfig?.writingLanguage),
  }
}

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
  novelConfig?: Pick<NovelConfig, 'totalChapters' | 'writingLanguage'>,
): Promise<Record<string, boolean>> {
  const { projectPath } = projectSession
  const [core, roster, checkpoint] = await Promise.all([
    ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', projectPath),
    ipc.invokeWithProjectSession(projectSession, 'db:character-roster-read', projectPath),
    readArchCheckpoint(projectSession),
  ])
  if (!core) return { premise: false, characters: false, worldbuilding: false, synopsis: false }
  const { synopsis, totalChapters, writingLanguage } = archOutlineSource(core, novelConfig)
  const progress = outlineProgress(synopsis, checkpoint, writingLanguage, totalChapters)
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
