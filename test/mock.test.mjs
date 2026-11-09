import assert from 'node:assert/strict'
import test from 'node:test'
import { parse, serializeOuter } from 'parse5'
import { parseMock, MOCK_VIEWPORTS } from '../src/shared/mock.ts'
import { mockPage } from '../src/shared/page.ts'
import { threadsOf } from '../src/shared/comments.ts'

const html = (body, head = '') => `<!doctype html>\n<html><head><meta charset="utf-8">${head}</head>\n<body>\n${body}\n</body></html>`
const parsed = source => {
  const result = parseMock(source)
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics))
  return result
}

test('mock viewport uses desktop by default, presets, meta dimensions and comment markers', () => {
  assert.deepEqual(parsed(html('<p>Hello</p>')).document.viewport, MOCK_VIEWPORTS.desktop)
  assert.deepEqual(parsed(html('', '<meta name="canvas-viewport" content="mobile">')).document.viewport, { width: 390, height: 844 })
  assert.deepEqual(parsed(html('', '<meta name="canvas-viewport" content="desktop">')).document.viewport, { width: 1280, height: 800 })
  assert.deepEqual(parsed(html('', '<meta name="canvas-viewport" content="420x900">')).document.viewport, { width: 420, height: 900 })
  assert.deepEqual(parsed(html('<!-- canvas-viewport: 390x844 -->')).document.viewport, { width: 390, height: 844 })
  const bad = parseMock(html('', '<meta name="canvas-viewport" content="0x844">'))
  assert.equal(bad.ok, false)
  assert.match(bad.diagnostics[0].message, /canvas-viewport/u)
  assert.equal(typeof bad.diagnostics[0].line, 'number')
})

test('HTML parser reports malformed syntax with original line, column and source snippet', () => {
  const result = parseMock(html('<div title=>broken</div>'))
  assert.equal(result.ok, false)
  const error = result.diagnostics.find(item => item.severity === 'error')
  assert.equal(error.line, 4)
  assert.equal(error.column, 12)
  assert.match(error.message, /missing-attribute-value/u)
  assert.match(error.snippet, /<div title=>broken<\/div>\n[- ]*\^/u)
})

test('scripts, event handlers and external resource attributes are warned and removed', () => {
  const result = parsed(html('<script>parent.hacked = true</script>\n<img src="https://example.com/logo.png" onerror="alert(1)">\n<a id="external" href="/private">Account</a>\n<iframe srcdoc="<script>alert(1)</script>"></iframe>\n<base href="https://example.com/">'))
  const page = mockPage(result.document)
  assert.doesNotMatch(page.html, /<script|onerror=|<iframe|<base|https:\/\/example\.com|href="\/private"/iu)
  for (const needle of ['script', 'src', 'href']) {
    const diagnostic = result.diagnostics.find(item => item.message.includes(needle))
    assert.ok(diagnostic, needle)
    assert.equal(diagnostic.severity, 'warning')
    assert.ok(diagnostic.line > 0 && diagnostic.column > 0)
    assert.ok(diagnostic.snippet.includes('^'))
  }
})

