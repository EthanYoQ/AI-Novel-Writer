import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import {
  Archive,
  Bot,
  Check,
  ChevronDown,
  FilePlus2,
  FileText,
  FolderOpen,
  Import,
  Languages,
  LifeBuoy,
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
import { useProjectStore } from '../../../stores/project-store'
import { useThemeStore, type Theme } from '../../../stores/theme-store'
import { useEditorStore } from '../../../stores/editor-store'
import { countUnsavedEditorItems } from '../../../stores/editor-unsaved'
import { useLayoutStore } from '../../../stores/layout-store'
import { useLLMStore } from '../../../stores/llm-store'
import { APP_BRAND } from '../../../shared/brand'
import { modelDisplayName } from '../../../shared/model-display'
import { ipc } from '../../../services/ipc-client'
import { useLocaleStore } from '../../../stores/locale-store'
import { useOnboardingStore } from '../../../stores/onboarding-store'
import { useHelpStore } from '../../../stores/help-store'
import GuideMark from '../../onboarding/GuideMark'
import type { MessageKey } from '../../../i18n/core'
import FlowStages from './FlowStages'
import { useCreationStage } from './useCreationStage'
import { useProjectOverview } from '../../pages/v2/useProjectOverview'
import { goRail } from './rail-routing'
import { useThemeCycle } from '../theme-cycle'
import { ExitGuardDialog } from '../exit-guard'
import { useExitGuard } from '../use-exit-guard'
import { MenuItem } from '../../ui/MenuItem'

const isMac = navigator.userAgent.includes('Mac')

import { BRAND_SEAL_URL } from './v2-assets'
import MagLogo from './magazine/MagLogo'
import { useUiVersionStore, isMagazine } from '../../../stores/ui-version-store'
const themeIcons: Record<Theme, typeof Sun> = {
  light: Sun,
  galaxy: Sparkles,
  paper: ScrollText,
  dark: Moon,
}
const themeLabelKeys: Record<Theme, MessageKey> = {
  light: 'theme.light',
  galaxy: 'theme.galaxy',
  paper: 'theme.paper',
  dark: 'theme.dark',
}

/**
 * 「墨纸书斋」顶栏（v2）。
 *
 * 视觉结构照 demo：印章 → 书名 → 保存态 → 六道工序 → 模型胶囊 → 操作区。
 * 产品原有的命令（打开/新建/导出/仿写/备份）、缩放、语言、窗口控制一项不减，
 * 只是换成 demo 的 .tb-btn 语言；退出守卫复用共享实现。
 */
export default function TitleBarV2() {
  const currentProject = useProjectStore((s) => s.currentProject)
  const openProject = useProjectStore((s) => s.openProject)
  const { theme, zoom, zoomIn, zoomOut, zoomReset } = useThemeStore()
  const tabs = useEditorStore((s) => s.tabs)
  const activeTabId = useEditorStore((s) => s.activeTabId)
  const hasDirty = useEditorStore((s) => countUnsavedEditorItems(s.tabs, s.draftLedgers) > 0)
  const settingsOpen = useLayoutStore((s) => s.settingsOpen)
  const openSettings = useLayoutStore((s) => s.openSettings)
  const openNewProject = useLayoutStore((s) => s.openNewProject)
  const openExport = useLayoutStore((s) => s.openExport)
  const openImportNovel = useLayoutStore((s) => s.openImportNovel)
  const aiPanelOpen = useLayoutStore((s) => s.aiPanelOpen)
  const toggleAIPanel = useLayoutStore((s) => s.toggleAIPanel)
  const models = useLLMStore((s) => s.models)
  const defaultModelId = useLLMStore((s) => s.defaultModelId)
  const { locale, toggleLocale, t, text } = useLocaleStore()

  /* 界面版本的分家只认这一个开关：v3 的刊头换成**双页 W**（先生 2026-09-17 从
     六款候选里挑的 NO.02），v2 仍用原来的印章图 —— 逐像素不变。 */
  const uiVersion = useUiVersionStore(s => s.uiVersion)
  const magazine = isMagazine(uiVersion)

  const cycleTheme = useThemeCycle()
  const exitGuard = useExitGuard()
  const { current: creationStage } = useCreationStage()
  /**
   * 工序条优先显示「这本书走到哪一步」——先生要的是「永远显示选中的小说、最新章节状态」，
   * 而不是「此刻有没有任务在跑」。数据与书架首页共用同一个聚合钩子。
   */
  const overview = useProjectOverview()

  const defaultModel = models.find(
    (m) => m.id === defaultModelId && m.purposes?.some((p) => p !== 'embedding'),
  )
  /**
   * 模型别名允许为空（新建模型时只有 modelName 是必填的），
   * 直接显示 name 会让胶囊变成一片空白 —— 回退到 modelName / provider。
   */
  const modelLabel = modelDisplayName(defaultModel)
  const ThemeIcon = themeIcons[theme] || Sun
  const activeTab = tabs.find((tab) => tab.id === activeTabId)
  const zoomLabel = `${Math.round(zoom * 100)}%`

  // 快捷键与 v1 顶栏保持一致：Cmd/Ctrl + = / - / 0
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
      void openProject(folder)
    }
  }

  const handleSettings = (event: MouseEvent) => {
    event.stopPropagation()
    openSettings()
  }

  /**
   * 「文件」下拉菜单。
   *
   * 先生：顶栏图标太多看着心累 —— 于是把 新建 / 打开 / 导出小说 / 小说导入 / 备份
   * 收进一个菜单，每一项都是「图标 + 文字说明」，能力一项不减。
   */
  const [fileMenuOpen, setFileMenuOpen] = useState(false)
  const fileMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!fileMenuOpen) return
    const handlePointerDown = (event: Event) => {
      const target = event.target as Node | null
      if (fileMenuRef.current && target && !fileMenuRef.current.contains(target)) {
        setFileMenuOpen(false)
      }
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFileMenuOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [fileMenuOpen])

  /**
   * 「帮助」下拉：和「文件」同一套交互 —— 点开、点外面或 Esc 关闭。
   * 里面放两件事：从头走一遍的新手教程，以及出事时按报错查的常见错误。
   */
  const [helpMenuOpen, setHelpMenuOpen] = useState(false)
  const helpMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!helpMenuOpen) return
    const handlePointerDown = (event: Event) => {
      const target = event.target as Node | null
      if (helpMenuRef.current && target && !helpMenuRef.current.contains(target)) {
        setHelpMenuOpen(false)
      }
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHelpMenuOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [helpMenuOpen])

  return (
    <>
      <header
        className="titlebar v2-titlebar"
        style={{
          paddingLeft: isMac ? 78 : 16,
          WebkitAppRegion: 'drag',
        } as CSSProperties}
      >
        {/* 印章：点击回到书架（对齐 demo 的 navGo('home')：焦点清空，中央回到书架首页） */}
        <div
          className="brand"
          title={text('回到书架', 'Back to shelf')}
          onClick={() => goRail('home')}
        >
          <span className="sealmark">
            {magazine
              ? <MagLogo size={32} />
              : <img src={BRAND_SEAL_URL} alt={text(APP_BRAND.zhName, APP_BRAND.enName)} />}
          </span>
        </div>

        <span className="tbdiv" />

        {/* 书名与当前文档 */}
        <div className="bookname">
          <b>{currentProject?.name ?? text(APP_BRAND.zhName, APP_BRAND.enName)}</b>
          {activeTab && <span>{activeTab.name}</span>}
        </div>

        <span
          className="saved"
          title={hasDirty ? t('save.dirty') : t('save.saved')}
          style={hasDirty ? { color: 'var(--warn)' } : undefined}
        >
          {hasDirty ? <FilePlus2 size={11} strokeWidth={1.9} /> : <Check size={11} strokeWidth={2.4} />}
          {hasDirty ? t('save.modified') : t('save.saved')}
        </span>

        {/* 六道工序：优先显示「这本书走到哪一步」的真实完成度，其次才是运行中的任务 */}
        <FlowStages current={creationStage} stages={overview.stages} />

        <span className="tbdiv" />

        {/* 当前模型 */}
        <span
          className="modelpill"
          data-tour="model-pill"
          title={modelLabel
            ? text(`当前模型：${modelLabel}`, `Current model: ${modelLabel}`)
            : text('点击配置模型', 'Click to configure a model')}
          onClick={(event) => {
            event.stopPropagation()
            openSettings('llm')
          }}
        >
          <span className="live" />
          {modelLabel || text('未配置模型', 'No model configured')}
        </span>

        {/* 项目命令：全部收进「文件」下拉菜单（先生：顶栏图标太多看着心累） */}
        <div className="tb-file" ref={fileMenuRef} data-tour="file-menu">
          <button
            className={`tb-btn${fileMenuOpen ? ' on' : ''}`}
            onClick={() => setFileMenuOpen((open) => !open)}
            title={text('文件', 'File')}
            aria-haspopup="menu"
            aria-expanded={fileMenuOpen}
          >
            <FileText size={13} strokeWidth={1.75} />
            <span>{text('文件', 'File')}</span>
            <ChevronDown size={11} strokeWidth={1.8} />
          </button>
          {fileMenuOpen && (
            <div className="tb-menu" role="menu">
              <MenuItem
                icon={<FilePlus2 size={13} />}
                label={text('新建项目', 'New project')}
                onClick={() => { setFileMenuOpen(false); openNewProject() }}
              />
              <MenuItem
                icon={<FolderOpen size={13} />}
                label={text('打开项目…', 'Open project…')}
                onClick={() => { setFileMenuOpen(false); void handleOpenProject() }}
              />
              <MenuItem
                icon={<Upload size={13} />}
                label={text('导出小说', 'Export novel')}
                onClick={() => { setFileMenuOpen(false); openExport() }}
              />
              <MenuItem
                icon={<Import size={13} />}
                label={text('小说导入', 'Import novel')}
                onClick={() => { setFileMenuOpen(false); openImportNovel() }}
              />
              <MenuItem
                icon={<Archive size={13} />}
                label={text('备份', 'Backup')}
                disabled
                onClick={() => undefined}
              />
            </div>
          )}
        </div>

        <span className="tbdiv" />

        {/* 视图命令 */}
        <button className="tb-btn" onClick={zoomOut} title={t('zoom.out')}>
          <ZoomOut size={13} strokeWidth={1.5} />
        </button>
        <button className="tb-btn" onClick={zoomReset} title={t('zoom.reset')}>
          <span className="zoom-label">{zoomLabel}</span>
        </button>
        <button className="tb-btn" onClick={zoomIn} title={t('zoom.in')}>
          <ZoomIn size={13} strokeWidth={1.5} />
        </button>
        <button
          className="tb-btn"
          onClick={cycleTheme}
          title={t('theme.label', { name: t(themeLabelKeys[theme]) })}
        >
          <ThemeIcon size={13} strokeWidth={1.5} />
        </button>
        <button className="tb-btn" onClick={() => void toggleLocale()} title={t('language.switch')}>
          <Languages size={13} strokeWidth={1.5} />
          <span>{locale === 'zh-CN' ? 'EN' : '中文'}</span>
        </button>
        {/* 帮助：新手教程 + 常见错误（先生指定：橙色按钮 + 下拉，交互与「文件」一致） */}
        <div className="tb-file" ref={helpMenuRef} data-tour="help-menu">
          <button
            type="button"
            className={`tb-btn tb-quickstart${helpMenuOpen ? ' on' : ''}`}
            onClick={() => setHelpMenuOpen((open) => !open)}
            title={text('帮助：新手教程与常见错误', 'Help: quick start and common issues')}
            aria-haspopup="menu"
            aria-expanded={helpMenuOpen}
          >
            <GuideMark size={13} />
            <span>{text('帮助', 'Help')}</span>
            <ChevronDown size={11} strokeWidth={1.8} />
          </button>
          {helpMenuOpen && (
            <div className="tb-menu" role="menu">
              <MenuItem
                icon={<GuideMark size={13} />}
                label={text('新手教程', 'Quick start guide')}
                onClick={() => {
                  setHelpMenuOpen(false)
                  useOnboardingStore.getState().openGuide()
                }}
              />
              <MenuItem
                icon={<LifeBuoy size={13} />}
                label={text('常见错误', 'Common issues')}
                onClick={() => {
                  setHelpMenuOpen(false)
                  useHelpStore.getState().openHelp()
                }}
              />
            </div>
          )}
        </div>
        <button
          className={`tb-btn${aiPanelOpen ? ' on' : ''}`}
          onClick={toggleAIPanel}
          title={text('AI 助手 · 资料与答疑', 'AI assistant')}
        >
          <Bot size={13} strokeWidth={1.7} />
          <span>{text('助手', 'Assistant')}</span>
        </button>
        <button
          className={`tb-btn${settingsOpen ? ' on' : ''}`}
          onClick={handleSettings}
          title={t('common.settings')}
        >
          <Settings size={13} strokeWidth={1.6} />
        </button>

        <span className="tbdiv" />

        {/* 窗口控制 */}
        <button className="tb-btn tb-win" title={t('common.minimize')} onClick={() => ipc.invoke('window:minimize')}>
          <Minus size={13} />
        </button>
        <button className="tb-btn tb-win" title={t('common.maximizeRestore')} onClick={() => ipc.invoke('window:toggle-maximize')}>
          <Square size={12} />
        </button>
        <button className="tb-btn tb-win tb-win-close" title={t('common.close')} onClick={() => ipc.invoke('window:close')}>
          <X size={14} />
        </button>
      </header>

      <ExitGuardDialog guard={exitGuard} />
    </>
  )
}
