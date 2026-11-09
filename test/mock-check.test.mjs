import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { posix } from 'node:path'
import test from 'node:test'
import { HeadlessBrowser, browserCandidates, locateBrowser } from '../src/host/browser.ts'
import { canvasCheckTool } from '../src/host/check.ts'
import { BoardJournal } from '../src/host/board-journal.ts'
import * as raster from '../src/host/raster.ts'
import { parseMock } from '../src/shared/mock.ts'
import { mockPage } from '../src/shared/page.ts'
import { decodePng } from './png.mjs'

const signal = new AbortController().signal
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
const html = (body, head = '') => `<!doctype html>\n<html><head><meta charset="utf-8">${head}</head>\n<body>\n${body}\n</body></html>`
const root = (id, target, label) => ({ id, author: 'user', text: `Review ${target}`, status: 'open', at: '2026-11-09T00:00:00Z', anchor: { target, label } })
const node = (id, label) => ({ id, label, boxes: [{ x: 20, y: 30, width: 100, height: 40 }] })
const missing = { kind: 'missing', reason: '本机找不到 Chrome 或 Edge' }

function harness({
  source = html('<button id="dom" data-canvas-id="submit">Continue</button>'),
  comments = [], model = 'vision', browser = { kind: 'found', path: '/chrome' },
  inspection = { nodes: [node('submit', 'Continue')], diagnostics: [] },
  attachment = 'png', saveError, headless,
} = {}) {
  const stats = { browserLookups: 0, uses: 0, loads: [], inspections: 0, captures: 0, reads: 0, saved: [] }
  const recording = {
    async use(_path, work) {
      stats.uses++
      return work({
        async newContext() {
          return {
            async route() {},
            async newPage() {
              return {
                async setContent(content) { stats.loads.push(content) },
                async evaluate(inspect) { assert.equal(typeof inspect, 'function'); stats.inspections++; return inspection },
                async screenshot() { stats.captures++; return PNG },
              }
            },
            async close() {},
          }
        },
      })
    },
  }
  const tool = canvasCheckTool({
    fs: {
      async resolve(path, options) { return { displayPath: posix.resolve(options?.cwd ?? '/', path) } },
      async stat() { return { type: 'file', version: '1', size: source.length } },
      async readText() { return source },
      processPath(target) { return target.displayPath },
    },
    workingDirectory: { ensure: async () => '/work' },
    attachments: () => attachment === 'missing' ? undefined : {
      imageLimits: { mediaTypes: attachment === 'png' ? ['image/png'] : ['image/jpeg'] },
      async saveImage(input) {
        stats.saved.push(input)
        if (saveError) throw new Error(saveError)
        return { attachmentId: 'mock-image', mediaType: 'image/png', bytes: input.data.length, width: 1, height: 1 }
      },
    },
    llm: () => ({ resolveModelInfo: async () => ({ inputModalities: model === 'vision' ? ['text', 'image'] : ['text'] }) }),
    browser: () => { stats.browserLookups++; return browser },
    headless: headless ?? recording,
    store: { async read() { stats.reads++; return { comments } } },
    journal: new BoardJournal(),
  })
  const agent = { session: { requestHeader: () => undefined }, options: { provider: 'test', model } }
  return { tool, stats, run: (args = {}) => tool.execute({ path: 'login.mock.html', ...args }, { signal, agent, callId: 'mock-check' }) }
}

test('mock without Chrome passes static warnings and comments without launching or inventing rename drift', async () => {
  const { run, stats } = harness({
    source: html('<button>Unanchored</button>\n<button id="dom" data-canvas-id="submit">Continue</button>'),
    comments: [root('u-1', 'submit', 'Sign in'), root('u-2', 'removed', 'Cancel')], browser: missing,
  })
  const value = await run()
  assert.match(value.text, /^✓ .*\/work\/login\.mock\.html：校验通过/u)
  assert.match(value.text, /4:1 警告 .*id/u)
  assert.match(value.text, /未出图：本机找不到 Chrome 或 Edge/u)
  assert.match(value.text, /u-1 未处理 · 用户 · submit「Sign in」/u)
  assert.match(value.text, /图里已没有 removed/u)
  assert.doesNotMatch(value.text, /submit 的文字已从|图里已没有 submit/u)
  assert.equal(value.image, undefined)
  assert.equal(stats.uses, 0)
  assert.equal(stats.captures, 0)
  assert.equal(stats.saved.length, 0)
  assert.equal(stats.reads, 1)
})

