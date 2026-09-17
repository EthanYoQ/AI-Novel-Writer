/**
 * 退出守卫的 Hook 与类型 —— 从 exit-guard.tsx 拆出来的非组件模块。
 *
 * 为什么要拆：react-refresh 只有在一个文件「只导出组件」时才能做组件级热替换。
 * exit-guard.tsx 原本既导出 useExitGuard（普通函数）又导出 ExitGuardDialog
 * （组件），于是整个退出对话框只能退回整页刷新。hook 属于产品行为，与皮肤无关，
 * 两套顶栏共用；拆开后 exit-guard.tsx 只剩组件。
 */
import { useEffect, useMemo, useState } from 'react'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { saveDirtyEditorChangesForExit, useEditorStore } from '../../stores/editor-store'
import { countUnsavedEditorItems, listUnsavedEditorItems, type UnsavedEditorItem } from '../../stores/editor-unsaved'
import { discardAllEditorChanges } from '../../stores/editor-discard'
import { ipc } from '../../services/ipc-client'
import { useLocaleStore } from '../../stores/locale-store'
import { sameProjectPathKey } from '../../shared/project-session-context'
import { alertError } from '../ui/AlertDialog'
import { UNSAVED_EDITOR_TARGETS, projectDisplayName } from './unsaved-editor-targets'

export interface ExitRequest {
  requestId: string
  workflowBlocked?: boolean
}

export interface ExitGuard {
  exitRequest: ExitRequest | null
  exitBusy: boolean
  exitError: string | null
  /** 未保存内容明细（按条，供退出确认告诉用户「哪部作品、哪个地方」）。 */
  unsavedItems: UnsavedEditorItem[]
  cancelExit: () => Promise<void>
  discardAndExit: () => Promise<void>
  saveAndExit: () => Promise<void>
  /** 撤销退出并跳到这条未保存内容的所在地，交给用户自己确认。 */
  revealUnsavedItem: (item: UnsavedEditorItem) => Promise<void>
}

/**
 * 激活（必要时重新打开）某条未保存内容所在的编辑器。
 *
 * 优先激活已存在的 Tab —— 未保存内容就在那个 Tab / 那份后台账本里，
 * 绝不能用新 Tab 顶掉它。只有内容属于后台草稿账本（人物档案 / 小说配置 /
 * 章节蓝图这类「页面关了、草稿还在」的编辑器）时才按类型重新打开。
 */
function activateUnsavedEditor(item: UnsavedEditorItem): boolean {
  const store = useEditorStore.getState()
  if (item.tabId) {
    const exact = store.tabs.find(tab => tab.id === item.tabId)
    if (exact) {
      store.setActiveTab(exact.id)
      return true
    }
  }
  if (!item.type) return false
  const sameEditor = store.tabs.find(tab => (
    tab.type === item.type
    && Boolean(tab.projectKey && item.projectKey && sameProjectPathKey(tab.projectKey, item.projectKey))
  ))
  if (sameEditor) {
    store.setActiveTab(sameEditor.id)
    return true
  }
  const target = UNSAVED_EDITOR_TARGETS[item.type]
  if (!target || !item.projectKey) return false
  const text = useLocaleStore.getState().text
  store.openFile({
    id: target.tabId,
    name: text(target.label.zh, target.label.en),
    type: item.type,
    projectKey: item.projectKey,
  })
  return true
}

/**
 * 退出守卫：关窗前的未保存内容与运行中任务处理。
 *
 * v1 与 v2 两套顶栏共用这一份实现 —— 退出语义属于产品行为，不属于皮肤。
 * 注意它注册的是全局 window:close-requested 监听，因此同一时刻只应有一个
 * 顶栏挂载（由 ui-version 开关保证）。
 */
