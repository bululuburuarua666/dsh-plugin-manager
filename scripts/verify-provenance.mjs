#!/usr/bin/env node
// Provenance gate: verify (default) or regenerate (--write) provenance.json so
// every file under imported/ is classified and every entry exists on disk.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const IMPORTED = join(ROOT, 'imported')
const SOURCE_COMMIT = 'c25f5299eb79a42f15910ae27e1ac1413ea6a7b0+worktree'
const UPSTREAM_BASE = 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e'
const COPYRIGHT = 'bululuburuarua666'

function dirname(p) { return p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))) }

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

/** Category rules for one path relative to imported/. */
function classify(rel) {
  // The lifecycle host package was written from scratch for this project.
  if (rel.startsWith('host-plugin-lifecycle/')) return { category: 'original' }
  // Origin classification additions: new files, no upstream counterpart.
  if (rel === 'host-plugin-inventory/src/origin.ts') return { category: 'original' }
  if (rel === 'host-plugin-inventory/src/install-source.ts') return { category: 'original' }
  if (rel === 'host-plugin-inventory/tests/origin.spec.ts') return { category: 'original' }
  // Everything else modifies files that exist in upstream 0.1.1-rc.2.
  return { category: 'modified-upstream', upstreamBase: UPSTREAM_BASE }
}

function build() {
  return walk(IMPORTED).map((full) => {
    const rel = relative(IMPORTED, full).replaceAll('\\', '/')
    const meta = classify(rel)
    return {
      path: `imported/${rel}`,
      category: meta.category,
      sourceCommit: SOURCE_COMMIT,
      upstreamBase: meta.upstreamBase ?? null,
      sourcePath: upstreamPathOf(rel),
      copyright: COPYRIGHT,
      license: 'MIT',
    }
  }).sort((a, b) => a.path.localeCompare(b.path))
}

/** Original DSH monorepo path each file was taken from. */
function upstreamPathOf(rel) {
  return rel
    .replace('host-plugin-lifecycle/', 'packages/host/plugin-lifecycle/')
    .replace('host-plugin-inventory/', 'packages/host/plugin-inventory/')
    .replace('client-ui-settings-plugin-inventory/', 'packages/client/ui-settings-plugin-inventory/')
}

const expected = build()
const provenancePath = join(ROOT, 'provenance.json')
const write = process.argv.includes('--write')
if (write) {
  writeFileSync(provenancePath, `${JSON.stringify({ sourceCommit: SOURCE_COMMIT, upstreamBase: UPSTREAM_BASE, copyright: COPYRIGHT, files: expected }, null, 2)}\n`)
  console.log(`provenance.json written: ${expected.length} entries`)
} else {
  let actual
  try { actual = JSON.parse(readFileSync(provenancePath, 'utf8')).files } catch { fail('provenance.json missing or unparsable') }
  const expectedByPath = new Map(expected.map((e) => [e.path, e]))
  const actualByPath = new Map(actual.map((e) => [e.path, e]))
  const problems = []
  for (const [path, entry] of expectedByPath) {
    if (!actualByPath.has(path)) problems.push(`missing entry: ${path}`)
    else {
      const a = actualByPath.get(path)
      for (const field of ['category', 'upstreamBase', 'copyright', 'license']) {
        if (a[field] !== entry[field]) problems.push(`${path}: ${field} ${JSON.stringify(a[field])} != expected ${JSON.stringify(entry[field])}`)
      }
    }
  }
  for (const path of actualByPath.keys()) {
    if (!expectedByPath.has(path)) problems.push(`stale entry (no file on disk): ${path}`)
  }
  if (problems.length) { fail(problems.join('\n')) }
  console.log(`provenance OK: ${actual.length} entries, all files classified`)
}

function fail(message) {
  console.error(`verify-provenance: FAIL\n${message}`)
  process.exit(1)
}
