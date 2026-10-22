import { createElement, useEffect, useState, type ComponentType } from 'react'
import { useLocaleStore } from '../../stores/locale-store'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'

/** Chromium 动态导入失败的消息：Failed to fetch dynamically imported module: <地址>。 */
const FAILED_MODULE_URL = /dynamically imported module: (\S+)/

/** 能当页面渲染的默认导出：函数组件、类组件，或 memo、forwardRef 包出来的对象。 */
const isComponent = (value: unknown): boolean =>
  typeof value === 'function' || (typeof value === 'object' && value !== null && '$$typeof' in value)

/**
 * 书房冷启动用不到的整页（设定页、设置页）拆成单独的代码块，外壳空下来后预先载入。
 * 不用 React.lazy：它首次渲染一定挂起，Suspense 的揭示节流会让页面晚出现（见 RD-3 的 f89bc700）；
 * 这里载入完成前什么也不画，预载入后打开页面时代码已在手里，直接渲染。
 * entry 是页面入口代码块的文件名前缀（构建产物为 `<entry>-<hash>.js`，开发时为 `<entry>.tsx`）。
 */
export function lazyPage<P extends object>(load: () => Promise<{ default: ComponentType<P> }>, entry: string) {
  let loaded: ComponentType<P> | null = null
  let pending: Promise<boolean> | null = null
  let failedUrl: URL | null = null
  let retries = 0
  // Chromium 记住失败的动态导入，同一地址再 import 不会重新读文件；重试时给失败的入口地址加查询串，换一个模块记录。
  // 失败的若是入口依赖的代码块，入口在这次会话里没法再载入，只按原路重试并保持失败态。
  const attemptLoad = (): Promise<{ default: unknown }> => {
    if (!failedUrl) return load()
    const url = new URL(failedUrl)
    url.searchParams.set('retry', String(++retries))
    return import(/* @vite-ignore */ url.href) as Promise<{ default: unknown }>
  }
  const entryUrl = (error: unknown): URL | null => {
    const found = FAILED_MODULE_URL.exec(error instanceof Error ? error.message : '')?.[1]
    if (!found || !URL.canParse(found)) return null
    const url = new URL(found)
    const file = url.pathname.slice(url.pathname.lastIndexOf('/') + 1)
    return file.startsWith(`${entry}-`) || file.startsWith(`${entry}.`) ? url : null
  }
  // 载入失败时清掉 pending，重试或下次打开页面会重新载入，而不是一直拿着失败的结果。
  const preload = () => (pending ??= attemptLoad().then(
    module => {
      // i18n-exempt: 下面的 catch 只记日志，作者看到的是按语言写好的「页面没有载入」
      if (!isComponent(module.default)) throw new Error(`页面代码块 ${entry} 没有默认导出的组件`)
      loaded = module.default as ComponentType<P>
      return true
    },
  ).catch((error: unknown) => {
    pending = null
    failedUrl ??= entryUrl(error)
    console.warn('[lazyPage] 页面代码载入失败', error)
    return false
  }))

  function Page(props: P) {
    const text = useLocaleStore(s => s.text)
    const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
    const attempt = () => {
      setStatus('loading')
      void preload().then(ok => setStatus(ok ? 'ready' : 'failed'))
    }
    useEffect(() => {
      if (!loaded) attempt()
    }, [])
    if (loaded) return createElement(loaded, props)
    if (status !== 'failed') return null
    return (
      <EmptyState
        heading={text('页面没有载入', 'This page did not load')}
        description={text('页面代码读取失败，作品内容不受影响。', 'The page code could not be read. Your book is not affected.')}
        action={<Button variant="primary" onClick={attempt}>{text('重试', 'Retry')}</Button>}
      />
    )
  }

  return { Page, preload }
}
