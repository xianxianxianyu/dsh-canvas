import { join, win32 } from 'node:path'
import type { Browser } from 'playwright-core'

export type BrowserLocation =
  | { readonly kind: 'found'; readonly path: string }
  | { readonly kind: 'missing'; readonly reason: string }

/**
 * Where Chrome, then Edge, install on this platform. Nothing is downloaded.
 * @param platform - `process.platform`.
 * @param env - environment variables; Windows reads its program directories from them.
 * @param home - the user's home directory.
 * @returns executable paths in preference order.
 */
export function browserCandidates(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>, home: string): string[] {
  if (platform === 'darwin') {
    const roots = ['/Applications', join(home, 'Applications')]
    return [
      ...roots.map(root => `${root}/Google Chrome.app/Contents/MacOS/Google Chrome`),
      ...roots.map(root => `${root}/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`),
    ]
  }
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((root): root is string => Boolean(root))
    return [
      ...roots.map(root => win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')),
      ...roots.map(root => win32.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    ]
  }
  return [
    '/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome',
    '/opt/microsoft/msedge/msedge', '/usr/bin/microsoft-edge-stable', '/usr/bin/microsoft-edge',
  ]
}

/**
 * Pick the browser for screenshots. A configured path is used alone, never replaced by discovery.
 * @param configured - the plugin's `browserPath` setting.
 * @param candidates - discovery order from {@link browserCandidates}.
 * @param exists - whether a path is an existing file.
 * @returns the executable, or why there is none.
 */
export function locateBrowser(configured: string | undefined, candidates: readonly string[], exists: (path: string) => boolean): BrowserLocation {
  if (configured !== undefined) {
    return exists(configured) ? { kind: 'found', path: configured } : { kind: 'missing', reason: `配置的 browserPath 不存在：${configured}` }
  }
  const path = candidates.find(exists)
  return path === undefined
    ? { kind: 'missing', reason: '本机找不到 Chrome 或 Edge（可在插件配置 browserPath 里指定浏览器）' }
    : { kind: 'found', path }
}

/** One lazily launched headless browser, closed after an idle period and on disposal. */
export class HeadlessBrowser {
  private current: { readonly path: string; readonly browser: Promise<Browser> } | undefined
  private users = 0
  private timer: NodeJS.Timeout | undefined
  private disposed = false
  private readonly idleMs: number

  /** @param idleMs - how long an unused browser stays open. */
  constructor(idleMs = 60_000) {
    this.idleMs = idleMs
  }

  /**
   * Run work with the browser at `path`, launching it on first use.
   * @param path - the executable; a different path replaces the running browser.
   * @param work - the work; the browser stays open until it settles.
   * @returns the work's result.
   */
  async use<T>(path: string, work: (browser: Browser) => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error('canvas: the headless browser was disposed')
    clearTimeout(this.timer)
    this.users++
    try {
      if (this.current?.path !== path) {
        void this.shut()
        this.current = { path, browser: this.launch(path) }
      }
      return await work(await this.current.browser)
    } finally {
      if (--this.users === 0 && !this.disposed) {
        this.timer = setTimeout(() => { void this.shut() }, this.idleMs)
        this.timer.unref?.()
      }
    }
  }

  /** Close the browser and refuse later work. */
  async dispose(): Promise<void> {
    this.disposed = true
    clearTimeout(this.timer)
    await this.shut()
  }

  private launch(path: string): Promise<Browser> {
    const launched = import('playwright-core').then(({ chromium }) => chromium.launch({
      executablePath: path, headless: true, args: ['--hide-scrollbars', '--force-color-profile=srgb'],
    }))
    const forget = (): void => { if (this.current?.browser === launched) this.current = undefined }
    launched.then(browser => { browser.on('disconnected', forget) }, forget)
    return launched
  }

  private async shut(): Promise<void> {
    const current = this.current
    this.current = undefined
    const browser = await current?.browser.catch(() => undefined)
    await browser?.close()
  }
}
