import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { HeadlessBrowser, browserCandidates, locateBrowser } from '../src/host/browser.ts'

const location = locateBrowser(undefined, browserCandidates(process.platform, process.env, homedir()), existsSync)
const skip = location.kind === 'missing' && `no Chrome or Edge installed: ${location.reason}`

const SOURCE = 'stateDiagram-v2\n  [*] --> s1\n  s1: 待支付\n  s2: 支付中\n  s3: 支付失败\n  s1 --> s2: 支付\n  s2 --> s3: 失败\n  s3 --> s1: 重来\n'

/**
 * The sidebar renderer as DSH mounts it: React 18, the zh dictionary with `{name}` parameters, and
 * an in-memory comment route behind `fetch` that records each POST in `window.posts`.
 * `show(source)` renders the body for new file bytes; `hide()` replaces it with DSH's loading text,
 * which is what DSH does while it re-reads a changed file.
 */
const harness = `
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { DiagramPreview } from './src/client/DiagramPreview.tsx'
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
const resourceAddress = 'dsh-resource://file/absolute/w/order.mmd'
window.show = source => flushSync(() => root.render(createElement(DiagramPreview, { content: { kind: 'bytes', data: new TextEncoder().encode(source) }, resourceAddress, t })))
window.hide = () => flushSync(() => root.render(createElement('p', null, '文档渲染中...')))
`

const bundle = (await build({
  stdin: { contents: harness, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'jsx', sourcefile: 'harness.jsx' },
  bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2023', jsx: 'automatic', logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"' },
})).outputFiles[0].text

/**
 * Run `work` on a fresh page with the preview of SOURCE in a 700×600 pane. The page is
 * `about:blank`, which is not a secure context, like DSH web served over plain http on a LAN
 * address. Uncaught page errors fail the test.
 */
async function withPreview(work) {
  const headless = new HeadlessBrowser()
  try {
    await headless.use(location.path, async browser => {
      const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
      page.setDefaultTimeout(5000)
      const errors = []
      page.on('pageerror', error => { errors.push(error.message) })
      await page.setContent('<!doctype html><html><body style="margin:0"><div id="root" style="width:700px;height:600px"></div></body></html>')
      await page.addScriptTag({ content: bundle })
      await page.evaluate(source => { window.show(source) }, SOURCE)
      await page.waitForSelector('[data-canvas-diagram] iframe')
      await work(page)
      assert.deepEqual(errors, [], 'no uncaught errors in the page')
    })
  } finally {
    await headless.dispose()
  }
}

/** Comment mode on, click `node`, type `text`, Enter; resolves once its pin shows. */
async function comment(page, node, text) {
  if (await page.locator('[data-canvas-diagram]').getAttribute('data-canvas-commenting') === null) {
    await page.getByRole('button', { name: '批注', exact: true }).click()
  }
  await page.locator(`[data-canvas-node="${node}"]`).click()
  await page.locator('[data-canvas-draft] textarea').fill(text)
  await page.keyboard.press('Enter')
  await page.waitForSelector(`[data-canvas-pin="${node}"]`)
}

test('a comment can be written where crypto.randomUUID does not exist', { skip }, async () => {
  await withPreview(async page => {
    assert.deepEqual(await page.evaluate(() => [isSecureContext, typeof crypto.randomUUID]), [false, 'undefined'])
    await comment(page, 's3', '失败后应该能直接重试')
    const posts = await page.evaluate(() => window.posts)
    assert.equal(posts.length, 1)
    assert.match(posts[0].ops[0].id, /^u-[0-9a-z]+-[0-9a-f]{8}$/)
    assert.deepEqual(posts[0].ops[0].anchor, { target: 's3', label: '支付失败' })
    assert.equal(await page.locator('[data-canvas-pin="s3"]').getAttribute('aria-label'), '1 条批注：支付失败')
  })
})
