#!/usr/bin/env node
// Documentation gate: every repo-linked doc exists, every README/docs pair
// has its bilingual twin, both dictionaries carry identical key sets, the
// compatibility matrix matches package.json, and the notices name every
// runtime dependency. Exits non-zero on the first failure class.
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function dirname(p) { return p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))) }

const problems = []
const fail = (label) => { problems.push(label) }

// 1) Bilingual pairs exist.
for (const pair of [
  ['README.md', 'README.zh.md'],
  ['THIRD_PARTY_NOTICES.md', null],
  ['SECURITY.md', null],
  ['docs/INSTALL.md', 'docs/INSTALL.zh.md'],
  ['docs/COMPATIBILITY.md', 'docs/COMPATIBILITY.zh.md'],
  ['docs/SECURITY-MODEL.md', 'docs/SECURITY-MODEL.zh.md'],
  ['docs/RECOVERY.md', 'docs/RECOVERY.zh.md'],
]) {
  const [doc, twin] = pair
  if (!existsSync(join(ROOT, doc))) fail(`missing ${doc}`)
  if (twin !== null && !existsSync(join(ROOT, twin))) fail(`missing bilingual twin ${twin}`)
}

// 2) Locale dictionaries share one key set.
const locales = readFileSync(join(ROOT, 'src/client/locales.ts'), 'utf8')
const zhKeys = /export const zh = \{([\s\S]*?)\n\} satisfies/.exec(locales)
const enKeys = /export const en = \{([\s\S]*?)\n\} satisfies/.exec(locales)
if (zhKeys === null || enKeys === null) {
  fail('locales.ts shape not recognized')
} else {
  const keysOf = (body) => [...body.matchAll(/^\s{2}([A-Za-z0-9]+):/gm)].map(m => m[1])
  const zh = keysOf(zhKeys[1])
  const en = keysOf(enKeys[1])
  const zhSet = new Set(zh)
  const enSet = new Set(en)
  for (const key of zh) if (!enSet.has(key)) fail(`locale key ${key} missing in en`)
  for (const key of en) if (!zhSet.has(key)) fail(`locale key ${key} missing in zh`)
}

// 3) Compatibility matrix matches package.json.
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const compatibility = JSON.parse(readFileSync(join(ROOT, 'compatibility.json'), 'utf8'))
if (compatibility.pluginVersion !== pkg.version) fail(`compatibility.pluginVersion ${compatibility.pluginVersion} != package.json ${pkg.version}`)
const compatDoc = readFileSync(join(ROOT, 'docs/COMPATIBILITY.md'), 'utf8')
if (!compatDoc.includes(pkg.version)) fail('COMPATIBILITY.md does not mention the current version')

// 4) Notices name every runtime dependency.
const notices = readFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8')
for (const dep of Object.keys(pkg.dependencies ?? {})) {
  if (!notices.includes(`\`${dep}\``)) fail(`notices missing runtime dependency ${dep}`)
}

// 5) README links resolve to real files.
for (const readme of ['README.md', 'README.zh.md']) {
  const text = readFileSync(join(ROOT, readme), 'utf8')
  for (const match of text.matchAll(/\]\((docs\/[A-Za-z-]+\.md|LICENSE|THIRD_PARTY_NOTICES\.md|compatibility\.json)\)/g)) {
    if (!existsSync(join(ROOT, match[1]))) fail(`${readme} links to missing ${match[1]}`)
  }
}

if (problems.length > 0) {
  console.error(`verify-docs: FAIL\n${problems.join('\n')}`)
  process.exit(1)
}
console.log('verify-docs: OK (bilingual pairs, locale parity, version matrix, notices, links)')
