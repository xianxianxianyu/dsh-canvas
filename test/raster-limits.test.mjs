import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as pause } from 'node:timers/promises'
import { HeadlessBrowser } from '../src/host/browser.ts'
import { screenshot, renderMock, imageScale, IMAGE_PIXEL_BUDGET, MAX_SIDE } from '../src/host/raster.ts'
import { canvasCheckTool } from '../src/host/check.ts'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
const page = { html: '<p>bounded</p>', width: 100, height: 100, background: '#fff' }
async function settled(promise, ms = 300) {
  const timeout = Promise.withResolvers()
  const timer = setTimeout(() => timeout.resolve({ hung: true }), ms)
  try {
    return await Promise.race([
      promise.then(value => ({ value }), error => ({ error })),
      timeout.promise,
    ])
  } finally { clearTimeout(timer) }
}

// A missing protocol reply reproduces the browser's newPage stall without hanging the test runner.
function stalledBrowser(step) {
  const never = () => Promise.withResolvers().promise
  const calls = { contextClosed: 0, browserClosed: 0 }
  const tab = {
    setContent: step === 'setContent' ? never : async () => {},
    evaluate: step === 'evaluate' ? never : async () => ({ nodes: [], diagnostics: [] }),
    screenshot: step === 'screenshot' ? never : async () => PNG,
  }
  const context = {
    route: step === 'route' ? never : async () => {},
    newPage: step === 'newPage' ? never : async () => tab,
    close: async () => { calls.contextClosed++; if (step === 'close') await never() },
  }
  const browser = {
    newContext: step === 'newContext' ? never : async () => context,
    close: async () => { calls.browserClosed++ },
  }
  const headless = new HeadlessBrowser(10)
  headless.launch = async () => browser
  return { headless, calls }
}

test('F2 impossible minimum scale refuses 200000 and 600000 px boards instead of exceeding the image budget', () => {
  for (const [width, height] of [[200032, 200032], [500232, 500132], [600232, 600132]]) {
    assert.equal(imageScale(width, height), 0, `${width}×${height} must not be captured`)
  }
  for (const [width, height] of [[1, 1], [1302, 1302], [651, 651], [13151, 12865], [100, 409601], [10000, 10000]]) {
    const scale = imageScale(width, height)
    if (scale === 0) continue
    const w = Math.ceil(width * scale), h = Math.ceil(height * scale)
    assert.ok(w * h <= IMAGE_PIXEL_BUDGET, `${w}×${h} exceeds the pixel budget`)
    assert.ok(Math.max(w, h) <= MAX_SIDE, `${w}×${h} exceeds the side budget`)
  }
})

test('F2 canvas_check settles on the 600000 px board without launching Chrome and locates the layout warning', async () => {
  const source = '{"nodes":[\n{"id":"a","type":"text","text":"near","x":0,"y":0,"width":200,"height":100},\n{"id":"b","type":"text","text":"far","x":600000,"y":600000,"width":200,"height":100}\n]}'
  let uses = 0
  const tool = canvasCheckTool({
    fs: {
      resolve: async path => ({ displayPath: path }), processPath: target => target.displayPath,
      stat: async () => ({ type: 'file', version: '1', size: source.length }), readText: async () => source,
    },
    workingDirectory: { ensure: async () => '/work' },
    llm: () => ({ resolveModelInfo: async () => ({ inputModalities: ['image'] }) }),
    attachments: () => ({ imageLimits: { mediaTypes: ['image/png'] } }),
    browser: () => ({ kind: 'found', path: '/chrome' }),
    headless: { use: async () => { uses++; throw new Error('capture must not start') } },
    store: { read: async () => ({ comments: [] }) }, journal: { lost: () => [] },
  })
  const result = await settled(tool.execute({ path: '/work/huge.canvas' }, {
    signal: new AbortController().signal, callId: 'f2',
    agent: { session: { requestHeader: () => undefined }, options: { provider: 'p', model: 'm' } },
  }))
  assert.equal(result.hung, undefined)
  assert.equal(result.error, undefined)
  assert.match(result.value.text, /未出图：画板太大（600232×600132），先把节点收拢/u)
  assert.match(result.value.text, /3:1 警告 .*节点 b.*(?:太远|距离|收拢)/u)
  assert.equal(result.value.image, undefined)
  assert.equal(uses, 0)
})

for (const step of ['newContext', 'route', 'newPage', 'setContent', 'evaluate', 'screenshot', 'close']) {
  test(`F2 timeout during ${step} settles, releases the browser user and runs idle shutdown`, async () => {
    const { headless, calls } = stalledBrowser(step)
    try {
      const result = await settled(headless.use('/chrome', browser => renderMock(browser, page, new AbortController().signal, true, { timeoutMs: 30 })))
      assert.equal(result.hung, undefined, `${step} did not settle within the timeout`)
      if (step !== 'close') assert.match(result.error?.message ?? '', /超时|timeout/iu)
      assert.equal(headless.users, 0)
      if (step !== 'newContext') assert.ok(calls.contextClosed > 0, 'cancellation closes the context')
      await pause(30)
      assert.equal(calls.browserClosed, 1, 'the idle shutdown closes the browser')
    } finally { await headless.dispose() }
  })
}

for (const step of ['newContext', 'newPage', 'setContent', 'evaluate', 'screenshot']) {
  test(`F2 abort during ${step} settles, releases the browser user and runs idle shutdown`, async () => {
    const { headless, calls } = stalledBrowser(step)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('cancelled by caller')), 10)
    try {
      const result = await settled(headless.use('/chrome', browser => renderMock(browser, page, controller.signal, true, { timeoutMs: 100 })))
      assert.equal(result.hung, undefined, `${step} ignored abort`)
      assert.match(result.error?.message ?? '', /cancelled by caller/u)
      assert.equal(headless.users, 0)
      if (step !== 'newContext') assert.ok(calls.contextClosed > 0)
      await pause(30)
      assert.equal(calls.browserClosed, 1)
    } finally { clearTimeout(timer); await headless.dispose() }
  })
}

test('F2 oversized direct captures are rejected before allocating a browser context', async () => {
  let contexts = 0
  await assert.rejects(screenshot({ newContext: async () => { contexts++; throw new Error('allocated') } }, { ...page, width: 600232, height: 600132 }, new AbortController().signal), /太大/u)
  assert.equal(contexts, 0)
})
