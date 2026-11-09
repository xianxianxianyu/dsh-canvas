// Drive the canvas-dev web UI through an omp browser tab. Import it inside an omp JS eval:
//
//   const ui = await import('<repo>/.dsh/skills/verify-dsh-canvas/scripts/dev-ui.mjs')
//   const tab = await ui.open(browser, { url, run })   // url: the server's `dsh web:` line
//
// Every helper takes the tab and uses role/name handles or the plugin's own DOM attributes.
// `run` is the evidence directory of this journey. Every session the run creates is recorded in
// `<run>/sessions.json`; leftovers.mjs holds the run to archiving each one. Chrome's scratch
// profile is chromeProfile(run), under /tmp but outside the evidence root.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

export const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/**
 * canvas-dev's own data directory, which scripts/dev-server.sh points its session store, storages,
 * attachments and canvas root at (same default, same variable). Nothing there is shared with the
 * desktop app or another profile.
 */
export const DEV_DATA = resolve(process.env.CANVAS_DEV_DATA || join(homedir(), '.cache', 'dsh-canvas-dev'))
/** Same override and default as scripts/dev-server.sh; share it with doctor and cleanup. */
export const DEV_PORT = process.env.PORT || '3996'

export const SEL = {
  /** 预览版说明: shown once per profile until 继续 is pressed. */
  notice: 'role/button[name="继续"]',
  /** The composer of a new (blank) session, and of a session that already has turns. */
  newPrompt: 'role/textbox[name="描述你想要构建的内容, / 调用指令, @ 文件或对话"]',
  replyPrompt: 'role/textbox[name="发消息或创建任务, / 调用指令, @ 文件或对话"]',
  /** The session on screen: its row in the left tree, keyed `session:<id>`. */
  currentRow: '[role="treeitem"][aria-selected="true"][data-row-key^="session:"]',
  /** The sidebar's renderer menu (图 / 界面稿 / 纯文本); the chat header has other 打开方式 buttons. */
  rendererMenu: '[data-slot="sidebar.right.pane.tab"] button[aria-label="打开方式"]',
  /** dsh-canvas's preview: a sandboxed srcdoc iframe inside this element. */
  preview: '[data-canvas-preview]',
  previewFrame: '[data-canvas-preview] iframe',
  /** dsh-canvas's error view, which replaces the preview while the file does not parse (comment alerts inside the preview are not it). */
  previewError: '[data-slot="sidebar.right.pane.tab"] [role="alert"]:not([data-canvas-preview] *)',
  /** Comment mode toggle (button 批注), and the side list toggle (button 批注列表, its text ☰ and the pending count). */
  commentMode: '[data-canvas-preview] button[aria-label="批注"]',
  commentList: '[data-canvas-preview] button[aria-label="批注列表"]',
  /** The side list; each thread in it is [data-canvas-thread="<id>"] with data-status. */
  comments: '[data-canvas-comments]',
  /** The form that opens on a clicked node in comment mode. */
  draft: '[data-canvas-draft]',
  board: '[data-canvas-board]',
}

/** A node's click box over the preview (comment mode), a node's pin, a thread, a status filter. */
export const node = id => `[data-canvas-node="${id}"]`
export const pin = id => `[data-canvas-pin="${id}"]`
export const thread = id => `[data-canvas-thread="${id}"]`
export const filter = status => `[data-canvas-filter="${status}"]`

const NEW_PROMPT = /name="(.*)"/.exec(SEL.newPrompt)[1]
const REPLY_PROMPT = /name="(.*)"/.exec(SEL.replyPrompt)[1]
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function poll(what, check, timeoutMs, everyMs = 1000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`dev-ui: timed out after ${timeoutMs} ms waiting for ${what}`)
    await sleep(everyMs)
  }
}

/** Elements of the accessibility snapshot, with `selected` decoded from the states list. */
async function elements(tab) {
  const { elements } = await tab.observe({ compact: true })
  return elements.map(element => ({ ...element, selected: (element.states ?? []).includes('selected=true') }))
}

/** The scratch Chrome profile of a run: unique per run directory, removed by leftovers.mjs --clean. */
export function chromeProfile(run) {
  return `/tmp/dsh-canvas-chrome-${basename(run)}-${createHash('sha256').update(resolve(run)).digest('hex').slice(0, 8)}`
}

