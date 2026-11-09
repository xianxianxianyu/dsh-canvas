// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 xianxianxianyu

import { isUtf8 } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'

// Escaped patterns keep this scanner subject to the same checks as every other file.
const rules = [
  ['local home or volume path', /\/(?:Users|Volumes)\//g],
  ['private temporary path', /\/private\/tmp/g],
  ['private project temporary path', /\/tmp\/(?:pstack|canvas)/g],
  ['private session directory', /~\/\.dsh\/sessions\/--/g],
  ['session identifier', /session-[0-9a-f]{8}-[0-9a-f-]{27}/gi],
  ['API key', /\bs[k]-[a-z0-9_-]+/gi],
  ['token assignment', /\btoken\s*=/gi],
  ['authorization header', /\bauthorization\s*:/gi],
  ['private key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g],
  ['email address', /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi],
]

const localDenylist = 'check-public.local.txt'

// The maintainer's public GitHub attribution address is intentionally publishable.
const publicEmail = 'xianxianxianyu@users.noreply.github.com'
const licenseEmails = new Map([
  // Required verbatim attribution in bundled yaml ISC and parse5 MIT licenses only.
  ['THIRD_PARTY_NOTICES.md', new Set(['eemeli\x40gmail.com', 'ifaaan\x40gmail.com'])],
])

function inspect(text, path) {
  const findings = []
  for (const [rule, pattern] of rules) {
    for (const match of text.matchAll(pattern)) {
      if (rule === 'email address' && (match[0] === publicEmail || licenseEmails.get(path)?.has(match[0]))) continue
      findings.push({ rule, offset: match.index })
    }
  }
  return findings.sort((left, right) => left.offset - right.offset)
}

try {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd()
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const paths = [...new Set(listed.split('\0').filter(Boolean))].sort()
  const cached = new Set(execFileSync('git', ['ls-files', '--cached', '-z'], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }).split('\0').filter(Boolean))
  // Ignoring this optional file is a publication boundary, not a scanner exemption.
  // --cached includes force-added files even when the working copy is ignored or gone.
  if (paths.includes(localDenylist)) {
    throw Object.assign(new Error(), { code: 'LOCAL_DENYLIST_PUBLISHABLE' })
  }
  let localTerms = ''
  try {
    localTerms = readFileSync(join(root, localDenylist), 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  // One case-insensitive literal substring per line, not regex syntax or comments.
  // Ignore blank lines and surrounding whitespace; never print a term or its match.
  for (const line of localTerms.split(/\r?\n/u)) {
    const term = line.trim()
    if (term) rules.push(['local denylist term', new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')])
  }

  let files = 0
  let binaryFiles = 0
  let findingCount = 0
  let failedFiles = 0

  for (const path of paths) {
    let bytes
    try {
      const absolute = join(root, path)
      const stat = lstatSync(absolute)
      // Inspect link targets, never follow links into private files outside the tree.
      if (stat.isSymbolicLink()) bytes = Buffer.from(readlinkSync(absolute))
      else if (stat.isFile()) bytes = readFileSync(absolute)
      else continue
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }

    const versions = bytes ? [{ bytes, label: '' }] : []
    // A safe working copy must not conceal a secret still staged for the next commit.
    if (cached.has(path)) {
      const staged = execFileSync('git', ['show', `:./${path}`], {
        cwd: root, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      })
      if (!bytes?.equals(staged)) versions.push({ bytes: staged, label: ' (index)' })
    }
    if (!versions.length) continue
    files++
    if (versions.some(({ bytes }) => bytes.includes(0) || !isUtf8(bytes))) binaryFiles++
    const pathFindings = inspect(path, '')
    let fileFindings = pathFindings.length
    // JSON quoting makes unusual filenames unambiguous; a sensitive name is never printed.
    const displayPath = pathFindings.length ? `"[redacted path ${files}]"` : JSON.stringify(path)
    for (const { rule } of pathFindings) console.error(`${displayPath}:1: ${rule} (filename)`)
    for (const { bytes, label } of versions) {
      const binary = bytes.includes(0) || !isUtf8(bytes)
      // Binary metadata can contain private paths or credentials too.
      const text = bytes.toString(binary ? 'latin1' : 'utf8')
      const findings = inspect(text, path)
      fileFindings += findings.length
      let line = 1
      let cursor = 0
      for (const { rule, offset } of findings) {
        while (cursor < offset) if (text.charCodeAt(cursor++) === 10) line++
        const location = binary ? `byte ${offset + 1}` : line
        console.error(`${displayPath}:${location}: ${rule}${label}`)
      }
    }
    findingCount += fileFindings
    if (fileFindings) failedFiles++
  }

  if (findingCount) {
    console.error(`Public privacy check failed: ${findingCount} findings in ${failedFiles} of ${files} files.`)
    process.exitCode = 1
  } else {
    console.log(`Public privacy check passed: ${files} files (${binaryFiles} binary).`)
  }
} catch (error) {
  // Error messages can contain absolute paths or file contents; expose only the failure code.
  const code = typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'scan error'
  console.error(`Public privacy check could not scan repository (${code}).`)
  process.exitCode = 1
}
