import type { ToolArtifact } from '../../../services/agent/tool-registry'
import { appErrorMessage } from '../../../i18n/app-errors'
import { ipc } from '../../../services/ipc-client'
import { useEditorStore } from '../../../stores/editor-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import {
  sameProjectPathKey,
  sameProjectSessionContext,
} from '../../../shared/project-session-context'
import { alertError } from '../../ui/AlertDialog'
import {
  captureProjectSession,
  isProjectSessionCurrent,
} from '../../project-session-gate'

function artifactText(zhCNText: string, enUSText: string): string {
  return useLocaleStore.getState().text(zhCNText, enUSText)
}

function artifactError(
  error: unknown,
  fallbackZhCN = '文件读取失败。',
  fallbackEnUS = 'Could not read the file.',
): string {
  if (error === undefined || error === null || error === '') {
    return artifactText(fallbackZhCN, fallbackEnUS)
  }
  return appErrorMessage(useLocaleStore.getState().locale, error)
}

function reportProjectChangedWhileReadingArtifact(): void {
  alertError(
    artifactText(
      '读取期间项目已切换，已丢弃旧项目的文件结果。',
      'The project changed while reading this file, so the stale result was discarded.',
    ),
    { title: artifactText('项目已切换', 'Project changed') },
  )
}

export async function openArtifactInEditor(artifact: ToolArtifact): Promise<boolean> {
  const { type, name, path, projectPath, projectSession } = artifact
  if (
    !path
    || (type !== 'file_created' && type !== 'file_modified' && type !== 'tab_opened')
  ) {
    return false
  }

  if (!projectPath || !projectSession) {
    alertError(
      artifactText(
        '该产物缺少来源项目信息，无法安全打开。',
        'The artifact is missing source project information and cannot be opened safely.',
      ),
      { title: artifactText('无法打开产物', 'Cannot open artifact') },
    )
    return false
  }
  const activeProjectSession = captureProjectSession(useProjectStore.getState().currentProject)
  if (
    !activeProjectSession
    || !sameProjectPathKey(projectPath, projectSession.projectPath)
    || !sameProjectSessionContext(projectSession, activeProjectSession)
  ) {
    alertError(
      artifactText(
        '该产物属于另一个项目。请先切换回来源项目后再打开。',
        'This artifact belongs to another project. Switch back to its source project before opening it.',
      ),
      { title: artifactText('项目已切换', 'Project changed') },
    )
    return false
  }

  // 只信任工具执行时冻结在产物上的项目身份，绝不借用点击时的当前项目。
  let content: string
  try {
    const result = await ipc.invokeWithProjectSession(
      projectSession,
      'fs:read-file',
      path,
      projectSession.projectPath,
    )
    if (!isProjectSessionCurrent(projectSession)) {
      reportProjectChangedWhileReadingArtifact()
      return false
    }
    if (!result.success) {
      alertError(
        artifactError(result.error),
        { title: artifactText('无法打开产物', 'Cannot open artifact') },
      )
      return false
    }
    content = result.content
  } catch (error) {
    if (!isProjectSessionCurrent(projectSession)) {
      reportProjectChangedWhileReadingArtifact()
      return false
    }
    alertError(
      artifactError(error),
      { title: artifactText('无法打开产物', 'Cannot open artifact') },
    )
    return false
  }

  if (!isProjectSessionCurrent(projectSession)) {
    reportProjectChangedWhileReadingArtifact()
    return false
  }
  useEditorStore.getState().openFile({
    id: `artifact-file:${path}`,
    name,
    type: 'chapter',
    filePath: path,
    content,
    savedContent: content,
    projectKey: projectSession.projectPath,
  })
  return true
}
