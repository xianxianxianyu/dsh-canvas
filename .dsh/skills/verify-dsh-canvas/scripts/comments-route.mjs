#!/usr/bin/env node
// Call dsh-canvas's comment route on a running canvas-dev server, the way the sidebar does, but
// without a page (so no blank session is created).
//
//   comments-route.mjs <dsh web url> get <absolute .mmd path>
//   comments-route.mjs <dsh web url> post <json body | ->      e.g. {"path":"/abs/x.mmd","ops":[…]}
//   comments-route.mjs --anonymous <dsh web url> get <path>    the same call without signing in
//
// <dsh web url> is the server's whole `dsh web: http://127.0.0.1:3996/?…` line: the query
// authorizes the browser. The helper trades it for the signed cookie at GET /, then calls
// /api/canvas/comments with that cookie. It prints the HTTP status and the JSON body.
// Exit status: 0 for a 2xx answer, 1 for any other answer, 2 for usage errors.

import { readFileSync } from 'node:fs'

const USAGE = 'usage: comments-route.mjs [--anonymous] <dsh web url> get <path> | post <json | ->'
const args = process.argv.slice(2)
const anonymous = args[0] === '--anonymous'
const [url, method, argument] = anonymous ? args.slice(1) : args
if (!url || !['get', 'post'].includes(method) || !argument) {
  console.error(USAGE)
  process.exit(2)
}

const origin = new URL(url).origin
let cookie = ''
if (!anonymous) {
  const login = await fetch(url, { redirect: 'manual' })
  cookie = login.headers.getSetCookie().map(line => line.split(';', 1)[0]).join('; ')
  if (!cookie) {
    console.error(`comments-route: GET / answered ${login.status} without a cookie; is this the server's whole dsh web URL?`)
    process.exit(1)
  }
}
const endpoint = `${origin}/api/canvas/comments`
const response = method === 'get'
  ? await fetch(`${endpoint}?${new URLSearchParams({ path: argument })}`, { headers: { cookie } })
  : await fetch(endpoint, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: argument === '-' ? readFileSync(0, 'utf8') : argument,
  })
const text = await response.text()
let body = text
try {
  body = JSON.stringify(JSON.parse(text), null, 2)
} catch {
  // Not JSON (DSH's own 401 or 404 page): print it as it came.
}
console.log(`HTTP ${response.status}`)
console.log(body)
process.exit(response.ok ? 0 : 1)
