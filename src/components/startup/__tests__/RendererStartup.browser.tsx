import '../../../index.css'
import { page } from 'vitest/browser'
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import RendererStartup from '../RendererStartup'
import { useLocaleStore } from '../../../stores/locale-store'
const originalLocale = useLocaleStore.getState()
import { useAppearanceStore, type AppearanceBootstrapDependencies } from '../../../stores/appearance-bootstrap'
import { APPEARANCE_STORAGE_KEY, LEGACY_THEME_STORAGE_KEY, LEGACY_UI_STORAGE_KEY } from '../../../shared/appearance-profile'
import { ipc } from '../../../services/ipc-client'

let host: HTMLDivElement
let root: Root
const noticeStorageKey = 'ai-novel-writer-dismissed-migration-generation'
const keys = [APPEARANCE_STORAGE_KEY, LEGACY_THEME_STORAGE_KEY, LEGACY_UI_STORAGE_KEY, noticeStorageKey, 'startup-unrelated-model']
const dependencies = (overrides: Partial<AppearanceBootstrapDependencies> = {}): AppearanceBootstrapDependencies => ({
  waitForMainReady: async () => ({ state: 'ready', globalGeneration: '启动世代', skinRevision: 0 }),
  readSkinSnapshot: async () => ({ globalGeneration: '启动世代', skinRevision: 0, backgroundSkin: 'classic' }),
  acknowledgeReadback: async () => true,
  ...overrides,
})
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
beforeEach(() => {
  keys.forEach(key => localStorage.removeItem(key))
  useAppearanceStore.setState(useAppearanceStore.getInitialState(), true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove()
  keys.forEach(key => localStorage.removeItem(key))
  useAppearanceStore.setState(useAppearanceStore.getInitialState(), true)
  useLocaleStore.setState(originalLocale)
  vi.restoreAllMocks()
  delete window.aiNovelAPI
})

it('主进程确认前不写偏好、不导入工作台；确认后才加载', async () => {
  let release!: () => void
  const main = new Promise<void>(resolve => { release = resolve })
  const load = vi.fn(async () => ({ default: () => <p>合成工作台</p> }))
  const dep = dependencies({ waitForMainReady: async () => { await main; return { state: 'ready', globalGeneration: '启动世代', skinRevision: 0 } } })
  await act(async () => root.render(<RendererStartup dependencies={dep} loadWorkspace={load} />))
  expect(host.textContent).toContain('正在检查现有配置')
  expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBeNull()
  expect(load).not.toHaveBeenCalled()
  await act(async () => { release(); await main })
  await vi.waitFor(() => expect(host.textContent).toContain('合成工作台'))
  expect(load).toHaveBeenCalledTimes(1)
})

it('损坏偏好保留原字节和无关配置，工作台保持关闭', async () => {
  localStorage.setItem(LEGACY_THEME_STORAGE_KEY, '{损坏的偏好')
  localStorage.setItem('startup-unrelated-model', '合成模型选择')
  const load = vi.fn(async () => ({ default: () => <p>工作台不应加载</p> }))
  await act(async () => root.render(<RendererStartup dependencies={dependencies()} loadWorkspace={load} />))
  await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull())
  expect(load).not.toHaveBeenCalled()
  expect(localStorage.getItem(LEGACY_THEME_STORAGE_KEY)).toBe('{损坏的偏好')
  expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBeNull()
  expect(localStorage.getItem('startup-unrelated-model')).toBe('合成模型选择')
})

it('写入后 main 拒绝确认也不加载工作台或删除迁入值', async () => {
  const load = vi.fn(async () => ({ default: () => <p>工作台不应加载</p> }))
  await act(async () => root.render(<RendererStartup dependencies={dependencies({ acknowledgeReadback: async () => false })} loadWorkspace={load} />))
  await vi.waitFor(() => expect(useAppearanceStore.getState().phase).toBe('blocked'))
  expect(load).not.toHaveBeenCalled()
  expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).not.toBeNull()
})

it('启动后偏好写入失败保留已挂载编辑器及其未保存正文', async () => {
  let unmounted = 0
  function Workspace() {
    useEffect(() => () => { unmounted++ }, [])
    return <textarea aria-label="未保存正文" defaultValue="尚未保存的中文正文" />
  }
  const load = vi.fn(async () => ({ default: Workspace }))
  await act(async () => root.render(<RendererStartup dependencies={dependencies()} loadWorkspace={load} />))
  await vi.waitFor(() => expect(host.querySelector('textarea')).not.toBeNull())
  const editor = host.querySelector('textarea')!
  editor.value = '作者刚输入的新句子。'
  localStorage.setItem(APPEARANCE_STORAGE_KEY, '外部变化')
  await act(async () => { expect(useAppearanceStore.getState().update({ colorTheme: 'dark' })).toBe(false) })
  expect(host.querySelector('textarea')).toBe(editor)
  expect(editor.value).toBe('作者刚输入的新句子。')
  expect(unmounted).toBe(0)
  expect(host.querySelector('[role="alert"]')).not.toBeNull()
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('当前工作台保持原状')
  expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe('外部变化')
})

