import { type ReactNode, useEffect } from 'react'
import { type Theme, useThemeStore } from './stores/theme-store'
import { useAppearanceStore } from './stores/appearance-bootstrap'
import { useLayoutStore } from './stores/layout-store'
import { useLLMStore } from './stores/llm-store'
import { useProjectStore } from './stores/project-store'
import { useMCPStore } from './stores/mcp-store'
import { useWorkflowStore } from './stores/workflow-store'
import { useLocaleStore } from './stores/locale-store'
import { useSkinStore } from './stores/skin-store'
import { ipc } from './services/ipc-client'
import TitleBar from './components/layout/TitleBar'
import StatusBar from './components/layout/StatusBar'
import LeftToolWindowBar from './components/layout/LeftToolWindowBar'
import RightToolWindowBar from './components/layout/RightToolWindowBar'
import ShellV2 from './components/layout/v2/ShellV2'
import Sidebar from './components/panels/Sidebar'
import EditorArea from './components/panels/EditorArea'
import AIPanel from './components/panels/AIPanel'
import AIOutputPanel from './components/panels/AIOutputPanel'
import BottomPanel from './components/panels/BottomPanel'
import NewProjectDialog from './components/dialogs/NewProjectDialog'
import ImportNovelDialog from './components/dialogs/ImportNovelDialog'
import ChapterCreationDialog from './components/dialogs/ChapterCreationDialog'
import ExportDialog from './components/dialogs/ExportDialog'
import SettingsModal from './components/settings/SettingsModal'
import { ANIME_SKIN_URL } from './components/settings/AppearanceSettings'
import { ErrorBoundary } from './components/ErrorBoundary'
import { actionToast } from './components/ui/ActionToast'
import { UpdateNotifier } from './components/updates/UpdateNotifier'
import { globalEventBus } from './shared/event-bus'
import {
  projectSessionContextFromProject,
  sameProjectSessionContext,
} from './shared/project-session-context'
import { getAutoNextChapterPrefill, type NextChapterBlueprint } from './services/auto-next-chapter'
import type { SkinId } from './shared/skin-types'

// eslint-disable-next-line react-refresh/only-export-components
export function resolveSkinBackgroundUrl(skinId: SkinId, customUrl: string | null): string | null {
  if (skinId === 'anime') return ANIME_SKIN_URL
  if (skinId === 'custom') return customUrl
  return null
}

/** The sole decorative skin layer at the App root. It never participates in accessibility. */
export function SkinBackgroundLayer({
  skinId,
  backgroundUrl,
  onImageError,
}: {
  skinId: SkinId
  backgroundUrl: string | null
  onImageError?: () => void
}) {
  const imageUrl = resolveSkinBackgroundUrl(skinId, backgroundUrl)
  return (
    <div
      aria-hidden="true"
      data-skin-background={skinId}
      className="app-skin-background"
    >
      {imageUrl && <img src={imageUrl} alt="" className="app-skin-background-image" onError={onImageError} />}
    </div>
  )
}

/** Stable root semantics let image skins opt into their own readability tokens for every color theme. */
export function AppSkinRoot({
  theme,
  skinId,
  children,
}: {
  theme: Theme
  skinId: SkinId
  children: ReactNode
}) {
  return (
    <div
      className="app-skin-root flex flex-col w-full h-full overflow-hidden"
      data-theme={theme}
      data-skin={skinId}
      data-skin-readability={skinId === 'classic' ? 'theme-default' : 'high-contrast'}
    >
      {children}
    </div>
  )
}

/**
 * Vela 主应用组件
 * 使用 react-resizable-panels 实现可拖拽调整大小的四区布局
 */
