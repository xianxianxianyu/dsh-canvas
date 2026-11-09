import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { setTimeout as pause } from 'node:timers/promises'
import test from 'node:test'
import { HeadlessBrowser, browserCandidates, locateBrowser } from '../src/host/browser.ts'
import { IMAGE_PIXEL_BUDGET, MAX_SIDE, screenshot, renderMock } from '../src/host/raster.ts'
import { parseBoard, scene } from '../src/shared/board.ts'
import { boardPageHtml } from '../src/shared/page.ts'

const location = locateBrowser(undefined, browserCandidates(process.platform, process.env, homedir()), existsSync)
const skip = location.kind === 'missing' && location.reason
const document = { width: 100, height: 100, html: '<!doctype html><p>bounded</p>', background: '#fff' }

test('F2 real Chrome refuses the 600000 px board within the render deadline and idles out', { skip, timeout: 10000 }, async () => {
  const nodes = [
    { id: 'a', type: 'text', text: 'near', x: 0, y: 0, width: 200, height: 100 },
    { id: 'b', type: 'text', text: 'far', x: 600000, y: 600000, width: 200, height: 100 },
  ]
  const page = boardPageHtml(scene(parseBoard(JSON.stringify({ nodes })).board), new Map(), 'light')
  const headless = new HeadlessBrowser(20)
  let chrome
  try {
    await headless.use(location.path, async browser => {
      chrome = browser
      const start = performance.now()
      await assert.rejects(screenshot(browser, page, new AbortController().signal, { timeoutMs: 1000 }), /太大/u)
      assert.ok(performance.now() - start < 1000, 'oversized capture must settle before the deadline')
      assert.equal(browser.contexts().length, 0)
    })
    assert.equal(headless.users, 0)
    for (let i = 0; i < 100 && chrome.isConnected(); i++) await pause(20)
    assert.equal(chrome.isConnected(), false, 'idle shutdown really disconnects Chrome')
  } finally { await headless.dispose() }
})

for (const cancel of ['deadline', 'abort']) {
  test(`F2 real Chrome ${cancel} cancels an unanswered evaluation and releases its context and user`, { skip, timeout: 10000 }, async () => {
    const headless = new HeadlessBrowser(20)
    const controller = new AbortController()
    let chrome, abortTimer
    try {
      await assert.rejects(headless.use(location.path, async browser => {
        chrome = browser
        const newContext = browser.newContext.bind(browser)
        browser.newContext = async options => {
          const context = await newContext(options)
          const newPage = context.newPage.bind(context)
          context.newPage = async () => {
            const page = await newPage()
            const evaluate = page.evaluate.bind(page)
            // This is an actual pending Chromium protocol evaluation, not a host-only promise.
            page.evaluate = () => {
              if (cancel === 'abort') abortTimer = setTimeout(() => controller.abort(new Error('caller cancelled')), 30)
              return evaluate(() => Promise.withResolvers().promise)
            }
            return page
          }
          return context
        }
        const start = performance.now()
        // The abort case must reach evaluation even when other Chrome tests start concurrently.
        const timeoutMs = cancel === 'abort' ? 5000 : 500
        try { return await renderMock(browser, document, controller.signal, true, { timeoutMs }) }
        finally { assert.ok(performance.now() - start < timeoutMs + 1000, 'cancelled protocol call must not remain hung') }
      }, controller.signal), cancel === 'abort' ? /caller cancelled/u : /超时/u)
      assert.equal(headless.users, 0)
      for (let i = 0; i < 100 && chrome.isConnected(); i++) await pause(20)
      assert.equal(chrome.contexts().length, 0)
      assert.equal(chrome.isConnected(), false)
    } finally { clearTimeout(abortTimer); await headless.dispose() }
  })
}

test('F2 real PNGs respect both pixel and longest-side budgets at the rounding boundaries', { skip, timeout: 10000 }, async () => {
  const headless = new HeadlessBrowser()
  try {
    await headless.use(location.path, async browser => {
      for (const [width, height] of [[1302, 1302], [13151, 12865], [4096, 100]]) {
        const shot = await screenshot(browser, { ...document, width, height }, new AbortController().signal)
        assert.ok(shot.width * shot.height <= IMAGE_PIXEL_BUDGET, `${shot.width}×${shot.height}`)
        assert.ok(Math.max(shot.width, shot.height) <= MAX_SIDE)
      }
    })
  } finally { await headless.dispose() }
})
