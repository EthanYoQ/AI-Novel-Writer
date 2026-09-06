import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'

interface WindowCloseGuardState {
  approved: boolean
  pendingRequestId: string | null
  requestSequence: number
}

const closeGuardStates = new WeakMap<BrowserWindow, WindowCloseGuardState>()

function getSenderWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

export function installWindowCloseGuard(win: BrowserWindow): void {
  const state: WindowCloseGuardState = {
    approved: false,
    pendingRequestId: null,
    requestSequence: 0,
  }
  closeGuardStates.set(win, state)
  win.on('close', (event) => {
    if (
      state.approved
      || win.webContents.isDestroyed()
      || win.webContents.isLoadingMainFrame()
    ) return
    event.preventDefault()
    if (state.pendingRequestId) return
    state.pendingRequestId = `${win.id}:${++state.requestSequence}`
    win.webContents.send('window:close-requested', { requestId: state.pendingRequestId })
  })
}

export function registerWindowController() {
  ipcMain.handle('window:minimize', async (event) => {
    const win = getSenderWindow(event)
    win?.minimize()
    return { success: !!win }
  })

  ipcMain.handle('window:toggle-maximize', async (event) => {
    const win = getSenderWindow(event)
    if (!win) return { success: false }

    if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }

    return { success: true, maximized: win.isMaximized() }
  })

  ipcMain.handle('window:close', async (event) => {
    const win = getSenderWindow(event)
    win?.close()
    return { success: !!win }
  })

  ipcMain.handle('window:resolve-close', async (event, requestId: unknown, decision: unknown) => {
    const win = getSenderWindow(event)
    const state = win ? closeGuardStates.get(win) : undefined
    if (
      !win
      || !state
      || typeof requestId !== 'string'
      || state.pendingRequestId !== requestId
      || (decision !== 'proceed' && decision !== 'cancel')
    ) return { success: false }

    state.pendingRequestId = null
    if (decision === 'cancel') return { success: true }

    state.approved = true
    win.close()
    return { success: true }
  })
}
