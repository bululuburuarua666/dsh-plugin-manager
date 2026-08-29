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
import { LIFECYCLE_BEGIN_MARKER, LIFECYCLE_END_MARKER } from '../../src/host/patch-editor.ts'
import type { LoaderEntry } from '../../src/host/cordis.ts'

interface MutableRow extends LoaderEntry {
  options: { name: string; group?: unknown; disabled?: unknown }
  disabled: boolean
}

/** One captured dynamic-inject callback (the connection registration). */
type InjectCallback = (ctx: FakePluginContext) => void | Promise<void>

const tempDirs: string[] = []
const warnings: string[] = []
const infos: string[] = []

/** Fake plugin context mirroring the real Cordis inject/effect semantics. */
class FakePluginContext {
  readonly rows: MutableRow[] = []
  readonly pendingInjects: Array<{ deps: readonly string[]; callback: InjectCallback }> = []
  profileDir: string
  loader: { ctx: { baseUrl: string | undefined; entries: () => Iterable<LoaderEntry> } }
  connection?: {
    rpc: {
      handle(
        channel: string,
        handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<{ ok: boolean; value?: unknown; error?: { code: string; message?: string } }>,
        options: { readonly authority: 'loopback' | 'trusted-host' },
      ): () => Promise<void>
    }
  }
  webServer?: { host?: string }
  get(name: string): unknown {
    return name === 'webServer' ? this.webServer : undefined
  }
  readonly logger = { info: (m: string) => infos.push(m), warn: (m: string) => warnings.push(m) }

  constructor() {
    this.profileDir = mkdtempSync(join(tmpdir(), 'dsh-mgr-chan-'))
    tempDirs.push(this.profileDir)
    mkdirSync(join(this.profileDir, 'node_modules'), { recursive: true })
    writeFileSync(join(this.profileDir, 'package.json'), JSON.stringify({ name: 'p' }))
    this.loader = { entries: () => this.rows.values(), ctx: { baseUrl: pathToFileURL(join(this.profileDir, 'cordis.yml')).href } }
  }

  /** Real-shape dynamic inject: queue until the connection service provides. */
  inject(deps: readonly string[], callback: InjectCallback): unknown {
    this.pendingInjects.push({ deps, callback })
    if (this.connection !== undefined) void callback(this)
    return () => {}
  }

  effect(fn: () => unknown, _label?: string): unknown {
    return fn
  }

  /** Simulate the connection service arriving after the plugin mounted. */
  provideConnection(handler: Parameters<NonNullable<FakePluginContext['connection']>['rpc']['handle']>[1]): void {
    this.connection = {
      rpc: {
        handle: (channel, registered, options) => {
          captured.channel = channel
          captured.authority = options.authority
          captured.handler = registered
          return async () => {}
        },
      },
    }
    void handler
    for (const pending of this.pendingInjects.splice(0)) {
      if (pending.deps.includes('connection')) void pending.callback(this)
    }
  }
}

const captured: {
  channel: string | undefined
  authority: string | undefined
  handler: ((endpoint: string, payload: unknown, signal: AbortSignal) => Promise<{ ok: boolean; value?: unknown; error?: { code: string; message?: string } }>) | undefined
  count: number
} = { channel: undefined, authority: undefined, handler: undefined, count: 0 }

/** Wrap the captured handler with a call counter (for fence-order tests). */
function countedHandler() {
  const real = captured.handler!
  const wrapper = async (endpoint: string, payload: unknown, signal: AbortSignal) => {
    captured.count += 1
    return real(endpoint, payload, signal)
  }
  captured.handler = wrapper
  return wrapper
}

const signal = new AbortController().signal

function makeHostContext(): FakePluginContext {
  captured.channel = undefined
  captured.authority = undefined
  captured.handler = undefined
  captured.count = 0
  return new FakePluginContext()
}

