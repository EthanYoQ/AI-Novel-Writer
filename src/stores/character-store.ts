import { create } from 'zustand'
import { ipc } from '../services/ipc-client'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import {
  projectSessionContextFromProject,
  sameProjectPathKey,
  sameProjectSessionContext,
} from '../shared/project-session-context'
import type {
  CharacterData,
  CharacterStateData,
} from '../../electron/repositories/character-repository'
import { useEditorStore } from './editor-store'
import { useProjectStore } from './project-store'
import {
  CHARACTER_DRAFT_TAB,
  discardProjectEditorDraft,
  getProjectEditorDraft,
  mergeNamedRecordDraftWithRemote,
  parseProjectEditorDraftLedger,
  persistProjectEditorDraftLedger,
  rebaseProjectEditorDraft,
  recordProjectEditorEdit,
  setProjectEditorDraft,
  settleProjectEditorSave,
} from './project-editor-draft-ledger'
import {
  getCharacterDraftRenames,
  mergeCharacterDraftWithRemote,
  rebuildCharacterRenamesAfterSave,
  setCharacterDraftRenames,
  updateCharacterRename,
} from './character-rename-ledger'

export type CharacterCurrentState = CharacterStateData
export type CharacterCard = CharacterData

export const EMPTY_CARD: CharacterCard = {
  name: '', role: 'supporting', gender: '', age: '',
  appearance: '', personality: '', background: '', abilities: '',
  motivation: '', relationships: '', arc: '', notes: '',
}

export const EMPTY_STATE: CharacterCurrentState = {
  location: '', powerLevel: '', physicalState: '', mentalState: '',
  keyItems: '', recentEvents: '', updatedAtChapter: 0,
}

export const CHARACTER_ROLE_KEYS = [
  'protagonist',
  'antagonist',
  'supporting',
  'minor',
] as const satisfies readonly CharacterCard['role'][]

function readCharacterDraftLedger() {
  return parseProjectEditorDraftLedger<CharacterCard[]>(
    useEditorStore.getState().draftLedgers[CHARACTER_DRAFT_TAB.id],
  )
}

function persistCharacterDraftLedger(ledger: ReturnType<typeof readCharacterDraftLedger>) {
  persistProjectEditorDraftLedger(useEditorStore.getState(), CHARACTER_DRAFT_TAB, ledger)
}

function currentCharacterProjectSession(
  expectedProjectPath?: string,
  expectedProjectSession?: ProjectSessionContext,
): ProjectSessionContext | null {
  const project = useProjectStore.getState().currentProject
  const projectSession = projectSessionContextFromProject(project)
  if (
    !project
    || !projectSession
    || (expectedProjectPath && !sameProjectPathKey(project.path, expectedProjectPath))
    || (expectedProjectSession && !sameProjectSessionContext(expectedProjectSession, projectSession))
  ) return null
  return projectSession
}

function isCharacterProjectSessionCurrent(projectSession: ProjectSessionContext): boolean {
  return sameProjectSessionContext(
    projectSession,
    projectSessionContextFromProject(useProjectStore.getState().currentProject),
  )
}