/** Session ids this run created, from `<run>/sessions.json`. */
export function runSessions(run) {
  const file = join(run, 'sessions.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
}

function recordSession(run, id) {
  writeFileSync(join(run, 'sessions.json'), `${JSON.stringify([...new Set([...runSessions(run), id])])}\n`)
}

/** The id and title of the session on screen, read from its row's `data-row-key`. */
export async function currentSession(tab) {
  const row = await tab.evaluate(sel => {
    const element = document.querySelector(sel)
    return element && { id: element.dataset.rowKey.replace(/^session:/, ''), title: element.querySelector('[class*="title"]')?.textContent ?? element.textContent }
  }, SEL.currentRow)
  if (!row) throw new Error('dev-ui: no session row is selected')
  return row
}

/**
 * Open the UI in an isolated headless Chrome and get past 预览版说明. A page load reopens the
 * session that was selected last when that one is a conversation; otherwise it persists a new
 * blank session (新会话) in the selected workspace, which becomes the conversation once you send
 * into it. open() records a blank session's id in `<run>/sessions.json`. Use open() for every page
 * load, never tab.goto or a reload, so each new blank session is recorded.
 */
export async function open(browser, { name = 'canvas-dev', url, run }) {
  mkdirSync(run, { recursive: true })
  const tab = await browser.open({
    name, url, timeout: 60,
    app: { path: CHROME, args: ['--headless=new', `--user-data-dir=${chromeProfile(run)}`, '--hide-scrollbars'], tern: false, relay: false },
  })
  await tab.emulate({ viewport: { width: 1600, height: 1000 } })
  const composer = e => e.role === 'textbox' && (e.name === NEW_PROMPT || e.name === REPLY_PROMPT)
  await poll('a composer or 预览版说明', async () => (await elements(tab)).some(e => e.role === 'button' && e.name === '继续' || composer(e)), 30_000)
  if ((await elements(tab)).some(e => e.role === 'button' && e.name === '继续')) {
    await tab.click(SEL.notice)
    await poll('a composer', async () => (await elements(tab)).some(composer), 10_000)
  }
  const current = await poll('the selected session row', () => currentSession(tab).catch(() => undefined), 10_000, 250)
  if (current.title === '新会话') recordSession(run, current.id)
  return tab
}

/** Count of finished turns in the open session (each shows a 已完成，用时 … button). */
async function finishedTurns(tab) {
  return (await elements(tab)).filter(e => e.role === 'button' && /^已完成，用时/.test(e.name ?? '')).length
}

/** Send a prompt in whichever composer is showing and wait until that turn finishes. */
export async function send(tab, text, { timeoutMs = 240_000 } = {}) {
  const textboxes = (await elements(tab)).filter(e => e.role === 'textbox').map(e => e.name)
  const box = textboxes.includes(NEW_PROMPT) ? SEL.newPrompt : SEL.replyPrompt
  const before = await finishedTurns(tab)
  await tab.click(box)
  await tab.type(box, text)
  await tab.press('Enter')
  await poll('the turn to finish (已完成，用时 …)', async () => (await finishedTurns(tab)) > before, timeoutMs, 2000)
}

/** Click the present card's 在侧边栏预览 button for `path` and wait for the preview or its error. */
export async function previewFile(tab, path) {
  const real = realpathSync(path)
  const button = (await elements(tab)).find(e => e.role === 'button' && e.name === `在侧边栏预览 ${real}`)
  if (!button) throw new Error(`dev-ui: no 在侧边栏预览 button for ${real}; the agent did not present it`)
  await tab.id(button.id).click()
  await poll('the sidebar preview', () => tab.evaluate(sel => Boolean(document.querySelector(sel.previewFrame) || document.querySelector(sel.previewError) || document.querySelector(sel.board)), SEL), 15_000)
}

/** What the sidebar shows now: the diagram page, the error text, or neither (another renderer). */
export async function sidebar(tab) {
  return tab.evaluate(sel => ({
    srcdoc: document.querySelector(sel.previewFrame)?.srcdoc ?? null,
    error: document.querySelector(sel.previewError)?.textContent ?? null,
    text: document.querySelector('[data-slot="sidebar.right.pane.tab"]')?.innerText ?? null,
  }), SEL)
}

/** Wait until `test(await sidebar(tab))` holds, e.g. after the file changed on disk. */
export async function waitForSidebar(tab, what, test, timeoutMs = 20_000) {
  return poll(what, async () => { const state = await sidebar(tab); return test(state) ? state : undefined }, timeoutMs)
}

/** Open the renderer menu and list its items; the selected one carries a check icon. Leaves it open. */
export async function rendererMenu(tab) {
  await tab.click(SEL.rendererMenu)
  return poll('the renderer menu', () => tab.evaluate(() => {
    const items = [...document.querySelectorAll('[role="menuitem"]')]
    return items.length ? items.map(item => ({ name: item.textContent.trim(), selected: Boolean(item.querySelector('svg[data-icon*="check"]')) })) : undefined
  }), 5000, 200)
}

/** Pick a renderer (图 or 纯文本) from the sidebar's menu. */
export async function chooseRenderer(tab, name) {
  await rendererMenu(tab)
  await tab.click(`role/menuitem[name="${name}" exact]`)
  await sleep(800)
}

/**
 * The preview's comment UI as the person sees it, or null without a preview: comment mode and its
 * hint, the pending count on ☰, the pins, the open draft, and the side list when it is open (its
 * filters and every visible thread with status, anchor label, text, author line, drift note,
 * replies and buttons). `braces` is true when any of that text still holds a `{name}` placeholder.
 */
export async function comments(tab) {
  return tab.evaluate(sel => {
    const pane = document.querySelector(sel.preview)
    if (!pane) return null
    const text = element => element ? element.textContent.trim() : null
    const draft = pane.querySelector(sel.draft)
    const list = document.querySelector(sel.comments)
    return {
      commenting: pane.hasAttribute('data-canvas-commenting'),
      hint: text(pane.querySelector('[role="status"]')),
      pending: Number(text(pane.querySelector('button[aria-label="批注列表"]'))?.replace(/\D/g, '')),
      pins: [...pane.querySelectorAll('[data-canvas-pin]')].map(pin => ({ node: pin.dataset.canvasPin, label: pin.getAttribute('aria-label'), count: Number(pin.textContent) })),
      draft: draft && { title: text(draft.firstElementChild), text: draft.querySelector('textarea').value, placeholder: draft.querySelector('textarea').placeholder },
      list: list && {
        filters: [...list.querySelectorAll('[data-canvas-filter]')].map(button => ({ status: button.dataset.canvasFilter, on: button.getAttribute('aria-pressed') === 'true', text: text(button) })),
        threads: [...list.querySelectorAll('[data-canvas-thread]')].map(thread => ({
          id: thread.dataset.canvasThread,
          status: thread.dataset.status,
          label: text(thread.querySelector('header button')),
          badge: text(thread.querySelector('[data-canvas-status]')),
          text: text(thread.querySelector(':scope > p:not([role])')),
          by: text(thread.querySelector(':scope > div:not([data-canvas-reply])')),
          drift: text(thread.querySelector(':scope > p[role="note"]')),
          replies: [...thread.querySelectorAll('[data-canvas-reply]')].map(reply => reply.innerText.replace(/\s*\n\s*/g, ' · ')),
          buttons: [...thread.querySelectorAll('footer button')].map(text),
        })),
        empty: text(list.querySelector(':scope > div > p')),
      },
      braces: /\{\w+\}/.test([pane.innerText, list?.innerText ?? '', ...[...pane.querySelectorAll('[aria-label], [title], [placeholder]')].flatMap(e => [e.getAttribute('aria-label'), e.getAttribute('title'), e.getAttribute('placeholder')])].join('\n')),
    }
  }, SEL)
}

/** Wait until `test(await comments(tab))` holds, e.g. for the agent's reply to arrive (the preview polls every 3 s). */
export async function waitForComments(tab, what, test, timeoutMs = 20_000) {
  return poll(what, async () => { const state = await comments(tab); return state && test(state) ? state : undefined }, timeoutMs, 250)
}

// Input for the comment helpers goes through the tab's own page. After an omp tab.click in the
// preview, the next tab.click or tab.press often failed with `Tab "canvas-dev" is busy` although the
// click had landed; raw page input never did.
const click = (tab, selector) => tab.run(async ({ page }, target) => { await page.click(target) }, { args: [selector] })
const press = (tab, key) => tab.run(async ({ page }, name) => { await page.keyboard.press(name) }, { args: [key] })

/** The board's visible geometry and feedback, not a private React store. */
export async function board(tab) {
  return tab.evaluate(() => {
    const root = document.querySelector('[data-canvas-board]')
    if (!root) return null
    const rect = el => el.getBoundingClientRect().toJSON()
    return {
      readonly: root.getAttribute('data-readonly') === 'true',
      nodes: [...root.querySelectorAll('.react-flow__node')].map(el => ({
        id: el.dataset.id, transform: el.style.transform, width: el.style.width, height: el.style.height,
        rect: rect(el), srcdoc: el.querySelector('iframe')?.srcdoc ?? null,
      })),
      edges: [...root.querySelectorAll('.react-flow__edge')].map(el => ({ id: el.dataset.id, path: el.querySelector('.react-flow__edge-path')?.getAttribute('d') })),
      status: root.querySelector('[data-canvas-board-status]')?.textContent ?? null,
      errors: [...root.querySelectorAll('[role="alert"]')].map(el => el.textContent),
      lost: [...root.querySelectorAll('[data-canvas-lost]')].map(el => ({ id: el.dataset.canvasLost, text: el.textContent })),
    }
  })
}

export async function waitForBoard(tab, what, test, timeoutMs = 20_000) {
  return poll(what, async () => { const state = await board(tab); return state && test(state) ? state : undefined }, timeoutMs, 150)
}

/** Real pointer gesture; delta is in screen pixels. End=false leaves the pointer down for an agent-write race. */
export async function dragBoardNode(tab, id, dx, dy, { end = true } = {}) {
  return tab.run(async ({ page }, id, dx, dy, end) => {
    const box = await (await page.$(`.react-flow__node[data-id="${id}"]`))?.boundingBox()
    if (!box) throw new Error(`board node ${id} is not visible`)
    const from = { x: box.x + box.width / 2, y: box.y + Math.min(30, box.height / 2) }
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + dx, from.y + dy, { steps: 12 })
    if (end) await page.mouse.up()
    return { from, to: { x: from.x + dx, y: from.y + dy } }
  }, { args: [id, dx, dy, end] })
}

