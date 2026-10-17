import { useEffect } from 'react'
import { editorSaveHandler, useEditorStore } from '../../stores/editor-store'
import { useLayoutStore } from '../../stores/layout-store'
import { leaveSettings } from '../settings/unsaved-settings'
import { useStageStore } from '../../stores/navigation/stage-store'
import { IS_MAC, isCommand, isComposing, isModalOpen } from './shortcut-keys'
import { requestCloseTab } from './tab-close'

function saveActiveTab(): void {
  const { tabs, activeTabId } = useEditorStore.getState()
  const tab = tabs.find(candidate => candidate.id === activeTabId)
  if (!tab?.dirty) return
  void editorSaveHandler(tab)?.().catch(() => undefined)
}

/**
 * 外壳的全局快捷键（macOS 用 ⌘，其余平台用 Ctrl）：K 搜索与跳转，P 查找章节，W 关闭当前标签（设置页开着时关设置页），S 保存当前页；Esc 退出沉浸写作（设置页开着时先关设置页）。
 * W 一律拦下（包括输入法组字时）：应用菜单的「关闭」绑了 CommandOrControl+W，页面不拦就会关窗。
 * Esc 与 S 在冒泡阶段处理并尊重 defaultPrevented：编辑器的搜索框、补全与 Radix 对话框先用掉 Esc，CodeMirror 自己保存时 S 已被拦下。
 */
export function useStageShortcuts({ library, focus, mac = IS_MAC }: { library: boolean; focus: boolean; mac?: boolean }): void {
  useEffect(() => {
    const onCommand = (event: KeyboardEvent) => {
      const close = isCommand(event, 'w', mac)
      if (close) event.preventDefault()
      if (isComposing(event)) return
      const commands = isCommand(event, 'k', mac)
      const chapters = isCommand(event, 'p', mac)
      if (!close && !commands && !chapters) return
      if (useStageStore.getState().palette) {
        if (commands) {
          event.preventDefault()
          useStageStore.setState({ palette: null })
        }
        return
      }
      if (isModalOpen()) return
      if (close && useLayoutStore.getState().settingsOpen) {
        leaveSettings(() => useLayoutStore.getState().closeSettings())
        return
      }
      if (commands) {
        event.preventDefault()
        useStageStore.setState({ palette: 'commands' })
      } else if (chapters && !library) {
        event.preventDefault()
        useStageStore.setState({ palette: 'chapters' })
      } else if (close && !library) {
        const { activeTabId } = useEditorStore.getState()
        if (activeTabId) requestCloseTab(activeTabId)
      }
    }
    const onUnhandled = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isComposing(event)) return
      if (event.key === 'Escape') {
        // 设置页盖在沉浸写作上面时 Esc 归设置页（它的监听注册在后，跳过已处理的事件），这里不拦。
        if (!focus || useStageStore.getState().palette || isModalOpen() || useLayoutStore.getState().settingsOpen) return
        event.preventDefault()
        useStageStore.setState({ focus: false })
      } else if (!library && isCommand(event, 's', mac) && !isModalOpen()) {
        event.preventDefault()
        // 设置页盖在标签上面，作者看不到当前标签，Ctrl S 不替它保存。
        if (!useLayoutStore.getState().settingsOpen) saveActiveTab()
      }
    }
    window.addEventListener('keydown', onCommand, true)
    window.addEventListener('keydown', onUnhandled)
    return () => {
      window.removeEventListener('keydown', onCommand, true)
      window.removeEventListener('keydown', onUnhandled)
    }
  }, [library, focus, mac])
}
