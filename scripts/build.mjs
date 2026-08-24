#!/usr/bin/env node
// Build both halves: the Host ESM lib (tsc) and the browser client bundle
// (esbuild wrapped in the DSH module-table factory contract:
// window.__ModuleLoader__.load({ id, factory }) — see the out-of-tree client
// constraints in the DSH settings-plugins README).
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const id = pkg.name
const require = createRequire(import.meta.url)

// 1) Host half: TypeScript emit (JS + d.ts) into lib/. Invoke the tsc JS
// entry directly — spawning shell shims (.cmd) is blocked on Windows Node 24.
const tscEntry = require.resolve('typescript/bin/tsc')
execFileSync(process.execPath, [tscEntry, '-p', 'tsconfig.build.json'], { stdio: 'inherit' })

// 2) Client half: bundled CJS body inside the factory wrapper. Official
// @deepseek-ai/* client packages and react stay external — the injected
// require resolves them through the browser module table.
const result = await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  outfile: 'lib/client.js',
  sourcemap: true,
  logLevel: 'info',
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/*'],
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: 'return module.exports; } });' },
})

if (result.errors.length > 0) process.exit(1)
console.log('build complete: lib/index.js (host) + lib/client.js (client)')
