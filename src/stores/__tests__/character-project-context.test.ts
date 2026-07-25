import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectData } from '../../shared/ipc-channels'
import { useCharacterStore, type CharacterCard } from '../character-store'
import { useEditorStore } from '../editor-store'
import { useProjectStore } from '../project-store'
import {
  CHARACTER_DRAFT_TAB,
  getProjectEditorDraft,
  parseProjectEditorDraftLedger,
} from '../project-editor-draft-ledger'

const { invoke, invokeWithProjectSession } = vi.hoisted(() => ({
  invoke: vi.fn(),
  invokeWithProjectSession: vi.fn(),
}))

vi.mock('../../services/ipc-client', () => ({
  ipc: { invoke, invokeWithProjectSession },
}))

const PROJECT_A = 'C:\\novels\\project-a'
const PROJECT_B = 'C:\\novels\\project-b'

function project(path: string): ProjectData {
  return {
    id: path === PROJECT_A ? 'a' : 'b',
    sessionLease: `lease-${path === PROJECT_A ? 'a' : 'b'}`,
    name: path === PROJECT_A ? 'A' : 'B',
    path,
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

function character(name: string, notes = ''): CharacterCard {
  return {
    name,
    role: 'protagonist',
    gender: '',
    age: '',
    appearance: '',
    personality: '',
    background: '',
    abilities: '',
    motivation: '',
    relationships: '',
    arc: '',
    notes,
  }
}

function currentLedger() {
  return parseProjectEditorDraftLedger<CharacterCard[]>(
    useEditorStore.getState().draftLedgers[CHARACTER_DRAFT_TAB.id],
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

beforeEach(() => {
  invoke.mockReset()
  invokeWithProjectSession.mockReset()
  invokeWithProjectSession.mockImplementation((
    _projectSession: unknown,
    channel: string,
    ...args: unknown[]
  ) => invoke(channel, ...args))
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useProjectStore.setState({ currentProject: project(PROJECT_A), fileTree: [], loading: false })
  useCharacterStore.getState().reset()
})

describe('character store project context', () => {
  it('binds a normal load and every mutation to the same project path', async () => {
    invoke
      .mockResolvedValueOnce([character('A 角色')])
      .mockResolvedValueOnce({ success: true })

    await useCharacterStore.getState().load(PROJECT_A)
    expect(invoke).toHaveBeenNthCalledWith(1, 'db:character-get-all', PROJECT_A)
    expect(useCharacterStore.getState()).toMatchObject({
      dataProjectKey: PROJECT_A,
      loadingProjectKey: null,
      lastError: null,
    })

    useCharacterStore.getState().updateField('A 角色', 'notes', 'A 本地修改')
    await expect(useCharacterStore.getState().saveAll(PROJECT_A)).resolves.toBeUndefined()
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      'db:character-save-all',
      [expect.objectContaining({ name: 'A 角色', notes: 'A 本地修改' })],
      [],
      PROJECT_A,
    )
  })

  it('keeps A and B ledgers separate and blocks mutations while B data is not loaded', async () => {
    invoke
      .mockResolvedValueOnce([character('A 角色')])
      .mockResolvedValueOnce([character('B 角色')])

    await useCharacterStore.getState().load(PROJECT_A)
    useCharacterStore.getState().updateField('A 角色', 'notes', 'A 未保存')

    useCharacterStore.getState().beginProjectLoad(PROJECT_B)
    useProjectStore.setState({ currentProject: project(PROJECT_B) })

    expect(useCharacterStore.getState()).toMatchObject({
      characters: [],
      dataProjectKey: null,
      loadingProjectKey: PROJECT_B,
    })
    expect(useCharacterStore.getState().renameCharacter('A 角色', '错误改名')).toBe(false)
    await expect(useCharacterStore.getState().deleteCharacter('A 角色', PROJECT_B))
      .resolves.toBe(false)
    await expect(useCharacterStore.getState().saveAll(PROJECT_B))
      .rejects.toThrow(/切换项目/)
    expect(invoke).toHaveBeenCalledTimes(1)

    await useCharacterStore.getState().load(PROJECT_B)
    useCharacterStore.getState().updateField('B 角色', 'notes', 'B 未保存')

    const ledger = currentLedger()
    expect(getProjectEditorDraft(ledger, PROJECT_A)?.draftValue).toEqual([
      character('A 角色', 'A 未保存'),
    ])
    expect(getProjectEditorDraft(ledger, PROJECT_B)?.draftValue).toEqual([
      character('B 角色', 'B 未保存'),
    ])
  })

  it('does not let an A delete completion mutate B and waits before loading B', async () => {
    const deleteA = deferred<{ success: boolean }>()
    invoke
      .mockResolvedValueOnce([character('A 待删除'), character('A 保留')])
      .mockReturnValueOnce(deleteA.promise)
      .mockResolvedValueOnce([character('B 角色')])

    await useCharacterStore.getState().load(PROJECT_A)
    const deletion = useCharacterStore.getState().deleteCharacter('A 待删除', PROJECT_A)
    useCharacterStore.getState().beginProjectLoad(PROJECT_B)
    useProjectStore.setState({ currentProject: project(PROJECT_B) })
    const loadB = useCharacterStore.getState().load(PROJECT_B)

    // B obtains a new lease, so it does not wait for A's stale identity mutation.
    expect(invoke).toHaveBeenCalledTimes(3)
    deleteA.resolve({ success: true })
    await Promise.all([expect(deletion).resolves.toBe(false), loadB])

    expect(invoke).toHaveBeenNthCalledWith(
      2,
      'db:character-delete',
      'A 待删除',
      PROJECT_A,
    )
    expect(invoke).toHaveBeenNthCalledWith(3, 'db:character-get-all', PROJECT_B)
    expect(useCharacterStore.getState()).toMatchObject({
      characters: [character('B 角色')],
      dataProjectKey: PROJECT_B,
      selectedName: 'B 角色',
    })
  })

  it('exposes a same-project read rejection without attaching stale data', async () => {
    invoke.mockRejectedValueOnce(new Error('项目上下文已切换，已拒绝跨项目读写'))

    await useCharacterStore.getState().load(PROJECT_A)

    expect(useCharacterStore.getState()).toMatchObject({
      characters: [],
      dataProjectKey: PROJECT_A,
      loaded: false,
      lastError: '项目上下文已切换，已拒绝跨项目读写',
    })
  })

  it('preserves an existing character draft ledger and blocks every write after reload fails', async () => {
    invoke.mockResolvedValueOnce([character('A 角色')])
    await useCharacterStore.getState().load(PROJECT_A)
    useCharacterStore.getState().updateField('A 角色', 'notes', '未保存草稿')
    const ledgerBeforeFailure = useEditorStore.getState().draftLedgers[CHARACTER_DRAFT_TAB.id]

    invoke.mockRejectedValueOnce(new Error('database busy'))
    await useCharacterStore.getState().load(PROJECT_A)

    useCharacterStore.getState().addCharacter()
    useCharacterStore.getState().updateField('A 角色', 'notes', '不应覆盖')
    expect(useCharacterStore.getState().renameCharacter('A 角色', '不应改名')).toBe(false)
    await expect(useCharacterStore.getState().deleteCharacter('A 角色', PROJECT_A))
      .resolves.toBe(false)
    await expect(useCharacterStore.getState().saveAll(PROJECT_A))
      .rejects.toThrow(/切换项目/)

    expect(useCharacterStore.getState()).toMatchObject({
      characters: [],
      dataProjectKey: PROJECT_A,
      loaded: false,
      loadingProjectKey: null,
      lastError: 'database busy',
    })
    expect(useEditorStore.getState().draftLedgers[CHARACTER_DRAFT_TAB.id])
      .toBe(ledgerBeforeFailure)
    expect(invoke).toHaveBeenCalledTimes(2)
  })
})
