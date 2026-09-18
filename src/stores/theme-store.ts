import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { ipc } from '../services/ipc-client'

export type Theme = 'light' | 'galaxy' | 'paper' | 'dark'

// ─── 共享字体库 ─────────────────────────────────────────────────────────────

/** 内置字体 ID（界面字体和写作字体共享同一张清单） */
export type FontId =
  | 'inter'
  | 'noto-sans-sc'
  | 'lxgw-wenkai'
  | 'noto-serif-sc'
  | 'chosunilbo'
  | 'kaiti'
  | 'system'

export interface FontOption {
  id: FontId
  label: string
  labelEn: string
  desc: string
  descEn: string
  /** 实际 CSS font-family 字符串 */
  family: string
  /** 预览文字（用该字体渲染，展示中英文效果） */
  preview: string
  previewEn: string
  /**
   * 「本机是否装了这款字」的探测名。
   *
   * 只有**引用系统字体**的选项才需要它 —— 内置字体由 @font-face 保证存在，
   * 不必探测。探不到的选项不会从列表里消失，而是照常可选：它下面的 family
   * 已经排好了后路（见 fallbackLabel），选了也不会难看，只是字形与预期不同。
   *
   * 为什么是「引用系统字体」而不是「打包字体文件」：
   * Windows 楷体（KaiTi）与华文楷体都随系统或商业软件授权，
   * **不得随本软件再分发**。因此这里只能引用字体名，由用户机器决定是否命中；
   * 真要「任何机器都一致」，得换成可自由分发的开源字体
   * （思源宋体 / 霞鹜文楷 / 朝鲜日报明朝体）。
   */
  probe?: string
  /** 探测不到时实际会落到哪款字体 —— 界面上如实告知用户，不假装生效 */
  fallbackLabel?: string
  fallbackLabelEn?: string
}

/** 所有内置字体（界面 + 写作共用） */
export const FONT_OPTIONS: FontOption[] = [
  {
    id: 'inter',
    label: 'Inter',
    labelEn: 'Inter',
    desc: '精心设计的现代 UI 字体，英文排版优秀，界面首选',
    descEn: 'A modern UI font designed for clear English interfaces',
    family: "'Inter', system-ui, sans-serif",
    preview: 'Aa Bb 文字 123',
    previewEn: 'Aa Bb Text 123',
  },
  {
    id: 'noto-sans-sc',
    label: '思源黑体',
    labelEn: 'Noto Sans SC',
    desc: '黑体风格，中英文兼顾，简洁现代，科幻都市题材适用',
    descEn: 'A clean modern sans serif for Chinese and English text',
    family: "'Noto Sans SC', sans-serif",
    preview: '思源黑体 Sans',
    previewEn: 'Noto Sans',
  },
  {
    id: 'lxgw-wenkai',
    label: '霞鹜文楷',
    labelEn: 'LXGW WenKai',
    desc: '楷体风格，温润典雅，最适合中文小说写作',
    descEn: 'A warm, elegant typeface suited to literary writing',
    family: "'LXGW WenKai', serif",
    preview: '春花秋月何时了',
    previewEn: 'Once upon a time',
  },
  {
    id: 'noto-serif-sc',
    label: '思源宋体',
    labelEn: 'Noto Serif SC',
    desc: '宋体风格，字形端正，印刷质感强，正式文稿首选',
    descEn: 'A formal serif with a print-like reading experience',
    family: "'Noto Serif SC', serif",
    preview: '往事如云烟，归零',
    previewEn: 'A story in print',
  },
  {
    // 先生（2026-09-15）提供的**免费商用**字库，已随软件打包进 public/fonts/。
    // 与下面「引用系统字体」的选项不同：它不依赖用户机器上装没装，
    // 任何机器打开都长一个样子。
    id: 'chosunilbo',
    label: '明朝体',
    labelEn: 'Chosunilbo Myeongjo',
    desc: '朝鲜日报免费发布的传统明朝体，笔画端正如雕版，书卷气厚 · 可商用可分发',
    descEn: 'A traditional myeongjo released free for commercial use by the Chosun Ilbo',
    family: "'Chosunilbo Myeongjo', 'Noto Serif SC', serif",
    preview: '长夜将明，雪落无声',
    previewEn: 'A story in print',
  },
  {
    // 楷体：**引用系统字体**，不打包 —— Windows 楷体（KaiTi）与华文楷体都随系统
    // 或商业软件授权，不得再随本软件分发，所以这里只引用字体名。
    // 字体栈末位挂了霞鹜文楷（SIL OFL，已内置）当后路，于是「本机没装」时
    // 不会掉成黑体，而是落到那款同气质的开源楷体上；界面上也会如实标注
    // 「本机已装 / 未装 · 回退霞鹜文楷」，不让作者误以为已经生效。
    id: 'kaiti',
    label: '楷体',
    labelEn: 'KaiTi',
    desc: '系统楷书，笔锋清晰亲切，日记体与书信体叙事顺手（需本机已装）',
    descEn: 'The system kai script — warm and handwritten in feel (needs the font installed)',
    family: "'KaiTi', '楷体', 'STKaiti', '华文楷体', 'LXGW WenKai', serif",
    preview: '春花秋月何时了',
    previewEn: 'Once upon a time',
    probe: 'KaiTi',
    fallbackLabel: '霞鹜文楷',
    fallbackLabelEn: 'LXGW WenKai',
  },
  {
    id: 'system',
    label: '系统默认',
    labelEn: 'System UI',
    desc: 'macOS 使用苹方/SF Pro，原生手感，无需字体文件',
    descEn: 'Uses the operating system interface font with no extra files',
    family: 'system-ui, -apple-system, sans-serif',
    preview: 'Aa Bb 苹方 123',
    previewEn: 'Aa Bb System 123',
  },
]

