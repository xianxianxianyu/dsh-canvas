import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { writeBoardOps, MAX_ATTEMPTS } from '../../src/host/board-write.ts'
import { BoardJournal } from '../../src/host/board-journal.ts'

// Execute a scratch mutant of the REAL writer, without modifying the working tree.
// The provider is a deterministic seam model, not evidence about a live DSH host.
const writerURL = new URL('../../src/host/board-write.ts', import.meta.url)
const source = await readFile(writerURL, 'utf8')
async function mutant(before, after) {
  assert.equal(source.split(before).length, 2, 'writer changed: re-ground this mutation')
  const js = stripTypeScriptTypes(source.replace(before, after))
    .replace("'../shared/board-ops.ts'", JSON.stringify(new URL('../../src/shared/board-ops.ts', import.meta.url).href))
  return (await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)).writeBoardOps
}
const noCAS = await mutant("{ kind: 'replaceIfVersion', version: info.version }", 'undefined')
const skipValidity = await mutant('applyBoardOps(text, ops)', `applyBoardOps(text === 'broken' ? '{"nodes":[],"edges":[]}' : text, ops)`)
const replayWrites = await mutant('if (edit.text === text)', 'if (false)')
const journalSource = await readFile(new URL('../../src/host/board-journal.ts', import.meta.url), 'utf8')
async function journalMutant(before, after) {
  assert.equal(journalSource.split(before).length, 2, 'journal changed: re-ground this mutation')
  const js = stripTypeScriptTypes(journalSource.replace(before, after))
    .replace("'../shared/board-ops.ts'", JSON.stringify(new URL('../../src/shared/board-ops.ts', import.meta.url).href))
    .replace("'./board-write.ts'", JSON.stringify(writerURL.href))
  return (await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)).BoardJournal
}
const NoJournal = await journalMutant("if (outcome.kind === 'done' && outcome.written) this.record(path, ops, outcome.statuses)", '')
const RecordUnwritten = await journalMutant(' && outcome.written', '')
const RetainDeclined = await journalMutant('.filter(batch => !declined.has(batch.id))', '.filter(() => true)')
const MergeLabels = await journalMutant('for (const next of applied) {', `for (let next of applied) {
  if (next.op === 'place') {
    for (const prior of batches) for (const old of prior.ops) {
      if (old.op === 'place' && old.id === next.id) next = { ...old, ...next }
    }
  }`)
