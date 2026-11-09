import { inflateSync } from 'node:zlib'

/**
 * Decode an 8-bit, non-interlaced RGB or RGBA PNG, as Chrome writes screenshots.
 * @param {Uint8Array} bytes - the PNG file.
 * @returns {{ width: number, height: number, rgb(x: number, y: number): string }} pixels as `#rrggbb`.
 */
export function decodePng(bytes) {
  const data = Buffer.from(bytes)
  let offset = 8
  let width = 0, height = 0, channels = 0
  const chunks = []
  while (offset < data.length) {
    const length = data.readUInt32BE(offset)
    const type = data.toString('latin1', offset + 4, offset + 8)
    const body = data.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      if (body[8] !== 8 || body[12] !== 0) throw new Error('only 8-bit, non-interlaced PNGs are supported')
      channels = { 2: 3, 6: 4 }[body[9]]
      if (!channels) throw new Error(`unsupported PNG color type ${body[9]}`)
    } else if (type === 'IDAT') chunks.push(body)
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(chunks))
  const stride = width * channels
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x]
      const left = x >= channels ? pixels[y * stride + x - channels] : 0
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0
      const corner = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0
      let predicted = 0
      if (filter === 1) predicted = left
      else if (filter === 2) predicted = up
      else if (filter === 3) predicted = (left + up) >> 1
      else if (filter === 4) {
        const estimate = left + up - corner
        const [a, b, c] = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - corner)]
        predicted = a <= b && a <= c ? left : b <= c ? up : corner
      }
      pixels[y * stride + x] = (value + predicted) & 0xff
    }
  }
  return {
    width,
    height,
    rgb(x, y) {
      const at = Math.round(y) * stride + Math.round(x) * channels
      return `#${[0, 1, 2].map(index => pixels[at + index].toString(16).padStart(2, '0')).join('')}`
    },
  }
}