// ─── 向后兼容：旧版 WRITING_FONT_OPTIONS 别名 ──────────────────────────────
/** @deprecated 请使用 FONT_OPTIONS */
export const WRITING_FONT_OPTIONS = FONT_OPTIONS
/** @deprecated 请使用 FontId */
export type WritingFont = FontId

// ─── 缩放常量 ─────────────────────────────────────────────────────────────

const ZOOM_STEP = 0.05
const ZOOM_MIN = 0.7
const ZOOM_MAX = 1.5
/** 基准 font-size（未缩放时 html 的字号，px） */
const BASE_FONT_SIZE = 14 as const

// ─── Store 类型 ──────────────────────────────────────────────────────────

interface ThemeState {
  /** 用户选择的主题 */
  theme: Theme
  /** 实际应用的主题（解析 system 后） */
  resolvedTheme: 'light' | 'galaxy' | 'paper' | 'dark'
  /** 当前缩放级别（1.0 = 100%） */
  zoom: number
  /** 当前写作字体（正文编辑区 → --font-writing） */
  writingFont: FontId
  /** 当前界面字体（UI 全局 → --font-sans） */
  uiFont: FontId
  /**
   * 字体默认值的迁移版本。v2「墨纸书斋」把正文的默认观感定为宋体纸书，
   * 需要把仍停留在旧默认（霞鹜文楷）的存量设置迁移一次；用版本号标记迁移状态，
   * 迁移过之后作者再主动选回霞鹜文楷（或任何字体）都不会被改动。
   */
  fontDefaultsVersion: number
  /** 设置主题 */
  setTheme: (theme: Theme) => void
  /** 初始化主题监听 */
  initTheme: () => void
  /** 放大 */
  zoomIn: () => void
  /** 缩小 */
  zoomOut: () => void
  /** 重置缩放到 100% */
  zoomReset: () => void
  /** 直接设置缩放级别 */
  setZoom: (zoom: number) => void
  /** 设置写作字体 */
  setWritingFont: (font: FontId) => void
  /** 设置界面字体 */
  setUiFont: (font: FontId) => void
}

type PersistedThemeState = Pick<
  ThemeState,
  'theme' | 'zoom' | 'writingFont' | 'uiFont' | 'fontDefaultsVersion'
>