it('已挂载的真实 App 在偏好写入失败后仍呈现 V3', async () => {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'config:get') return { locale: 'zh-CN' }
    if (channel === 'project:recent-list') return []
    if (channel === 'llm:list-models') return []
    if (channel === 'update:get-state') return { status: 'disabled', currentVersion: '', isReminderDeferred: false }
    return null
  })
  window.aiNovelAPI = { invoke, on: () => () => {}, once: () => {}, send: () => {}, setZoomLevel: () => {}, setZoomFactor: () => {} } as unknown as NonNullable<Window['aiNovelAPI']>
  await act(async () => root.render(<RendererStartup dependencies={dependencies()} loadWorkspace={() => import('../../../App')} />))
  await vi.waitFor(() => expect(host.querySelector('[data-shell-presentation="writer"][data-shell-variant="v3"]')).not.toBeNull(), { timeout: 5000 })
  const shell = host.querySelector('[data-shell-presentation="writer"][data-shell-variant="v3"]')
  localStorage.setItem(APPEARANCE_STORAGE_KEY, '外部变化')
  await act(async () => { expect(useAppearanceStore.getState().update({ colorTheme: 'dark' })).toBe(false) })
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('当前工作台保持原状')
  expect(host.querySelector('[data-shell-presentation="writer"][data-shell-variant="v3"]')).toBe(shell)
  expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe('外部变化')
})

it('外观损坏时响应关闭请求，工作台接管后由业务决定未保存正文是否关闭', async () => {
  const listeners = new Set<(value: { requestId: string }) => void>()
  const invoke = vi.fn(async () => ({ success: true }))
  window.aiNovelAPI = {
    invoke,
    on: (_channel: string, callback: (value: { requestId: string }) => void) => {
      listeners.add(callback); return () => listeners.delete(callback)
    },
    setZoomFactor: () => {},
  } as unknown as NonNullable<Window['aiNovelAPI']>
  localStorage.setItem(APPEARANCE_STORAGE_KEY, '{corrupt')
  const dep = dependencies()
  function Workspace() {
    useEffect(() => ipc.on('window:close-requested', ({ requestId }) => {
      void ipc.invoke('window:resolve-close', requestId, 'cancel')
    }), [])
    return <textarea aria-label="业务未保存正文" defaultValue="未保存正文" />
  }
  const load = async () => ({ default: Workspace })
  await act(async () => root.render(<RendererStartup dependencies={dep} loadWorkspace={load} />))
  await vi.waitFor(() => expect(useAppearanceStore.getState().phase).toBe('blocked'))
  expect(listeners.size).toBe(1)
  listeners.forEach(callback => callback({ requestId: 'before-editor' }))
  expect(invoke).toHaveBeenLastCalledWith('window:resolve-close', 'before-editor', 'proceed')
  // Explicit retry after repairing the synthetic preference, without recreating the component.
  localStorage.removeItem(APPEARANCE_STORAGE_KEY)
  await act(async () => (Array.from(host.querySelectorAll('button')).find(button => button.textContent === '重新检查')!).click())
  await vi.waitFor(() => expect(host.querySelector('textarea')).not.toBeNull())
  expect(listeners.size).toBe(1)
  invoke.mockClear()
  listeners.forEach(callback => callback({ requestId: 'after-editor' }))
  expect(invoke).toHaveBeenCalledExactlyOnceWith('window:resolve-close', 'after-editor', 'cancel')
})

it('renders pending and blocked startup messages in English', async () => {
  useLocaleStore.setState({ locale: 'en-US' })
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const dep = dependencies({ waitForMainReady: async () => { await pending; throw new Error('unavailable') } })
  await act(async () => root.render(<RendererStartup dependencies={dep} />))
  expect(host.textContent).toContain('Checking existing settings')
  await act(async () => { release(); await pending })
  await vi.waitFor(() => expect(host.textContent).toContain('Appearance preferences could not be loaded safely'))
  expect(host.textContent).toContain('Check again')
  expect(host.textContent).not.toContain('启动尚未完成')
})

