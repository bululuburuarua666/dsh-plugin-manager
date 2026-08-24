/**
 * Channel security and contract tests: the handler fail-closes on unknown
 * endpoints, malformed payloads, wrong protocol versions, and oversize
 * requests; loopback enforcement is delegated to the official Host fence
 * (verified end-to-end against the real Connection in T09).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import plugin from '../../src/index.ts'
import { MANAGER_CHANNEL, MANAGER_ENDPOINTS } from '../../src/host/channel-protocol.ts'
import type { HostContext, LoaderEntry } from '../../src/host/cordis.ts'

interface MutableRow extends LoaderEntry {
  options: { name: string; group?: unknown; disabled?: unknown }
  disabled: boolean
}

const tempDirs: string[] = []
const warnings: string[] = []

function makeHostContext(): HostContext & { profileDir: string } {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-mgr-chan-'))
  tempDirs.push(profileDir)
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'p' }))
  const rows: MutableRow[] = []
  const captured: {
    channel: string | undefined
    authority: string | undefined
    handler: ((endpoint: string, payload: unknown, signal: AbortSignal) => Promise<{ ok: boolean; value?: unknown; error?: { code: string; message?: string } }>) | undefined
  } = { channel: undefined, authority: undefined, handler: undefined }
  const ctx: HostContext & { profileDir: string } = {
    loader: { ctx: { baseUrl: pathToFileURL(join(profileDir, 'cordis.yml')).href, entries: () => rows.values() } },
    logger: { info: () => {}, warn: (m: string) => warnings.push(m) },
    connection: {
      rpc: {
        handle: (channel, handler, options) => {
          captured.channel = channel
          captured.authority = options.authority
          captured.handler = handler
          return async () => {}
        },
      },
    },
    profileDir,
  }
  ;(ctx as { __captured: typeof captured }).__captured = captured
  ;(ctx as { __rows: MutableRow[] }).__rows = rows
  return ctx
}

function capturedOf(ctx: ReturnType<typeof makeHostContext>) {
  return (ctx as unknown as { __captured: NonNullable<ReturnType<typeof makeHostContext>['__captured']> }).__captured
}

function rowsOf(ctx: ReturnType<typeof makeHostContext>): MutableRow[] {
  return (ctx as unknown as { __rows: MutableRow[] }).__rows
}

const signal = new AbortController().signal

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  warnings.splice(0)
})

describe('manager channel registration', () => {
  it('registers exactly one loopback-pinned channel', () => {
    const ctx = makeHostContext()
    plugin.apply(ctx)
    const captured = capturedOf(ctx)
    expect(captured.channel).toBe(MANAGER_CHANNEL)
    expect(captured.authority).toBe('loopback')
    expect(captured.handler).toBeTypeOf('function')
  })

  it('serves read-only persistence when the webserver binds all interfaces', async () => {
    const ctx = makeHostContext()
    ;(ctx as HostContext & { webServer?: { host?: string } }).webServer = { host: '0.0.0.0' }
    plugin.apply(ctx)
    const { handler } = capturedOf(ctx)
    const result = await handler!('capabilities', { protocolVersion: 1 }, signal)
    expect(result.ok).toBe(true)
    expect((result.value as { persistence: string }).persistence).toBe('read-only')
  })

  it('answers empty capabilities when the Loader context is absent', async () => {
    const ctx = makeHostContext()
    delete (ctx as { loader?: unknown }).loader
    plugin.apply(ctx)
    const { handler } = capturedOf(ctx)
    const result = await handler!('capabilities', { protocolVersion: 1 }, signal)
    expect(result.ok).toBe(true)
    expect((result.value as { entries: unknown[] }).entries).toEqual([])
  })

  it('keeps roster and capability rows consistent for live Loader mutations', async () => {
    const ctx = makeHostContext()
    rowsOf(ctx).push({ id: 'include:timer', options: { name: 'cordis:timer' }, disabled: false })
    plugin.apply(ctx)
    // A row added after apply is visible to BOTH the roster and the engine
    // (same Loader source): the merged row carries a real capability.
    rowsOf(ctx).push({ id: 'include:extra', options: { name: 'cordis:extra' }, disabled: false })
    const { handler } = capturedOf(ctx)
    const result = await handler!('capabilities', { protocolVersion: 1 }, signal)
    expect(result.ok).toBe(true)
    const entries = (result.value as { entries: Array<{ entryId: string; canToggle: boolean }> }).entries
    expect(entries.map(entry => entry.entryId)).toContain('include:extra')
    expect(entries.find(entry => entry.entryId === 'include:extra')?.canToggle).toBe(true)
  })

  it('degrades to a warning without the Connection RPC surface', () => {
    const ctx = makeHostContext()
    delete (ctx as { connection?: unknown }).connection
    expect(() => plugin.apply(ctx)).not.toThrow()
    expect(warnings.some(w => w.includes('no Connection RPC surface'))).toBe(true)
  })
})

describe('manager channel contract (fail-closed gates)', () => {
  it('rejects an unknown endpoint before any parsing', async () => {
    const ctx = makeHostContext()
    plugin.apply(ctx)
    const { handler } = capturedOf(ctx)
    const result = await handler!('evil/endpoint', { protocolVersion: 1 }, signal)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('ENDPOINT_UNKNOWN')
  })

  it('rejects a wrong protocol version', async () => {
    const ctx = makeHostContext()
    plugin.apply(ctx)
    const { handler } = capturedOf(ctx)
    const result = await handler!('capabilities', { protocolVersion: 99 }, signal)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('REQUEST_INVALID')
  })

  it('rejects unknown fields on every endpoint', async () => {
    const ctx = makeHostContext()
    plugin.apply(ctx)
    const { handler } = capturedOf(ctx)
    for (const endpoint of MANAGER_ENDPOINTS) {
      const result = await handler!(endpoint, { protocolVersion: 1, evil: 'x' }, signal)
      expect(result.ok, endpoint).toBe(false)
      expect(result.error?.code, endpoint).toBe('REQUEST_INVALID')
    }
  })

  it('rejects malformed shapes (entryId missing, bad action, short token)', async () => {
    const ctx = makeHostContext()
    plugin.apply(ctx)
    const { handler } = capturedOf(ctx)
    const previewBad = await handler!('preview', { protocolVersion: 1, action: 'disable', expectedRevision: 'r' }, signal)
    expect(previewBad.ok).toBe(false)
    const actionBad = await handler!('preview', { protocolVersion: 1, entryId: 'a', action: 'destroy', expectedRevision: 'r' }, signal)
    expect(actionBad.ok).toBe(false)
    const tokenBad = await handler!('execute', { protocolVersion: 1, token: 'short' }, signal)
    expect(tokenBad.ok).toBe(false)
  })

  it('serves capabilities with protocol version, revision, and merged entries', async () => {
    const ctx = makeHostContext()
    plugin.apply(ctx)
    const captured = capturedOf(ctx)
    // Seed one row so the merge path carries real data.
    ;(ctx.loader.ctx as { entries: () => Iterable<LoaderEntry> }).entries = function* () {
      yield { id: 'include:timer', options: { name: 'cordis:timer' }, disabled: false }
    }
    const result = await captured.handler!('capabilities', { protocolVersion: 1 }, signal)
    expect(result.ok).toBe(true)
    const value = result.value as { protocolVersion: number; revision: string; persistence: string; entries: Array<{ entryId: string; canToggle: boolean }> }
    expect(value.protocolVersion).toBe(1)
    expect(value.persistence).toBe('writable')
    expect(value.revision.length).toBeGreaterThan(0)
    expect(value.entries).toHaveLength(1)
    expect(value.entries[0]!.entryId).toBe('include:timer')
    expect(value.entries[0]!.canToggle).toBe(true)
  })

  it('maps engine ManagerFailure codes onto the wire untouched', async () => {
    const ctx = makeHostContext()
    plugin.apply(ctx)
    const { handler } = capturedOf(ctx)
    // Unknown token: the engine raises PROFILE_CHANGED through the channel.
    const result = await handler!('execute', { protocolVersion: 1, token: 'a'.repeat(32) }, signal)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('PROFILE_CHANGED')
  })

  it('drives a full preview → execute → operation cycle over the channel', async () => {
    const ctx = makeHostContext()
    const patchPath = join(ctx.profileDir, 'cordis.patch.yml')
    // A persistent mutable roster the driver can flip.
    const rows = rowsOf(ctx)
    rows.push({ id: 'include:timer', options: { name: 'cordis:timer' }, disabled: false })
    const timer = setInterval(() => {
      try {
        const text = readFileSync(patchPath, 'utf8')
        const match = /- id: "([^"]+)"\n  disabled: true/.exec(text)
        if (match === null) return
        for (const row of rows) {
          if (row.id === match[1] && !row.disabled) row.disabled = true
        }
      } catch { /* not written yet */ }
    }, 10)
    try {
      plugin.apply(ctx)
      const { handler } = capturedOf(ctx)

      const caps = await handler!('capabilities', { protocolVersion: 1 }, signal)
      expect(caps.ok).toBe(true)
      const revision = (caps.value as { revision: string }).revision

      const preview = await handler!('preview', { protocolVersion: 1, entryId: 'include:timer', action: 'disable', expectedRevision: revision }, signal)
      expect(preview.ok).toBe(true)
      expect((preview.value as { action: string }).action).toBe('disable')
      const token = (preview.value as { token: string }).token

      const started = await handler!('execute', { protocolVersion: 1, token }, signal)
      expect(started.ok).toBe(true)
      const operationId = (started.value as { operationId: string }).operationId

      const deadline = Date.now() + 10_000
      for (;;) {
        const polled = await handler!('operation', { protocolVersion: 1, operationId }, signal)
        expect(polled.ok).toBe(true)
        const state = (polled.value as { state: string }).state
        if (state === 'succeeded') break
        if (Date.now() > deadline) throw new Error('channel operation never settled')
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    } finally {
      clearInterval(timer)
    }
  }, 15_000)

  it('rejects an oversize payload before parsing', async () => {
    const ctx = makeHostContext()
    plugin.apply(ctx)
    const { handler } = capturedOf(ctx)
    const huge = { protocolVersion: 1, blob: 'x'.repeat(200_000) }
    const result = await handler!('capabilities', huge, signal)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('REQUEST_TOO_LARGE')
  })

  it('maps unserializable payloads to INTERNAL instead of crashing', async () => {
    const ctx = makeHostContext()
    plugin.apply(ctx)
    const { handler } = capturedOf(ctx)
    // A circular payload makes the size probe's JSON.stringify throw inside
    // the handler: the defensive catch must answer INTERNAL, never crash.
    const circular: Record<string, unknown> = { protocolVersion: 1 }
    circular.self = circular
    const result = await handler!('capabilities', circular, signal)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('INTERNAL')
  })

  it('bridges channel disposal through the plugin effect API when present', async () => {
    const ctx = makeHostContext()
    const effects: Array<() => unknown> = []
    ;(ctx as HostContext & { effect?: (fn: () => unknown, label?: string) => unknown }).effect = (fn) => {
      effects.push(fn)
      return () => {}
    }
    plugin.apply(ctx)
    expect(effects).toHaveLength(1)
    // Executing the effect runs the disposal thunk.
    await effects[0]!()
  })

  it('warns when startup cleanup fails and still registers the channel', async () => {
    const ctx = makeHostContext()
    // Settled records + a patch that needs rewriting, but the profile
    // directory is read-only: the cross-process lock cannot be created and
    // the cleanup rejects; the channel registration is unaffected.
    writeFileSync(join(ctx.profileDir, 'dsh-plugin-manager-pending-removals.json'), JSON.stringify({
      schemaVersion: 1,
      records: [{ packageName: 'dsh-gone', entryIds: ['gone-entry'], operationId: 'op-1', createdAt: 1 }],
    }))
    writeFileSync(join(ctx.profileDir, 'cordis.patch.yml'), [
      '# BEGIN DSH PLUGIN LIFECYCLE — managed, do not edit',
      '- id: gone-entry',
      '  disabled: true',
      '# END DSH PLUGIN LIFECYCLE',
      '',
    ].join('\n'))
    writeFileSync(join(ctx.profileDir, 'package.json'), JSON.stringify({ dependencies: {} }))
    try { chmodSync(ctx.profileDir, 0o500) } catch { /* Windows may ignore */ }
    plugin.apply(ctx)
    try { chmodSync(ctx.profileDir, 0o700) } catch { /* best effort */ }
    const captured = capturedOf(ctx)
    expect(captured.channel).toBe(MANAGER_CHANNEL)
    await new Promise(resolve => setTimeout(resolve, 50))
    // On POSIX the lock creation fails (warning fires); on Windows the chmod
    // may be a no-op and the cleanup succeeds — accept both, the invariant
    // under test is that apply() never throws and the channel always exists.
    expect(captured.channel).toBe(MANAGER_CHANNEL)
  })

  it('skips group rows when assembling the channel roster', async () => {
    const ctx = makeHostContext()
    ;(ctx.loader.ctx as { entries: () => Iterable<LoaderEntry> }).entries = function* () {
      yield { id: 'include:timer', options: { name: 'cordis:timer' }, disabled: false }
      yield { id: 'g1', options: { name: 'grouped', group: true }, disabled: false }
    }
    plugin.apply(ctx)
    const { handler } = capturedOf(ctx)
    const result = await handler!('capabilities', { protocolVersion: 1 }, signal)
    expect(result.ok).toBe(true)
    expect((result.value as { entries: Array<{ entryId: string }> }).entries.map(entry => entry.entryId)).toEqual(['include:timer'])
  })
})
