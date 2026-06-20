import { useEffect, type CSSProperties, type MouseEvent } from 'react'
import {
  Archive,
  CheckCircle2,
  FilePlus2,
  FolderOpen,
  Import,
  Menu,
  Minus,
  Moon,
  ScrollText,
  Settings,
  Sparkles,
  Square,
  Sun,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import { useThemeStore, type Theme } from '../../stores/theme-store'
import { useEditorStore } from '../../stores/editor-store'
import { useLayoutStore } from '../../stores/layout-store'
import { APP_BRAND } from '../../shared/brand'
import { ipc } from '../../services/ipc-client'

const isMac = navigator.userAgent.includes('Mac')

const themeIcons: Record<Theme, typeof Sun> = {
  light: Sun,
  galaxy: Sparkles,
  paper: ScrollText,
  dark: Moon,
}
const themeOrder: Theme[] = ['galaxy', 'dark', 'light', 'paper']

export default function TitleBar() {
  const currentProject = useProjectStore((s) => s.currentProject)
  const openProject = useProjectStore((s) => s.openProject)
  const { theme, setTheme } = useThemeStore()
  const { zoom, zoomIn, zoomOut, zoomReset } = useThemeStore()
  const hasDirty = useEditorStore((s) => s.tabs.some((t) => t.dirty))
  const openSettings = useLayoutStore(s => s.openSettings)
  const openNewProject = useLayoutStore(s => s.openNewProject)
  const openExport = useLayoutStore(s => s.openExport)
  const openImportNovel = useLayoutStore(s => s.openImportNovel)

  const ThemeIcon = themeIcons[theme] || Sun
  const cycleTheme = (e: MouseEvent) => {
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
        `circle(${endRadius}px at ${x}px ${y}px)`,
      ]

      document.documentElement.animate(
        { clipPath },
        {
          duration: 450,
          easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
          pseudoElement: '::view-transition-new(root)',
        }
      )
    })
  }

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

  const handleOpenProject = async () => {
    const folder = await ipc.invoke('dialog:select-folder')
    if (folder) {
      openProject(folder)
    }
  }

  const zoomLabel = `${Math.round(zoom * 100)}%`

  return (
    <div
      className="writer-topbar no-select flex items-center gap-2"
      style={{
        height: 'var(--height-titlebar)',
        paddingLeft: isMac ? 78 : 14,
        paddingRight: 10,
        WebkitAppRegion: 'drag',
      } as CSSProperties}
    >
      <div className="flex items-center gap-2 flex-shrink-0 min-w-0">
        <div
          className="flex h-8 w-8 items-center justify-center rounded-md"
          style={{
            background: 'linear-gradient(180deg, rgba(255, 239, 205, 0.22), rgba(160, 98, 39, 0.16))',
            border: '1px solid rgba(255, 236, 194, 0.18)',
          }}
        >
          <ScrollText size={18} strokeWidth={1.7} />
        </div>
        <div className="leading-tight min-w-[112px]">
          <div className="text-sm font-semibold brand-gradient">{APP_BRAND.zhName}</div>
          <div className="text-[0.68rem] opacity-75">{APP_BRAND.enName}</div>
        </div>
      </div>

      <div
        className="flex items-center gap-2 min-w-0 flex-1"
        style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
      >
        <button className="writer-command-button" title="主菜单" onClick={openSettings}>
          <Menu size={17} strokeWidth={1.8} />
        </button>

        <span className="text-xs font-semibold opacity-90 whitespace-nowrap">当前项目:</span>
        <button
          className="writer-command-button max-w-[280px]"
          title="切换项目"
          onClick={handleOpenProject}
        >
          <span className="truncate">{currentProject?.name ?? '未打开项目'}</span>
        </button>

        <span
          className="inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap"
          title={hasDirty ? '有未保存的修改' : '已保存'}
          style={{ color: hasDirty ? 'var(--color-warning)' : '#87d27d' }}
        >
          <CheckCircle2 size={14} strokeWidth={1.9} />
          {hasDirty ? '有修改' : '已保存'}
        </span>

        <div className="h-5 w-px bg-[rgba(255,244,223,0.24)]" />

        <button className="writer-command-button" title="备份功能将在后续任务实现" disabled>
          <Archive size={14} strokeWidth={1.75} />
          备份
        </button>
        <button className="writer-command-button" title="小说拆解与仿写" onClick={openImportNovel}>
          <Import size={14} strokeWidth={1.75} />
          拆解仿写
        </button>
        <button className="writer-command-button" title="导出" onClick={openExport}>
          <Upload size={14} strokeWidth={1.75} />
          导出
        </button>
        <button className="writer-command-button" title="新建项目" onClick={openNewProject}>
          <FilePlus2 size={14} strokeWidth={1.75} />
          新建
        </button>
        <button className="writer-command-button" title="打开项目" onClick={handleOpenProject}>
          <FolderOpen size={14} strokeWidth={1.75} />
          打开
        </button>
      </div>

      <div
        className="flex items-center gap-1 flex-shrink-0"
        style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
      >
        <button
          onClick={zoomOut}
          title="缩小"
          className="writer-command-button"
          style={{ minHeight: 24, padding: '0 6px' }}
        >
          <ZoomOut size={13} strokeWidth={1.5} />
        </button>
        <button
          onClick={zoomReset}
          title="重置缩放"
          className="writer-command-button"
          style={{ minHeight: 24, minWidth: 42, padding: '0 6px', fontFamily: 'var(--font-mono)' }}
        >
          {zoomLabel}
        </button>
        <button
          onClick={zoomIn}
          title="放大"
          className="writer-command-button"
          style={{ minHeight: 24, padding: '0 6px' }}
        >
          <ZoomIn size={13} strokeWidth={1.5} />
        </button>
        <button
          onClick={cycleTheme}
          title={`主题: ${theme === 'galaxy' ? '星空' : theme === 'paper' ? '纸质' : theme === 'dark' ? '黑夜' : '浅色'}`}
          className="writer-command-button"
          style={{ minHeight: 24, padding: '0 7px' }}
        >
          <ThemeIcon size={13} strokeWidth={1.5} />
        </button>
        <button
          onClick={openSettings}
          title="设置"
          className="writer-command-button"
          style={{ minHeight: 24, padding: '0 7px' }}
        >
          <Settings size={13} strokeWidth={1.5} />
        </button>
        <div className="h-5 w-px bg-[rgba(255,244,223,0.24)] mx-1" />
        <button className="writer-command-button" title="最小化窗口由系统标题栏控制" disabled style={{ minHeight: 24, padding: '0 7px' }}>
          <Minus size={13} />
        </button>
        <button className="writer-command-button" title="最大化窗口由系统标题栏控制" disabled style={{ minHeight: 24, padding: '0 7px' }}>
          <Square size={12} />
        </button>
        <button className="writer-command-button" title="关闭窗口由系统标题栏控制" disabled style={{ minHeight: 24, padding: '0 7px' }}>
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
