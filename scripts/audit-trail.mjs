#!/usr/bin/env node
// Reconcile .audit/landing.tsv against reality: every row has 6 cells, and every commit and /tmp
// path in a row's evidence column exists (commits in this repo or the town repo).
// A path written as a prefix (`unit5-*`, `chrome-<run>`) passes when any entry starts with it.
// Hex ids labelled as sessions or sha256 digests are not commits. Git worktrees (any path ending
// in a `-wt-<slice>` directory, or listed in --worktrees a,b) are removed by design after merging
// and are reported, not failed.
// Usage: node scripts/audit-trail.mjs [trail] [--town <repo>] [--worktrees <a,b>]   Exit 1 when anything is missing.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const townAt = args.indexOf('--town')
const town = townAt >= 0 ? args[townAt + 1] : undefined
const trail = args.find((a, i) => !a.startsWith('--') && !['--town', '--worktrees'].includes(args[i - 1])) ?? '.audit/landing.tsv'
const worktreesAt = args.indexOf('--worktrees')
const worktrees = worktreesAt >= 0 ? args[worktreesAt + 1].split(',') : []

const commitExists = (repo, sha) => {
  try {
    execFileSync('git', ['-C', repo, 'cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const prefixExists = (path) => {
  try {
    return readdirSync(dirname(path)).some((name) => name.startsWith(basename(path)))
  } catch {
    return false
  }
}

const rows = readFileSync(trail, 'utf8').split('\n').filter(Boolean)
const problems = []
const removed = []
let commits = 0
let paths = 0
rows.slice(1).forEach((row, i) => {
  const line = i + 2
  const cells = row.split('\t')
  if (cells.length !== 6) problems.push(`${line}: ${cells.length} cells, want 6`)
  const evidence = cells[4] ?? ''
  // Commit ids: 7-40 hex chars with a digit and a letter, not labelled as a session or digest.
  for (const match of evidence.matchAll(/(?<![\w/.-])[0-9a-f]{7,40}(?![\w/-])/g)) {
    const sha = match[0]
    if (!/[a-f]/.test(sha) || !/[0-9]/.test(sha)) continue
    if (/(session|sha256)[^;]{0,40}$/i.test(evidence.slice(0, match.index))) continue
    commits++
    if (!commitExists('.', sha) && !(town && commitExists(town, sha))) problems.push(`${line}: commit ${sha} not found`)
  }
  for (const match of evidence.matchAll(/\/tmp\/[\w./-]+/g)) {
    const path = match[0].replace(/[.,;:)]+$/, '')
    const next = evidence[match.index + match[0].length]
    paths++
    if (/-wt-[\w-]+$/.test(path) || worktrees.some((w) => path.startsWith(w))) {
      if (!existsSync(path)) removed.push(`${line}: worktree ${path} removed`)
      continue
    }
    const prefix = path.endsWith('-') || next === '*' || next === '<' || next === '…'
    if (!(prefix ? prefixExists(path) : existsSync(path))) problems.push(`${line}: evidence ${path}${prefix ? '*' : ''} missing`)
  }
})
console.log(`${rows.length - 1} rows, ${commits} commit refs, ${paths} /tmp evidence refs, ${problems.length} problems, ${removed.length} removed worktrees`)
for (const p of problems) console.log(`  ${p}`)
for (const r of removed) console.log(`  (info) ${r}`)
process.exit(problems.length ? 1 : 0)
