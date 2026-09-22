/* eslint-disable react-refresh/only-export-components */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'

import '../../../../index.css'
import { useAppearanceStore } from '../../../../stores/appearance-bootstrap'
import { useLayoutStore } from '../../../../stores/layout-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import LeftToolWindowBar from '../../LeftToolWindowBar'
import TitleBar from '../../TitleBar'
import SettingsModal from '../../../settings/SettingsModal'
import ShellV2 from '../ShellV2'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const originalLayout = useLayoutStore.getState()
const originalProject = useProjectStore.getState()
const originalAppearance = useAppearanceStore.getState()
const originalLocale = useLocaleStore.getState()
const originalBridge = Object.getOwnPropertyDescriptor(window, 'aiNovelAPI')

function Settings() {
  const open = useLayoutStore(state => state.settingsOpen)
  const close = useLayoutStore(state => state.closeSettings)
  return <SettingsModal open={open} onClose={close} />
}

afterEach(() => {
  useLayoutStore.setState(originalLayout, true)
  useProjectStore.setState(originalProject, true)
  useAppearanceStore.setState(originalAppearance, true)
  useLocaleStore.setState(originalLocale, true)
  if (originalBridge) Object.defineProperty(window, 'aiNovelAPI', originalBridge)
  else Reflect.deleteProperty(window, 'aiNovelAPI')
  vi.restoreAllMocks()
})

it('V3 rail and masthead open the sibling settings sheet with the same paper and backup commands', async () => {
  await page.viewport(1440, 900)
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'cloud-backup:view') return { success: true, state: 'unconfigured', binding: null, account: null }
    if (channel.startsWith('dialog:select-project-archive')) return null
    if (channel === 'update:get-state') return { status: 'disabled', currentVersion: '', isReminderDeferred: false }
    if (channel === 'llm:list-models') return []
    return { success: true }
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: {
    invoke, on: vi.fn(() => () => {}), once: vi.fn(), send: vi.fn(),
    setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn(() => 0),
  } })
  useAppearanceStore.setState({ resolvedShell: 'writer' })
  useLocaleStore.setState({ locale: 'zh-CN' })
  useLayoutStore.setState({ settingsOpen: false, settingsSection: 'llm', sidebarView: 'project' })
  useProjectStore.setState({ currentProject: {
    id: 'v3-settings', name: '设置旅程', path: 'C:/v3/settings', sessionLease: 'v3-settings-lease', novelConfig: {},
  } as never })

  const host = document.createElement('div')
  host.className = 'app-skin-root'
  host.dataset.theme = 'light'
  host.dataset.skin = 'classic'
  host.style.height = '900px'
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<>
      <ShellV2 presentation="writer" variant="v3" theme="light" titleBar={<TitleBar />}
        rail={<LeftToolWindowBar />} sidebar={<span>目录</span>} editor={<span>正文</span>}
        aiPanel={<span>助手</span>} bottom={<span>任务</span>} statusBar={<span>本地写作</span>} />
      <Settings />
    </>))
    await act(async () => host.querySelector<HTMLButtonElement>('.writer-left-rail button[title="设置"]')!.click())
    expect(host.querySelector('h2')?.textContent).toBe('AI 生成模型')
    const shell = host.querySelector<HTMLElement>('.v3-magazine-shell')!
    const dialog = host.querySelector<HTMLElement>('.skin-solid-surface > div')!
    expect(getComputedStyle(dialog).getPropertyValue('--v3-paper').trim()).toBe(getComputedStyle(shell).getPropertyValue('--v3-paper').trim())
    expect(getComputedStyle(dialog).fontFamily).toContain('Noto Sans SC')
    expect(getComputedStyle(dialog).backgroundColor).toBe('rgb(251, 251, 252)')
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="关闭设置"]')!.click())

    await act(async () => host.querySelector<HTMLButtonElement>('.writer-topbar button[title="备份"]')!.click())
    await vi.waitFor(() => expect(host.querySelector('h2')?.textContent).toBe('项目备份'))
    expect(host.querySelector('[data-testid="project-backup-panel"]')?.textContent).toContain('WebDAV')
    expect(host.textContent).toContain('从本地存档恢复副本')
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('导出本地存档'))!.click())
    expect(invoke.mock.calls.some(([channel]) => channel === 'dialog:select-project-archive-export')).toBe(true)
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('从本地存档恢复副本'))!.click())
    expect(invoke.mock.calls.some(([channel]) => channel === 'dialog:select-project-archive')).toBe(true)
    expect(invoke.mock.calls.some(([channel]) => channel === 'cloud-backup:view')).toBe(true)
    expect(invoke.mock.calls.some(([channel]) => channel === 'project:archive-export' || channel === 'project:archive-restore')).toBe(false)

    host.dataset.theme = 'dark'
    await act(async () => root.render(<>
      <ShellV2 presentation="writer" variant="v3" theme="dark" titleBar={<TitleBar />}
        rail={<LeftToolWindowBar />} sidebar={<span>目录</span>} editor={<span>正文</span>}
        aiPanel={<span>助手</span>} bottom={<span>任务</span>} statusBar={<span>本地写作</span>} />
      <Settings />
    </>))
    const darkDialog = host.querySelector<HTMLElement>('.skin-solid-surface > div')!
    expect(getComputedStyle(darkDialog).getPropertyValue('--v3-paper').trim()).toBe('#171b25')
    expect(getComputedStyle(darkDialog).backgroundColor).toBe('rgb(23, 27, 37)')

    await act(async () => root.render(<>
      <ShellV2 presentation="classic" variant="v3" theme="dark" titleBar={<TitleBar />}
        rail={<LeftToolWindowBar />} sidebar={<span>目录</span>} editor={<span>正文</span>}
        aiPanel={<span>助手</span>} bottom={<span>任务</span>} statusBar={<span>本地写作</span>} />
      <Settings />
    </>))
    const classicDialog = host.querySelector<HTMLElement>('.skin-solid-surface > div')!
    expect(getComputedStyle(classicDialog).getPropertyValue('--v3-paper').trim()).toBe('')
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
