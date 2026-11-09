#!/usr/bin/env node
// Export real tool records and canvas PNGs from sessions this UI run created. Read-only to DSH;
// output is confined to the existing evidence run. Usage: capture-ui.mjs <run-dir>
import { copyFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { DEV_DATA, runSessions } from './dev-ui.mjs'

const run = process.argv[2] && resolve(process.argv[2])
if (!run || process.argv.length !== 3) throw new Error('usage: capture-ui.mjs <run-dir>')
const sessions = runSessions(run)
if (!sessions.length) throw new Error('No tracked UI sessions in this run')
const logs = readdirSync(join(DEV_DATA, 'sessions'), { withFileTypes: true, recursive: true })
const records = []
const checks = []
const comments = []
for (const sessionId of sessions) {
  const log = logs.find(entry => entry.isFile() && entry.name === 'session.v4.jsonl.zstd' && entry.parentPath.endsWith(`/${sessionId}`))
  if (!log) throw new Error(`Missing persisted log for ${sessionId}`)
  const events = zstdDecompressSync(readFileSync(join(log.parentPath, log.name))).toString('utf8').split('\n').filter(Boolean).map(JSON.parse)
  const calls = new Map(events.filter(event => event.type === 'tool/call').map(event => [event.data.callId, event.data]))
  records.push({ sessionId, events: events.filter(event => event.type === 'tool/call' || event.type === 'tool/result') })
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const result = event.data.message
    const call = calls.get(result.toolCallId)
    if (call?.name !== 'canvas_check' && call?.name !== 'canvas_comment') continue
    const entry = {
      sessionId, callId: call.callId, input: JSON.parse(call.arguments), isError: result.isError,
      text: result.content.filter(block => block.type === 'text').map(block => block.text).join('\n'), images: [],
    }
    if (call.name === 'canvas_comment') { comments.push(entry); continue }
    const n = checks.length + 1
    for (const block of result.content) {
      if (block.type !== 'image') continue
      const hex = /^sha256:([a-f0-9]{64})$/u.exec(block.attachment.attachmentId)?.[1]
      if (!hex || block.attachment.mediaType !== 'image/png') throw new Error('Unexpected canvas image attachment')
      const file = `check-${n}${entry.images.length ? `-${entry.images.length + 1}` : ''}.png`
      copyFileSync(join(DEV_DATA, 'home', 'attachments', 'v1', 'objects', hex.slice(0, 2), hex), join(run, file))
      entry.images.push({ file, width: block.attachment.width, height: block.attachment.height, sha256: hex })
    }
    checks.push(entry)
  }
}
writeFileSync(join(run, 'tool-events.json'), `${JSON.stringify(records, null, 2)}\n`)
writeFileSync(join(run, 'tool-summary.json'), `${JSON.stringify({ sessions, checks, comments }, null, 2)}\n`)
for (const [tool, entries] of [['canvas-check', checks], ['canvas-comment', comments]]) {
  writeFileSync(join(run, `${tool}.txt`), entries.map((entry, index) => `--- ${tool} #${index + 1} ${entry.isError ? 'error' : 'completed'} ${JSON.stringify(entry.input)}\n${entry.text}\n${entry.images.map(image => `[image ${image.width}×${image.height} → ${image.file}]`).join('\n')}`).join('\n\n'))
}
console.log(`${sessions.length} tracked sessions; ${checks.length} checks; ${comments.length} comments; ${checks.flatMap(entry => entry.images).length} PNGs captured in ${run}`)
