import type { Browser, BrowserContext, Page as BrowserPage } from 'playwright-core'
import { inspectMock, type MockInspection } from '../shared/mock-dom.ts'
import type { Page } from '../shared/page.ts'
import { abortable, BROWSER_TIMEOUT_MS } from './browser.ts'

/** DeepSeek's 1024-token image grid keeps a square image up to 1302×1302 px; larger ones are shrunk. */
export const IMAGE_PIXEL_BUDGET = 1302 * 1302
/** Small charts are enlarged at most this much, so thin lines and small text stay legible. */
export const MAX_UPSCALE = 2
/** Longest side DSH sends to the provider. */
export const MAX_SIDE = 4096

/**
 * Device scale for a screenshot: as large as the image budget allows, never above {@link MAX_UPSCALE}.
 * @param width - page width in CSS pixels.
 * @param height - page height in CSS pixels.
 * @returns a scale rounded down to hundredths, or zero when even 0.01 cannot fit.
 */
export function imageScale(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 0
  const fit = Math.min(Math.sqrt(IMAGE_PIXEL_BUDGET / (width * height)), MAX_SIDE / Math.max(width, height), MAX_UPSCALE)
  let hundredths = Math.floor(fit * 100)
  while (hundredths > 0) {
    const w = Math.ceil(width * (hundredths / 100))
    const h = Math.ceil(height * (hundredths / 100))
    if (w * h <= IMAGE_PIXEL_BUDGET && Math.max(w, h) <= MAX_SIDE) break
    hundredths--
  }
  return hundredths / 100
}

export interface Screenshot {
  readonly png: Uint8Array
  readonly width: number
  readonly height: number
  readonly scale: number
}

export interface MockRendering {
  readonly inspection: MockInspection
  readonly shot?: Screenshot
}

/** A shorter deadline is useful to callers with a smaller execution window. */
interface RenderOptions {
  readonly timeoutMs?: number
}

type Step = <T>(work: Promise<T>) => Promise<T>

/**
 * Screenshot a page in a fresh, script-free browser context.
 * @param browser - a launched Chromium-family browser.
 * @param page - the document from `page.ts`.
 * @param signal - cancels the screenshot.
 * @returns the PNG and its pixel size.
 */
export async function screenshot(browser: Browser, page: Page, signal: AbortSignal, options: RenderOptions = {}): Promise<Screenshot> {
  return renderPage(browser, page, signal, imageScale(page.width, page.height), capture, options)
}

/**
 * 在同一张离线、禁脚本页面上检查 mock 的真实布局；只有附件门禁放行时才截 PNG。
 * @param browser - a launched Chromium-family browser.
 * @param page - the same mock page shown in the preview.
 * @param signal - cancels layout and capture.
 * @param captureImage - whether the image route accepts a PNG.
 * @returns visible anchors and layout warnings, plus the optional screenshot.
 */
export async function renderMock(browser: Browser, page: Page, signal: AbortSignal, captureImage: boolean, options: RenderOptions = {}): Promise<MockRendering> {
  const scale = captureImage ? imageScale(page.width, page.height) : 1
  return renderPage(browser, page, signal, scale, async (tab, scale, step) => {
    // inspectMock is self-contained: evaluate must not close over host-side imports or helpers.
    const inspection = await step(tab.evaluate(inspectMock, undefined))
    return captureImage ? { inspection, shot: await capture(tab, scale, step) } : { inspection }
  }, options)
}

async function capture(tab: BrowserPage, scale: number, step: Step): Promise<Screenshot> {
  const png = await step(tab.screenshot({ type: 'png', animations: 'disabled', caret: 'hide', timeout: BROWSER_TIMEOUT_MS }))
  // PNG IHDR: width and height are the big-endian words at bytes 16 and 20.
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20)
  if (width * height > IMAGE_PIXEL_BUDGET || Math.max(width, height) > MAX_SIDE) throw new Error('截图超出图片预算')
  return { png, width, height, scale }
}

/** A single deadline covers all protocol steps, including context/page creation and evaluation. */
async function renderPage<T>(browser: Browser, page: Page, signal: AbortSignal, scale: number, render: (tab: BrowserPage, scale: number, step: Step) => Promise<T>, { timeoutMs = BROWSER_TIMEOUT_MS }: RenderOptions): Promise<T> {
  signal.throwIfAborted()
  if (scale === 0) throw new Error(`页面太大（${page.width}×${page.height}），先缩小页面`)
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(new Error(`浏览器渲染超时（${timeoutMs} ms）`)), timeoutMs)
  const cancelled = AbortSignal.any([signal, deadline.signal])
  const step: Step = work => abortable(work, cancelled)
  let context: BrowserContext | undefined
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    if (context === undefined) return Promise.resolve()
    return closing ??= context.close().catch(() => undefined)
  }
  const abort = (): void => { void close() }
  cancelled.addEventListener('abort', abort, { once: true })
  try {
    // If creation replies after cancellation, close that late context too.
    await step(browser.newContext({
      viewport: { width: page.width, height: page.height }, deviceScaleFactor: scale, javaScriptEnabled: false, offline: true,
    }).then(created => {
      context = created
      if (cancelled.aborted) void close()
    }))
    const active = context!
    await step(active.route('**/*', route => route.abort()))
    const tab = await step(active.newPage())
    await step(tab.setContent(page.html, { waitUntil: 'load', timeout: timeoutMs }))
    const rendered = await render(tab, scale, step)
    cancelled.throwIfAborted()
    return rendered
  } finally {
    // A crashed renderer can also fail to acknowledge close. The same deadline bounds cleanup;
    // on cancellation initiate close immediately, then release the user for idle shutdown.
    await step(close()).catch(() => undefined)
    clearTimeout(timer)
    cancelled.removeEventListener('abort', abort)
  }
}
