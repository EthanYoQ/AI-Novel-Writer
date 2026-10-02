import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { registerIPCHandlers } from './ipc-handlers'
import { registerMCPHandlers } from './mcp/mcp-ipc-bridge'
import { mainT, mainText } from './i18n'
import { registerUpdateController } from './controllers/update-controller'
import { createElectronUpdaterBackend } from './services/electron-updater-adapter'
import {
  GITHUB_LATEST_RELEASE_PAGE,
  createGitHubReleaseUpdateBackend,
} from './services/github-release-update-backend'
import { GlobalConfigUpdatePreferencesStore } from './services/update-preferences-store'
import {
  hasWindowsUpdateConfiguration,
  isMacUpdateReminderEnabled,
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
import {
  claimReleaseSkinSmokeInvocation,
  releaseSkinSmokeWasRequested,
  runReleaseSkinSmoke,
} from './services/release-skin-smoke'
import { registerOfficialHomepageController } from './controllers/official-homepage-controller'
import type { UpdateState } from './services/update-service'
import {
  createOfficialHomepageWindowOpenHandler,
  preventRendererNavigation,
} from './services/official-homepage-navigation'
import { configureSingleInstanceRuntime } from './services/single-instance-runtime'
import { installWindowCloseGuard } from './controllers/window-controller'

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
const releaseSkinSmokeRequested = releaseSkinSmokeWasRequested(process.argv)
const releaseSmokeRequested = releaseVectorSmokeRequested || releaseHomepageSmokeRequested || releaseSkinSmokeRequested
const releaseVectorSmokeInvocation = releaseVectorSmokeRequested
  ? claimReleaseVectorSmokeInvocation(process.argv, process.env)
  : undefined
const releaseHomepageSmokeInvocation = releaseHomepageSmokeRequested
  ? claimReleaseOfficialHomepageSmokeInvocation(process.argv, process.env)
  : undefined
const releaseSkinSmokeInvocation = releaseSkinSmokeRequested
  ? claimReleaseSkinSmokeInvocation(process.argv, process.env)
  : undefined
const applicationInstanceAccepted = configureSingleInstanceRuntime({
  releaseSmokeRequested,
  requestLock: () => app.requestSingleInstanceLock(),
  quit: () => app.quit(),
  onSecondInstance: listener => { app.on('second-instance', () => listener()) },
  getWindow: () => win,
})
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

/**
 * 进程级异常兜底（主进程的生命线）。
 *
 * 为什么必须有：Node 15+ 起 `--unhandled-rejections` 默认为 `throw`，
 * Electron 主进程同样如此 —— 任何一个没人接管的 Promise rejection 都会
 * 被当作未捕获异常，**直接让主进程退出、窗口消失**。而本项目里存在这样的
 * 最短路径：`controllers/llm-controller.ts` 的 `provider.generateStream(...)`
 * 是 fire-and-forget（未 await 未 catch），一旦流式出错且此刻窗口正在关闭，
 * provider 内部 catch 里的 `webContents.send` 会抛 "Object has been destroyed"，
 * 该异常从 catch 块里冒出来 → rejected promise 无人接管 → 应用猝死。
 *
 * 兜底策略：只记录、不退出。应用继续可用，作者至少能保存作品；
 * 真正的修复点在调用处（generateStream 已补 .catch）。
 * release smoke 场景不接管 —— 那条链路需要 fail-closed。
 */
function installProcessErrorGuards(): void {
  process.on('uncaughtException', (error: unknown) => {
    console.error('[Vela] 未捕获异常（已兜底，应用继续运行）：', error)
  })
  process.on('unhandledRejection', (reason: unknown) => {
    console.error('[Vela] 未处理的 Promise rejection（已兜底，应用继续运行）：', reason)
  })
}

if (!releaseSmokeRequested) {
  installProcessErrorGuards()
}

if (releaseSmokeRequested) {
  reportReleaseSmokeStage('bootstrap')
  const timeoutDescription = releaseVectorSmokeRequested
    ? 'Packaged vector smoke timed out after 90 seconds'
    : releaseHomepageSmokeRequested
      ? 'Packaged official homepage smoke timed out after 90 seconds'
      : 'Packaged skin smoke timed out after 90 seconds'
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
  installWindowCloseGuard(win)

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
  if (!applicationInstanceAccepted) return
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

// macOS: 点击 dock 图标重新创建窗口
app.on('activate', () => {
  if (!applicationInstanceAccepted || releaseSmokeRequested) return
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

/**
 * 渲染进程意外消失（崩溃 / 被系统 OOM 杀掉）时给作者一个明确交代。
 *
 * 少了这个监听，作者看到的是「窗口还在、界面全白、点什么都没反应」，
 * 完全无从判断发生了什么；控制台里也没有任何线索。
 * 这里只在确实异常结束时提示，正常关闭（clean-exit）不打扰。
 */
app.on('render-process-gone', (_event, _webContents, details) => {
  if (releaseSmokeRequested) return
  console.error('[Vela] 渲染进程异常结束：', details.reason, details.exitCode)
  if (details.reason === 'clean-exit') return
  try {
    const windows = BrowserWindow.getAllWindows()
    if (windows.length === 0) return
    dialog.showMessageBox(windows[0], {
      type: 'error',
      title: mainText(app.getLocale(), '界面进程异常退出', 'The interface process stopped unexpectedly'),
      message: mainText(app.getLocale(), '界面进程异常退出，需要重新加载。', 'The interface process stopped unexpectedly and must be reloaded.'),
      detail: mainText(
        app.getLocale(),
        `原因：${details.reason}（退出码 ${details.exitCode}）。\n你的作品数据保存在项目目录里，没有丢失。\n点击「重新加载」恢复使用。`,
        `Reason: ${details.reason} (exit code ${details.exitCode}).\nYour manuscript is safe in the project folder.\nChoose "Reload" to continue.`,
      ),
      buttons: [mainText(app.getLocale(), '重新加载', 'Reload'), mainText(app.getLocale(), '关闭窗口', 'Close window')],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) {
        const target = BrowserWindow.getAllWindows()[0]
        if (!target || target.isDestroyed()) {
          createWindow()
          return
        }
        target.webContents.reload()
      } else {
        app.quit()
      }
    }).catch((error: unknown) => {
      console.error('[Vela] 渲染进程恢复提示失败：', error)
    })
  } catch (error) {
    console.error('[Vela] 处理渲染进程异常结束时出错：', error)
  }
})

app.whenReady().then(async () => {
  if (!applicationInstanceAccepted) return
  reportReleaseSmokeStage('electron-ready')
  if (releaseSmokeRequested) {
    const requestedSmokeModeCount = Number(releaseVectorSmokeRequested)
      + Number(releaseHomepageSmokeRequested)
      + Number(releaseSkinSmokeRequested)
    const invocationCount = Number(releaseVectorSmokeInvocation !== undefined)
      + Number(releaseHomepageSmokeInvocation !== undefined)
      + Number(releaseSkinSmokeInvocation !== undefined)
    if (requestedSmokeModeCount !== 1 || invocationCount !== 1) {
      throw new Error('Invalid packaged smoke invocation: exactly one environment and one-time CLI token pair must match')
    }
    reportReleaseSmokeStage(
      releaseVectorSmokeInvocation
        ? 'vector-invocation-valid'
        : releaseHomepageSmokeInvocation
          ? 'official-homepage-invocation-valid'
          : 'skin-invocation-valid',
    )
    const evidence = releaseVectorSmokeInvocation
      ? await runReleaseVectorSmoke(releaseVectorSmokeInvocation.token)
      : releaseHomepageSmokeInvocation
        ? await runPackagedOfficialHomepageSmoke(releaseHomepageSmokeInvocation.token)
        : runReleaseSkinSmoke(releaseSkinSmokeInvocation!.token)
    reportReleaseSmokeStage('evidence-ready')
    process.stdout.write(`${JSON.stringify(evidence)}\n`)
    clearReleaseSmokeTimeout()
    app.exit(0)
    return
  }

  // 先准备主进程服务和 IPC，再允许渲染层加载并发起调用。
  registerIPCHandlers()
  registerMCPHandlers()
  // 更新功能失败不能阻断作者进入应用；窗口先于更新运行时创建。
  createWindow()
  const windowsUpdateEnabled = isWindowsUpdateRuntimeEnabled(app.isPackaged, VITE_DEV_SERVER_URL)
  const macUpdateReminderEnabled = isMacUpdateReminderEnabled(app.isPackaged, VITE_DEV_SERVER_URL)
  const updateRuntimeEnabled = windowsUpdateEnabled || macUpdateReminderEnabled
  const updateConfiguration = windowsUpdateEnabled && !hasWindowsUpdateConfiguration()
    ? 'missing'
    : 'available'
  startUpdateRuntime({
    updateRuntimeEnabled,
    updateConfiguration,
    currentVersion: app.getVersion(),
    updateAction: windowsUpdateEnabled ? 'download' : 'open-release',
    openRelease: () => shell.openExternal(GITHUB_LATEST_RELEASE_PAGE),
    createBackend: windowsUpdateEnabled
      ? createElectronUpdaterBackend
      : createGitHubReleaseUpdateBackend,
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
