import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useProjectStore } from '../../stores/project-store'
import { useLayoutStore } from '../../stores/layout-store'
import { useLocaleStore } from '../../stores/locale-store'
import { useEditorStore } from '../../stores/editor-store'
import { navigate } from '../../stores/navigation/navigation-intents'
import { useStageStore } from '../../stores/navigation/stage-store'
import { openBuiltinEditor } from '../../stores/open-builtin-editor'
import { chapterLabel } from '../../shared/chapter-label'
import type { Theme } from '../../stores/theme-store'
import ClearProjectDataDialog from '../dialogs/ClearProjectDataDialog'
import { leaveSettingsThen, openProjectFolder } from '../settings/unsaved-settings'
import type { MenuGroupSpec } from '../ui/Menu'
import NewWorkDialog from './library/NewWorkDialog'
import { SETTINGS_PAGES } from './settings/settings-pages'
import { preloadStagePages } from './stage-pages'
import StagePalette from './StagePalette'
import { paletteItem, type PaletteItem } from './palette-filter'
import StageSpine from './StageSpine'
import StageTopBar from './StageTopBar'
import StageWorkspace from './StageWorkspace'
import { CHAPTER_PHASE_TEXT, CHAPTER_RUNNING_TEXT, RESOURCE_NAMES, STAGE_NAMES, stageTabName } from './stage-text'
import { refreshStageWork, useLandingPage, useStageView, useStageWorkRefresh, type StageView } from './use-stage-work'
import { useStageShortcuts } from './use-stage-shortcuts'

type Text = (zh: string, en: string) => string

const backToLibrary = () => leaveSettingsThen(() => useLayoutStore.getState().setSidebarView('home'))
const newBook = () => leaveSettingsThen(() => useLayoutStore.getState().openNewProject())
const importNovel = () => leaveSettingsThen(() => useLayoutStore.getState().openImportNovel())

function crumbsFor(view: StageView, library: boolean, activeName: string | undefined, text: Text): string[] {
  if (library) return []
  const location = view.location
  if (!location) return []
  if (location.kind === 'resource') return [text('作品资料', 'Reference'), text(...RESOURCE_NAMES[location.page])]
  const stage = text(...STAGE_NAMES[location.stage])
  if (location.stage === 'manuscript' && location.chapter !== undefined) return [stage, chapterLabel(location.chapter, text)]
  if (location.stage === 'architecture' && activeName && activeName !== stage) return [stage, activeName]
  return [stage]
}

