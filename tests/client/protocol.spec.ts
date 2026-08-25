/**
 * Client protocol tests: transport vs domain error separation, strict
 * response validation (INCOMPATIBLE / PROTOCOL_INVALID never become
 * success), and the happy path for each endpoint.
 */
import { describe, expect, it } from 'vitest'
import { capabilities, execute, operation, preview, type ChannelCaller } from '../../src/client/protocol.ts'
import { MANAGER_CHANNEL } from '../../src/host/channel-protocol.ts'

/** Recording fake transport. */
function fakeRpc(handler: (endpoint: string, payload: unknown) => Promise<{ ok: boolean; value?: unknown; error?: { code: string; message?: string } }>): ChannelCaller & { calls: Array<{ channel: string; endpoint: string; payload: unknown }> } {
  const calls: Array<{ channel: string; endpoint: string; payload: unknown }> = []
  return {
    calls,
    call: async (channel, endpoint, payload) => {
      calls.push({ channel, endpoint, payload })
      return handler(endpoint, payload)
    },
  }
}

const goodCapabilities = {
  protocolVersion: 1,
  revision: 'rev-1',
  persistence: 'writable',
  entries: [{
    entryId: 'include:timer',
    moduleName: 'cordis:timer',
    enabled: true,
    origin: { kind: 'official', customized: false, upstream: null, fork: null, branch: null, note: null, declaredBy: 'heuristic' },
    title: null,
    description: null,
    packageName: null,
    canToggle: true,
    canUninstall: false,
    toggleBlockReason: null,
    uninstallBlockReason: 'not-direct-dependency',
  }],
}

describe('client protocol — happy path', () => {
  it('routes every call through the manager channel with the protocol version stamped', async () => {
    const rpc = fakeRpc(async () => ({ ok: true, value: goodCapabilities }))
    const result = await capabilities(rpc)
    expect(result.ok).toBe(true)
    expect(rpc.calls[0]).toMatchObject({ channel: MANAGER_CHANNEL, endpoint: 'capabilities' })
    expect((rpc.calls[0]!.payload as { protocolVersion: number }).protocolVersion).toBe(1)
  })

  it('validates and returns a well-formed preview/execute/operation sequence', async () => {
    const rpc = fakeRpc(async (endpoint) => {
      if (endpoint === 'preview') return { ok: true, value: { protocolVersion: 1, token: 't'.repeat(32), expiresAt: 2, action: 'disable', entryId: 'e', packageName: null, affectedEntryIds: ['e'], restartRequired: false } }
      if (endpoint === 'execute') return { ok: true, value: { protocolVersion: 1, operationId: 'op-1', state: 'running' } }
      return { ok: true, value: { protocolVersion: 1, operationId: 'op-1', state: 'succeeded', action: 'disable', errorCode: null, restartRequired: false } }
    })
    const p = await preview(rpc, { entryId: 'e', action: 'disable', expectedRevision: 'r' })
    expect(p.ok).toBe(true)
    const e = await execute(rpc, 't'.repeat(32))
    expect(e.ok).toBe(true)
    const o = await operation(rpc, 'op-1')
    expect(o.ok).toBe(true)
    if (o.ok) expect(o.value.state).toBe('succeeded')
  })
})

