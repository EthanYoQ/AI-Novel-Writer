import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectData } from '../../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useCharacterStore, type CharacterCard } from '../../../../stores/character-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import CharactersView from '../CharactersView'

const PROJECT_PATH = 'C:\\novels\\character-search'
const originalCharacterState = useCharacterStore.getState()
const originalLocaleState = useLocaleStore.getState()
const originalProjectState = useProjectStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement

function project(): ProjectData {
  return {
    id: 'character-search',
    sessionLease: 'character-search-lease',
    name: 'Character Search',
    path: PROJECT_PATH,
    novelConfig: {
      genre: 'Mystery', subGenre: '', targetAudience: 'General', totalChapters: 10,
      wordsPerChapter: 2500, plotStructure: 'three_act', narrativePOV: 'third_limited',
      coreOutline: '', worldSetting: '', goldenFinger: '', protagonistProfile: '', globalGuidance: '',
    },
    characterStates: '', createdAt: '', updatedAt: '',
  }
}

function card(name: string): CharacterCard {
  return {
    name, role: 'supporting', gender: '', age: '', appearance: '', personality: '',
    background: '', abilities: '', motivation: '', relationships: '', arc: '', notes: '',
  }
}

beforeEach(async () => {
  useCharacterStore.setState(originalCharacterState)
  useLocaleStore.setState({ ...originalLocaleState, locale: 'en-US', initialized: true })
  useProjectStore.setState({ ...originalProjectState, currentProject: project() })
  useCharacterStore.setState({
    characters: [card('Alice Chen'), card('Bob Stone'), card('Alicia Park')],
    dataProjectKey: PROJECT_PATH,
    loadingProjectKey: null,
    lastError: null,
    identityBusy: false,
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<CharactersView />))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useCharacterStore.setState(originalCharacterState)
  useLocaleStore.setState(originalLocaleState)
  useProjectStore.setState(originalProjectState)
  setActiveProjectSessionContext(null)
  delete window.aiNovelAPI
})

describe('character list search', () => {
  it('filters characters by a case-insensitive name fragment and restores the list when cleared', async () => {
    const search = page.getByRole('textbox', { name: 'Search characters' })

    await act(async () => { await search.fill('ALI') })
    expect(container.textContent).toContain('Alice Chen')
    expect(container.textContent).toContain('Alicia Park')
    expect(container.textContent).not.toContain('Bob Stone')

    await act(async () => { await search.clear() })
    expect(container.textContent).toContain('Bob Stone')
  })

  it('renders same-name avatars by stable ID and keeps them bound after a rename', async () => {
    setActiveProjectSessionContext({
      projectId: 'character-search', leaseId: 'character-search-lease', projectPath: PROJECT_PATH,
    })
    const invoke = vi.fn(async (channel: string, ids: string[]) => ({
      success: true,
      avatars: channel === 'character-avatar:read-batch'
        ? ids.map((characterId, index) => ({ characterId, assetRevision: 1, mime: 'image/png', base64: btoa(`avatar-${index}`) }))
        : [],
    }))
    window.aiNovelAPI = { invoke } as unknown as typeof window.aiNovelAPI
    useCharacterStore.setState({
      characters: [
        { ...card('同名'), characterId: 'stable-a' },
        { ...card('同名'), characterId: 'stable-b' },
      ],
    })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const before = new Map(Array.from(container.querySelectorAll('[data-character-id]')).map(row => [
      row.getAttribute('data-character-id'), row.querySelector('img')?.src,
    ]))
    expect(before.get('stable-a')).toMatch(/^blob:/)
    expect(before.get('stable-b')).toMatch(/^blob:/)
    expect(before.get('stable-a')).not.toBe(before.get('stable-b'))
    expect(invoke).toHaveBeenCalledWith(
      'character-avatar:read-batch',
      ['stable-a', 'stable-b'],
      expect.objectContaining({ projectId: 'character-search' }),
    )

    useCharacterStore.setState(state => ({
      characters: state.characters.map(character => character.characterId === 'stable-b'
        ? { ...character, name: '改名后' }
        : character),
    }))
    await act(async () => { await Promise.resolve() })
    const after = container.querySelector('[data-character-id="stable-b"] img') as HTMLImageElement
    expect(after.alt).toBe('改名后 avatar')
    expect(after.src).toBe(before.get('stable-b'))
  })
})