export default function StageShell({ theme }: { theme: Theme }) {
  const text = useLocaleStore(s => s.text)
  const hasProject = useProjectStore(s => Boolean(s.currentProject))
  const recentProjects = useProjectStore(s => s.recentProjects)
  const home = useLayoutStore(s => s.sidebarView === 'home')
  const library = !hasProject || home
  const focus = useStageStore(s => s.focus) && !library
  const palette = useStageStore(s => s.palette)
  const activeName = useEditorStore(s => {
    const tab = s.tabs.find(candidate => candidate.id === s.activeTabId)
    return tab ? stageTabName(tab, text) : undefined
  })
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const [clearOpen, setClearOpen] = useState(false)
  const view = useStageView()

  useStageWorkRefresh()
  useLandingPage(view)
  useStageShortcuts({ library, focus })

  useEffect(() => {
    if (library && useStageStore.getState().focus) useStageStore.setState({ focus: false })
  }, [library])

  useEffect(() => {
    const handle = requestIdleCallback(preloadStagePages, { timeout: 2000 })
    return () => cancelIdleCallback(handle)
  }, [])

  // 设置页属于打开它时的书房或作品；在书房与作品之间切换时收起。
  const settingsOpen = useLayoutStore(s => s.settingsOpen)
  const settingsSection = useLayoutStore(s => s.settingsSection)
  const wasLibrary = useRef(library)
  useEffect(() => {
    if (wasLibrary.current !== library && useLayoutStore.getState().settingsOpen) useLayoutStore.getState().closeSettings()
    wasLibrary.current = library
  }, [library])

  const toggleFocus = useCallback(() => useStageStore.setState(state => ({ focus: !state.focus, palette: null })), [])

  const workMenu = useMemo<MenuGroupSpec[]>(() => [
    { id: 'work', items: [
      { id: 'library', label: text('回到书房', 'Back to library'), onSelect: backToLibrary },
      { id: 'open', label: text('打开其他作品…', 'Open another book…'), onSelect: openProjectFolder },
      { id: 'new', label: text('新建作品…', 'New book…'), onSelect: newBook },
    ] },
    { id: 'files', items: [
      { id: 'export', label: text('导出…', 'Export…'), onSelect: () => useLayoutStore.getState().openExport() },
      { id: 'backup', label: text('项目备份', 'Project backup'), onSelect: () => navigate({ kind: 'settings', section: 'backup' }) },
      { id: 'import', label: text('小说拆解与仿写…', 'Novel breakdown & imitation…'), onSelect: importNovel },
    ] },
    { id: 'danger', tone: 'danger', items: [
      { id: 'clear', label: text('清除生成内容…', 'Clear generated content…'), onSelect: () => setClearOpen(true) },
    ] },
  ], [text])

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const go = view.stages.map(status => paletteItem('stage', {
      id: `stage-${status.stage}`, label: text(...STAGE_NAMES[status.stage]),
      run: () => navigate({ kind: 'stage', stage: status.stage }),
    }))
    const chapters = view.chapters.map(row => paletteItem('chapter', {
      id: `chapter-${row.number}`, chapter: row.number,
      label: row.title ? `${chapterLabel(row.number, text)} · ${row.title}` : chapterLabel(row.number, text),
      meta: text(...(row.running ? CHAPTER_RUNNING_TEXT : CHAPTER_PHASE_TEXT[row.phase])),
      run: () => navigate({ kind: 'chapter', chapterNumber: row.number }),
    }))
    const references = hasProject && !library ? [
      ...(Object.keys(RESOURCE_NAMES) as (keyof typeof RESOURCE_NAMES)[]).map(page => paletteItem('reference', {
        id: `resource-${page}`, label: text(...RESOURCE_NAMES[page]),
        run: () => navigate({ kind: 'resource', page }),
      })),
      paletteItem('reference', { id: 'characters', label: text('角色名单', 'Cast'), keywords: 'roster characters 角色',
        run: () => leaveSettingsThen(() => openBuiltinEditor('character-editor', text('角色名单', 'Cast'), 'character')) }),
    ] : []
    const books = recentProjects.map(project => paletteItem('action', {
      id: `book-${project.path}`, label: text(`打开《${project.name}》`, `Open “${project.name}”`), keywords: project.name,
      run: () => leaveSettingsThen(() => void useProjectStore.getState().openProject(project.path)),
    }))
    const actions = [
      paletteItem('action', { id: 'new', label: text('新建作品', 'New book'), run: newBook }),
      paletteItem('action', { id: 'open', label: text('打开作品', 'Open a book'), run: openProjectFolder }),
      paletteItem('action', { id: 'import', label: text('小说拆解与仿写', 'Novel breakdown & imitation'), run: importNovel }),
      ...(hasProject ? [
        paletteItem('action', { id: 'library', label: text('回到书房', 'Back to library'), run: backToLibrary }),
        paletteItem('action', { id: 'run', label: text('运行侧页', 'Run sheet'), keywords: 'AI 输出 任务 日志', run: () => navigate({ kind: 'run', facet: 'output' }) }),
        paletteItem('action', { id: 'export', label: text('导出', 'Export'), run: () => useLayoutStore.getState().openExport() }),
        paletteItem('action', { id: 'backup', label: text('项目备份', 'Project backup'), run: () => navigate({ kind: 'settings', section: 'backup' }) }),
      ] : []),
      ...(hasProject && !library ? [paletteItem('action', { id: 'focus', label: text('沉浸写作', 'Focus mode'), run: toggleFocus })] : []),
      paletteItem('action', { id: 'settings', label: text('设置', 'Settings'), run: () => navigate({ kind: 'settings', section: 'llm' }) }),
    ]
    return [...go, ...chapters, ...references, ...actions, ...(library ? books : [])]
  }, [view.stages, view.chapters, hasProject, library, text, toggleFocus, recentProjects])

  const settingsName = SETTINGS_PAGES.find(page => page.id === settingsSection)?.name
  const crumbs = settingsOpen && settingsName ? [text('设置', 'Settings'), text(...settingsName)] : crumbsFor(view, library, activeName, text)
  const focusChapter = view.location?.kind === 'stage' ? view.location.chapter : undefined
  const focusRow = view.chapters.find(row => row.number === focusChapter)
  const focusTitle = focusRow ? { chapter: focusRow.number, title: focusRow.title || chapterLabel(focusRow.number, text) } : { title: activeName ?? '' }

  return (
    <div
      ref={setRoot}
      className="paper-ink stage-shell"
      data-theme={theme}
      data-shell-presentation="stage"
      data-focus={focus || undefined}
      data-library={library || undefined}
    >
      <StageTopBar
        crumbs={crumbs}
        library={library}
        focus={focus}
        focusTitle={focusTitle}
        workMenu={workMenu}
        onToggleFocus={toggleFocus}
      />
      <div className="stage-frame">
        {!library && !focus && (
          <StageSpine
            stages={view.stages}
            chapters={view.chapters}
            location={view.location}
            settingsOpen={settingsOpen}
            onStage={stage => navigate({ kind: 'stage', stage })}
            onChapter={chapterNumber => navigate({ kind: 'chapter', chapterNumber })}
            onResource={page => navigate({ kind: 'resource', page })}
            onSettings={() => navigate({ kind: 'settings', section: 'llm' })}
          />
        )}
        <StageWorkspace library={library} focus={focus} />
      </div>
      <StagePalette mode={palette} items={paletteItems} container={root} onClose={() => useStageStore.setState({ palette: null })} />
      <ClearProjectDataDialog open={clearOpen} onClose={() => setClearOpen(false)} onCleared={() => refreshStageWork(text)} />
      <NewWorkDialog />
    </div>
  )
}
