import '../../../index.css'
import '../../../styles/paper-ink/index.css'
import { page } from 'vitest/browser'
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import RendererStartup from '../RendererStartup'
import { useLocaleStore } from '../../../stores/locale-store'
const originalLocale = useLocaleStore.getState()
import { useAppearanceStore, type AppearanceBootstrapDependencies } from '../../../stores/appearance-bootstrap'
import { APPEARANCE_STORAGE_KEY, LEGACY_THEME_STORAGE_KEY, PREVIOUS_APPEARANCE_STORAGE_KEY, INITIAL_APPEARANCE, serializeAppearanceProfile } from '../../../shared/appearance-profile'
import { registerStartupController, type StartupEvent } from '../../../../electron/controllers/startup-controller'
import { ipc } from '../../../services/ipc-client'

let host: HTMLDivElement
let root: Root
const noticeStorageKey = 'ai-novel-writer-dismissed-migration-generation'
/** 旧版本单独存的界面版本键：迁移不读也不写。 */
const OLD_SHELL_STORAGE_KEY = 'ai-novel-writer-ui-version'
const keys = [APPEARANCE_STORAGE_KEY, PREVIOUS_APPEARANCE_STORAGE_KEY, LEGACY_THEME_STORAGE_KEY, OLD_SHELL_STORAGE_KEY, noticeStorageKey, 'startup-unrelated-model']
const dependencies = (overrides: Partial<AppearanceBootstrapDependencies> = {}): AppearanceBootstrapDependencies => ({
  waitForMainReady: async () => ({ state: 'ready', globalGeneration: '启动世代' }),
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
  const dep = dependencies({ waitForMainReady: async () => { await main; return { state: 'ready', globalGeneration: '启动世代' } } })
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

it('无效旧字体由作者重置后仍等待原启动确认，并保留旧键及无关配置', async () => {
  const legacy = JSON.stringify({ state: { writingFont: 'retired-font' }, version: 1 })
  localStorage.setItem(LEGACY_THEME_STORAGE_KEY, legacy)
  localStorage.setItem(OLD_SHELL_STORAGE_KEY, 'v1')
  localStorage.setItem('startup-unrelated-model', '合成模型选择')
  let release!: (accepted: boolean) => void
  const confirmation = new Promise<boolean>(resolve => { release = resolve })
  const acknowledgeReadback = vi.fn(() => confirmation)
  const load = vi.fn(async () => ({ default: () => <p>恢复后的工作台</p> }))
  const dep = dependencies({ acknowledgeReadback })
  await act(async () => root.render(<RendererStartup dependencies={dep} loadWorkspace={load} />))
  await vi.waitFor(() => expect(useAppearanceStore.getState().phase).toBe('blocked'))
  expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBeNull()
  expect(acknowledgeReadback).not.toHaveBeenCalled()
  await act(async () => page.getByRole('button', { name: '重置外观偏好为默认（不影响其它配置）', exact: true }).click())
  await vi.waitFor(() => expect(acknowledgeReadback).toHaveBeenCalledOnce())
  expect(useAppearanceStore.getState().phase).toBe('pending')
  expect(load).not.toHaveBeenCalled()
  await act(async () => { release(true); await confirmation })
  await vi.waitFor(() => expect(host.textContent).toContain('恢复后的工作台'))
  expect(useAppearanceStore.getState().profile).toMatchObject({ writingFont: 'lxgw-wenkai', uiFont: 'noto-sans-sc', origin: 'author' })
  expect(localStorage.getItem(LEGACY_THEME_STORAGE_KEY)).toBe(legacy)
  expect(localStorage.getItem(OLD_SHELL_STORAGE_KEY)).toBe('v1')
  expect(localStorage.getItem('startup-unrelated-model')).toBe('合成模型选择')
})

it.each(['saved', 'newer', 'newer-dark', 'corrupt', 'removed'])('已确认高版本后工作台加载失败，重置 %s 外观可在同窗口恢复', async stored => {
  localStorage.setItem(APPEARANCE_STORAGE_KEY, serializeAppearanceProfile({ ...INITIAL_APPEARANCE, revision: 7, colorTheme: 'dark' }))
  const sender = { id: 1, mainFrame: { url: 'file:///startup/index.html' }, isDestroyed: () => false }
  const event = { sender, senderFrame: sender.mainFrame }
  const handlers = new Map<string, (event: StartupEvent, input?: unknown) => unknown>()
  registerStartupController({
    ipc: { handle: (channel, handler) => { handlers.set(channel, handler) } },
    getTrustedSender: () => sender, rendererUrl: sender.mainFrame.url,
    getGlobalGeneration: () => '启动世代',
    getBlockedCode: () => undefined,
  })
  const acknowledgeReadback = vi.fn<AppearanceBootstrapDependencies['acknowledgeReadback']>(async ack =>
    handlers.get('startup:appearance-ack')!(event, ack) === true)
  const dep = dependencies({ acknowledgeReadback })
  const load = vi.fn(async () => ({ default: () => <p>同窗口恢复的工作台</p> }))
    .mockRejectedValueOnce(new Error('fixture workspace module unavailable'))
  await act(async () => root.render(<RendererStartup dependencies={dep} loadWorkspace={load} />))
  await vi.waitFor(() => expect(host.textContent).toContain('工作台暂时无法加载'))
  expect(acknowledgeReadback).toHaveBeenCalledExactlyOnceWith({
    storageKey: APPEARANCE_STORAGE_KEY, profileRevision: 7, globalGeneration: '启动世代',
  })
  if (stored === 'newer') localStorage.setItem(APPEARANCE_STORAGE_KEY, serializeAppearanceProfile({ ...INITIAL_APPEARANCE, revision: 9 }))
  if (stored === 'newer-dark') localStorage.setItem(APPEARANCE_STORAGE_KEY, serializeAppearanceProfile({ ...INITIAL_APPEARANCE, revision: 9, colorTheme: 'dark' }))
  if (stored === 'corrupt') localStorage.setItem(APPEARANCE_STORAGE_KEY, '{corrupt')
  if (stored === 'removed') localStorage.removeItem(APPEARANCE_STORAGE_KEY)
  await act(async () => page.getByRole('button', { name: '重置外观偏好为默认（不影响其它配置）', exact: true }).click())
  await vi.waitFor(() => expect(host.textContent).toContain('同窗口恢复的工作台'))
  expect(useAppearanceStore.getState().profile).toMatchObject({ revision: stored.startsWith('newer') ? 10 : 8, colorTheme: 'light', origin: 'author' })
  expect(JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY)!)).toMatchObject({ schemaVersion: 3, colorTheme: 'light' })
  expect(acknowledgeReadback).toHaveBeenCalledTimes(2)
  expect(load).toHaveBeenCalledTimes(2)
})

