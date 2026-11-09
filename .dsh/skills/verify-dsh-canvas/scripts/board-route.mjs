#!/usr/bin/env node
// Call dsh-canvas's board route on a running canvas-dev server, the way the board UI does, but
// without a page (so no blank session is created).
//
//   board-route.mjs <dsh web url> <json body | ->              e.g. {"path":"/abs/plan.canvas","ops":[…]}
//   board-route.mjs --anonymous <dsh web url> <json body | ->  the same call without signing in
//
// <dsh web url> is the server's whole `dsh web: http://127.0.0.1:3996/?…` line: the query
// authorizes the browser. The helper trades it for the signed cookie at GET /, then POSTs the
// body to /api/canvas/board with that cookie. It prints the HTTP status and the response verbatim,
// including every per-op status (applied, unchanged, missing or conflict), without interpreting them.
// Exit status: 0 for a 2xx answer, 1 for any other answer, 2 for usage errors.

import { readFileSync } from 'node:fs'

const USAGE = 'usage: board-route.mjs [--anonymous] <dsh web url> <json | ->'
const args = process.argv.slice(2)
const anonymous = args[0] === '--anonymous'
const [url, argument] = anonymous ? args.slice(1) : args
if (!url || !argument) {
  console.error(USAGE)
  process.exit(2)
}

let cookie = ''
if (!anonymous) {
  const login = await fetch(url, { redirect: 'manual' })
  cookie = login.headers.getSetCookie().map(line => line.split(';', 1)[0]).join('; ')
  if (!cookie) {
    console.error(`board-route: GET / answered ${login.status} without a cookie; is this the server's whole dsh web URL?`)
    process.exit(1)
  }
}
const response = await fetch(`${new URL(url).origin}/api/canvas/board`, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/json' },
  body: argument === '-' ? readFileSync(0, 'utf8') : argument,
})
const text = await response.text()
console.log(`HTTP ${response.status}`)
console.log(text)
process.exit(response.ok ? 0 : 1)
