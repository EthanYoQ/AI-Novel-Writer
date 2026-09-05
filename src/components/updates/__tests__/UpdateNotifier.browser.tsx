import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useLocaleStore } from '../../../stores/locale-store'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
  Object.assign(window, {
    velaAPI: {
      invoke: vi.fn(async (channel: string) => channel === 'update:get-state'
        ? {
            status: 'available',
            currentVersion: '0.9.2',
            availableVersion: '9.8.7',
            updateAction: 'download',
            isReminderDeferred: false,
          }
        : null),
      on: vi.fn(() => () => {}),
      once: vi.fn(),
      send: vi.fn(),
      setZoomLevel: vi.fn(),
      setZoomFactor: vi.fn(),
      getZoomLevel: vi.fn(() => 0),
    },
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(window, 'velaAPI')
  vi.restoreAllMocks()
})

describe('UpdateNotifier locale changes', () => {
  it('replaces an active update notice in the newly selected locale', async () => {
    const dismiss = vi.fn()
    const { actionToast } = await import('../../ui/ActionToast')
    const show = vi.spyOn(actionToast, 'show').mockReturnValue(dismiss)
    const { UpdateNotifier } = await import('../UpdateNotifier')
    await act(async () => root.render(<UpdateNotifier />))
    await vi.waitFor(() => expect(show).toHaveBeenCalledOnce())
    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      message: '发现新版本 v9.8.7',
      actions: [expect.objectContaining({ label: '查看更新' })],
    }))

    await act(async () => {
      useLocaleStore.setState(state => ({
        locale: 'en-US',
        text: (_zhCNText, enUSText) => enUSText,
        t: state.t,
      }))
    })

    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(2))
    expect(dismiss).toHaveBeenCalledOnce()
    expect(show).toHaveBeenLastCalledWith(expect.objectContaining({
      message: 'New version v9.8.7 is available',
      actions: [expect.objectContaining({ label: 'View update' })],
    }))
  })
})
