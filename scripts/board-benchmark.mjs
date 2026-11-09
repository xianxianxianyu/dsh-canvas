import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile, writeFile, stat, rename, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { performance } from 'node:perf_hooks'
import { largeBoard, dragOps } from '../test/fixtures/large-board.mjs'

// The client lives on its own event loop: unrelated-request latency measures the host, not
// a client whose timers happen to share the blocked thread. No DSH server/profile is involved.
if (!isMainThread) {
  let unrelated, started
  const request = async (path, init) => {
    const start = performance.now()
    const response = await fetch(workerData.url + path, { ...init, headers: { ...init?.headers, connection: 'close' } })
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    return { ms: performance.now() - start, body }
  }
  parentPort.on('message', async message => {
    if (message.kind === 'busy') {
      unrelated = request('/api/canvas/comments?' + new URLSearchParams({ path: workerData.path }))
      started?.()
      return
    }
    try {
      const waiting = message.concurrent ? new Promise(resolve => { started = resolve }) : undefined
      const main = await request('/api/canvas/board' + (message.ops ? '' : '?' + new URLSearchParams({ path: workerData.path })), message.ops ? {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: workerData.path, ops: message.ops }),
      } : undefined)
      await waiting
      const other = message.concurrent ? await unrelated : undefined
      if (other) assert.deepEqual(other.body.comments, [])
      parentPort.postMessage({ kind: 'result', main, unrelatedMs: other?.ms })
    } catch (error) { parentPort.postMessage({ kind: 'error', error: `${error.stack}\nCause: ${JSON.stringify(error.cause, Object.getOwnPropertyNames(error.cause ?? {}))}` }) }
  })
} else {
  const root = resolve(process.argv[2] ?? fileURLToPath(new URL('../', import.meta.url)))
  const count = Number(process.argv[3] ?? 4000)
  const { source, nodes, edges } = largeBoard(count)
  const { parseBoard } = await import(pathToFileURL(join(root, 'src/shared/board.ts')))
  if (process.argv.includes('--profile')) {
    for (let i = 0; i < 30; i++) assert.equal(parseBoard(source).board.nodes.length, count)
    console.log(JSON.stringify({ profileOnly: true, parses: 30, nodes: count, bytes: Buffer.byteLength(source), errors: 0 }))
  } else {
    const { boardRoute, commentsRoute } = await import(pathToFileURL(join(root, 'src/host/route.ts')))
    const { BoardJournal } = await import(pathToFileURL(join(root, 'src/host/board-journal.ts')))
    const { CommentStore } = await import(pathToFileURL(join(root, 'src/host/comments.ts')))
    const dir = await mkdtemp(join(tmpdir(), 'canvas-board-bench-')), path = join(dir, 'board.canvas')
    await writeFile(path, source)
    let writes = 0, reads = 0, signalBusy = false, client
    const fs = {
      resolve: async path => ({ displayPath: path }), processPath: target => target.displayPath,
      stat: async target => { const s = await stat(target.displayPath, { bigint: true }); return { type: 'file', size: Number(s.size), version: `${s.ino}:${s.size}:${s.mtimeNs}` } },
      readText: async target => { const text = await readFile(target.displayPath, 'utf8'); reads++; if (signalBusy) { signalBusy = false; client.postMessage({ kind: 'busy' }) } return text },
      writeText: async (target, text, intent) => {
        const current = await fs.stat(target)
        if (intent?.kind === 'replaceIfVersion' && current.version !== intent.version) throw Object.assign(Error('stale'), { code: 'FS_STALE_VERSION' })
        await writeFile(target.displayPath + '.tmp', text)
        await rename(target.displayPath + '.tmp', target.displayPath)
        writes++
        return { version: (await fs.stat(target)).version }
      },
    }
    const journal = new BoardJournal()
    const deps = { fs, journal, store: new CommentStore(join(dir, 'comments')), sessionCwd: async () => dir }
    const board = boardRoute(deps), comments = commentsRoute(deps)
    const server = createServer(async (req, res) => {
      try {
        const parts = []
        for await (const part of req) parts.push(part)
        const body = Buffer.concat(parts)
        const request = new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) })
        const route = req.url.startsWith('/api/canvas/comments') ? comments : board
        const response = await route.fetch(request)
        res.writeHead(response.status, Object.fromEntries(response.headers))
        res.end(Buffer.from(await response.arrayBuffer()))
      } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.stack })) }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    client = new Worker(new URL(import.meta.url), { workerData: { url: `http://127.0.0.1:${server.address().port}`, path } })
    const call = async (ops, concurrent = false) => {
      signalBusy = concurrent
      const beforeCPU = process.cpuUsage()
      client.postMessage({ kind: 'request', ops, concurrent })
      const [result] = await once(client, 'message')
      assert.equal(result.kind, 'result', result.error)
      return { ...result, cpuMs: Object.values(process.cpuUsage(beforeCPU)).reduce((a, b) => a + b, 0) / 1000 }
    }
    try {
      // Warm parsing, but not the journal cache; each process publishes real changed positions.
      for (let i = 0; i < 3; i++) assert.equal(parseBoard(source).board.nodes.length, count)
      const ops = dragOps(nodes)
      const drag = await call(ops, true)
      assert.deepEqual(drag.main.body.statuses, Array(200).fill('applied'))
      const saved = JSON.parse(await readFile(path, 'utf8'))
      assert.equal(saved.nodes.length, count)
      assert.equal(saved.edges.length, edges.length)
      for (let i = 0; i < 200; i++) assert.deepEqual([saved.nodes[i].x, saved.nodes[i].y], [ops[i].x, ops[i].y])
      assert.deepEqual(saved.nodes.slice(200), nodes.slice(200))
      if (count === 600) for (let start = 0; start < 600; start += 100) {
        const setup = await call(dragOps(nodes, start, 100, 31))
        assert.deepEqual(setup.main.body.statuses, Array(100).fill('applied'))
      }
      await writeFile(path, source) // the adversary's blind overwrite, outside the route
      const firstLost = await call(undefined, true)
      const cachedLost = await call(undefined, true)
      assert.deepEqual(cachedLost.main.body, firstLost.main.body)
      const lostOps = firstLost.main.body.lost.reduce((sum, batch) => sum + batch.count, 0)
      assert.equal(lostOps, count === 600 ? 600 : 200)
      console.log(JSON.stringify({ root, nodes: count, edges: edges.length, bytes: Buffer.byteLength(source), errors: 0,
        completed: { dragOps: 200, lostOps, writes, reads },
        dragMs: drag.main.ms, dragCPUms: drag.cpuMs, unrelatedDuringDragMs: drag.unrelatedMs,
        firstLostMs: firstLost.main.ms, firstLostCPUms: firstLost.cpuMs, unrelatedDuringFirstLostMs: firstLost.unrelatedMs,
        cachedLostMs: cachedLost.main.ms, cachedLostCPUms: cachedLost.cpuMs, unrelatedDuringCachedLostMs: cachedLost.unrelatedMs }))
    } finally {
      await client.terminate()
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
      await rm(dir, { recursive: true, force: true })
    }
  }
}
