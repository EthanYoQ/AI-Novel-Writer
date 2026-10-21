import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { writeCoreContent } from '../../services/resource-protocol'
import { useEditorStore } from '../../stores/editor-store'
import { isProjectSessionCurrent } from '../project-session-gate'
import { createProjectArchTabId } from './arch-file-refresh-policy'

/**
 * 清空一节故事架构文本（调用前已由作者确认），并让已打开的这一节标签同步为空且不算未保存。
 * 写入失败返回 false；写入后项目会话已切换时不动标签。
 */
export async function clearArchSection(filePath: string, projectSession: ProjectSessionContext): Promise<boolean> {
  const success = await writeCoreContent(filePath, '', projectSession)
  if (!success || !isProjectSessionCurrent(projectSession)) return success
  const store = useEditorStore.getState()
  const tabId = createProjectArchTabId(projectSession.projectPath, filePath)
  store.syncTabContent(tabId, '')
  store.markTabSaved(tabId, '')
  return true
}
