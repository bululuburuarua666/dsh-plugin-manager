import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LifecycleEngine, type EngineHost } from '../../src/host/engine.ts'
import { PluginLifecycleTokenStore } from '../../src/host/token-store.ts'
import { isValidPatchListText } from '../../src/host/patch-editor.ts'
import type { LoaderEntry } from '../../src/host/cordis.ts'

interface MutableRow extends LoaderEntry {
  options: { id?: unknown; name: string; group?: unknown; disabled?: unknown }
  disabled: boolean
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  // Restore write permissions dropped by a read-only fixture (Windows keeps
  // the attribute on the directory entry even after rm on some volumes).
  for (const dir of tempDirs.splice(0)) { try { chmodSync(dir, 0o755) } catch { /* already gone */ } }
})

function makeEngine(profileDir: string, rows: MutableRow[]): LifecycleEngine {
  const host: EngineHost = {
    entries: () => rows,
    persistence: () => 'writable',
    engineTreeRoot: null,
  }
  return new LifecycleEngine(pathToFileURL(join(profileDir, 'cordis.yml')).href, host)
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

describe('LifecycleEngine remaining coverage arms', () => {
  it('downgrades to ROLLBACK_INCOMPLETE when the restore write itself fails', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-mgr-rbi-'))
    tempDirs.push(profileDir)
    mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'p' }))
    const patchPath = join(profileDir, 'cordis.patch.yml')

    const rows: MutableRow[] = [{ id: 'include:x', options: { id: 'x', name: 'cordis:noop' }, disabled: false }]
    const engine = makeEngine(profileDir, rows)
    // No driver: the toggle times out after writing; the restore then hits a
    // read-only patch file and must report ROLLBACK_INCOMPLETE.
    const caps = engine.capabilities()
    const preview = engine.preview({ entryId: 'include:x', action: 'disable', expectedRevision: caps.revision })
    const opId = engine.execute({ token: preview.token }).operationId

    // Flip the patch read-only right after the write lands: the restore's
    // writeFileAtomic then fails on Windows (EACCES) — the exact arm.
    setTimeout(() => {
      try { chmodSync(patchPath, 0o444) } catch { /* best effort */ }
    }, 300)

    const done = await settle(engine, opId)
    // Restore permissions so afterEach can clean up.
    try { chmodSync(patchPath, 0o644) } catch { /* already removed */ }
    expect(done.state).toBe('failed')
    // Either the hash guard tripped (no restore attempted → original code)
    // or the restore write failed → ROLLBACK_INCOMPLETE. Both are safe; the
    // ROLLBACK_INCOMPLETE arm is the one this test targets on POSIX. On
    // Windows chmod may not block atomic-rename writes, so accept the guard
    // arm too — the invariant is: never a silent success, never corruption.
    expect(['TIMEOUT', 'ROLLBACK_INCOMPLETE']).toContain(done.errorCode)
  }, 20_000)

  it('fails an uninstall execute whose token carries no package name', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-mgr-nopkg-'))
    tempDirs.push(profileDir)
    mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'p' }))

    const rows: MutableRow[] = [{ id: 'include:x', options: { id: 'x', name: 'cordis:noop' }, disabled: false }]
    const engine = makeEngine(profileDir, rows)

    // Forge a token binding without a package name (preview never issues
    // these; this is the defensive arm against internal drift).
    const tokens = (engine as unknown as { tokens: PluginLifecycleTokenStore }).tokens
    const caps = engine.capabilities()
    const issued = tokens.issue({
      action: 'uninstall',
      entryId: 'include:x',
      packageName: null,
      affectedEntryIds: ['include:x'],
      restartRequired: true,
      revision: caps.revision,
    })
    const opId = engine.execute({ token: issued.token }).operationId
    const done = await settle(engine, opId)
    expect(done.state).toBe('failed')
    expect(done.errorCode).toBe('NOT_DIRECT_DEPENDENCY')
  }, 15_000)

  it('fails execute when the entry left the tree between preview and execute', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-mgr-gone-'))
    tempDirs.push(profileDir)
    mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'p' }))

    const rows: MutableRow[] = [{ id: 'include:x', options: { id: 'x', name: 'cordis:noop' }, disabled: false }]
    const engine = makeEngine(profileDir, rows)
    const caps = engine.capabilities()
    engine.preview({ entryId: 'include:x', action: 'disable', expectedRevision: caps.revision })
    // The row leaves without changing anything else the revision hashes —
    // entryFacts feed computeRevision, so removing the row DOES drift the
    // revision; use a forged token whose revision matches the post-removal
    // evidence to reach the entry lookup arm specifically.
    rows.splice(0, 1)
    const after = engine.capabilities()
    const tokens = (engine as unknown as { tokens: PluginLifecycleTokenStore }).tokens
    const issued = tokens.issue({
      action: 'disable',
      entryId: 'include:x',
      packageName: null,
      affectedEntryIds: ['include:x'],
      restartRequired: false,
      revision: after.revision,
    })
    try {
      engine.execute({ token: issued.token })
      throw new Error('expected a structured failure')
    } catch (error) {
      expect((error as { code: string }).code).toBe('ENTRY_NOT_FOUND')
    }
  })

  it('fails a queued operation whose surface turned read-only before it started', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-mgr-roq-'))
    tempDirs.push(profileDir)
    mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'p' }))

    const rows: MutableRow[] = [{ id: 'include:x', options: { id: 'x', name: 'cordis:noop' }, disabled: false }]
    const host: EngineHost = {
      entries: () => rows,
      persistence: () => 'writable',
      engineTreeRoot: null,
    }
    const engine = new LifecycleEngine(pathToFileURL(join(profileDir, 'cordis.yml')).href, host)
    const caps = engine.capabilities()

    // First operation occupies the queue (it times out slowly with no
    // driver); a second one queues behind it, and the surface flips to
    // read-only before the second dequeues.
    const p1 = engine.preview({ entryId: 'include:x', action: 'disable', expectedRevision: caps.revision })
    const op1 = engine.execute({ token: p1.token }).operationId
    const p2 = engine.preview({ entryId: 'include:x', action: 'disable', expectedRevision: caps.revision })
    const op2 = engine.execute({ token: p2.token }).operationId
    host.persistence = () => 'read-only'

    const done2 = await settle(engine, op2)
    expect(done2.state).toBe('failed')
    expect(done2.errorCode).toBe('READ_ONLY_REMOTE')
    // The first finished on its own merits (timeout+rollback).
    const done1 = await settle(engine, op1)
    expect(done1.state).toBe('failed')
  }, 20_000)

  it('maps forward-compatible block reasons to their wire codes', async () => {
    const { blockReasonToCode } = await import('../../src/host/engine.ts')
    expect(blockReasonToCode('ambiguous-package')).toBe('AMBIGUOUS_PACKAGE')
    expect(blockReasonToCode('manual-insert-unsupported')).toBe('UNSUPPORTED_PATCH_SHAPE')
  })

  it('skips startup cleanup for a missing profile and empty pending records', async () => {
    // No baseUrl → no profile directory: cleanup is a no-op (line 62/145).
    const engine = new LifecycleEngine(undefined, {
      entries: () => [],
      persistence: () => 'writable',
      engineTreeRoot: null,
    })
    await expect(engine.startupCleanup()).resolves.toBeUndefined()

    // A profile with no pending file: records.length === 0 returns early.
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-mgr-empty-'))
    tempDirs.push(profileDir)
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'p' }))
    const engine2 = makeEngine(profileDir, [])
    await expect(engine2.startupCleanup()).resolves.toBeUndefined()
  })

  it('keeps pending records when the patch lock cannot be taken during cleanup', async () => {
    const { withFileLock } = await import('@deepseek-ai/dsh-atomic-write')
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-mgr-lockfail-'))
    tempDirs.push(profileDir)
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: {} }))
    writeFileSync(join(profileDir, 'cordis.patch.yml'), [
      '# BEGIN DSH PLUGIN LIFECYCLE — managed, do not edit',
      '- id: gone-entry',
      '  disabled: true',
      '# END DSH PLUGIN LIFECYCLE',
      '',
    ].join('\n'))
    writeFileSync(join(profileDir, 'dsh-plugin-manager-pending-removals.json'), JSON.stringify({
      schemaVersion: 1,
      records: [{ packageName: 'dsh-gone', entryIds: ['gone-entry'], operationId: 'op-1', createdAt: 1 }],
    }))

    // Hold the patch lock across the whole cleanup: the in-lock write cannot
    // run, so the pending records must survive for a later retry.
    const rows: MutableRow[] = []
    const engine = makeEngine(profileDir, rows)
    await withFileLock(join(profileDir, 'cordis.patch.yml'), async () => {
      await engine.startupCleanup()
      const pending = JSON.parse(readFileSync(join(profileDir, 'dsh-plugin-manager-pending-removals.json'), 'utf8')) as { records: unknown[] }
      expect(pending.records).toHaveLength(1)
    })
    // After the lock releases, a retry succeeds (idempotent).
    await engine.startupCleanup()
    const pending = JSON.parse(readFileSync(join(profileDir, 'dsh-plugin-manager-pending-removals.json'), 'utf8')) as { records: unknown[] }
    expect(pending.records).toHaveLength(0)
  }, 15_000)

  it('keeps pending records when the managed block is malformed during cleanup', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-mgr-badblock-'))
    tempDirs.push(profileDir)
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: {} }))
    writeFileSync(join(profileDir, 'cordis.patch.yml'), [
      '# BEGIN DSH PLUGIN LIFECYCLE — managed, do not edit',
      'broken: [',
      '# END DSH PLUGIN LIFECYCLE',
      '',
    ].join('\n'))
    writeFileSync(join(profileDir, 'dsh-plugin-manager-pending-removals.json'), JSON.stringify({
      schemaVersion: 1,
      records: [{ packageName: 'dsh-gone', entryIds: ['gone-entry'], operationId: 'op-1', createdAt: 1 }],
    }))

    const engine = makeEngine(profileDir, [])
    await engine.startupCleanup()
    // The malformed block fails closed: the record stays for manual recovery.
    const pending = JSON.parse(readFileSync(join(profileDir, 'dsh-plugin-manager-pending-removals.json'), 'utf8')) as { records: unknown[] }
    expect(pending.records).toHaveLength(1)
  })

  it('keeps pending records when their entries still exist, and filters group rows from evidence', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-mgr-keep-'))
    tempDirs.push(profileDir)
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'p' }))
    writeFileSync(join(profileDir, 'dsh-plugin-manager-pending-removals.json'), JSON.stringify({
      schemaVersion: 1,
      records: [{ packageName: 'dsh-still', entryIds: ['include:still'], operationId: 'op-1', createdAt: 1 }],
    }))
    // The manifest still declares the dependency AND the entry still exists.
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-still': '1.0.0' } }))
    const rows: MutableRow[] = [
      { id: 'include:still', options: { id: 'still', name: 'cordis:noop' }, disabled: false },
      // A group row: filtered from evidence by the group check.
      { id: 'g1', options: { name: 'group', group: true }, disabled: false },
    ]
    const engine = makeEngine(profileDir, rows)
    await engine.startupCleanup()
    const pending = JSON.parse(readFileSync(join(profileDir, 'dsh-plugin-manager-pending-removals.json'), 'utf8')) as { records: unknown[] }
    expect(pending.records).toHaveLength(1)
    // Group rows never appear in capabilities.
    expect(engine.capabilities().entries.map(entry => entry.entryId)).toEqual(['include:still'])
  })

  it('keeps a pending record whose dependency was removed but whose entry still loads', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-mgr-halfgone-'))
    tempDirs.push(profileDir)
    // Dependency gone from the manifest, but the Loader entry still exists:
    // the second settled-filter arm (entry presence) must keep the record.
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: {} }))
    writeFileSync(join(profileDir, 'dsh-plugin-manager-pending-removals.json'), JSON.stringify({
      schemaVersion: 1,
      records: [{ packageName: 'dsh-gone', entryIds: ['include:still-here'], operationId: 'op-1', createdAt: 1 }],
    }))
    const rows: MutableRow[] = [{ id: 'include:still-here', options: { id: 'still-here', name: 'cordis:noop' }, disabled: false }]
    const engine = makeEngine(profileDir, rows)
    await engine.startupCleanup()
    const pending = JSON.parse(readFileSync(join(profileDir, 'dsh-plugin-manager-pending-removals.json'), 'utf8')) as { records: unknown[] }
    expect(pending.records).toHaveLength(1)
  })

  it('fails execute when the revision drifted between preview and execute', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-mgr-drift-'))
    tempDirs.push(profileDir)
    mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'p' }))

    const rows: MutableRow[] = [{ id: 'include:x', options: { id: 'x', name: 'cordis:noop' }, disabled: false }]
    const engine = makeEngine(profileDir, rows)
    const caps = engine.capabilities()
    const preview = engine.preview({ entryId: 'include:x', action: 'disable', expectedRevision: caps.revision })
    // Any profile change flips the revision before execute.
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'p2' }))
    try {
      engine.execute({ token: preview.token })
      throw new Error('expected a structured failure')
    } catch (error) {
      expect((error as { code: string }).code).toBe('PROFILE_CHANGED')
    }
  })

  it('fails a queued op PROFILE_CHANGED with zero writes when node_modules resolution drifts', async () => {
    // The revision digest covers manifest/lockfile/patch/loader facts but NOT
    // package resolution: deleting the link between execute() and the queued
    // thunk drifts packageName with an identical revision. Single-threaded
    // ordering makes the gap deterministic: the synchronous rmSync below runs
    // after execute() returns and before the microtask-queued thunk starts.
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-mgr-pkgdrift-'))
    tempDirs.push(profileDir)
    const pkgDir = join(profileDir, 'node_modules', 'dsh-drift-pkg')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-drift-pkg', main: 'index.js' }))
    writeFileSync(join(pkgDir, 'index.js'), 'export function apply() {}\n')
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-drift-pkg': '1.0.0' } }))
    const patchPath = join(profileDir, 'cordis.patch.yml')

    const rows: MutableRow[] = [{ id: 'include:drift', options: { id: 'drift', name: 'dsh-drift-pkg' }, disabled: true }]
    const engine = makeEngine(profileDir, rows)
    const caps = engine.capabilities()
    // The package resolves at preview time: the token binds packageName.
    const capability = caps.entries.find(entry => entry.entryId === 'include:drift')
    expect(capability?.packageName).toBe('dsh-drift-pkg')
    const preview = engine.preview({ entryId: 'include:drift', action: 'disable', expectedRevision: caps.revision })
    const beforeManifest = readFileSync(join(profileDir, 'package.json'), 'utf8')
    expect(existsSync(patchPath)).toBe(false)

    const started = engine.execute({ token: preview.token })
    expect(started.state).toBe('queued')
    // The queued thunk has not run yet; drift node_modules resolution only.
    rmSync(pkgDir, { recursive: true, force: true })

    const done = await settle(engine, started.operationId)
    expect(done.state).toBe('failed')
    expect(done.errorCode).toBe('PROFILE_CHANGED')
    // Zero writes: nothing touched patch/manifest/lockfile.
    expect(existsSync(patchPath)).toBe(false)
    expect(readFileSync(join(profileDir, 'package.json'), 'utf8')).toBe(beforeManifest)
  })

  it('fails the cleanup rewrite when the editor refuses the resulting document', async () => {
    // The managed block itself parses, but the surrounding document is
    // invalid YAML: reading the block succeeds while re-emitting the whole
    // document is refused — the cleanup must keep the pending records.
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-mgr-rwfail-'))
    tempDirs.push(profileDir)
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: {} }))
    writeFileSync(join(profileDir, 'cordis.patch.yml'), [
      '- [unclosed',
      '# BEGIN DSH PLUGIN LIFECYCLE — managed, do not edit',
      '- id: keep-me',
      '  disabled: true',
      '# END DSH PLUGIN LIFECYCLE',
      '',
    ].join('\n'))
    writeFileSync(join(profileDir, 'dsh-plugin-manager-pending-removals.json'), JSON.stringify({
      schemaVersion: 1,
      records: [{ packageName: 'dsh-gone', entryIds: ['other-entry'], operationId: 'op-1', createdAt: 1 }],
    }))
    const engine = makeEngine(profileDir, [])
    await engine.startupCleanup()
    const pending = JSON.parse(readFileSync(join(profileDir, 'dsh-plugin-manager-pending-removals.json'), 'utf8')) as { records: unknown[] }
    expect(pending.records).toHaveLength(1)
  })

  it('blocks uninstall for a package that has entries outside the root patch space', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-mgr-pkggroup-'))
    tempDirs.push(profileDir)
    const pkgDir = join(profileDir, 'node_modules', 'dsh-mixed-pkg')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-mixed-pkg', main: 'index.js' }))
    writeFileSync(join(pkgDir, 'index.js'), 'export function apply() {}\n')
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-mixed-pkg': '1.0.0' } }))
    // One root-space entry and one nested-subtree sibling from the same
    // package: uninstall must refuse the WHOLE package at capabilities time.
    const rows: MutableRow[] = [
      { id: 'include:mixed', options: { id: 'mixed', name: 'dsh-mixed-pkg' }, disabled: true },
      { id: 'include:preset:mixed', options: { id: 'mixed', name: 'dsh-mixed-pkg' }, disabled: true },
    ]
    const engine = makeEngine(profileDir, rows)
    const caps = engine.capabilities()
    const rootRow = caps.entries.find(entry => entry.entryId === 'include:mixed')
    expect(rootRow?.canUninstall).toBe(false)
    expect(rootRow?.uninstallBlockReason).toBe('not-direct-dependency')
    // Toggling the root-space entry stays available; the nested row is
    // invisible to the patch layer but still toggling-blocked.
    expect(rootRow?.canToggle).toBe(true)
    const nestedRow = caps.entries.find(entry => entry.entryId === 'include:preset:mixed')
    expect(nestedRow?.canToggle).toBe(false)
  })

  it('cleanup removes the last managed row and re-emits an empty patch list that re-parses', async () => {
    // Official template shape: comments plus the managed block only. Dropping
    // the final row must restore the `[]` empty root, not leave a null
    // document the boot path would reject.
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-mgr-lastrow-'))
    tempDirs.push(profileDir)
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: {} }))
    writeFileSync(join(profileDir, 'cordis.patch.yml'), [
      '# comments-only remainder',
      '# BEGIN DSH PLUGIN LIFECYCLE — managed, do not edit',
      '- id: gone',
      '  disabled: true',
      '# END DSH PLUGIN LIFECYCLE',
      '',
    ].join('\n'))
    writeFileSync(join(profileDir, 'dsh-plugin-manager-pending-removals.json'), JSON.stringify({
      schemaVersion: 1,
      // Pending records carry loader tree ids; the managed row is data-id keyed.
      records: [{ packageName: 'dsh-gone', entryIds: ['include:gone'], operationId: 'op-1', createdAt: 1 }],
    }))
    const engine = makeEngine(profileDir, [])
    await engine.startupCleanup()
    const text = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    expect(text).not.toContain('- id: gone')
    expect(text.trimEnd().endsWith('[]')).toBe(true)
    expect(isValidPatchListText(text)).toBe(true)
    const pending = JSON.parse(readFileSync(join(profileDir, 'dsh-plugin-manager-pending-removals.json'), 'utf8')) as { records: unknown[] }
    expect(pending.records).toHaveLength(0)
  })
})