test('mock image:false is strictly static even when Chrome and an image-capable model exist', async () => {
  const { run, stats } = harness({ comments: [root('u-1', 'submit', 'Sign in')] })
  const value = await run({ image: false })
  assert.match(value.text, /未出图：本次只校验（image: false）/u)
  assert.doesNotMatch(value.text, /submit 的文字已从|图里已没有 submit/u)
  assert.equal(stats.browserLookups, 0)
  assert.equal(stats.uses, 0)
  assert.equal(stats.inspections, 0)
  assert.equal(stats.captures, 0)
  assert.equal(stats.saved.length, 0)
})

for (const [options, reason] of [
  [{ model: 'text-only' }, '当前模型 text-only 不支持看图'],
  [{ attachment: 'missing' }, 'DSH 没有挂载附件服务'],
  [{ attachment: 'jpeg' }, '当前部署不接受 PNG 图片'],
]) {
  test(`mock still measures layout but never captures a PNG when ${reason}`, async () => {
    const { run, stats } = harness({
      ...options,
      comments: [root('u-1', 'submit', 'Sign in')],
      inspection: { nodes: [node('submit', 'Continue')], diagnostics: [{ severity: 'warning', message: '页面横向溢出 320 px' }] },
    })
    const value = await run()
    assert.match(value.text, /警告 页面横向溢出 320 px/u)
    assert.ok(value.text.includes(`未出图：${reason}`))
    assert.match(value.text, /submit 的文字已从「Sign in」变成「Continue」/u)
    assert.equal(value.image, undefined)
    assert.equal(stats.uses, 1)
    assert.equal(stats.loads.length, 1)
    assert.equal(stats.inspections, 1)
    assert.equal(stats.captures, 0)
    assert.equal(stats.saved.length, 0)
    assert.equal(stats.reads, 1)
  })
}

test('mock uses canonical anchors for one outlined render, renames, removals and hidden-label deferral', async () => {
  const { run, stats } = harness({
    source: html('<button id="dom" data-canvas-id="submit">Continue</button><span id="hidden" hidden>Invisible</span>'),
    comments: [root('u-1', 'submit', 'Sign in'), root('u-2', 'removed', 'Cancel'), root('u-3', 'hidden', 'Invisible')],
  })
  const value = await run()
  assert.equal(value.image.attachmentId, 'mock-image')
  assert.match(value.text, /待处理批注 3 条（图上红色虚线框标出）/u)
  assert.match(value.text, /submit 的文字已从「Sign in」变成「Continue」/u)
  assert.match(value.text, /图里已没有 removed/u)
  assert.doesNotMatch(value.text, /图里已没有 hidden|hidden 的文字已从/u)
  assert.equal(stats.loads.length, 1)
  assert.match(stats.loads[0], /outline:.*dashed/u)
  assert.ok(stats.loads[0].includes('submit'))
  assert.equal(stats.inspections, 1)
  assert.equal(stats.captures, 1)
  assert.equal(stats.saved.length, 1)
  assert.equal(stats.saved[0].name, 'login.mock.html.png')
  assert.equal(stats.reads, 1)
})