// ─── Store ───────────────────────────────────────────────────────────────

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: 'galaxy',
      resolvedTheme: 'galaxy',
      zoom: 1.0,
      /**
       * 出厂默认（先生 2026-09-15 定）：
       *   · 主题   星空 —— 深空蓝紫底 + 天穹星尘（首页配星空壁纸）。
       *              这是安装后第一次打开看到的皮肤；作者一旦自己改过，
       *              持久化数据以作者为准，这里的默认值不再介入。
       *   · 写作字体 思源宋体 —— 草稿 / 终稿 / 架构文档等**正文区域**
       *   · 界面字体 明朝体  —— 左侧栏、菜单、对话框等 **UI 区域**
       */
      writingFont: 'noto-serif-sc',
      uiFont: 'chosunilbo',
      fontDefaultsVersion: 1,

      setTheme: (theme: Theme) => {
        const resolved = resolveTheme(theme)
        set({ theme, resolvedTheme: resolved })
        applyTheme(resolved)
      },

      initTheme: () => {
        const { zoom, uiFont } = get()
        let { writingFont } = get()
        let { theme } = get()

        // --- 字体默认值迁移（v2「墨纸书斋」）---
        // 皮肤把正文默认观感定为宋体纸书，而霞鹜文楷是旧默认值：仍停留在旧默认的
        // 存量设置随皮肤一起切到新默认，保证「一打开就是皮肤的样子」。
        // 用 fontDefaultsVersion 标记，迁移只发生一次 —— 之后作者主动选回霞鹜文楷
        // 或任何其它字体都不会再被改动。
        if ((get().fontDefaultsVersion ?? 0) < 1) {
          if (writingFont === 'lxgw-wenkai') {
            writingFont = 'noto-serif-sc'
            set({ writingFont })
          }
          set({ fontDefaultsVersion: 1 })
        }

        // --- 迁移并兼容历史数据版本 ---
        // 兼容旧版系统设定的 localStorage
        if ((theme as string) === 'system') {
          theme = resolveTheme(theme)
          set({ theme })
        }
        // Zustand v5 不会为缺失 version 的历史记录调用 migrate；首次初始化时
        // 将唯一明确的旧值 night 迁移并按当前持久化版本写回。
        if ((theme as string) === 'night') {
          theme = 'dark'
          set({ theme })
        }
        const resolved = resolveTheme(theme)
        set({ resolvedTheme: resolved })
        applyTheme(resolved)
        applyZoom(zoom)
        applyWritingFont(writingFont)
        applyUiFont(uiFont)
      },

      zoomIn: () => {
        const next = Math.min(ZOOM_MAX, +(get().zoom + ZOOM_STEP).toFixed(2))
        set({ zoom: next })
        applyZoom(next)
      },

      zoomOut: () => {
        const next = Math.max(ZOOM_MIN, +(get().zoom - ZOOM_STEP).toFixed(2))
        set({ zoom: next })
        applyZoom(next)
      },

      zoomReset: () => {
        set({ zoom: 1.0 })
        applyZoom(1.0)
      },

      setZoom: (zoom: number) => {
        const clamped = +Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom)).toFixed(2)
        set({ zoom: clamped })
        applyZoom(clamped)
      },

      setWritingFont: (font: FontId) => {
        set({ writingFont: font })
        applyWritingFont(font)
      },

      setUiFont: (font: FontId) => {
        set({ uiFont: font })
        applyUiFont(font)
      },
    }),
    {
      name: 'ai-novel-writer-theme',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        theme: state.theme,
        zoom: state.zoom,
        writingFont: state.writingFont,
        uiFont: state.uiFont,
      }),
      version: 1,
      migrate: (persistedState, version) => {
        const state = persistedState as { theme?: string }
        if (version < 1 && state.theme === 'night') {
          return { ...state, theme: 'dark' } as PersistedThemeState
        }
        return persistedState as PersistedThemeState
      },
    }
  )
)

// ─── 内部工具函数 ─────────────────────────────────────────────────────────

