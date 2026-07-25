import { describe, expect, it, vi } from 'vitest'

import {
  registerUpdateController,
  type UpdateIpcRegistrar,
  type UpdateServiceFacade,
} from '../update-controller'
import type { UpdateActionResponse, UpdateCheckResponse, UpdateState } from '../../services/update-service'

function state(status: UpdateState['status'] = 'idle'): UpdateState {
  return {
    status,
    currentVersion: '0.2.5',
    isReminderDeferred: false,
  }
}

describe('update IPC controller', () => {
  it('exposes typed update actions and forwards only safe state snapshots to the renderer bridge', async () => {
    const handlers = new Map<string, (_event: unknown, ...args: unknown[]) => unknown>()
    const ipc: UpdateIpcRegistrar = {
      handle: (channel, handler) => handlers.set(channel, handler),
    }
    let stateListener: ((next: UpdateState) => void) | undefined
    const currentState = state('idle')
    const manualResponse: UpdateCheckResponse = {
      success: true,
      checked: true,
      updateAvailable: true,
      state: { ...state('downloaded'), availableVersion: '0.2.6' },
    }
    const actionResponse: UpdateActionResponse = { success: true, state: manualResponse.state }
    const service: UpdateServiceFacade = {
      getState: vi.fn(() => currentState),
      checkManually: vi.fn(async () => manualResponse),
      deferReminder: vi.fn(async () => actionResponse),
      requestInstall: vi.fn(async () => actionResponse),
      subscribe: (listener) => {
        stateListener = listener
        return () => { stateListener = undefined }
      },
    }
    const publish = vi.fn()

    registerUpdateController(service, { ipc, publish })

    expect(await handlers.get('update:get-state')!({})).toEqual(currentState)
    expect(await handlers.get('update:check')!({})).toEqual(manualResponse)
    expect(await handlers.get('update:defer-reminder')!({}, 30)).toEqual(actionResponse)
    expect(await handlers.get('update:quit-and-install')!({})).toEqual(actionResponse)
    expect(service.deferReminder).toHaveBeenCalledWith(30)
    expect(service.requestInstall).toHaveBeenCalledOnce()

    const downloaded = { ...state('downloaded'), availableVersion: '0.2.6' }
    stateListener!(downloaded)
    expect(publish).toHaveBeenCalledWith(downloaded)
  })
})
