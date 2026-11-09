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
const NoJournal = await journalMutant("if (outcome.kind === 'done') this.record(path, ops, outcome.statuses)", '')
const RetainDeclined = await journalMutant('.filter(batch => !declined.has(batch.id))', '.filter(() => true)')
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
  assert.equal((await writeBoardOps(fs, target, ops, signal)).kind, 'done')
  const before = { text: fs.text, version: fs.version, writes: fs.writes }
  assert.equal((await writeBoardOps(fs, target, ops, signal)).kind, 'done')
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
const out = resolve(process.argv[2] ?? join(tmpdir(), 'dsh-board-writes'))
await mkdir(out, { recursive: true })
await writeFile(join(out, 'code-probes.json'), JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify(evidence, null, 2))
