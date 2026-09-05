import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import type { ProjectData } from '../../../shared/ipc-channels'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import ArchFileViewer from '../ArchFileViewer'

const PROJECT_PATH = 'C:\\novels\\arch-locale'
const project: ProjectData = {
  id: 'arch-locale-project',
  sessionLease: 'arch-locale-lease',
  name: 'Architecture locale',
  path: PROJECT_PATH,
  novelConfig: {
    genre: '', subGenre: '', targetAudience: '', totalChapters: 4, wordsPerChapter: 2500,
    plotStructure: 'three_act', narrativePOV: 'third_limited', coreOutline: '', worldSetting: '',
    goldenFinger: '', protagonistProfile: '', globalGuidance: '',
  },
  characterStates: '',
  createdAt: '',
  updatedAt: '',
}

let container: HTMLDivElement
let root: Root
let invoke: ReturnType<typeof vi.fn>
const originalLocaleState = useLocaleStore.getState()
const originalProjectState = useProjectStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  useLocaleStore.setState({ locale: 'en-US', initialized: true })
  useProjectStore.setState({ currentProject: project, fileTree: [], loading: false })
  setActiveProjectSessionContext({
    projectId: project.id,
    leaseId: project.sessionLease!,
    projectPath: PROJECT_PATH,
  })
  invoke = vi.fn().mockResolvedValue({ success: true })
  Object.defineProperty(window, 'velaAPI', {
    configurable: true,
    value: {
      invoke,
      on: vi.fn(() => () => {}),
      once: vi.fn(),
      send: vi.fn(),
    },
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(window, 'velaAPI')
  setActiveProjectSessionContext(null)
  useLocaleStore.setState(originalLocaleState)
  useProjectStore.setState(originalProjectState)
  vi.restoreAllMocks()
})

describe('ArchFileViewer locale', () => {
  it('renders document controls and empty guidance in English', async () => {
    const generatedContent = 'A'.repeat(60)
    await act(async () => root.render(
      <ArchFileViewer
        tabId="arch-premise"
        filePath="C:\\novels\\premise.md"
        projectKey={PROJECT_PATH}
        content={generatedContent}
        savedContent=""
      />,
    ))

    await vi.waitFor(() => expect(container.textContent).toContain('characters'))
    expect(container.textContent).toContain('Save')
    expect(container.textContent).toContain('AI Regenerate')
    expect(container.querySelector('[title="Unsaved changes"]')).not.toBeNull()
    expect(container.querySelector('[title="Save (Cmd+S)"]')).not.toBeNull()
    expect(container.querySelector('[title="AI Regenerate “Premise”"]')).not.toBeNull()
    expect(container.textContent).not.toMatch(/字|保存|重新生成/)

    let finishSave: ((value: { success: true }) => void) | undefined
    invoke.mockImplementation(() => new Promise(resolve => { finishSave = resolve }))
    await act(async () => Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.includes('Save'))?.click())
    await vi.waitFor(() => expect(container.textContent).toContain('Saving...'))
    await act(async () => finishSave?.({ success: true }))

    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => root.render(
      <ArchFileViewer
        tabId="arch-empty-premise"
        filePath="C:\\novels\\premise.md"
        projectKey={PROJECT_PATH}
        content=""
        savedContent=""
      />,
    ))

    await vi.waitFor(() => expect(container.textContent).toContain('AI Generate'))
    expect(container.querySelector('[title="AI Generate “Premise”"]')).not.toBeNull()
    expect(container.textContent).toContain('No content yet. Click “AI Generate” in the top-right or start editing here...')
    expect(container.textContent).not.toMatch(/尚未生成内容|AI 生成/)
  })
})
