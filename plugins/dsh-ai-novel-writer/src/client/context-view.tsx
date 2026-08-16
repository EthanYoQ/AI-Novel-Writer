/** React shell surfaces for the compact novel workbench drawer and Settings evidence card. */

import { useEffect, useRef, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from 'react'
import { IconListPenOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PresetSetupController } from './setup-store.ts'
import { PresetSetupBody } from './setup-view.tsx'
import type { NovelWorkbenchController } from './workbench-store.ts'
import { NovelPluginCardBody, NovelWorkbenchBody } from './workbench-view.tsx'

const drawerReturnTargets = new WeakMap<NovelWorkbenchController, HTMLElement>()

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
 * @param drawer Mounted drawer inside the native shell overlay layer.
 * @returns A disposer that restores the frame's original layout.
 * @throws When the drawer is not mounted inside a Harness shell overlay.
 */
export function installWorkbenchLayoutReservation(drawer: HTMLElement): () => void {
  const frame = drawer.closest('[data-shell-overlay]')?.parentElement
  if (frame === null || frame === undefined) throw new Error('AI novel workbench requires the Harness shell overlay')
  frame.classList.add('aiNovelWorkbenchFrameOpen')
  return () => { frame.classList.remove('aiNovelWorkbenchFrameOpen') }
}

/** Controllers shared by the sidebar, overlay, and Plugin Configuration card. */
export interface NovelWorkbenchInjected {
  readonly workbenchController: NovelWorkbenchController
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
  wide, workbenchController, setupController,
}: NovelWorkbenchTriggerProps) {
  const workbenchState = useSyncExternalStore(
    listener => workbenchController.subscribe(listener),
    () => workbenchController.getSnapshot(),
  )
  const open = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    drawerReturnTargets.set(workbenchController, event.currentTarget)
    setupController.open()
    void Promise.all([workbenchController.open(), setupController.load()])
  }
  return (
    <button
      type="button"
      className="aiNovelContextTrigger"
      aria-label="打开小说工作台"
      aria-haspopup="dialog"
      aria-expanded={workbenchState.open}
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
export function NovelWorkbenchOverlay({ workbenchController, setupController }: NovelWorkbenchOverlayProps) {
  const workbenchState = useSyncExternalStore(
    listener => workbenchController.subscribe(listener),
    () => workbenchController.getSnapshot(),
  )
  const setupState = useSyncExternalStore(
    listener => setupController.subscribe(listener),
    () => setupController.getSnapshot(),
  )
  const drawer = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!workbenchState.open || drawer.current === null) return
    const releaseLayout = installWorkbenchLayoutReservation(drawer.current)
    const releaseKeyboard = installDrawerKeyboardScope(
      drawer.current,
      closeButton.current ?? drawer.current,
      drawerReturnTargets.get(workbenchController),
      () => { workbenchController.close(); setupController.close() },
    )
    return () => {
      releaseLayout()
      releaseKeyboard()
    }
  }, [setupController, workbenchController, workbenchState.open])
  if (!workbenchState.open) return null
  const close = (): void => { workbenchController.close(); setupController.close() }
  return (
    <div className="aiNovelContextOverlay" role="presentation">
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
          <NovelWorkbenchBody
            state={workbenchState}
            refresh={() => { void workbenchController.refresh() }}
            selectChapter={chapter => { void workbenchController.selectChapter(chapter) }}
            updateInitialization={patch => { workbenchController.updateInitialization(patch) }}
            previewInitialization={() => { workbenchController.previewInitialization() }}
            submitInitialization={() => { void workbenchController.submitInitialization() }}
            openAsset={target => { void workbenchController.openAsset(target) }}
            backToAssets={() => { workbenchController.backToAssets() }}
            updateProjectSettings={patch => { workbenchController.updateProjectSettings(patch) }}
            updateAssetSummary={summary => { workbenchController.updateAssetSummary(summary) }}
            previewAssetChange={() => { workbenchController.previewAssetChange() }}
            submitAssetChange={() => { void workbenchController.submitAssetChange() }}
            discardAssetChanges={() => { workbenchController.discardAssetChanges() }}
            reloadStaleAsset={() => { workbenchController.reloadStaleAsset() }}
            setCharacterSearch={search => { workbenchController.setCharacterSearch(search) }}
            selectCharacter={id => { workbenchController.selectCharacter(id) }}
            createCharacter={() => { workbenchController.createCharacter() }}
            updateCharacter={patch => { workbenchController.updateCharacter(patch) }}
            deleteCharacter={() => { workbenchController.deleteCharacter() }}
          />
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
    </div>
  )
}

/**
 * Subscribe the pure Plugin Configuration card to shared controller state.
 *
 * @param props Shared controllers owned by the client plugin fiber.
 * @returns One card contribution with live Host, Preset, Workspace, and project evidence.
 */
export function NovelPluginStatusCard({ workbenchController, setupController }: NovelWorkbenchInjected) {
  const workbenchState = useSyncExternalStore(
    listener => workbenchController.subscribe(listener),
    () => workbenchController.getSnapshot(),
  )
  const setupState = useSyncExternalStore(
    listener => setupController.subscribe(listener),
    () => setupController.getSnapshot(),
  )
  useEffect(() => {
    void Promise.all([setupController.load(), workbenchController.inspect()])
  }, [setupController, workbenchController])
  return <NovelPluginCardBody
    setupState={setupState}
    workbenchState={workbenchState}
    openWorkbench={returnFocus => {
      drawerReturnTargets.set(workbenchController, returnFocus)
      setupController.open()
      void Promise.all([setupController.load(), workbenchController.open()])
    }}
    refresh={() => { void Promise.all([setupController.load(), workbenchController.inspect()]) }}
  />
}

export { NovelPluginCardBody, NovelWorkbenchBody } from './workbench-view.tsx'
export type { NovelPluginCardBodyProps, NovelWorkbenchBodyProps } from './workbench-view.tsx'
