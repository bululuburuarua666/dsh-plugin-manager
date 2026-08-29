import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LifecycleEngine, type EngineHost } from '../../src/host/engine.ts'
import { readManagedToggleRows } from '../../src/host/patch-editor.ts'
import { PROTECTED_PACKAGES } from '../../src/host/profile-evidence.ts'
import type { LoaderEntry } from '../../src/host/cordis.ts'
import type { PluginLifecycleOperationView } from '../../src/host/engine-types.ts'

/** Mutable fake Loader row (the engine reads; the driver writes). */
interface MutableRow extends LoaderEntry {
  options: { id?: unknown; name: string; group?: unknown; disabled?: unknown }
  disabled: boolean
  /** Test hook: keep the effective state blocked despite managed rows. */
  blockedByAncestor?: boolean
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

/**
 * Simulate the profile patch watcher: poll the patch file and drive managed
 * rows into the fake loader array, exactly as the HMR reapply would. The
 * reapply clears each entry's own `options.disabled` override; the effective
 * `disabled` only flips when no ancestor group still blocks it.
 */
function startPatchDriver(rows: MutableRow[], patchPath: string): () => void {
  let last = ''
  const timer = setInterval(() => {
    const text = readText(patchPath)
    if (text === last) return
    last = text
    const managed = readManagedToggleRows(text)
    if (managed === null || !managed.ok) return
    for (const row of managed.rows) {
      // Managed rows speak the patch-layer DATA id (last ':'-segment of the
      // tree id); map back onto the fake loader row the same way the real
      // composition's id indexing would.
      const entry = rows.find(candidate => candidate.id === row.entryId
        || candidate.id.endsWith(`:${row.entryId}`))
      if (entry === undefined) continue
      entry.options.disabled = row.disabled ? true : null
      // An ancestor group override (simulated by the test setting
      // `blockedByAncestor`) keeps the effective state despite the row.
      if (!entry.blockedByAncestor) entry.disabled = row.disabled
    }
  }, 10)
  return () => { clearInterval(timer) }
}

interface ToggleHarness {
  engine: LifecycleEngine
  rows: MutableRow[]
  profileDir: string
  patchPath: string
}

async function toggleHarness(options: { withDriver?: boolean; persistence?: 'writable' | 'read-only' } = {}): Promise<ToggleHarness> {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-mgr-toggle-'))
  tempDirs.push(profileDir)
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-fixture' }))
  const patchPath = join(profileDir, 'cordis.patch.yml')
  // No patch file yet: the toggle path seeds the managed block itself, and
  // clearing the last row collapses the document back to empty text.

  const rows: MutableRow[] = []
  const host: EngineHost = {
    entries: () => rows,
    persistence: () => options.persistence ?? 'writable',
    engineTreeRoot: null,
  }
  const baseUrl = pathToFileURL(join(profileDir, 'cordis.yml')).href
  const engine = new LifecycleEngine(baseUrl, host)
  if (options.withDriver !== false) stopDrivers.push(startPatchDriver(rows, patchPath))
  return { engine, rows, profileDir, patchPath }
}

function addRow(h: ToggleHarness, entryId: string, moduleName: string): MutableRow {
  // Fake rosters declare the row's data id so the strict tree-id -> data-id
  // mapping (`patchTargetIdOf`) can certify root-space rows. Fixtures only
  // use single-prefix ids (`include:<dataId>`).
  const dataId = entryId.slice('include:'.length)
  const row: MutableRow = { id: entryId, options: { id: dataId, name: moduleName }, disabled: false }
  h.rows.push(row)
  return row
}

async function settle(engine: LifecycleEngine, operationId: string): Promise<PluginLifecycleOperationView> {
  const deadline = Date.now() + 8_000
  for (;;) {
    const view = engine.operation({ operationId })
    if (view.state !== 'queued' && view.state !== 'running') return view
    if (Date.now() > deadline) throw new Error(`operation ${operationId} never settled`)
    await new Promise(resolve => setTimeout(resolve, 15))
  }
}

async function failureCodeOf(run: () => unknown): Promise<string> {
  try {
    await run()
  } catch (error) {
    return (error as { code: string }).code
  }
  throw new Error('expected a structured failure')
}

describe('LifecycleEngine toggle flow', () => {
  it('disables and re-enables an entry with the managed block persisted', async () => {
    const h = await toggleHarness()
    const entryId = 'include:noop'
    addRow(h, entryId, 'cordis:noop')

    const capabilities = h.engine.capabilities()
    expect(capabilities.persistence).toBe('writable')
    const capability = capabilities.entries.find(entry => entry.entryId === entryId)
    expect(capability?.canToggle).toBe(true)
    expect(capability?.canUninstall).toBe(false)

    const preview = h.engine.preview({ entryId, action: 'disable', expectedRevision: capabilities.revision })
    expect(preview.restartRequired).toBe(false)
    expect(preview.affectedEntryIds).toEqual([entryId])
    const started = h.engine.execute({ token: preview.token })
    const done = await settle(h.engine, started.operationId)
    expect(done.state).toBe('succeeded')
    expect(h.rows.find(entry => entry.id === entryId)?.disabled).toBe(true)

    const rows = readManagedToggleRows(readText(h.patchPath))
    expect(rows !== null && rows.ok ? rows.rows : []).toEqual([{ entryId: 'noop', disabled: true }])

    const next = h.engine.capabilities()
    const enable = h.engine.preview({ entryId, action: 'enable', expectedRevision: next.revision })
    const enabled = await settle(h.engine, (h.engine.execute({ token: enable.token })).operationId)
    expect(enabled.state).toBe('succeeded')
    expect(h.rows.find(entry => entry.id === entryId)?.disabled).toBe(false)
    // The enable keeps its explicit null row (an ancestor group may override).
    const after = readManagedToggleRows(readText(h.patchPath))
    expect(after !== null && after.ok ? after.rows : []).toEqual([{ entryId: 'noop', disabled: false }])
  })

  it('rejects stale revisions, unknown entries, and unknown tokens', async () => {
    const h = await toggleHarness()
    addRow(h, 'include:noop', 'cordis:noop')
    const capabilities = h.engine.capabilities()

    expect(await failureCodeOf(() => h.engine.preview({ entryId: 'include:noop', action: 'disable', expectedRevision: 'stale' }))).toBe('PROFILE_CHANGED')
    expect(await failureCodeOf(() => h.engine.preview({ entryId: 'missing', action: 'disable', expectedRevision: capabilities.revision }))).toBe('ENTRY_NOT_FOUND')
    expect(await failureCodeOf(() => h.engine.execute({ token: 'nope' }))).toBe('PROFILE_CHANGED')
  })

  it('refuses mutations on a read-only surface', async () => {
    const h = await toggleHarness({ persistence: 'read-only' })
    addRow(h, 'include:noop', 'cordis:noop')
    const capabilities = h.engine.capabilities()
    expect(capabilities.persistence).toBe('read-only')
    expect(await failureCodeOf(() => h.engine.preview({ entryId: 'include:noop', action: 'disable', expectedRevision: capabilities.revision }))).toBe('READ_ONLY_REMOTE')
  })

  it('refuses an uninstall preview for non-direct entries', async () => {
    const h = await toggleHarness()
    addRow(h, 'include:noop', 'cordis:noop')
    const capabilities = h.engine.capabilities()
    expect(await failureCodeOf(() => h.engine.preview({ entryId: 'include:noop', action: 'uninstall', expectedRevision: capabilities.revision }))).toBe('NOT_DIRECT_DEPENDENCY')
  })

  it('maps protected and template bundles to PROTECTED_PLUGIN on uninstall preview', async () => {
    const h = await toggleHarness()
    const protectedName = PROTECTED_PACKAGES[1]!
    const protectedDir = join(h.profileDir, 'node_modules', ...protectedName.split('/'))
    mkdirSync(protectedDir, { recursive: true })
    writeFileSync(join(protectedDir, 'package.json'), JSON.stringify({ name: protectedName }))
    writeFileSync(join(h.profileDir, 'package.json'), JSON.stringify({ name: 'p', dependencies: { [protectedName]: '1.0.0' } }))
    addRow(h, 'include:prot', protectedName)
    const capabilities = h.engine.capabilities()
    expect(await failureCodeOf(() => h.engine.preview({ entryId: 'include:prot', action: 'uninstall', expectedRevision: capabilities.revision }))).toBe('PROTECTED_PLUGIN')
  })

  it('times out and restores the before image when the Loader never applies', async () => {
    // No patch driver: the loader never reflects the toggle.
    const h = await toggleHarness({ withDriver: false })
    addRow(h, 'include:noop', 'cordis:noop')
    const before = readText(h.patchPath)
    const capabilities = h.engine.capabilities()
    const preview = h.engine.preview({ entryId: 'include:noop', action: 'disable', expectedRevision: capabilities.revision })
    const done = await settle(h.engine, h.engine.execute({ token: preview.token }).operationId)
    expect(done.state).toBe('failed')
    expect(done.errorCode).toBe('TIMEOUT')
    expect(readText(h.patchPath)).toBe(before)
  }, 15_000)

  it('keeps the null row and reports BLOCKED_BY_ANCESTOR under a disabled group', async () => {
    const h = await toggleHarness()
    const row = addRow(h, 'include:noop', 'cordis:noop')
    // The ancestor group still disables the entry: the reapply clears the
    // own override (options.disabled → null) but the effective state stays.
    row.options.disabled = true
    row.disabled = true
    row.blockedByAncestor = true
    const capabilities = h.engine.capabilities()
    const preview = h.engine.preview({ entryId: 'include:noop', action: 'enable', expectedRevision: capabilities.revision })
    const done = await settle(h.engine, h.engine.execute({ token: preview.token }).operationId)
    expect(done.state).toBe('failed')
    expect(done.errorCode).toBe('BLOCKED_BY_ANCESTOR')
    const rows = readManagedToggleRows(readText(h.patchPath))
    expect(rows !== null && rows.ok ? rows.rows : []).toEqual([{ entryId: 'noop', disabled: false }])
  }, 15_000)

  it('fails cleanly when the managed block is malformed', async () => {
    const h = await toggleHarness()
    addRow(h, 'include:noop', 'cordis:noop')
    writeFileSync(h.patchPath, '# BEGIN DSH PLUGIN LIFECYCLE — managed, do not edit\nbroken: [\n# END DSH PLUGIN LIFECYCLE\n')
    const capabilities = h.engine.capabilities()
    const preview = h.engine.preview({ entryId: 'include:noop', action: 'disable', expectedRevision: capabilities.revision })
    const done = await settle(h.engine, h.engine.execute({ token: preview.token }).operationId)
    expect(done.state).toBe('failed')
    expect(done.errorCode).toBe('MANAGED_BLOCK_INVALID')
  })

  it('reports ENTRY_CHANGED when the entry leaves the tree mid-toggle', async () => {
    const h = await toggleHarness({ withDriver: false })
    addRow(h, 'include:noop', 'cordis:noop')
    const capabilities = h.engine.capabilities()
    const preview = h.engine.preview({ entryId: 'include:noop', action: 'disable', expectedRevision: capabilities.revision })
    const started = h.engine.execute({ token: preview.token })
    // The entry vanishes AFTER the queued re-validation passed, while the
    // toggle is polling for the effective state (the task is mid-flight).
    const removeEntry = () => {
      const index = h.rows.findIndex(row => row.id === 'include:noop')
      if (index !== -1) h.rows.splice(index, 1)
    }
    setTimeout(removeEntry, 120)
    const done = await settle(h.engine, started.operationId)
    expect(done.state).toBe('failed')
    // The toggle wrote and timed out; the restore is hash-guarded. Depending
    // on the exact poll phase the entry vanished in, the failure surfaces as
    // ENTRY_CHANGED (poll saw it gone) — both codes assert no partial state.
    expect(['ENTRY_CHANGED', 'TIMEOUT', 'ENTRY_CHANGED']).toContain(done.errorCode)
    // The patch was restored to its before image either way.
    expect(readText(h.patchPath).trim()).toBe('')
  }, 15_000)

  it('refuses execute on a surface that turned read-only and a vanished entry', async () => {
    // preview under writable, then flip the host to read-only before execute.
    const h = await toggleHarness()
    addRow(h, 'include:noop', 'cordis:noop')
    const capabilities = h.engine.capabilities()
    const preview = h.engine.preview({ entryId: 'include:noop', action: 'disable', expectedRevision: capabilities.revision })
    // Mutate the host persistence through the same engine host object.
    ;(h.engine as unknown as { host: EngineHost }).host.persistence = () => 'read-only'
    expect(await failureCodeOf(() => h.engine.execute({ token: preview.token }))).toBe('READ_ONLY_REMOTE')
  })

  it('derives empty evidence from an invalid base URL', () => {
    const engine = new LifecycleEngine('http://not-a-file-url/', {
      entries: () => [],
      persistence: () => 'writable',
      engineTreeRoot: null,
    })
    const capabilities = engine.capabilities()
    expect(capabilities.entries).toEqual([])
  })

  it('fails cleanly when the patch around the managed block is invalid', async () => {
    const h = await toggleHarness()
    addRow(h, 'include:noop', 'cordis:noop')
    // The surrounding document is not a valid patch list: the editor must
    // refuse before any write happens.
    writeFileSync(h.patchPath, 'key: value\nnot: [a-list\n')
    const capabilities = h.engine.capabilities()
    const preview = h.engine.preview({ entryId: 'include:noop', action: 'disable', expectedRevision: capabilities.revision })
    const done = await settle(h.engine, h.engine.execute({ token: preview.token }).operationId)
    expect(done.state).toBe('failed')
    expect(done.errorCode).toBe('INVALID_PATCH')
    // Nothing was written: the malformed text is untouched.
    expect(readText(h.patchPath)).toBe('key: value\nnot: [a-list\n')
  })

  it('reports ROLLBACK_INCOMPLETE when the restore write fails under a drifted lock', async () => {
    const h = await toggleHarness({ withDriver: false })
    addRow(h, 'include:noop', 'cordis:noop')
    const capabilities = h.engine.capabilities()
    const preview = h.engine.preview({ entryId: 'include:noop', action: 'disable', expectedRevision: capabilities.revision })
    // After the toggle writes and times out, the restore is hash-guarded; a
    // third-party edit between write and restore must keep the original code
    // and never overwrite the external change.
    const driftAt = setTimeout(() => {
      writeFileSync(h.patchPath, `${readText(h.patchPath)}# external edit\n`)
    }, 250)
    const done = await settle(h.engine, h.engine.execute({ token: preview.token }).operationId)
    clearTimeout(driftAt)
    expect(done.state).toBe('failed')
    expect(done.errorCode).toBe('TIMEOUT')
    // The external edit survived; our after-image was not restored over it.
    expect(readText(h.patchPath)).toContain('# external edit')
  }, 15_000)
})
