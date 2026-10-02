import { useCallback, type MouseEvent } from 'react'
import { useThemeStore, type Theme } from '../../stores/theme-store'

/** 主题循环顺序，与既有顶栏保持一致。 */
export const THEME_CYCLE_ORDER: readonly Theme[] = ['galaxy', 'dark', 'light', 'paper']

/**
 * 主题切换（带以点击点为圆心的 View Transition 扩散）。
 *
 * v1 与 v2 两套顶栏共用这一份实现 —— 换壳不应该复制粘贴业务行为。
 * 浏览器不支持 View Transition 或用户要求减少动效时，直接切换，不做动画。
 */
export function useThemeCycle() {
  const theme = useThemeStore((s) => s.theme)
  const setTheme = useThemeStore((s) => s.setTheme)

  return useCallback((event?: MouseEvent) => {
    const nextTheme = THEME_CYCLE_ORDER[(THEME_CYCLE_ORDER.indexOf(theme) + 1) % THEME_CYCLE_ORDER.length]
    const originX = event?.clientX
    const originY = event?.clientY

    if (
      originX === undefined ||
      originY === undefined ||
      !('startViewTransition' in document) ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      setTheme(nextTheme)
      return
    }

    const endRadius = Math.hypot(
      Math.max(originX, innerWidth - originX),
      Math.max(originY, innerHeight - originY),
    )

    const transition = (document as Document & {
      startViewTransition?: (callback: () => void) => { ready: Promise<void> }
    }).startViewTransition!(() => {
      setTheme(nextTheme)
    })

    transition.ready.then(() => {
      document.documentElement.animate(
        {
          clipPath: [
            `circle(0px at ${originX}px ${originY}px)`,
            `circle(${endRadius}px at ${originX}px ${originY}px)`,
          ],
        },
        {
          duration: 450,
          easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
          pseudoElement: '::view-transition-new(root)',
        },
      )
    }).catch(() => {
      // View Transition 被中止（快速连点主题、过渡被新的过渡顶掉）时 ready 会
      // 以 AbortError reject。主题本身已经切好了，这里只是不长动画 ——
      // 不吞掉的话会变成未处理的 rejection，污染全局错误上报。
    })
  }, [theme, setTheme])
}
