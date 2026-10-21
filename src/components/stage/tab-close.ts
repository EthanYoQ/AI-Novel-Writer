import { discardAndCloseEditorTab } from '../../stores/editor-discard'
import { useEditorStore } from '../../stores/editor-store'
import { useStageStore } from '../../stores/navigation/stage-store'
import { useProjectStore } from '../../stores/project-store'
import { captureProjectSession, isProjectSessionCurrent } from '../project-session-gate'

export const STAGE_CONTENT_ID = 'stage-content'

/**
 * 被关掉的标签带走了焦点（标签条可能随之收起），下一帧把焦点交给内容区，键盘不会落到页面之外。
 * 这一帧里焦点已经落到页面里别处（例如又打开了标签菜单）就不抢。
 */
function focusContent(): void {
  requestAnimationFrame(() => {
    const active = document.activeElement
    if (active && active !== document.body && active.isConnected) return
    document.getElementById(STAGE_CONTENT_ID)?.focus({ preventScroll: true })
  })
}

/** 关闭标签：没有未保存修改就直接关；有修改时先请作者确认放弃。标签条与 ⌘W / Ctrl W 都走这里。 */
export function requestCloseTab(tabId: string): void {
  const tab = useEditorStore.getState().tabs.find(candidate => candidate.id === tabId)
  if (!tab || tab.pinned) return
  if (tab.dirty) {
    useStageStore.setState({ closingTabId: tabId })
    return
  }
  useEditorStore.getState().closeTab(tabId)
  focusContent()
}

export function confirmCloseTab(): void {
  const { closingTabId } = useStageStore.getState()
  const session = captureProjectSession(useProjectStore.getState().currentProject)
  if (closingTabId && session && isProjectSessionCurrent(session)) discardAndCloseEditorTab(closingTabId, session)
  useStageStore.setState({ closingTabId: null })
  focusContent()
}

export function cancelCloseTab(): void {
  useStageStore.setState({ closingTabId: null })
}

/**
 * 一次关几个标签（标签菜单的关闭其他、右侧、全部）：没有未保存修改的直接关，
 * 返回有未保存修改、要作者确认后才能放弃的那些。
 */
export function closeCleanTabs(tabIds: readonly string[]): string[] {
  const editor = useEditorStore.getState()
  const dirty: string[] = []
  for (const tabId of tabIds) {
    const tab = editor.tabs.find(candidate => candidate.id === tabId)
    if (!tab || tab.pinned) continue
    if (tab.dirty) dirty.push(tabId)
    else useEditorStore.getState().closeTab(tabId)
  }
  if (dirty.length < tabIds.length) focusContent()
  return dirty
}

/** 作者确认放弃后，丢掉这些标签的未保存修改并关掉；作品已换就什么也不做。 */
export function discardAndCloseTabs(tabIds: readonly string[]): void {
  const session = captureProjectSession(useProjectStore.getState().currentProject)
  if (!session || !isProjectSessionCurrent(session)) return
  for (const tabId of tabIds) discardAndCloseEditorTab(tabId, session)
  focusContent()
}