const note = id => ({ id, type: 'text', text: id, x: 0, y: 0, width: 100, height: 100 })
const board = (...ids) => JSON.stringify({ nodes: ids.map(note), edges: [] })
const ops = [{ op: 'addNote', ...note('person') }]
const signal = new AbortController().signal
const target = { targetKey: 'board.canvas', displayPath: 'board.canvas' }
const stale = () => Object.assign(new Error('file changed since it was read'), { code: 'FS_STALE_VERSION' })
class File {
  text = board()
  version = 0
  observed = 0
  writes = 0
  refreshObservation = false
  beforeWrite = () => {}
  stat = async () => ({ type: 'file', version: String(this.version) })
  readText = async () => this.text
  writeText = async (_target, text, expected) => {
    this.beforeWrite()
    if (expected?.kind === 'replaceIfVersion' && expected.version !== String(this.version)) throw stale()
    this.text = text
    this.version++
    this.writes++
    if (this.refreshObservation) this.observed = this.version
    return { version: String(this.version) }
  }
  agentWrite(text) {
    if (this.observed !== this.version) throw stale()
    this.text = text
    this.observed = ++this.version
  }
  ids() { return JSON.parse(this.text).nodes.map(node => node.id).sort() }
}
const evidence = []
for (const [label, writer] of [['current', writeBoardOps], ['no-CAS scratch mutant', noCAS]]) {
  const fs = new File()
  let inject = true
  fs.beforeWrite = () => {
    if (!inject) return
    inject = false
    fs.agentWrite(board('agent'))
  }
  const result = await writer(fs, target, ops, signal)
  assert.equal(result.kind, 'done')
  assert.deepEqual(fs.ids(), label === 'current' ? ['agent', 'person'] : ['person'])
  evidence.push({ scenario: label, result: result.kind, facts: fs.ids() })
}
for (const refresh of [false, true]) {
  const fs = new File()
  const agentSnapshot = fs.text
  fs.refreshObservation = refresh
  assert.equal((await writeBoardOps(fs, target, ops, signal)).kind, 'done')
  const edited = JSON.parse(agentSnapshot)
  edited.nodes.push(note('agent'))
  if (refresh) fs.agentWrite(JSON.stringify(edited))
  else assert.throws(() => fs.agentWrite(JSON.stringify(edited)), { code: 'FS_STALE_VERSION' })
  assert.deepEqual(fs.ids(), refresh ? ['agent'] : ['person'])
  evidence.push({ scenario: refresh ? 'refresh-observation seam mutant' : 'current observation isolation', facts: fs.ids() })
}
for (const [label, writer] of [['current invalid guard', writeBoardOps], ['skip-validity scratch mutant', skipValidity]]) {
  const fs = new File()
  fs.text = 'broken'
  const result = await writer(fs, target, ops, signal)
  assert.equal(result.kind, label.startsWith('current') ? 'invalid-source' : 'done')
  assert.equal(fs.writes, label.startsWith('current') ? 0 : 1)
  evidence.push({ scenario: label, result: result.kind, writes: fs.writes })
}
{
  const fs = new File()
  assert.equal((await writeBoardOps(fs, target, ops, signal)).written, true)
  const before = { text: fs.text, version: fs.version, writes: fs.writes }
  const replay = await writeBoardOps(fs, target, ops, signal)
  assert.deepEqual(replay, { kind: 'done', written: false, version: String(before.version), statuses: ['unchanged'] })
  assert.deepEqual({ text: fs.text, version: fs.version, writes: fs.writes }, before)
  evidence.push({ scenario: 'resend after lost reply', result: 'same bytes, version and write count' })
}
{
  const fs = new File()
  await replayWrites(fs, target, ops, signal)
  const before = fs.version
  await replayWrites(fs, target, ops, signal)
  assert.equal(fs.version, before + 1)
  evidence.push({ scenario: 'no-change guard scratch mutant', result: 'resend changes version' })
}
for (const Journal of [BoardJournal, RecordUnwritten]) {
  const fs = new File()
  fs.text = '{"nodes":[{"id":"a","type":"text","text":"A","x":0,"y":0,"width":100,"height":100}]}'
  const before = fs.text
  const journal = new Journal()
  const outcome = await journal.apply(fs, target, target.displayPath, [
    { op: 'place', id: 'a', x: 1 }, { op: 'place', id: 'a', x: 0 },
  ], signal)
  assert.deepEqual(outcome, { kind: 'done', written: false, version: '0', statuses: ['applied', 'applied'] })
  assert.deepEqual({ text: fs.text, version: fs.version, writes: fs.writes }, { text: before, version: 0, writes: 0 })
  fs.text = before.replace('"x":0', '"x":5')
  fs.version++
  const lost = journal.lost(target.displayPath, fs.text)
  assert.equal(lost.length, Journal === BoardJournal ? 0 : 1)
  evidence.push({ scenario: Journal === BoardJournal ? 'net-zero batch is not journaled' : 'record-unwritten scratch mutant',
    written: outcome.written, writes: fs.writes, detectedBatches: lost.length })
}
for (const Journal of [BoardJournal, NoJournal]) {
  const fs = new File()
  const journal = new Journal()
  assert.equal((await journal.apply(fs, target, target.displayPath, ops, signal)).kind, 'done')
  await journal.apply(fs, target, target.displayPath, ops, signal) // unchanged retry must not duplicate intent
  fs.text = board('agent') // policy-off blind overwrite of the person's acknowledged note
  fs.version++
  const lost = journal.lost(target.displayPath, fs.text)
  assert.equal(lost.length, Journal === BoardJournal ? 1 : 0)
  if (Journal === BoardJournal) {
    assert.equal(lost[0].count, 1)
    assert.equal((await journal.apply(fs, target, target.displayPath, lost[0].ops, signal)).kind, 'done')
    assert.deepEqual(fs.ids(), ['agent', 'person'])
    assert.deepEqual(journal.lost(target.displayPath, fs.text), [])
  }
  evidence.push({ scenario: Journal === BoardJournal ? 'policy-off detection and reapply' : 'no-journal scratch mutant',
    detectedBatches: lost.length, facts: fs.ids() })
}
for (const Journal of [BoardJournal, RetainDeclined]) {
  const fs = new File()
  const journal = new Journal()
  assert.equal((await journal.apply(fs, target, target.displayPath, ops, signal)).kind, 'done')
  fs.text = board('agent') // the same valid-text overwrite and decline path as RetainDeclined.cfg
  fs.version++
  const lost = journal.lost(target.displayPath, fs.text)
  assert.equal(lost.length, 1)
  const before = { text: fs.text, version: fs.version, writes: fs.writes }
  await journal.decline(target.displayPath, [lost[0].id])
  const expected = Journal === BoardJournal ? [] : [lost[0].id]
  const afterDecline = journal.lost(target.displayPath, fs.text).map(batch => batch.id)
  assert.deepEqual(afterDecline, expected)
  assert.deepEqual({ text: fs.text, version: fs.version, writes: fs.writes }, before)
  // Repeating a decline, including an absent ID, is successful and has no new effect.
  await journal.decline(target.displayPath, [lost[0].id, 'absent-batch'])
  assert.deepEqual(journal.lost(target.displayPath, fs.text).map(batch => batch.id), expected)
  fs.text = board('agent', 'person')
  fs.version++
  assert.deepEqual(journal.lost(target.displayPath, fs.text), [])
  fs.text = board('agent')
  fs.version++
  const afterLaterOverwrite = journal.lost(target.displayPath, fs.text).map(batch => batch.id)
  assert.deepEqual(afterLaterOverwrite, expected)
  evidence.push({ scenario: Journal === BoardJournal ? 'decline removes retained recovery' : 'retain-declined scratch mutant',
    afterDeclineBatches: afterDecline, afterLaterOverwriteBatches: afterLaterOverwrite, facts: fs.ids() })
}
{
  const fs = new File()
  const other = new File()
  const journal = new BoardJournal()
  const otherPath = 'other.canvas'
  const otherTarget = { targetKey: otherPath, displayPath: otherPath }
  assert.equal((await journal.apply(fs, target, target.displayPath, ops, signal)).kind, 'done')
  assert.equal((await journal.apply(fs, target, target.displayPath, [{ op: 'addNote', ...note('keep') }], signal)).kind, 'done')
  assert.equal((await journal.apply(other, otherTarget, otherPath, ops, signal)).kind, 'done')
  fs.text = other.text = board('agent')
  fs.version++
  other.version++
  const lost = journal.lost(target.displayPath, fs.text)
  const otherLost = journal.lost(otherPath, other.text)
  assert.equal(lost.length, 2)
  assert.equal(otherLost.length, 1)
  const selected = lost.find(batch => batch.ops.some(op => op.id === 'person'))
  const kept = lost.find(batch => batch.ops.some(op => op.id === 'keep'))
  assert.ok(selected)
  assert.ok(kept)
  await journal.decline(target.displayPath, [selected.id, otherLost[0].id])
  assert.deepEqual(journal.lost(target.displayPath, fs.text).map(batch => batch.id), [kept.id])
  assert.deepEqual(journal.lost(otherPath, other.text), otherLost)
  evidence.push({ scenario: 'decline is batch- and path-scoped',
    remainingBatches: [kept.id], otherPathBatches: otherLost.map(batch => batch.id) })
}
{
  const fs = new File()
  let rounds = 0
  fs.beforeWrite = () => {
    fs.observed = fs.version
    fs.agentWrite(board(...Array.from({ length: ++rounds }, (_, i) => `agent-${i + 1}`)))
  }
  assert.equal((await writeBoardOps(fs, target, ops, signal)).kind, 'busy')
  assert.equal(rounds, MAX_ATTEMPTS)
  assert.equal(fs.writes, 0)
  fs.beforeWrite = () => {}
  assert.equal((await writeBoardOps(fs, target, ops, signal)).kind, 'done')
  assert.equal(fs.ids().length, MAX_ATTEMPTS + 1)
  evidence.push({ scenario: 'busy then resend', rounds, facts: fs.ids() })
}
for (const Journal of [BoardJournal, MergeLabels]) {
  const fs = new File()
  fs.text = board('person')
  const journal = new Journal()
  await journal.apply(fs, target, target.displayPath, [{ op: 'place', id: 'person', x: 0, y: 0, width: 300, height: 50 }], signal)
  fs.text = fs.text.replace('"width":300', '"width":500')
  fs.version++
  const [resize] = journal.lost(target.displayPath, fs.text)
  await journal.apply(fs, target, target.displayPath, [{ op: 'place', id: 'person', x: 40, y: 40 }], signal)
  const [retained] = journal.lost(target.displayPath, fs.text)
  assert.equal(retained.id === resize.id, Journal === BoardJournal)
  if (Journal === BoardJournal) {
    assert.equal(retained.at, resize.at)
    assert.deepEqual(retained.ops, [{ op: 'place', id: 'person', width: 300, height: 50 }])
  }
  fs.text = fs.text.replace('"x":40,"y":40', '"x":60,"y":60')
  fs.version++
  await journal.apply(fs, target, target.displayPath, retained.ops, signal)
  const node = JSON.parse(fs.text).nodes[0]
  assert.equal(node.x, Journal === BoardJournal ? 60 : 40)
  assert.equal(node.width, 300)
  evidence.push({ scenario: Journal === BoardJournal ? 'per-field identity and recovery' : 'merged-label scratch mutant',
    originalBatch: resize.id, reportedBatch: retained.id, replay: retained.ops, positionAfterRecovery: node.x })
}
const out = resolve(process.argv[2] ?? join(tmpdir(), 'dsh-board-writes'))
await mkdir(out, { recursive: true })
await writeFile(join(out, 'code-probes.json'), JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify(evidence, null, 2))
