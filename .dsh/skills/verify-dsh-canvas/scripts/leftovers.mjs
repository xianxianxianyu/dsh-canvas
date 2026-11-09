#!/usr/bin/env node
// What did these runs leave behind, and is their evidence still there?
//
//   leftovers.mjs [--clean] <run-dir>...
//
// Reports, per run directory:
//   - the canvas-dev port (3996) still listening;
//   - processes whose command line names the run directory or its Chrome scratch profile
//     (dev-ui.mjs's chromeProfile(run)): ours by construction, so --clean stops them;
//   - every session the run recorded in `<run>/sessions.json`, and whether canvas-dev's own store
//     (in dev-ui.mjs's DEV_DATA) lists it as archived; headless summary sessions use their own store.
//   - the Chrome scratch profile itself (--clean removes it);
//   - the evidence files, which nothing here ever deletes.
// Exit status: 0 when nothing is left over and every run still has evidence, 1 otherwise.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { archivedIds, chromeProfile, runSessions } from './dev-ui.mjs'

const clean = process.argv.includes('--clean')
const runs = process.argv.slice(2).filter(arg => arg !== '--clean').map(arg => resolve(arg))
if (!runs.length) {
  console.error('usage: leftovers.mjs [--clean] <run-dir>...')
  process.exit(2)
}
let failed = false
function report(level, check, detail) {
  if (level === 'FAIL') failed = true
  console.log(`${level.padEnd(4)}  ${check.padEnd(8)}  ${detail}`)
}

/** Processes whose command line names any of `paths`, never this checker itself. */
function processesNaming(paths) {
  return spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout.split('\n')
    .map(line => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter(match => match && paths.some(path => match[2].includes(path)) && Number(match[1]) !== process.pid)
    .map(([, pid, command]) => ({ pid: Number(pid), command }))
}

const listener = spawnSync('lsof', ['-nP', '-iTCP:3996', '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).stdout.trim()
if (listener) report('FAIL', 'port', `3996 still listens (pid ${listener.split('\n').join(', ')}); stop the dev server you started`)
else report('OK', 'port', '3996 is free')

// UI sessions use canvas-dev's store; headless runs below use only their isolated state directory.
const archived = runs.some(run => runSessions(run).length) ? archivedIds() : new Set()

for (const run of runs) {
  console.log(`-- ${run}`)
  const chrome = chromeProfile(run)
  const names = [`${run}/`, chrome]
  let ours = processesNaming(names)
  if (clean && ours.length) {
    for (const { pid } of ours) process.kill(pid, 'SIGTERM')
    for (let i = 0; i < 10 && processesNaming(names).length; i++) spawnSync('sleep', ['0.5'])
    for (const { pid, command } of ours) report('OK', 'process', `stopped ${pid}: ${command.slice(0, 120)}`)
    ours = processesNaming(names)
  }
  for (const { pid, command } of ours) report('FAIL', 'process', `${pid} still runs: ${command.slice(0, 120)}`)
  if (!ours.length && !clean) report('OK', 'process', 'none name this run')

  for (const id of runSessions(run)) {
    report(archived.has(id) ? 'OK' : 'FAIL', 'session', `${id} ${archived.has(id) ? 'archived' : 'NOT archived: open it again and run ui.archive(tab, run)'}`)
  }

  const summaryPath = join(run, 'summary.json')
  if (existsSync(summaryPath)) {
    const { sessionId } = JSON.parse(readFileSync(summaryPath, 'utf8'))
    if (sessionId) {
      // Headless has no workspace controller/UI to archive through. After its process exits,
      // reconcile the same archive list in its own store, never canvas-dev's or the user's.
      const root = join(run, 'state', 'storages')
      const path = join(root, 'workspace.json')
      const workspace = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8'))
        : { unit: { name: 'workspace', version: 2 }, global: {}, tables: {} }
      const ids = workspace.global.archivedSessionIds ?? []
      if (clean && !ours.length && !ids.includes(sessionId)) {
        workspace.global.archivedSessionIds = [...ids, sessionId]
        mkdirSync(root, { recursive: true })
        writeFileSync(`${path}.tmp`, `${JSON.stringify(workspace, null, 2)}\n`)
        renameSync(`${path}.tmp`, path)
      }
      const done = workspace.global.archivedSessionIds?.includes(sessionId)
      report(done ? 'OK' : 'FAIL', 'session', `${sessionId} ${done ? 'archived in isolated headless store' : 'NOT archived: run leftovers.mjs --clean after it exits'}`)
    }
  }

  // Scratch, not evidence: Chrome's profile for this run.
  if (existsSync(chrome)) {
    if (clean && !ours.length) {
      rmSync(chrome, { recursive: true, force: true })
      report('OK', 'scratch', `removed ${chrome}`)
    } else report('FAIL', 'scratch', `${chrome} remains; leftovers.mjs --clean removes it once its Chrome has exited`)
  }

  const files = existsSync(run) ? readdirSync(run, { withFileTypes: true, recursive: true }).filter(entry => entry.isFile()) : []
  if (!files.length) report('FAIL', 'evidence', 'missing or empty')
  else {
    const top = files.filter(entry => entry.parentPath === run).map(entry => `${entry.name} (${statSync(join(run, entry.name)).size} B)`)
    report('OK', 'evidence', `${files.length} files; top level: ${top.join(', ')}`)
  }
}
process.exit(failed ? 1 : 0)
