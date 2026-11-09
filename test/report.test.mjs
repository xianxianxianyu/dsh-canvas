import assert from 'node:assert/strict'
import test from 'node:test'
import { formatCheck } from '../src/shared/report.ts'

const broken = {
  severity: 'error', message: "Parse error on line 4: Expecting 'ID', got 'INVALID'", line: 4, column: 6, snippet: '  s2 -> s3\n-----^',
}

test('a failing check lists each error at line:column with its snippet', () => {
  assert.equal(formatCheck({ path: '/w/chart.mmd', mode: 'diagram', ok: false, diagnostics: [broken] }), [
    '✗ 图 /w/chart.mmd：1 个错误',
    "  4:6 错误 Parse error on line 4: Expecting 'ID', got 'INVALID'",
    '        s2 -> s3',
    '      -----^',
    '改好文件后再运行 canvas_check。',
  ].join('\n'))
  assert.equal(formatCheck({
    path: 'x.mmd', mode: 'diagram', ok: false,
    diagnostics: [{ severity: 'error', message: 'No diagram type detected for the given text.' }],
  }).split('\n')[1], '  错误 No diagram type detected for the given text.')
})

test('a passing check names the picture, or says why there is none', () => {
  const ok = { path: '/w/chart.mmd', mode: 'diagram', ok: true, detail: 'stateDiagram，258×344 px', diagnostics: [] }
  assert.equal(formatCheck({ ...ok, image: { kind: 'attached', width: 580, height: 752, scale: 2 } }), [
    '✓ 图 /w/chart.mmd：校验通过（stateDiagram，258×344 px）',
    '已出图：580×752 PNG，按 2× 截取，与右侧栏预览同一页面。',
  ].join('\n'))
  assert.equal(formatCheck({ ...ok, image: { kind: 'skipped', reason: '当前模型 deepseek-v4-pro 不支持看图' } }), [
    '✓ 图 /w/chart.mmd：校验通过（stateDiagram，258×344 px）',
    '未出图：当前模型 deepseek-v4-pro 不支持看图',
  ].join('\n'))
  assert.equal(formatCheck({ ...ok, image: { kind: 'attached', width: 1301, height: 1300, scale: 0.6666 } }).split('\n')[1],
    '已出图：1301×1300 PNG，按 0.67× 截取，与右侧栏预览同一页面。')
})