export function useExitGuard(): ExitGuard {
  const [exitRequest, setExitRequest] = useState<ExitRequest | null>(null)
  const [exitBusy, setExitBusy] = useState(false)
  const [exitError, setExitError] = useState<string | null>(null)

  /**
   * 未保存明细。只在退出确认真正打开时才算，平时不订阅开销。
   * 依赖 tabs / draftLedgers：保存期间还可能有新输入，清单要跟着变。
   */
  const tabs = useEditorStore(state => state.tabs)
  const draftLedgers = useEditorStore(state => state.draftLedgers)
  const unsavedItems = useMemo(
    () => (exitRequest && !exitRequest.workflowBlocked
      ? listUnsavedEditorItems(tabs, draftLedgers)
      : []),
    [exitRequest, tabs, draftLedgers],
  )

  useEffect(() => ipc.on('window:close-requested', ({ requestId }) => {
    const projectPath = useProjectStore.getState().currentProject?.path
    const hasActiveWorkflow = !!projectPath && useWorkflowStore.getState().activeRuns.some(
      run => sameProjectPathKey(run.projectPath, projectPath),
    )
    if (hasActiveWorkflow) {
      setExitError(null)
      setExitRequest({ requestId, workflowBlocked: true })
      return
    }
    const editor = useEditorStore.getState()
    if (countUnsavedEditorItems(editor.tabs, editor.draftLedgers) === 0) {
      void ipc.invoke('window:resolve-close', requestId, 'proceed').then(result => {
        if (!result.success) console.error('[ExitGuard] 退出请求已失效')
      }).catch(error => console.error('[ExitGuard] 退出请求失败:', error))
      return
    }
    setExitError(null)
    setExitRequest({ requestId })
  }), [])

  const cancelExit = async () => {
    const request = exitRequest
    if (!request || exitBusy) return
    setExitBusy(true)
    try {
      const text = useLocaleStore.getState().text
      const result = await ipc.invoke('window:resolve-close', request.requestId, 'cancel')
      if (!result.success) throw new Error(text('退出请求已失效，请重试', 'The exit request expired. Try again.'))
      setExitRequest(null)
      setExitError(null)
    } catch (error) {
      setExitError(error instanceof Error ? error.message : String(error))
    } finally {
      setExitBusy(false)
    }
  }

  const discardAndExit = async () => {
    const request = exitRequest
    if (!request || request.workflowBlocked || exitBusy) return
    setExitBusy(true)
    setExitError(null)
    try {
      const text = useLocaleStore.getState().text
      const result = await ipc.invoke('window:resolve-close', request.requestId, 'cancel')
      if (!result.success) throw new Error(text('退出请求已失效，请重试', 'The exit request expired. Try again.'))
      discardAllEditorChanges()
      setExitRequest(null)
      const closeResult = await ipc.invoke('window:close')
      if (!closeResult.success) {
        await alertError(
          text('未保存修改已放弃，但无法再次发起退出。请手动重试退出。', 'Unsaved changes were discarded, but exit could not be requested again. Try exiting again.'),
          { title: text('退出失败', 'Could not exit') },
        )
      }
    } catch (error) {
      setExitError(error instanceof Error ? error.message : String(error))
    } finally {
      setExitBusy(false)
    }
  }

  const saveAndExit = async () => {
    const request = exitRequest
    if (!request || request.workflowBlocked || exitBusy) return
    setExitBusy(true)
    setExitError(null)
    try {
      const text = useLocaleStore.getState().text
      await saveDirtyEditorChangesForExit(useProjectStore.getState().currentProject?.path)
      const result = await ipc.invoke('window:resolve-close', request.requestId, 'proceed')
      if (!result.success) throw new Error(text('退出请求已失效，请重试', 'The exit request expired. Try again.'))
    } catch (error) {
      setExitError(error instanceof Error ? error.message : String(error))
    } finally {
      setExitBusy(false)
    }
  }

  /**
   * 跳到某条未保存内容的所在地。
   *
   * 语义：**去看一眼 ≠ 要退出** —— 先撤销这次关窗请求（窗口随之留下），
   * 再切回那部作品、打开那个编辑器，把未保存内容原样交到用户眼前。
   * 这样退出确认不必替用户猜：「另一个项目还有未保存内容」也能一步跳过去。
   */
  const revealUnsavedItem = async (item: UnsavedEditorItem) => {
    const request = exitRequest
    if (!request || exitBusy) return
    const text = useLocaleStore.getState().text
    setExitBusy(true)
    setExitError(null)

    // ① 撤销退出请求：失败就留在原弹窗里说明原因。
    try {
      const result = await ipc.invoke('window:resolve-close', request.requestId, 'cancel')
      if (!result.success) throw new Error(text('退出请求已失效，请重试', 'The exit request expired. Try again.'))
    } catch (error) {
      setExitError(error instanceof Error ? error.message : String(error))
      setExitBusy(false)
      return
    }
    setExitRequest(null)

    // ② 弹窗已关，后续失败只能弹告警，不能写回弹窗里的红字。
    try {
      const targetPath = item.projectKey
      const currentPath = useProjectStore.getState().currentProject?.path
      const alreadyThere = Boolean(
        targetPath && currentPath && sameProjectPathKey(targetPath, currentPath),
      )
      if (targetPath && !alreadyThere) {
        const opened = await useProjectStore.getState().openProject(targetPath)
        if (!opened) {
          const name = projectDisplayName(targetPath, useProjectStore.getState().recentProjects)
          throw new Error(text(
            `未能切回《${name}》，请从书架手动打开后再保存。`,
            `Could not switch back to "${name}". Open it from the shelf and save there.`,
          ))
        }
      }
      if (!activateUnsavedEditor(item)) {
        const name = item.projectKey
          ? projectDisplayName(item.projectKey, useProjectStore.getState().recentProjects)
          : ''
        throw new Error(text(
          `已切回《${name}》，但那条未保存内容所在的页面打不开，请在标签栏中手动打开对应编辑器。`,
          `Switched back to "${name}", but that page could not be opened. Open the editor from the tab bar.`,
        ))
      }
    } catch (error) {
      await alertError(
        error instanceof Error ? error.message : String(error),
        { title: text('无法前往未保存处', 'Could not jump to the unsaved edit') },
      )
    } finally {
      setExitBusy(false)
    }
  }

  return {
    exitRequest,
    exitBusy,
    exitError,
    unsavedItems,
    cancelExit,
    discardAndExit,
    saveAndExit,
    revealUnsavedItem,
  }
}
