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
import { normalizeCharacterRole } from '../shared/character-role'
import {
  characterCardFromRosterEntry,
  characterRosterEntriesFromCards,
} from '../services/character-roster-client'
import { randomUUID } from '../utils/id'
import { useEditorStore } from './editor-store'
import { useProjectStore } from './project-store'
import {
  CHARACTER_DRAFT_TAB,
  discardProjectEditorDraft,
  getProjectEditorDraft,
  parseProjectEditorDraftLedger,
  persistProjectEditorDraftLedger,
  rebaseProjectEditorDraft,
  recordProjectEditorEdit,
  settleProjectEditorSave,
} from './project-editor-draft-ledger'
import {
  getCharacterDraftRenames,
  mergeCharacterDraftWithRemote,
  setCharacterDraftRenames,
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

function textField(record: Record<string, unknown>, key: string): string {
  return typeof record[key] === 'string' ? record[key] : ''
}

function normalizeCharacterState(value: unknown): CharacterCurrentState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const state = value as Record<string, unknown>
  const provenance = state.provenance && typeof state.provenance === 'object' && !Array.isArray(state.provenance)
    ? state.provenance as CharacterCurrentState['provenance']
    : undefined
  return {
    location: textField(state, 'location'),
    powerLevel: textField(state, 'powerLevel'),
    physicalState: textField(state, 'physicalState'),
    mentalState: textField(state, 'mentalState'),
    keyItems: textField(state, 'keyItems'),
    recentEvents: textField(state, 'recentEvents'),
    updatedAtChapter: Number.isInteger(state.updatedAtChapter) && Number(state.updatedAtChapter) >= 0
      ? Number(state.updatedAtChapter)
      : 0,
    ...(provenance ? { provenance } : {}),
  }
}

function readCharacterDraftLedger(projectKey: string) {
  const ledger = parseProjectEditorDraftLedger<unknown>(
    useEditorStore.getState().draftLedgers[CHARACTER_DRAFT_TAB.id],
  )
  return {
    version: 1 as const,
    projects: ledger.projects.map(project => (
      project.projectKey === projectKey
        ? {
            ...project,
            baseValue: normalizeCharacterCards(project.baseValue),
            draftValue: normalizeCharacterCards(project.draftValue),
          }
        : project
    )),
    // The ledger is heterogeneous on disk. Only the requested project is ever
    // read through the typed editor helpers; foreign payloads stay opaque and
    // are carried through byte-for-byte at the value level.
  } as ReturnType<typeof parseProjectEditorDraftLedger<CharacterCard[]>>
}

function normalizeCharacterCards(value: unknown): CharacterCard[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    if (
      !candidate
      || typeof candidate !== 'object'
      || typeof (candidate as { name?: unknown }).name !== 'string'
    ) return []
    const card = candidate as Record<string, unknown>
    const currentState = normalizeCharacterState(card.currentState)
    const normalizedCard = {
      ...card,
      name: card.name as string,
      role: normalizeCharacterRole(card.role),
      gender: textField(card, 'gender'),
      age: textField(card, 'age'),
      appearance: textField(card, 'appearance'),
      personality: textField(card, 'personality'),
      background: textField(card, 'background'),
      abilities: textField(card, 'abilities'),
      motivation: textField(card, 'motivation'),
      relationships: textField(card, 'relationships'),
      arc: textField(card, 'arc'),
      notes: textField(card, 'notes'),
    } as CharacterCard
    if (currentState) normalizedCard.currentState = currentState
    else delete normalizedCard.currentState
    return [normalizedCard]
  })
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

function removeCharacterById(
  characters: readonly CharacterCard[],
  name: string,
): CharacterCard[] {
  const targetIndex = characters.findIndex(character => character.characterId === name)
  return targetIndex < 0
    ? [...characters]
    : characters.filter((_, index) => index !== targetIndex)
}

interface SessionOperation<T> {
  projectSession: ProjectSessionContext
  promise: Promise<T>
  kind: 'save' | 'rename' | 'delete'
}

