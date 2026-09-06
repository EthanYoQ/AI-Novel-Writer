import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ProjectData } from '../../../../shared/ipc-channels'
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
})
