import { create } from 'zustand'

/**
 * 帮助面板（常见错误排查）的开关。
 *
 * 有意不持久化：这是一次性的查阅动作，查完就关；下次打开软件不该自己弹出来。
 */
export interface HelpState {
  open: boolean
  openHelp: () => void
  closeHelp: () => void
}

export const useHelpStore = create<HelpState>()((set) => ({
  open: false,
  openHelp: () => set({ open: true }),
  closeHelp: () => set({ open: false }),
}))
