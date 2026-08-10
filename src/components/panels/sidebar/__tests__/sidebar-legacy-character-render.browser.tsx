import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ProjectData } from '../../../../shared/ipc-channels'
import { useCharacterStore, type CharacterCard } from '../../../../stores/character-store'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLayoutStore } from '../../../../stores/layout-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import { CHARACTER_DRAFT_TAB } from '../../../../stores/project-editor-draft-ledger'
import { ErrorBoundary } from '../../../ErrorBoundary'
import Sidebar from '../../Sidebar'

const PROJECT_PATH = 'C:\\novels\\legacy-character-sidebar'
const SIDEBAR_ERROR_LABEL = '侧边栏渲染失败'
const originalCharacterState = useCharacterStore.getState()
const originalEditorState = useEditorStore.getState()
const originalLayoutState = useLayoutStore.getState()
const originalLocaleState = useLocaleStore.getState()
const originalProjectState = useProjectStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface TestVelaApi {
  invoke: ReturnType<typeof vi.fn>
  on: () => () => void
  once: () => void
  send: () => void
  setZoomLevel: () => void
  setZoomFactor: () => void
  getZoomLevel: () => number
}

let root: Root | undefined
let container: HTMLDivElement | undefined

function project(): ProjectData {
  return {
    id: 'legacy-character-sidebar',
    sessionLease: 'legacy-character-sidebar-lease',
    name: '旧角色项目',
    path: PROJECT_PATH,
    novelConfig: {
      genre: '玄幻',
      subGenre: '',
      targetAudience: '全龄',
      totalChapters: 10,
      wordsPerChapter: 3000,
      plotStructure: 'three_act',
      narrativePOV: 'third_limited',
      coreOutline: '',
      worldSetting: '',
      goldenFinger: '',
      protagonistProfile: '',
      globalGuidance: '',
    },
    characterStates: '',
    createdAt: '',
    updatedAt: '',
  }
}

function rosterRead() {
  return {
    revision: 1,
    entries: [{
      name: '旧角色',
      role: 'supporting',
      relationships: [],
    }],
  }
}

function installVelaApi(response: ReturnType<typeof rosterRead>) {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'db:character-roster-read') return response
    throw new Error(`Unexpected IPC channel: ${channel}`)
  })
  ;(window as unknown as { velaAPI: TestVelaApi }).velaAPI = {
    invoke,
    on: () => () => {},
    once: () => {},
    send: () => {},
    setZoomLevel: () => {},
    setZoomFactor: () => {},
    getZoomLevel: () => 0,
  }
}

beforeEach(() => {
  useCharacterStore.setState(originalCharacterState)
  useEditorStore.setState(originalEditorState)
  useLayoutStore.setState(originalLayoutState)
  useLocaleStore.setState(originalLocaleState)
  useProjectStore.setState(originalProjectState)
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useProjectStore.setState({ currentProject: project(), fileTree: [], loading: false })
  useLayoutStore.setState({ sidebarView: 'characters' })
  useLocaleStore.setState({ locale: 'zh-CN' })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  useCharacterStore.setState(originalCharacterState)
  useEditorStore.setState(originalEditorState)
  useLayoutStore.setState(originalLayoutState)
  useLocaleStore.setState(originalLocaleState)
  useProjectStore.setState(originalProjectState)
  delete (window as unknown as { velaAPI?: TestVelaApi }).velaAPI
})

describe('Sidebar legacy character rendering', () => {
  it('renders a persisted legacy character draft that is missing role instead of crashing the sidebar', async () => {
    const persistedBaseCard = { name: '旧角色', role: 'supporting' } as CharacterCard
    const legacyDraftCard = { name: '旧角色' } as CharacterCard
    installVelaApi(rosterRead())
    useEditorStore.setState({
      draftLedgers: {
        [CHARACTER_DRAFT_TAB.id]: JSON.stringify({
          version: 1,
          projects: [{
            projectKey: PROJECT_PATH,
            baseValue: [persistedBaseCard],
            draftValue: [legacyDraftCard],
          }],
        }),
      },
    })

    await useCharacterStore.getState().load(PROJECT_PATH)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <ErrorBoundary fallbackLabel={SIDEBAR_ERROR_LABEL}>
          <Sidebar />
        </ErrorBoundary>,
      )
    })

    expect(container?.textContent).toContain('配角')
    expect(container?.textContent).not.toContain('侧边栏渲染失败')
  })

  it('defensively renders an unknown role already present in renderer state', async () => {
    installVelaApi(rosterRead())
    await useCharacterStore.getState().load(PROJECT_PATH)
    const loadedCharacter = useCharacterStore.getState().characters[0]
    useCharacterStore.setState({
      characters: [{
        ...loadedCharacter,
        role: 'legacy-custom-role' as CharacterCard['role'],
      }],
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <ErrorBoundary fallbackLabel={SIDEBAR_ERROR_LABEL}>
          <Sidebar />
        </ErrorBoundary>,
      )
    })

    expect(container?.textContent).toContain('配角')
    expect(container?.textContent).not.toContain('侧边栏渲染失败')
  })
})
