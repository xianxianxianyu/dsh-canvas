#!/usr/bin/env node
// Call dsh-canvas's board route on a running canvas-dev server, the way the board UI does, but
// without a page (so no blank session is created).
//
//   board-route.mjs <dsh web url> get <absolute .canvas path>
//   board-route.mjs <dsh web url> post <json body | ->        e.g. {"path":"/abs/plan.canvas","ops":[…]}
//   board-route.mjs --anonymous <dsh web url> get <path>      the same call without signing in
//
// <dsh web url> is the server's whole `dsh web: http://127.0.0.1:3996/?…` line: the query
// authorizes the browser. The helper trades it for the signed cookie at GET /, then calls
// /api/canvas/board with that cookie. It prints the HTTP status and the response verbatim,
// including every per-op status (applied, unchanged, missing or conflict), without interpreting them.
// Exit status: 0 for a 2xx answer, 1 for any other answer, 2 for usage errors.

import { readFileSync } from 'node:fs'

const USAGE = 'usage: board-route.mjs [--anonymous] <dsh web url> get <path> | post <json | ->'
const args = process.argv.slice(2)
const anonymous = args[0] === '--anonymous'
const [url, method, argument] = anonymous ? args.slice(1) : args
if (!url || !['get', 'post'].includes(method) || !argument) {
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
const endpoint = `${new URL(url).origin}/api/canvas/board`
const response = method === 'get'
  ? await fetch(`${endpoint}?${new URLSearchParams({ path: argument })}`, { headers: { cookie } })
  : await fetch(endpoint, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: argument === '-' ? readFileSync(0, 'utf8') : argument,
  })
const text = await response.text()
console.log(`HTTP ${response.status}`)
console.log(text)
process.exit(response.ok ? 0 : 1)