export async function finishBoardDrag(tab) {
  await tab.run(async ({ page }) => { await page.mouse.up() })
}

export async function resizeBoardNode(tab, id, dx, dy) {
  await tab.run(async ({ page }, id, dx, dy) => {
    const node = `.react-flow__node[data-id="${id}"]`
    await page.click(node)
    const box = await (await page.$(`${node} .react-flow__resize-control.handle.bottom.right`))?.boundingBox()
    if (!box) throw new Error('board resize handle is not visible')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 10 })
    await page.mouse.up()
  }, { args: [id, dx, dy] })
}

/** Board coordinates; choose a point outside every current node. */
export async function addBoardNote(tab, point, text) {
  await tab.run(async ({ page }, point, text) => {
    const screen = await page.evaluate(point => {
      const flow = document.querySelector('[data-canvas-board] .react-flow')
      const matrix = new DOMMatrix(getComputedStyle(flow.querySelector('.react-flow__viewport')).transform)
      const box = flow.getBoundingClientRect()
      return { x: box.x + matrix.e + point.x * matrix.a, y: box.y + matrix.f + point.y * matrix.d }
    }, point)
    await page.mouse.click(screen.x, screen.y, { count: 2 })
    await page.waitForSelector('[data-canvas-board-editor] textarea')
    await page.type('[data-canvas-board-editor] textarea', text)
    await page.click('[data-canvas-board-editor] button[type="submit"]')
  }, { args: [point, text] })
}

