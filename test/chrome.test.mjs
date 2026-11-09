import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import test from 'node:test'
import { HeadlessBrowser, browserCandidates, locateBrowser } from '../src/host/browser.ts'
import { screenshot } from '../src/host/raster.ts'
import { renderDiagram } from '../src/shared/diagram.ts'
import { diagramNodes } from '../src/shared/nodes.ts'
import { PAGE_PADDING, THEMES, pageHtml } from '../src/shared/page.ts'
import { decodePng } from './png.mjs'

const location = locateBrowser(undefined, browserCandidates(process.platform, process.env, homedir()), existsSync)
const skip = location.kind === 'missing' && `no Chrome or Edge installed: ${location.reason}`

/** The centre and half size of a node's rect, in page CSS pixels. */
function box(svg, id) {
  const node = new RegExp(`data-id="${id}" transform="translate\\(([\\d.]+),([\\d.]+)\\)"><rect x="(-?[\\d.]+)" y="(-?[\\d.]+)" width="([\\d.]+)" height="([\\d.]+)"`, 'u').exec(svg)
  assert.ok(node, `node ${id} not found`)
  const [cx, cy, x, y, width, height] = node.slice(1).map(Number)
  return { cx: PAGE_PADDING + cx + x + width / 2, cy: PAGE_PADDING + cy + y + height / 2, halfWidth: width / 2, halfHeight: height / 2 }
}

test('Chrome screenshots the shared page with the statechart colors', { skip }, async () => {
  const diagram = renderDiagram(await readFile(new URL('fixtures/statechart.mmd', import.meta.url), 'utf8'))
  assert.equal(diagram.ok, true)
  const page = pageHtml({ markup: diagram.svg, width: diagram.width, height: diagram.height }, 'light')
  const headless = new HeadlessBrowser()
  let shot
  try {
    shot = await headless.use(location.path, browser => screenshot(browser, page, new AbortController().signal))
  } finally {
    await headless.dispose()
  }
  assert.equal(shot.scale, 2)
  assert.deepEqual([shot.width, shot.height], [page.width * 2, page.height * 2])
  const png = decodePng(shot.png)
  assert.deepEqual([png.width, png.height], [shot.width, shot.height])
  const at = (x, y) => png.rgb(x * shot.scale, y * shot.scale)
  assert.equal(at(2, 2), '#ffffff')

  // `class s3 breaks` alone, with no classDef in the file: the red comes from the shared theme,
  // in the colors of the statechart skill's render.md.
  const failed = box(diagram.svg, 's3')
  assert.equal(at(failed.cx, failed.cy - failed.halfHeight), '#e72e3b', 'breaks border')
  assert.equal(at(failed.cx - failed.halfWidth + 6, failed.cy), '#ffecee', 'breaks fill')
  const cart = box(diagram.svg, 's1')
  assert.equal(at(cart.cx - cart.halfWidth + 6, cart.cy), '#bfe3df', 'teal group')
  const paying = box(diagram.svg, 's2')
  assert.equal(at(paying.cx, paying.cy - paying.halfHeight), '#1680f3', 'bugPath border')
})

const pageOf = (source, options) => {
  const diagram = renderDiagram(source)
  assert.equal(diagram.ok, true)
  return { diagram, page: pageHtml({ markup: diagram.svg, width: diagram.width, height: diagram.height }, 'light', options) }
}

test('node boxes computed from the SVG text match what Chrome lays out', { skip }, async () => {
  const sources = [
    await readFile(new URL('fixtures/statechart.mmd', import.meta.url), 'utf8'),
    'flowchart TD\n a[rect] --> b(round) --> c([stadium]) --> d[[sub]] --> e[(db)] --> f((circle)) --> g>asym] --> h{diam} --> i{{hex}} --> j[/para/] --> n(((dbl)))',
    'sequenceDiagram\n  participant A as 用户\n  participant B as 服务\n  A->>B: 请求',
    'mindmap\n  root((中心))\n    A\n      B1[分支]',
    'classDiagram\n  class Animal {\n    +name: string\n  }\n  Animal <|-- Dog',
  ]
  const headless = new HeadlessBrowser()
  try {
    await headless.use(location.path, async browser => {
      for (const source of sources) {
        const { diagram, page } = pageOf(source)
        const context = await browser.newContext({ viewport: { width: page.width, height: page.height }, bypassCSP: true })
        try {
          const tab = await context.newPage()
          await tab.setContent(page.html)
          // Chrome's box of a node's drawn shapes (its label text excluded), per occurrence of the id.
          const laid = await tab.evaluate(() => [...document.querySelectorAll('.pele-node[data-id]')].map(node => {
            const shapes = [...node.querySelectorAll('rect, circle, ellipse, polygon, polyline, path, line')]
            if (!shapes.length) return { id: node.dataset.id, box: null }
            const rects = shapes.map(shape => shape.getBoundingClientRect())
            const x = Math.min(...rects.map(r => r.left)); const y = Math.min(...rects.map(r => r.top))
            return { id: node.dataset.id, box: { x, y, width: Math.max(...rects.map(r => r.right)) - x, height: Math.max(...rects.map(r => r.bottom)) - y } }
          }))
          const computed = diagramNodes(diagram.svg).flatMap(node => node.boxes.length ? node.boxes.map(box => ({ id: node.id, box })) : [{ id: node.id, box: null }])
          assert.equal(computed.length, laid.length, source.split('\n')[0])
          for (const { id, box } of laid) {
            const match = computed.find(entry => entry.id === id && (box === null ? entry.box === null
              : entry.box !== null && ['x', 'y', 'width', 'height'].every(key => Math.abs((key === 'x' || key === 'y' ? PAGE_PADDING : 0) + entry.box[key] - box[key]) < 0.6)))
            assert.ok(match, `${source.split('\n')[0]}: node ${id} laid out at ${JSON.stringify(box)}, computed ${JSON.stringify(computed.filter(entry => entry.id === id))}`)
          }
        } finally {
          await context.close()
        }
      }
    })
  } finally {
    await headless.dispose()
  }
})

test('an outlined node shows a dashed frame in the comment color in the screenshot', { skip }, async () => {
  const source = await readFile(new URL('fixtures/statechart.mmd', import.meta.url), 'utf8')
  const plain = pageOf(source)
  const outlined = pageOf(source, { outline: ['s3'] })
  const s3 = diagramNodes(plain.diagram.svg).find(node => node.id === 's3').boxes[0]
  const headless = new HeadlessBrowser()
  const shots = []
  try {
    for (const { page } of [plain, outlined]) shots.push(await headless.use(location.path, browser => screenshot(browser, page, new AbortController().signal)))
  } finally {
    await headless.dispose()
  }
  // The frame sits 5 to 7.5 CSS px outside the node's drawn box (its border included); find the
  // row of that band with the most comment-red pixels along the top side.
  const framed = shots.map(shot => {
    const png = decodePng(shot.png)
    let best = 0
    for (let y = Math.round((PAGE_PADDING + s3.y - 10) * shot.scale); y < (PAGE_PADDING + s3.y - 4) * shot.scale; y++) {
      let hits = 0
      for (let x = Math.round((PAGE_PADDING + s3.x) * shot.scale); x < (PAGE_PADDING + s3.x + s3.width) * shot.scale; x++) {
        if (png.rgb(x, y) === THEMES.light.comment) hits++
      }
      best = Math.max(best, hits)
    }
    return best
  })
  assert.equal(framed[0], 0, 'no frame without the option')
  assert.ok(framed[1] > s3.width * shots[1].scale * 0.3, `dashed frame present (${framed[1]} red pixels on one row above the node)`)
})
