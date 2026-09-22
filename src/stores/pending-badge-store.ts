/**
 * 「有新东西等着确认」的未读水位 —— 待确认 / 候选 / 待选箱入口上那颗小红点。
 *
 * 先生 2026-09-21：
 *   「有新的待确认的角色，候选，设定等内容的时候，可以在待确认、候选、待选等地方
 *     做个小红点？类似未读消息？让用户一看就知道这里有东西等着确认那种？」
 *
 * ── 口径：未读 = 这一条我还没见过 ──────────────────────────────────────────
 * 每个队列记一份「上次打开它时，队列里都有哪些 id」的快照：
 *   · 队列里出现了快照之外的 id → 亮红点；
 *   · 作者打开那个弹窗 → 快照刷新成当前的 id 集合 → 红点灭；
 *   · 处理掉几条（采纳 / 忽略）→ 它们从队列消失，快照里留着也无害。
 *
 * 为什么用 **id 快照** 而不是「上次查看时间」：
 *   时间戳要求三个表的时间格式、时区、本地时钟全都对得上（库里存的是
 *   `datetime('now')` 的 UTC 串），任何一处漂移都会让红点该亮不亮、该灭不灭。
 *   id 是各自表里的自增主键，比时间硬得多，也不怕时钟。
 *
 * ── 为什么不进项目库 ────────────────────────────────────────────────────────
 * 「我读过没有」是纯界面状态：它不该产生一次项目写入、不该进定稿链路、
 * 更不该在换项目时串味。所以它落在 localStorage，并按**项目路径**分组 ——
 * 换一本书就是另一套红点。
 *
 * ⚠️ 红点只在**真的没见过**时亮，绝不做成「有待确认就一直亮」：
 *   那等于把「有新消息」和「有消息」混为一谈，作者很快就不看它了。
 */
import { useCallback, useMemo } from 'react'
import { create } from 'zustand'

export const PENDING_BADGE_STORAGE_KEY = 'ai-novel-writer-pending-badges'

/**
 * 会亮红点的队列。四个入口各占一格：
 *   · character-candidates —— 角色栏的「待确认」（正文里冒出来的新角色）
 *   · world-setting-pending —— 设定集侧栏的「待确认」（AI 归纳 / 正文选词标记的候选）
 *   · setting-conflicts —— 设定集侧栏的「待裁决冲突」
 *   · sticky-tray —— 便利贴的「待选箱」（抽卡落选的点子）
 *
 * 加新队列时**只在这里加一个 key**，其余（持久化、hook、红点）自动跟上。
 */
export const PENDING_QUEUES = [
  'character-candidates',
  'world-setting-pending',
  'setting-conflicts',
  'sticky-tray',
] as const

export type PendingQueue = typeof PENDING_QUEUES[number]

/** 存储键：项目路径与队列名拼在一起，换项目天然是另一套红点。 */
export function pendingBadgeKey(projectKey: string, queue: PendingQueue): string {
  return `${projectKey}::${queue}`
}

export type PendingBadgeSeen = Record<string, string[]>

interface PendingBadgeState {
  /** key（见 pendingBadgeKey）→ 上次打开时队列里的 id。 */
  seen: PendingBadgeSeen
  /** 打开队列的那一刻记一笔：把快照换成现在的 id 集合（覆盖，不累加）。 */
  markSeen: (projectKey: string, queue: PendingQueue, ids: readonly string[]) => void
  /** 项目被移除时顺手清掉它的水位，免得 localStorage 里越积越多。 */
  forgetProject: (projectKey: string) => void
  reset: () => void
}

/**
 * 读取本地水位。localStorage 不可用（隐私模式、损坏数据）时一律当空 ——
 * 最坏的结果是「红点多亮一次」，绝不因为读取失败让界面白屏。
 */
