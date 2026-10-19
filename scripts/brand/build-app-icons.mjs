// 从 docs/assets/brand/pagekin-icon.svg 生成 build/ 下的应用图标：icon.ico（Windows）、icon.icns（macOS）、icon.png（窗口图标）。
// 在 Electron 的离屏窗口里按每个尺寸直接栅格化矢量图，小尺寸不靠缩放大图，边缘更干净。
// 用法：npx electron scripts/brand/build-app-icons.mjs（Electron 主进程报错不会打到终端，失败时看退出码）
import { Buffer } from 'node:buffer'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const svg = readFileSync(path.join(root, 'docs/assets/brand/pagekin-icon.svg'), 'utf8')

// macOS 图标网格：1024 画布里圆角方块占 824，四周留白，和 Dock 里其他应用一样大。
const MAC_CONTENT_RATIO = 824 / 1024
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const ICNS_ENTRIES = [
  ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
  ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512],
]

// 窗口太小时 capturePage 会失败，所以固定一个 1024 的透明窗口，每次只改图标框的大小，再截左上角。
async function createCanvas() {
  const win = new BrowserWindow({ width: 1024, height: 1024, useContentSize: true, show: false, frame: false, transparent: true })
  const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">
    <div id="icon" style="position:absolute">${svg.replace('<svg ', '<svg width="100%" height="100%" ')}</div>
  </body></html>`
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  return win
}

async function render(win, size, contentRatio) {
  const inner = Math.round(size * contentRatio)
  const offset = (size - inner) / 2
  await win.webContents.executeJavaScript(`Object.assign(document.getElementById('icon').style,
    { left: '${offset}px', top: '${offset}px', width: '${inner}px', height: '${inner}px' }); new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`)
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })
  const { width, height } = image.getSize()
  if (width !== size || height !== size) throw new Error(`渲染尺寸不对：要 ${size}，得到 ${width}×${height}`)
  return image.toPNG()
}

function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16
    header.writeUInt8(size >= 256 ? 0 : size, entry)
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1)
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(png.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...images.map(image => image.png)])
}

function icns(entries) {
  const chunks = entries.map(({ type, png }) => {
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32BE(png.length + 8, 4)
    return Buffer.concat([head, png])
  })
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4)
  return Buffer.concat([head, ...chunks])
}

async function main() {
  const win = await createCanvas()
  const full = new Map()
  for (const size of [...ICO_SIZES, 512]) full.set(size, await render(win, size, 1))
  const mac = new Map()
  for (const size of new Set(ICNS_ENTRIES.map(([, size]) => size))) mac.set(size, await render(win, size, MAC_CONTENT_RATIO))

  writeFileSync(path.join(root, 'build/icon.ico'), ico(ICO_SIZES.map(size => ({ size, png: full.get(size) }))))
  writeFileSync(path.join(root, 'build/icon.icns'), icns(ICNS_ENTRIES.map(([type, size]) => ({ type, png: mac.get(size) }))))
  writeFileSync(path.join(root, 'build/icon.png'), full.get(512))
  console.log('build/icon.ico, build/icon.icns, build/icon.png 已生成')
}

// 主进程脚本里顶层 await 会卡住 ready 事件，所以用 then 串起来。
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.whenReady().then(main).then(() => app.exit(0), error => {
  console.error(error)
  app.exit(1)
})
