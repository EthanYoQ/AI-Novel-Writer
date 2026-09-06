import { useEffect, useRef } from 'react'

import { useLayoutStore } from '../../stores/layout-store'
import { useLocaleStore } from '../../stores/locale-store'
import { actionToast } from '../ui/ActionToast'
import { useUpdateState } from './use-update-state'

const notifiedVersions = new Set<string>()

/** Shows one persistent, app-wide notice for each release discovered in this renderer session. */
export function UpdateNotifier() {
  const text = useLocaleStore(s => s.text)
  const { state } = useUpdateState()
  const activeNotice = useRef<{ version: string; dismiss: () => void } | null>(null)

  useEffect(() => {
    const version = state.availableVersion
    if (!version || state.isReminderDeferred) {
      if (activeNotice.current && (!version || activeNotice.current.version === version)) {
        activeNotice.current.dismiss()
        activeNotice.current = null
      }
      if (version) notifiedVersions.delete(version)
      return
    }
    if (activeNotice.current && activeNotice.current.version !== version) {
      activeNotice.current.dismiss()
      activeNotice.current = null
    }
    if (activeNotice.current?.version === version) {
      activeNotice.current.dismiss()
      activeNotice.current = null
      notifiedVersions.delete(version)
    }
    if (notifiedVersions.has(version)) return
    notifiedVersions.add(version)
    const dismiss = actionToast.show({
      type: 'info',
      message: text(`发现新版本 v${version}`, `New version v${version} is available`),
      duration: 0,
      actions: [{
        label: text('查看更新', 'View update'),
        onClick: () => {
          const layout = useLayoutStore.getState()
          if (layout.sidebarView !== 'home' || !layout.sidebarOpen) layout.setSidebarView('home')
        },
      }],
    })
    activeNotice.current = { version, dismiss }
  }, [state.availableVersion, state.isReminderDeferred, text])

  return null
}
