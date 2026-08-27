#!/usr/bin/env node
// Documentation gate — fail-closed. Checks:
//   1. every doc pair exists (bilingual twins where required)
//   2. locale dictionaries share one key set
//   3. compatibility: plugin version === package.json in BOTH language
//      matrices, and the DSH release + commit in docs match
//      compatibility.json exactly
//   4. notices name every runtime dependency WITH its recorded license
//      matching the known license map
//   5. every relative link in every README/docs markdown file resolves to
//      a real file (multiline links and .zh.md included)
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function dirname0(p) { return p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))) }

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
  ['docs/MAINTENANCE.md', 'docs/MAINTENANCE.zh.md'],
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
  const enSet = new Set(en)
  const zhSet = new Set(zh)
  for (const key of zh) if (!enSet.has(key)) fail(`locale key ${key} missing in en`)
  for (const key of en) if (!zhSet.has(key)) fail(`locale key ${key} missing in zh`)
}

// 3) Compatibility: package.json === compatibility.json === BOTH matrices,
//    and the DSH release + commit match compatibility.json.
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const compatibility = JSON.parse(readFileSync(join(ROOT, 'compatibility.json'), 'utf8'))
if (compatibility.pluginVersion !== pkg.version) fail(`compatibility.pluginVersion ${compatibility.pluginVersion} != package.json ${pkg.version}`)
const tested = compatibility.dsh?.[0]
if (tested === undefined) fail('compatibility.json records no tested DSH entry')
else {
  for (const doc of ['docs/COMPATIBILITY.md', 'docs/COMPATIBILITY.zh.md']) {
    const text = readFileSync(join(ROOT, doc), 'utf8')
    if (!text.includes(`| ${pkg.version} |`)) fail(`${doc} matrix row for plugin ${pkg.version} missing`)
    if (!text.includes(tested.release)) fail(`${doc} matrix missing DSH release ${tested.release}`)
    if (!text.includes(tested.commit)) fail(`${doc} matrix missing DSH commit ${tested.commit.slice(0, 12)}…`)
  }
}

// 4) Notices name every runtime dependency with its license.
const LICENSE_BY_PACKAGE = {
  'js-yaml': 'MIT', 'yaml': 'ISC', 'zod': 'MIT', '@deepseek-ai/dsh-atomic-write': 'MIT',
}
const notices = readFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8')
for (const [dep, license] of Object.entries(LICENSE_BY_PACKAGE)) {
  if (!(pkg.dependencies ?? {})[dep]) continue
  const row = new RegExp(`\\|\\s*\`${dep}\`\\s*\\|\\s*${license}\\s*\\|`)
  if (!row.test(notices)) fail(`notices row for ${dep} missing or license != ${license}`)
}
for (const dep of Object.keys(pkg.dependencies ?? {})) {
  if (!notices.includes(`\`${dep}\``)) fail(`notices missing runtime dependency ${dep}`)
}

// 5) Every relative markdown link resolves (multiline + .zh.md aware).
const DOCS = [
  'README.md', 'README.zh.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md',
  'docs/INSTALL.md', 'docs/INSTALL.zh.md', 'docs/COMPATIBILITY.md', 'docs/COMPATIBILITY.zh.md',
  'docs/SECURITY-MODEL.md', 'docs/SECURITY-MODEL.zh.md', 'docs/RECOVERY.md', 'docs/RECOVERY.zh.md',
  'docs/MAINTENANCE.md', 'docs/MAINTENANCE.zh.md',
]
for (const doc of DOCS) {
  if (!existsSync(join(ROOT, doc))) continue
  const text = readFileSync(join(ROOT, doc), 'utf8').replace(/\r\n/g, '\n')
  // Markdown links, tolerant of a newline inside them (collapse for parse).
  const collapsed = text.replace(/\]\(\s*\n\s*/g, '](')
  for (const match of collapsed.matchAll(/\]\(([^)#\s]+)\)/g)) {
    const target = match[1]
    if (/^[a-z]+:\/\//i.test(target) || target.startsWith('#') || target.startsWith('mailto:')) continue
    const resolved = join(dirname0(join(ROOT, doc)), target)
    if (!existsSync(resolved)) fail(`${doc} links to missing ${target}`)
  }
}

if (problems.length > 0) {
  console.error(`verify-docs: FAIL\n${problems.join('\n')}`)
  process.exit(1)
}
console.log('verify-docs: OK (bilingual pairs, locale parity, version+DSH matrix both languages, license-notices, all markdown links)')
