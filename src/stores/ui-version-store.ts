import { create } from 'zustand'

/**
 * 界面版本开关。
 *
 * v3 = 「时尚杂志」（当前默认）—— 在 v2 基座之上重定令牌与版式
 * v2 = 「墨纸书斋」       —— 来自 AI小说家-Demo
 * v1 = 既有经典界面       —— 随时可回退的保险
 *
 * 三套外壳共用同一批业务组件与 store，只替换视觉与外壳布局，
 * 因此这个开关是纯逃生舱：任何异常都能立刻切回上一版，无需回退代码。
 *
 * v3 与 v2 的关系：v3 复用 v2 的外壳骨架（布局、拖拽、栏目路由都不重写），
 * 差异全部落在 CSS 令牌与图层上 —— 因此「用不用现代外壳」这件事，
 * 对业务组件来说是同一个判断。组件一律用 isModernShell() 而不是 === 'v2'，
 * 否则 v3 会丢掉 v2 已有的行为（成书纸页预览、标签栏回调、栏目同步等）。
 */
export type UiVersion = 'v1' | 'v2' | 'v3'

export const UI_VERSION_STORAGE_KEY = 'ai-novel-writer-ui-version'

/** 出厂默认界面版本：v2「墨纸书斋」（先生 2026-09-15 定）。 */
export const DEFAULT_UI_VERSION: UiVersion = 'v2'

/** 切换按钮的循环顺序（设置面板里是直接点选，这里只服务快捷键式的轮换）。
 *  v1 经典界面已隐藏入口，不再参与轮换。 */
export const UI_VERSION_ORDER: readonly UiVersion[] = ['v3', 'v2']

export interface UiVersionState {
  uiVersion: UiVersion
  setUiVersion: (version: UiVersion) => void
  toggleUiVersion: () => void
}

export function isUiVersion(value: unknown): value is UiVersion {
  return value === 'v1' || value === 'v2' || value === 'v3'
}

/**
 * 读取本地保存的界面版本。localStorage 不可用（隐私模式、损坏数据）时
 * 一律降级为默认值，绝不让界面因为读取失败而白屏。
 */
export function readStoredUiVersion(storage?: Pick<Storage, 'getItem'>): UiVersion {
  try {
    const store = storage ?? (typeof localStorage === 'undefined' ? null : localStorage)
    if (!store) return DEFAULT_UI_VERSION
    const raw = store.getItem(UI_VERSION_STORAGE_KEY)
    // v1 经典界面已隐藏入口：历史存过 v1 的一律回退到默认版本，避免卡在已隐藏的界面。
    if (isUiVersion(raw)) return raw === 'v1' ? DEFAULT_UI_VERSION : raw
    // 兼容直接存 JSON 的写法
    if (raw) {
      const parsed = JSON.parse(raw) as { version?: unknown; state?: { uiVersion?: unknown } }
      const candidate = parsed?.state?.uiVersion ?? parsed?.version
      if (isUiVersion(candidate)) return candidate === 'v1' ? DEFAULT_UI_VERSION : candidate
    }
  } catch {
    // 读取失败按默认值处理，不阻断启动
  }
  return DEFAULT_UI_VERSION
}

function persistUiVersion(version: UiVersion): void {
  try {
    localStorage?.setItem(UI_VERSION_STORAGE_KEY, version)
  } catch {
    // 无法持久化时仍允许本次会话内切换
  }
}

/**
 * 允许测试与其它 store 用依赖注入的方式构造，
 * 与项目内其它 store 的工厂式写法保持一致。
 */
export function createUiVersionStore(initial: UiVersion = readStoredUiVersion()) {
  return create<UiVersionState>()((set, get) => ({
    uiVersion: initial,
    setUiVersion: (version) => {
      persistUiVersion(version)
      set({ uiVersion: version })
    },
    toggleUiVersion: () => {
      const order = UI_VERSION_ORDER
      const current = order.indexOf(get().uiVersion)
      const next = order[(current + 1) % order.length] ?? DEFAULT_UI_VERSION
      persistUiVersion(next)
      set({ uiVersion: next })
    },
  }))
}

export const useUiVersionStore = createUiVersionStore()

/**
 * 派生辅助：是否使用「现代外壳」（墨纸书斋 v2 及其杂志版 v3）。
 *
 * 业务组件判断外壳行为时必须用这个函数，不要写 `=== 'v2'` ——
 * v3 与 v2 共用同一套外壳与交互，只是视觉不同。
 */
export function isModernShell(version: UiVersion): boolean {
  return version === 'v2' || version === 'v3'
}

/**
 * @deprecated 语义已并入 isModernShell（v3 同样使用现代外壳）。
 * 保留导出只为不打断既有引用，新代码请用 isModernShell。
 */
export const isV2 = isModernShell

/** 派生辅助：是否为「时尚杂志」版本。 */
export function isMagazine(version: UiVersion): boolean {
  return version === 'v3'
}
