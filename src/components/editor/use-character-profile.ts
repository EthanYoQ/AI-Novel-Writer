import { useEffect, useRef, useState } from 'react'
import { useProjectStore } from '../../stores/project-store'
import { registerEditorExitSaveHandler, useEditorStore } from '../../stores/editor-store'
import { CHARACTER_DRAFT_TAB, getProjectEditorDraft, parseProjectEditorDraftLedger } from '../../stores/project-editor-draft-ledger'
import { useWorkflowStore } from '../../stores/workflow-store'
import { useCharacterStore, characterSelectionKey, type CharacterCard } from '../../stores/character-store'
import { useLocaleStore } from '../../stores/locale-store'
import { formatRelationshipsForEditor } from '../../shared/relationship-presentation'
import { captureProjectSession, isProjectSessionCurrent, isProjectSessionPath } from '../project-session-gate'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { SaveOutcome } from './save-feedback'
import { displayedErrorMessage, englishWithReason } from '../../i18n/app-errors'

/**
 * 角色档案的数据与操作：当前选中的角色、保存（含退出时保存）、删除一位、删除全部、改字段与改名。
 * 确认由调用方负责（角色档案页用危险确认对话框）。调用方在弹出确认前用 beginDelete 冻结项目会话，
 * 确认期间换了项目时删除不会落到新项目上。
 */
export function useCharacterProfile(projectKey: string) {
  const currentProject = useProjectStore(s => s.currentProject)
  const addLog = useWorkflowStore(s => s.addLog)
  const characters = useCharacterStore(s => s.characters)
  const dataProjectKey = useCharacterStore(s => s.dataProjectKey)
  const loadingProjectKey = useCharacterStore(s => s.loadingProjectKey)
  const lastError = useCharacterStore(s => s.lastError)
  const selectedId = useCharacterStore(s => s.selectedId)
  const saving = useCharacterStore(s => s.saving)
  const dirty = useEditorStore(state => state.tabs.some(
    tab => tab.type === 'character' && tab.projectKey === projectKey && tab.dirty,
  ) || Boolean(getProjectEditorDraft(
    parseProjectEditorDraftLedger(state.draftLedgers[CHARACTER_DRAFT_TAB.id]), projectKey,
  )))
  const [saveOutcome, setSaveOutcome] = useState<SaveOutcome>('idle')
  const [saveError, setSaveError] = useState('')
  const identityBusy = useCharacterStore(s => s.identityBusy)
  const renameCharacter = useCharacterStore(s => s.renameCharacter)
  const updateField = useCharacterStore(s => s.updateField)
  const deleteCharacter = useCharacterStore(s => s.deleteCharacter)
  const clearAllCharacters = useCharacterStore(s => s.clearAllCharacters)
  const saveAll = useCharacterStore(s => s.saveAll)
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const projectMatches = currentProject?.path === projectKey
  const dataReady = Boolean(
    projectMatches
    && dataProjectKey === projectKey
    && loadingProjectKey === null
    && lastError === null,
  )

  const selectedCard = dataReady
    ? characters.find((c, index) => characterSelectionKey(c, index) === selectedId) || null
    : null
  const relationshipEditorText = selectedCard
    ? formatRelationshipsForEditor(selectedCard.relationships, { locale, identities: characters })
    : ''

  /** 删除前冻结项目会话；没有可删的角色或项目不匹配时为 null。 */
  const beginDelete = (scope: 'selected' | 'all') => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) return null
    if (scope === 'selected') return selectedCard && projectMatches ? projectSession : null
    return dataReady && characters.length > 0 ? projectSession : null
  }

  /** 删除选中的角色；调用前已由作者确认。 */
  const deleteSelected = async (projectSession: ProjectSessionContext) => {
    if (!isProjectSessionCurrent(projectSession)) return
    const deleted = await deleteCharacter(selectedId!, projectKey)
    if (!isProjectSessionCurrent(projectSession)) return
    if (!deleted) {
      addLog(
        'error',
        text(
          '角色删除失败：项目可能已切换，请刷新后重试',
          'Could not delete the character. The project may have changed; refresh and try again.',
        ),
      )
    }
  }

  const handleSave = async (propagateFailure = false) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    setSaveOutcome('idle')
    setSaveError('')
    try {
      await saveAll(projectKey)
      if (!isProjectSessionCurrent(projectSession)) return
      addLog('info', text(`已保存 ${characters.length} 个角色卡`, `Saved ${characters.length} character cards`))
      const stillDirty = useEditorStore.getState().tabs.some(
        tab => tab.type === 'character' && tab.projectKey === projectKey && tab.dirty,
      )
      setSaveOutcome(stillDirty ? 'idle' : 'saved')
    } catch (error) {
      if (isProjectSessionCurrent(projectSession)) {
        setSaveOutcome('failed')
        const reason = displayedErrorMessage(useLocaleStore.getState().locale, error)
        setSaveError(reason)
        addLog('error', text(`角色卡保存失败：${reason}`, englishWithReason('Could not save character cards.', reason)))
      }
      if (propagateFailure) throw error
    }
  }

  const exitSaveRef = useRef(handleSave)
  useEffect(() => {
    exitSaveRef.current = handleSave
  })
  useEffect(() => {
    registerEditorExitSaveHandler({
      type: 'character',
      projectKey,
      save: () => exitSaveRef.current(true),
    })
  }, [projectKey])

  /** 删除全部角色与关系；调用前已由作者确认。 */
  const deleteAll = async (projectSession: ProjectSessionContext) => {
    if (!isProjectSessionCurrent(projectSession)) return
    const cleared = await clearAllCharacters(projectKey, projectSession)
    if (!isProjectSessionCurrent(projectSession)) return
    addLog(
      cleared ? 'info' : 'error',
      cleared
        ? text('已删除全部角色及关系', 'Deleted all characters and relationships')
        : text('删除全部角色失败，请刷新后重试', 'Could not delete all characters. Refresh and try again.'),
    )
  }

  const updateCurrentField = <K extends Exclude<keyof CharacterCard, 'name' | 'characterId'>>(
    name: string,
    key: K,
    value: CharacterCard[K],
  ) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    setSaveOutcome('idle')
    updateField(name, key, value)
  }

  const renameCurrentCharacter = (name: string, nextName: string) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    setSaveOutcome('idle')
    renameCharacter(name, nextName)
  }

  return {
    currentProject,
    projectMatches,
    dataReady,
    characters,
    selectedId,
    selectedCard,
    relationshipEditorText,
    lastError,
    saving,
    dirty,
    identityBusy,
    saveOutcome,
    saveError,
    handleSave,
    beginDelete,
    deleteSelected,
    deleteAll,
    updateCurrentField,
    renameCurrentCharacter,
  }
}
