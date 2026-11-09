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
import { basename, join, resolve } from 'node:path'

export const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

export const SEL = {
  /** 预览版说明: shown once per profile until 继续 is pressed. */
  notice: 'role/button[name="继续"]',
  /** The composer of a new (blank) session, and of a session that already has turns. */
  newPrompt: 'role/textbox[name="描述你想要构建的内容, / 调用指令, @ 文件或对话"]',
  replyPrompt: 'role/textbox[name="发消息或创建任务, / 调用指令, @ 文件或对话"]',
  /** The session on screen: its row in the left tree, keyed `session:<id>`. */
  currentRow: '[role="treeitem"][aria-selected="true"][data-row-key^="session:"]',
  /** The right sidebar's renderer menu (图 / 纯文本); the chat header has other 打开方式 buttons. */
  rendererMenu: '[data-slot="sidebar.right.pane.tab"] button[aria-label="打开方式"]',
  /** dsh-canvas's preview: a sandboxed srcdoc iframe inside this element. */
  preview: '[data-canvas-diagram]',
  previewFrame: '[data-canvas-diagram] iframe',
  /** dsh-canvas's error view, which replaces the preview while the file does not parse. */
  previewError: '[data-slot="sidebar.right.pane.tab"] [role="alert"]',
}

const NEW_PROMPT = /name="(.*)"/.exec(SEL.newPrompt)[1]
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
 * Open the UI in an isolated headless Chrome and get past 预览版说明. Loading the page persists a
 * blank session (新会话) in the selected workspace, and that session becomes the conversation
 * once you send into it. open() records its id in `<run>/sessions.json`. Use open() for every page
 * load, never tab.goto or a reload, so each new blank session is recorded.
 */
export async function open(browser, { name = 'canvas-dev', url, run }) {
  mkdirSync(run, { recursive: true })
  const tab = await browser.open({
    name, url, timeout: 60,
    app: { path: CHROME, args: ['--headless=new', `--user-data-dir=${chromeProfile(run)}`, '--hide-scrollbars'], tern: false, relay: false },
  })
  await tab.emulate({ viewport: { width: 1600, height: 1000 } })
  await poll('the composer or 预览版说明', async () => (await elements(tab)).some(e => e.role === 'button' && e.name === '继续' || e.role === 'textbox' && e.name === NEW_PROMPT), 30_000)
  if ((await elements(tab)).some(e => e.role === 'button' && e.name === '继续')) {
    await tab.click(SEL.notice)
    await poll('the composer', async () => (await elements(tab)).some(e => e.role === 'textbox' && e.name === NEW_PROMPT), 10_000)
  }
  const blank = await poll('the blank session row', () => currentSession(tab).catch(() => undefined), 10_000, 250)
  recordSession(run, blank.id)
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
  await poll('the sidebar preview', () => tab.evaluate(sel => Boolean(document.querySelector(sel.previewFrame) || document.querySelector(sel.previewError)), SEL), 15_000)
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

/** Full-page PNG at device scale, written straight to `file`. */
export async function shot(tab, file) {
  await tab.run(async ({ page }, path) => { await page.screenshot({ path }) }, { args: [file] })
  return file
}

/** Ids in DSH's archived-session list, kept in the store every profile on this machine shares. */
export function archivedIds(home = process.env.HOME) {
  return new Set(JSON.parse(readFileSync(join(home, '.dsh', 'storages', 'workspace.json'), 'utf8')).global.archivedSessionIds)
}

/**
 * Archive the session on screen and wait until DSH stores it as archived; returns its id. A
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