let characterSaveInFlight: SessionOperation<void> | null = null
let characterIdentityMutationInFlight: SessionOperation<unknown> | null = null
let characterLoadSequence = 0

interface CharacterState {
  characters: CharacterCard[]
  selectedId: string | null
  /** Display-only compatibility; writes always receive characterId. */
  selectedName: string | null
  saving: boolean
  identityBusy: boolean
  loaded: boolean
  /** 当前 characters 数组实际归属的项目；为空时禁止任何角色写操作。 */
  dataProjectKey: string | null
  /** Exact lease whose character data is currently mounted. */
  dataProjectSession: ProjectSessionContext | null
  /** 当前角色卡来自的 roster revision；所有保存都必须带回这一乐观并发令牌。 */
  rosterRevision: number | null
  identityRevision: number | null
  loadingProjectKey: string | null
  loadingProjectSession: ProjectSessionContext | null
  lastError: string | null

  load: (projectPath?: string, expectedProjectSession?: ProjectSessionContext) => Promise<void>
  beginProjectLoad: (projectPath: string) => void
  reset: () => void
  setSelectedId: (id: string | null) => void
  setSelectedName: (name: string | null) => void
  addCharacter: () => void
  deleteCharacter: (
    name: string,
    projectPath?: string,
    expectedProjectSession?: ProjectSessionContext,
  ) => Promise<boolean>
  clearAllCharacters: (
    projectPath?: string,
    expectedProjectSession?: ProjectSessionContext,
  ) => Promise<boolean>
  renameCharacter: (name: string, newName: string) => boolean
  discardDraft: (projectPath: string, expectedProjectSession?: ProjectSessionContext) => void
  updateField: <K extends Exclude<keyof CharacterCard, 'name' | 'characterId'>>(
    name: string,
    key: K,
    value: CharacterCard[K],
  ) => void
  saveAll: (
    projectPath?: string,
    expectedProjectSession?: ProjectSessionContext,
    operationKind?: 'delete',
  ) => Promise<void>

  // 兼容旧接口
  loadCharacters: (projectPath: string, expectedProjectSession?: ProjectSessionContext) => Promise<void>
}

