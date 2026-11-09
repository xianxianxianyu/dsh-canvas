import type { Browser, Page as BrowserPage } from 'playwright-core'
import { inspectMock, type MockInspection } from '../shared/mock-dom.ts'
import type { Page } from '../shared/page.ts'

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
 * @returns a scale rounded down to hundredths.
 */
export function imageScale(width: number, height: number): number {
  const fit = Math.min(Math.sqrt(IMAGE_PIXEL_BUDGET / (width * height)), MAX_SIDE / Math.max(width, height), MAX_UPSCALE)
  return Math.max(Math.floor(fit * 100) / 100, 0.01)
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

/**
 * Screenshot a page in a fresh, script-free browser context.
 * @param browser - a launched Chromium-family browser.
 * @param page - the document from `page.ts`.
 * @param signal - cancels the screenshot.
 * @returns the PNG and its pixel size.
 */
export async function screenshot(browser: Browser, page: Page, signal: AbortSignal): Promise<Screenshot> {
  return renderPage(browser, page, signal, imageScale(page.width, page.height), capture)
}

/**
 * 在同一张离线、禁脚本页面上检查 mock 的真实布局；只有附件门禁放行时才截 PNG。
 * @param browser - a launched Chromium-family browser.
 * @param page - the same mock page shown in the preview.
 * @param signal - cancels layout and capture.
 * @param captureImage - whether the image route accepts a PNG.
 * @returns visible anchors and layout warnings, plus the optional screenshot.
 */
export async function renderMock(browser: Browser, page: Page, signal: AbortSignal, captureImage: boolean): Promise<MockRendering> {
  const scale = captureImage ? imageScale(page.width, page.height) : 1
  return renderPage(browser, page, signal, scale, async (tab, scale) => {
    // inspectMock is self-contained: evaluate must not close over host-side imports or helpers.
    const inspection = await tab.evaluate(inspectMock, undefined)
    return captureImage ? { inspection, shot: await capture(tab, scale) } : { inspection }
  })
}

async function capture(tab: BrowserPage, scale: number): Promise<Screenshot> {
  const png = await tab.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' })
  // PNG IHDR: width and height are the big-endian words at bytes 16 and 20.
  return { png, width: png.readUInt32BE(16), height: png.readUInt32BE(20), scale }
}

/** One fresh context and one document load for either screenshots or mock layout plus capture. */
async function renderPage<T>(browser: Browser, page: Page, signal: AbortSignal, scale: number, render: (tab: BrowserPage, scale: number) => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  const context = await browser.newContext({
    viewport: { width: page.width, height: page.height }, deviceScaleFactor: scale, javaScriptEnabled: false, offline: true,
  })
  const abort = (): void => { void context.close() }
  signal.addEventListener('abort', abort, { once: true })
  try {
    const tab = await context.newPage()
    await tab.setContent(page.html, { waitUntil: 'load' })
    const rendered = await render(tab, scale)
    signal.throwIfAborted()
    return rendered
  } finally {
    signal.removeEventListener('abort', abort)
    await context.close()
  }
}
