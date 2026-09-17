import { useCallback } from 'react'

import { useCharacterStore } from '../../stores/character-store'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { confirm } from '../ui/Confirm'
import {
  captureProjectSession,
  isProjectSessionCurrent,
  isProjectSessionPath,
} from '../project-session-gate'

/**
 * 「删除全部角色与关系」的唯一实现。
 *
 * 人物档案页与关系图谱页都能触发它（图谱成为独立标签页之后，两处入口都必须走
 * 同一套确认文案、项目会话校验与日志），所以抽成 hook —— 免得两份实现各自漂移。
 *
 * 语义一字未改：确认 → 冻结项目会话 → 清空 → 按结果写日志。
 */
export function useClearAllCharacters(projectKey: string): () => Promise<void> {
  const currentProject = useProjectStore((state) => state.currentProject)
  const addLog = useWorkflowStore((state) => state.addLog)
  const characters = useCharacterStore((state) => state.characters)
  const dataProjectKey = useCharacterStore((state) => state.dataProjectKey)
  const loadingProjectKey = useCharacterStore((state) => state.loadingProjectKey)
  const lastError = useCharacterStore((state) => state.lastError)
  const clearAllCharacters = useCharacterStore((state) => state.clearAllCharacters)
  const text = useLocaleStore((state) => state.text)

  return useCallback(async () => {
    const dataReady = Boolean(
      currentProject?.path === projectKey
      && dataProjectKey === projectKey
      && loadingProjectKey === null
      && lastError === null,
    )
    const projectSession = captureProjectSession(currentProject)
    if (
      !dataReady
      || characters.length === 0
      || !projectSession
      || !isProjectSessionPath(projectSession, projectKey)
    ) return

    const ok = await confirm(
      text(
        `确定删除全部 ${characters.length} 个角色及其关系吗？角色图谱是角色名单的投影，无法单独清空。此操作不可撤销。`,
        `Delete all ${characters.length} characters and their relationships? The graph is a projection of the roster and cannot be cleared independently. This cannot be undone.`,
      ),
      {
        title: text('删除全部角色与关系', 'Delete all characters and relationships'),
        confirmText: text('确认删除全部', 'Delete all'),
        danger: true,
      },
    )
    if (!ok || !isProjectSessionCurrent(projectSession)) return

    const cleared = await clearAllCharacters(projectKey, projectSession)
    if (!isProjectSessionCurrent(projectSession)) return
    addLog(
      cleared ? 'info' : 'error',
      cleared
        ? text('已删除全部角色及关系', 'Deleted all characters and relationships')
        : text('删除全部角色失败，请刷新后重试', 'Could not delete all characters. Refresh and try again.'),
    )
  }, [
    addLog,
    characters.length,
    clearAllCharacters,
    currentProject,
    dataProjectKey,
    lastError,
    loadingProjectKey,
    projectKey,
    text,
  ])
}
