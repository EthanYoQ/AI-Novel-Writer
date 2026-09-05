import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { globalEventBus } from '../../../../shared/event-bus'
import type { ProjectData } from '../../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useDraftStore } from '../../../../stores/draft-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useWorkflowStore } from '../../../../stores/workflow-store'
import ProjectTree from '../ProjectTree'

const PROJECT_PATH = 'C:\\novels\\architecture-refresh'
const PROJECT_SESSION = {
  projectId: 'architecture-refresh',
  leaseId: 'architecture-refresh-lease',
  projectPath: PROJECT_PATH,
}
const project: ProjectData = {
  id: PROJECT_SESSION.projectId,
  sessionLease: PROJECT_SESSION.leaseId,
  name: 'Architecture refresh',
  path: PROJECT_PATH,
  novelConfig: {
    genre: '', subGenre: '', targetAudience: '', totalChapters: 4, wordsPerChapter: 2500,
    plotStructure: 'three_act', narrativePOV: 'third_limited', coreOutline: 'Configured',
    worldSetting: '', goldenFinger: '', protagonistProfile: '', globalGuidance: '',
  },
  characterStates: '',
  createdAt: '',
  updatedAt: '',
}

const originalDraftState = useDraftStore.getState()
const originalLocaleState = useLocaleStore.getState()
const originalProjectState = useProjectStore.getState()
const originalWorkflowState = useWorkflowStore.getState()

let container: HTMLDivElement
let root: Root
let invoke: ReturnType<typeof vi.fn>
let synopsis = ''
let blueprintCount = 0

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  synopsis = ''
  blueprintCount = 0
  useLocaleStore.setState({ locale: 'en-US', initialized: true })
  useProjectStore.setState({
    currentProject: project,
    projectSessionEpoch: 1,
    fileTree: [],
    loading: false,
  })
  useWorkflowStore.setState({ activeRuns: [], history: [] })
  useDraftStore.setState({
    draftsByChapter: {},
    loading: false,
    dataProjectKey: null,
    dataProjectSession: null,
    loadingProjectKey: null,
    loadingProjectSession: null,
  })
  setActiveProjectSessionContext(PROJECT_SESSION)

  invoke = vi.fn(async (channel: string) => {
    if (channel === 'fs:list-dir' || channel === 'db:draft-list-all') return []
    if (channel === 'db:blueprint-get-all') {
      return Array.from({ length: blueprintCount }, (_, index) => ({ chapterNumber: index + 1 }))
    }
    if (channel === 'db:project-core-get') {
      return {
        premise: 'P'.repeat(60),
        charactersArch: 'C'.repeat(60),
        worldbuilding: 'W'.repeat(60),
        synopsis,
      }
    }
    if (channel === 'db:character-roster-read') {
      return { status: 'ready', revision: 1, entries: [], renderedMarkdown: 'Character roster' }
    }
    if (channel === 'chapter:list-incomplete-deletions') return { success: true, operations: [] }
    throw new Error(`Unexpected IPC channel in ProjectTree refresh test: ${channel}`)
  })
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
  useDraftStore.setState(originalDraftState)
  useLocaleStore.setState(originalLocaleState)
  useProjectStore.setState(originalProjectState)
  useWorkflowStore.setState(originalWorkflowState)
  vi.restoreAllMocks()
})

describe('ProjectTree architecture status refresh', () => {
  it('reflects a committed architecture file event without waiting for another workflow state change', async () => {
    await act(async () => root.render(<ProjectTree />))

    const coreReadCount = () => invoke.mock.calls.filter(([channel]) => channel === 'db:project-core-get').length
    await act(async () => {
      await vi.waitFor(() => expect(coreReadCount()).toBeGreaterThanOrEqual(2))
    })
    expect(container.textContent).toContain('Story architecture3/4')
    const readsBeforeCommit = coreReadCount()

    synopsis = 'S'.repeat(60)
    await act(async () => globalEventBus.emit('ARCH_FILE_UPDATED', {
      fileName: 'synopsis.md',
      projectPath: PROJECT_PATH,
      projectSession: PROJECT_SESSION,
      runId: 'architecture-run',
    }))

    await act(async () => {
      await vi.waitFor(() => expect(coreReadCount()).toBeGreaterThan(readsBeforeCommit))
    })
    expect(container.textContent).toContain('Story architecture4/4')
  })

  it('reflects committed blueprint count when the blueprint resource event arrives', async () => {
    await act(async () => root.render(<ProjectTree />))

    const blueprintReadCount = () => invoke.mock.calls.filter(([channel]) => channel === 'db:blueprint-get-all').length
    await act(async () => {
      await vi.waitFor(() => expect(blueprintReadCount()).toBeGreaterThanOrEqual(2))
    })
    expect(container.textContent).toContain('Chapter blueprintsPending')
    const readsBeforeCommit = blueprintReadCount()

    blueprintCount = 4
    await act(async () => globalEventBus.emit('REFRESH_RESOURCE', {
      resources: ['blueprints'],
      projectPath: PROJECT_PATH,
      projectSession: PROJECT_SESSION,
    }))

    await act(async () => {
      await vi.waitFor(() => expect(blueprintReadCount()).toBeGreaterThan(readsBeforeCommit))
    })
    expect(container.textContent).toContain('Chapter blueprints4/4 chapters')
  })
})
