import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { renderDiagram } from '../../src/shared/diagram.ts'
import { pageHtml } from '../../src/shared/page.ts'
import { HeadlessBrowser, browserCandidates, locateBrowser } from '../../src/host/browser.ts'
import { screenshot } from '../../src/host/raster.ts'

const out = resolve(process.argv[2] ?? join(tmpdir(), 'dsh-board-writes'))
const source = await readFile(process.argv[3] ?? new URL('./chart.mmd', import.meta.url), 'utf8')
const diagram = renderDiagram(source)
if (!diagram.ok) throw new Error(JSON.stringify(diagram.diagnostics))
const browser = locateBrowser(process.env.CANVAS_BROWSER, browserCandidates(process.platform, process.env, homedir()), existsSync)
if (browser.kind !== 'found') throw new Error(browser.reason)
await mkdir(out, { recursive: true })
await writeFile(join(out, 'chart.svg'), diagram.svg)
const host = new HeadlessBrowser()
try {
  const page = pageHtml({ markup: diagram.svg, width: diagram.width, height: diagram.height }, 'light')
  const image = await host.use(browser.path, instance => screenshot(instance, page, new AbortController().signal))
  await writeFile(join(out, 'chart.png'), image.png)
  const result = { renderer: 'dsh-canvas renderDiagram / pageHtml / screenshot', kind: diagram.kind,
    width: image.width, height: image.height, scale: image.scale, png: join(out, 'chart.png') }
  await writeFile(join(out, 'render.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
} finally {
  await host.dispose()
}
