/* global process */
import fs from 'node:fs'
import { decodePng } from './png.mjs'

/** 同一状态连续截图，渲染器在模糊与渐变上会有 ±1～2 级抖动，肉眼不可见；超过 2 级才算不同像素。 */
const CHANNEL_TOLERANCE = 2

/** 不同像素占比，0 到 1。任一通道差值超过 threshold 即算不同；threshold 为 0 即逐字节比较。 */
function diffRatio(first, second, threshold = CHANNEL_TOLERANCE) {
  let different = 0
  for (let index = 0; index < first.pixels.length; index += 4) {
    for (let channel = 0; channel < 4; channel++) {
      if (Math.abs(first.pixels[index + channel] - second.pixels[index + channel]) > threshold) { different++; break }
    }
  }
  return different / (first.width * first.height)
}

const files = process.argv.slice(2).filter(arg => arg !== '--')
if (files.length < 2) {
  process.stderr.write('用法: node scripts/redesign/pixel-diff.mjs <基准.png> <对比.png>...\n')
  process.exit(2)
}
const [reference, ...others] = files.map(file => decodePng(fs.readFileSync(file)))
const ratios = others.map((image, index) => {
  const file = files[index + 1]
  if (image.width !== reference.width || image.height !== reference.height) {
    return { file, ratio: 1, strictRatio: 1, reason: `尺寸不同：${reference.width}×${reference.height} 对 ${image.width}×${image.height}` }
  }
  return { file, ratio: diffRatio(reference, image), strictRatio: diffRatio(reference, image, 0) }
})
const maxRatio = Math.max(...ratios.map(item => item.ratio))
process.stdout.write(`${JSON.stringify({ reference: files[0], channelTolerance: CHANNEL_TOLERANCE, ratios, maxRatio,
  pass: maxRatio < 0.005 })}\n`)
process.exitCode = maxRatio < 0.005 ? 0 : 1
