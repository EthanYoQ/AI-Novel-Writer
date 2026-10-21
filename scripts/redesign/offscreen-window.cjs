// drive.mjs 以 `electron -r` 预加载本文件，先于应用主进程脚本运行，每个窗口创建时监听都已就位。
const path = require('node:path')
const { app, screen, session } = require('electron')

const timing = globalThis.__driveTiming = { readyToShow: null }

app.on('browser-window-created', (_, window) => {
  window.once('ready-to-show', () => { timing.readyToShow ??= Date.now() })
  // 应用用默认 show: true 建窗，构造时已显示并可能已激活：移出全部显示器、去掉任务栏按钮、禁止再激活并交还焦点。
  const right = Math.max(...screen.getAllDisplays().map(({ bounds }) => bounds.x + bounds.width))
  window.setSkipTaskbar(true)
  window.setPosition(right + 200, 0)
  window.setFocusable(false)
  window.blur()
})

// 计时会话（drive.mjs 设 DRIVE_RENDER_TIMING 为书架上的书数）在页面里记录控件进入 DOM 的时刻，见 render-timing-preload.cjs。
if (process.env.DRIVE_RENDER_TIMING) {
  app.whenReady().then(() => {
    session.defaultSession.registerPreloadScript({ type: 'frame', id: 'drive-render-timing', filePath: path.join(__dirname, 'render-timing-preload.cjs') })
  })
}
