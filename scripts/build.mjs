import { readFile, writeFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
// playwright-core stays a runtime dependency: it locates its own files at run time and is not
// safe to bundle. DSH packages are supplied by the host.
await build({
  absWorkingDir: root,
  entryPoints: { index: 'src/host/index.ts' },
  outdir: 'lib',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'warning',
  external: ['@deepseek-ai/*', 'playwright-core'],
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
})

// DSH supplies React from its module table; never bundle a second React instance.
const moduleTable = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'])
// Browser-safe pure helpers DSH inlines into its own client bundles (tsdown.client.ts INLINE_SAFE);
// they are not module-table rows, so the pinned copy is bundled here too.
const inlineSafe = new Set(['@deepseek-ai/dsh-util-workspace-path'])
const client = await build({
  absWorkingDir: root,
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2023',
  jsx: 'automatic',
  // React Flow's stylesheet travels inside the client module, not as an unserved sibling asset.
  loader: { '.css': 'text' },
  write: false,
  minify: true,
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{
    name: 'dsh-module-table',
    setup(builder) {
      builder.onResolve({ filter: /^[^./]/ }, ({ path }) => {
        if (moduleTable.has(path)) return { path, external: true }
        if (inlineSafe.has(path)) return undefined
        if (isBuiltin(path) || path.startsWith('@deepseek-ai/') || /^react(?:-dom)?(?:\/|$)/.test(path)) {
          throw new Error(`unsupported browser import: ${path}`)
        }
        return undefined
      })
    },
  }],
})
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
await writeFile(new URL('../lib/client.js', import.meta.url), [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {`,
  'var module = { exports: {} }; var exports = module.exports;',
  client.outputFiles[0].text,
  'return module.exports; } });',
  '',
].join('\n'))
console.log('built dsh-canvas host and client modules')
