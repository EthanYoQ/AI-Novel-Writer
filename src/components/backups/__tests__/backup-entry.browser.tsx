/* eslint-disable react-refresh/only-export-components */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import TitleBar from '../../layout/TitleBar'
import { WriterWelcomePage } from '../../pages/v2/use-project-overview'
import SettingsModal from '../../settings/SettingsModal'
import { useLayoutStore } from '../../../stores/layout-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const originalLayout = useLayoutStore.getState()
const originalLocale = useLocaleStore.getState()
const originalProject = useProjectStore.getState()

let container: HTMLDivElement
let root: Root
let invoke: ReturnType<typeof vi.fn>

function SettingsHarness() {
  const open = useLayoutStore(state => state.settingsOpen)
  const close = useLayoutStore(state => state.closeSettings)
  return <SettingsModal open={open} onClose={close} />
}

beforeEach(() => {
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'update:get-state') return { status: 'disabled', currentVersion: '', isReminderDeferred: false }
    if (channel === 'llm:list-models') return []
    return { success: true }
  })
  Object.defineProperty(window, 'aiNovelAPI', {
    configurable: true,
    value: {
      invoke,
      on: vi.fn(() => () => {}),
      once: vi.fn(),
      send: vi.fn(),
      setZoomLevel: vi.fn(),
      setZoomFactor: vi.fn(),
      getZoomLevel: vi.fn(() => 0),
    },
  })
  useLayoutStore.setState({ settingsOpen: false, settingsSection: 'llm' })
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ currentProject: null, recentProjects: [] })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useLayoutStore.setState(originalLayout, true)
  useLocaleStore.setState(originalLocale, true)
  useProjectStore.setState(originalProject, true)
  Reflect.deleteProperty(window, 'aiNovelAPI')
})

describe('backup production entries', () => {
  it('keeps both settings entries on llm and opens backup from the TitleBar', async () => {
    await act(async () => root.render(<TitleBar />))
    const settingsButtons = [...container.querySelectorAll<HTMLButtonElement>('[title="设置"]')]
    expect(settingsButtons).toHaveLength(2)

    for (const button of settingsButtons) {
      useLayoutStore.getState().closeSettings()
      useLayoutStore.setState({ settingsSection: 'about' })
      await act(async () => button.click())
      expect(useLayoutStore.getState()).toMatchObject({ settingsOpen: true, settingsSection: 'llm' })
    }

    useLayoutStore.getState().closeSettings()
    const backupButton = [...container.querySelectorAll('button')]
      .find(button => button.textContent?.includes('备份')) as HTMLButtonElement
    await act(async () => backupButton.click())
    expect(useLayoutStore.getState()).toMatchObject({ settingsOpen: true, settingsSection: 'backup' })
  })

  it('offers the Writer welcome backup slot as the same settings request', async () => {
    await act(async () => {
      root.render(<WriterWelcomePage onNewProject={vi.fn()} />)
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    const backupButton = [...container.querySelectorAll('button')]
      .find(button => button.textContent?.includes('项目备份')) as HTMLButtonElement
    expect(backupButton).toBeTruthy()
    await act(async () => backupButton.click())
    expect(useLayoutStore.getState()).toMatchObject({ settingsOpen: true, settingsSection: 'backup' })
  })

  it('defaults both settings entries to llm, syncs external sections, and reopens on a new request', async () => {
    await act(async () => root.render(<><TitleBar /><SettingsHarness /></>))
    const settingsButtons = [...container.querySelectorAll<HTMLButtonElement>('[title="设置"]')]

    await act(async () => settingsButtons[0]?.click())
    await vi.waitFor(() => expect(container.querySelector('h2')?.textContent).toBe('AI 生成模型'))
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="关闭设置"]')?.click())
    expect(useLayoutStore.getState().settingsOpen).toBe(false)

    await act(async () => settingsButtons[1]?.click())
    await vi.waitFor(() => expect(container.querySelector('h2')?.textContent).toBe('AI 生成模型'))
    await act(async () => useLayoutStore.getState().openSettings('about'))
    await vi.waitFor(() => expect(container.querySelector('h2')?.textContent).toBe('关于'))
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="关闭设置"]')?.click())

    await act(async () => useLayoutStore.getState().openSettings('backup'))
    await vi.waitFor(() => expect(container.querySelector('h2')?.textContent).toBe('项目备份'))
    expect(container.textContent).toContain('请先打开一个项目')
  })
})
