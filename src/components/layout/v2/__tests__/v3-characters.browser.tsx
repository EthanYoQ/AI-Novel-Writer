import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'

import '../../../../index.css'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useAppearanceStore } from '../../../../stores/appearance-bootstrap'
import { useCharacterStore, type CharacterCard } from '../../../../stores/character-store'
import { useLayoutStore } from '../../../../stores/layout-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import LeftToolWindowBar from '../../LeftToolWindowBar'
import EditorArea from '../../../panels/EditorArea'
import Sidebar from '../../../panels/Sidebar'
import ShellV2 from '../ShellV2'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const projectPath = 'C:/v3/character-journey'
const originalCharacter = useCharacterStore.getState()
const originalProject = useProjectStore.getState()
const originalLayout = useLayoutStore.getState()
const originalAppearance = useAppearanceStore.getState()
const originalLocale = useLocaleStore.getState()
const originalBridge = Object.getOwnPropertyDescriptor(window, 'aiNovelAPI')

function card(characterId: string, notes: string, relationships = ''): CharacterCard {
  return { characterId, name: '沈砺', role: 'supporting', gender: '', age: '', appearance: '',
    personality: '', background: notes, abilities: '', motivation: '', relationships, arc: '', notes }
}

afterEach(() => {
  useCharacterStore.setState(originalCharacter, true)
  useProjectStore.setState(originalProject, true)
  useLayoutStore.setState(originalLayout, true)
  useAppearanceStore.setState(originalAppearance, true)
  useLocaleStore.setState(originalLocale, true)
  setActiveProjectSessionContext(null)
  if (originalBridge) Object.defineProperty(window, 'aiNovelAPI', originalBridge)
  else Reflect.deleteProperty(window, 'aiNovelAPI')
  vi.restoreAllMocks()
})

it('V3 role rail opens a stable-ID profile, avatar and graph without changing their owners', async () => {
  await page.viewport(1440, 900)
  const avatarCanvas = document.createElement('canvas')
  avatarCanvas.width = avatarCanvas.height = 1
  const avatarBase64 = avatarCanvas.toDataURL('image/png').split(',')[1]
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'character-avatar:read-batch') return { success: true, avatars: [
      { characterId: 'stable-a', assetRevision: 1, mime: 'image/png', base64: avatarBase64 },
    ] }
    return []
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: vi.fn(() => () => {}) } })
  useAppearanceStore.setState({ resolvedShell: 'writer' })
  useLocaleStore.setState({ locale: 'zh-CN' })
  useLayoutStore.setState({ sidebarView: 'project', activeRailItem: 'project' })
  useProjectStore.setState({ currentProject: {
    id: 'v3-characters', name: '角色旅程', path: projectPath, sessionLease: 'v3-character-lease', novelConfig: {},
  } as never, fileTree: [], loading: false })
  setActiveProjectSessionContext({ projectId: 'v3-characters', leaseId: 'v3-character-lease', projectPath })
  useCharacterStore.setState({
    characters: [
      card('stable-a', '甲档案', JSON.stringify([{ target: '沈砺', targetCharacterId: 'stable-b', relation: '同伴' }])),
      card('stable-b', '乙档案'),
    ],
    selectedId: 'stable-a', selectedName: '沈砺', dataProjectKey: projectPath,
    loadingProjectKey: null, lastError: null, saving: false, identityBusy: false,
    dataProjectSession: { projectId: 'v3-characters', leaseId: 'v3-character-lease', projectPath },
  })

  const host = document.createElement('div')
  host.style.height = '900px'
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<ShellV2 presentation="writer" variant="v3" theme="light"
      titleBar={<span>角色旅程</span>} rail={<LeftToolWindowBar />} sidebar={<Sidebar />}
      editor={<EditorArea onNewProject={vi.fn()} />} aiPanel={<span>助手</span>}
      bottom={<span>任务</span>} statusBar={<span>本地写作</span>} />))
    await act(async () => host.querySelector<HTMLButtonElement>('button[title="角色"]')!.click())
    expect(useLayoutStore.getState().sidebarView).toBe('characters')
    expect(host.querySelector('[data-character-id="stable-a"]')).toBeTruthy()
    await vi.waitFor(() => expect(host.querySelector<HTMLImageElement>('[data-character-id="stable-a"] img')?.naturalWidth).toBe(1))
    await vi.waitFor(() => expect(host.querySelector<HTMLImageElement>('img[alt="沈砺头像预览"]')?.naturalWidth).toBe(1))
    expect(invoke.mock.calls.some(([channel]) => channel === 'character-avatar:read-batch')).toBe(true)
    const profile = host.querySelector<HTMLElement>('.writer-editor-content .skin-workspace-page:not([hidden]) .max-w-2xl')!
    expect(profile).toBeTruthy()
    expect(getComputedStyle(profile).borderTopWidth).toBe('3px')
    expect(host.querySelector<HTMLInputElement>('input[value="沈砺"]')).toBeTruthy()
    await act(async () => host.querySelector<HTMLButtonElement>('button[title="查看全员关系网"]')!.click())
    expect(host.querySelector('canvas')).toBeTruthy()
    await act(async () => host.querySelector<HTMLButtonElement>('[data-graph-character-id="stable-b"]')!.click())
    expect(useCharacterStore.getState().selectedId).toBe('stable-b')
    expect(host.querySelector<HTMLTextAreaElement>('textarea[placeholder="输入备注..."]')?.value).toBe('乙档案')
    await page.screenshot({ path: '../../../../../.runtime/.cache/novel-quality-modernization/v3-characters-browser-1440x900.png' })
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