it.each([
  ['损坏', '{corrupt'],
  ['带外壳偏好', JSON.stringify({ ...JSON.parse(serializeAppearanceProfile({ ...INITIAL_APPEARANCE, revision: 4 })), shellPreference: 'stage' })],
  ['未来版本', JSON.stringify({ ...JSON.parse(serializeAppearanceProfile({ ...INITIAL_APPEARANCE, revision: 4 })), schemaVersion: 4 })],
])('冷启动时外观配置%s而受阻，点重置后进入工作台，存储写成初始的浅色 v3，RD-10 之前的配置不动', async (_, stored) => {
  const previous = JSON.stringify({ schemaVersion: 1, revision: 2, shellPreference: 'writer', colorTheme: 'galaxy', zoom: 1,
    writingFont: 'lxgw-wenkai', uiFont: 'noto-sans-sc', origin: 'author', legacyImportCompleted: true })
  localStorage.setItem(PREVIOUS_APPEARANCE_STORAGE_KEY, previous)
  localStorage.setItem(APPEARANCE_STORAGE_KEY, stored)
  const sender = { id: 1, mainFrame: { url: 'file:///startup/index.html' }, isDestroyed: () => false }
  const event = { sender, senderFrame: sender.mainFrame }
  const handlers = new Map<string, (event: StartupEvent, input?: unknown) => unknown>()
  registerStartupController({
    ipc: { handle: (channel, handler) => { handlers.set(channel, handler) } },
    getTrustedSender: () => sender, rendererUrl: sender.mainFrame.url,
    getGlobalGeneration: () => '启动世代',
    getBlockedCode: () => undefined,
  })
  const dep = dependencies({ acknowledgeReadback: async ack => handlers.get('startup:appearance-ack')!(event, ack) === true })
  const load = vi.fn(async () => ({ default: () => <p>重置后的工作台</p> }))
  await act(async () => root.render(<RendererStartup dependencies={dep} loadWorkspace={load} />))
  await vi.waitFor(() => expect(host.textContent).toContain('启动尚未完成'))
  expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe(stored)
  await act(async () => page.getByRole('button', { name: '重置外观偏好为默认（不影响其它配置）', exact: true }).click())
  await vi.waitFor(() => expect(host.textContent).toContain('重置后的工作台'))
  expect(JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY)!)).toMatchObject({ schemaVersion: 3, colorTheme: 'light', origin: 'author' })
  expect(localStorage.getItem(PREVIOUS_APPEARANCE_STORAGE_KEY)).toBe(previous)
  expect(useAppearanceStore.getState()).toMatchObject({ phase: 'migrated' })
})

