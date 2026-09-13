import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  setActiveProjectSessionContext,
} from '../../shared/project-session-context'
import { ipc } from '../ipc-client'

const invoke = vi.fn()

beforeEach(() => {
  invoke.mockReset()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      aiNovelAPI: {
        invoke,
        on: () => () => {},
        once: () => {},
        send: () => {},
        setZoomLevel: () => {},
        setZoomFactor: () => {},
        getZoomLevel: () => 0,
      },
    },
  })
  setActiveProjectSessionContext({
    projectId: 'project-A',
    leaseId: 'lease-A',
    projectPath: 'C:/projects/A',
  })
})

afterEach(() => {
  setActiveProjectSessionContext(null)
  Reflect.deleteProperty(globalThis, 'window')
})

describe('project-scoped IPC session transport', () => {
  it('rejects a missing canonical bridge without invoking the legacy write API', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { velaAPI: { invoke } },
    })

    expect(ipc.isElectron).toBe(false)
    await expect(ipc.invoke('fs:grant-write-file', 'grant-1', '正文.txt', '中文正文')).rejects.toThrow('aiNovelAPI 未就绪')
    expect(() => ipc.send('window:close')).toThrow('aiNovelAPI 未就绪')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('appends the frozen active session to a project database request', async () => {
    invoke.mockResolvedValue([])

    await ipc.invoke('db:blueprint-get-all', 'C:/projects/A')

    expect(invoke).toHaveBeenCalledWith(
      'db:blueprint-get-all',
      'C:/projects/A',
      {
        projectId: 'project-A',
        leaseId: 'lease-A',
        projectPath: 'C:/projects/A',
      },
    )
  })

  it('allows a capability-grant filesystem request without an active project session', async () => {
    invoke.mockResolvedValue({ success: true })
    setActiveProjectSessionContext(null)

    await ipc.invoke('fs:grant-write-file', 'grant-export-1', 'chapter.txt', 'content')

    expect(invoke).toHaveBeenCalledWith(
      'fs:grant-write-file',
      'grant-export-1',
      'chapter.txt',
      'content',
    )
  })
})