test('a mock attachment save failure retains static warnings, layout diagnostics and measured comment drift', async () => {
  const { run, stats } = harness({
    source: html('<button>Missing anchor</button><button id="submit">Continue</button>'),
    comments: [root('u-1', 'submit', 'Sign in')], saveError: 'disk full\nprivate detail',
    inspection: { nodes: [node('submit', 'Continue')], diagnostics: [{ severity: 'warning', message: '文字被裁切' }] },
  })
  const value = await run()
  assert.match(value.text, /4:1 警告 .*id/u)
  assert.match(value.text, /警告 文字被裁切/u)
  assert.match(value.text, /submit 的文字已从「Sign in」变成「Continue」/u)
  assert.match(value.text, /未出图：图片未能保存：disk full/u)
  assert.doesNotMatch(value.text, /private detail/u)
  assert.equal(value.image, undefined)
  assert.equal(stats.loads.length, 1)
  assert.equal(stats.captures, 1)
  assert.equal(stats.reads, 1)
})

const location = locateBrowser(undefined, browserCandidates(process.platform, process.env, homedir()), existsSync)
const skip = location.kind === 'missing' && `no Chrome or Edge installed: ${location.reason}`
const layoutSource = html(`
<button id="dom" data-canvas-id="submit">Continue</button>
<p id="clip">This text must visibly extend beyond its tiny clipping box</p>
<div id="wide">Wide content</div>
<div id="hidden" hidden>Not visible</div>`, `<meta name="canvas-viewport" content="320x240"><style>
body{margin:0;background:#fff;color:#000;font:16px Arial}
button{position:absolute;left:40px;top:40px;width:120px;height:40px;background:#fff;border:1px solid #000}
#clip{position:absolute;left:20px;top:90px;width:60px;height:20px;margin:0;white-space:nowrap;overflow:hidden}
#wide{position:absolute;left:0;top:140px;width:600px;height:30px}
</style>`)

