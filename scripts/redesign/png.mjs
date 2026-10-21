import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'

const SIGNATURE = '89504e470d0a1a0a'
const CHANNELS = { 2: 3, 6: 4 }

/** 只解码截图实际产出的格式：8 位 RGB 或 RGBA、非隔行。返回 RGBA 像素。 */
export function decodePng(buffer) {
  assert.equal(buffer.subarray(0, 8).toString('hex'), SIGNATURE, '不是 PNG')
  let width, height, channels
  const data = []
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const chunk = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4); channels = CHANNELS[chunk[9]]
      assert(chunk[8] === 8 && channels && chunk[12] === 0, '只支持 8 位 RGB/RGBA 非隔行 PNG')
    } else if (type === 'IDAT') data.push(chunk)
    offset += length + 12
  }
  const raw = inflateSync(Buffer.concat(data))
  const stride = width * channels
  const pixels = Buffer.alloc(width * height * 4)
  let previous = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? line[x - channels] : 0
      const up = previous[x]
      const upLeft = x >= channels ? previous[x - channels] : 0
      const paeth = () => {
        const p = left + up - upLeft
        const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)]
        return pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      }
      const predictor = [0, left, up, (left + up) >> 1, filter === 4 ? paeth() : 0][filter]
      line[x] = (line[x] + predictor) & 0xff
    }
    for (let x = 0; x < width; x++) {
      line.copy(pixels, (y * width + x) * 4, x * channels, x * channels + Math.min(channels, 4))
      if (channels === 3) pixels[(y * width + x) * 4 + 3] = 255
    }
    previous = line
  }
  return { width, height, pixels }
}