export async function connectBoardNodes(tab, from, to, label = '', fromSide = 'right', toSide = 'left') {
  await tab.run(async ({ page }, from, to, label, fromSide, toSide) => {
    const handle = async (id, side) => (await page.$(`.react-flow__node[data-id="${id}"] .react-flow__handle[data-handleid="${side}"]`))?.boundingBox()
    const a = await handle(from, fromSide)
    const b = await handle(to, toSide)
    if (!a || !b) throw new Error('board connection handles are not visible')
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
    await page.mouse.down()
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 })
    await page.mouse.up()
    await page.waitForSelector('[data-canvas-board-editor] input')
    await page.type('[data-canvas-board-editor] input', label)
    await page.click('[data-canvas-board-editor] button[type="submit"]')
  }, { args: [from, to, label, fromSide, toSide] })
}

/** Pick an exposed edge segment; its midpoint may be underneath a node. */
export async function deleteBoardEdge(tab, id) {
  await tab.run(async ({ page }, id) => {
    const point = await page.evaluate(id => {
      const edge = document.querySelector(`.react-flow__edge[data-id="${id}"]`)
      const path = edge?.querySelector('.react-flow__edge-path')
      if (!path) throw new Error(`board edge ${id} is missing`)
      for (const fraction of [.5, .25, .75, .1, .9]) {
        const local = path.getPointAtLength(path.getTotalLength() * fraction)
        const screen = new DOMPoint(local.x, local.y).matrixTransform(path.getScreenCTM())
        if (document.elementFromPoint(screen.x, screen.y)?.closest('.react-flow__edge') === edge) return { x: screen.x, y: screen.y }
      }
      throw new Error(`board edge ${id} has no exposed hit target; move an overlapping node first`)
    }, id)
    await page.mouse.click(point.x, point.y)
    await page.waitForSelector(`.react-flow__edge.selected[data-id="${id}"]`)
    await page.keyboard.press('Delete')
  }, { args: [id] })
}

