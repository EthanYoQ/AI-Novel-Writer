import { useCallback, useEffect, useRef, useState } from 'react'
import { getActiveProjectSessionContext, sameProjectSessionContext } from '../../shared/project-session-context'
import { ipc } from '../../services/ipc-client'
import { characterAvatarChanges, useCharacterStore } from '../../stores/character-store'
import { useLocaleStore } from '../../stores/locale-store'
export { characterAvatarChanges }

export function base64ToObjectUrl(base64: string, mime: string): string | null {
  try {
    const binary = atob(base64), bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return URL.createObjectURL(new Blob([bytes], { type: mime }))
  } catch { return null }
}

export function revokeObjectUrl(url: string | null): void {
  if (!url) return
  try { URL.revokeObjectURL(url) } catch { /* Browser reclaims it later. */ }
}

export interface CharacterAvatarState {
  avatarUrl: string | null
  assetRevision: number | null
  busy: boolean
  notice: string | null
  staged: boolean
  chooseAvatar(): Promise<void>
  stageRemoval(): void
  commitStaged(): Promise<boolean>
  discardStaged(): void
}

export function useCharacterAvatar(characterId: string | null, editing: boolean): CharacterAvatarState {
  const context = getActiveProjectSessionContext()
  const key = context ? `${context.projectId}\u0000${context.leaseId}\u0000${characterId}` : ''
  const currentKey = useRef(key)
  useEffect(() => { currentKey.current = key }, [key])
  const draft = useCharacterStore(state => characterId ? state.avatarDrafts[characterId] : undefined)
  const saving = useCharacterStore(state => state.saving)
  const text = useLocaleStore(state => state.text)
  const [saved, setSaved] = useState<{ key: string; url: string | null; revision: number | null } | null>(null)
  const [preview, setPreview] = useState<{ draft: typeof draft; url: string | null } | null>(null)
  const [operation, setOperation] = useState({ key, busy: false, notice: null as string | null })
  const [refresh, setRefresh] = useState(0)
  const savedRef = useRef<string | null>(null)
  const persisted = Boolean(characterId && !characterId.startsWith('draft:'))

  useEffect(() => {
    let cancelled = false
    revokeObjectUrl(savedRef.current); savedRef.current = null
    void Promise.resolve().then(async () => {
      if (cancelled) return
      setSaved(null)
      if (!context || !characterId || !persisted) return
      try {
        const response = await ipc.invokeWithProjectSession(context, 'character-avatar:read-batch', [characterId])
        if (cancelled) return
        const avatar = response.success ? response.avatars.find(item => item.characterId === characterId) : undefined
        const url = avatar ? base64ToObjectUrl(avatar.base64, avatar.mime) : null
        savedRef.current = url
        setSaved({ key, url, revision: avatar?.assetRevision ?? null })
      } catch { if (!cancelled) setSaved(null) }
    })
    return () => { cancelled = true; revokeObjectUrl(savedRef.current); savedRef.current = null }
  }, [characterId, context, key, persisted, refresh])

  useEffect(() => {
    let cancelled = false
    const url = draft?.kind === 'image' ? base64ToObjectUrl(draft.base64, draft.mime) : null
    void Promise.resolve().then(() => { if (!cancelled) setPreview({ draft, url }) })
    return () => { cancelled = true; revokeObjectUrl(url) }
  }, [draft])

  useEffect(() => {
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ context: typeof context; characterId: string }>).detail
      if (detail.characterId === characterId && sameProjectSessionContext(detail.context, context)) setRefresh(value => value + 1)
    }
    characterAvatarChanges.addEventListener('changed', changed)
    return () => characterAvatarChanges.removeEventListener('changed', changed)
  }, [characterId, context])

  const chooseAvatar = useCallback(async () => {
    if (!context || !characterId || !persisted || saving || operation.key === key && operation.busy || !editing) return
    setOperation({ key, busy: true, notice: null })
    let notice: string | null = null
    try {
      const response = await ipc.invokeWithProjectSession(context, 'character-avatar:choose', characterId)
      if (!response.success) notice = response.error.message
      else if (!response.cancelled) {
        const url = base64ToObjectUrl(response.image.base64, response.image.mime)
        if (!url) notice = text('头像预览失败，请换一张图片再试。', 'Could not preview the avatar. Choose another image.')
        else {
          revokeObjectUrl(url)
          useCharacterStore.getState().stageAvatar(characterId, { kind: 'image', base64: response.image.base64, mime: response.image.mime }, context)
        }
      }
    } catch { notice = text('头像操作暂时无法完成，请稍后重试。', 'The avatar operation could not be completed. Try again later.') }
    finally { if (currentKey.current === key) setOperation({ key, busy: false, notice }) }
  }, [characterId, context, editing, key, operation, persisted, saving, text])

  const commitStaged = useCallback(async () => {
    if (!context) return true
    try { await useCharacterStore.getState().commitAvatarDrafts(context); return true }
    catch (error) {
      if (currentKey.current === key) setOperation({ key, busy: false, notice: error instanceof Error ? error.message : String(error) })
      return false
    }
  }, [context, key])
  return {
    avatarUrl: draft?.kind === 'remove' ? null : preview?.draft === draft && preview?.url ? preview.url : saved?.key === key ? saved.url : null,
    assetRevision: saved?.key === key ? saved.revision : null,
    busy: saving || operation.key === key && operation.busy,
    notice: operation.key === key ? operation.notice : null,
    staged: Boolean(draft), chooseAvatar, commitStaged,
    stageRemoval: () => { if (editing && !saving && persisted && context && characterId) useCharacterStore.getState().stageAvatar(characterId, { kind: 'remove' }, context) },
    discardStaged: () => { if (!saving && context && characterId) useCharacterStore.getState().stageAvatar(characterId, null, context) },
  }
}
