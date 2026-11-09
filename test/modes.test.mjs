import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { MODES, MODE_IDS, SUFFIXES, modeOf } from '../src/shared/modes.ts'

test('no two modes claim one suffix, and suffixes are lowercase without a dot', () => {
  const owners = new Map()
  for (const id of MODE_IDS) {
    for (const extension of MODES[id].extensions) {
      assert.match(extension, /^[a-z0-9]+(?:\.[a-z0-9]+)*$/u, `${id}: ${extension}`)
      assert.equal(owners.get(extension), undefined, `${extension} is claimed by ${owners.get(extension)} and ${id}`)
      owners.set(extension, id)
    }
  }
})

test('every mode has its skill file', () => {
  for (const id of MODE_IDS) {
    const path = fileURLToPath(new URL(`../skills/${MODES[id].skill}/SKILL.md`, import.meta.url))
    assert.ok(existsSync(path), `${id} needs skills/${MODES[id].skill}/SKILL.md`)
  }
})

test('a file belongs to the mode of its suffix, ignoring case and directories', () => {
  assert.equal(modeOf('/tmp/x/chart.mmd'), 'diagram')
  assert.equal(modeOf('C:\\charts\\Flow.MERMAID'), 'diagram')
  assert.equal(modeOf('docs/chart.mmd.md'), undefined)
  assert.equal(modeOf('notes.md'), undefined)
  assert.equal(SUFFIXES, '.mmd, .mermaid')
})
