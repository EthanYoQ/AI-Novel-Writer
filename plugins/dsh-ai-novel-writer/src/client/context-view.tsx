/** React shell surfaces for the compact novel workbench drawer and Settings evidence card. */

import { useEffect, useRef, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { IconChevronLeftOutline14, IconListPenOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PresetSetupController } from './setup-store.ts'
import { PresetSetupBody } from './setup-view.tsx'
import type { NovelV2WorkbenchController, NovelWorkbenchController } from './workbench-store.ts'
import { NovelPluginCardBody, NovelV2WorkbenchBody, NovelWorkbenchBody } from './workbench-view.tsx'
import type { NovelWorkbenchRouteController } from './workbench-v2-observer.ts'
import type { NovelV2WorkbenchState } from './workbench-v2.ts'

const drawerReturnTargets = new WeakMap<object, HTMLElement>()

function v2ScreenKey(state: NovelV2WorkbenchState): string {
  if (state.status !== 'ready' || state.editor.target === undefined) return state.status
  const { target, source = 'asset' } = state.editor
  const aggregate = target.kind === 'chapter' ? `chapter:${target.chapter}`
    : target.kind === 'task' ? `task:${target.taskId}` : target.kind
  return source === 'proposal'
    ? `proposal:${state.proposals.selectedId ?? 'none'}:${state.proposals.selectedChange ?? 'none'}:${aggregate}`
    : `${source}:${aggregate}`
}

function focusableElements(drawer: HTMLElement): HTMLElement[] {
  return [...drawer.querySelectorAll<HTMLElement>(
    'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[href],[tabindex]:not([tabindex="-1"])',
  )].filter(element => !element.hidden)
}

/**
 * Contain focus in a non-modal drawer, close it with Escape, and restore its invoking control.
 *
 * @param drawer Drawer element receiving fallback focus.
 * @param initialFocus Preferred element focused after open.
 * @param returnFocus Invoking control restored after close.
 * @param close Close action used by the Escape key.
 * @returns A disposer that removes the key listener and restores focus.
 */
export function installDrawerKeyboardScope(
  drawer: HTMLElement,
  initialFocus: HTMLElement,
  returnFocus: HTMLElement | undefined,
  close: () => void,
): () => void {
  initialFocus.focus()
  const target = drawer.ownerDocument
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = focusableElements(drawer)
    if (focusable.length === 0) {
      event.preventDefault()
      drawer.focus()
      return
    }
    const first = focusable[0]!
    const last = focusable.at(-1)!
    if (event.shiftKey && target.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && target.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
  target.addEventListener('keydown', onKeyDown)
  return () => {
    target.removeEventListener('keydown', onKeyDown)
    if (returnFocus?.isConnected) returnFocus.focus()
  }
}

/**
 * Reserve the drawer's wide-screen column in the owning Harness frame.
 *
 * @param shellSeat Mounted marker or drawer inside the native shell overlay layer.
 * @returns A disposer that restores the frame's original layout.
 * @throws When the shell seat is not mounted inside a Harness shell overlay.
 */
export function installWorkbenchLayoutReservation(shellSeat: HTMLElement): () => void {
  const frame = shellSeat.closest('[data-shell-overlay]')?.parentElement
  if (frame === null || frame === undefined) throw new Error('AI novel workbench requires the Harness shell overlay')
  frame.classList.add('aiNovelWorkbenchFrameOpen')
  return () => { frame.classList.remove('aiNovelWorkbenchFrameOpen') }
}

/** Controllers shared by the sidebar, overlay, and Plugin Configuration card. */
export interface NovelWorkbenchInjected {
  readonly workbenchController: NovelWorkbenchController
  readonly v2WorkbenchController: NovelV2WorkbenchController
  readonly workbenchRoute: NovelWorkbenchRouteController
  readonly setupController: PresetSetupController
}

type NovelWorkbenchTriggerProps = PropsRuntime<'sidebar.footer.action'> & NovelWorkbenchInjected
type NovelWorkbenchOverlayProps = PropsRuntime<'shell.overlay'> & NovelWorkbenchInjected

/**
 * Render the discoverable sidebar action.
 *
 * @param props Sidebar width state and shared workbench controllers.
 * @returns A keyboard-operable DSH-native button.
 */
export function NovelWorkbenchTrigger({
  wide, workbenchController, v2WorkbenchController, workbenchRoute, setupController,
}: NovelWorkbenchTriggerProps) {
  const mode = useSyncExternalStore(
    listener => workbenchRoute.subscribe(listener),
    () => workbenchRoute.getSnapshot(),
  )
  const v1State = useSyncExternalStore(
    listener => workbenchController.subscribe(listener),
    () => workbenchController.getSnapshot(),
  )
  const v2State = useSyncExternalStore(
    listener => v2WorkbenchController.subscribe(listener),
    () => v2WorkbenchController.getSnapshot(),
  )
  const activeState = mode === 'v2' ? v2State : mode === 'v1' ? v1State : undefined
  const open = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    if (mode === 'none') return
    const activeController = mode === 'v2' ? v2WorkbenchController : workbenchController
    drawerReturnTargets.set(activeController, event.currentTarget)
    setupController.open()
    void Promise.all([activeController.open(), setupController.load()])
  }
  return (
    <button
      type="button"
      className="aiNovelContextTrigger"
      aria-label="打开小说工作台"
      aria-haspopup="dialog"
      aria-expanded={activeState?.open ?? false}
      disabled={mode === 'none'}
      onClick={open}
    >
      <IconListPenOutline16 />
      {wide ? <span>小说工作台</span> : undefined}
    </button>
  )
}

/**
 * Render the 400–440 px non-modal workbench in the root shell overlay slot.
 *
 * @param props Shared workbench and Preset setup controllers.
 * @returns The controlled drawer while open, otherwise null.
 */
export function NovelWorkbenchOverlay({
  workbenchController, v2WorkbenchController, workbenchRoute, setupController,
}: NovelWorkbenchOverlayProps) {
  const mode = useSyncExternalStore(
    listener => workbenchRoute.subscribe(listener),
    () => workbenchRoute.getSnapshot(),
  )
  const v1State = useSyncExternalStore(
    listener => workbenchController.subscribe(listener),
    () => workbenchController.getSnapshot(),
  )
  const v2State = useSyncExternalStore(
    listener => v2WorkbenchController.subscribe(listener),
    () => v2WorkbenchController.getSnapshot(),
  )
  const setupState = useSyncExternalStore(
    listener => setupController.subscribe(listener),
    () => setupController.getSnapshot(),
  )
  const drawer = useRef<HTMLDivElement>(null)
  const shellSeat = useRef<HTMLSpanElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const activeState = mode === 'v2' ? v2State : mode === 'v1' ? v1State : undefined
  const screenKey = mode === 'v2'
    ? v2ScreenKey(v2State)
    : v1State.status === 'ready' ? v1State.screen.kind : v1State.status
  const previousScreenKey = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (activeState === undefined || !activeState.open || drawer.current === null || shellSeat.current === null) return
    const activeController = mode === 'v2' ? v2WorkbenchController : workbenchController
    const releaseLayout = installWorkbenchLayoutReservation(shellSeat.current)
    const releaseKeyboard = installDrawerKeyboardScope(
      drawer.current,
      closeButton.current ?? drawer.current,
      drawerReturnTargets.get(activeController),
      () => { activeController.close(); setupController.close() },
    )
    return () => {
      releaseLayout()
      releaseKeyboard()
    }
  }, [activeState?.open, mode, setupController, v2WorkbenchController, workbenchController])
  useEffect(() => {
    if (activeState === undefined || !activeState.open) {
      previousScreenKey.current = undefined
      return
    }
    if (previousScreenKey.current === undefined) {
      previousScreenKey.current = screenKey
      if (mode === 'v2' && (v2State.status === 'error'
        || (v2State.status === 'ready' && v2State.editor.target !== undefined))) {
        drawer.current?.querySelector<HTMLElement>('[data-ai-novel-screen-focus]')?.focus()
      }
      return
    }
    if (previousScreenKey.current === screenKey) return
    previousScreenKey.current = screenKey
    drawer.current?.querySelector<HTMLElement>('[data-ai-novel-screen-focus]')?.focus()
  }, [activeState?.open, activeState?.status, screenKey])
  if (activeState === undefined || !activeState.open) return null
  const close = (): void => {
    if (mode === 'v2') v2WorkbenchController.close()
    else if (mode === 'v1') workbenchController.close()
    setupController.close()
  }
  return <>
    <span ref={shellSeat} hidden aria-hidden="true" />
    {createPortal(<div className="aiNovelContextOverlay" role="presentation">
      <div
        ref={drawer}
        className="aiNovelContextDrawer"
        role="dialog"
        aria-modal="false"
        aria-labelledby="ai-novel-workbench-title"
        tabIndex={-1}
      >
        <div className="aiNovelContextHeader">
          <h2 id="ai-novel-workbench-title">小说工作台</h2>
          <button
            ref={closeButton}
            type="button"
            className="aiNovelPresetClose"
            aria-label="关闭小说工作台"
            onClick={close}
          >关闭</button>
        </div>
        <div className="aiNovelContextBody" data-ai-novel-workbench>
          {mode === 'v2'
            ? <NovelV2WorkbenchBody
                state={v2State}
                refresh={() => { void v2WorkbenchController.refresh() }}
                selectProposal={proposalId => { v2WorkbenchController.selectProposal(proposalId) }}
                openProposalChange={index => { v2WorkbenchController.openProposalChange(index) }}
                applySelectedProposal={() => { void v2WorkbenchController.applySelectedProposal() }}
                retryProposalItem={index => { void v2WorkbenchController.retryProposalItem(index) }}
                discardProposalItem={index => { void v2WorkbenchController.discardProposalItem(index) }}
                regenerateProposalItem={index => { void v2WorkbenchController.regenerateProposalItem(index) }}
                proposalLifecycleAvailable={v2WorkbenchController.proposalLifecycleAvailable()}
                selectTask={taskId => { void v2WorkbenchController.selectTask(taskId) }}
                selectChapter={chapter => { v2WorkbenchController.selectChapter(chapter) }}
                openAsset={target => { v2WorkbenchController.openAsset(target) }}
                updateEditor={draft => { v2WorkbenchController.updateEditor(draft) }}
                discardEditor={() => { v2WorkbenchController.discardEditor() }}
              />
            : <NovelWorkbenchBody
                state={v1State}
                backIcon={<IconChevronLeftOutline14 />}
                refresh={() => { void workbenchController.refresh() }}
                selectChapter={chapter => { void workbenchController.selectChapter(chapter) }}
                updateInitialization={patch => { workbenchController.updateInitialization(patch) }}
                updateInitializationGenerationBrief={brief => { workbenchController.updateInitializationGenerationBrief(brief) }}
                generateInitialization={() => { void workbenchController.generateInitialization() }}
                previewInitialization={() => { workbenchController.previewInitialization() }}
                submitInitialization={() => { void workbenchController.submitInitialization() }}
                openAsset={target => { void workbenchController.openAsset(target) }}
                backToAssets={() => { workbenchController.backToAssets() }}
                updateProjectSettings={patch => { workbenchController.updateProjectSettings(patch) }}
                updateStoryBlueprint={patch => { workbenchController.updateStoryBlueprint(patch) }}
                updateChapterBlueprint={patch => { workbenchController.updateChapterBlueprint(patch) }}
                updateChapterDraft={text => { workbenchController.updateChapterDraft(text) }}
                updateAssetSummary={summary => { workbenchController.updateAssetSummary(summary) }}
                updateAssetGenerationBrief={brief => { workbenchController.updateAssetGenerationBrief(brief) }}
                generateAsset={() => { void workbenchController.generateAsset() }}
                previewAssetChange={() => { workbenchController.previewAssetChange() }}
                submitAssetChange={() => { void workbenchController.submitAssetChange() }}
                discardAssetChanges={() => { workbenchController.discardAssetChanges() }}
                reloadStaleAsset={() => { workbenchController.reloadStaleAsset() }}
                setCharacterSearch={search => { workbenchController.setCharacterSearch(search) }}
                selectCharacter={id => { workbenchController.selectCharacter(id) }}
                createCharacter={() => { workbenchController.createCharacter() }}
                updateCharacter={patch => { workbenchController.updateCharacter(patch) }}
                deleteCharacter={() => { workbenchController.deleteCharacter() }}
              />}
        </div>
        <section className="aiNovelContextSetup" aria-labelledby="ai-novel-preset-setup-title">
          <h3 id="ai-novel-preset-setup-title">AI 小说作家 Preset</h3>
          <PresetSetupBody
            state={setupState}
            install={() => { void setupController.install() }}
            retry={() => { void setupController.load() }}
          />
        </section>
      </div>
    </div>, document.body)}
  </>
}