export default function App() {
  const initTheme = useThemeStore((s) => s.initTheme)
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme)
  const resolvedShell = useAppearanceStore((s) => s.resolvedShell)
  const initLocale = useLocaleStore((s) => s.init)
  const text = useLocaleStore((s) => s.text)
  const sidebarOpen = useLayoutStore(s => s.sidebarOpen)
  const sidebarView = useLayoutStore(s => s.sidebarView)
  const currentProject = useProjectStore(s => s.currentProject)
  const aiPanelOpen = useLayoutStore(s => s.aiPanelOpen)
  const bottomPanelOpen = useLayoutStore(s => s.bottomPanelOpen)
  const immersive = useLayoutStore(s => s.immersive)
  const rightView = useLayoutStore(s => s.rightView)
  const settingsOpen = useLayoutStore(s => s.settingsOpen)
  const closeSettings = useLayoutStore(s => s.closeSettings)
  const newProjectOpen = useLayoutStore(s => s.newProjectOpen)
  const closeNewProject = useLayoutStore(s => s.closeNewProject)
  const exportOpen = useLayoutStore(s => s.exportOpen)
  const closeExport = useLayoutStore(s => s.closeExport)
  const importNovelOpen = useLayoutStore(s => s.importNovelOpen)
  const closeImportNovel = useLayoutStore(s => s.closeImportNovel)
  const chapterCreationOpen = useLayoutStore(s => s.chapterCreationOpen)
  const chapterCreationPrefill = useLayoutStore(s => s.chapterCreationPrefill)
  const closeChapterCreation = useLayoutStore(s => s.closeChapterCreation)
  const initLLM = useLLMStore((s) => s.init)
  const loadRecentProjects = useProjectStore((s) => s.loadRecentProjects)
  const skinState = useSkinStore((s) => s.skinState)
  const skinBackgroundUrl = useSkinStore((s) => s.backgroundUrl)
  const initSkin = useSkinStore((s) => s.init)
  const disposeSkin = useSkinStore((s) => s.dispose)
  const recoverFromImageFailure = useSkinStore((s) => s.recoverFromImageFailure)

  // 初始化：主题 + LLM 模型 + 最近项目 + 缩放级别
  useEffect(() => {
    initLocale()
    initTheme()
    initLLM()
    loadRecentProjects()
    // 初始化 MCP Store
    useMCPStore.getState().init().catch(e => console.warn('[MCP] 初始化失败:', e))
    if (ipc.isElectron) {
      const savedZoom = localStorage.getItem('vela-zoom-level')
      if (savedZoom) ipc.setZoomLevel(parseFloat(savedZoom))
    }
    // 初始化 ProjectService — 注册全局事件监听（生命周期与 App 一致）
    import('./services/project-service').then(({ initProjectService }) => {
      initProjectService()
    }).catch(e => console.warn('[ProjectService] 初始化失败:', e))

    // C) 工作流完成时弹出 ActionToast 通知（不依赖任何面板状态）
    const unsubActionToast = globalEventBus.on('WORKFLOW_COMPLETE', ({ projectSession, runId }) => {
      if (!sameProjectSessionContext(
        projectSession,
        projectSessionContextFromProject(useProjectStore.getState().currentProject),
      )) return
      const text = useLocaleStore.getState().text
      const { activeRuns, history } = useWorkflowStore.getState()
      const completedRun = activeRuns.find(r => r.id === runId)
        ?? history.find(r => r.id === runId)
      if (!completedRun) return
      actionToast.workflowComplete(
        text(`「${completedRun.title}」已完成`, `“${completedRun.title}” completed`),
        () => useLayoutStore.getState().openRightPanel('ai-output')
      )
    })

    const unsubAutoOpenNextChapter = globalEventBus.on('FINALIZE_COMPLETE', ({
      chapterNumber,
      projectSession,
      source,
    }) => {
      void (async () => {
        try {
          if (source === 'batch') return
          const isCurrentProjectSession = () => sameProjectSessionContext(
            projectSession,
            projectSessionContextFromProject(useProjectStore.getState().currentProject),
          )
          if (!isCurrentProjectSession()) return
          const config = await ipc.invoke('config:get')
          if (!isCurrentProjectSession()) return
          if (!config.autoOpenNextChapterAfterFinalize) return

          const nextChapterNumber = chapterNumber + 1
          const [blueprint, existingDraft] = await Promise.all([
            ipc.invokeWithProjectSession(
              projectSession,
              'db:blueprint-get',
              nextChapterNumber,
              projectSession.projectPath,
            ),
            ipc.invokeWithProjectSession(
              projectSession,
              'db:draft-get-latest',
              nextChapterNumber,
              projectSession.projectPath,
            ),
          ])
          if (!isCurrentProjectSession()) return
          const prefill = getAutoNextChapterPrefill(
            true,
            chapterNumber,
            blueprint as NextChapterBlueprint | null,
            existingDraft !== null,
          )
          if (prefill) useLayoutStore.getState().openChapterCreation(prefill)
        } catch (error) {
          console.warn('[AutoNextChapter] 无法打开下一章创作窗口:', error)
        }
      })()
    })

    return () => {
      // App 卸载时销毁 ProjectService（开发环境 HMR 时会触发）
      import('./services/project-service').then(({ disposeProjectService }) => {
        disposeProjectService()
      }).catch(() => {})
      unsubActionToast()
      unsubAutoOpenNextChapter()
    }
  }, [initLocale, initTheme, initLLM, loadRecentProjects])

  useEffect(() => {
    if (!ipc.isElectron) return undefined
    void initSkin()
    return disposeSkin
  }, [disposeSkin, initSkin])

  useEffect(() => {
    if (!ipc.isElectron) return
    void ipc.invoke('project:smoke-open-request').then(async (request) => {
      if (!request) return
      const opened = await useProjectStore.getState().openProject(request.projectPath)
      if (!opened) throw new Error('烟测项目打开失败')
      const confirmed = await ipc.invoke('project:smoke-open-confirm', request.projectPath)
      if (!confirmed.success) throw new Error(confirmed.error || '烟测项目确认失败')
    }).catch(error => console.error('[SmokeProjectOpen]', error))
  }, [])

  // 全局快捷键: Cmd+N 新建项目，Cmd+O 打开项目
  // 注意：Cmd+=/- 缩放已由 TitleBar.tsx 统一处理，此处不重复注册
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault()
        useLayoutStore.getState().openNewProject()
      } else if (e.key === 'o' || e.key === 'O') {
        e.preventDefault()
        const folder = await ipc.invoke('dialog:select-folder')
        if (folder) {
          useProjectStore.getState().openProject(folder)
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  useEffect(() => {
    if (resolvedShell !== 'writer' && useLayoutStore.getState().immersive) {
      useLayoutStore.getState().toggleImmersion()
    }
  }, [resolvedShell])

  return (
    <AppSkinRoot theme={resolvedTheme} skinId={skinState.activeSkin}>
      <SkinBackgroundLayer
        skinId={skinState.activeSkin}
        backgroundUrl={skinBackgroundUrl}
        onImageError={() => void recoverFromImageFailure()}
      />
      <UpdateNotifier />
      <ShellV2
        presentation={resolvedShell}
        variant={resolvedShell === 'writer' ? 'v3' : undefined}
        home={!currentProject || sidebarView === 'home'}
        theme={resolvedTheme}
        titleBar={<TitleBar />}
        rail={<LeftToolWindowBar />}
        sidebar={(
          <ErrorBoundary fallbackLabel={text('侧边栏渲染失败', 'Sidebar failed to render')}>
            <Sidebar />
          </ErrorBoundary>
        )}
        editor={(
          <ErrorBoundary fallbackLabel={text('编辑区渲染失败', 'Editor failed to render')}>
            <EditorArea onNewProject={() => useLayoutStore.getState().openNewProject()} />
          </ErrorBoundary>
        )}
        aiPanel={(
          <ErrorBoundary fallbackLabel={text('AI 面板渲染失败', 'AI panel failed to render')}>
            {rightView === 'ai-output' ? <AIOutputPanel /> : <AIPanel />}
          </ErrorBoundary>
        )}
        bottom={<BottomPanel />}
        statusBar={<StatusBar />}
        rightRail={<RightToolWindowBar />}
        sidebarOpen={sidebarOpen}
        aiPanelOpen={aiPanelOpen}
        bottomOpen={bottomPanelOpen}
        immersive={immersive}
      />

      {/* 全局对话框 — 由 layout-store 控制开关，不再依赖 window.dispatchEvent */}
      <NewProjectDialog
        open={newProjectOpen}
        onClose={closeNewProject}
      />
      <ImportNovelDialog
        open={importNovelOpen}
        onClose={closeImportNovel}
      />
      <ChapterCreationDialog
        isOpen={chapterCreationOpen}
        prefill={chapterCreationPrefill}
        onClose={closeChapterCreation}
      />
      <ExportDialog
        isOpen={exportOpen}
        onClose={closeExport}
      />
      {/* 全屏设置弹窗 */}
      <SettingsModal
        open={settingsOpen}
        onClose={closeSettings}
      />

    </AppSkinRoot>
  )
}
