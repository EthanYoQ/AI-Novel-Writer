import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'

interface WindowCloseGuardState {
  approved: boolean
  quitRequested: boolean
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
    quitRequested: false,
    pendingRequestId: null,
    requestSequence: 0,
  }
  closeGuardStates.set(win, state)
  const noteQuitRequest = () => { state.quitRequested = true }
  app.on('before-quit', noteQuitRequest)
  win.on('closed', () => app.off('before-quit', noteQuitRequest))
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
    if (decision === 'cancel') {
      state.quitRequested = false
      return { success: true }
    }

    state.approved = true
    if (state.quitRequested) app.quit()
    else win.close()
    return { success: true }
  })
}
