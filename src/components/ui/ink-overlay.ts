import { useLayoutEffect, useState } from 'react'
import { useThemeStore } from '../../stores/theme-store'

const HOST_ID = 'ai-novel-ink-overlay'
const TOAST_MOUNT_ID = 'ai-novel-ink-toasts'
let unsubscribeTheme: (() => void) | undefined

/**
 * body 下唯一的纸墨宿主。挂在 body 上的浮层碰不到外壳根的 .paper-ink，所以宿主自带 .paper-ink 与 data-theme，
 * 并跟随主题切换；它是 display: contents，不画底色、不建层叠上下文。
 */
export function inkOverlayHost(): HTMLElement {
  const existing = document.getElementById(HOST_ID)
  if (existing) return existing
  const host = document.createElement('div')
  host.id = HOST_ID
  host.className = 'paper-ink pi-overlay-host'
  host.dataset.theme = useThemeStore.getState().resolvedTheme
  unsubscribeTheme?.()
  unsubscribeTheme = useThemeStore.subscribe(state => { host.dataset.theme = state.resolvedTheme })
  // 提示栈的挂载点随宿主一起建并且是 live region：Radix 模态用 hideOthers 把其余节点标 aria-hidden 时放过已有的 [aria-live]，
  // 模态开着时到达的通知读屏仍读得到
  const toasts = document.createElement('div')
  toasts.id = TOAST_MOUNT_ID
  toasts.setAttribute('aria-live', 'polite')
  host.append(toasts)
  document.body.append(host)
  return host
}

export function toastStackMount(): HTMLElement {
  inkOverlayHost()
  return document.getElementById(TOAST_MOUNT_ID)!
}

/** 宿主里放一个独立的挂载点，命令式弹窗用完即删。它是一层 .pi-prompt-layer，后弹出的整层画在先弹出的上面。 */
export function createInkOverlayMount(): HTMLElement {
  const mount = document.createElement('div')
  mount.className = 'pi-prompt-layer'
  inkOverlayHost().append(mount)
  return mount
}

/**
 * 组件里取纸墨宿主：渲染期不建节点，提交后在布局 effect 里取（同 use-paper-ink-root）。
 * 取到之前为 null，调用方先不渲染 Portal（Radix 的 Portal 没有容器时会挂到 body）。
 */
export function useInkOverlayHost(): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    // 宿主要在提交后才建（渲染期不写 DOM），取到后在绘制前再渲染一次，和 use-paper-ink-root 同理
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHost(inkOverlayHost())
  }, [])
  return host
}
