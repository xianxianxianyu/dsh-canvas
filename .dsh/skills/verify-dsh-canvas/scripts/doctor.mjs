#!/usr/bin/env node
// Is this machine worth driving dsh-canvas on? One line per check, then a verdict.
//
//   doctor.mjs [--no-live] [--patch <path>]...
//
// Read-only, except the live auth probe: one tiny headless turn ("reply OK") whose session and
// stores land in $CANVAS_VERIFY_OUT/doctor-<time>/ like any other run. --no-live skips it.
// Extra patches are temporary overlays for both profile dumps and the live probe, in argument order.
// fs-observation-policy off is informational (WARN), not a readiness failure; defaults are unchanged.
// Exit status: 0 when nothing failed, 1 otherwise.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import { DEV_DATA, DEV_PORT } from './dev-ui.mjs'
import { DSH_BIN, OUT, PROFILE, REPO, dshEnv, linkState } from './run-headless.mjs'

const DEV_PROFILE = 'canvas-dev'
const live = !process.argv.includes('--no-live')
const extraPatches = []
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] !== '--patch') continue
  const path = process.argv[++i]
  if (!path || path.startsWith('--')) {
    console.error('doctor: --patch needs a path')
    process.exit(2)
  }
  extraPatches.push(resolve(path))
}
const patchArgs = extraPatches.flatMap(path => ['--patch', path])
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
  if (state.missing || !existsSync(cli)) {
    report('WARN', 'policy', `${name}: fs-observation-policy unknown (${state.missing ? 'profile does not exist' : 'CLI missing'})`)
    continue
  }
  const config = spawnSync('dsh', ['--profile', name, '--dump-config', ...patchArgs], { env: dshEnv(), encoding: 'utf8' })
  if (config.status !== 0) {
    report('FAIL', 'policy', `${name}: cannot dump composed config: ${config.error?.message ?? (config.stderr?.trim() || `exit ${config.status}`)}`)
    continue
  }
  try {
    // Cordis !!js scalars remain source strings; the doctor never evaluates configuration code.
    const entries = parse(config.stdout, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] })
    if (!Array.isArray(entries)) throw new Error('--dump-config did not return a plugin entry list')
    const policy = entries.find(entry => entry?.id === 'fs-observation-policy')
    if (!policy || policy.disabled === true) {
      report('WARN', 'policy', `${name}: fs-observation-policy off (${policy ? 'disabled' : 'not present'} in composed config; allowed, defaults unchanged)`)
    } else if (policy.disabled === undefined || policy.disabled === false) {
      report('OK', 'policy', `${name}: fs-observation-policy on in composed config`)
    } else {
      report('WARN', 'policy', `${name}: fs-observation-policy unknown (disabled is not a literal boolean)`)
    }
  } catch (error) {
    report('FAIL', 'policy', `${name}: cannot read composed config: ${error.message}`)
  }
}

// 4. The selected PORT must be free, or held by canvas-dev; another project is never ours to drive.
// 4b. canvas-dev keeps its session store, storages, attachments and canvas root in DEV_DATA, through
// the dev.patch.yml that scripts/dev-server.sh writes there. Every DSH process loads
// storages/workspace.json once and rewrites it whole, so a canvas-dev server booted without that
// patch (an older dev-server.sh) shares ~/.dsh with the desktop app and loses one side's updates.
const devPatch = `--patch ${join(DEV_DATA, 'dev.patch.yml')}`
const listener = spawnSync('lsof', ['-nP', `-iTCP:${DEV_PORT}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean)
if (!listener.length) {
  report('OK', 'port', `${DEV_PORT} is free`)
  report('OK', 'data', `scripts/dev-server.sh keeps canvas-dev's sessions, storages, attachments and canvas root in ${DEV_DATA} (CANVAS_DEV_DATA), not ~/.dsh`)
} else {
  for (const pid of listener) {
    const chain = processChain(Number(pid))
    const ours = chain.some(({ command }) => command.includes(`--profile ${DEV_PROFILE}`))
    report(ours ? 'OK' : 'FAIL', 'port', `${DEV_PORT} is held by pid ${pid}${ours ? ` (a ${DEV_PROFILE} server; drive it only if you started it)` : ''}: ${chain[0]?.command.slice(0, 160)}`)
    if (!ours) continue
    if (chain.some(({ command }) => command.includes(devPatch))) report('OK', 'data', `pid ${pid} keeps its stores in ${DEV_DATA}`)
    else report('FAIL', 'data', `pid ${pid} runs without ${devPatch}, so it shares ~/.dsh/sessions and ~/.dsh/storages with the desktop app; whoever started it should stop it and restart with scripts/dev-server.sh`)
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
  spawnSync(process.execPath, [join(import.meta.dirname, 'run-headless.mjs'), '--name', name, '--timeout', '180', ...patchArgs, '只回复 OK 两个字母，不要调用任何工具。'], { encoding: 'utf8' })
  const summaryFile = join(OUT, name, 'summary.json')
  const summary = existsSync(summaryFile) ? JSON.parse(readFileSync(summaryFile, 'utf8')) : undefined
  if (summary?.final?.kind === 'completed') report('OK', 'auth', `headless turn completed on ${summary.model} (${summary.seconds}s, ${join(OUT, name)})`)
  else if (summary?.signInRequired) report('FAIL', 'auth', `ACCOUNT_SIGN_IN_REQUIRED: sign in to DeepSeek in the desktop app (${join(OUT, name)})`)
  else report('FAIL', 'auth', `headless probe did not complete: see ${join(OUT, name)}/stderr.log`)
}

console.log(failed ? 'doctor: not ready' : 'doctor: ready')
process.exit(failed ? 1 : 0)
