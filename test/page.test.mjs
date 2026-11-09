import assert from 'node:assert/strict'
import test from 'node:test'
import { PAGE_PADDING, THEMES, pageHtml } from '../src/shared/page.ts'

const svg = '<svg xmlns="http://www.w3.org/2000/svg" class="pele pele-state" width="120" height="80.4"><g class="pele-node breaks" data-id="s3"><rect/></g></svg>'

test('the page carries the SVG, the statechart palette and its padded size', () => {
  const page = pageHtml({ markup: svg, width: 120, height: 80.4 }, 'light')
  assert.ok(page.html.includes(`<body class="canvas-page">${svg}</body>`))
  assert.ok(page.html.includes('.pele .breaks rect{fill:#ffecee!important;stroke:#e72e3b!important;stroke-width:2.5px!important}'))
  assert.ok(page.html.includes('.pele .breaks text{fill:#cd2834!important}'))
  assert.ok(page.html.includes('.pele .mayBreak rect{fill:#fff3e6!important;stroke:#e8730c!important'))
  assert.ok(page.html.includes('.pele .bugPath rect{stroke:#1680f3!important'))
  assert.ok(page.html.includes('.pele .repeats rect{stroke:#9b35d6!important;stroke-width:2.5px!important;stroke-dasharray:6 3}'))
  for (const [group, fill] of Object.entries(THEMES.light.groups)) assert.ok(page.html.includes(`.pele .${group} rect{fill:${fill}}`), group)
  assert.ok(page.html.includes('--pele-bg:#ffffff;--pele-fg:#1c1c1c'))
  // Group colors come first so a bug mark shows over a group color.
  assert.ok(page.html.indexOf('.pink rect') < page.html.indexOf('.breaks rect'))
  assert.equal(page.width, 120 + 2 * PAGE_PADDING)
  assert.equal(page.height, 81 + 2 * PAGE_PADDING)
  assert.equal(page.background, '#ffffff')
})

test('the dark page swaps the whole palette and never loads scripts or the network', () => {
  const page = pageHtml({ markup: svg, width: 120, height: 80 }, 'dark')
  assert.ok(page.html.includes('.pele .breaks rect{fill:#2e2021!important;stroke:#cf2b35!important'))
  assert.ok(page.html.includes('--pele-bg:#1f1f1f'))
  assert.ok(!page.html.includes('#ffecee'))
  assert.equal(page.background, '#1f1f1f')
  assert.match(page.html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">/u)
  assert.ok(!/<script/iu.test(page.html))
})
