import { writeFile, readFile, stat, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { deflateSync, crc32 } from 'node:zlib'

/** A real 7.89 MiB PNG, generated locally without storing a large binary fixture. */
export async function imageBoardFixture(root, count = 60) {
  await mkdir(root, { recursive: true })
  const width = 2048, height = 1346
  const raw = Buffer.alloc((width * 3 + 1) * height, 200)
  for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0
  const chunk = (type, data) => {
    const output = Buffer.alloc(data.length + 12)
    output.writeUInt32BE(data.length)
    output.write(type, 4, 'ascii')
    data.copy(output, 8)
    output.writeUInt32BE(crc32(output.subarray(4, -4)), output.length - 4)
    return output
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2
  const png = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 0 })), chunk('IEND', Buffer.alloc(0)),
  ])
  const imagePath = resolve(root, 'large.png')
  const path = resolve(root, 'images.canvas')
  await writeFile(imagePath, png)
  const nodes = Array.from({ length: count }, (_, index) => ({
    id: `image-${index}`, type: 'file', file: 'large.png',
    x: (index % 10) * 150, y: Math.floor(index / 10) * 150, width: 140, height: 140,
  }))
  const source = `{\n"nodes":[\n${nodes.map(node => JSON.stringify(node)).join(',\n')}\n]}\n`
  await writeFile(path, source)
  const calls = { reads: 0, bytes: 0 }
  const fs = {
    resolve: async (path, options) => ({ displayPath: resolve(options?.cwd ?? root, path) }),
    processPath: target => target.displayPath,
    stat: async target => {
      const info = await stat(target.displayPath)
      return { type: 'file', version: '1', size: info.size }
    },
    readText: target => readFile(target.displayPath, 'utf8'),
    readBytes: async (target, _signal, maxBytes) => {
      const bytes = await readFile(target.displayPath)
      if (bytes.length > maxBytes) throw new Error('too large')
      calls.reads++; calls.bytes += bytes.length
      return bytes
    },
  }
  return { source, path, imagePath, imageBytes: png.length, nodes, calls, fs, context: { path, fs, signal: new AbortController().signal } }
}
