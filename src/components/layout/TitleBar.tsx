import { useEffect } from 'react'
import { Sun, Moon, ScrollText, Settings, ZoomIn, ZoomOut, Sparkles } from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import { useThemeStore, type Theme } from '../../stores/theme-store'
import { useEditorStore } from '../../stores/editor-store'
import { useLayoutStore } from '../../stores/layout-store'

/** 检测是否为 macOS */
const isMac = navigator.userAgent.includes('Mac')

const themeIcons: Record<Theme, typeof Sun> = {
  light: Sun,
  galaxy: Sparkles,
  paper: ScrollText,
  dark: Moon,
}
const themeOrder: Theme[] = ['galaxy', 'dark', 'light', 'paper']

/** 标题栏组件 — JetBrains 风格：36px 高，含缩放控制 */
export default function TitleBar() {
  const projectName = useProjectStore((s) => s.currentProject?.name)
  const { theme, setTheme } = useThemeStore()
  const { zoom, zoomIn, zoomOut, zoomReset } = useThemeStore()
  // 是否有未保存的文档（任意 dirty tab）
  const hasDirty = useEditorStore((s) => s.tabs.some((t) => t.dirty))

  const ThemeIcon = themeIcons[theme] || Sun
  const cycleTheme = (e: React.MouseEvent) => {
    const nextTheme = themeOrder[(themeOrder.indexOf(theme) + 1) % themeOrder.length]

    if (
      !('startViewTransition' in document) ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      setTheme(nextTheme)
      return
    }

    const x = e.clientX
    const y = e.clientY
    const endRadius = Math.hypot(
      Math.max(x, innerWidth - x),
      Math.max(y, innerHeight - y)
    )

    const transition = (document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } }).startViewTransition!(() => {
      setTheme(nextTheme)
    })

    transition.ready.then(() => {
      const clipPath = [
        `circle(0px at ${x}px ${y}px)`,
        `circle(${endRadius}px at ${x}px ${y}px)`
      ]

      document.documentElement.animate(
        {
          clipPath: clipPath
        },
        {
          duration: 450,
          easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
          pseudoElement: '::view-transition-new(root)'
        }
      )
    })
  }
  const openSettings = useLayoutStore(s => s.openSettings)

  // 注册缩放快捷键：Cmd+= 放大，Cmd+- 缩小，Cmd+0 重置
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        zoomIn()
      } else if (e.key === '-') {
        e.preventDefault()
        zoomOut()
      } else if (e.key === '0') {
        e.preventDefault()
        zoomReset()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [zoomIn, zoomOut, zoomReset])

  /** 百分比文字，如 "100%" */
  const zoomLabel = `${Math.round(zoom * 100)}%`

  return (
    <div
      className="no-select flex items-center"
      style={{
        height: 'var(--height-titlebar)',
        backgroundColor: 'var(--color-titlebar)',
        borderBottom: '1px solid var(--color-border)',
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
    >
      {/* 左侧：macOS 留出交通灯位置 + 应用名 */}
      <div className="flex items-center flex-shrink-0" style={{ paddingLeft: isMac ? 78 : 12 }}>
        <span className="text-xs font-semibold tracking-wider brand-gradient">
          Vela
        </span>
        {projectName && (
          <span className="text-xs ml-2 opacity-50" style={{ color: 'var(--color-titlebar-text)' }}>
            — {projectName}
          </span>
        )}
        {/* 未保存警示灯：当存在 dirty tab 时显示橙色小圆点 */}
        {hasDirty && (
          <span
            title="有未保存的修改"
            style={{
              display: 'inline-block',
              width: 7,
              height: 7,
              borderRadius: '50%',
              backgroundColor: 'var(--color-warning, #f59e0b)',
              marginLeft: 7,
              flexShrink: 0,
              boxShadow: '0 0 4px var(--color-warning, #f59e0b)',
              animation: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
            }}
          />
        )}
      </div>

      {/* 中间弹性区（可拖动） */}
      <div className="flex-1" />

      {/* 右侧控件区（no-drag，可点击） */}
      <div
        className="flex items-center gap-0.5 flex-shrink-0 pr-2"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {/* ───── 缩放控制组 ───── */}
        {/* 缩小 */}
        <button
          onClick={zoomOut}
          title={`缩小 (${isMac ? '⌘' : 'Ctrl'}+-)`}
          className="icon-btn"
          style={{ width: 22, height: 22 }}
        >
          <ZoomOut size={12} strokeWidth={1.5} />
        </button>

        {/* 缩放比例显示，点击可重置 */}
        <button
          onClick={zoomReset}
          title={`重置缩放 (${isMac ? '⌘' : 'Ctrl'}+0)`}
          style={{
            fontSize: "0.7rem",
            fontFamily: 'var(--font-mono)',
            color: zoom !== 1.0 ? 'var(--color-accent)' : 'var(--color-text-muted)',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: '0 3px',
            minWidth: 36,
            textAlign: 'center',
            lineHeight: '22px',
            borderRadius: 'var(--radius-sm)',
            transition: 'color var(--transition-fast)',
          }}
        >
          {zoomLabel}
        </button>

        {/* 放大 */}
        <button
          onClick={zoomIn}
          title={`放大 (${isMac ? '⌘' : 'Ctrl'}+=)`}
          className="icon-btn"
          style={{ width: 22, height: 22 }}
        >
          <ZoomIn size={12} strokeWidth={1.5} />
        </button>

        {/* 分割线 */}
        <div
          style={{
            width: 1,
            height: 14,
            background: 'var(--color-border)',
            margin: '0 3px',
            flexShrink: 0,
          }}
        />

        {/* 主题切换 */}
        <button
          onClick={cycleTheme}
          title={`主题: ${theme === 'galaxy' ? '星空' : theme === 'paper' ? '纸质' : theme === 'dark' ? '黑夜' : '浅色'}`}
          className="icon-btn"
          style={{ width: 24, height: 22 }}
        >
          <ThemeIcon size={13} strokeWidth={1.5} />
        </button>

        {/* 设置 */}
        <button
          onClick={openSettings}
          title="设置"
          className="icon-btn"
          style={{ width: 24, height: 22 }}
        >
          <Settings size={13} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  )
}
