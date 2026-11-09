import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const require = createRequire(import.meta.url)

test('published client claims only canvas session files as an interactive tab and keeps diagram preview', () => {
  let client
  const externals = new Set()
  runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(registration) {
      client = registration.factory(id => { externals.add(id); return require(id) })
    } } }, TextDecoder, TextEncoder, URL, console,
  })
  const tabs = []
  const previews = []
  const slots = []
  const ctx = {
    effect: install => install(),
    locale: { register: () => () => {}, bind: () => key => key },
    slots: { inject: (_name, install) => install(), register: (definition, component) => { slots.push({ ...definition, component }); return () => {} } },
    sidebarRightTabs: { register: definition => { tabs.push(definition); return () => {} } },
    documentPreviews: { register: definition => { previews.push(definition); return () => {} } },
    remote: { workspaceFiles: { readBytes: () => assert.fail('registration must not read') } },
    resources: { source: () => assert.fail('registration must not watch') },
  }
  client.apply(ctx)
  assert.equal(tabs.length, 1)
  assert.equal(tabs[0].id, 'dsh-canvas/board')
  assert.equal(tabs[0].kind, 'canvas.board')
  assert.deepEqual(Array.from(tabs[0].patterns), ['*.canvas'])
  assert.equal(tabs[0].priority, 'extension')
  assert.equal(tabs[0].canOpen('dsh-resource://file/session/test/work/plan.canvas'), true)
  assert.equal(tabs[0].canOpen('dsh-resource://file/absolute/work/plan.canvas'), false)
  assert.equal(tabs[0].title('dsh-resource://file/session/test/work/plan.canvas'), 'plan.canvas')
  assert.equal(previews.length, 1)
  assert.equal(previews[0].id, 'dsh-canvas/diagram')
  assert.ok(slots.some(slot => slot.name === 'sidebar.right.pane.tab' && slot.key === 'dsh-canvas/board' && typeof slot.component === 'function'))
  assert.ok(slots.some(slot => slot.name === 'sidebar.right.tab.document' && slot.key === 'dsh-canvas/diagram'))
  assert.ok([...externals].every(id => ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'].includes(id)), `only React is external: ${[...externals]}`)
})