export const useCharacterStore = create<CharacterState>()((set, get) => ({
  characters: [],
  selectedId: null, selectedName: null,
  saving: false,
  identityBusy: false,
  loaded: false,
  dataProjectKey: null,
  dataProjectSession: null,
  rosterRevision: null, identityRevision: null,
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
        selectedId: null, selectedName: null,
        loaded: false,
        dataProjectKey: null,
        dataProjectSession: null,
        rosterRevision: null, identityRevision: null,
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
      const roster = await ipc.invokeWithProjectSession(
        projectSession,
        'db:character-roster-read',
        requestedProjectKey,
      )
      if (
        !isCharacterProjectSessionCurrent(projectSession)
        || requestSequence !== characterLoadSequence
      ) return

      const draftLedger = readCharacterDraftLedger(requestedProjectKey)
      const cards = normalizeCharacterCards(roster.entries.map(characterCardFromRosterEntry))
      const renames = requestedProjectKey
        ? getCharacterDraftRenames(draftLedger, requestedProjectKey)
        : []
      const restored = requestedProjectKey
        ? rebaseProjectEditorDraft(
            draftLedger,
            requestedProjectKey,
            cards,
            (base, draft, remote) => (
              mergeCharacterDraftWithRemote(base, draft, remote, renames)
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
      const visibleCards = normalizeCharacterCards(restored.value)

      const { selectedId } = get()
      set({
        characters: visibleCards,
        loaded: true,
        dataProjectKey: requestedProjectKey,
        dataProjectSession: projectSession,
        rosterRevision: roster.revision,
        identityRevision: roster.identityRevision ?? null,
        loadingProjectKey: null,
        loadingProjectSession: null,
        lastError: null,
        selectedId: visibleCards.find(c => c.characterId === selectedId)?.characterId ?? visibleCards[0]?.characterId ?? null,
        selectedName: visibleCards.find(c => c.characterId === selectedId)?.name ?? visibleCards[0]?.name ?? null,
      })
    } catch (error) {
      if (
        !isCharacterProjectSessionCurrent(projectSession)
        || requestSequence !== characterLoadSequence
      ) return
      set({
        characters: [],
        selectedId: null, selectedName: null,
        loaded: false,
        dataProjectKey: requestedProjectKey,
        dataProjectSession: projectSession,
        rosterRevision: null, identityRevision: null,
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
      selectedId: null, selectedName: null,
      saving: false,
      identityBusy: false,
      loaded: false,
      dataProjectKey: null,
      dataProjectSession: null,
      rosterRevision: null, identityRevision: null,
      loadingProjectKey: projectPath,
      loadingProjectSession: null,
      lastError: null,
    })
  },

  reset: () => {
    characterLoadSequence += 1
    set({
      characters: [],
      selectedId: null, selectedName: null,
      saving: false,
      identityBusy: false,
      loaded: false,
      dataProjectKey: null,
      dataProjectSession: null,
      rosterRevision: null, identityRevision: null,
      loadingProjectKey: null,
      loadingProjectSession: null,
      lastError: null,
    })
  },

  setSelectedId: (id) => {
    const projectSession = currentCharacterProjectSession()
    const state = get()
    if (
      !projectSession
      || !sameProjectSessionContext(state.dataProjectSession, projectSession)
      || state.loadingProjectSession !== null
      || state.lastError !== null
    ) return
    const card = state.characters.find(c => c.characterId === id)
    set({ selectedId: card?.characterId ?? null, selectedName: card?.name ?? null })
  },

  setSelectedName: name => {
    const matches = get().characters.filter(c => c.name === name)
    if (matches.length === 1 && matches[0].characterId) get().setSelectedId(matches[0].characterId)
    else get().setSelectedId(null)
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
      characterId: `draft:${randomUUID()}`,
      name: `新角色_${Math.random().toString(36).slice(2, 6)}`,
    }
    set((s) => ({
      characters: [...s.characters, newCard],
      selectedId: newCard.characterId!, selectedName: newCard.name,
    }))
    persistCharacterDraftLedger(recordProjectEditorEdit(
      readCharacterDraftLedger(projectKey),
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
    if (!characters.some(card => card.characterId === name)) return Promise.resolve(false)
    const ledger = readCharacterDraftLedger(projectKey)
    const renames = getCharacterDraftRenames(ledger, projectKey)
    const remaining = removeCharacterById(characters, name)
    const nextRenames = renames // Historical metadata is preserved, never used as identity.
    set({
      characters: remaining,
      selectedId: remaining.find(c => c.characterId === get().selectedId)?.characterId ?? remaining[0]?.characterId ?? null,
      selectedName: remaining.find(c => c.characterId === get().selectedId)?.name ?? remaining[0]?.name ?? null,
    })
    let nextLedger = recordProjectEditorEdit(ledger, projectKey, characters, remaining)
    nextLedger = setCharacterDraftRenames(nextLedger, projectKey, nextRenames)
    persistCharacterDraftLedger(nextLedger)

    // 删除同样是完整手工名单保存：由 roster seam 在一次事务中清理关系、
    // 蓝图引用、投影、revision 与 receipt。失败时草稿仍在本地可重试。
    return get().saveAll(projectKey, projectSession, 'delete')
      .then(() => isCharacterProjectSessionCurrent(projectSession))
      .catch(() => false)
  },

  clearAllCharacters: (projectPath, expectedProjectSession) => {
    const projectSession = currentCharacterProjectSession(projectPath, expectedProjectSession)
    if (!projectSession) return Promise.resolve(false)
    if (
      characterIdentityMutationInFlight
      && sameProjectSessionContext(characterIdentityMutationInFlight.projectSession, projectSession)
    ) return Promise.resolve(false)
    const projectKey = projectSession.projectPath
    const state = get()
    if (
      !sameProjectSessionContext(state.dataProjectSession, projectSession)
      || state.loadingProjectSession !== null
      || state.lastError !== null
    ) return Promise.resolve(false)
    const characters = state.characters
    if (characters.length === 0) return Promise.resolve(true)

    const ledger = readCharacterDraftLedger(projectKey)
    set({ characters: [], selectedName: null })
    let nextLedger = recordProjectEditorEdit(ledger, projectKey, characters, [])
    nextLedger = setCharacterDraftRenames(nextLedger, projectKey, [])
    persistCharacterDraftLedger(nextLedger)

    // 空名单仍通过既有 roster 原子提交；主进程据此同步删除角色、关系和投影。
    return get().saveAll(projectKey, projectSession, 'delete')
      .then(() => isCharacterProjectSessionCurrent(projectSession))
      .catch(() => false)
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
    const targetIndex = before.findIndex(character => character.characterId === name)
    if (targetIndex < 0) return false

    const ledger = readCharacterDraftLedger(projectKey)
    const nextRenames = getCharacterDraftRenames(ledger, projectKey)

    const characters = before.map((character, index) => (
      index === targetIndex ? { ...character, name: newName } : character
    ))
    set({
      characters,
      selectedName: get().selectedId === name ? newName : get().selectedName,
    })

    let nextLedger = recordProjectEditorEdit(ledger, projectKey, before, characters)
    nextLedger = setCharacterDraftRenames(nextLedger, projectKey, nextRenames)
    persistCharacterDraftLedger(nextLedger)
    return true
  },

  discardDraft: (projectPath, expectedProjectSession) => {
    const ledger = readCharacterDraftLedger(projectPath)
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
      const selected = restored.find(c => c.characterId === get().selectedId) ?? restored[0]
      set({ characters: restored, selectedId: selected?.characterId ?? null, selectedName: selected?.name ?? null })
    }

    persistCharacterDraftLedger(discardProjectEditorDraft(ledger, projectPath))
  },

  updateField: (name, key, value) => {
    if ((key as string) === 'characterId') return
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
        c.characterId === name ? { ...c, [key]: value } : c
      )

      return { characters: newChars }
    })
    persistCharacterDraftLedger(recordProjectEditorEdit(
      readCharacterDraftLedger(projectKey),
      projectKey,
      before,
      get().characters,
    ))
  },

  saveAll: (projectPath, expectedProjectSession, operationKind) => {
    const projectSession = currentCharacterProjectSession(projectPath, expectedProjectSession)
    const projectKey = projectSession?.projectPath
    if (
      !projectSession
      || !projectKey
      || !sameProjectSessionContext(get().dataProjectSession, projectSession)
      || get().loadingProjectSession !== null
      || get().lastError !== null
      || get().rosterRevision === null
    ) {
      return Promise.reject(new Error('角色数据仍在切换项目，已拒绝跨项目保存'))
    }
    if (
      characterSaveInFlight
      && sameProjectSessionContext(characterSaveInFlight.projectSession, projectSession)
    ) {
      if (characterSaveInFlight.kind === 'delete') {
        return Promise.reject(new Error('角色身份操作正在进行（删除中），请等待完成后再保存'))
      }
      return characterSaveInFlight.promise
    }
    if (
      characterIdentityMutationInFlight
      && sameProjectSessionContext(characterIdentityMutationInFlight.projectSession, projectSession)
    ) {
      return Promise.reject(new Error('角色身份操作正在进行，请稍后再保存'))
    }
    set({ saving: true, identityBusy: true })
    const { characters } = get()
    const expectedRevision = get().rosterRevision
    const expectedIdentityRevision = get().identityRevision
    if (expectedRevision === null) {
      return Promise.reject(new Error('角色名单尚未完成安全读取，已拒绝保存'))
    }
    if (characters.some(c => !c.characterId) || new Set(characters.map(c => c.characterId)).size !== characters.length) return Promise.reject(new Error('角色身份尚未确认；旧草稿已保留，不按名字自动绑定。'))
    const saveLedger = readCharacterDraftLedger(projectKey)
    const renames = getCharacterDraftRenames(saveLedger, projectKey)
    const savedCharacters = characters.map(character => ({
      ...character,
      name: character.name.trim(),
    }))
    const savedRenames = renames.map(rename => ({
      originalName: rename.originalName,
      newName: rename.newName.trim(),
    }))
    const saveKind: SessionOperation<void>['kind'] = operationKind
      ?? (savedRenames.length > 0 ? 'rename' : 'save')

    const save = async () => {
      // 角色主键改名、删除、蓝图结构化引用、角色图谱、revision 和 receipt
      // 都由主进程 roster seam 在同一事务内完成。
      const payload = {
        expectedRevision, expectedIdentityRevision: expectedIdentityRevision ?? undefined,
        schemaVersion: 1 as const, intent: 'manual_edit' as const,
        entries: characterRosterEntriesFromCards(savedCharacters),
      }
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ projectSession, payload })))
      const operationId = `manual-character-save-${Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')}`
      if (!isCharacterProjectSessionCurrent(projectSession)) return
      const result = await ipc.invokeWithProjectSession(projectSession, 'db:character-roster-commit', { ...payload, operationId }, projectKey)
      if (!result.success || !result.receipt) {
        throw new Error(result.error ?? '角色卡保存失败')
      }
      if (!isCharacterProjectSessionCurrent(projectSession)) return
      const savedRosterCards = result.receipt.snapshot.entries.map(characterCardFromRosterEntry)
      const ledger = readCharacterDraftLedger(projectKey)
      const currentProjectDraft = getProjectEditorDraft(ledger, projectKey)
      const projectSaveInputStillCurrent = (
        !currentProjectDraft || valuesMatch(currentProjectDraft.draftValue, characters)
      )
      const createdIds = new Map((result.receipt.created ?? []).map(item => [item.selectionKey, item.characterId]))
      const remapCreated = (card: CharacterCard): CharacterCard => {
        let relationships = card.relationships
        try {
          const parsed: unknown = JSON.parse(relationships)
          if (Array.isArray(parsed)) relationships = JSON.stringify(parsed.map(value => value && typeof value === 'object'
            ? { ...value, ...(typeof value.targetCharacterId === 'string' ? { targetCharacterId: createdIds.get(value.targetCharacterId) ?? value.targetCharacterId } : {}) } : value))
        } catch { /* Free-form author notes remain unchanged. */ }
        return { ...card, characterId: createdIds.get(card.characterId ?? '') ?? card.characterId, relationships }
      }
      const currentValue = projectSaveInputStillCurrent
        ? savedRosterCards
        : currentProjectDraft.draftValue.map(remapCreated)
      const remainingRenames: never[] = []
      let settledLedger = settleProjectEditorSave(
        ledger,
        projectKey,
        savedRosterCards,
        currentValue,
      )
      settledLedger = setCharacterDraftRenames(settledLedger, projectKey, remainingRenames)
      if (!isCharacterProjectSessionCurrent(projectSession)) return
      persistCharacterDraftLedger(settledLedger)

      if (
        projectSaveInputStillCurrent
        && valuesMatch(get().characters, characters)
      ) {
        const previousId = get().selectedId
        const selectedId = result.receipt.created?.find(item => item.selectionKey === previousId)?.characterId ?? previousId
        const selectedIndex = savedRosterCards.findIndex(character => character.characterId === selectedId)
        set({
          characters: savedRosterCards,
          selectedId, identityRevision: result.receipt.snapshot.identityRevision ?? null,
          rosterRevision: result.receipt.revision,
          selectedName: selectedIndex >= 0
            ? savedRosterCards[selectedIndex].name
            : get().selectedName,
        })
      } else if (isCharacterProjectSessionCurrent(projectSession)) {
        set({ characters: currentValue, selectedId: createdIds.get(get().selectedId ?? '') ?? get().selectedId, rosterRevision: result.receipt.revision, identityRevision: result.receipt.snapshot.identityRevision ?? null })
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
    characterSaveInFlight = { projectSession, promise: trackedSave, kind: saveKind }
    characterIdentityMutationInFlight = { projectSession, promise: trackedSave, kind: saveKind }
    return trackedSave
  },
}))
