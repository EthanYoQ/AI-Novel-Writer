import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import HomeSidebarPanel from '../HomeSidebarPanel'

const originalLocaleState = useLocaleStore.getState()
const originalProjectState = useProjectStore.getState()
const movedProject = {
  name: '已移动的项目',
  path: 'C:\\novels\\moved-away',
  updatedAt: '2026-09-01T00:00:00.000Z',
}

let root: Root
let container: HTMLDivElement
let invoke: ReturnType<typeof vi.fn>

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(async () => {
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'project:recent-remove') return { success: true }
    throw new Error(`unexpected channel ${channel}`)
  })
  Object.defineProperty(window, 'velaAPI', {
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
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ currentProject: null, recentProjects: [movedProject] })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<HomeSidebarPanel />))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(window, 'velaAPI')
  useLocaleStore.setState(originalLocaleState)
  useProjectStore.setState(originalProjectState)
})

describe('HomeSidebarPanel recent project removal', () => {
  it('removes a stale recent-project record without deleting project data', async () => {
    await act(async () => page.getByRole('button', { name: '从最近项目移除' }).click())
    await expect.element(page.getByRole('dialog')).toBeVisible()
    await expect.element(page.getByText('这只会移除列表记录，不会删除项目文件。')).toBeVisible()
    await act(async () => {
      await page.getByRole('button', { name: '移除记录' }).click()
      await new Promise(resolve => setTimeout(resolve, 250))
    })

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('project:recent-remove', movedProject.path))
    expect(useProjectStore.getState().recentProjects).toEqual([])
    expect(invoke.mock.calls.some(([channel]) => channel === 'project:delete')).toBe(false)
  })
})