/** 解析主题：直接返回实际值，保留对 localStorage 旧版 system 设定的向下兼容 */
function resolveTheme(theme: Theme): 'light' | 'galaxy' | 'paper' | 'dark' {
  if ((theme as string) === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return theme
}

/** 应用主题到 DOM — 支持互斥的主题 */
function applyTheme(theme: 'light' | 'galaxy' | 'paper' | 'dark') {
  const root = document.documentElement
  root.classList.remove('galaxy', 'paper', 'dark')
  if (theme === 'galaxy') {
    root.classList.add('galaxy')
  } else if (theme === 'paper') {
    root.classList.add('paper')
  } else if (theme === 'dark') {
    root.classList.add('dark')
  }
}

/**
 * 将缩放比例应用到整个窗口。
 * Electron 环境使用 native zoomFactor；否则降级到 html root font-size。
 */
function applyZoom(zoom: number) {
  if (ipc.isElectron) {
    ipc.setZoomFactor(zoom)
  } else {
    document.documentElement.style.fontSize = `${(BASE_FONT_SIZE * zoom).toFixed(2)}px`
  }
}

/** 将写作字体应用到 --font-writing，正文编辑器通过 CSS 变量引用 */
function applyWritingFont(font: FontId) {
  /**
   * 兜一层回退：字体清单会随版本增删，旧设置里可能留着已下线的 id
   * （例如中途试过、后来又撤掉的款式）。此时 find 会落空、变量保持旧值不动，
   * 作者看到的就是「换了字体却毫无反应」。找不到就退回默认写作字体。
   */
  const opt = FONT_OPTIONS.find((o) => o.id === font)
    ?? FONT_OPTIONS.find((o) => o.id === 'noto-serif-sc')
  if (opt) {
    document.documentElement.style.setProperty('--font-writing', opt.family)
  }
}

/** 将界面字体应用到 --font-sans，body/html 通过 font-family: var(--font-sans) 引用 */
function applyUiFont(font: FontId) {
  // 同上：旧设置里的下线 id 一律回退，不让界面字体无声地失效。
  const opt = FONT_OPTIONS.find((o) => o.id === font)
    ?? FONT_OPTIONS.find((o) => o.id === 'noto-sans-sc')
  if (opt) {
    document.documentElement.style.setProperty('--font-sans', opt.family)
  }
}

// ─── 系统字体可用性探测 ────────────────────────────────────────────────────

/**
 * 探测某个字体族是否真的装在这台机器上。
 *
 * 做法：用 Canvas 量同一段文字的宽度 —— 先以 monospace 为基准量一次，
 * 再让浏览器在 monospace 之前尝试目标字体；两次宽度若完全相同，
 * 说明浏览器根本没找到那款字、直接落回了基准，即「未安装」。
 *
 * 为什么不用 document.fonts.check()：它对「系统已装但没有 @font-face 注册」
 * 的字体判断不可靠（常常一律返回 true），而宽度法只依赖真实排版结果。
 *
 * 用途：华文中宋、楷体这类**引用系统字体**的选项，在界面上如实标注
 * 「本机已装 / 未安装，将回退到某款」。不假装生效。
 */
export function isFontFamilyAvailable(family: string): boolean {
  if (typeof document === 'undefined') return false
  try {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return false
    // 中英混排：中文区分中文字体，拉丁与数字区分西文字体
    const sample = '永和九年岁在癸丑ABCabc123'
    ctx.font = '72px monospace'
    const baseline = ctx.measureText(sample).width
    ctx.font = `72px "${family}", monospace`
    const probed = ctx.measureText(sample).width
    return Math.abs(probed - baseline) > 0.5
  } catch {
    return false
  }
}

/** 批量探测：只检查带 probe 的选项（即引用系统字体的那几款），返回 id → 是否可用 */
export function detectFontAvailability(): Partial<Record<FontId, boolean>> {
  const result: Partial<Record<FontId, boolean>> = {}
  for (const opt of FONT_OPTIONS) {
    if (opt.probe) result[opt.id] = isFontFamilyAvailable(opt.probe)
  }
  return result
}
