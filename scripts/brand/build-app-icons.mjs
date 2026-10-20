// 从 docs/assets/brand/pagekin-icon.svg 生成 build/ 下的应用图标：icon.ico（Windows）、icon.icns（macOS）、icon.png（窗口图标）。
// 在 Electron 的离屏窗口里按每个尺寸直接栅格化矢量图，小尺寸不靠缩放大图，边缘更干净。
// 用法：npx electron scripts/brand/build-app-icons.mjs（失败时打印原因并以退出码 1 结束，不写任何图标）
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

// 每个尺寸开一个新窗口：透明窗口复用时，上一次较大渲染的抗锯齿边缘会残留在左上角。
// 窗口太小时 capturePage 会失败，所以窗口固定 1024，只截左上角 size×size。
// SVG 必须是块级：行内 SVG 落在文字基线上，16px 时会被行高往下推几像素，截图就丢掉底边。
// 留白取整数像素，否则 16px 的 macOS 帧会糊成半像素边。
async function render(size, contentRatio) {
  const margin = Math.round((size - size * contentRatio) / 2)
  const inner = size - margin * 2
  const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">
    <div style="position:absolute;left:${margin}px;top:${margin}px;width:${inner}px;height:${inner}px">${svg.replace('<svg ', '<svg style="display:block" width="100%" height="100%" ')}</div>
  </body></html>`
  // 隐藏窗口默认会节流 rAF 与绘制，可能永远等不到下一帧或截到空白。
  const win = new BrowserWindow({ width: 1024, height: 1024, useContentSize: true, show: false, frame: false, transparent: true, webPreferences: { backgroundThrottling: false } })
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })
    assertPlaced(image, size, margin)
    return image.toPNG()
  } finally {
    win.destroy()
  }
}

// 截图不对就别写进图标：尺寸、非全透明、四角透明、图形落在预期的留白里（四边都对上，才说明没被截掉或挪位）。
// 满版渲染时图形铺满画布，包围盒发现不了背景不透明；图标是圆角方块，四角按设计透明，用它兜底。
// 小尺寸圆角的抗锯齿会向外渗 1 像素，所以每边容差 1。
function assertPlaced(image, size, margin) {
  const { width, height } = image.getSize()
  if (width !== size || height !== size) throw new Error(`渲染尺寸不对：要 ${size}，得到 ${width}×${height}`)
  const bitmap = image.toBitmap()
  let [left, top, right, bottom] = [size, size, -1, -1]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (bitmap[(y * size + x) * 4 + 3] === 0) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
    }
  }
  if (right < 0) throw new Error(`${size}px 截图全透明`)
  const cornerAlphas = [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]].map(([x, y]) => bitmap[(y * size + x) * 4 + 3])
  if (cornerAlphas.some(alpha => alpha !== 0)) throw new Error(`${size}px 四角不透明（alpha ${cornerAlphas.join(',')}），背景没有保持透明`)
  const expected = [margin, margin, size - 1 - margin, size - 1 - margin]
  if ([left, top, right, bottom].some((value, index) => Math.abs(value - expected[index]) > 1)) {
    throw new Error(`${size}px 图形位置不对：要 ${expected.join(',')}，得到 ${[left, top, right, bottom].join(',')}`)
  }
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
  const full = new Map()
  for (const size of [...ICO_SIZES, 512]) full.set(size, await render(size, 1))
  const mac = new Map()
  for (const size of new Set(ICNS_ENTRIES.map(([, size]) => size))) mac.set(size, await render(size, MAC_CONTENT_RATIO))

  writeFileSync(path.join(root, 'build/icon.ico'), ico(ICO_SIZES.map(size => ({ size, png: full.get(size) }))))
  writeFileSync(path.join(root, 'build/icon.icns'), icns(ICNS_ENTRIES.map(([type, size]) => ({ type, png: mac.get(size) }))))
  writeFileSync(path.join(root, 'build/icon.png'), full.get(512))
  console.log('build/icon.ico, build/icon.icns, build/icon.png 已生成')
}

// 主进程脚本里顶层 await 会卡住 ready 事件，所以用 then 串起来。
app.commandLine.appendSwitch('force-device-scale-factor', '1')
// 每个尺寸用完就关窗口，别让「所有窗口已关闭」把应用提前退出。
app.on('window-all-closed', () => {})
app.whenReady().then(main).then(() => app.exit(0), error => {
  console.error(error)
  app.exit(1)
})
