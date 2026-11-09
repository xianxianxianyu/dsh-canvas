import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { render } from 'pele'
import { DIAGRAM_OPTIONS, renderDiagram } from '../src/shared/diagram.ts'

const fixture = name => readFile(new URL(`fixtures/${name}`, import.meta.url), 'utf8')

test('a broken arrow is located at its line and column with the source line', async () => {
  const outcome = renderDiagram(await fixture('broken.mmd'))
  assert.equal(outcome.ok, false)
  assert.equal(outcome.diagnostics.length, 1)
  const [problem] = outcome.diagnostics
  assert.equal(problem.severity, 'error')
  assert.equal(problem.line, 4)
  assert.equal(problem.column, 6)
  assert.equal(problem.snippet, '  s2 -> s3\n-----^')
  assert.match(problem.message, /^Parse error on line 4: Expecting /u)
  assert.ok(!problem.message.includes('\n'), 'the snippet is not repeated inside the message')
})

test('text that is no diagram fails without a position', () => {
  const outcome = renderDiagram('hello world')
  assert.equal(outcome.ok, false)
  assert.deepEqual(outcome.diagnostics, [{ severity: 'error', message: 'No diagram type detected for the given text.' }])
})

test('a valid chart renders to SVG that keeps Mermaid ids and classes on its nodes', async () => {
  const outcome = renderDiagram(await fixture('statechart.mmd'))
  assert.equal(outcome.ok, true)
  assert.equal(outcome.kind, 'stateDiagram')
  assert.match(outcome.svg, /^<svg[^>]* class="pele pele-state"/u)
  assert.match(outcome.svg, /<g class="pele-node pele-state breaks" data-id="s3"/u)
  assert.match(outcome.svg, />支付失败</u)
  assert.ok(outcome.width > 0 && outcome.height > 0)
})

test('the SVG is the same with or without a canvas, as in the browser and in Node', async () => {
  const source = await fixture('statechart.mmd')
  const node = renderDiagram(source)
  // pele measures labels with a canvas whenever one exists, as in every browser. A canvas that
  // measures every character 50px wide changes pele's default output but not ours.
  const wide = { getContext: () => ({ font: '', measureText: text => ({ width: text.length * 50 }) }) }
  globalThis.OffscreenCanvas = function OffscreenCanvas() { return wide }
  try {
    const withCanvas = render(source, { ...DIAGRAM_OPTIONS, measurer: undefined, fontFamily: 'canvas-probe' })
    assert.ok(withCanvas.width > node.width, 'pele\'s default measurer follows the canvas')
    assert.equal(renderDiagram(source).svg, node.svg)
  } finally {
    delete globalThis.OffscreenCanvas
  }
  // And the fixed table is pele's own: in Node, without a canvas, pele's default gives the same SVG.
  assert.equal(render(source, { ...DIAGRAM_OPTIONS, measurer: undefined }).svg, node.svg)
})
