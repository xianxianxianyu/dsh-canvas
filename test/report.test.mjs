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

const T0 = '2026-11-09T08:00:00.000Z'
const thread = (root, replies = [], drift) => ({ root, replies, ...drift ? { drift } : {} })

test('a passing check appends the open and addressed comments with replies and drift warnings', () => {
  const ok = { path: '/w/order.mmd', mode: 'diagram', ok: true, detail: 'stateDiagram，258×344 px', diagnostics: [] }
  const threads = [
    thread({ id: 'u-1', author: 'user', text: '失败后应该能直接重试', status: 'open', at: T0, anchor: { target: 's3', label: '支付失败' } },
      [{ id: 'a-1', author: 'agent', text: '加了重试箭头', status: 'open', at: T0, re: 'u-1' }]),
    thread({ id: 'u-2', author: 'user', text: '名字不对', status: 'addressed', at: T0, anchor: { target: 's1', label: '购物车' } }, [],
      { kind: 'renamed', label: '订单', movedTo: ['s5'] }),
    thread({ id: 'u-3', author: 'user', text: '这步多余', status: 'open', at: T0, anchor: { target: 's9', label: '旧状态' } }, [],
      { kind: 'gone', movedTo: [] }),
    thread({ id: 'u-4', author: 'user', text: '整体太挤', status: 'open', at: T0 }),
  ]
  const text = formatCheck({ ...ok, image: { kind: 'attached', width: 580, height: 752, scale: 2 }, comments: { kind: 'threads', threads } })
  assert.equal(text, [
    '✓ 图 /w/order.mmd：校验通过（stateDiagram，258×344 px）',
    '已出图：580×752 PNG，按 2× 截取，与右侧栏预览同一页面。',
    '待处理批注 4 条（图上红色虚线框标出）：',
    '  u-1 未处理 · 用户 · s3「支付失败」：失败后应该能直接重试',
    '    ↳ a-1 agent：加了重试箭头',
    '  u-2 已处理 · 用户 · s1「购物车」：名字不对',
    '    ⚠ s1 的文字已从「购物车」变成「订单」；「购物车」现在是 s5',
    '  u-3 未处理 · 用户 · s9「旧状态」：这步多余',
    '    ⚠ 图里已没有 s9（批注时是「旧状态」）',
    '  u-4 未处理 · 用户 · 整张图：整体太挤',
    '改完后用 canvas_comment 回复，并传 status: "addressed" 标记已处理；只有用户能标记为已解决。',
  ].join('\n'))
  const textOnly = formatCheck({ ...ok, image: { kind: 'skipped', reason: '本次只校验（image: false）' }, comments: { kind: 'threads', threads: threads.slice(0, 1) } })
  assert.equal(textOnly.split('\n')[2], '待处理批注 1 条：', 'no frame is promised without a picture')
  const none = formatCheck({ ...ok, image: { kind: 'skipped', reason: 'x' }, comments: { kind: 'threads', threads: [] } })
  assert.equal(none, '✓ 图 /w/order.mmd：校验通过（stateDiagram，258×344 px）\n未出图：x', 'no section when nothing is pending')
  const broken = formatCheck({ ...ok, image: { kind: 'skipped', reason: 'x' }, comments: { kind: 'unreadable', reason: '/r/comments/ab.jsonl:3 不是合法的批注' } })
  assert.equal(broken.split('\n')[2], '批注读不出来：/r/comments/ab.jsonl:3 不是合法的批注')
})