function valuesMatch(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function removeFirstCharacterNamed(
  characters: readonly CharacterCard[],
  name: string,
): CharacterCard[] {
  const targetIndex = characters.findIndex(character => character.name === name)
  return targetIndex < 0
    ? [...characters]
    : characters.filter((_, index) => index !== targetIndex)
}

interface SessionOperation<T> {
  projectSession: ProjectSessionContext
  promise: Promise<T>
}

let characterSaveInFlight: SessionOperation<void> | null = null
let characterIdentityMutationInFlight: SessionOperation<unknown> | null = null
let characterLoadSequence = 0

interface CharacterState {
  characters: CharacterCard[]
  selectedName: string | null
  saving: boolean
  identityBusy: boolean
  loaded: boolean
  /** 当前 characters 数组实际归属的项目；为空时禁止任何角色写操作。 */
  dataProjectKey: string | null
  /** Exact lease whose character data is currently mounted. */
  dataProjectSession: ProjectSessionContext | null
  loadingProjectKey: string | null
  loadingProjectSession: ProjectSessionContext | null
  lastError: string | null

  load: (projectPath?: string, expectedProjectSession?: ProjectSessionContext) => Promise<void>
  beginProjectLoad: (projectPath: string) => void
  reset: () => void
  setSelectedName: (name: string | null) => void
  addCharacter: () => void
  deleteCharacter: (
    name: string,
    projectPath?: string,
    expectedProjectSession?: ProjectSessionContext,
  ) => Promise<boolean>
  renameCharacter: (name: string, newName: string) => boolean
  discardDraft: (projectPath: string, expectedProjectSession?: ProjectSessionContext) => void
  updateField: <K extends Exclude<keyof CharacterCard, 'name'>>(
    name: string,
    key: K,
    value: CharacterCard[K],
  ) => void
  saveAll: (projectPath?: string, expectedProjectSession?: ProjectSessionContext) => Promise<void>

  // 兼容旧接口
  loadCharacters: (projectPath: string, expectedProjectSession?: ProjectSessionContext) => Promise<void>
}

export const useCharacterStore = create<CharacterState>()((set, get) => ({
  characters: [],
  selectedName: null,
  saving: false,
  identityBusy: false,
  loaded: false,
  dataProjectKey: null,
  dataProjectSession: null,
  loadingProjectKey: null,
  loadingProjectSession: null,
  lastError: null,

  load: async (projectPath, expectedProjectSession) => {
    const projectSession = currentCharacterProjectSession(projectPath, expectedProjectSession)
    if (!projectSession) return
    const requestedProjectKey = projectSession.projectPath
    const requestSequence = ++characterLoadSequence
    if (!sameProjectSessionContext(get().dataProjectSession, projectSession)) {
      set({
        characters: [],
        selectedName: null,
        loaded: false,
        dataProjectKey: null,
        dataProjectSession: null,
        loadingProjectKey: requestedProjectKey,
        loadingProjectSession: projectSession,
        lastError: null,
      })
    } else {
      set({
        loadingProjectKey: requestedProjectKey,
        loadingProjectSession: projectSession,
        lastError: null,
      })
    }
    const pendingIdentityMutation = characterIdentityMutationInFlight
    if (
      pendingIdentityMutation
      && sameProjectSessionContext(pendingIdentityMutation.projectSession, projectSession)
    ) {
      try {
        await pendingIdentityMutation.promise
      } catch {
        // 身份操作失败不应永久阻断后续项目加载。
      }
      if (
        !isCharacterProjectSessionCurrent(projectSession)
        || requestSequence !== characterLoadSequence
      ) return
    }
    try {
      const cards = await ipc.invokeWithProjectSession(
        projectSession,
        'db:character-get-all',
        requestedProjectKey,
      )
      if (
        !isCharacterProjectSessionCurrent(projectSession)
        || requestSequence !== characterLoadSequence
      ) return

      const draftLedger = readCharacterDraftLedger()
      const renames = requestedProjectKey
        ? getCharacterDraftRenames(draftLedger, requestedProjectKey)
        : []
      const restored = requestedProjectKey
        ? rebaseProjectEditorDraft(
            draftLedger,
            requestedProjectKey,
            cards,
            (base, draft, remote) => (
              renames.length > 0
                ? mergeCharacterDraftWithRemote(base, draft, remote, renames)
                : mergeNamedRecordDraftWithRemote(base, draft, remote)
            ),
          )
        : { ledger: draftLedger, value: cards }
      if (requestedProjectKey && getProjectEditorDraft(draftLedger, requestedProjectKey)) {
        persistCharacterDraftLedger(restored.ledger)
      }
      if (
        !isCharacterProjectSessionCurrent(projectSession)
        || requestSequence !== characterLoadSequence
      ) return
      const visibleCards = restored.value

      const { selectedName } = get()
      set({
        characters: visibleCards,
        loaded: true,
        dataProjectKey: requestedProjectKey,
        dataProjectSession: projectSession,
        loadingProjectKey: null,
        loadingProjectSession: null,
        lastError: null,
        selectedName: visibleCards.find(c => c.name === selectedName)
          ? selectedName
          : (visibleCards.length > 0 ? visibleCards[0].name : null),
      })
    } catch (error) {
      if (
        !isCharacterProjectSessionCurrent(projectSession)
        || requestSequence !== characterLoadSequence
      ) return
      set({
        characters: [],
        selectedName: null,
        loaded: false,
        dataProjectKey: requestedProjectKey,
        dataProjectSession: projectSession,
        loadingProjectKey: null,
        loadingProjectSession: null,
        lastError: error instanceof Error ? error.message : String(error),
      })
    }
  },

  loadCharacters: async (projectPath, expectedProjectSession) => {
    await get().load(projectPath, expectedProjectSession)
  },

  beginProjectLoad: (projectPath) => {
    characterLoadSequence += 1
    set({
      characters: [],
      selectedName: null,
      saving: false,
      identityBusy: false,
      loaded: false,
      dataProjectKey: null,
      dataProjectSession: null,
      loadingProjectKey: projectPath,
      loadingProjectSession: null,
      lastError: null,
    })
  },

  reset: () => {
    characterLoadSequence += 1
    set({
      characters: [],
      selectedName: null,
      saving: false,
      identityBusy: false,
      loaded: false,
      dataProjectKey: null,
      dataProjectSession: null,
      loadingProjectKey: null,
      loadingProjectSession: null,
      lastError: null,
    })
  },

  setSelectedName: (name) => {
    const projectSession = currentCharacterProjectSession()
    const state = get()
    if (
      !projectSession
      || !sameProjectSessionContext(state.dataProjectSession, projectSession)
      || state.loadingProjectSession !== null
      || state.lastError !== null
    ) return
    set({ selectedName: name })
  },

  addCharacter: () => {
    const projectSession = currentCharacterProjectSession()
    if (!projectSession) return
    if (
      characterIdentityMutationInFlight
      && sameProjectSessionContext(characterIdentityMutationInFlight.projectSession, projectSession)
    ) return
    const projectKey = projectSession.projectPath
    const state = get()
    if (
      !sameProjectSessionContext(state.dataProjectSession, projectSession)
      || state.loadingProjectSession !== null
      || state.lastError !== null
    ) return
    const before = get().characters
    const newCard: CharacterCard = {
      ...EMPTY_CARD,
      name: `新角色_${Math.random().toString(36).slice(2, 6)}`,
    }
    set((s) => ({
      characters: [...s.characters, newCard],
      selectedName: newCard.name,
    }))
    persistCharacterDraftLedger(recordProjectEditorEdit(
      readCharacterDraftLedger(),
      projectKey,
      before,
      get().characters,
    ))
  },

  deleteCharacter: (name, projectPath, expectedProjectSession) => {
    const projectSession = currentCharacterProjectSession(projectPath, expectedProjectSession)
    if (!projectSession) return Promise.resolve(false)
    if (
      characterIdentityMutationInFlight
      && sameProjectSessionContext(characterIdentityMutationInFlight.projectSession, projectSession)
    ) return Promise.resolve(false)
    const projectKey = projectSession.projectPath
    if (
      !sameProjectSessionContext(get().dataProjectSession, projectSession)
      || get().loadingProjectSession !== null
      || get().lastError !== null
    ) return Promise.resolve(false)
    const { characters } = get()
    const card = characters.find(c => c.name === name)
    if (!card) return Promise.resolve(false)
    const ledger = readCharacterDraftLedger()
    const renames = getCharacterDraftRenames(ledger, projectKey)
    const pendingRename = renames.find(rename => rename.newName === name)
    const persistedName = pendingRename?.originalName ?? name

    const performDelete = async (): Promise<boolean> => {
      // SQLite 删除
      try {
        const result = await ipc.invokeWithProjectSession(
          projectSession,
          'db:character-delete',
          persistedName,
          projectKey,
        )
        if (!result.success) return false
      } catch {
        return false
      }
      if (!isCharacterProjectSessionCurrent(projectSession)) return false

      const latestLedger = readCharacterDraftLedger()
      const latestProjectDraft = projectKey
        ? getProjectEditorDraft(latestLedger, projectKey)
        : undefined
      const latestRenames = projectKey
        ? getCharacterDraftRenames(latestLedger, projectKey)
        : []
      const latestPendingRename = latestRenames.find(rename => (
        rename.originalName === persistedName || rename.newName === name
      ))
      const currentCharacters = get().characters
      const currentTargetName = latestPendingRename?.newName ?? name
      const remaining = removeFirstCharacterNamed(currentCharacters, currentTargetName)
      if (isCharacterProjectSessionCurrent(projectSession)) {
        const selectedName = get().selectedName
        set({
          characters: remaining,
          selectedName: remaining.some(character => character.name === selectedName)
            ? selectedName
            : (remaining[0]?.name ?? null),
        })
      }
      const initialProjectDraft = getProjectEditorDraft(ledger, projectKey)
      const baseCharacters = latestProjectDraft?.baseValue
        ?? initialProjectDraft?.baseValue
        ?? characters
      let nextLedger = setProjectEditorDraft(
        latestLedger,
        projectKey,
        removeFirstCharacterNamed(baseCharacters, persistedName),
        remaining,
      )
      nextLedger = setCharacterDraftRenames(
        nextLedger,
        projectKey,
        latestRenames.filter(rename => rename !== latestPendingRename),
      )
      if (!isCharacterProjectSessionCurrent(projectSession)) return false
      persistCharacterDraftLedger(nextLedger)
      return true
    }
    set({ identityBusy: true })
    const trackedDelete = performDelete().finally(() => {
      if (characterIdentityMutationInFlight?.promise === trackedDelete) {
        characterIdentityMutationInFlight = null
        if (isCharacterProjectSessionCurrent(projectSession)) {
          set({ identityBusy: false })
        }
      }
    })
    characterIdentityMutationInFlight = { projectSession, promise: trackedDelete }
    return trackedDelete
  },

  renameCharacter: (name, newName) => {
    const projectSession = currentCharacterProjectSession()
    if (!projectSession) return false
    if (
      characterIdentityMutationInFlight
      && sameProjectSessionContext(characterIdentityMutationInFlight.projectSession, projectSession)
    ) return false
    const projectKey = projectSession.projectPath
    const state = get()
    if (
      !sameProjectSessionContext(state.dataProjectSession, projectSession)
      || state.loadingProjectSession !== null
      || state.lastError !== null
    ) return false
    const before = get().characters
    const targetIndex = before.findIndex(character => character.name === name)
    if (targetIndex < 0) return false
    if (before.some((character, index) => index !== targetIndex && character.name === newName)) {
      return false
    }

    const ledger = readCharacterDraftLedger()
    const existing = getProjectEditorDraft(ledger, projectKey)
    const renames = getCharacterDraftRenames(ledger, projectKey)
    const persistedNames = new Set((existing?.baseValue ?? before).map(character => character.name))
    const nextRenames = updateCharacterRename(renames, name, newName, persistedNames)

    const characters = before.map((character, index) => (
      index === targetIndex ? { ...character, name: newName } : character
    ))
    set({
      characters,
      selectedName: get().selectedName === name ? newName : get().selectedName,
    })

    let nextLedger = recordProjectEditorEdit(ledger, projectKey, before, characters)
    nextLedger = setCharacterDraftRenames(nextLedger, projectKey, nextRenames)
    persistCharacterDraftLedger(nextLedger)
    return true
  },

  discardDraft: (projectPath, expectedProjectSession) => {
    const ledger = readCharacterDraftLedger()
    const projectDraft = getProjectEditorDraft(ledger, projectPath)
    if (!projectDraft) return
    const projectSession = currentCharacterProjectSession(projectPath, expectedProjectSession)

    if (
      projectSession
      && (
        !sameProjectSessionContext(get().dataProjectSession, projectSession)
        || get().loadingProjectSession !== null
        || get().lastError !== null
      )
    ) {
      return
    }
    if (
      projectSession
      && sameProjectSessionContext(get().dataProjectSession, projectSession)
    ) {
      const restored = projectDraft.baseValue
      const selectedName = get().selectedName
      const renames = getCharacterDraftRenames(ledger, projectPath)
      const selectedRename = renames.find(rename => rename.newName === selectedName)
      const restoredSelection = selectedRename?.originalName ?? selectedName
      set({
        characters: restored,
        selectedName: restored.some(character => character.name === restoredSelection)
          ? restoredSelection
          : (restored[0]?.name ?? null),
      })
    }

    persistCharacterDraftLedger(discardProjectEditorDraft(ledger, projectPath))
  },

  updateField: (name, key, value) => {
    const projectSession = currentCharacterProjectSession()
    if (!projectSession) return
    const projectKey = projectSession.projectPath
    const state = get()
    if (
      !sameProjectSessionContext(state.dataProjectSession, projectSession)
      || state.lastError !== null
    ) return
    const before = get().characters
    set((s) => {
      const newChars = s.characters.map(c =>
        c.name === name ? { ...c, [key]: value } : c
      )

      return { characters: newChars }
    })
    persistCharacterDraftLedger(recordProjectEditorEdit(
      readCharacterDraftLedger(),
      projectKey,
      before,
      get().characters,
    ))
  },

  saveAll: (projectPath, expectedProjectSession) => {
    const projectSession = currentCharacterProjectSession(projectPath, expectedProjectSession)
    const projectKey = projectSession?.projectPath
    if (
      !projectSession
      || !projectKey
      || !sameProjectSessionContext(get().dataProjectSession, projectSession)
      || get().loadingProjectSession !== null
      || get().lastError !== null
    ) {
      return Promise.reject(new Error('角色数据仍在切换项目，已拒绝跨项目保存'))
    }
    if (
      characterSaveInFlight
      && sameProjectSessionContext(characterSaveInFlight.projectSession, projectSession)
    ) return characterSaveInFlight.promise
    if (
      characterIdentityMutationInFlight
      && sameProjectSessionContext(characterIdentityMutationInFlight.projectSession, projectSession)
    ) {
      return Promise.reject(new Error('角色身份操作正在进行，请稍后再保存'))
    }
    set({ saving: true, identityBusy: true })
    const { characters } = get()
    const saveLedger = readCharacterDraftLedger()
    const renames = getCharacterDraftRenames(saveLedger, projectKey)
    const savedCharacters = characters.map(character => ({
      ...character,
      name: character.name.trim(),
    }))
    const savedRenames = renames.map(rename => ({
      originalName: rename.originalName,
      newName: rename.newName.trim(),
    }))

    const save = async () => {
      // 角色主键改名、蓝图结构化引用更新和角色卡保存由主进程在单事务内完成。
      const result = await ipc.invokeWithProjectSession(
        projectSession,
        'db:character-save-all',
        savedCharacters,
        savedRenames,
        projectKey,
      )
      if (!result.success) {
        throw new Error(result.error ?? '角色卡保存失败')
      }
      if (!isCharacterProjectSessionCurrent(projectSession)) return
      const ledger = readCharacterDraftLedger()
      const currentProjectDraft = getProjectEditorDraft(ledger, projectKey)
      const projectSaveInputStillCurrent = (
        !currentProjectDraft || valuesMatch(currentProjectDraft.draftValue, characters)
      )
      const currentValue = projectSaveInputStillCurrent
        ? savedCharacters
        : currentProjectDraft.draftValue
      const currentRenames = getCharacterDraftRenames(ledger, projectKey)
      const remainingRenames = rebuildCharacterRenamesAfterSave(
        savedCharacters,
        currentValue,
        savedRenames,
        currentRenames,
      )
      let settledLedger = settleProjectEditorSave(
        ledger,
        projectKey,
        savedCharacters,
        currentValue,
      )
      settledLedger = setCharacterDraftRenames(settledLedger, projectKey, remainingRenames)
      if (!isCharacterProjectSessionCurrent(projectSession)) return
      persistCharacterDraftLedger(settledLedger)

      if (
        projectSaveInputStillCurrent
        && valuesMatch(get().characters, characters)
      ) {
        const selectedIndex = characters.findIndex(character => character.name === get().selectedName)
        set({
          characters: savedCharacters,
          selectedName: selectedIndex >= 0
            ? savedCharacters[selectedIndex].name
            : get().selectedName,
        })
      }
    }
    const trackedSave = save().finally(() => {
      if (characterSaveInFlight?.promise === trackedSave) {
        characterSaveInFlight = null
      }
      if (characterIdentityMutationInFlight?.promise === trackedSave) {
        characterIdentityMutationInFlight = null
      }
      if (isCharacterProjectSessionCurrent(projectSession)) {
        set({ saving: false, identityBusy: false })
      }
    })
    characterSaveInFlight = { projectSession, promise: trackedSave }
    characterIdentityMutationInFlight = { projectSession, promise: trackedSave }
    return trackedSave
  },
}))
