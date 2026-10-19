import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react'
import { useProjectStore } from '../../stores/project-store'
import { useEditorStore, type EditorTab } from '../../stores/editor-store'
import { useLayoutStore } from '../../stores/layout-store'
import { useLocaleStore } from '../../stores/locale-store'
import { navigate } from '../../stores/navigation/navigation-intents'
import { useStageStore } from '../../stores/navigation/stage-store'
import type { ProjectData } from '../../shared/ipc-channels'
import { sameProjectPathKey } from '../../shared/project-session-context'
import { ErrorBoundary } from '../ErrorBoundary'
import ArchFileViewer from '../editor/ArchFileViewer'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { DangerConfirm } from '../ui/DangerConfirm'
import RunSheet from './run/RunSheet'
import StageArchitecture from './architecture/StageArchitecture'
import StageCharacters from './characters/StageCharacters'
import StageLibrary from './library/StageLibrary'
import { SettingsPage, SetupPage } from './stage-pages'
import StageHistory from './history/StageHistory'
import StageKnowledge from './knowledge/StageKnowledge'
import StagePlot from './plot/StagePlot'
import StageTabMenu, { CloseTabsConfirm } from './StageTabMenu'
import StageTabs from './StageTabs'
import { commandLabel, isComposing, isModalOpen } from './shortcut-keys'
import BlueprintRecovery from './blueprint/BlueprintRecovery'
import StageBlueprint from './blueprint/StageBlueprint'
import ChapterView from './chapter/ChapterView'
import ProseDocument from './chapter/ProseDocument'
import { installChapterTabRouting, isChapterViewTab, isProseDocumentTab } from './chapter/chapter-tab-routing'
import { stageTabName } from './stage-text'
import { cancelCloseTab, closeCleanTabs, confirmCloseTab, requestCloseTab, STAGE_CONTENT_ID } from './tab-close'

/** 每种标签对应的页面。架构文档（含大纲恢复稿与角色名单全文）沿用 ArchFileViewer。 */
function TabContent({ tab, project }: { tab: EditorTab; project: ProjectData }) {
  const text = useLocaleStore(s => s.text)
  const sameProject = sameProjectPathKey(tab.projectKey, project.path)
  if (tab.type === 'config' && tab.projectKey) return <SetupPage projectKey={tab.projectKey} />
  if (tab.type === 'world-building' && tab.projectKey) return <StageArchitecture projectKey={tab.projectKey} />
  if (tab.type === 'character' && tab.projectKey) return <StageCharacters projectKey={tab.projectKey} />
  if (isChapterViewTab(tab)) return <ChapterView tab={tab} />
  if (isProseDocumentTab(tab) && sameProject) return <ProseDocument tab={tab} project={project} />
  if (tab.type === 'chapter-card' && tab.projectKey && tab.planningRecovery) {
    return <BlueprintRecovery key={`${tab.id}:${project.sessionLease}`} tab={tab} projectKey={tab.projectKey} />
  }
  if (tab.type === 'chapter-card' && tab.projectKey) {
    return <StageBlueprint projectKey={tab.projectKey} initialChapterNumber={tab.chapterNumber} selectRequest={tab.chapterSelectRequest} />
  }
  if (tab.type === 'version-history' && sameProject) return <StageHistory projectKey={project.path} />
  if (tab.type === 'knowledge' && sameProject) return <StageKnowledge tabId={tab.id} />
  if (tab.type === 'narrative-thread' && sameProject) {
    return <StagePlot projectKey={project.path} initialView={tab.narrativeThreadView ?? 'plans'} viewRequest={tab.narrativeThreadViewRequest} />
  }
  if (tab.type === 'arch-file' && tab.filePath && tab.projectKey) {
    return <ArchFileViewer key={tab.id} tabId={tab.id} filePath={tab.filePath} projectKey={tab.projectKey} content={tab.content ?? ''} savedContent={tab.savedContent ?? tab.content ?? ''} />
  }
  return (
    <EmptyState
      heading={text('这个标签没有可显示的页面', 'This tab has no page to show')}
      description={text('它可能属于另一部作品，或者来自旧版界面。关掉它不会改动作品。', 'It may belong to another book or come from the old interface. Closing it does not change the book.')}
      action={<Button variant="secondary" onClick={() => requestCloseTab(tab.id)}>{text('关闭标签', 'Close tab')}</Button>}
    />
  )
}

const TABBABLE = 'a[href], button, input, select, textarea, [contenteditable="true"], [tabindex]'
const tabbables = (root: Element) => [...root.querySelectorAll<HTMLElement>(TABBABLE)]
  .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0)

const isEditable = (target: EventTarget | null) => target instanceof HTMLElement
  && (target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)

/** 侧页浮起（stage-panel.css 的容器查询）时才盖住内容区右侧；以样式为准，不在这里重复浮起的宽度阈值。 */
const floatingSheet = (slot: HTMLElement | null) => slot && getComputedStyle(slot).position === 'absolute' ? slot : null