describe('client protocol — error layering', () => {
  it('maps a transport throw to UNAVAILABLE', async () => {
    const rpc = fakeRpc(async () => { throw new Error('channel missing') })
    const result = await capabilities(rpc)
    expect(result).toMatchObject({ ok: false, code: 'UNAVAILABLE' })
  })

  it('passes domain error codes through untouched', async () => {
    const rpc = fakeRpc(async () => ({ ok: false, error: { code: 'PROFILE_CHANGED', message: 'drift' } }))
    const result = await capabilities(rpc)
    expect(result).toMatchObject({ ok: false, code: 'PROFILE_CHANGED' })
  })

  it('answers INCOMPATIBLE when the Host speaks a different protocol version', async () => {
    const rpc = fakeRpc(async () => ({ ok: true, value: { ...goodCapabilities, protocolVersion: 2 } }))
    const result = await capabilities(rpc)
    expect(result).toMatchObject({ ok: false, code: 'INCOMPATIBLE' })
  })

  it('answers PROTOCOL_INVALID for malformed success bodies (never a fake success)', async () => {
    const rpc = fakeRpc(async () => ({ ok: true, value: { protocolVersion: 1, nonsense: true } }))
    expect(await capabilities(rpc)).toMatchObject({ ok: false, code: 'PROTOCOL_INVALID' })
    const previewRpc = fakeRpc(async () => ({ ok: true, value: { protocolVersion: 1, token: 'short', expiresAt: 1, action: 'disable', entryId: 'e', packageName: null, affectedEntryIds: [], restartRequired: false } }))
    expect(await preview(previewRpc, { entryId: 'e', action: 'disable', expectedRevision: 'r' })).toMatchObject({ ok: false, code: 'PROTOCOL_INVALID' })
    const executeRpc = fakeRpc(async () => ({ ok: true, value: { protocolVersion: 1, operationId: '', state: 'running' } }))
    expect(await execute(executeRpc, 't'.repeat(32))).toMatchObject({ ok: false, code: 'PROTOCOL_INVALID' })
    const opRpc = fakeRpc(async () => ({ ok: true, value: { protocolVersion: 1, operationId: 'o', state: 'exploded', action: 'disable', errorCode: null, restartRequired: false } }))
    expect(await operation(opRpc, 'o')).toMatchObject({ ok: false, code: 'PROTOCOL_INVALID' })
  })

  it('answers PROTOCOL_INVALID when a success body has no protocol version at all', async () => {
    const rpc = fakeRpc(async () => ({ ok: true, value: { entries: [] } }))
    const result = await capabilities(rpc)
    expect(result).toMatchObject({ ok: false, code: 'PROTOCOL_INVALID' })
  })

  it('answers INCOMPATIBLE when the version field is a non-numeric value', async () => {
    const rpc = fakeRpc(async () => ({ ok: true, value: { ...goodCapabilities, protocolVersion: 'one' } }))
    const result = await capabilities(rpc)
    expect(result).toMatchObject({ ok: false, code: 'INCOMPATIBLE' })
  })

  it('answers PROTOCOL_INVALID when the success value is null', async () => {
    const rpc = fakeRpc(async () => ({ ok: true, value: null }))
    const result = await capabilities(rpc)
    expect(result).toMatchObject({ ok: false, code: 'PROTOCOL_INVALID' })
  })

  it('maps a non-Error transport throw to UNAVAILABLE without a message', async () => {
    const rpc = fakeRpc(async () => { throw 'just a string' })
    const result = await capabilities(rpc)
    expect(result).toMatchObject({ ok: false, code: 'UNAVAILABLE', message: 'transport failed' })
  })

  it('answers PROTOCOL_INVALID when the error envelope itself is malformed', async () => {
    const rpc = fakeRpc(async () => ({ ok: false, error: {} as { code: string } }))
    const result = await capabilities(rpc)
    expect(result).toMatchObject({ ok: false, code: 'PROTOCOL_INVALID' })
  })

  it('answers PROTOCOL_INVALID for unknown fields on the outer envelope', async () => {
    const rpc = fakeRpc(async () => ({ ok: true, value: goodCapabilities, suspicious: 'extra' }) as never)
    const result = await capabilities(rpc)
    expect(result).toMatchObject({ ok: false, code: 'PROTOCOL_INVALID' })
  })

  it('answers PROTOCOL_INVALID for a primitive transport result', async () => {
    const rpc = fakeRpc(async () => 42 as never)
    const result = await capabilities(rpc)
    expect(result).toMatchObject({ ok: false, code: 'PROTOCOL_INVALID' })
  })

  it('answers PROTOCOL_INVALID for unknown fields on a success value', async () => {
    const rpc = fakeRpc(async () => ({ ok: true, value: { ...goodCapabilities, extra: 1 } }))
    const result = await capabilities(rpc)
    expect(result).toMatchObject({ ok: false, code: 'PROTOCOL_INVALID' })
  })
})