it('migration notice excludes its titlebar overlap from native dragging and dismisses without remounting the workspace', async () => {
  const load = vi.fn(async () => ({ default: () => <textarea aria-label="迁移后未保存正文" defaultValue="保留作者正文" /> }))
  const dep = dependencies({ waitForMainReady: async () => ({
    state: 'ready', globalGeneration: '启动世代', skinRevision: 0,
    migrationNotice: { legacySourceIgnored: true, preservedUnknownCount: 1 },
  }) })
  await act(async () => root.render(<RendererStartup dependencies={dep} loadWorkspace={load} />))
  await vi.waitFor(() => expect(host.querySelector('textarea')).not.toBeNull())
  const editor = host.querySelector('textarea')!
  const notice = host.querySelector<HTMLElement>('[role="status"]')!
  expect(getComputedStyle(notice).getPropertyValue('-webkit-app-region')).toBe('no-drag')
  expect(editor.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  await act(async () => page.getByRole('button', { name: '知道了', exact: true }).click())
  expect(host.querySelector('[role="status"]')).toBeNull()
  expect(host.querySelector('textarea')).toBe(editor)
  expect(editor.value).toBe('保留作者正文')
  expect(load).toHaveBeenCalledOnce()
})

it('同一迁移世代的通知关闭后重启不再出现，新迁移世代仍出现', async () => {
  let generation = '启动世代'
  const load = vi.fn(async () => ({ default: () => <p>合成工作台</p> }))
  const dep = dependencies({
    waitForMainReady: async () => ({ state: 'ready', globalGeneration: generation, skinRevision: 0,
      migrationNotice: { legacySourceIgnored: true, preservedUnknownCount: 1 } }),
    readSkinSnapshot: async () => ({ globalGeneration: generation, skinRevision: 0, backgroundSkin: 'classic' }),
  })
  await act(async () => root.render(<RendererStartup dependencies={dep} loadWorkspace={load} />))
  await vi.waitFor(() => expect(host.textContent).toContain('合成工作台'))
  await act(async () => page.getByRole('button', { name: '知道了', exact: true }).click())
  expect(host.querySelector('.startup-migration-notice')).toBeNull()

  await act(async () => root.unmount())
  useAppearanceStore.setState(useAppearanceStore.getInitialState(), true)
  root = createRoot(host)
  await act(async () => root.render(<RendererStartup dependencies={dep} loadWorkspace={load} />))
  await vi.waitFor(() => expect(host.textContent).toContain('合成工作台'))
  expect(host.querySelector('.startup-migration-notice')).toBeNull()

  await act(async () => root.unmount())
  useAppearanceStore.setState(useAppearanceStore.getInitialState(), true)
  generation = '新迁移世代'
  root = createRoot(host)
  await act(async () => root.render(<RendererStartup dependencies={dep} loadWorkspace={load} />))
  await vi.waitFor(() => expect(host.textContent).toContain('合成工作台'))
  expect(host.querySelector('.startup-migration-notice')).not.toBeNull()
  expect(load).toHaveBeenCalledTimes(3)
})

it.each(['read', 'write'])('迁移通知的 %s storage 失败不阻断工作台或卸载编辑器', async failure => {
  const load = vi.fn(async () => ({ default: () => <textarea defaultValue="保留作者正文" /> }))
  const dep = dependencies({
    waitForMainReady: async () => ({ state: 'ready', globalGeneration: '启动世代', skinRevision: 0,
      migrationNotice: { legacySourceIgnored: true, preservedUnknownCount: 1 } }),
    storage: () => ({
      getItem(key) {
        if (key === noticeStorageKey && failure === 'read') throw new Error('Storage read unavailable')
        return localStorage.getItem(key)
      },
      setItem(key, value) {
        if (key === noticeStorageKey && failure === 'write') throw new Error('Storage write unavailable')
        localStorage.setItem(key, value)
      },
    }),
  })
  await act(async () => root.render(<RendererStartup dependencies={dep} loadWorkspace={load} />))
  await vi.waitFor(() => expect(host.querySelector('textarea')).not.toBeNull())
  const editor = host.querySelector('textarea')!
  editor.value = '作者刚输入的新句子。'
  const appearance = localStorage.getItem(APPEARANCE_STORAGE_KEY)
  await act(async () => page.getByRole('button', { name: '知道了', exact: true }).click())
  expect(host.querySelector('.startup-migration-notice')).toBeNull()
  expect(host.querySelector('textarea')).toBe(editor)
  expect(editor.value).toBe('作者刚输入的新句子。')
  expect(useAppearanceStore.getState().phase).toBe('migrated')
  expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe(appearance)
  expect(load).toHaveBeenCalledOnce()
})
