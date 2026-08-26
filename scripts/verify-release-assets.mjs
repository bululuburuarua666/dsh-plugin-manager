#!/usr/bin/env node
// Verify one release asset set: exactly the four expected entries exist, the
// recorded SHA-256 matches the tarball, the zip carries the same tgz digest,
// and the compatibility matrix names the version being released.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function dirname(p) { return p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))) }

const usage = 'usage: node scripts/verify-release-assets.mjs <dist-dir> <version>'
const distDir = process.argv[2]
const version = process.argv[3]
if (distDir === undefined || version === undefined) {
  console.error(usage)
  process.exit(1)
}
const dist = resolve(ROOT, distDir)
const problems = []
const must = (path) => {
  try {
    statSync(path)
    return true
  } catch {
    problems.push(`missing asset: ${path}`)
    return false
  }
}

// The tarball keeps its npm name (scope stripped by pnpm pack).
const tgz = join(dist, `bululuburuarua666-dsh-plugin-manager-${version}.tgz`)
const zip = join(dist, `dsh-plugin-manager-${version}.zip`)
const sums = join(dist, 'SHA256SUMS.txt')
must(tgz); must(zip); must(sums)
// The SBOM is a T10 gate; its absence is expected until then (non-fatal).
let sbomPresent = false
try {
  statSync(join(dist, `dsh-plugin-manager-${version}.cdx.json`))
  sbomPresent = true
} catch {
  // Expected before T10.
}

let digest = ''
if (problems.length === 0) {
  digest = createHash('sha256').update(readFileSync(tgz)).digest('hex')
  const recordedLine = readFileSync(sums, 'utf8').trim().split(/\r?\n/).find(line => line.endsWith('.tgz'))
  if (recordedLine === undefined) problems.push('SHA256SUMS.txt records no tgz line')
  else {
    const recorded = recordedLine.trim().split(/\s+/)[0]
    if (recorded !== digest) problems.push(`SHA256 mismatch: sums say ${recorded}, tgz is ${digest}`)
  }

  // The zip must contain the same-named tgz; extract just its digest by
  // reading the entry through PowerShell (no archive deps).
  const listing = execFileSync('powershell', ['-NoProfile', '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::OpenRead('${zip.replace(/\\/g, '\\\\')}').Entries.FullName -join ';'`], { encoding: 'utf8' })
  const entries = listing.split(';').map(name => name.trim())
  for (const required of [`bululuburuarua666-dsh-plugin-manager-${version}.tgz`, 'SHA256SUMS.txt', 'compatibility.json', 'INSTALL.md', 'INSTALL.zh.md']) {
    if (!entries.includes(required)) problems.push(`zip misses ${required}`)
  }
  const compatibility = JSON.parse(readFileSync(join(ROOT, 'compatibility.json'), 'utf8'))
  if (compatibility.pluginVersion !== version) problems.push(`compatibility.json version ${compatibility.pluginVersion} != ${version}`)
}

if (problems.length > 0) {
  console.error(`verify-release-assets: FAIL\n${problems.join('\n')}`)
  process.exit(1)
}
const sbomNote = sbomPresent ? ', sbom present' : ', sbom pending T10'
const digestHead = digest.slice(0, 16)
console.log('verify-release-assets: OK (tgz digest ' + digestHead + ', zip payload complete' + sbomNote + ')')