export async function deleteBoardNode(tab, id) {
  await tab.run(async ({ page }, id) => {
    await page.click(`.react-flow__node[data-id="${id}"]`)
    await page.keyboard.press('Delete')
  }, { args: [id] })
}

/**
 * Turn comment mode on or off with the 批注 button, or with the C key after clicking an empty
 * corner of the diagram (keys reach the preview only while it has the focus).
 */
export async function commentMode(tab, on, { via = 'button' } = {}) {
  if ((await comments(tab)).commenting !== on) {
    if (via === 'key') {
      const corner = await tab.evaluate(sel => { const box = document.querySelector(sel).getBoundingClientRect(); return { x: box.left + 24, y: box.bottom - 24 } }, SEL.preview)
      await tab.run(async ({ page }, x, y) => { await page.mouse.click(x, y) }, { args: [corner.x, corner.y] })
      await press(tab, 'c')
    } else await click(tab, SEL.commentMode)
  }
  return waitForComments(tab, `comment mode ${on ? 'on' : 'off'}`, state => state.commenting === on, 5000)
}

/** Press Escape where the focus is (in the preview it leaves comment mode). */
export async function escape(tab) {
  await press(tab, 'Escape')
  return comments(tab)
}

/** In comment mode, click node `id`, type `text`, press Enter, and wait for its pin to count one more. Returns the draft as it showed, and the state after. */
export async function addComment(tab, id, text) {
  const count = state => state.pins.find(entry => entry.node === id)?.count ?? 0
  const before = count(await comments(tab))
  await click(tab, node(id))
  const { draft } = await waitForComments(tab, `the draft on ${id}`, state => state.draft, 5000)
  await tab.run(async ({ page }, target, words) => { await page.type(target, words) }, { args: [`${SEL.draft} textarea`, text] })
  await press(tab, 'Enter')
  const after = await waitForComments(tab, `a pin counting ${before + 1} on ${id}`, state => !state.draft && count(state) > before, 10_000)
  return { draft, after }
}

/** Open the side list with ☰ unless it is open. */
export async function openComments(tab) {
  if (!(await comments(tab)).list) await click(tab, SEL.commentList)
  return waitForComments(tab, 'the comment list', state => state.list, 5000)
}

/** Toggle one status filter of the side list (未处理 open, 已处理 addressed, 已解决 resolved). */
export async function toggleFilter(tab, status) {
  await click(tab, filter(status))
  return comments(tab)
}

/** Press a thread's button by its text: 解决, 重开, 删除, then 确认删除 within 3 s. */
export async function threadAction(tab, id, label) {
  await tab.run(async ({ page }, target, text) => {
    for (const button of await page.$$(`${target} footer button`)) {
      if (await button.evaluate(element => element.textContent.trim()) === text) return button.click()
    }
    throw new Error(`dev-ui: ${target} has no ${text} button`)
  }, { args: [thread(id), label] })
}

/** Full-page PNG at device scale, written straight to `file`. */
export async function shot(tab, file) {
  await tab.run(async ({ page }, path) => { await page.screenshot({ path }) }, { args: [file] })
  return file
}

/** Ids in the archived-session list of canvas-dev's own workspace store. */
export function archivedIds(data = DEV_DATA) {
  return new Set(JSON.parse(readFileSync(join(data, 'storages', 'workspace.json'), 'utf8')).global.archivedSessionIds)
}

/**
 * Archive the session on screen and wait until canvas-dev stores it as archived; returns its id. A
 * conversation is archived from its row menu (right-click → 归档会话); a blank 新会话 has no row
 * menu and is archived with Meta+Alt+A. Refuses a session this run did not record.
 */
export async function archive(tab, run) {
  const { id, title } = await currentSession(tab)
  if (!runSessions(run).includes(id)) throw new Error(`dev-ui: ${id} (${title}) is not in ${run}/sessions.json; this run did not create it`)
  if (title === '新会话') await tab.press('Meta+Alt+A')
  else {
    await tab.click(`${SEL.currentRow}`, { button: 'right' })
    const entry = await poll('the 归档会话 menu item', async () => (await elements(tab)).find(e => e.role === 'menuitem' && e.name === '归档会话'), 5000, 200)
    await tab.id(entry.id).click()
  }
  await poll(`${id} in archivedSessionIds`, () => archivedIds().has(id), 10_000, 500)
  return id
}
