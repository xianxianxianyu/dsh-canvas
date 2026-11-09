import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'

const root = fileURLToPath(new URL('../../', import.meta.url))
const model = join(root, 'formal/board-write')
const out = resolve(process.argv[2] ?? join(tmpdir(), 'dsh-board-writes'))
const record = process.argv.includes('--record')
const statechart = process.env.STATECHART ?? join(homedir(), '.omp/agent/skills/statechart/scripts/statechart')
const properties = ['TypeOK', 'NoLostAcknowledgedChange', 'NoLostAgentChange', 'NoSilentLoss',
  'DeclinedNeverReported', 'NeverWritesOverInvalid', 'ReplaySafe', 'RoundsBounded', 'NoDeadlock', 'RouteTerminates', 'RecoveryEventually']
const cases = [
  ['full', 'BoardWrite', []],
  ['policy-off', 'PolicyOff', ['NoLostAcknowledgedChange']],
  ['no-cas', 'NoCAS', ['NoLostAcknowledgedChange', 'NoLostAgentChange', 'NeverWritesOverInvalid']],
  ['refresh-observation', 'RefreshObservation', ['NoLostAcknowledgedChange']],
  ['skip-validity', 'SkipValidity', ['NeverWritesOverInvalid']],
  ['replay-writes', 'ReplayWrites', ['ReplaySafe']],
  ['no-journal', 'NoJournal', ['NoLostAcknowledgedChange', 'NoSilentLoss', 'RecoveryEventually']],
  ['retain-declined', 'RetainDeclined', ['NoLostAcknowledgedChange', 'DeclinedNeverReported']],
  ['chart', 'Chart', []],
]
const summary = []
await mkdir(out, { recursive: true })
for (const [name, config, expected] of cases) {
  const destination = join(out, name)
  const result = spawnSync(statechart, [join(model, 'BoardWrite.tla'), '--config', join(model, `${config}.cfg`),
    '--view', join(model, 'view.ts'), '--out', destination], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  if (result.error) throw result.error
  assert.equal(result.status, expected.length ? 1 : 0, `${name}: statechart did not finish as expected`)
  const report = await readFile(join(destination, 'report.md'), 'utf8')
  assert.doesNotMatch(report, /Rules not checked/)
  const broken = [...report.matchAll(/^## (\w+) breaks$/gm)].map(match => match[1]).sort()
  assert.deepEqual(broken, [...expected].sort(), `${name}: unexpected property results`)
  const held = report.split('## Rules that hold\n')[1]?.trim().split(', ') ?? []
  assert.deepEqual([...held, ...broken].sort(), [...properties].sort(), `${name}: missing properties`)
  summary.push({ case: name, states: report.match(/TLC reached ([\d,]+) states/)?.[1], broken, held })
}
// A real-code mutation is loaded from memory. No src/, test/, script or profile changes.
const probe = spawnSync(process.execPath, [join(model, 'probe.mjs'), out], { cwd: root, encoding: 'utf8' })
process.stdout.write(probe.stdout ?? '')
process.stderr.write(probe.stderr ?? '')
if (probe.error) throw probe.error
assert.equal(probe.status, 0, 'real-code protocol controls failed')
await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
if (record) {
  // Only this command owns results/: discard obsolete generated traces on refresh.
  await rm(join(model, 'results'), { recursive: true, force: true })
  const clean = text => text.replaceAll(root.replace(/\/$/, ''), '$CANVAS_REPO')
    .replaceAll(out, '$OUT').replaceAll(homedir(), '$HOME').replaceAll(tmpdir(), '$TMPDIR')
  for (const [name] of cases) {
    const destination = join(model, 'results', name)
    await mkdir(destination, { recursive: true })
    for (const file of await readdir(join(out, name))) {
      if (file === 'report.md' || file === 'chart.mmd' || /^tlc(?:-[\w]+)?\.out$/.test(file)) {
        await writeFile(join(destination, file), clean(await readFile(join(out, name, file), 'utf8')))
      }
    }
  }
  await writeFile(join(model, 'chart.mmd'), await readFile(join(out, 'chart/chart.mmd')))
  await writeFile(join(model, 'results/summary.json'), await readFile(join(out, 'summary.json')))
  await writeFile(join(model, 'results/code-probes.json'), await readFile(join(out, 'code-probes.json')))
}
console.log(`Verified both policy modes, six negative controls and real-code probes. Evidence: ${out}`)
