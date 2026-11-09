import assert from 'node:assert/strict'
import test from 'node:test'
import { browserCandidates, locateBrowser } from '../src/host/browser.ts'

const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const macUserChrome = '/home/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const macEdge = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'

test('candidates list Chrome before Edge on every platform', () => {
  assert.deepEqual(browserCandidates('darwin', {}, '/home/me'), [
    macChrome, macUserChrome, macEdge, '/home/me/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ])
  assert.deepEqual(browserCandidates('win32', { PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'C:\\Users\\me'), [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe',
  ])
  assert.deepEqual(browserCandidates('win32', { PROGRAMFILES: 'C:\\Program Files' }, 'C:\\Users\\me'), [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ], 'unset program directories are skipped')
  const linux = browserCandidates('linux', {}, '/home/me')
  assert.equal(linux[0], '/opt/google/chrome/chrome')
  assert.ok(linux.indexOf('/usr/bin/google-chrome') < linux.indexOf('/opt/microsoft/msedge/msedge'))
})

test('discovery takes the first installed candidate', () => {
  const installed = paths => path => paths.includes(path)
  const candidates = browserCandidates('darwin', {}, '/home/me')
  assert.deepEqual(locateBrowser(undefined, candidates, installed([macEdge, macUserChrome])), { kind: 'found', path: macUserChrome })
  assert.deepEqual(locateBrowser(undefined, candidates, installed([macEdge])), { kind: 'found', path: macEdge })
  assert.deepEqual(locateBrowser(undefined, candidates, installed([])), {
    kind: 'missing', reason: '本机找不到 Chrome 或 Edge（可在插件配置 browserPath 里指定浏览器）',
  })
})

test('a configured browserPath is used alone, even when it is missing', () => {
  const candidates = browserCandidates('darwin', {}, '/home/me')
  assert.deepEqual(locateBrowser('/opt/chromium/chrome', candidates, path => path === '/opt/chromium/chrome'), { kind: 'found', path: '/opt/chromium/chrome' })
  assert.deepEqual(locateBrowser('/nowhere/chrome', candidates, path => path === macChrome), {
    kind: 'missing', reason: '配置的 browserPath 不存在：/nowhere/chrome',
  })
})
