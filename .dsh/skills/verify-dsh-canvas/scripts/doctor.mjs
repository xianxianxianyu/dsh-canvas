#!/usr/bin/env node
// Is this machine worth driving dsh-canvas on? One line per check, then a verdict.
//
//   doctor.mjs [--no-live]
//
// Read-only, except the live auth probe: one tiny headless turn ("reply OK") whose session and
// stores land in $CANVAS_VERIFY_OUT/doctor-<time>/ like any other run. --no-live skips it.
// Exit status: 0 when nothing failed, 1 otherwise.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DSH_BIN, OUT, PROFILE, REPO, dshEnv, linkState } from './run-headless.mjs'

const DEV_PROFILE = 'canvas-dev'
const DEV_PORT = 3996
const live = !process.argv.includes('--no-live')
let failed = false

function report(level, check, detail) {
  if (level === 'FAIL') failed = true
  console.log(`${level.padEnd(4)}  ${check.padEnd(8)}  ${detail}`)
}

function newest(dir) {
  let time = 0
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) time = Math.max(time, statSync(join(entry.parentPath, entry.name)).mtimeMs)
  }
  return time
}

function processChain(pid) {
  const chain = []
  for (let current = pid; current > 1 && chain.length < 6;) {
    const line = spawnSync('ps', ['-o', 'ppid=,command=', '-p', String(current)], { encoding: 'utf8' }).stdout.trim()
    if (!line) break
    const [, ppid, command] = /^(\d+)\s+(.*)$/s.exec(line) ?? []
    chain.push({ pid: current, command })
    current = Number(ppid)
  }
  return chain
}

// 1. The DSH CLI the skill uses (never runtime/bin).
const cli = join(DSH_BIN, 'dsh')
if (!existsSync(cli)) report('FAIL', 'dsh', `no CLI at ${cli}`)
else report('OK', 'dsh', `${spawnSync('dsh', ['-V'], { env: dshEnv(), encoding: 'utf8' }).stdout.trim()} at ${DSH_BIN}${process.env.DSH_HOME ? ' (DSH_HOME is set in this shell; the helpers unset it)' : ''}`)

// 2. DSH loads lib/, not src/: a stale build drives old code.
const libs = ['lib/index.js', 'lib/client.js'].map(file => join(REPO, file))
if (!libs.every(existsSync)) report('FAIL', 'build', 'lib/ is missing: run pnpm install && pnpm build')
else {
  const built = Math.min(...libs.map(file => statSync(file).mtimeMs))
  const source = newest(join(REPO, 'src'))
  if (source > built) report('FAIL', 'build', `src/ changed after lib/ was built (${new Date(source).toISOString()}): run pnpm build`)
  else report('OK', 'build', `lib/ is newer than src/ (${new Date(built).toISOString()})`)
}

// 3. Both profiles must load this checkout, not another worktree or clone.
for (const [name, creator] of [[DEV_PROFILE, 'scripts/dev-server.sh'], [PROFILE, 'run-headless.mjs']]) {
  const state = linkState(name)
  if (state.ok) report('OK', 'link', state.detail)
  else if (state.missing) report('WARN', 'link', `${state.detail}; ${creator} creates it on first use`)
  else report('FAIL', 'link', state.detail)
}

// 4. Port 3996 must be free, or held by a canvas-dev server; anything else is not ours to drive.
const listener = spawnSync('lsof', ['-nP', `-iTCP:${DEV_PORT}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean)
if (!listener.length) report('OK', 'port', `${DEV_PORT} is free`)
else {
  for (const pid of listener) {
    const chain = processChain(Number(pid))
    const ours = chain.some(({ command }) => command.includes(`--profile ${DEV_PROFILE}`))
    report(ours ? 'OK' : 'FAIL', 'port', `${DEV_PORT} is held by pid ${pid}${ours ? ` (a ${DEV_PROFILE} server; drive it only if you started it)` : ''}: ${chain[0]?.command.slice(0, 160)}`)
  }
}

// 5. The browser canvas_check will use, found by the plugin's own discovery code.
const { browserCandidates, locateBrowser } = await import(join(REPO, 'src/host/browser.ts'))
const found = locateBrowser(undefined, browserCandidates(process.platform, process.env, homedir()), existsSync)
if (found.kind === 'found') report('OK', 'browser', found.path)
else report('FAIL', 'browser', `${found.reason}; check-image and the dev UI journeys cannot run`)

// 6. Account auth: the headless template disables it, and run-headless.mjs turns it back on.
if (!existsSync(join(homedir(), '.dsh', '.credentials.yaml'))) report('FAIL', 'auth', 'no stored DeepSeek credentials: sign in once in the desktop app')
else if (!live) report('WARN', 'auth', 'credentials stored; live probe skipped (--no-live)')
else if (!linkState(PROFILE).ok && !linkState(PROFILE).missing) report('FAIL', 'auth', `live probe skipped: ${linkState(PROFILE).detail}`)
else {
  const name = `doctor-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')}`
  spawnSync(process.execPath, [join(import.meta.dirname, 'run-headless.mjs'), '--name', name, '--timeout', '180', '只回复 OK 两个字母，不要调用任何工具。'], { encoding: 'utf8' })
  const summaryFile = join(OUT, name, 'summary.json')
  const summary = existsSync(summaryFile) ? JSON.parse(readFileSync(summaryFile, 'utf8')) : undefined
  if (summary?.final?.kind === 'completed') report('OK', 'auth', `headless turn completed on ${summary.model} (${summary.seconds}s, ${join(OUT, name)})`)
  else if (summary?.signInRequired) report('FAIL', 'auth', `ACCOUNT_SIGN_IN_REQUIRED: sign in to DeepSeek in the desktop app (${join(OUT, name)})`)
  else report('FAIL', 'auth', `headless probe did not complete: see ${join(OUT, name)}/stderr.log`)
}

console.log(failed ? 'doctor: not ready' : 'doctor: ready')
process.exit(failed ? 1 : 0)