it('重置写入失败保留原字节与加载失败页面', async () => {
  const original = serializeAppearanceProfile({ ...INITIAL_APPEARANCE, revision: 7, colorTheme: 'dark' })
  localStorage.setItem(APPEARANCE_STORAGE_KEY, original)
  const load = vi.fn(async () => ({ default: () => <p>工作台不应加载</p> }))
    .mockRejectedValueOnce(new Error('fixture workspace module unavailable'))
  await act(async () => root.render(<RendererStartup dependencies={dependencies()} loadWorkspace={load} />))
  await vi.waitFor(() => expect(host.textContent).toContain('工作台暂时无法加载'))
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('fixture quota', 'QuotaExceededError') })
  await act(async () => page.getByRole('button', { name: '重置外观偏好为默认（不影响其它配置）', exact: true }).click())
  expect(host.textContent).toContain('工作台暂时无法加载')
  expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe(original)
  expect(load).toHaveBeenCalledOnce()
})

it.each([
  ['corrupt', 'none'], ['removed', 'none'], ['removed', 'write'], ['corrupt', 'readback'],
] as const)('ACK8 后存储 %s 且重置故障为 %s，再次重置保留已接受版本并恢复工作台', async (stored, fault) => {
  localStorage.setItem(APPEARANCE_STORAGE_KEY, serializeAppearanceProfile({ ...INITIAL_APPEARANCE, revision: 7 }))
  const sender = { id: 1, mainFrame: { url: 'file:///startup/index.html' }, isDestroyed: () => false }
  const event = { sender, senderFrame: sender.mainFrame }
  const handlers = new Map<string, (event: StartupEvent, input?: unknown) => unknown>()
  registerStartupController({
    ipc: { handle: (channel, handler) => { handlers.set(channel, handler) } },
    getTrustedSender: () => sender, rendererUrl: sender.mainFrame.url,
    getGlobalGeneration: () => '启动世代',
    getBlockedCode: () => undefined,
  })
  const acknowledgements: { revision: number; accepted: boolean }[] = []
  let failReset = false
  const dep = dependencies({
    storage: () => ({
      getItem: key => localStorage.getItem(key),
      setItem: (key, value) => {
        if (failReset && fault === 'write') throw new DOMException('fixture quota', 'QuotaExceededError')
        localStorage.setItem(key, value)
        if (failReset && fault === 'readback') localStorage.removeItem(key)
      },
    }),
    acknowledgeReadback: async ack => {
      const accepted = handlers.get('startup:appearance-ack')!(event, ack) === true
      acknowledgements.push({ revision: ack.profileRevision, accepted })
      expect(useAppearanceStore.getState().update({ colorTheme: 'dark' })).toBe(false)
      if (ack.profileRevision === 8 && accepted) {
        if (stored === 'corrupt') localStorage.setItem(APPEARANCE_STORAGE_KEY, '{corrupt')
        else localStorage.removeItem(APPEARANCE_STORAGE_KEY)
      }
      return accepted
    },
  })
  const load = vi.fn(async () => ({ default: () => <p>再次重置恢复的工作台</p> }))
    .mockRejectedValueOnce(new Error('fixture workspace module unavailable'))
  await act(async () => root.render(<RendererStartup dependencies={dep} loadWorkspace={load} />))
  await vi.waitFor(() => expect(host.textContent).toContain('工作台暂时无法加载'))
  await act(async () => page.getByRole('button', { name: '重置外观偏好为默认（不影响其它配置）', exact: true }).click())
  await vi.waitFor(() => expect(useAppearanceStore.getState()).toMatchObject({
    phase: 'blocked', profile: null, failureCode: 'APPEARANCE_CHANGED_DURING_ACK',
  }))
  expect(acknowledgements).toEqual([{ revision: 7, accepted: true }, { revision: 8, accepted: true }])
  expect(load).toHaveBeenCalledOnce()
  if (fault !== 'none') {
    failReset = true
    await act(async () => page.getByRole('button', { name: '重置外观偏好为默认（不影响其它配置）', exact: true }).click())
    expect(useAppearanceStore.getState()).toMatchObject({ phase: 'blocked', profile: null })
    expect(acknowledgements).toHaveLength(2)
    expect(load).toHaveBeenCalledOnce()
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
    failReset = false
  }
  await act(async () => page.getByRole('button', { name: '重置外观偏好为默认（不影响其它配置）', exact: true }).click())
  await vi.waitFor(() => expect(useAppearanceStore.getState().phase).not.toBe('pending'))
  expect(acknowledgements).toEqual([
    { revision: 7, accepted: true }, { revision: 8, accepted: true }, { revision: 9, accepted: true },
  ])
  await vi.waitFor(() => expect(host.textContent).toContain('再次重置恢复的工作台'))
  expect(useAppearanceStore.getState().profile).toMatchObject({ revision: 9, origin: 'author' })
  expect(load).toHaveBeenCalledTimes(2)
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

it('已挂载的真实 App 在偏好写入失败后仍保留新外壳', async () => {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'config:get') return { locale: 'zh-CN' }
    if (channel === 'project:recent-list') return []
    if (channel === 'llm:list-models') return []
    if (channel === 'llm:get-stage-models') return {}
    if (channel === 'update:get-state') return { status: 'disabled', currentVersion: '', isReminderDeferred: false }
    return null
  })
  window.aiNovelAPI = { invoke, on: () => () => {}, once: () => {}, send: () => {}, setZoomLevel: () => {}, setZoomFactor: () => {} } as unknown as NonNullable<Window['aiNovelAPI']>
  await act(async () => root.render(<RendererStartup dependencies={dependencies()} loadWorkspace={() => import('../../../App')} />))
  await vi.waitFor(() => expect(host.querySelector('[data-shell-presentation="stage"]')).not.toBeNull(), { timeout: 5000 })
  const shell = host.querySelector('[data-shell-presentation="stage"]')
  localStorage.setItem(APPEARANCE_STORAGE_KEY, '外部变化')
  await act(async () => { expect(useAppearanceStore.getState().update({ colorTheme: 'dark' })).toBe(false) })
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('当前工作台保持原状')
  expect(host.querySelector('[data-shell-presentation="stage"]')).toBe(shell)
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
    state: 'ready', globalGeneration: '启动世代',
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

/** 计算出的颜色的相对亮度（0 黑 1 白）。先画到画布上换成 sRGB，oklch 等写法也能比。 */
const luminance = (color: string) => {
  const context = document.createElement('canvas').getContext('2d')!
  context.fillStyle = color
  context.fillRect(0, 0, 1, 1)
  const [r, g, b] = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => {
    const channel = value / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

it.each(['dark', 'light'] as const)('迁移提示条跟随外观主题用纸墨面板与文字色（%s）', async colorTheme => {
  localStorage.setItem(APPEARANCE_STORAGE_KEY, serializeAppearanceProfile({ ...INITIAL_APPEARANCE, colorTheme, revision: 3, origin: 'author' }))
  const dep = dependencies({ waitForMainReady: async () => ({
    state: 'ready', globalGeneration: '启动世代', migrationNotice: { legacySourceIgnored: true, preservedUnknownCount: 0 } }) })
  await act(async () => root.render(<RendererStartup dependencies={dep} loadWorkspace={async () => ({ default: () => <p>合成工作台</p> })} />))
  await vi.waitFor(() => expect(host.querySelector('.startup-migration-notice')).not.toBeNull())
  const notice = host.querySelector<HTMLElement>('.startup-migration-notice')!
  const [background, ink] = [luminance(getComputedStyle(notice).backgroundColor), luminance(getComputedStyle(notice).color)]
  expect(colorTheme === 'dark' ? background < 0.05 && ink > 0.5 : background > 0.8 && ink < 0.05).toBe(true)
})

it('启动受阻页在深色系统主题下是深底浅字', async () => {
  localStorage.setItem(LEGACY_THEME_STORAGE_KEY, '{损坏的偏好')
  await act(async () => root.render(<RendererStartup dependencies={dependencies({ systemTheme: () => 'dark' })} />))
  await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull())
  const main = host.querySelector<HTMLElement>('main')!
  expect(luminance(getComputedStyle(main).backgroundColor)).toBeLessThan(0.05)
  expect(luminance(getComputedStyle(main.querySelector('h1')!).color)).toBeGreaterThan(0.5)
})

it('同一迁移世代的通知关闭后重启不再出现，新迁移世代仍出现', async () => {
  let generation = '启动世代'
  const load = vi.fn(async () => ({ default: () => <p>合成工作台</p> }))
  const dep = dependencies({
    waitForMainReady: async () => ({ state: 'ready', globalGeneration: generation,
      migrationNotice: { legacySourceIgnored: true, preservedUnknownCount: 1 } }),
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
    waitForMainReady: async () => ({ state: 'ready', globalGeneration: '启动世代',
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
