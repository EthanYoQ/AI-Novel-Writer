import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useProjectStore } from '../project-store'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('../../services/ipc-client', () => ({
  ipc: { invoke, invokeWithProjectSession: vi.fn() },
}))

beforeEach(() => {
  invoke.mockReset()
  useProjectStore.setState({ recentProjects: [], recentProjectsLoaded: false })
})

describe('最近项目是否已读到', () => {
  it('读到列表（包括空列表）后才算读过', async () => {
    invoke.mockResolvedValueOnce([])
    expect(useProjectStore.getState().recentProjectsLoaded).toBe(false)
    await useProjectStore.getState().loadRecentProjects()
    expect(useProjectStore.getState()).toMatchObject({ recentProjects: [], recentProjectsLoaded: true })
  })

  it('读取失败也算读过，书房不会一直停在等待里', async () => {
    invoke.mockRejectedValueOnce(new Error('IPC 不可用'))
    await expect(useProjectStore.getState().loadRecentProjects()).rejects.toThrow('IPC 不可用')
    expect(useProjectStore.getState().recentProjectsLoaded).toBe(true)
  })

  it('被更新的一次读取取代时，旧请求的失败不改状态', async () => {
    let rejectFirst: (error: Error) => void = () => undefined
    invoke.mockReturnValueOnce(new Promise((_, reject) => { rejectFirst = reject }))
    invoke.mockReturnValueOnce(new Promise(() => undefined))
    const first = useProjectStore.getState().loadRecentProjects()
    void useProjectStore.getState().loadRecentProjects()
    rejectFirst(new Error('过期'))
    await expect(first).rejects.toThrow('过期')
    expect(useProjectStore.getState().recentProjectsLoaded).toBe(false)
  })
})