test('real Chrome measures text-only mock overflow, clipped text and renamed comments without PNG capture', { skip }, async t => {
  const headless = new HeadlessBrowser()
  t.after(() => headless.dispose())
  let captures = 0
  let loads = 0
  const observed = {
    use: (path, work) => headless.use(path, browser => work({
      async newContext(options) {
        const context = await browser.newContext(options)
        const newPage = context.newPage.bind(context)
        context.newPage = async () => {
          const tab = await newPage()
          const setContent = tab.setContent.bind(tab)
          tab.setContent = async (...args) => { loads++; return setContent(...args) }
          tab.screenshot = async () => { captures++; throw new Error('text-only must never capture') }
          return tab
        }
        return context
      },
    })),
  }
  const { run, stats } = harness({ source: layoutSource, model: 'text-only', browser: location, headless: observed, comments: [root('u-1', 'submit', 'Sign in')] })
  const value = await run()
  assert.match(value.text, /警告 .*横向.*溢出/u)
  assert.match(value.text, /警告 文字裁切：#clip /u)
  assert.match(value.text, /submit 的文字已从「Sign in」变成「Continue」/u)
  assert.match(value.text, /未出图：当前模型 text-only 不支持看图/u)
  assert.equal(value.image, undefined)
  assert.equal(loads, 1)
  assert.equal(captures, 0)
  assert.equal(stats.saved.length, 0)
})

test('real mock raster keeps authored geometry, paints comment outlines, and blocks scripts and network', { skip }, async t => {
  const requests = []
  const server = createServer((request, response) => { requests.push(request.url); response.end(PNG) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  await fetch(`${origin}/probe`)
  assert.deepEqual(requests, ['/probe'], 'the network observer can receive requests')
  const source = layoutSource.replace('<html>', `<html lang="zh-CN" class="authored-root" style="background-image:url(${origin}/root)">`)
    .replace('</head>', `<style>body{background-image:url(${origin}/css)}</style></head>`)
    .replace('</body>', `<script>document.body.style.backgroundColor='rgb(255,0,0)'</script><img src="${origin}/image" onerror="document.body.style.backgroundColor='rgb(255,0,0)'"></body>`)
  const parsed = parseMock(source)
  assert.equal(parsed.ok, true)
  const headless = new HeadlessBrowser()
  t.after(() => headless.dispose())
  const results = []
  for (const outline of [[], ['submit']]) {
    const page = mockPage(parsed.document, { outline })
    results.push(await headless.use(location.path, browser => raster.renderMock(browser, page, signal, true)))
  }
  const [plain, framed] = results
  assert.deepEqual(plain.inspection.nodes.find(entry => entry.id === 'submit').boxes, [{ x: 40, y: 40, width: 120, height: 40 }])
  assert.equal(plain.inspection.nodes.find(entry => entry.id === 'submit').label, 'Continue')
  assert.equal(plain.inspection.nodes.some(entry => entry.id === 'dom' || entry.id === 'hidden'), false)
  assert.ok(plain.inspection.diagnostics.some(entry => /横向.*溢出/u.test(entry.message)))
  assert.ok(plain.inspection.diagnostics.some(entry => /clip/u.test(entry.message) && /裁切|截|溢出/u.test(entry.message)))
  const redPixels = results.map(result => {
    const { shot } = result
    assert.ok(shot)
    const png = decodePng(shot.png)
    assert.deepEqual([png.width, png.height], [Math.round(320 * shot.scale), Math.round(240 * shot.scale)])
    assert.equal(png.rgb(5 * shot.scale, 5 * shot.scale), '#ffffff', 'authored scripts cannot repaint the page')
    let red = 0
    for (let y = Math.floor(28 * shot.scale); y < 40 * shot.scale; y++) {
      for (let x = Math.floor(36 * shot.scale); x < 164 * shot.scale; x++) {
        const color = png.rgb(x, y)
        const [r, g, b] = [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16))
        if (r > 150 && r > g * 1.4 && r > b * 1.2) red++
      }
    }
    return red
  })
  assert.equal(redPixels[0], 0)
  assert.ok(redPixels[1] > 50, `the actual outlined PNG contains a red frame (${redPixels[1]} pixels)`)
  assert.deepEqual(framed.inspection.nodes, plain.inspection.nodes, 'outlining does not move authored geometry')
  assert.deepEqual(requests, ['/probe'], 'neither authored CSS nor image resources reach the network')
  await headless.use(location.path, async browser => {
    // Unlike raster's offline context, this proves that the page's CSP blocks early root CSS.
    const context = await browser.newContext({ viewport: { width: 320, height: 240 }, javaScriptEnabled: true, offline: false })
    try {
      const probe = await context.newPage()
      await probe.setContent(`<!doctype html><script>globalThis.probeRan=true</script><img src="${origin}/browser-probe">`, { waitUntil: 'load' })
      assert.equal(await probe.evaluate(() => globalThis.probeRan), true, 'the comparison context permits authored scripts')
      assert.deepEqual(requests, ['/probe', '/browser-probe'], 'the comparison browser can reach the network')
      await probe.close()
      const tab = await context.newPage()
      const requested = []
      const blocked = []
      tab.on('request', request => requested.push(request.url()))
      tab.on('requestfailed', request => blocked.push({ url: request.url(), error: request.failure()?.errorText }))
      await tab.setContent(mockPage(parsed.document).html, { waitUntil: 'load' })
      const root = await tab.evaluate(() => ({
        lang: document.documentElement.lang,
        classes: document.documentElement.className,
        background: getComputedStyle(document.documentElement).backgroundImage,
      }))
      assert.equal(root.lang, 'zh-CN')
      assert.equal(root.classes, 'authored-root')
      assert.ok(root.background.includes(`${origin}/root`), 'authored root CSS survives sanitizing and HTML5 document merging')
      // Chromium emits `request` even for a CSP-rejected CSS URL; network effects are the server
      // log, while requestfailed identifies why those attempted loads never reached it.
      assert.deepEqual(blocked.map(entry => entry.url), requested)
      assert.ok(blocked.every(entry => /csp/iu.test(entry.error ?? '')), JSON.stringify(blocked))
      assert.deepEqual(requests, ['/probe', '/browser-probe'], 'neither root CSS nor body CSS reaches the server')
    } finally {
      await context.close()
    }
  })
})