/**
 * Subscribe the pure Plugin Configuration card to shared controller state.
 *
 * @param props Shared controllers owned by the client plugin fiber.
 * @returns One card contribution with live Host, Preset, Workspace, and project evidence.
 */
export function NovelPluginStatusCard({
  workbenchController, v2WorkbenchController, workbenchRoute, setupController,
}: NovelWorkbenchInjected) {
  const mode = useSyncExternalStore(
    listener => workbenchRoute.subscribe(listener),
    () => workbenchRoute.getSnapshot(),
  )
  const workbenchState = useSyncExternalStore(
    listener => workbenchController.subscribe(listener),
    () => workbenchController.getSnapshot(),
  )
  const v2WorkbenchState = useSyncExternalStore(
    listener => v2WorkbenchController.subscribe(listener),
    () => v2WorkbenchController.getSnapshot(),
  )
  const setupState = useSyncExternalStore(
    listener => setupController.subscribe(listener),
    () => setupController.getSnapshot(),
  )
  useEffect(() => {
    void setupController.load()
    if (mode === 'v2') void v2WorkbenchController.refresh()
    else if (mode === 'v1') void workbenchController.inspect()
  }, [mode, setupController, v2WorkbenchController, workbenchController])
  const activeWorkbenchState = mode === 'v2' ? v2WorkbenchState : mode === 'v1' ? workbenchState : undefined
  return <NovelPluginCardBody
    setupState={setupState}
    workbenchState={activeWorkbenchState}
    workbenchMode={mode}
    openWorkbench={returnFocus => {
      if (mode === 'none') return
      const activeController = mode === 'v2' ? v2WorkbenchController : workbenchController
      drawerReturnTargets.set(activeController, returnFocus)
      setupController.open()
      void Promise.all([setupController.load(), activeController.open()])
    }}
    refresh={() => {
      void setupController.load()
      if (mode === 'v2') void v2WorkbenchController.refresh()
      else if (mode === 'v1') void workbenchController.inspect()
    }}
  />
}

export { NovelPluginCardBody, NovelWorkbenchBody } from './workbench-view.tsx'
export { NovelV2WorkbenchBody } from './workbench-view.tsx'
export type { NovelPluginCardBodyProps, NovelV2WorkbenchBodyProps, NovelWorkbenchBodyProps } from './workbench-view.tsx'