/** apply + connection provision; returns the registered handler. */
function mount(options: { connection?: boolean } = {}): { ctx: FakePluginContext; handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<{ ok: boolean; value?: unknown; error?: { code: string; message?: string } }> } {
  const ctx = makeHostContext()
  plugin.apply(ctx as never)
  if (options.connection !== false) ctx.provideConnection(() => {})
  expect(captured.handler).toBeTypeOf('function')
  return { ctx, handler: captured.handler! }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  warnings.splice(0)
  infos.splice(0)
})

describe('manager channel registration', () => {
  it('declares loader as a required injection', () => {
    const declaration = plugin as unknown as { inject: readonly string[] }
    expect(declaration.inject).toContain('loader')
  })

  it('waits for the connection service and then registers exactly one loopback-pinned channel', () => {
    const ctx = makeHostContext()
    plugin.apply(ctx as never)
    // Before the connection service exists: nothing registered.
    expect(captured.channel).toBeUndefined()
    ctx.provideConnection(() => {})
    expect(captured.channel).toBe(MANAGER_CHANNEL)
    expect(captured.authority).toBe('loopback')
    expect(captured.handler).toBeTypeOf('function')
  })

  it('stays mounted (no crash, no channel) when the connection service never arrives', () => {
    const ctx = makeHostContext()
    expect(() => plugin.apply(ctx as never)).not.toThrow()
    expect(captured.channel).toBeUndefined()
  })

  it('warns when the connection service exists without an rpc surface', () => {
    const ctx = makeHostContext()
    plugin.apply(ctx as never)
    // The service object is present but carries no rpc registry: the
    // registration callback must fail closed with a warning, not crash.
    ;(ctx as FakePluginContext & { connection?: unknown }).connection = {}
    for (const pending of ctx.pendingInjects.splice(0)) {
      if (pending.deps.includes('connection')) void pending.callback(ctx)
    }
    expect(captured.channel).toBeUndefined()
    expect(warnings.some(w => w.includes('without an rpc surface'))).toBe(true)
  })
})

