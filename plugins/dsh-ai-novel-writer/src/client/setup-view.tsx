import { useEffect, useRef, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from 'react'
import { IconListPenOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PresetSetupController, PresetSetupState } from './setup-store.ts'

const dialogReturnTargets = new WeakMap<PresetSetupController, HTMLElement>()
const focusableSelector = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * Keep keyboard focus inside one open dialog and restore its invoking control on close.
 *
 * @param dialog Modal element owning the tabbable descendants.
 * @param initialFocus Preferred element focused after the dialog opens.
 * @param returnFocus Invoking control restored after the dialog closes.
 * @param close Close action used by the Escape key.
 * @returns A disposer that removes the key listener and restores focus.
 */
export function installDialogKeyboardScope(
  dialog: HTMLElement,
  initialFocus: HTMLElement,
  returnFocus: HTMLElement | undefined,
  close: () => void,
): () => void {
  const target = dialog.ownerDocument
  initialFocus.focus()
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = [...dialog.querySelectorAll<HTMLElement>(focusableSelector)]
    const first = focusable[0] ?? dialog
    const last = focusable.at(-1) ?? dialog
    const active = target.activeElement
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
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

/** Props for the framework-independent setup state body. */
export interface PresetSetupBodyProps {
  readonly state: PresetSetupState
  readonly install: () => void
  readonly retry: () => void
}

/**
 * Render the setup result and its explicit action without owning dialog chrome.
 *
 * @param props Current state and user-triggered actions.
 * @returns Accessible status content for the setup dialog.
 */
export function PresetSetupBody({ state, install, retry }: PresetSetupBodyProps) {
  switch (state.status) {
    case 'idle':
    case 'loading':
      return <p role="status">正在检查安装状态…</p>
    case 'not-installed':
      return (
        <div aria-live="polite">
          <p>安装后，请新建会话并选择“AI 小说作家”Preset。</p>
          <button type="button" className="aiNovelPresetPrimary" onClick={install}>安装 AI 小说作家 Preset</button>
        </div>
      )
    case 'installed':
      return (
        <div role="status" aria-live="polite">
          <p>Preset 已安装。</p>
          <p>请新建会话并选择“AI 小说作家”，现有会话不会被改写。</p>
        </div>
      )
    case 'conflict':
      return (
        <div role="alert">
          <p>检测到同名 Preset 冲突。</p>
          <p>插件没有覆盖任何用户文件；请重命名或移走现有目录后重试。</p>
          <button type="button" className="aiNovelPresetSecondary" onClick={retry}>重新检查</button>
        </div>
      )
    case 'error':
      return (
        <div role="alert">
          <p>安装状态读取失败：{state.message}</p>
          <button type="button" className="aiNovelPresetSecondary" onClick={retry}>重试</button>
        </div>
      )
    case 'disconnected':
      return (
        <div role="alert">
          <p>Harness 连接已断开。</p>
          <button type="button" className="aiNovelPresetSecondary" onClick={retry}>重新连接后重试</button>
        </div>
      )
  }
}

interface SetupInjected {
  readonly controller: PresetSetupController
}

type PresetSetupTriggerProps = PropsRuntime<'sidebar.footer.action'> & SetupInjected
type PresetSetupOverlayProps = PropsRuntime<'shell.overlay'> & SetupInjected

/**
 * Render the sidebar action that opens the setup dialog.
 *
 * @param props Sidebar width state and shared setup controller.
 * @returns A keyboard-operable native button.
 */
export function PresetSetupTrigger({ wide, controller }: PresetSetupTriggerProps) {
  const state = useSyncExternalStore(
    listener => controller.subscribe(listener),
    () => controller.getSnapshot(),
  )
  const open = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    dialogReturnTargets.set(controller, event.currentTarget)
    controller.open()
    void controller.load()
  }
  return (
    <button
      type="button"
      className="aiNovelPresetTrigger"
      aria-label="AI 小说作家 Preset 设置"
      aria-haspopup="dialog"
      aria-expanded={state.open}
      onClick={open}
    >
      <IconListPenOutline16 />
      {wide ? <span>AI 小说作家</span> : undefined}
    </button>
  )
}

/**
 * Render the setup dialog in the shell overlay slot.
 *
 * @param props Shared setup controller.
 * @returns The controlled modal while open, otherwise null.
 */
export function PresetSetupOverlay({ controller }: PresetSetupOverlayProps) {
  const state = useSyncExternalStore(
    listener => controller.subscribe(listener),
    () => controller.getSnapshot(),
  )
  const dialog = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!state.open || dialog.current === null) return
    return installDialogKeyboardScope(
      dialog.current,
      closeButton.current ?? dialog.current,
      dialogReturnTargets.get(controller),
      () => { controller.close() },
    )
  }, [controller, state.open])
  if (!state.open) return null
  return (
    <div className="aiNovelPresetOverlay" role="presentation">
      <div
        className="aiNovelPresetMask"
        aria-hidden="true"
        onClick={() => { controller.close() }}
      />
      <div
        ref={dialog}
        className="aiNovelPresetDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-novel-preset-title"
        tabIndex={-1}
      >
        <div className="aiNovelPresetHeader">
          <h2 id="ai-novel-preset-title">AI 小说作家 Preset</h2>
          <button
            ref={closeButton}
            type="button"
            className="aiNovelPresetClose"
            aria-label="关闭 AI 小说作家 Preset 设置"
            onClick={() => { controller.close() }}
          >关闭</button>
        </div>
        <p className="aiNovelPresetDescription">安装操作只会复制插件随附的专用 Preset；同名内容不同时绝不覆盖。</p>
        <div className="aiNovelPresetBody" data-ai-novel-preset-setup>
          <PresetSetupBody
            state={state}
            install={() => { void controller.install() }}
            retry={() => { void controller.load() }}
          />
        </div>
      </div>
    </div>
  )
}