/** 浮起时焦点不停在被侧页整个盖住的控件上：顺着 Tab 的方向跳到下一个看得见的，前面没有了就进侧页，后面没有了就停在内容区。 */
function skipCoveredFocus(event: FocusEvent<HTMLElement>, slot: HTMLElement | null) {
  const sheet = floatingSheet(slot)?.getBoundingClientRect()
  if (!sheet) return
  const covered = (element: Element) => element.getBoundingClientRect().left >= sheet.left
  const target = event.target
  if (!covered(target)) return
  const order = tabbables(event.currentTarget)
  const index = order.indexOf(target)
  if (index < 0) return
  const backward = event.relatedTarget instanceof Node && (target.compareDocumentPosition(event.relatedTarget) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  const next = (backward ? order.slice(0, index).reverse() : order.slice(index + 1)).find(element => !covered(element))
  ;(next ?? (backward ? event.currentTarget : tabbables(slot!)[0]))?.focus()
}

export default function StageWorkspace({ library, focus }: { library: boolean; focus: boolean }) {
  const settingsOpen = useLayoutStore(s => s.settingsOpen)
  const text = useLocaleStore(s => s.text)
  const project = useProjectStore(s => s.currentProject)
  const tabs = useEditorStore(s => s.tabs)
  const activeTabId = useEditorStore(s => s.activeTabId)
  const sheet = useStageStore(s => s.sheet)
  const tabDomId = (tabId: string) => `${STAGE_CONTENT_ID}-tab-${tabId.replace(/[^\w-]/g, '_')}`
  const closingTabId = useStageStore(s => s.closingTabId)
  const pending = tabs.find(tab => tab.id === closingTabId) ?? null
  const pendingName = pending ? stageTabName(pending, text) : ''
  const [closingMany, setClosingMany] = useState<readonly string[] | null>(null)
  const sheetSlotRef = useRef<HTMLDivElement>(null)
  // 浮起的侧页盖着内容区，焦点在内容区时 Esc 也收起它；并排时 Esc 只在侧页里有效，与原来一样。
  // 打字处（输入框、正文编辑器）与输入法组字时的 Esc 属于输入，设置页与对话框的 Esc 归它们自己。
  const closeFloatingSheet = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return
    if (isComposing(event.nativeEvent) || isModalOpen() || settingsOpen || isEditable(event.target)) return
    if (floatingSheet(sheetSlotRef.current)) useStageStore.setState({ sheet: null })
  }
  const closeMany = (tabIds: readonly string[]) => {
    const dirty = closeCleanTabs(tabIds)
    if (dirty.length > 0) setClosingMany(dirty)
  }

  const activeTab = tabs.find(tab => tab.id === activeTabId)
  useEffect(() => installChapterTabRouting(), [])
  useEffect(() => {
    if (tabs.length > 0 && !activeTab) useEditorStore.getState().setActiveTab(tabs[0].id)
  }, [tabs, activeTab])

  if (library || !project) {
    return (
      <main className="stage-panel" data-page={settingsOpen ? 'settings' : 'library'}>
        {settingsOpen ? <SettingsPage library /> : <div className="stage-library"><StageLibrary /></div>}
      </main>
    )
  }

  // 设置页盖在内容区上，标签内容保持挂载（编辑器的撤销历史、滚动位置不丢），运行侧页照常在右侧。
  const showTabs = !focus && !settingsOpen && tabs.length > 1
  return (
    <main className="stage-panel">
      {showTabs && (
        <div className="stage-tabbar">
          <StageTabs
            tabs={tabs}
            activeTabId={activeTab?.id ?? null}
            onSelect={tabId => useEditorStore.getState().setActiveTab(tabId)}
            onClose={requestCloseTab}
            tabDomId={tabDomId}
            panelId={STAGE_CONTENT_ID}
          />
          <StageTabMenu tabs={tabs} activeTabId={activeTab?.id ?? null} onSelect={tabId => useEditorStore.getState().setActiveTab(tabId)} onCloseMany={closeMany} />
        </div>
      )}
      <div className="stage-body" onKeyDown={closeFloatingSheet}>
        {settingsOpen && <SettingsPage library={false} />}
        <div
          className="stage-content"
          hidden={settingsOpen}
          id={STAGE_CONTENT_ID}
          tabIndex={-1}
          role={showTabs ? 'tabpanel' : undefined}
          aria-labelledby={showTabs && activeTab ? tabDomId(activeTab.id) : undefined}
          onFocus={event => skipCoveredFocus(event, sheetSlotRef.current)}
        >
          {activeTab
            ? (
              <ErrorBoundary key={activeTab.id} fallbackLabel={text('编辑区渲染失败', 'Editor failed to render')}>
                <TabContent tab={activeTab} project={project} />
              </ErrorBoundary>
            )
            : (
              <EmptyState
                heading={text('从流程脊选一步开始', 'Pick a step in the flow to begin')}
                description={text('左侧按设定、架构、蓝图、正文排列，点任意一步打开它。', 'Setup, architecture, blueprint and manuscript are listed on the left. Open any of them.')}
                action={<Button variant="primary" onClick={() => navigate({ kind: 'stage', stage: 'setup' })}>{text('打开设定', 'Open setup')}</Button>}
              />
            )}
        </div>
        {sheet?.kind === 'run' && !focus && (
          <div ref={sheetSlotRef} className="stage-sheet-slot" data-wide={sheet.tab === 'diagnostics' || undefined}>
            <ErrorBoundary fallbackLabel={text('运行侧页渲染失败', 'Run sheet failed to render')}>
              <RunSheet sheet={sheet} />
            </ErrorBoundary>
          </div>
        )}
      </div>
      <DangerConfirm
        open={pending !== null}
        onOpenChange={open => { if (!open) cancelCloseTab() }}
        title={text('放弃未保存的修改？', 'Discard unsaved changes?')}
        consequence={text(`「${pendingName}」有未保存的修改，关闭后这些修改会丢失。`, `“${pendingName}” has unsaved changes. Closing it discards them.`)}
        recoverability={text(`丢弃后无法恢复。想保留就选「继续编辑」，再按 ${commandLabel('s')} 保存。`, `This cannot be undone. Choose “Keep editing” and press ${commandLabel('s')} to keep them.`)}
        confirmLabel={text('放弃并关闭', 'Discard and close')}
        cancelLabel={text('继续编辑', 'Keep editing')}
        onConfirm={confirmCloseTab}
      />
      <CloseTabsConfirm pending={closingMany} onSettled={() => setClosingMany(null)} />
    </main>
  )
}
