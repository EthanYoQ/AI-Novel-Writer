import { createRoot } from 'react-dom/client'

import { UpdateSection } from '../../src/components/updates/UpdateSection'
import { UpdateNotifier } from '../../src/components/updates/UpdateNotifier'
import { useEditorStore } from '../../src/stores/editor-store'
import { useLocaleStore } from '../../src/stores/locale-store'
import { useWorkflowStore, type WorkflowStatus } from '../../src/stores/workflow-store'
import { useLayoutStore } from '../../src/stores/layout-store'
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
  downloadCalls: number
  openReleaseCalls: number
  deferCalls: number[]
  checkCalls: number
  officialHomepageRequests: Array<{ channel: string; args: unknown[] }>
  setActiveWorkflowStatuses(statuses: WorkflowStatus[]): void
  setLocale(locale: 'zh-CN' | 'en-US'): void
  setOfficialHomepageFailure(shouldFail: boolean): void
  setUpdateState(state: UpdateState): void
  getSidebarView(): string
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
  updateAction: 'download',
  isReminderDeferred: false,
}
const listeners = new Set<StateListener>()
let officialHomepageShouldFail = false
const harness: UpdateHarness = {
  installCalls: 0,
  downloadCalls: 0,
  openReleaseCalls: 0,
  deferCalls: [],
  checkCalls: 0,
  officialHomepageRequests: [],
  setActiveWorkflowStatuses(statuses) {
    const activeRuns = statuses.map((status, index) => ({
      id: `workflow-${index}`,
      type: 'chapter_creation' as const,
      title: `创作任务 ${index + 1}`,
      status,
      steps: [{
        id: `step-${index}`,
        name: '生成章节',
        description: '生成章节内容',
        status: status === 'completed' ? 'completed' as const : 'running' as const,
        logs: [],
      }],
      currentStepIndex: 0,
      createdAt: '2026-07-25T00:00:00.000Z',
    }))
    useWorkflowStore.setState({
      activeRuns,
      currentRun: activeRuns[0] ?? null,
    })
  },
  setLocale(locale) {
    useLocaleStore.setState({ locale, initialized: true })
  },
  setOfficialHomepageFailure(shouldFail) {
    officialHomepageShouldFail = shouldFail
  },
  setUpdateState(nextState) {
    publish(nextState)
  },
  getSidebarView() {
    return useLayoutStore.getState().sidebarView
  },
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
      case 'update:download':
        harness.downloadCalls += 1
        publish({ ...state, status: 'downloaded' })
        return { success: true, state }
      case 'update:open-release':
        harness.openReleaseCalls += 1
        return { success: true, state }
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
      case 'official-homepage:open':
        harness.officialHomepageRequests.push({ channel, args })
        return officialHomepageShouldFail
          ? { success: false, error: 'Fixture browser unavailable' }
          : { success: true }
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
createRoot(root).render(<><UpdateNotifier /><UpdateSection /></>)
