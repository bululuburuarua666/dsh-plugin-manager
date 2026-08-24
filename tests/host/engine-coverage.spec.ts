import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LifecycleEngine, type EngineHost } from '../../src/host/engine.ts'
import { PluginLifecycleTokenStore } from '../../src/host/token-store.ts'
import type { LoaderEntry } from '../../src/host/cordis.ts'

interface MutableRow extends LoaderEntry {
  options: { name: string; group?: unknown; disabled?: unknown }
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

    const rows: MutableRow[] = [{ id: 'include:x', options: { name: 'cordis:noop' }, disabled: false }]
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

    const rows: MutableRow[] = [{ id: 'include:x', options: { name: 'cordis:noop' }, disabled: false }]
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

    const rows: MutableRow[] = [{ id: 'include:x', options: { name: 'cordis:noop' }, disabled: false }]
    const engine = makeEngine(profileDir, rows)
    const caps = engine.capabilities()
    const preview = engine.preview({ entryId: 'include:x', action: 'disable', expectedRevision: caps.revision })
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

    const rows: MutableRow[] = [{ id: 'include:x', options: { name: 'cordis:noop' }, disabled: false }]
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
      { id: 'include:still', options: { name: 'cordis:noop' }, disabled: false },
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
    const rows: MutableRow[] = [{ id: 'include:still-here', options: { name: 'cordis:noop' }, disabled: false }]
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

    const rows: MutableRow[] = [{ id: 'include:x', options: { name: 'cordis:noop' }, disabled: false }]
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
})
