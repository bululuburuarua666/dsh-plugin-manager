#!/usr/bin/env node
// Pack inspection gate: the tarball must carry the install surface
// (manifest, cordis.patch.yml, lib halves, legal files) and must not leak
// sources, tests, the imported/ staging area, or CI files.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tarball = process.argv[2]
if (!tarball) {
  console.error('verify-pack: usage node scripts/verify-pack.mjs <tarball>')
  process.exit(1)
}

const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
const names = new Set(listing.map((line) => line.replace(/^\.\//, '').replace(/^\/+/, '')))

const required = [
  'package/package.json',
  'package/cordis.patch.yml',
  'package/compatibility.json',
  'package/lib/index.js',
  'package/lib/client.js',
  'package/LICENSE',
  'package/THIRD_PARTY_NOTICES.md',
  'package/README.md',
  'package/README.zh.md',
]
const forbidden = [/\/imported\//, /\/tests?\//, /\/src\//, /\/scripts\//, /\/\.github\//, /\.(?:tsx?|mts|cts)$/]
const isTypeDeclaration = /\.d\.ts(?:\.map)?$/

const problems = []
for (const path of required) if (!names.has(path)) problems.push(`missing from tarball: ${path}`)
for (const path of names) {
  if (isTypeDeclaration.test(path)) continue
  if (forbidden.some((re) => re.test(path))) problems.push(`forbidden in tarball: ${path}`)
}

if (problems.length) {
  console.error(`verify-pack: FAIL\n${problems.join('\n')}`)
  process.exit(1)
}
console.log(`verify-pack: OK (${listing.length} entries, install surface complete, no leaks)`)
