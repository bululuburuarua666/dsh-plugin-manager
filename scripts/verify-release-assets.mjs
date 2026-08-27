#!/usr/bin/env node
// Verify one release asset set with an INDEPENDENT ZIP reader (./zip.mjs —
// its own central-directory parser + CRC check; never the tool that wrote
// the archive, never `tar` self-certification). Checks:
//   - the zip has real ZIP magic and parses cleanly (a tar named .zip fails)
//   - exactly five members, nothing extra
//   - inner tgz digest === outer tgz digest === SHA256SUMS record
//   - inner SHA256SUMS/compatibility/INSTALL docs byte-equal the repo copies
// The SBOM joins at T10.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipLoad } from './zip.mjs'

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

const tgzName = `bululuburuarua666-dsh-plugin-manager-${VERSION}.tgz`
const outerTgz = join(dist, tgzName)
const zipPath = join(dist, `dsh-plugin-manager-${VERSION}.zip`)
const outerSums = join(dist, 'SHA256SUMS.txt')
mustExist(outerTgz, 'release tgz')
mustExist(zipPath, 'release zip')
mustExist(outerSums, 'SHA256SUMS.txt')

// The version triple must agree: package.json, tarball name, compatibility.
const compatibility = JSON.parse(readFileSync(join(ROOT, 'compatibility.json'), 'utf8'))
if (compatibility.pluginVersion !== VERSION) problems.push(`compatibility.json version ${compatibility.pluginVersion} != package.json ${VERSION}`)

let digest = ''
if (problems.length === 0) {
  digest = createHash('sha256').update(readFileSync(outerTgz)).digest('hex')
  const outerSumsText = readFileSync(outerSums, 'utf8')
  const recordedLine = outerSumsText.trim().split(/\r?\n/).find(line => line.endsWith('.tgz'))
  if (recordedLine === undefined) problems.push('SHA256SUMS.txt records no tgz line')
  else {
    const recorded = recordedLine.trim().split(/\s+/)[0]
    if (recorded !== digest) problems.push(`SHA256 mismatch: sums say ${recorded}, tgz is ${digest}`)
  }

  // Parse the zip with the independent reader: wrong magic or a tar named
  // .zip throws here, before any member comparison runs.
  let members
  try {
    members = zipLoad(readFileSync(zipPath))
  } catch (error) {
    problems.push(`zip rejected by the independent parser: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (members !== undefined) {
    const names = members.map(member => member.name)
    const expected = [tgzName, 'SHA256SUMS.txt', 'compatibility.json', 'INSTALL.md', 'INSTALL.zh.md']
    if (names.length !== 5) problems.push(`zip has ${names.length} members, expected exactly 5`)
    for (const name of names) {
      if (!expected.includes(name)) problems.push(`zip carries an unexpected member: ${name}`)
    }
    const by = (name) => members.find(member => member.name === name)?.data
    const norm = (buffer) => buffer.toString('utf8').replace(/\r\n/g, '\n').replace(/\n$/, '')
    const innerTgz = by(tgzName)
    if (innerTgz !== undefined) {
      const innerDigest = createHash('sha256').update(innerTgz).digest('hex')
      if (innerDigest !== digest) problems.push(`zip's inner tgz digest ${innerDigest.slice(0, 12)} != released ${digest.slice(0, 12)}`)
    } else problems.push(`zip misses ${tgzName}`)
    if (by('SHA256SUMS.txt') !== undefined && norm(by('SHA256SUMS.txt')) !== norm(readFileSync(outerSums))) problems.push('zip SHA256SUMS differs from the released copy')
    if (by('compatibility.json') !== undefined && norm(by('compatibility.json')) !== norm(readFileSync(join(ROOT, 'compatibility.json')))) problems.push('zip compatibility.json differs from the repository copy')
    if (by('INSTALL.md') !== undefined && norm(by('INSTALL.md')) !== norm(readFileSync(join(ROOT, 'docs', 'INSTALL.md')))) problems.push('zip INSTALL.md differs from docs/INSTALL.md')
    if (by('INSTALL.zh.md') !== undefined && norm(by('INSTALL.zh.md')) !== norm(readFileSync(join(ROOT, 'docs', 'INSTALL.zh.md')))) problems.push('zip INSTALL.zh.md differs from docs/INSTALL.zh.md')
  }
}

const sbomPresent = existsSync(join(dist, `dsh-plugin-manager-${VERSION}.cdx.json`))
if (problems.length > 0) {
  console.error(`verify-release-assets: FAIL\n${problems.join('\n')}`)
  process.exit(1)
}
const sbomNote = sbomPresent ? ', sbom present' : ', sbom pending T10'
const digestHead = digest.slice(0, 16)
console.log('verify-release-assets: OK (independent zip parser accepted the archive, tgz digest ' + digestHead + sbomNote + ')')
