import { create } from 'zustand'

/**
 * 新手引导（Quick Start）状态。
 *
 * 只负责记住「这位用户有没有走过这一趟」，以及当前浮层的开关与进度；
 * 教程的内容（每一步讲什么、点了去做什么）全部放在组件里，这里不掺业务。
 *
 * 持久化沿用项目里既有 store 的写法（手写 localStorage + 读取失败即降级），
 * 不引入 zustand 的 persist 中间件，保持与 ui-version-store / theme-store 一致。
 */
export const ONBOARDING_STORAGE_KEY = 'ai-novel-writer-quick-start'

/**
 * pending   —— 还没走过：首次启动会自动弹出。
 * completed —— 走完了（包括每步都点「下一步」的情况）。
 * skipped   —— 中途「跳过全部」。
 * 后两者都不再自动弹出，但仍可由欢迎页的入口手动重看。
 */
export type OnboardingStatus = 'pending' | 'completed' | 'skipped'

/**
 * 教程走哪条路线。打开教程先让作者选一次，两条线的步骤集合完全不同：
 * - choose —— 还没表态：浮层先给出「我想自己写 / 我想导入小说」两个选项。
 * - self   —— 从小说配置开始，一步步把新书的地基搭好。
 * - import —— 已有作品：先配主模型与向量模型，再拆章导入并反向推演设定。
 */
export type OnboardingTrack = 'choose' | 'self' | 'import'

export interface OnboardingState {
  status: OnboardingStatus
  /** 浮层是否正在显示。 */
  open: boolean
  /** 当前走的是哪条路线。 */
  track: OnboardingTrack
  /** 当前步骤下标；每次重新打开都从头开始，避免停在半截。 */
  stepIndex: number
  /** 本次引导里被「跳过这一步」跳过的步骤下标。 */
  skippedSteps: number[]
  /** 首次使用（没走过）时自动弹出；走过之后什么都不做。 */
  openOnFirstRun: () => void
  /** 手动重看（欢迎页入口）。 */
  openGuide: () => void
  /** 选定路线。换路线时把进度归零，免得两条线的步骤下标互相串。 */
  setTrack: (track: OnboardingTrack) => void
  /** 关闭浮层；传 status 时一并记下「走完 / 跳过全部」。 */
  closeGuide: (status?: OnboardingStatus) => void
  setStepIndex: (index: number) => void
  markStepSkipped: (index: number) => void
}

/** localStorage 不可用（隐私模式、脏数据）时一律按「没走过」处理，绝不阻断启动。 */
export function readStoredOnboardingStatus(
  storage?: Pick<Storage, 'getItem'>,
): OnboardingStatus {
  try {
    const store = storage ?? (typeof localStorage === 'undefined' ? null : localStorage)
    const raw = store?.getItem(ONBOARDING_STORAGE_KEY)
    if (raw === 'completed' || raw === 'skipped') return raw
  } catch {
    // 读取失败按未走过处理
  }
  return 'pending'
}

function persistOnboardingStatus(status: OnboardingStatus): void {
  try {
    localStorage?.setItem(ONBOARDING_STORAGE_KEY, status)
  } catch {
    // 无法持久化时仍允许本次会话走完教程
  }
}

/** 允许测试用依赖注入构造，与项目内其它 store 的工厂式写法保持一致。 */
export function createOnboardingStore(initial: OnboardingStatus = readStoredOnboardingStatus()) {
  return create<OnboardingState>()((set, get) => ({
    status: initial,
    open: false,
    track: 'choose',
    stepIndex: 0,
    skippedSteps: [],

    openOnFirstRun: () => {
      if (get().status !== 'pending') return
      set({ open: true, track: 'choose', stepIndex: 0, skippedSteps: [] })
    },

    openGuide: () => set({ open: true, track: 'choose', stepIndex: 0, skippedSteps: [] }),

    setTrack: (track) => set({ track, stepIndex: 0, skippedSteps: [] }),

    closeGuide: (status) => {
      if (!status) {
        set({ open: false })
        return
      }
      persistOnboardingStatus(status)
      set({ status, open: false })
    },

    setStepIndex: (index) => set({ stepIndex: Math.max(0, index) }),

    markStepSkipped: (index) => set((state) => (
      state.skippedSteps.includes(index)
        ? state
        : { skippedSteps: [...state.skippedSteps, index] }
    )),
  }))
}

export const useOnboardingStore = createOnboardingStore()
