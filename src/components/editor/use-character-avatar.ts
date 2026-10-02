import { useCallback, useEffect, useRef, useState } from 'react'

import { ipc } from '../../services/ipc-client'

/**
 * 角色自定义头像的渲染层边界。
 *
 * 先生（头像逻辑）：头像只能在编辑档案时改，并且要跟角色卡**一起生效**。
 * 所以这里区分两份状态：
 *   · savedUrl  —— 已经落库的头像；
 *   · staged    —— 编辑态里刚选、还没保存的预览（或「待清除」意图）。
 * 只有角色卡保存成功那一刻才把 staged 提交给主进程；取消编辑、切换角色或
 * 组件卸载都会把它丢掉，磁盘与数据库不会留下任何痕迹。
 *
 * 主进程只回 base64 + MIME，这里立刻转成 Blob URL 并把字节丢掉（与皮肤同策）。
 */

interface StagedImage {
  base64: string
  mime: string
  url: string
}

/** 头像字节 → Blob URL。主进程只回 base64，渲染层立刻转 URL 并把字节丢掉。 */
export function base64ToObjectUrl(base64: string, mime: string): string | null {
  try {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return URL.createObjectURL(new Blob([bytes], { type: mime }))
  } catch {
    return null
  }
}

/** 释放 Blob URL；已释放过的 URL 不应制造新的阻断错误。 */
export function revokeObjectUrl(url: string | null): void {
  if (!url) return
  try {
    URL.revokeObjectURL(url)
  } catch {
    // 释放失败无需上报：最坏情况只是浏览器稍后自行回收。
  }
}

export interface CharacterAvatarState {
  /** 界面当前该显示的头像 URL：草稿预览优先，其次已保存的；null = 姓名首字。 */
  avatarUrl: string | null
  busy: boolean
  notice: string | null
  /** 编辑态中是否有尚未随档案保存的头像改动。 */
  staged: boolean
  chooseAvatar: () => Promise<void>
  /** 只标记「保存时清除」；真正的删除发生在 commitStaged。 */
  stageRemoval: () => void
  /** 由角色卡保存流程调用；返回 false 表示头像提交失败（档案本身已保存）。 */
  commitStaged: () => Promise<boolean>
  discardStaged: () => void
}

export function useCharacterAvatar(
  characterName: string | null,
  editing: boolean,
): CharacterAvatarState {
  const [savedUrl, setSavedUrl] = useState<string | null>(null)
  const [stagedImage, setStagedImage] = useState<StagedImage | null>(null)
  const [pendingRemoval, setPendingRemoval] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const savedUrlRef = useRef<string | null>(null)
  const stagedUrlRef = useRef<string | null>(null)

  const replaceSaved = useCallback((next: string | null) => {
    revokeObjectUrl(savedUrlRef.current)
    savedUrlRef.current = next
    setSavedUrl(next)
  }, [])

  const replaceStaged = useCallback((next: StagedImage | null) => {
    revokeObjectUrl(stagedUrlRef.current)
    stagedUrlRef.current = next?.url ?? null
    setStagedImage(next)
  }, [])

  // 切换角色 / 换项目：重新读取该角色已保存的头像，并丢弃上一位角色的草稿。
  useEffect(() => {
    let cancelled = false
    // 丢弃上一位角色的暂存头像不只是改状态：replaceStaged 会顺带 revoke 它的
    // Blob URL（外部资源，必须在这个 effect 的清理边界内完成），无法用派生值替代。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 换角色时清空暂存头像并释放其 Blob URL（副作用，见上）
    replaceStaged(null)
    setPendingRemoval(false)
    setNotice(null)
    void (async () => {
      if (!characterName) {
        replaceSaved(null)
        return
      }
      try {
        const response = await ipc.invoke('character-avatar:read', characterName)
        if (cancelled) return
        if (response.success && response.avatar) {
          replaceSaved(base64ToObjectUrl(response.avatar.base64, response.avatar.mime))
        } else {
          replaceSaved(null)
        }
      } catch {
        if (!cancelled) replaceSaved(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [characterName, replaceSaved, replaceStaged])

  useEffect(() => () => {
    revokeObjectUrl(savedUrlRef.current)
    revokeObjectUrl(stagedUrlRef.current)
    savedUrlRef.current = null
    stagedUrlRef.current = null
  }, [])

  const chooseAvatar = useCallback(async () => {
    if (!characterName || busy || !editing) return
    setBusy(true)
    setNotice(null)
    try {
      const response = await ipc.invoke('character-avatar:choose', characterName)
      if (!response.success) {
        setNotice(response.error.message)
        return
      }
      if (response.cancelled) return
      const url = base64ToObjectUrl(response.image.base64, response.image.mime)
      if (!url) {
        setNotice('头像预览失败，请换一张图片再试。')
        return
      }
      replaceStaged({ base64: response.image.base64, mime: response.image.mime, url })
      setPendingRemoval(false)
    } catch {
      setNotice('头像操作暂时无法完成，请稍后重试。')
    } finally {
      setBusy(false)
    }
  }, [characterName, busy, editing, replaceStaged])

  const stageRemoval = useCallback(() => {
    if (!editing) return
    replaceStaged(null)
    setPendingRemoval(true)
  }, [editing, replaceStaged])

  const discardStaged = useCallback(() => {
    replaceStaged(null)
    setPendingRemoval(false)
  }, [replaceStaged])

  const commitStaged = useCallback(async (): Promise<boolean> => {
    if (!characterName) return true
    if (!stagedImage && !pendingRemoval) return true
    setBusy(true)
    setNotice(null)
    try {
      if (stagedImage) {
        const response = await ipc.invoke('character-avatar:commit', characterName, stagedImage.base64)
        if (!response.success) {
          setNotice(response.error.message)
          return false
        }
        /**
         * 主进程回传的是**压缩后**的字节（最长边 256px，见 electron/services/avatar-image.ts），
         * 用它换掉草稿预览 —— 于是先生看到的头像与磁盘上真正存的是同一张，
         * 不会出现「预览清晰、重启后变糊」的怪相。
         * 万一压缩图解码失败（极罕见），沿用草稿 URL 把所有权转正即可。
         */
        const storedUrl = base64ToObjectUrl(response.avatar.base64, response.avatar.mime)
        const nextUrl = storedUrl ?? stagedImage.url
        revokeObjectUrl(savedUrlRef.current)
        if (storedUrl) revokeObjectUrl(stagedImage.url)
        savedUrlRef.current = nextUrl
        setSavedUrl(nextUrl)
        stagedUrlRef.current = null
        setStagedImage(null)
        setPendingRemoval(false)
        return true
      }
      const response = await ipc.invoke('character-avatar:remove', characterName)
      if (!response.success) {
        setNotice(response.error.message)
        return false
      }
      replaceSaved(null)
      setPendingRemoval(false)
      return true
    } catch {
      setNotice('头像保存失败，档案其它内容已保存。')
      return false
    } finally {
      setBusy(false)
    }
  }, [characterName, pendingRemoval, replaceSaved, stagedImage])

  return {
    avatarUrl: pendingRemoval ? null : (stagedImage?.url ?? savedUrl),
    busy,
    notice,
    staged: Boolean(stagedImage) || pendingRemoval,
    chooseAvatar,
    stageRemoval,
    commitStaged,
    discardStaged,
  }
}
