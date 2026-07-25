import { app, BrowserWindow, ipcMain } from 'electron'
import { registerIPCHandlers } from './ipc-handlers'
import { registerMCPHandlers } from './mcp/mcp-ipc-bridge'
import { mainT } from './i18n'
import { registerUpdateController } from './controllers/update-controller'
import { createElectronUpdaterBackend } from './services/electron-updater-adapter'
import { GlobalConfigUpdatePreferencesStore } from './services/update-preferences-store'
import { isWindowsUpdateRuntimeEnabled } from './services/update-runtime'
import { startUpdateRuntime } from './services/update-startup'
import type { UpdateState } from './services/update-service'

import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Electron 41 在部分 Windows 环境中无法启动受限 GPU 子进程（0xC0000135），
// 随后会触发 Chromium 的致命检查。仅放宽 GPU 子进程，保持 renderer 隔离策略不变。
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-gpu-sandbox')
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 构建产物目录结构
process.env.APP_ROOT = path.join(__dirname, '..')

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

let win: BrowserWindow | null

function publishUpdateState(state: UpdateState): void {
  for (const target of BrowserWindow.getAllWindows()) {
    if (target.isDestroyed() || target.webContents.isDestroyed()) continue
    target.webContents.send('update:state', state)
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: mainT(app.getLocale(), 'app.windowTitle'),
    icon: path.join(process.env.APP_ROOT!, 'build', 'icon.png'),
    // 使用应用内自绘标题栏，避免 Windows 原生标题栏与棕色标题栏重复显示。
    frame: false,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      // 安全性设置
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  if (process.platform === 'darwin') {
    app.dock?.setIcon(path.join(process.env.APP_ROOT!, 'build', 'icon.png'))
  }

  // 隐藏默认菜单栏（Windows/Linux）
  win.setMenuBarVisibility(false)

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

// macOS: 关闭所有窗口不退出
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

// macOS: 点击 dock 图标重新创建窗口
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.whenReady().then(() => {
  // 先让本地工作区可用；更新功能失败不能阻断作者进入应用。
  createWindow()
  registerIPCHandlers()
  registerMCPHandlers()
  startUpdateRuntime({
    updateRuntimeEnabled: isWindowsUpdateRuntimeEnabled(app.isPackaged, VITE_DEV_SERVER_URL),
    currentVersion: app.getVersion(),
    createBackend: createElectronUpdaterBackend,
    createPreferences: () => new GlobalConfigUpdatePreferencesStore(),
    registerController: updateService => {
      registerUpdateController(updateService, { ipc: ipcMain, publish: publishUpdateState })
    },
    reportFailure: (operation, error) => {
      console.warn(`[Vela Update] ${operation}失败，已降级并继续启动应用。`, error)
    },
  })
}).catch((error: unknown) => {
  console.error('[Vela] Electron 启动失败。', error)
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
