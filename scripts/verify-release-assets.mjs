#!/usr/bin/env node
// Verify one release asset set by unpacking the ZIP and comparing every
// payload member byte-for-byte against the repository sources:
//   - inner tgz digest === outer tgz digest === SHA256SUMS record
//   - inner SHA256SUMS === outer SHA256SUMS
//   - inner compatibility.json === repository compatibility.json
//   - inner INSTALL.md / INSTALL.zh.md === repository docs
//   - exactly five top-level entries, nothing extra
// Cross-platform: uses bsdtar (tar) for listing and extraction, available on
// Windows 10+, Linux, and macOS. The SBOM joins at T10.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function dirname(p) { return p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))) }

const usage = 'usage: node scripts/verify-release-assets.mjs <dist-dir>'
const distDir = process.argv[2]
if (distDir === undefined) {
  console.error(usage)
  process.exit(1)
}

const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const VERSION = PKG.version
const dist = resolve(ROOT, distDir)
const problems = []
const mustExist = (path, label) => {
  if (!existsSync(path)) { problems.push(`missing asset: ${label}`); return false }
  return true
}

const outerTgz = join(dist, `bululuburuarua666-dsh-plugin-manager-${VERSION}.tgz`)
const zipPath = join(dist, `dsh-plugin-manager-${VERSION}.zip`)
const outerSums = join(dist, 'SHA256SUMS.txt')
mustExist(outerTgz, 'release tgz')
mustExist(zipPath, 'release zip')
mustExist(outerSums, 'SHA256SUMS.txt')

// The version triple must agree: package.json, tarball name, compatibility.
const compatibility = JSON.parse(readFileSync(join(ROOT, 'compatibility.json'), 'utf8'))
if (compatibility.pluginVersion !== VERSION) problems.push(`compatibility.json version ${compatibility.pluginVersion} != package.json ${VERSION}`)

if (problems.length === 0) {
  const outerDigest = createHash('sha256').update(readFileSync(outerTgz)).digest('hex')
  const outerSumsText = readFileSync(outerSums, 'utf8')
  const recordedLine = outerSumsText.trim().split(/\r?\n/).find(line => line.endsWith('.tgz'))
  if (recordedLine === undefined) problems.push('SHA256SUMS.txt records no tgz line')
  else {
    const recorded = recordedLine.trim().split(/\s+/)[0]
    if (recorded !== outerDigest) problems.push(`SHA256 mismatch: sums say ${recorded}, tgz is ${outerDigest}`)
  }

  // Unpack the zip with bsdtar and audit every member.
  const stage = mkdtempSync(join(tmpdir(), 'verify-assets-'))
  try {
    execFileSync('tar', ['-xf', zipPath, '-C', stage])
    const listing = execFileSync('tar', ['-tf', zipPath], { encoding: 'utf8' })
      .split(/\r?\n/).map(name => name.trim()).filter(name => name.length > 0)
    const tops = listing.map(name => name.split('/')[0]).filter(name => name.length > 0)
    const uniqueTops = [...new Set(tops)]
    const expected = new Set([
      `bululuburuarua666-dsh-plugin-manager-${VERSION}.tgz`,
      'SHA256SUMS.txt', 'compatibility.json', 'INSTALL.md', 'INSTALL.zh.md',
    ])
    if (uniqueTops.length !== 5) problems.push(`zip has ${uniqueTops.length} top-level entries (${uniqueTops.join(', ')}), expected exactly 5`)
    for (const top of uniqueTops) {
      if (!expected.has(top)) problems.push(`zip carries an unexpected entry: ${top}`)
    }
    for (const need of expected) {
      if (!uniqueTops.includes(need)) problems.push(`zip misses ${need}`)
    }

    // Byte-level comparisons (normalize trailing newlines only).
    const read = (path) => readFileSync(path)
    const norm = (buffer) => buffer.toString('utf8').replace(/\r\n/g, '\n').replace(/\n$/, '')
    const innerTgz = join(stage, `bululuburuarua666-dsh-plugin-manager-${VERSION}.tgz`)
    if (existsSync(innerTgz)) {
      const innerDigest = createHash('sha256').update(read(innerTgz)).digest('hex')
      if (innerDigest !== outerDigest) problems.push(`zip's inner tgz digest ${innerDigest.slice(0, 12)} != released ${outerDigest.slice(0, 12)}`)
    }
    const innerSums = join(stage, 'SHA256SUMS.txt')
    if (existsSync(innerSums) && norm(read(innerSums)) !== norm(read(outerSums))) problems.push('zip SHA256SUMS differs from the released copy')
    const innerCompat = join(stage, 'compatibility.json')
    if (existsSync(innerCompat) && norm(read(innerCompat)) !== norm(read(join(ROOT, 'compatibility.json')))) problems.push('zip compatibility.json differs from the repository copy')
    const innerInstall = join(stage, 'INSTALL.md')
    if (existsSync(innerInstall) && norm(read(innerInstall)) !== norm(read(join(ROOT, 'docs', 'INSTALL.md')))) problems.push('zip INSTALL.md differs from docs/INSTALL.md')
    const innerInstallZh = join(stage, 'INSTALL.zh.md')
    if (existsSync(innerInstallZh) && norm(read(innerInstallZh)) !== norm(read(join(ROOT, 'docs', 'INSTALL.zh.md')))) problems.push('zip INSTALL.zh.md differs from docs/INSTALL.zh.md')
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

const sbomPresent = existsSync(join(dist, `dsh-plugin-manager-${VERSION}.cdx.json`))
if (problems.length > 0) {
  console.error(`verify-release-assets: FAIL\n${problems.join('\n')}`)
  process.exit(1)
}
console.log(`verify-release-assets: OK (zip payload byte-verified, version ${VERSION} consistent${sbomPresent ? ', sbom present' : ', sbom pending T10'})`)
