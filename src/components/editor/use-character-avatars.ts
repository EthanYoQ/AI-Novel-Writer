import { useEffect, useRef, useState } from 'react'

import { ipc } from '../../services/ipc-client'
import { base64ToObjectUrl, revokeObjectUrl as revoke } from './use-character-avatar'

/**
 * 关系图谱要一次画出**全员**头像，而 use-character-avatar 只管当前角色一人。
 *
 * 这里复用同一个「主进程回 base64、渲染层转 Blob URL」的边界，不做任何新的
 * 主进程通道：头像读取仍然是 character-avatar:read，令牌与接口保持不变。
 *
 * 三条约束：
 *   · 头像逐张到达就刷新 —— 先出现的先画上，不必等最慢的一张；
 *   · 并发受限（4 张）—— 不给主进程的文件读造成尖峰；
 *   · 卸载 / 换项目一律 revoke，Blob 不会长期占着内存。
 */

const READ_CONCURRENCY = 4

export interface CharacterAvatarsState {
  /** 角色名 → 头像 Blob URL；没有自定义头像的角色不出现。 */
  avatarUrls: Record<string, string>
  /** 至少有一张头像还在路上。 */
  loading: boolean
}

export function useCharacterAvatars(
  names: readonly string[],
  enabled: boolean,
): CharacterAvatarsState {
  const [avatarUrls, setAvatarUrls] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  // names 每次渲染都是新数组，用内容作依赖键，避免无谓的重读。
  const rosterKey = enabled ? names.join('\u0000') : ''

  /**
   * names 走 ref 传递，effect 只依赖内容键 rosterKey。
   *
   * 注意 ref 的赋值放在 effect 里而不是 render 期：render 期写 ref 在并发渲染 /
   * StrictMode 双调用下可能写入被丢弃的那一次渲染的值。这个 effect 声明在主 effect
   * 之前，因此每次提交都会先同步到最新值。
   */
  const namesRef = useRef(names)
  useEffect(() => {
    namesRef.current = names
  })

  /** 上一轮的内容键：用于判断「内容真的换了」才清空旧头像，避免每次加载都闪一下。 */
  const previousKeyRef = useRef(rosterKey)

  useEffect(() => {
    // 内容换了才先清空：旧 key 的头像 URL 可能已被 revoke，
    // 留着会让图谱短暂显示错人的头像。
    if (previousKeyRef.current !== rosterKey) {
      previousKeyRef.current = rosterKey
      setAvatarUrls({})
      setLoading(false)
    }

    if (!rosterKey) {
      return
    }

    let cancelled = false
    const created: string[] = []
    const targets = [...namesRef.current]
    // loading 描述的是「这一轮 rosterKey 对应的 IPC 读取任务还在进行中」，只能由
    // 任务的起止来标记（结束点在下面的异步收尾里），无法从已加载的头像表派生出来。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 标记本轮外部读取任务已开始（见上）
    setLoading(true)

    const readOne = async (name: string, sink: Record<string, string>): Promise<void> => {
      try {
        const response = await ipc.invoke('character-avatar:read', name)
        if (cancelled) return
        if (!response.success || !response.avatar) return
        const url = base64ToObjectUrl(response.avatar.base64, response.avatar.mime)
        if (!url) return
        created.push(url)
        sink[name] = url
        setAvatarUrls({ ...sink })
      } catch {
        // 单张失败按「无自定义头像」处理，回落到姓名首字，不打断整个图谱。
      }
    }

    void (async () => {
      const sink: Record<string, string> = {}
      let cursor = 0
      const worker = async (): Promise<void> => {
        while (!cancelled) {
          const index = cursor
          cursor += 1
          if (index >= targets.length) return
          await readOne(targets[index], sink)
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(READ_CONCURRENCY, targets.length) }, worker),
      )
      // worker 的 while 有明确出口（cancelled 或游标越界），不会无终止循环。
      if (!cancelled) setLoading(false)
    })()

    return () => {
      // 清理函数只做「取消 + 释放资源」，**不再 setState**：
      // 它在真卸载时也会执行，此时 setState 会触发
      // "Can't perform a React state update on an unmounted component"。
      // 重置状态的职责已上移到本 effect 开头的 key 比较。
      cancelled = true
      for (const url of created) revoke(url)
    }
  }, [rosterKey])

  return { avatarUrls, loading }
}
