import { describe, expect, it, vi } from 'vitest'
import type { AiNovelAPI } from '../../src/shared/desktop-api'

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), once: vi.fn(), send: vi.fn(), removeListener: vi.fn() },
  webFrame: { setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn() },
}))
vi.mock('electron', () => electron)
await import('../preload')

describe('桌面预加载接口', () => {
  it('仅提供规范接口，事件回调不暴露 Electron 事件对象', async () => {
    expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledTimes(1)
    const [name, bridge] = electron.contextBridge.exposeInMainWorld.mock.calls[0] as [string, AiNovelAPI]
    expect(name).toBe('aiNovelAPI')
    const listener = vi.fn()
    const unsubscribe = bridge.on('project:opened', listener)
    const [, handler] = electron.ipcRenderer.on.mock.calls[0] as [string, (...args: unknown[]) => void]
    const privateEvent = { sender: '不应进入渲染进程' }
    handler(privateEvent, { projectId: '项目甲' })
    expect(listener).toHaveBeenCalledWith({ projectId: '项目甲' })
    unsubscribe()
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith('project:opened', handler)
    electron.ipcRenderer.invoke.mockResolvedValue({ success: true })
    await expect(bridge.invoke('project:open', '合成项目')).resolves.toEqual({ success: true })
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('project:open', '合成项目')
  })
})