export function readStoredPendingBadges(storage?: Pick<Storage, 'getItem'>): PendingBadgeSeen {
  try {
    const store = storage ?? (typeof localStorage === 'undefined' ? null : localStorage)
    if (!store) return {}
    const raw = store.getItem(PENDING_BADGE_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    // 兼容 zustand persist 的 {state:{seen}} 外形，也认裸对象
    const candidate = (parsed as { state?: { seen?: unknown } })?.state?.seen ?? parsed
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return {}
    const seen: PendingBadgeSeen = {}
    for (const [key, value] of Object.entries(candidate as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue
      const ids = value.filter((id): id is string => typeof id === 'string' && id !== '')
      if (ids.length > 0) seen[key] = ids
    }
    return seen
  } catch {
    // 读坏了一律按「什么都没读过」处理
    return {}
  }
}

function persistPendingBadges(seen: PendingBadgeSeen): void {
  try {
    localStorage?.setItem(PENDING_BADGE_STORAGE_KEY, JSON.stringify(seen))
  } catch {
    // 无法持久化时仍允许本次会话内正常消点
  }
}

/** 工厂式写法：与 ui-version-store 一致，便于测试注入初始值。 */
export function createPendingBadgeStore(initial: PendingBadgeSeen = readStoredPendingBadges()) {
  return create<PendingBadgeState>()((set, get) => ({
    seen: initial,

    markSeen: (projectKey, queue, ids) => {
      if (!projectKey || ids.length === 0) return
      const key = pendingBadgeKey(projectKey, queue)
      const current = get().seen[key]
      // 内容没变就不写盘：侧栏在滚动、重渲染时都会走到这里，白写只会添 I/O。
      if (current && current.length === ids.length && current.every((id, index) => id === ids[index])) return
      const next: PendingBadgeSeen = { ...get().seen, [key]: [...ids] }
      persistPendingBadges(next)
      set({ seen: next })
    },

    forgetProject: (projectKey) => {
      if (!projectKey) return
      const prefix = `${projectKey}::`
      const next: PendingBadgeSeen = {}
      let changed = false
      for (const [key, value] of Object.entries(get().seen)) {
        if (key.startsWith(prefix)) { changed = true; continue }
        next[key] = value
      }
      if (!changed) return
      persistPendingBadges(next)
      set({ seen: next })
    },

    reset: () => {
      persistPendingBadges({})
      set({ seen: {} })
    },
  }))
}

export const usePendingBadgeStore = createPendingBadgeStore()

/**
 * 某个队列此刻要不要亮红点，以及「打开它」时该调的那个记号函数。
 *
 * `ids` 传当前队列里全部条目的 id（顺序无所谓）。内部按内容比较，
 * 所以调用方**不需要**先把 ids 包成 useMemo —— 每次渲染传新数组也不会让红点抖动。
 */
export function usePendingUnread(
  projectKey: string | null | undefined,
  queue: PendingQueue,
  ids: readonly string[],
): { unread: boolean; markSeen: () => void } {
  const storageKey = projectKey ? pendingBadgeKey(projectKey, queue) : null
  const seen = usePendingBadgeStore(state => (storageKey ? state.seen[storageKey] : undefined))
  const remember = usePendingBadgeStore(state => state.markSeen)

  // 用内容当依赖，而不是数组引用 —— 否则父组件每渲染一次就重算一次。
  const idKey = ids.join('\u0000')

  const unread = useMemo(() => {
    if (!storageKey || ids.length === 0) return false
    // 从来没打开过这个队列：里面有东西就是「没见过」，红点该亮。
    if (!seen || seen.length === 0) return true
    const known = new Set(seen)
    return ids.some(id => !known.has(id))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- idKey 就是 ids 的内容指纹
  }, [storageKey, idKey, seen])

  const markSeen = useCallback(() => {
    if (!projectKey) return
    remember(projectKey, queue, ids)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 同上，按内容指纹绑定
  }, [projectKey, queue, idKey, remember])

  return { unread, markSeen }
}
