import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { HeadlessBrowser, browserCandidates, locateBrowser } from '../src/host/browser.ts'

const location = locateBrowser(undefined, browserCandidates(process.platform, process.env, homedir()), existsSync)
const skip = location.kind === 'missing' && `no Chrome or Edge installed: ${location.reason}`
const SOURCE = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#fff;font:16px sans-serif} #panel{position:absolute;left:100px;top:140px;width:220px;height:180px;z-index:1}
#behind{position:absolute;left:100px;top:140px;width:220px;height:180px;z-index:0}
#submit{position:absolute;left:24px;top:36px;width:150px;height:48px} #other{position:absolute;left:340px;top:220px;width:120px;height:44px}
.secret{display:none}
</style></head><body><section id="panel"><button id="submit" data-canvas-id="send">继续<span class="secret">隐藏的密钥</span></button></section>
<div id="behind">后层</div><button id="other">取消</button><p id="hidden" hidden>不可见内容</p>
<script>parent.sourceScriptRan = true; document.body.textContent = 'unsafe'</script></body></html>`

const harness = `
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { MockPreview } from './src/client/MockPreview.tsx'
import { zh } from './src/client/locales.ts'
const t = (key, params) => (zh[key] ?? key).replace(/\\{(\\w+)\\}/g, (_, name) => String(params?.[name]))
let comments = []
let version = 0
window.posts = []
window.fetch = async (_url, init) => {
  if (init?.method === 'POST') {
    const body = JSON.parse(init.body)
    window.posts.push(body)
    for (const op of body.ops) {
      if (op.op === 'create') comments = [...comments, { id: op.id, author: 'user', text: op.text, status: 'open', at: new Date().toISOString(), anchor: op.anchor }]
    }
    version++
  }
  return Response.json({ version: 'v' + version, comments })
}
const root = createRoot(document.getElementById('root'))
const resourceAddress = 'dsh-resource://file/absolute/w/login.mock.html'
window.show = source => flushSync(() => root.render(createElement(MockPreview, { content: { kind: 'bytes', data: new TextEncoder().encode(source) }, resourceAddress, t })))
window.hide = () => flushSync(() => root.render(createElement('p', null, '文档渲染中...')))
`
let bundle
async function withPreview(work, size = { width: 700, height: 700 }, source = SOURCE) {
  bundle ??= (await build({
    stdin: { contents: harness, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'jsx', sourcefile: 'mock-harness.jsx' },
    bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2023', jsx: 'automatic', logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"production"' },
  })).outputFiles[0].text
  const headless = new HeadlessBrowser()
  try {
    await headless.use(location.path, async browser => {
      const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } })
      page.setDefaultTimeout(5000)
      const errors = []
      page.on('pageerror', error => { errors.push(error.message) })
      await page.setContent(`<!doctype html><html><body style="margin:0"><div id="root" style="width:${size.width}px;height:${size.height}px"></div></body></html>`)
      await page.addScriptTag({ content: bundle })
      await page.evaluate(source => { window.show(source) }, source)
      await page.waitForSelector('[data-canvas-mock] iframe')
      await page.waitForSelector('[data-canvas-node="send"]', { state: 'attached' })
      await work(page)
      assert.deepEqual(errors, [], 'no uncaught errors in the trusted parent')
    })
  } finally {
    await headless.dispose()
  }
}

// Click the authored element's real location, not a synthetic rectangle chosen by DOM order.
async function clickElement(page, id) {
  const point = await page.evaluate(id => {
    const frame = document.querySelector('[data-canvas-mock] iframe')
    const outer = frame.getBoundingClientRect()
    const inner = frame.contentDocument.getElementById(id).getBoundingClientRect()
    const scale = outer.width / frame.offsetWidth
    return { x: outer.left + (inner.left + inner.width / 2) * scale, y: outer.top + (inner.top + inner.height / 2) * scale }
  }, id)
  await page.mouse.click(point.x, point.y)
}
async function comment(page, id, text) {
  if (await page.locator('[data-canvas-mock]').getAttribute('data-canvas-commenting') === null) {
    await page.getByRole('button', { name: '批注', exact: true }).click()
  }
  await clickElement(page, id)
  await page.locator('[data-canvas-draft] textarea').fill(text)
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => window.posts.length > 0)
}
const dimensions = page => page.evaluate(() => {
  const frame = document.querySelector('[data-canvas-mock] iframe')
  return [frame.offsetWidth, frame.offsetHeight, frame.contentWindow.innerWidth, frame.contentWindow.innerHeight]
})

test('mock stays in an inert same-origin script-free frame and parent geometry uses page pixels', { skip }, async () => {
  await withPreview(async page => {
    const observed = await page.evaluate(() => {
      const frame = document.querySelector('[data-canvas-mock] iframe')
      const box = document.querySelector('[data-canvas-node="send"]')
      const doc = frame.contentDocument
      const actual = doc.getElementById('submit').getBoundingClientRect()
      return {
        preview: frame.closest('[data-canvas-preview]') !== null,
        diagram: document.querySelector('[data-canvas-diagram]') !== null,
        sandbox: frame.getAttribute('sandbox'), inert: frame.hasAttribute('inert'), pointer: getComputedStyle(frame).pointerEvents,
        ran: window.sourceScriptRan === true, scripts: doc.scripts.length,
        injectedIntoParent: document.getElementById('submit') !== null,
        actual: { x: actual.x, y: actual.y, width: actual.width, height: actual.height },
        overlay: { x: parseFloat(box.style.left), y: parseFloat(box.style.top), width: parseFloat(box.style.width), height: parseFloat(box.style.height) },
      }
    })
    assert.equal(observed.preview, true)
    assert.equal(observed.diagram, false)
    assert.equal(observed.sandbox, 'allow-same-origin')
    assert.equal(observed.inert, true)
    assert.equal(observed.pointer, 'none')
    assert.equal(observed.ran, false)
    assert.equal(observed.scripts, 0)
    assert.equal(observed.injectedIntoParent, false)
    assert.deepEqual(observed.actual, { x: 124, y: 176, width: 150, height: 48 })
    assert.equal(observed.overlay.x + observed.overlay.width / 2, observed.actual.x + observed.actual.width / 2, 'no diagram padding enters mock coordinates')
    assert.equal(observed.overlay.y + observed.overlay.height / 2, observed.actual.y + observed.actual.height / 2)
    assert.equal(await page.locator('[data-canvas-node="hidden"]').count(), 0, 'hidden anchors have no hit boxes')
    await page.evaluate(() => {
      const script = document.createElement('script')
      script.textContent = 'parent.injectedScriptRan = true'
      document.querySelector('[data-canvas-mock] iframe').contentDocument.body.append(script)
    })
    assert.equal(await page.evaluate(() => window.injectedScriptRan === true), false, 'sandbox/CSP also block a script inserted after sanitization')
  })
})

test('desktop/mobile switch actual layout dimensions, reset fit, and retain zoom controls', { skip }, async () => {
  await withPreview(async page => {
    assert.deepEqual(await dimensions(page), [1280, 800, 1280, 800])
    const zoom = page.getByRole('button', { name: '原始大小', exact: true })
    await page.getByRole('button', { name: '放大', exact: true }).click()
    await zoom.click()
    assert.equal(await zoom.textContent(), '100%')
    await page.getByRole('button', { name: '手机', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[data-canvas-mock] iframe').contentWindow.innerWidth === 390)
    assert.deepEqual(await dimensions(page), [390, 844, 390, 844])
    assert.equal(await page.getByRole('button', { name: '手机', exact: true }).getAttribute('aria-pressed'), 'true')
    assert.notEqual(await zoom.textContent(), '100%', 'changing layout resets manual zoom to fit')
    const fitted = parseInt(await zoom.textContent(), 10)
    await page.getByRole('button', { name: '放大', exact: true }).click()
    assert.ok(parseInt(await zoom.textContent(), 10) > fitted)
    await page.getByRole('button', { name: '适应窗口', exact: true }).click()
    assert.equal(parseInt(await zoom.textContent(), 10), fitted)
    await page.getByRole('button', { name: '桌面', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[data-canvas-mock] iframe').contentWindow.innerWidth === 1280)
    assert.deepEqual(await dimensions(page), [1280, 800, 1280, 800])
  })
})

test('source custom viewport is available beside presets and controls remain reachable in narrow panes', { skip }, async () => {
  await withPreview(async page => {
    assert.deepEqual(await dimensions(page), [620, 940, 620, 940])
    await page.getByRole('button', { name: '手机', exact: true }).click()
    await page.getByRole('button', { name: /620.*940/u }).click()
    await page.waitForFunction(() => document.querySelector('[data-canvas-mock] iframe').contentWindow.innerWidth === 620)
    assert.deepEqual(await dimensions(page), [620, 940, 620, 940])
    await page.getByRole('button', { name: '批注列表', exact: true }).click()
    await page.getByRole('button', { name: '批注', exact: true }).click()
    for (const name of ['桌面', '手机', '批注', '批注列表', '放大', '缩小', '适应窗口']) {
      const control = page.getByRole('button', { name, exact: true })
      await control.click({ trial: true })
      const box = await control.boundingBox()
      assert.ok(box.x >= 0 && box.x + box.width <= 320 && box.y >= 0 && box.y + box.height <= 800, `${name} stays within the pane`)
    }
  }, { width: 320, height: 800 }, SOURCE.replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="canvas-viewport" content="620x940">'))
})

test('nested DOM picking captures the actual button anchor and visible label, with pins and page outlines', { skip }, async () => {
  await withPreview(async page => {
    await comment(page, 'submit', '文案再明确一点')
    const posts = await page.evaluate(() => window.posts)
    assert.equal(posts.length, 1)
    assert.deepEqual(posts[0].ops[0].anchor, { target: 'send', label: '继续' }, 'closest nested canonical anchor wins over the enclosing panel and hidden text')
    await page.waitForSelector('[data-canvas-pin="send"]')
    assert.equal(await page.locator('[data-canvas-pin="send"]').getAttribute('aria-label'), '1 条批注：继续')
    assert.equal(await page.locator('[data-canvas-pin="panel"]').count(), 0)
    await page.waitForFunction(() => {
      const frame = document.querySelector('[data-canvas-mock] iframe')
      const button = frame.contentDocument?.getElementById('submit')
      return button && frame.contentWindow.getComputedStyle(button).outlineStyle === 'dashed'
    })
    await page.locator('[data-canvas-pin="send"]').click()
    assert.match(await page.locator('[data-canvas-comments]').innerText(), /文案再明确一点/u)
  })
})

test('source remount preserves draft, comment/list state, zoom and viewport while refreshing labels and geometry', { skip }, async () => {
  await withPreview(async page => {
    await comment(page, 'submit', '保留这条批注')
    await page.waitForSelector('[data-canvas-pin="send"]')
    await page.getByRole('button', { name: '手机', exact: true }).click()
    await page.getByRole('button', { name: '批注列表', exact: true }).click()
    await page.getByRole('button', { name: '放大', exact: true }).click()
    const zoom = await page.getByRole('button', { name: '原始大小', exact: true }).textContent()
    await clickElement(page, 'submit')
    await page.locator('[data-canvas-draft] textarea').fill('未发送的意见')
    const changed = SOURCE.replace('继续<span', '提交<span').replace('left:24px', 'left:44px')
    await page.evaluate(source => { window.hide(); window.show(source) }, changed)
    await page.waitForSelector('[data-canvas-pin="send"]')
    await page.waitForFunction(() => document.querySelector('[data-canvas-pin="send"]')?.getAttribute('aria-label') === '1 条批注：提交')
    assert.equal(await page.locator('[data-canvas-mock]').getAttribute('data-canvas-commenting'), 'true')
    assert.equal(await page.locator('[data-canvas-draft] textarea').inputValue(), '未发送的意见')
    assert.equal(await page.getByRole('button', { name: '原始大小', exact: true }).textContent(), zoom)
    assert.equal(await page.getByRole('button', { name: '手机', exact: true }).getAttribute('aria-pressed'), 'true')
    assert.deepEqual(await dimensions(page), [390, 844, 390, 844])
    assert.match(await page.locator('[data-canvas-comments]').innerText(), /send 的文字已从「继续」变成「提交」/u)
    const geometry = await page.evaluate(() => {
      const frame = document.querySelector('[data-canvas-mock] iframe')
      const node = document.querySelector('[data-canvas-node="send"]')
      const actual = frame.contentDocument.getElementById('submit').getBoundingClientRect()
      return [parseFloat(node.style.left) + parseFloat(node.style.width) / 2, actual.x + actual.width / 2]
    })
    assert.equal(geometry[0], geometry[1], 'geometry belongs to the latest iframe document')
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await page.evaluate(source => { window.show(source) }, changed.replace(/<button id="submit"[\s\S]*?<\/button>/u, ''))
    await page.waitForFunction(() => document.querySelector('[data-canvas-comments]')?.textContent.includes('图里已没有 send'))
    assert.equal(await page.locator('[data-canvas-pin="send"]').count(), 0)
  }, { width: 620, height: 900 })
})

test('rapid srcdoc replacements cannot publish geometry from a detached document and invalid input uses the shared error convention', { skip }, async () => {
  await withPreview(async page => {
    await page.evaluate(source => {
      window.show(source.replace('left:24px', 'left:54px'))
      window.show(source.replace('left:24px', 'left:84px'))
    }, SOURCE)
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-canvas-node="send"]')
      return node && parseFloat(node.style.left) + parseFloat(node.style.width) / 2 === 259
    })
    await page.evaluate(() => { window.show('<!doctype html><html><body><button id="same">A</button><button id="same">B</button></body></html>') })
    assert.match(await page.getByRole('alert').innerText(), /这个文件画不出来：/u)
    assert.match(await page.getByRole('alert').innerText(), /same/u)
    assert.equal(await page.locator('iframe').count(), 0)
  })
})
