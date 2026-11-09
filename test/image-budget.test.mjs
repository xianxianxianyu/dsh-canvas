import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { canvasCheckTool } from '../src/host/check.ts'
import { prepareBoard } from '../src/host/board-check.ts'
import { boardRenderRoute } from '../src/host/board-render.ts'
import { parseBoard, scene } from '../src/shared/board.ts'
import * as pages from '../src/shared/page.ts'
import { imageBoardFixture } from './image-budget-fixture.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'canvas-image-budget-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const result = await imageBoardFixture(root)
  assert.equal((result.imageBytes / 1024 / 1024).toFixed(2), '7.89')
  return result
}

test('F9 canvas_check on 60 local 7.89 MiB PNGs passes with located placeholder warnings, not Invalid string length', async t => {
  const input = await fixture(t)
  const tool = canvasCheckTool({
    fs: input.fs, workingDirectory: { ensure: async () => input.path },
    llm: () => undefined, attachments: () => undefined,
    browser: () => ({ kind: 'missing', reason: 'not needed' }),
    headless: { use: async () => { throw new Error('no browser needed') } },
    store: { read: async () => ({ comments: [] }) }, journal: { lost: () => [] },
  })
  const result = await tool.execute({ path: input.path }, { signal: input.context.signal, callId: 'f9' })
  assert.match(result.text, /^✓ 画板/u)
  assert.match(result.text, /5:1 警告 节点 image-2.*24 MiB/u)
  assert.equal(result.text.split('\n').filter(line => /警告 节点 image-\d+.*24 MiB/u.test(line)).length, 58)
  assert.equal(input.calls.reads, 2, 'do not read images that cannot fit the remaining page budget')
})

test('F9 board-render returns 200 with two images and 58 reasoned placeholders, not 500', async t => {
  const input = await fixture(t)
  const response = await boardRenderRoute({ fs: input.fs }).fetch(new Request('http://localhost/api/canvas/board-render', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: input.path, source: input.source }),
  }))
  assert.equal(response.status, 200)
  const result = await response.json()
  const contents = new Map(result.contents)
  assert.equal([...contents.values()].filter(content => content.kind === 'image').length, 2)
  assert.equal([...contents.values()].filter(content => content.kind === 'card').length, 58)
  assert.match(contents.get('image-2').detail, /24 MiB/u)
  assert.equal(result.diagnostics.length, 58)
  assert.ok(result.diagnostics.every(diagnostic => diagnostic.severity === 'warning' && diagnostic.line >= 5 && diagnostic.column === 1))
  assert.ok([...contents.values()].reduce((bytes, content) => bytes + (content.kind === 'image' ? Buffer.byteLength(content.src) : 0), 0) <= 24 * 1024 * 1024)
  assert.equal(input.calls.reads, 2)
  const page = pages.boardPageHtml(scene(parseBoard(input.source).board), contents, 'light')
  assert.equal((page.html.match(/<img src="data:/gu) ?? []).length, 2)
  assert.equal((page.html.match(/图片嵌入总量超过 24 MiB/gu) ?? []).length, 58)
})

test('F9 direct board composition shares the 24 MiB data URI budget and keeps later small images that fit', () => {
  const prefix = 'data:image/png;base64,'
  const content = { kind: 'image', src: prefix + 'A'.repeat(13 * 1024 * 1024) }
  const nodes = ['a', 'b', 'c'].map((id, index) => ({ id, type: 'file', file: `${id}.png`, x: index * 100, y: 0, width: 90, height: 90 }))
  const contents = new Map([['a', content], ['b', content], ['c', { kind: 'image', src: prefix + 'AAAA' }]])
  const page = pages.boardPageHtml(scene({ nodes, edges: [] }), contents, 'light')
  assert.equal((page.html.match(/<img src="data:/gu) ?? []).length, 2)
  assert.match(page.html, /图片嵌入总量超过 24 MiB/u)
  assert.equal(pages.BOARD_EMBED_BYTES, 24 * 1024 * 1024)
})

test('F9 embedding uses actual bytes as well as stat when a file grows before read', async () => {
  const image = Buffer.alloc(8 * 1024 * 1024)
  const source = '{"nodes":[\n' + Array.from({ length: 3 }, (_, index) => JSON.stringify({ id: `n${index}`, type: 'file', file: 'grow.png', x: index * 100, y: 0, width: 90, height: 90 })).join(',\n') + '\n]}'
  const fs = {
    resolve: async path => ({ displayPath: path }), processPath: target => target.displayPath,
    stat: async () => ({ type: 'file', version: '1', size: 1 }), readBytes: async () => image,
  }
  const prepared = await prepareBoard(source, { fs, path: '/work/grow.canvas', signal: new AbortController().signal })
  assert.equal(prepared.ok, true)
  assert.equal([...prepared.contents.values()].filter(content => content.kind === 'image').length, 2)
  assert.match(prepared.contents.get('n2').detail, /24 MiB/u)
  assert.equal(prepared.diagnostics.at(-1).severity, 'warning')
})
