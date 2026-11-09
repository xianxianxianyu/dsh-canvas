import assert from 'node:assert/strict'
import test from 'node:test'
import { performance } from 'node:perf_hooks'
import { applyBoardOps } from '../src/shared/board-ops.ts'
import { largeBoard, dragOps } from './fixtures/large-board.mjs'

test('F3: a 200-node drag on 4000 nodes completes under one second and applies every position', () => {
  const { source, nodes } = largeBoard(4000)
  const ops = dragOps(nodes)
  const start = performance.now()
  const result = applyBoardOps(source, ops)
  const elapsed = performance.now() - start
  assert.equal(result.ok, true)
  assert.deepEqual(result.statuses, Array(200).fill('applied'))
  const actual = JSON.parse(result.text).nodes
  for (let i = 0; i < 200; i++) assert.deepEqual([actual[i].x, actual[i].y], [ops[i].x, ops[i].y])
  assert.deepEqual(actual.slice(200), nodes.slice(200))
  assert.ok(elapsed < 1000, `200-node drag took ${elapsed.toFixed(1)} ms`)
})
