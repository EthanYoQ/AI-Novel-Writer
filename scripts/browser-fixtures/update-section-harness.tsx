import { createRoot } from 'react-dom/client'

import { UpdateSection } from '../../src/components/updates/UpdateSection'
import { useEditorStore } from '../../src/stores/editor-store'
import { useLocaleStore } from '../../src/stores/locale-store'
import type { UpdateState } from '../../src/services/update-presentation'

type StateListener = (state: UpdateState) => void

interface HarnessApi {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  on: (channel: string, callback: StateListener) => () => void
  once: () => void
  send: () => void
  setZoomLevel: () => void
  setZoomFactor: () => void
  getZoomLevel: () => number
}

interface UpdateHarness {
  installCalls: number
  deferCalls: number[]
  checkCalls: number
}

declare global {
  interface Window {
    __updateHarness: UpdateHarness
  }
}

let state: UpdateState = {
  status: 'downloaded',
  currentVersion: '0.2.5',
  availableVersion: '0.2.6',
  isReminderDeferred: false,
}
const listeners = new Set<StateListener>()
const harness: UpdateHarness = {
  installCalls: 0,
  deferCalls: [],
  checkCalls: 0,
}

function publish(nextState: UpdateState): void {
  state = nextState
  for (const listener of listeners) listener(state)
}

const api: HarnessApi = {
  async invoke(channel: string, ...args: unknown[]) {
    switch (channel) {
      case 'update:get-state':
        return state
      case 'update:check':
        harness.checkCalls += 1
        publish(state)
        return { success: true, checked: true, updateAvailable: true, state }
      case 'update:defer-reminder': {
        const days = args[0]
        if (days === 7 || days === 30) harness.deferCalls.push(days)
        publish({
          ...state,
          isReminderDeferred: true,
          reminderUntil: '2026-08-01T00:00:00.000Z',
        })
        return { success: true, state }
      }
      case 'update:quit-and-install':
        harness.installCalls += 1
        return { success: true, state }
      default:
        return { success: true, state }
    }
  },
  on(channel: string, callback: StateListener) {
    if (channel !== 'update:state') return () => {}
    listeners.add(callback)
    return () => listeners.delete(callback)
  },
  once: () => {},
  send: () => {},
  setZoomLevel: () => {},
  setZoomFactor: () => {},
  getZoomLevel: () => 0,
}

;(window as unknown as { velaAPI: HarnessApi }).velaAPI = api
window.__updateHarness = harness
useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
useEditorStore.setState({
  tabs: [{ id: 'dirty-chapter', name: '未保存章节', type: 'chapter', dirty: true }],
  activeTabId: 'dirty-chapter',
})

const root = document.getElementById('root')
if (!root) throw new Error('Missing test root')
createRoot(root).render(<UpdateSection />)
