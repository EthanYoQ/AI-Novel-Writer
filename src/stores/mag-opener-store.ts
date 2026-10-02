/**
 * 栏目扫线状态 —— v3「时尚杂志」专属。
 *
 * ── 它现在管什么 ────────────────────────────────────────────────────────────
 * 只管切栏目那**一道 300ms 的扫线**。栏目身份（底色 / 巨号水印 / 左缘色带）
 * 是**常驻背景**，由 ShellV2 挂在编辑区上的 `data-sec` / `data-sec-no` 驱动，
 * 不经过这里 —— 所以「切栏目」绝大多数视觉是属性变化 + CSS 过渡，
 * 没有一整幅需要重建的 DOM。先生 2026-09-16：「动画太慢，会让用户觉得卡顿」，
 * 这一版就是照那句话收的。
 *
 * ── 为什么需要一份状态，而不是让组件自己监听 activeRailItem ────────────────
 * 「栏目变了」与「用户切了栏目」不是一回事：
 *   · 打开作品时 EditorArea 会把栏目同步到「目录」—— 那是自动的，不扫
 *   · 点标签页也会同步栏目 —— 那是在栏内换页，更不扫
 *   · 只有书脊上那一次点击（rail-routing 的 goRail）才是「翻到新一栏」
 * 所以触发点放在 goRail —— 用**动作**触发，而不是用**状态变化**触发。
 *
 * ── token 的作用 ────────────────────────────────────────────────────────────
 * 连点两栏时，第二次触发必须能覆盖第一次的扫线（而不是被第一次的定时器提前关掉）。
 * 每次触发把 token +1，React 用它当 key 强制重挂载组件、重播动画；
 * 关闭时必须带上自己那一次的 token，过期的定时器自然失效。
 */
import { create } from 'zustand'
import type { SectionKey } from '../shared/section-opener'

export interface SectionOpening {
  key: SectionKey
  /** 第几次触发，从 1 开始；用于强制重挂载与安全关闭 */
  token: number
}

export interface MagOpenerState {
  /** 当前正在播的过场；null = 没有过场 */
  opening: SectionOpening | null
  /** 触发一次栏目开篇页 */
  open: (key: SectionKey) => void
  /** 关闭过场；只关掉 token 相符的那一次（过期定时器不得关掉新的过场） */
  close: (token: number) => void
}

export function createMagOpenerStore() {
  return create<MagOpenerState>()((set, get) => ({
    opening: null,

    open: (key) => {
      const token = (get().opening?.token ?? 0) + 1
      set({ opening: { key, token } })
    },

    close: (token) => {
      if (get().opening?.token !== token) return
      set({ opening: null })
    },
  }))
}

export const useMagOpenerStore = createMagOpenerStore()
