import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  invokeWithProjectSession: vi.fn(),
}))

const currentProject = {
  id: 'project-1',
  path: 'C:/novels/project-1',
  sessionLease: 'lease-1',
}

vi.mock('../../ipc-client', () => ({
  ipc: {
    invoke: mocks.invoke,
    invokeWithProjectSession: mocks.invokeWithProjectSession,
    isElectron: true,
  },
}))

vi.mock('../../../stores/project-store', () => ({
  useProjectStore: { getState: () => ({ currentProject }) },
}))

describe('project skill directory loading', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.invoke.mockResolvedValue([])
    mocks.invokeWithProjectSession.mockReset()
  })

  it('does not list an absent optional project skills directory', async () => {
    mocks.invokeWithProjectSession.mockImplementation(async (_session, channel) => {
      if (channel === 'fs:check-exists') return false
      throw new Error(`unexpected channel: ${channel}`)
    })

    const { skillRegistry } = await import('../skill-registry')
    await expect(skillRegistry.loadAll()).resolves.toBeUndefined()

    expect(mocks.invokeWithProjectSession).toHaveBeenCalledOnce()
    expect(mocks.invokeWithProjectSession).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-1', leaseId: 'lease-1' }),
      'fs:check-exists',
      'C:/novels/project-1/.vela/skills',
      currentProject.path,
    )
  })

  it('does not hide project skill directory access failures', async () => {
    const denied = new Error(
      "Error invoking remote method 'fs:list-dir': Error: EACCES: permission denied",
    )
    mocks.invokeWithProjectSession.mockImplementation(async (_session, channel) => {
      if (channel === 'fs:check-exists') return true
      if (channel === 'fs:list-dir') throw denied
      throw new Error(`unexpected channel: ${channel}`)
    })

    const { skillRegistry } = await import('../skill-registry')

    await expect(skillRegistry.loadAll()).rejects.toBe(denied)
  })

  it('lists an existing project skills directory normally', async () => {
    mocks.invokeWithProjectSession.mockImplementation(async (_session, channel) => {
      if (channel === 'fs:check-exists') return true
      if (channel === 'fs:list-dir') return []
      throw new Error(`unexpected channel: ${channel}`)
    })

    const { skillRegistry } = await import('../skill-registry')
    await expect(skillRegistry.loadAll()).resolves.toBeUndefined()

    expect(mocks.invokeWithProjectSession.mock.calls.map(([, channel]) => channel)).toEqual([
      'fs:check-exists',
      'fs:list-dir',
    ])
  })
})
