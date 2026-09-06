import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useLayoutStore } from '../../../stores/layout-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import BottomPanel from '../BottomPanel'

const originalLayoutState = useLayoutStore.getState()
const originalLocaleState = useLocaleStore.getState()
const originalWorkflowState = useWorkflowStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement

beforeEach(async () => {
  useLayoutStore.setState({ ...originalLayoutState, bottomPanelOpen: true, bottomTab: 'log' })
  useLocaleStore.setState({ ...originalLocaleState, locale: 'en-US', initialized: true })
  useWorkflowStore.setState({ ...originalWorkflowState, globalLogs: [] })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<BottomPanel />))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useLayoutStore.setState(originalLayoutState)
  useLocaleStore.setState(originalLocaleState)
  useWorkflowStore.setState(originalWorkflowState)
})

describe('workflow logs', () => {
  it('shows the running application version in the log view', () => {
    expect(container.textContent).toContain(`AI Novel Writer v${__APP_VERSION__}`)
  })

  it('shows a readable candidate preview and explicit confirmation actions', async () => {
    const confirmContinue = vi.fn()
    const cancelWorkflow = vi.fn()
    await act(async () => {
      useLayoutStore.setState({ bottomTab: 'tasks' })
      useWorkflowStore.setState({
        activeRuns: [{
          id: 'planning-candidates',
          projectPath: 'C:/novels/planning',
          projectSession: null,
          writingLanguage: 'en-US',
          uiLocale: 'en-US',
          type: 'post_process',
          title: 'Extract character cards from planning material',
          status: 'waiting',
          currentStepIndex: 0,
          createdAt: new Date(0).toISOString(),
          steps: [
            {
              id: 'extract',
              name: 'Generate character-card candidates',
              description: 'Generate candidates without saving them',
              status: 'completed',
              progress: 100,
              result: '## Character-card candidates awaiting confirmation\n\n### Zhou Lan\n- Age: 45\n- Background: Guarded the archive for 20 years',
              logs: [],
            },
            {
              id: 'commit',
              name: 'Confirm and import character cards',
              description: 'Atomically merge confirmed candidates',
              status: 'pending',
              logs: [],
            },
          ],
        }],
        history: [],
        waitingRuns: {
          'planning-candidates': { waitingForConfirm: true, waitingAfterStepIndex: 0 },
        },
        confirmContinue,
        cancelWorkflow,
      })
    })

    const preview = container.querySelector('[data-testid="workflow-confirmation-preview"]')
    expect(preview?.textContent).toContain('Zhou Lan')
    expect(preview?.textContent).toContain('Guarded the archive for 20 years')

    const cancel = container.querySelector<HTMLButtonElement>('[data-testid="workflow-confirmation-cancel"]')
    const confirm = container.querySelector<HTMLButtonElement>('[data-testid="workflow-confirmation-confirm"]')
    expect(cancel?.textContent).toContain('Cancel workflow')
    expect(confirm?.textContent).toContain('Confirm and import')

    await act(async () => confirm?.click())
    expect(confirmContinue).toHaveBeenCalledWith('planning-candidates')
    expect(cancelWorkflow).not.toHaveBeenCalled()

    await act(async () => cancel?.click())
    expect(cancelWorkflow).toHaveBeenCalledWith('planning-candidates')
  })
})
