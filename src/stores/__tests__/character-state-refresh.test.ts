import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { authorStateEdit } from '../../components/editor/character-state-fields'
import { characterRosterEntryFromCard } from '../../services/character-roster-client'
import type { CharacterStateFieldProvenance } from '../../shared/character-roster'
import { mergeCharacterDraftWithRemote } from '../character-rename-ledger'
import { EMPTY_CARD, useCharacterStore, type CharacterCard, type CharacterCurrentState } from '../character-store'
import { useEditorStore } from '../editor-store'
import { useProjectStore } from '../project-store'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../services/ipc-client', () => ({ ipc: { invokeWithProjectSession: invoke } }))

const path = 'C:/灯塔'
const derived = (chapterNumber: number): CharacterStateFieldProvenance => ({
  kind: 'derived',
  source: { draftId: chapterNumber, finalizationId: `finalization-${chapterNumber}`, chapterNumber, contentHash: String(chapterNumber).repeat(64) },
})
const author = (chapterNumber: number): CharacterStateFieldProvenance => ({ kind: 'author', chapterNumber })

const chapterOneState: CharacterCurrentState = {
  location: '旧港', powerLevel: '普通人', physicalState: '疲惫', mentalState: '警觉',
  keyItems: '铜钥匙', recentEvents: '找到封存的地图', updatedAtChapter: 1,
  provenance: { location: derived(1), mentalState: derived(1), keyItems: author(1), recentEvents: derived(1) },
}
const chapterThreeState: CharacterCurrentState = {
  ...chapterOneState,
  location: '灯塔顶层灯室', mentalState: '平静', keyItems: '父亲的地图', recentEvents: '在灯室找到纸条', updatedAtChapter: 3,
  provenance: { ...chapterOneState.provenance, location: derived(3), mentalState: derived(3), keyItems: derived(3), recentEvents: derived(3) },
}

const linLan = (currentState?: CharacterCurrentState): CharacterCard => ({
  ...EMPTY_CARD, characterId: '林岚id', name: '林岚', ...(currentState ? { currentState } : {}),
})
const authorEdit = (card: CharacterCard, field: Parameters<typeof authorStateEdit>[1], value: string) => (
  { ...card, currentState: authorStateEdit(card, field, value) }
)
const mergedState = (base: CharacterCard, draft: CharacterCard, remote: CharacterCard) => (
  mergeCharacterDraftWithRemote([base], [draft], [remote], [])[0].currentState
)

it('keeps the field the author edited and takes every other field and the chapter from the database', () => {
  const base = linLan(chapterOneState)
  const draft = authorEdit(base, 'mentalState', '怕涨潮')

  expect(mergedState(base, draft, linLan(chapterThreeState))).toEqual({
    ...chapterThreeState,
    mentalState: '怕涨潮',
    provenance: { ...chapterThreeState.provenance, mentalState: author(1) },
  })
})

it('keeps a field the author cleared even when the database wrote a new value', () => {
  const base = linLan(chapterOneState)
  const draft = authorEdit(base, 'keyItems', '')

  expect(mergedState(base, draft, linLan(chapterThreeState))).toEqual({
    ...chapterThreeState,
    keyItems: '',
    provenance: { ...chapterThreeState.provenance, keyItems: author(1) },
  })
})

it('keeps a field the author typed in and then restored, since the input is still the author input', () => {
  const base = linLan(chapterOneState)
  const draft = authorEdit(authorEdit(base, 'location', '半路'), 'location', '旧港')

  expect(mergedState(base, draft, linLan(chapterThreeState))).toEqual({
    ...chapterThreeState,
    location: '旧港',
    provenance: { ...chapterThreeState.provenance, location: author(1) },
  })
})

it('merges by field when the author started the state on a card that had none', () => {
  const base = linLan()
  const draft = authorEdit(base, 'mentalState', '怕涨潮')

  expect(mergedState(base, draft, linLan(chapterThreeState))).toEqual({
    ...chapterThreeState,
    mentalState: '怕涨潮',
    provenance: { ...chapterThreeState.provenance, mentalState: author(0) },
  })
})

const roster = (cards: CharacterCard[], revision: number) => ({
  revision, identityRevision: revision, entries: cards.map(characterRosterEntryFromCard),
})

beforeEach(() => {
  invoke.mockReset()
  useEditorStore.setState({ draftLedgers: {} })
  useProjectStore.setState({ currentProject: { id: '灯塔', path, sessionLease: 'epoch', novelConfig: {} } as never })
  useCharacterStore.getState().reset()
})

afterEach(() => {
  useProjectStore.setState({ currentProject: null })
  useCharacterStore.getState().reset()
})

it('saves the refreshed state with the new revision after finalization wrote it under an unsaved author edit', async () => {
  invoke.mockResolvedValue(roster([linLan(chapterOneState)], 1))
  await useCharacterStore.getState().load(path)
  const loaded = useCharacterStore.getState().characters[0]
  useCharacterStore.getState().updateField('林岚id', 'currentState', authorStateEdit(loaded, 'mentalState', '怕涨潮'))

  invoke.mockResolvedValue(roster([linLan(chapterThreeState)], 2))
  await useCharacterStore.getState().load(path)

  const expected = {
    ...chapterThreeState,
    mentalState: '怕涨潮',
    provenance: { ...chapterThreeState.provenance, mentalState: author(1) },
  }
  expect(useCharacterStore.getState().characters[0].currentState).toEqual(expected)

  let commit: { expectedRevision: number; entries: Array<{ currentState?: CharacterCurrentState }> } | undefined
  invoke.mockImplementation(async (_session, channel, request) => {
    expect(channel).toBe('db:character-roster-commit')
    commit = request
    return { success: true, receipt: { revision: 3, snapshot: roster([{ ...linLan(), currentState: request.entries[0].currentState }], 3) } }
  })
  await useCharacterStore.getState().saveAll(path)

  expect(commit?.expectedRevision).toBe(2)
  expect(commit?.entries[0].currentState).toEqual(expected)
})

it('keeps an unsaved author value across later refreshes after the database once wrote the same text', async () => {
  invoke.mockResolvedValue(roster([linLan(chapterOneState)], 1))
  await useCharacterStore.getState().load(path)
  const loaded = useCharacterStore.getState().characters[0]
  useCharacterStore.getState().updateField('林岚id', 'currentState', authorStateEdit(loaded, 'location', '灯塔顶层灯室'))

  invoke.mockResolvedValue(roster([linLan(chapterThreeState)], 2))
  await useCharacterStore.getState().load(path)
  invoke.mockResolvedValue(roster([linLan({ ...chapterThreeState, location: '图书馆', updatedAtChapter: 4, provenance: { ...chapterThreeState.provenance, location: derived(4) } })], 3))
  await useCharacterStore.getState().load(path)

  const state = useCharacterStore.getState().characters[0].currentState
  expect({ location: state?.location, provenance: state?.provenance?.location, updatedAtChapter: state?.updatedAtChapter })
    .toEqual({ location: '灯塔顶层灯室', provenance: author(1), updatedAtChapter: 4 })
})
