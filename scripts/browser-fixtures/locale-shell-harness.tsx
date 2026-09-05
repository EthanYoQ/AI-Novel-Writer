import { createRoot } from 'react-dom/client'

/* eslint-disable react-refresh/only-export-components -- standalone browser harness entry */

import '../../src/index.css'
import WelcomePage from '../../src/components/pages/WelcomePage'
import AIPanel from '../../src/components/panels/AIPanel'
import BottomPanel from '../../src/components/panels/BottomPanel'
import StatusBar from '../../src/components/layout/StatusBar'
import TitleBar from '../../src/components/layout/TitleBar'
import { useAgentStore } from '../../src/stores/agent-store'
import { useLayoutStore } from '../../src/stores/layout-store'
import { useLLMStore } from '../../src/stores/llm-store'
import { useLocaleStore } from '../../src/stores/locale-store'
import { useProjectStore } from '../../src/stores/project-store'
import { useWorkflowStore } from '../../src/stores/workflow-store'

const disabledUpdateState = {
  status: 'disabled',
  currentVersion: '0.9.2',
  availableVersion: null,
  updateAction: 'none',
  isReminderDeferred: false,
}

Object.assign(window, {
  velaAPI: {
    async invoke(channel: string) {
      if (channel === 'config:set') return { success: true }
      if (channel === 'update:get-state') return disabledUpdateState
      return null
    },
    on: () => () => {},
    once: () => {},
    send: () => {},
    setZoomLevel: () => {},
    setZoomFactor: () => {},
    getZoomLevel: () => 0,
  },
})

useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
useProjectStore.setState({ currentProject: null, recentProjects: [] })
useLLMStore.setState({ loaded: true, models: [], defaultModelId: null })
useAgentStore.setState({ conversations: [], activeConversationId: null, showHistory: false })
useWorkflowStore.setState({ activeRuns: [], history: [], globalLogs: [], currentRun: null })
useLayoutStore.setState({ bottomPanelOpen: true, bottomTab: 'models' })

function LocaleShellHarness() {
  const setLocale = useLocaleStore(s => s.setLocale)

  return (
    <main className="h-screen w-screen overflow-hidden bg-[var(--color-editor-bg)]">
      <button
        type="button"
        data-testid="switch-to-english"
        className="absolute left-2 top-2 z-50"
        onClick={() => void setLocale('en-US')}
      >
        Switch to English
      </button>
      <TitleBar />
      <div className="grid h-[660px] grid-cols-[1fr_320px] pt-10">
        <WelcomePage onNewProject={() => {}} onOpenProject={() => {}} />
        <AIPanel />
      </div>
      <div className="h-[200px]">
        <BottomPanel />
      </div>
      <StatusBar />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<LocaleShellHarness />)
