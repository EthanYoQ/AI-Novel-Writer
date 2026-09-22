import { useEffect, useRef, useState } from 'react'
import type { CharacterAvatarChannels } from '../../shared/character-avatar'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { getActiveProjectSessionContext } from '../../shared/project-session-context'
import { ipc } from '../../services/ipc-client'
import { base64ToObjectUrl, revokeObjectUrl } from './use-character-avatar'

type BatchInvoke = (context: ProjectSessionContext, channel: 'character-avatar:read-batch', characterIds: string[]) =>
  Promise<CharacterAvatarChannels['character-avatar:read-batch']['return']>
const readBatch = ipc.invokeWithProjectSession as unknown as BatchInvoke

export interface CharacterAvatarsState {
  avatarUrls: Record<string, string>
  loading: boolean
}

export function useCharacterAvatars(characterIds: readonly string[], enabled: boolean): CharacterAvatarsState {
  const context = getActiveProjectSessionContext()
  const sessionKey = context ? `${context.projectId}\u0000${context.leaseId}\u0000${context.projectPath}` : ''
  const idsKey = enabled ? [...new Set(characterIds)].sort().join('\u0000') : ''
  const [avatarUrls, setAvatarUrls] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const urls = useRef(new Map<string, string>())

  useEffect(() => {
    for (const url of urls.current.values()) revokeObjectUrl(url)
    urls.current.clear()
    let cancelled = false
    void Promise.resolve().then(async () => {
      if (cancelled) return
      setAvatarUrls({})
      if (!context || !idsKey) { setLoading(false); return }
      setLoading(true)
      try {
        const response = await readBatch(context, 'character-avatar:read-batch', idsKey.split('\u0000'))
        if (cancelled || !response.success) return
        const next: Record<string, string> = {}
        for (const avatar of response.avatars) {
          const cacheKey = `${sessionKey}\u0000${avatar.characterId}\u0000${avatar.assetRevision}`
          const url = base64ToObjectUrl(avatar.base64, avatar.mime)
          if (!url) continue
          urls.current.set(cacheKey, url); next[avatar.characterId] = url
        }
        setAvatarUrls(next)
      } catch {
        if (!cancelled) setAvatarUrls({})
      } finally { if (!cancelled) setLoading(false) }
    })
    return () => { cancelled = true }
  }, [context, idsKey, sessionKey])

  useEffect(() => () => {
    for (const url of urls.current.values()) revokeObjectUrl(url)
    urls.current.clear()
  }, [])
  return { avatarUrls, loading }
}
