import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { registerIPCHandlers } from './ipc-handlers'
import { registerMCPHandlers } from './mcp/mcp-ipc-bridge'
import { mainT } from './i18n'
import { registerUpdateController } from './controllers/update-controller'
import { createElectronUpdaterBackend } from './services/electron-updater-adapter'
import { GlobalConfigUpdatePreferencesStore } from './services/update-preferences-store'
import {
  hasWindowsUpdateConfiguration,
  isWindowsUpdateRuntimeEnabled,
} from './services/update-runtime'
import { startUpdateRuntime } from './services/update-startup'
import {
  claimReleaseVectorSmokeInvocation,
  releaseVectorSmokeWasRequested,
  runReleaseVectorSmoke,
} from './services/release-vector-smoke'
import {
  claimReleaseOfficialHomepageSmokeInvocation,
  releaseOfficialHomepageSmokeWasRequested,
  runReleaseOfficialHomepageSmoke,
} from './services/release-official-homepage-smoke'
import { registerOfficialHomepageController } from './controllers/official-homepage-controller'
import type { UpdateState } from './services/update-service'
import {
  createOfficialHomepageWindowOpenHandler,
  preventRendererNavigation,
} from './services/official-homepage-navigation'

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

// The installed-package vector qualification is deliberately opt-in and
// fail-closed. A command-line request without the matching environment token
// must never turn into a normal interactive application launch.
const releaseVectorSmokeRequested = releaseVectorSmokeWasRequested(process.argv)
const releaseHomepageSmokeRequested = releaseOfficialHomepageSmokeWasRequested(process.argv)
const releaseSmokeRequested = releaseVectorSmokeRequested || releaseHomepageSmokeRequested
const releaseVectorSmokeInvocation = releaseVectorSmokeRequested
  ? claimReleaseVectorSmokeInvocation(process.argv, process.env)
  : undefined
const releaseHomepageSmokeInvocation = releaseHomepageSmokeRequested
  ? claimReleaseOfficialHomepageSmokeInvocation(process.argv, process.env)
  : undefined
let releaseSmokeStage = 'not-requested'
let releaseSmokeTimeout: NodeJS.Timeout | undefined

function reportReleaseSmokeStage(stage: string): void {
  if (!releaseSmokeRequested) return
  releaseSmokeStage = stage
  process.stderr.write(`[AI Novel release smoke] stage=${stage}\n`)
}

function clearReleaseSmokeTimeout(): void {
  if (releaseSmokeTimeout === undefined) return
  clearTimeout(releaseSmokeTimeout)
  releaseSmokeTimeout = undefined
}

if (releaseSmokeRequested) {
  reportReleaseSmokeStage('bootstrap')
  const timeoutDescription = releaseVectorSmokeRequested
    ? 'Packaged vector smoke timed out after 90 seconds'
    : 'Packaged official homepage smoke timed out after 90 seconds'
  releaseSmokeTimeout = setTimeout(() => {
    console.error(`[AI Novel release smoke] ${timeoutDescription}; last stage=${releaseSmokeStage}`)
    app.exit(1)
  }, 90_000)
}

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

  // 所有新窗口都留在应用外；仅精确匹配的官方仓库可交给系统浏览器。
  win.webContents.setWindowOpenHandler(createOfficialHomepageWindowOpenHandler({
    openExternal: url => shell.openExternal(url),
    onOpenExternalError: error => {
      console.warn('[AI Novel Writer] Unable to open official homepage from a window request.', error)
    },
  }))
  // 渲染进程不能把现有主窗口导航到外部内容。
  win.webContents.on('will-navigate', preventRendererNavigation)

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

function createReleaseHomepageSmokeWindow(): BrowserWindow {
  return new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  })
}

async function runPackagedOfficialHomepageSmoke(token: string) {
  return runReleaseOfficialHomepageSmoke(token, {
    createWindow: createReleaseHomepageSmokeWindow,
    loadProbeDocument: window => window.loadFile(path.join(RENDERER_DIST, 'release-homepage-smoke.html')),
    removeHandler: channel => ipcMain.removeHandler(channel),
    registerController: options => registerOfficialHomepageController(options),
  })
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
  if (releaseSmokeRequested) return
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.whenReady().then(async () => {
  reportReleaseSmokeStage('electron-ready')
  if (releaseSmokeRequested) {
    const requestedSmokeModeCount = Number(releaseVectorSmokeRequested)
      + Number(releaseHomepageSmokeRequested)
    const invocationCount = Number(releaseVectorSmokeInvocation !== undefined)
      + Number(releaseHomepageSmokeInvocation !== undefined)
    if (requestedSmokeModeCount !== 1 || invocationCount !== 1) {
      throw new Error('Invalid packaged smoke invocation: exactly one environment and one-time CLI token pair must match')
    }
    reportReleaseSmokeStage(releaseVectorSmokeInvocation ? 'vector-invocation-valid' : 'official-homepage-invocation-valid')
    const evidence = releaseVectorSmokeInvocation
      ? await runReleaseVectorSmoke(releaseVectorSmokeInvocation.token)
      : await runPackagedOfficialHomepageSmoke(releaseHomepageSmokeInvocation!.token)
    reportReleaseSmokeStage('evidence-ready')
    process.stdout.write(`${JSON.stringify(evidence)}\n`)
    clearReleaseSmokeTimeout()
    app.exit(0)
    return
  }

  // 先让本地工作区可用；更新功能失败不能阻断作者进入应用。
  createWindow()
  registerIPCHandlers()
  registerMCPHandlers()
  const updateRuntimeEnabled = isWindowsUpdateRuntimeEnabled(app.isPackaged, VITE_DEV_SERVER_URL)
  const updateConfiguration = updateRuntimeEnabled && !hasWindowsUpdateConfiguration()
    ? 'missing'
    : 'available'
  startUpdateRuntime({
    updateRuntimeEnabled,
    updateConfiguration,
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
  clearReleaseSmokeTimeout()
  console.error('[Vela] Electron 启动失败。', error)
  if (releaseSmokeRequested) {
    app.exit(1)
    return
  }
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