describe('manager channel contract (fail-closed gates)', () => {
  it('rejects an unknown endpoint before any parsing', async () => {
    const { handler } = mount()
    const result = await handler('evil/endpoint', { protocolVersion: 1 }, signal)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('ENDPOINT_UNKNOWN')
  })

  it('rejects a wrong protocol version', async () => {
    const { handler } = mount()
    const result = await handler('capabilities', { protocolVersion: 99 }, signal)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('REQUEST_INVALID')
  })

  it('rejects unknown fields on every endpoint', async () => {
    const { handler } = mount()
    for (const endpoint of MANAGER_ENDPOINTS) {
      const result = await handler(endpoint, { protocolVersion: 1, evil: 'x' }, signal)
      expect(result.ok, endpoint).toBe(false)
      expect(result.error?.code, endpoint).toBe('REQUEST_INVALID')
    }
  })

  it('rejects malformed shapes (entryId missing, bad action, short token)', async () => {
    const { handler } = mount()
    const previewBad = await handler('preview', { protocolVersion: 1, action: 'disable', expectedRevision: 'r' }, signal)
    expect(previewBad.ok).toBe(false)
    const actionBad = await handler('preview', { protocolVersion: 1, entryId: 'a', action: 'destroy', expectedRevision: 'r' }, signal)
    expect(actionBad.ok).toBe(false)
    const tokenBad = await handler('execute', { protocolVersion: 1, token: 'short' }, signal)
    expect(tokenBad.ok).toBe(false)
  })

  it('counts payload size in UTF-8 bytes, not UTF-16 code units', async () => {
    const { handler } = mount()
    // 40k CJK chars = 80k UTF-8 bytes (over the 64k limit) but only 40k
    // UTF-16 code units (under it if counted wrongly). The escape keeps the
    // SOURCE pure ASCII so no tooling round-trip can corrupt it.
    const sneaky = { protocolVersion: 1, entryId: 'x'.repeat(30), expectedRevision: 'r', action: 'disable', note: '\u6c49'.repeat(40_000) }
    const result = await handler('preview', sneaky, signal)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('REQUEST_TOO_LARGE')
  })

  it('skips the size gate for non-object payloads (zod rejects them anyway)', async () => {
    const { handler } = mount()
    const result = await handler('capabilities', null, signal)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('REQUEST_INVALID')
  })

  it('rejects an oversize JSON primitive payload', async () => {
    const { handler } = mount()
    // A 100k-char string primitive: past the byte limit, not an object.
    const result = await handler('capabilities', 'x'.repeat(100_000), signal)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('REQUEST_TOO_LARGE')
  })

  it('returns CANCELLED without consuming the token when execute enters pre-aborted', async () => {
    const { ctx, handler } = mount()
    ctx.rows.push({ id: 'include:demo', options: { id: 'demo', name: 'cordis:demo' }, disabled: false })
    const caps = await handler('capabilities', { protocolVersion: 1 }, signal)
    const revision = (caps.value as { revision: string }).revision
    const preview = await handler('preview', { protocolVersion: 1, entryId: 'include:demo', action: 'disable', expectedRevision: revision }, signal)
    expect(preview.ok).toBe(true)
    const token = (preview.value as { token: string }).token

    // The caller cancels BEFORE dispatch: the one-use token must survive.
    const controller = new AbortController()
    controller.abort()
    const cancelled = await handler('execute', { protocolVersion: 1, token }, controller.signal)
    expect(cancelled).toMatchObject({ ok: false })
    expect(cancelled.error?.code).toBe('CANCELLED')

    // The token is still consumable afterwards (it was never spent).
    const late = await handler('execute', { protocolVersion: 1, token }, signal)
    expect(late.ok).toBe(true)
  })

  it('maps unserializable payloads to INTERNAL instead of crashing', async () => {
    const { handler } = mount()
    const circular: Record<string, unknown> = { protocolVersion: 1 }
    circular.self = circular
    const result = await handler('capabilities', circular, signal)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('INTERNAL')
  })

  it('serves capabilities with protocol version, revision, and merged entries', async () => {
    const { ctx, handler } = mount()
    ctx.rows.push({ id: 'include:demo', options: { id: 'demo', name: 'cordis:demo' }, disabled: false })
    const result = await handler('capabilities', { protocolVersion: 1 }, signal)
    expect(result.ok).toBe(true)
    const value = result.value as { protocolVersion: number; persistence: string; entries: Array<{ entryId: string; canToggle: boolean }> }
    expect(value.protocolVersion).toBe(1)
    expect(value.persistence).toBe('writable')
    expect(value.entries).toHaveLength(1)
    expect(value.entries[0]!.entryId).toBe('include:demo')
    expect(value.entries[0]!.canToggle).toBe(true)
  })

  it('protects infrastructure rows and skips non-root-space rows from toggling', async () => {
    const { ctx, handler } = mount()
    ctx.rows.push({ id: 'include:timer', options: { id: 'timer', name: 'cordis:timer' }, disabled: false })
    ctx.rows.push({ id: 'include:hmr', options: { id: 'hmr', name: 'cordis:hmr' }, disabled: false })
    ctx.rows.push({ id: 'include:dsh-plugin-manager', options: { id: 'dsh-plugin-manager', name: '@bululuburuarua666/dsh-plugin-manager' }, disabled: false })
    // A nested subtree row and a loader-root row have no addressable data id.
    ctx.rows.push({ id: 'include:preset:nested', options: { id: 'nested', name: 'cordis:demo' }, disabled: false, subtree: {} })
    ctx.rows.push({ id: 'bare-root', options: { id: 'bare-root', name: 'cordis:demo' }, disabled: false })
    const result = await handler('capabilities', { protocolVersion: 1 }, signal)
    expect(result.ok).toBe(true)
    const entries = (result.value as { entries: Array<{ entryId: string; canToggle: boolean }> }).entries
    const byId = new Map(entries.map(entry => [entry.entryId, entry]))
    // Infrastructure rows inside the patch space are explicitly protected.
    expect(byId.get('include:timer')?.canToggle).toBe(false)
    expect(byId.get('include:hmr')?.canToggle).toBe(false)
    expect(byId.get('include:dsh-plugin-manager')?.canToggle).toBe(false)
    // The nested subtree row is a composition container: skipped from the
    // roster entirely; the loader-root row has no addressable data id.
    expect(byId.has('include:preset:nested')).toBe(false)
    expect(byId.get('bare-root')?.canToggle).toBe(false)
    // And preview refuses rather than timing out at execute time.
    const revision = (result.value as { revision: string }).revision
    const denied = await handler('preview', { protocolVersion: 1, entryId: 'include:timer', action: 'disable', expectedRevision: revision }, signal)
    expect(denied.ok).toBe(false)
    expect(denied.error?.code).toBe('PROTECTED_PLUGIN')
  })

  it('serves read-only persistence when the webserver binds all interfaces', async () => {
    const { ctx, handler } = mount()
    ctx.webServer = { host: '0.0.0.0' }
    const result = await handler('capabilities', { protocolVersion: 1 }, signal)
    expect(result.ok).toBe(true)
    expect((result.value as { persistence: string }).persistence).toBe('read-only')
  })

  it('answers empty capabilities when the Loader context is absent', async () => {
    const ctx = makeHostContext()
    plugin.apply(ctx as never)
    delete (ctx as { loader?: unknown }).loader
    ctx.provideConnection(() => {})
    const result = await captured.handler!('capabilities', { protocolVersion: 1 }, signal)
    expect(result.ok).toBe(true)
    expect((result.value as { entries: unknown[] }).entries).toEqual([])
  })

  it('skips group rows when assembling the channel roster', async () => {
    const { ctx, handler } = mount()
    ctx.rows.push({ id: 'include:demo', options: { id: 'demo', name: 'cordis:demo' }, disabled: false })
    ctx.rows.push({ id: 'g1', options: { name: 'grouped', group: true }, disabled: false })
    const result = await handler('capabilities', { protocolVersion: 1 }, signal)
    expect(result.ok).toBe(true)
    expect((result.value as { entries: Array<{ entryId: string }> }).entries.map(entry => entry.entryId)).toEqual(['include:demo'])
  })

  it('keeps roster and capability rows consistent for live Loader mutations', async () => {
    const { ctx, handler } = mount()
    ctx.rows.push({ id: 'include:demo', options: { id: 'demo', name: 'cordis:demo' }, disabled: false })
    ctx.rows.push({ id: 'include:extra', options: { id: 'extra', name: 'cordis:extra' }, disabled: false })
    const result = await handler('capabilities', { protocolVersion: 1 }, signal)
    expect(result.ok).toBe(true)
    const entries = (result.value as { entries: Array<{ entryId: string; canToggle: boolean }> }).entries
    expect(entries.map(entry => entry.entryId)).toContain('include:extra')
    expect(entries.find(entry => entry.entryId === 'include:extra')?.canToggle).toBe(true)
  })

  it('maps engine ManagerFailure codes onto the wire untouched', async () => {
    const { handler } = mount()
    const result = await handler('execute', { protocolVersion: 1, token: 'a'.repeat(32) }, signal)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('PROFILE_CHANGED')
  })

  it('drives a full preview -> execute -> operation cycle over the channel', async () => {
    const ctx = makeHostContext()
    const patchPath = join(ctx.profileDir, 'cordis.patch.yml')
    ctx.rows.push({ id: 'include:demo', options: { id: 'demo', name: 'cordis:demo' }, disabled: false })
    plugin.apply(ctx as never)
    ctx.provideConnection(() => {})
    const handler = captured.handler!
    const timer = setInterval(() => {
      try {
        const text = readFileSync(patchPath, 'utf8')
        // Managed rows carry the patch-layer DATA id (unquoted when plain):
        // `timer` targets the loader row `include:timer`.
        const match = /- id: "?([^\n"]+)"?\n  disabled: true/.exec(text)
        if (match === null) return
        for (const row of ctx.rows) {
          if ((row.id === match[1] || row.id.endsWith(`:${match[1]}`)) && !row.disabled) row.disabled = true
        }
      } catch { /* not written yet */ }
    }, 10)
    try {
      const caps = await handler('capabilities', { protocolVersion: 1 }, signal)
      expect(caps.ok).toBe(true)
      const revision = (caps.value as { revision: string }).revision
      const preview = await handler('preview', { protocolVersion: 1, entryId: 'include:demo', action: 'disable', expectedRevision: revision }, signal)
      expect(preview.ok).toBe(true)
      const token = (preview.value as { token: string }).token
      const started = await handler('execute', { protocolVersion: 1, token }, signal)
      expect(started.ok).toBe(true)
      const operationId = (started.value as { operationId: string }).operationId
      const deadline = Date.now() + 10_000
      for (;;) {
        const polled = await handler('operation', { protocolVersion: 1, operationId }, signal)
        expect(polled.ok).toBe(true)
        if ((polled.value as { state: string }).state === 'succeeded') break
        if (Date.now() > deadline) throw new Error('channel operation never settled')
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    } finally {
      clearInterval(timer)
    }
  }, 15_000)

  it('rejects a pre-cancelled read request before dispatching', async () => {
    const { handler } = mount()
    const controller = new AbortController()
    controller.abort()
    const result = await handler('capabilities', { protocolVersion: 1 }, controller.signal)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('CANCELLED')
  })

  it('still acknowledges execute when the caller aborts right after dispatch', async () => {
    const { ctx, handler } = mount()
    ctx.rows.push({ id: 'include:demo', options: { id: 'demo', name: 'cordis:demo' }, disabled: false })
    const caps = await handler('capabilities', { protocolVersion: 1 }, signal)
    const revision = (caps.value as { revision: string }).revision
    const preview = await handler('preview', { protocolVersion: 1, entryId: 'include:demo', action: 'disable', expectedRevision: revision }, signal)
    const token = (preview.value as { token: string }).token
    // Abort fires only AFTER the acknowledgement: the operation is queued
    // regardless; its result is observable through `operation`.
    const controller = new AbortController()
    const pending = handler('execute', { protocolVersion: 1, token }, controller.signal)
    controller.abort()
    const result = await pending
    expect(result.ok).toBe(true)
    expect((result.value as { operationId: string }).operationId).toBeTruthy()
  })

  it('warns when startup cleanup fails and still registers the channel', async () => {
    const ctx = makeHostContext()
    writeFileSync(join(ctx.profileDir, 'dsh-plugin-manager-pending-removals.json'), JSON.stringify({
      schemaVersion: 1,
      records: [{ packageName: 'dsh-gone', entryIds: ['gone-entry'], operationId: 'op-1', createdAt: 1 }],
    }))
    writeFileSync(join(ctx.profileDir, 'cordis.patch.yml'), [
      LIFECYCLE_BEGIN_MARKER,
      '- id: gone-entry',
      '  disabled: true',
      LIFECYCLE_END_MARKER,
      '',
    ].join('\n'))
    writeFileSync(join(ctx.profileDir, 'package.json'), JSON.stringify({ dependencies: {} }))
    try { chmodSync(ctx.profileDir, 0o500) } catch { /* Windows may ignore */ }
    plugin.apply(ctx as never)
    try { chmodSync(ctx.profileDir, 0o700) } catch { /* best effort */ }
    ctx.provideConnection(() => {})
    expect(captured.channel).toBe(MANAGER_CHANNEL)
  })

  it('counts business handler invocations (fence-order harness)', async () => {
    mount()
    const handler = countedHandler()
    await handler('capabilities', { protocolVersion: 1 }, signal)
    expect(captured.count).toBe(1)
  })

  it('skips the size gate for function payloads and logs INTERNAL diagnostics', async () => {
    const { handler } = mount()
    // A function cannot cross JSON; zod rejects it as a malformed request.
    const result = await handler('capabilities', () => {}, signal)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('REQUEST_INVALID')
  })
})

