#!/usr/bin/env node
// Assemble the release asset set from one `pnpm pack` tarball:
//   bululuburuarua666-dsh-plugin-manager-<v>.tgz  (copied verbatim)
//   dsh-plugin-manager-<v>.zip                    (tgz + INSTALL.md + INSTALL.zh.md
//                                                  + SHA256SUMS.txt + compatibility.json)
//   SHA256SUMS.txt                                (SHA-256 over the tgz)
// Cross-platform: the ZIP is written by the dependency-free writer in
// ./zip.mjs (real ZIP magic, STORE/deflate), never by `tar -a` (GNU tar
// would emit a POSIX tar named .zip). The version comes from package.json.
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipStore } from './zip.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function dirname(p) { return p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))) }

const usage = 'usage: node scripts/create-release-assets.mjs <dist-dir>'
const distDir = process.argv[2]
if (distDir === undefined) {
  console.error(usage)
  process.exit(1)
}
const dist = resolve(ROOT, distDir)
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const VERSION = PKG.version
const compatibility = JSON.parse(readFileSync(join(ROOT, 'compatibility.json'), 'utf8'))
if (compatibility.pluginVersion !== VERSION) {
  console.error(`create-release-assets: compatibility.json says ${compatibility.pluginVersion}, package.json says ${VERSION} — fix the drift first`)
  process.exit(1)
}

const tarballs = readdirSync(dist).filter(name => name.endsWith('.tgz'))
if (tarballs.length !== 1) {
  console.error(`create-release-assets: expected exactly one tgz in ${distDir}, found ${tarballs.length}`)
  process.exit(1)
}
const tgzName = tarballs[0]
if (tgzName !== `bululuburuarua666-dsh-plugin-manager-${VERSION}.tgz`) {
  console.error(`create-release-assets: tarball ${tgzName} does not match version ${VERSION}`)
  process.exit(1)
}
const tgzPath = join(dist, tgzName)
const zipName = `dsh-plugin-manager-${VERSION}.zip`
const zipPath = join(dist, zipName)

// SHA-256 over the install tarball.
const digest = createHash('sha256').update(readFileSync(tgzPath)).digest('hex')
const sums = `${digest}  ${tgzName}\n`
const sumsPath = join(dist, 'SHA256SUMS.txt')
writeFileSync(sumsPath, sums, 'utf8')

// Stage the zip payload: tgz + install docs + checksums + compatibility.
const stage = join(dist, '.zip-stage')
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
copyFileSync(tgzPath, join(stage, tgzName))
copyFileSync(sumsPath, join(stage, 'SHA256SUMS.txt'))
for (const doc of ['INSTALL.md', 'INSTALL.zh.md']) {
  const from = join(ROOT, 'docs', doc)
  try {
    statSync(from)
    copyFileSync(from, join(stage, doc))
  } catch {
    console.error(`create-release-assets: missing ${doc} under docs/ (T08 owns the install docs)`)
    process.exit(1)
  }
}
copyFileSync(join(ROOT, 'compatibility.json'), join(stage, 'compatibility.json'))

// Write a REAL zip through the dependency-free writer (magic + CRC valid on
// every platform; unzip-compatible).
rmSync(zipPath, { force: true })
writeFileSync(zipPath, zipStore([
  { name: tgzName, data: readFileSync(join(stage, tgzName)) },
  { name: 'SHA256SUMS.txt', data: readFileSync(join(stage, 'SHA256SUMS.txt')) },
  { name: 'compatibility.json', data: readFileSync(join(stage, 'compatibility.json')) },
  { name: 'INSTALL.md', data: readFileSync(join(stage, 'INSTALL.md')) },
  { name: 'INSTALL.zh.md', data: readFileSync(join(stage, 'INSTALL.zh.md')) },
]))
rmSync(stage, { recursive: true, force: true })

const finalDigest = createHash('sha256').update(readFileSync(tgzPath)).digest('hex')
if (finalDigest !== digest) {
  console.error('create-release-assets: tgz changed during assembly')
  process.exit(1)
}
console.log(`assets: ${tgzName} (${statSync(tgzPath).size}B) + ${zipName} + SHA256SUMS.txt (digest ${digest.slice(0, 16)})`)
