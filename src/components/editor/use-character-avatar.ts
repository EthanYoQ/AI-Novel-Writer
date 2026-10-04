import { useCallback, useEffect, useRef, useState } from 'react'
import type { CharacterAvatarChannels } from '../../shared/character-avatar'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { getActiveProjectSessionContext } from '../../shared/project-session-context'
import { ipc } from '../../services/ipc-client'

type AvatarInvoke = <C extends keyof CharacterAvatarChannels>(
  context: ProjectSessionContext,
  channel: C,
  ...args: CharacterAvatarChannels[C]['args']
) => Promise<CharacterAvatarChannels[C]['return']>
const invokeAvatar = ipc.invokeWithProjectSession as unknown as AvatarInvoke
export const characterAvatarChanges = new EventTarget()

interface StagedImage { base64: string; mime: string; url: string }

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
  const sessionKey = context ? `${context.projectId}\u0000${context.leaseId}\u0000${context.projectPath}` : ''
  const [savedUrl, setSavedUrl] = useState<string | null>(null)
  const [assetRevision, setAssetRevision] = useState<number | null>(null)
  const [stagedImage, setStagedImage] = useState<StagedImage | null>(null)
  const [pendingRemoval, setPendingRemoval] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const savedRef = useRef<string | null>(null), stagedRef = useRef<string | null>(null)

  const replaceSaved = useCallback((url: string | null, revision: number | null = null) => {
    revokeObjectUrl(savedRef.current); savedRef.current = url; setSavedUrl(url); setAssetRevision(revision)
  }, [])
  const replaceStaged = useCallback((image: StagedImage | null) => {
    revokeObjectUrl(stagedRef.current); stagedRef.current = image?.url ?? null; setStagedImage(image)
  }, [])

  useEffect(() => {
    let cancelled = false
    void Promise.resolve().then(async () => {
      if (cancelled) return
      replaceStaged(null); setPendingRemoval(false); setNotice(null)
      if (!context || !characterId) { replaceSaved(null); return }
      try {
        const response = await invokeAvatar(context, 'character-avatar:read-batch', [characterId])
        if (cancelled) return
        const avatar = response.success ? response.avatars.find(item => item.characterId === characterId) : undefined
        replaceSaved(avatar ? base64ToObjectUrl(avatar.base64, avatar.mime) : null, avatar?.assetRevision ?? null)
      } catch { if (!cancelled) replaceSaved(null) }
    })
    return () => { cancelled = true }
  }, [characterId, context, sessionKey, replaceSaved, replaceStaged])

  useEffect(() => () => {
    revokeObjectUrl(savedRef.current); revokeObjectUrl(stagedRef.current)
    savedRef.current = null; stagedRef.current = null
  }, [])

  const chooseAvatar = useCallback(async () => {
    if (!context || !characterId || busy || !editing) return
    setBusy(true); setNotice(null)
    try {
      const response = await invokeAvatar(context, 'character-avatar:choose', characterId)
      if (!response.success) { setNotice(response.error.message); return }
      if (response.cancelled) return
      const url = base64ToObjectUrl(response.image.base64, response.image.mime)
      if (!url) { setNotice('头像预览失败，请换一张图片再试。'); return }
      replaceStaged({ base64: response.image.base64, mime: response.image.mime, url }); setPendingRemoval(false)
    } catch { setNotice('头像操作暂时无法完成，请稍后重试。') } finally { setBusy(false) }
  }, [busy, characterId, context, editing, replaceStaged])

  const stageRemoval = useCallback(() => {
    if (!editing) return
    replaceStaged(null); setPendingRemoval(true)
  }, [editing, replaceStaged])
  const discardStaged = useCallback(() => { replaceStaged(null); setPendingRemoval(false) }, [replaceStaged])

  const commitStaged = useCallback(async (): Promise<boolean> => {
    if (!context || !characterId || (!stagedImage && !pendingRemoval)) return true
    setBusy(true); setNotice(null)
    try {
      if (stagedImage) {
        const response = await invokeAvatar(context, 'character-avatar:commit', characterId, stagedImage.base64)
        if (!response.success) { setNotice(response.error.message); return false }
        const storedUrl = base64ToObjectUrl(response.avatar.base64, response.avatar.mime)
        const nextUrl = storedUrl ?? stagedImage.url
        revokeObjectUrl(savedRef.current); if (storedUrl) revokeObjectUrl(stagedImage.url)
        savedRef.current = nextUrl; stagedRef.current = null
        setSavedUrl(nextUrl); setAssetRevision(response.avatar.assetRevision); setStagedImage(null); setPendingRemoval(false)
        characterAvatarChanges.dispatchEvent(new CustomEvent('changed', { detail: { context, characterId } }))
        return true
      }
      const response = await invokeAvatar(context, 'character-avatar:remove', characterId)
      if (!response.success) { setNotice(response.error.message); return false }
      replaceSaved(null); setPendingRemoval(false)
      characterAvatarChanges.dispatchEvent(new CustomEvent('changed', { detail: { context, characterId } }))
      return true
    } catch { setNotice('头像保存失败，档案其它内容已保存。'); return false } finally { setBusy(false) }
  }, [characterId, context, pendingRemoval, replaceSaved, stagedImage])

  return { avatarUrl: pendingRemoval ? null : stagedImage?.url ?? savedUrl, assetRevision, busy, notice,
    staged: Boolean(stagedImage) || pendingRemoval, chooseAvatar, stageRemoval, commitStaged, discardStaged }
}
