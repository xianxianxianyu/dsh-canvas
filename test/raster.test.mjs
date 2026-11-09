import assert from 'node:assert/strict'
import test from 'node:test'
import { IMAGE_PIXEL_BUDGET, imageScale } from '../src/host/raster.ts'

test('small charts are enlarged at most twice', () => {
  assert.equal(imageScale(290, 376), 2)
  assert.equal(imageScale(10, 10), 2)
})

test('larger charts get the largest scale whose picture fits the 1302×1302 pixel budget', () => {
  assert.equal(imageScale(1302, 1302), 1)
  assert.equal(imageScale(2604, 2604), 0.5)
  for (const [width, height] of [[900, 700], [1800, 1000], [3000, 400], [5000, 5000], [651, 651]]) {
    const scale = imageScale(width, height)
    const pixels = Math.ceil(width * scale) * Math.ceil(height * scale)
    assert.ok(pixels <= IMAGE_PIXEL_BUDGET * 1.01, `${width}×${height} at ${scale}: ${pixels} px`)
    const next = scale + 0.01
    assert.ok(next > 2 || width * next * height * next > IMAGE_PIXEL_BUDGET, `${width}×${height}: ${scale} is not the largest`)
  }
})

test('a very long chart keeps its longest side within 4096 px', () => {
  assert.equal(imageScale(8192, 100), 0.5)
  assert.equal(imageScale(100, 20000), 0.2)
})
