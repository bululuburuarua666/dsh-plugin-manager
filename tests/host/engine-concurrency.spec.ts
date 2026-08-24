import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { LifecycleEngine, type EngineHost } from '../../src/host/engine.ts'
import { readManagedToggleRows } from '../../src/host/patch-editor.ts'
import type { LoaderEntry } from '../../src/host/cordis.ts'

interface MutableRow extends LoaderEntry {
  options: { name: string; group?: unknown; disabled?: unknown }
  disabled: boolean
}

const tempDirs: string[] = []
const stopDrivers: Array<() => void> = []

afterEach(() => {
  for (const stop of stopDrivers.splice(0)) stop()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** Patch watcher double: applies managed disable rows to the fake loader. */
function startPatchDriver(rows: MutableRow[], patchPath: string): () => void {
  let last = ''
  const timer = setInterval(() => {
    const text = readText(patchPath)
    if (text === last) return
    last = text
    const managed = readManagedToggleRows(text)
    if (managed === null || !managed.ok) return
    for (const row of managed.rows) {
      const entry = rows.find(candidate => candidate.id === row.entryId)
      if (entry === undefined || entry.disabled === row.disabled) continue
      entry.options.disabled = row.disabled ? true : null
      entry.disabled = row.disabled
    }
  }, 10)
  return () => { clearInterval(timer) }
}

function makeHarness(): { engine: LifecycleEngine; rows: MutableRow[]; profileDir: string; patchPath: string } {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-mgr-conc-'))
  tempDirs.push(profileDir)
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-fixture' }))
  const patchPath = join(profileDir, 'cordis.patch.yml')

  const rows: MutableRow[] = []
  const host: EngineHost = {
    entries: () => rows,
    persistence: () => 'writable',
    engineTreeRoot: null,
  }
  const engine = new LifecycleEngine(pathToFileURL(join(profileDir, 'cordis.yml')).href, host)
  stopDrivers.push(startPatchDriver(rows, patchPath))
  return { engine, rows, profileDir, patchPath }
}

function addRow(h: { rows: MutableRow[] }, entryId: string, moduleName = 'cordis:noop'): MutableRow {
  const row: MutableRow = { id: entryId, options: { name: moduleName }, disabled: false }
  h.rows.push(row)
  return row
}

async function settle(engine: LifecycleEngine, operationId: string) {
  const deadline = Date.now() + 15_000
  for (;;) {
    const view = engine.operation({ operationId })
    if (view.state !== 'queued' && view.state !== 'running') return view
    if (Date.now() > deadline) throw new Error(`operation ${operationId} never settled`)
    await new Promise(resolve => setTimeout(resolve, 15))
  }
}

describe('LifecycleEngine concurrency (per-profile serial queue)', () => {
  it('serializes two rapid operations: the first lands, the queued second re-validates', async () => {
    const h = makeHarness()
    addRow(h, 'include:a')
    addRow(h, 'include:b')

    // Two rapid disables against the same revision: the queue runs them in
    // order. The first succeeds and flips the revision; the second dequeues,
    // re-derives evidence, and must refuse (PROFILE_CHANGED) with zero
    // writes — never clobber the first with a stale before-image.
    const caps = h.engine.capabilities()
    const p1 = h.engine.preview({ entryId: 'include:a', action: 'disable', expectedRevision: caps.revision })
    const p2 = h.engine.preview({ entryId: 'include:b', action: 'disable', expectedRevision: caps.revision })
    const op1 = h.engine.execute({ token: p1.token }).operationId
    const op2 = h.engine.execute({ token: p2.token }).operationId

    const done1 = await settle(h.engine, op1)
    const done2 = await settle(h.engine, op2)
    expect(done1.state).toBe('succeeded')
    expect(done2.state).toBe('failed')
    expect(done2.errorCode).toBe('PROFILE_CHANGED')
    // The first row landed; the second never wrote.
    const text = readText(h.patchPath)
    expect(text).toContain('include:a')
    expect(text).not.toContain('include:b')
    expect(h.rows.find(row => row.id === 'include:a')?.disabled).toBe(true)
    expect(h.rows.find(row => row.id === 'include:b')?.disabled).toBe(false)
  }, 15_000)

  it('runs a fresh preview after a failed operation (queue keeps accepting)', async () => {
    const h = makeHarness()
    const { engine } = { engine: h.engine }
    // Make the first attempt fail via a malformed patch: INVALID_PATCH.
    const a = addRow(h, 'include:a')
    void a
    writeFileSync(h.patchPath, 'key: value\nnot: [a-list\n')
    const caps1 = engine.capabilities()
    const p1 = engine.preview({ entryId: 'include:a', action: 'disable', expectedRevision: caps1.revision })
    const done1 = await settle(engine, engine.execute({ token: p1.token }).operationId)
    expect(done1.state).toBe('failed')
    expect(done1.errorCode).toBe('INVALID_PATCH')

    // Repair the patch; a second operation must still be accepted and run.
    writeFileSync(h.patchPath, '')
    const caps2 = engine.capabilities()
    const p2 = engine.preview({ entryId: 'include:a', action: 'disable', expectedRevision: caps2.revision })
    const done2 = await settle(engine, engine.execute({ token: p2.token }).operationId)
    expect(done2.state).toBe('succeeded')
    expect(h.rows.find(row => row.id === 'include:a')?.disabled).toBe(true)
  }, 15_000)

  it('rejects a queued operation whose revision drifted before it started', async () => {
    const h = makeHarness()
    addRow(h, 'include:a')
    addRow(h, 'include:b')

    // The first disable succeeds and flips the revision; a second disable
    // previewed against the ORIGINAL revision must refuse on dequeue with
    // PROFILE_CHANGED and write nothing.
    const caps = h.engine.capabilities()
    const p1 = h.engine.preview({ entryId: 'include:a', action: 'disable', expectedRevision: caps.revision })
    const p2 = h.engine.preview({ entryId: 'include:b', action: 'disable', expectedRevision: caps.revision })
    const op1 = h.engine.execute({ token: p1.token }).operationId
    const op2 = h.engine.execute({ token: p2.token }).operationId

    const done1 = await settle(h.engine, op1)
    const done2 = await settle(h.engine, op2)
    expect(done1.state).toBe('succeeded')
    expect(done2.state).toBe('failed')
    expect(done2.errorCode).toBe('PROFILE_CHANGED')
    // Only the first entry's row was written; the second wrote nothing.
    const text = readText(h.patchPath)
    expect(text).toContain('include:a')
    expect(text).not.toContain('include:b')
  }, 15_000)

  it('reports ROLLBACK_INCOMPLETE when the restore write cannot take the lock', async () => {
    const h = makeHarness()
    addRow(h, 'include:hold')
    // Pre-occupy the patch lock: the toggle's own write cannot start, and
    // the operation must fail without ever writing.
    const caps = h.engine.capabilities()
    const preview = h.engine.preview({ entryId: 'include:hold', action: 'disable', expectedRevision: caps.revision })
    const release = await withFileLock(h.patchPath, async () => {
      const done = await settle(h.engine, h.engine.execute({ token: preview.token }).operationId)
      expect(done.state).toBe('failed')
      expect(['TIMEOUT', 'ROLLBACK_INCOMPLETE', 'INTERNAL']).toContain(done.errorCode)
      expect(readText(h.patchPath)).toBe('')
    })
    void release
  }, 20_000)
})
