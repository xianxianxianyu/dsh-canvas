import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import test from 'node:test'
import { HeadlessBrowser, browserCandidates, locateBrowser } from '../src/host/browser.ts'
import { screenshot } from '../src/host/raster.ts'
import { renderDiagram } from '../src/shared/diagram.ts'
import { PAGE_PADDING, pageHtml } from '../src/shared/page.ts'
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
