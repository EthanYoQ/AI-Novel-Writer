import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

interface Frame { name: string, png: Buffer, fullBleed: boolean }

function icoFrames(file: Buffer): Frame[] {
  return Array.from({ length: file.readUInt16LE(4) }, (_, index) => {
    const entry = 6 + index * 16
    const start = file.readUInt32LE(entry + 12)
    return { name: `ico ${file[entry] || 256}px`, png: file.subarray(start, start + file.readUInt32LE(entry + 8)), fullBleed: true }
  })
}

function icnsFrames(file: Buffer): Frame[] {
  const frames: Frame[] = []
  for (let offset = 8; offset < file.length;) {
    const length = file.readUInt32BE(offset + 4)
    frames.push({ name: `icns ${file.toString('ascii', offset, offset + 4)}`, png: file.subarray(offset + 8, offset + length), fullBleed: false })
    offset += length
  }
  return frames
}

/** 只解 8 位 RGBA、非隔行的 PNG（Chromium capturePage().toPNG() 的输出），返回每个像素的 alpha。 */
function decodeAlpha(png: Buffer) {
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  if (png[24] !== 8 || png[25] !== 6 || png[28] !== 0) throw new Error('只支持 8 位 RGBA 非隔行 PNG')
  const idat: Buffer[] = []
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset)
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length))
    offset += length + 12
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x]
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0
      const upLeft = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4] : 0
      const paeth = () => {
        const p = left + up - upLeft
        const [a, b, c] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)]
        return a <= b && a <= c ? left : b <= c ? up : upLeft
      }
      const predictor = [0, left, up, (left + up) >> 1, paeth()][filter]
      pixels[y * stride + x] = (value + predictor) & 0xff
    }
  }
  return { width, height, alpha: (x: number, y: number) => pixels[y * stride + x * 4 + 3] }
}

function opaqueBounds(png: Buffer) {
  const { width, height, alpha } = decodeAlpha(png)
  let [left, top, right, bottom] = [width, height, -1, -1]
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (alpha(x, y) === 0) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
    }
  }
  return { width, height, margins: { left, top, right: width - 1 - right, bottom: height - 1 - bottom } }
}

const buildDir = resolve(process.cwd(), 'build')
const frames = [
  ...icoFrames(readFileSync(resolve(buildDir, 'icon.ico'))),
  ...icnsFrames(readFileSync(resolve(buildDir, 'icon.icns'))),
]

describe('build/ 下提交的应用图标', () => {
  it.each(frames)('$name 的图形完整居中，没有被截掉', ({ png, fullBleed }) => {
    const { width, margins } = opaqueBounds(png)

    expect(margins.right, '图形为空').toBeLessThan(width)
    expect(Math.abs(margins.top - margins.bottom), `上下留白 ${margins.top}/${margins.bottom}`).toBeLessThanOrEqual(1)
    expect(Math.abs(margins.left - margins.right), `左右留白 ${margins.left}/${margins.right}`).toBeLessThanOrEqual(1)
    if (fullBleed) expect(margins).toEqual({ left: 0, top: 0, right: 0, bottom: 0 })
  })
})