test('mock page keeps inline CSS and data images behind a first, network-denying CSP', () => {
  const image = 'data:image/png;base64,iVBORw0KGgo='
  const result = parsed(html(`<img src="${image}"><button id="save" style="color: red">Save</button>`, '<meta http-equiv="refresh" content="0;url=https://example.com"><style>body{background:#abc} .photo{background:url(https://example.com/x)}</style>'))
  const page = mockPage(result.document, { outline: ['save'] })
  assert.match(page.html, /default-src 'none'/u)
  assert.match(page.html, /script-src 'none'/u)
  assert.match(page.html, /style-src 'unsafe-inline'/u)
  assert.match(page.html, /img-src data:/u)
  assert.match(page.html, /base-uri 'none'/u)
  assert.match(page.html, /form-action 'none'/u)
  assert.ok(page.html.indexOf('Content-Security-Policy') < page.html.indexOf('<style>'))
  assert.ok(page.html.includes(image))
  assert.match(page.html, /body\{background:#abc\}/u)
  assert.doesNotMatch(page.html, /http-equiv="refresh"/iu)
  assert.equal(page.width, 1280)
  assert.equal(page.height, 800)
  assert.equal(mockPage(result.document, { viewport: MOCK_VIEWPORTS.mobile }).width, 390)
})

test('duplicate ids and ambiguous canonical comment anchors fail with their source positions', () => {
  for (const body of ['<p id="same">A</p>\n<button id="same">B</button>', '<p data-canvas-id="same">A</p>\n<button id="same">B</button>']) {
    const result = parseMock(html(body))
    assert.equal(result.ok, false)
    const error = result.diagnostics.find(item => item.severity === 'error')
    assert.match(error.message, /same/u)
    assert.equal(error.line, 5)
    assert.ok(error.column > 0)
  }
})

test('all interactive elements need a stable id or data-canvas-id', () => {
  const result = parsed(html('<button>Go</button>\n<a href="#top">Top</a>\n<input>\n<select></select>\n<textarea></textarea>\n<div role="button">More</div>\n<button id="ok">OK</button>\n<input data-canvas-id="email">'))
  const warnings = result.diagnostics.filter(item => /id|data-canvas-id/u.test(item.message))
  assert.equal(warnings.length, 6)
  assert.deepEqual(warnings.map(item => item.line), [4, 5, 6, 7, 8, 9])
  assert.deepEqual([...result.document.targets.keys()], ['ok', 'email'])
})

test('mock anchors prefer data-canvas-id, permit unknown labels without false drift, and detect removed anchors', () => {
  const mock = parsed(html('<button id="dom-id" data-canvas-id="submit">Sign in</button>')).document
  assert.deepEqual([...mock.targets.keys()], ['submit'])
  const root = { id: 'u-1', author: 'user', text: 'Change copy', status: 'open', at: '2026-11-09T00:00:00Z', anchor: { target: 'submit', label: 'Sign in' } }
  assert.equal(threadsOf([root], mock.targets)[0].drift, undefined)
  assert.equal(threadsOf([root], new Map([['submit', 'Continue']]))[0].drift.kind, 'renamed')
  assert.equal(threadsOf([root], new Map())[0].drift.kind, 'gone')
})

test('mock comment outline targets either anchor attribute and cannot escape the style element', () => {
  const mock = parsed(html('<button id="submit">Sign in</button><p data-canvas-id="copy">Welcome</p>')).document
  const page = mockPage(mock, { outline: ['submit', 'copy', '</style><script>evil</script>'] })
  assert.match(page.html, /outline:.*dashed/u)
  assert.match(page.html, /\[id=/u)
  assert.match(page.html, /\[data-canvas-id=/u)
  assert.doesNotMatch(page.html, /<script>evil/u)
  assert.equal((page.html.match(/<\/style>/gu) ?? []).length, 1)
})

test('deep mock nesting reports a located error instead of overflowing the stack', () => {
  const result = parseMock(html('<div>'.repeat(3000) + 'deep' + '</div>'.repeat(3000)))
  assert.equal(result.ok, false)
  const error = result.diagnostics.find(item => item.severity === 'error')
  assert.match(error.message, /嵌套.*256/u)
  assert.equal(error.line, 4)
  assert.ok(error.column > 0)
  assert.ok(error.snippet.includes('^'))
  assert.equal(parsed(html('<div>'.repeat(100) + 'ordinary' + '</div>'.repeat(100))).ok, true)
})

const mxss = [
  ['noscript', '<noscript><p title="</noscript><img src=x onerror=alert(1)>">'],
  ['svg/style', '<svg><style><img src=x onerror=alert(1)></style></svg>'],
  ['math/mglyph', '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">'],
  ['form nesting', '<form><math><mtext></form><form><mglyph><style></math><iframe src="https://adv-opus-check-iframe.example.com/f"></iframe><meta http-equiv="refresh" content="0;url=https://example.com/"><img src=x onerror=alert(1)></style></mglyph></form></mtext></math></form>'],
]

for (const [name, body] of mxss) {
  test(`mXSS ${name} remains passive and stable after re-parsing`, () => {
    const result = parseMock(html(body))
    if (!result.ok) {
      assert.ok(result.diagnostics.some(item => item.severity === 'error' && item.line > 0))
      return
    }
    const tree = parse(result.document.html, { scriptingEnabled: false })
    const queue = [...tree.childNodes]
    for (const node of queue) {
      if (node.childNodes) queue.push(...node.childNodes)
      if (node.content) queue.push(node.content)
      if (!node.tagName) continue
      assert.ok(!['script', 'iframe', 'meta'].includes(node.tagName) || (node.tagName === 'meta' && !node.attrs.some(attr => attr.name === 'http-equiv')), `${name}: live ${node.tagName}`)
      assert.ok(!node.attrs.some(attr => attr.name.startsWith('on') || attr.name === 'srcdoc' || attr.name === 'src' && !attr.value.startsWith('data:')), `${name}: active attribute`)
    }
    const root = tree.childNodes.find(node => node.tagName === 'html')
    assert.equal(serializeOuter(root), result.document.html)
    if (name === 'form nesting') assert.ok(result.diagnostics.some(item => item.severity === 'warning'))
  })
}
