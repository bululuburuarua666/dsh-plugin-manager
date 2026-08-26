#!/usr/bin/env node
// Assemble the release asset set from one `pnpm pack` tarball:
//   <name>-<version>.tgz          (copied verbatim, the install artifact)
//   <name>-<version>.zip          (tgz + INSTALL.md + INSTALL.zh.md + SHA256SUMS.txt + compatibility.json)
//   SHA256SUMS.txt                (SHA-256 over the tgz, at zip top level too)
// Nothing mutates the tarball; the zip is a fresh staging build.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function dirname(p) { return p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))) }

const usage = 'usage: node scripts/create-release-assets.mjs <dist-dir> <version>'
const distDir = process.argv[2]
const version = process.argv[3]
if (distDir === undefined || version === undefined) {
  console.error(usage)
  process.exit(1)
}

const dist = resolve(ROOT, distDir)
const tarballs = execFileSync('cmd', ['/c', 'dir', '/b', '*.tgz'], { cwd: dist, encoding: 'utf8' })
  .split(/\r?\n/).filter(name => name.endsWith('.tgz'))
if (tarballs.length !== 1) {
  console.error(`create-release-assets: expected exactly one tgz in ${distDir}, found ${tarballs.length}`)
  process.exit(1)
}
const tgzName = tarballs[0]
if (!tgzName.includes(version)) {
  console.error(`create-release-assets: tarball ${tgzName} does not mention version ${version}`)
  process.exit(1)
}
const tgzPath = join(dist, tgzName)
const expectedName = `dsh-plugin-manager-${version}`
const zipName = `${expectedName}.zip`
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

// Zip via PowerShell Compress-Archive (deterministic enough for a staging
// payload; the tgz inside is the install artifact and carries its own hash).
rmSync(zipPath, { force: true })
execFileSync('powershell', ['-NoProfile', '-Command',
  `Compress-Archive -Path "${join(stage, '*')}" -DestinationPath "${zipPath}" -Force`], { stdio: 'inherit' })
rmSync(stage, { recursive: true, force: true })

const finalDigest = createHash('sha256').update(readFileSync(tgzPath)).digest('hex')
if (finalDigest !== digest) {
  console.error('create-release-assets: tgz changed during assembly')
  process.exit(1)
}
console.log(`assets: ${tgzName} (${statSync(tgzPath).size}B) + ${zipName} + SHA256SUMS.txt (${digest.slice(0, 16)}…)`)