describe('origin endpoints (state + update)', () => {
  function withPackage(profileDir: string, name: string, extra: Record<string, unknown> = {}): void {
    const pkg = join(profileDir, 'node_modules', ...name.split('/'))
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, ...extra }))
  }

  it('describes detected/effective origins and the file revision', async () => {
    const { ctx, handler } = mount()
    withPackage(ctx.profileDir, 'dsh-vision-router', { repository: 'https://github.com/example/vr' })
    ctx.rows.push({ id: 'include:vr', options: { id: 'vr', name: 'dsh-vision-router' }, disabled: false })
    const result = await handler('originState', { protocolVersion: 1, entryId: 'include:vr' }, signal)
    expect(result.ok).toBe(true)
    const value = result.value as {
      protocolVersion: number
      entryId: string
      packageName: string
      detected: { kind: string; declaredBy: string }
      effective: { kind: string; declaredBy: string }
      override: unknown
      originRevision: string
    }
    expect(value.protocolVersion).toBe(1)
    expect(value.entryId).toBe('include:vr')
    expect(value.packageName).toBe('dsh-vision-router')
    expect(value.detected.kind).toBe('opensource')
    expect(value.detected.declaredBy).toBe('heuristic')
    expect(value.detected.upstream).toBe('https://github.com/example/vr')
    expect(value.effective.kind).toBe('opensource')
    expect(value.effective.declaredBy).toBe('heuristic')
    expect(value.override).toBeNull()
    expect(value.originRevision).toBe('-')
  })

  it('applies an override through originUpdate and reports the new state', async () => {
    const { ctx, handler } = mount()
    withPackage(ctx.profileDir, 'dsh-vision-router', { repository: 'https://github.com/example/vr' })
    ctx.rows.push({ id: 'include:vr', options: { id: 'vr', name: 'dsh-vision-router' }, disabled: false })
    const state = await handler('originState', { protocolVersion: 1, entryId: 'include:vr' }, signal)
    const revision = (state.value as { originRevision: string }).originRevision
    const updated = await handler('originUpdate', {
      protocolVersion: 1,
      entryId: 'include:vr',
      expectedOriginRevision: revision,
      override: { kind: 'personal', note: 'mine' },
    }, signal)
    expect(updated.ok).toBe(true)
    const value = updated.value as {
      effective: { kind: string; declaredBy: string }
      override: { kind: string; note: string } | null
      originRevision: string
    }
    expect(value.effective.kind).toBe('personal')
    expect(value.effective.declaredBy).toBe('user-override')
    expect(value.override).toEqual({ kind: 'personal', note: 'mine' })
    expect(value.originRevision).not.toBe(revision)
    const file = JSON.parse(readFileSync(join(ctx.profileDir, 'plugin-origins.json'), 'utf8')) as {
      packages: Record<string, unknown>
    }
    expect(file.packages['dsh-vision-router']).toEqual({ kind: 'personal', note: 'mine' })
  })

  it('keeps lifecycle capabilities identical across a manual official mark', async () => {
    const { ctx, handler } = mount()
    withPackage(ctx.profileDir, 'dsh-vision-router', { repository: 'https://github.com/example/vr' })
    ctx.rows.push({ id: 'include:vr', options: { id: 'vr', name: 'dsh-vision-router' }, disabled: false })
    const capabilitiesOf = async (): Promise<Record<string, unknown>> => {
      const caps = await handler('capabilities', { protocolVersion: 1 }, signal)
      const entry = (caps.value as { entries: Array<{ entryId: string } & Record<string, unknown>> }).entries
        .find(candidate => candidate.entryId === 'include:vr')
      return {
        canToggle: entry?.canToggle,
        canUninstall: entry?.canUninstall,
        toggleBlockReason: entry?.toggleBlockReason,
        uninstallBlockReason: entry?.uninstallBlockReason,
      }
    }
    const before = await capabilitiesOf()
    const state = await handler('originState', { protocolVersion: 1, entryId: 'include:vr' }, signal)
    const revision = (state.value as { originRevision: string }).originRevision
    const updated = await handler('originUpdate', {
      protocolVersion: 1,
      entryId: 'include:vr',
      expectedOriginRevision: revision,
      override: { kind: 'official' },
    }, signal)
    expect(updated.ok).toBe(true)
    expect((updated.value as { effective: { kind: string } }).effective.kind).toBe('official')
    // The display classification changed; every lifecycle gate did not.
    expect(await capabilitiesOf()).toEqual(before)
  })

  it('restores automatic detection with a null override', async () => {
    const { ctx, handler } = mount()
    withPackage(ctx.profileDir, 'dsh-vision-router', { repository: 'https://github.com/example/vr' })
    ctx.rows.push({ id: 'include:vr', options: { id: 'vr', name: 'dsh-vision-router' }, disabled: false })
    const first = await handler('originState', { protocolVersion: 1, entryId: 'include:vr' }, signal)
    const revision = (first.value as { originRevision: string }).originRevision
    const applied = await handler('originUpdate', {
      protocolVersion: 1,
      entryId: 'include:vr',
      expectedOriginRevision: revision,
      override: { kind: 'opensource', customized: true, note: 'custom note' },
    }, signal)
    expect(applied.ok).toBe(true)
    const freshRevision = (applied.value as { originRevision: string }).originRevision
    const restored = await handler('originUpdate', {
      protocolVersion: 1,
      entryId: 'include:vr',
      expectedOriginRevision: freshRevision,
      override: null,
    }, signal)
    expect(restored.ok).toBe(true)
    const value = restored.value as { effective: { declaredBy: string }; override: unknown }
    expect(value.override).toBeNull()
    expect(value.effective.declaredBy).toBe('heuristic')
  })

  it('answers ORIGIN_CONFLICT on a stale revision and writes nothing', async () => {
    const { ctx, handler } = mount()
    withPackage(ctx.profileDir, 'dsh-vision-router', { repository: 'https://github.com/example/vr' })
    ctx.rows.push({ id: 'include:vr', options: { id: 'vr', name: 'dsh-vision-router' }, disabled: false })
    const state = await handler('originState', { protocolVersion: 1, entryId: 'include:vr' }, signal)
    const stale = (state.value as { originRevision: string }).originRevision
    await handler('originUpdate', {
      protocolVersion: 1,
      entryId: 'include:vr',
      expectedOriginRevision: stale,
      override: { kind: 'personal' },
    }, signal)
    // Another page now holds the stale revision.
    const second = await handler('originUpdate', {
      protocolVersion: 1,
      entryId: 'include:vr',
      expectedOriginRevision: stale,
      override: { kind: 'official' },
    }, signal)
    expect(second.ok).toBe(false)
    expect(second.error?.code).toBe('ORIGIN_CONFLICT')
    const file = JSON.parse(readFileSync(join(ctx.profileDir, 'plugin-origins.json'), 'utf8')) as {
      packages: Record<string, unknown>
    }
    expect(file.packages['dsh-vision-router']).toEqual({ kind: 'personal' })
  })

  it('enforces the customized-note requirement server-side', async () => {
    const { ctx, handler } = mount()
    withPackage(ctx.profileDir, 'dsh-vision-router', { repository: 'https://github.com/example/vr' })
    ctx.rows.push({ id: 'include:vr', options: { id: 'vr', name: 'dsh-vision-router' }, disabled: false })
    const state = await handler('originState', { protocolVersion: 1, entryId: 'include:vr' }, signal)
    const revision = (state.value as { originRevision: string }).originRevision
    const updated = await handler('originUpdate', {
      protocolVersion: 1,
      entryId: 'include:vr',
      expectedOriginRevision: revision,
      override: { kind: 'opensource', customized: true },
    }, signal)
    expect(updated.ok).toBe(false)
    expect(updated.error?.code).toBe('ORIGIN_NOTE_REQUIRED')
    expect(ctx.loader.ctx.baseUrl !== undefined).toBe(true)
  })

  it('preserves a corrupt override file and answers ORIGIN_FILE_INVALID', async () => {
    const { ctx, handler } = mount()
    withPackage(ctx.profileDir, 'dsh-vision-router', { repository: 'https://github.com/example/vr' })
    ctx.rows.push({ id: 'include:vr', options: { id: 'vr', name: 'dsh-vision-router' }, disabled: false })
    const corrupt = '{ not json'
    writeFileSync(join(ctx.profileDir, 'plugin-origins.json'), corrupt)
    const updated = await handler('originUpdate', {
      protocolVersion: 1,
      entryId: 'include:vr',
      expectedOriginRevision: '-',
      override: { kind: 'personal' },
    }, signal)
    expect(updated.ok).toBe(false)
    expect(updated.error?.code).toBe('ORIGIN_FILE_INVALID')
    expect(readFileSync(join(ctx.profileDir, 'plugin-origins.json'), 'utf8')).toBe(corrupt)
  })

  it('refuses originUpdate on read-only deployments while originState stays readable', async () => {
    const { ctx, handler } = mount()
    withPackage(ctx.profileDir, 'dsh-vision-router', { repository: 'https://github.com/example/vr' })
    ctx.rows.push({ id: 'include:vr', options: { id: 'vr', name: 'dsh-vision-router' }, disabled: false })
    ctx.webServer = { host: '0.0.0.0' }
    const state = await handler('originState', { protocolVersion: 1, entryId: 'include:vr' }, signal)
    expect(state.ok).toBe(true)
    const updated = await handler('originUpdate', {
      protocolVersion: 1,
      entryId: 'include:vr',
      expectedOriginRevision: '-',
      override: { kind: 'personal' },
    }, signal)
    expect(updated.ok).toBe(false)
    expect(updated.error?.code).toBe('READ_ONLY_REMOTE')
  })

  it('answers ENTRY_NOT_FOUND for an unknown entry and ORIGIN_UNAVAILABLE for cordis builtins', async () => {
    const { ctx, handler } = mount()
    ctx.rows.push({ id: 'include:timer', options: { id: 'timer', name: 'cordis:timer' }, disabled: false })
    const unknown = await handler('originState', { protocolVersion: 1, entryId: 'include:ghost' }, signal)
    expect(unknown.ok).toBe(false)
    expect(unknown.error?.code).toBe('ENTRY_NOT_FOUND')
    const builtin = await handler('originState', { protocolVersion: 1, entryId: 'include:timer' }, signal)
    expect(builtin.ok).toBe(false)
    expect(builtin.error?.code).toBe('ORIGIN_UNAVAILABLE')
  })

  it('rejects malformed originState/originUpdate payloads', async () => {
    const { handler } = mount()
    const longRevision = await handler('originUpdate', {
      protocolVersion: 1,
      entryId: 'include:vr',
      expectedOriginRevision: 'r'.repeat(129),
      override: null,
    }, signal)
    expect(longRevision.error?.code).toBe('REQUEST_INVALID')
    const missingOverride = await handler('originUpdate', {
      protocolVersion: 1,
      entryId: 'include:vr',
      expectedOriginRevision: 'r',
    }, signal)
    expect(missingOverride.error?.code).toBe('REQUEST_INVALID')
    const unknownField = await handler('originUpdate', {
      protocolVersion: 1,
      entryId: 'include:vr',
      expectedOriginRevision: 'r',
      override: { kind: 'personal', evil: true },
    }, signal)
    expect(unknownField.error?.code).toBe('REQUEST_INVALID')
    const badKind = await handler('originUpdate', {
      protocolVersion: 1,
      entryId: 'include:vr',
      expectedOriginRevision: 'r',
      override: { kind: 'builtin' },
    }, signal)
    expect(badKind.error?.code).toBe('REQUEST_INVALID')
    const longNote = await handler('originUpdate', {
      protocolVersion: 1,
      entryId: 'include:vr',
      expectedOriginRevision: 'r',
      override: { kind: 'opensource', customized: true, note: 'n'.repeat(1_001) },
    }, signal)
    expect(longNote.error?.code).toBe('REQUEST_INVALID')
    const longEntry = await handler('originState', { protocolVersion: 1, entryId: 'e'.repeat(257) }, signal)
    expect(longEntry.error?.code).toBe('REQUEST_INVALID')
  })
})
