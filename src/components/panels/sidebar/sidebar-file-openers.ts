import type {
  DatabaseChannels,
  ProjectData,
  ProjectSessionContext,
} from '../../../shared/ipc-channels'
import type { DraftStatus } from '../../../shared/draft-status'
import { ipc } from '../../../services/ipc-client'
import { useEditorStore } from '../../../stores/editor-store'
import { useProjectStore } from '../../../stores/project-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { toast } from '../../ui/Toast'
import {
  captureProjectSession,
  isProjectSessionCurrent,
} from '../../project-session-gate'
import {
  createProjectArchTabId,
  shouldSyncProjectArchTab,
} from '../../editor/arch-file-refresh-policy'

type SessionProject = Pick<ProjectData, 'id' | 'path' | 'sessionLease'>

/**
 * Freeze the complete project identity before awaiting a destructive confirmation.
 * A confirmation for the same folder is not transferable to a reopened lease.
 */
export async function confirmCurrentProjectSession(
  project: SessionProject | null | undefined,
  requestConfirmation: () => Promise<boolean>,
): Promise<ProjectSessionContext | null> {
  const projectSession = captureProjectSession(project)
  if (!projectSession) return null

  const confirmed = await requestConfirmation()
  return confirmed && isProjectSessionCurrent(projectSession)
    ? projectSession
    : null
}

function reportFileReadFailure(error: string | undefined): void {
  const text = useLocaleStore.getState().text
  toast.error(text(
    `无法读取文件：${error ?? '未知错误'}`,
    `Could not read file: ${error ?? 'Unknown error'}`,
  ))
}

/** 打开架构文件（带 AI 生成工具栏；若 tab 已存在则刷新内容） */
export async function openArchFile(filePath: string, name: string): Promise<void> {
  const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
  if (!projectSession) return
  const projectKey = projectSession.projectPath
  const tabId = createProjectArchTabId(projectKey, filePath)
  let content = ''
  // 支持 vela://core/ 伪协议路径，从 DB 读取架构字段
  if (filePath.startsWith('vela://core/')) {
    const { readCoreContent } = await import('../../../services/vela-protocol')
    try {
      content = await readCoreContent(filePath, projectSession)
    } catch (error) {
      if (isProjectSessionCurrent(projectSession)) reportFileReadFailure(String(error))
      return
    }
  } else {
    const result = await ipc.invokeWithProjectSession(
      projectSession,
      'fs:read-file',
      filePath,
      projectKey,
    )
    if (!result.success) {
      if (isProjectSessionCurrent(projectSession)) reportFileReadFailure(result.error)
      return
    }
    content = result.content
  }
  // 读取期间可能切换项目；旧项目结果不能进入新项目的 Tab。
  if (!isProjectSessionCurrent(projectSession)) return
  const store = useEditorStore.getState()
  const existingTab = store.tabs.find(tab => tab.id === tabId)
  if (existingTab) {
    store.setActiveTab(tabId)
    // 同项目的未保存草稿保持原样；干净 Tab 才接受远端刷新。
    if (shouldSyncProjectArchTab(existingTab, projectKey)) {
      store.syncTabContent(tabId, content)
      store.markTabSaved(tabId, content)
    }
  } else {
    store.openFile({
      id: tabId,
      name,
      type: 'arch-file',
      filePath,
      content,
      savedContent: content,
      projectKey,
    })
  }
}

/** 打开内置编辑器 */
export function openBuiltinEditor(id: string, name: string, type: 'chapter-card' | 'character' | 'world-building' | 'narrative-thread'): void {
  const projectKey = useProjectStore.getState().currentProject?.path
  useEditorStore.getState().openFile({
    id,
    name,
    type,
    ...(projectKey ? { projectKey } : {}),
  })
}

/** 打开章节文件 */
export async function openChapterFile(filePath: string, name: string): Promise<void> {
  const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
  if (!projectSession) return
  const projectKey = projectSession.projectPath
  let content = ''
  let draftMeta: DatabaseChannels['db:draft-get-meta']['return'] = null
  try {
    if (filePath.startsWith('vela://')) {
      const { readVelaContent } = await import('../../../services/vela-protocol')
      content = await readVelaContent(filePath, projectSession)
      if (!isProjectSessionCurrent(projectSession)) return
      const draftIdMatch = filePath.match(/^vela:\/\/(?:draft|manuscript)\/(\d+)$/)
      if (draftIdMatch) {
        draftMeta = await ipc.invokeWithProjectSession(
          projectSession,
          'db:draft-get-meta',
          Number(draftIdMatch[1]),
          projectKey,
        )
      }
    } else {
      const result = await ipc.invokeWithProjectSession(
        projectSession,
        'fs:read-file',
        filePath,
        projectKey,
      )
      if (!result.success) {
        if (isProjectSessionCurrent(projectSession)) reportFileReadFailure(result.error)
        return
      }
      content = result.content
    }
  } catch (error) {
    if (isProjectSessionCurrent(projectSession)) reportFileReadFailure(String(error))
    return
  }
  if (!isProjectSessionCurrent(projectSession)) return
  useEditorStore.getState().openFile({
    id: filePath,
    name,
    type: 'chapter',
    filePath,
    content,
    savedContent: content,
    ...(draftMeta
      ? {
          draftId: draftMeta.id,
          chapterNumber: draftMeta.chapterNumber,
          draftStatus: draftMeta.status as DraftStatus,
        }
      : {}),
    projectKey,
  })
}
