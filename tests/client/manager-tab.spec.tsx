// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PluginManagerTab, lifecycleErrorText } from '../../src/client/PluginManagerTab.tsx'
import type { ChannelCaller, ClientCapabilities, ClientResult } from '../../src/client/protocol.ts'
import { en, type ManagerLocaleKey } from '../../src/client/locales.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const t = (key: ManagerLocaleKey): string => en[key]

/** A healthy two-entry capabilities snapshot. */
const CAPS: ClientCapabilities = {
  protocolVersion: 1,
  revision: 'rev-1',
  persistence: 'writable',
  entries: [
    {
      entryId: 'include:vision-router',
      moduleName: 'dsh-vision-router',
      enabled: true,
      origin: { kind: 'opensource', customized: false, upstream: 'https://github.com/example/vr', fork: null, branch: null, note: null, declaredBy: 'heuristic' },
      title: { zh: '视觉路由', en: '视觉路由' },
      description: { zh: '视觉工具', en: 'Vision tools' },
      packageName: 'dsh-vision-router',
      canToggle: true,
      canUninstall: true,
      toggleBlockReason: null,
      uninstallBlockReason: null,
    },
    {
      entryId: 'include:timer',
      moduleName: 'cordis:timer',
      enabled: false,
      origin: { kind: 'official', customized: false, upstream: null, fork: null, branch: null, note: null, declaredBy: 'heuristic' },
      title: null,
      description: null,
      packageName: null,
      canToggle: true,
      canUninstall: false,
      toggleBlockReason: null,
      uninstallBlockReason: 'not-direct-dependency',
    },
  ],
}

type Handler = (endpoint: string, payload: unknown) => Promise<ClientResult<unknown>>

/** Fake transport answering the four endpoints from a handler table. */
function fakeRpc(handler: Handler): ChannelCaller {
  return {
    call: async (_channel, endpoint, payload) => {
      const result = await handler(endpoint, payload)
      if (result.ok) return { ok: true, value: result.value }
      return { ok: false, error: { code: result.code, message: result.message } }
    },
  }
}

const okCaps = (): Handler => async endpoint => {
  if (endpoint === 'capabilities') return { ok: true, value: CAPS }
  throw new Error(`unexpected ${endpoint}`)
}

describe('PluginManagerTab states', () => {
  it('renders the roster with origin badges and enabled tags', async () => {
    render(<PluginManagerTab rpc={fakeRpc(okCaps())} t={t} />)
    await screen.findByText('视觉路由')
    expect(document.querySelector('[data-plugin-count]')?.getAttribute('data-plugin-count')).toBe('2')
    expect(document.querySelector('[data-origin-badge="source-opensource"]')).toBeTruthy()
    expect(document.querySelector('[data-origin-badge="source-official"]')).toBeTruthy()
    expect(screen.getByText(en.enabledTag)).toBeTruthy()
    expect(screen.getByText(en.disabledTag)).toBeTruthy()
  })

  it('expands a detail row with origin basis and upstream', async () => {
    render(<PluginManagerTab rpc={fakeRpc(okCaps())} t={t} />)
    await screen.findByText('视觉路由')
    fireEvent.click(screen.getByText('视觉路由'))
    expect(await screen.findByText('https://github.com/example/vr')).toBeTruthy()
    expect(screen.getByText('Automatic')).toBeTruthy()
    // Lifecycle controls appear for a writable uninstallable row.
    expect(document.querySelector('[data-lifecycle-action="uninstall"]')).toBeTruthy()
    expect(document.querySelector('[data-lifecycle-action="disable"]')).toBeTruthy()
  })

  it('filters by source and search', async () => {
    render(<PluginManagerTab rpc={fakeRpc(okCaps())} t={t} />)
    await screen.findByText('视觉路由')
    const filter = screen.getByRole('combobox')
    fireEvent.change(filter, { target: { value: 'official' } })
    expect(screen.queryByText('视觉路由')).toBeNull()
    fireEvent.change(filter, { target: { value: 'all' } })
    const search = screen.getByLabelText(en.search)
    fireEvent.change(search, { target: { value: 'vision-router' } })
    expect(screen.getByText('视觉路由')).toBeTruthy()
    fireEvent.change(search, { target: { value: 'no-such' } })
    expect(screen.getByText(en.emptySearch)).toBeTruthy()
  })

  it('shows the read-only note without controls when persistence is read-only', async () => {
    const readOnly = { ...CAPS, persistence: 'read-only' as const }
    const rpc = fakeRpc(async () => ({ ok: true, value: readOnly }))
    render(<PluginManagerTab rpc={rpc} t={t} />)
    await screen.findByText('视觉路由')
    fireEvent.click(screen.getByText('视觉路由'))
    expect(await screen.findByText(en.lifecycleReadOnly)).toBeTruthy()
    expect((document.querySelector('[data-lifecycle-action="uninstall"]') as HTMLButtonElement | null)?.disabled).toBe(true)
  })

  it('renders an explicit error state with retry on channel failure', async () => {
    render(<PluginManagerTab rpc={fakeRpc(async () => ({ ok: false, code: 'UNAVAILABLE' }))} t={t} />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain(en.channelUnavailable)
    expect(screen.getByRole('button', { name: en.retry })).toBeTruthy()
  })

  it('renders loading copy before the first response', () => {
    render(<PluginManagerTab rpc={fakeRpc(okCaps())} t={t} />)
    expect(screen.getByText(en.loading)).toBeTruthy()
  })
})

describe('PluginManagerTab lifecycle flows', () => {
  /** Full happy-path handler: disable toggle succeeds after one poll. */
  function toggleFlowRpc(): { rpc: ChannelCaller; calls: string[] } {
    const calls: string[] = []
    const rpc = fakeRpc(async (endpoint, payload) => {
      calls.push(endpoint)
      if (endpoint === 'capabilities') return { ok: true, value: calls.length <= 2 ? CAPS : { ...CAPS, entries: [CAPS.entries[1]!] } }
      if (endpoint === 'preview') {
        const request = payload as { action: string }
        return { ok: true, value: { protocolVersion: 1, token: 't'.repeat(32), expiresAt: 2, action: request.action, entryId: 'include:vision-router', packageName: 'dsh-vision-router', affectedEntryIds: ['include:vision-router'], restartRequired: false } }
      }
      if (endpoint === 'execute') return { ok: true, value: { protocolVersion: 1, operationId: 'op-1', state: 'running' } }
      return { ok: true, value: { protocolVersion: 1, operationId: 'op-1', state: 'succeeded', action: 'disable', errorCode: null, restartRequired: false } }
    })
    return { rpc, calls }
  }

  it('drives disable through preview, execute, and operation polling', async () => {
    const { rpc, calls } = toggleFlowRpc()
    render(<PluginManagerTab rpc={rpc} t={t} />)
    await screen.findByText('视觉路由')
    fireEvent.click(screen.getByText('视觉路由'))
    const disable = await waitFor(() => document.querySelector('[data-lifecycle-action="disable"]') as HTMLButtonElement)
    expect(disable).toBeTruthy()
    fireEvent.click(disable)
    await waitFor(() => { expect(calls).toContain('preview') })
    await waitFor(() => { expect(calls).toContain('execute') })
    await waitFor(() => { expect(calls).toContain('operation') })
    // After the terminal poll the roster reloads: the disabled entry left
    // the mock's post-toggle world (its second snapshot drops it), proving
    // the full preview → execute → poll → reload cycle ran.
    await waitFor(() => { expect(screen.queryByText('视觉路由')).toBeNull() }, { timeout: 5_000 })
    expect(calls.filter(call => call === 'capabilities').length).toBeGreaterThanOrEqual(2)
  }, 10_000)

  it('surfaces a structured preview failure on the row', async () => {
    const rpc = fakeRpc(async endpoint => {
      if (endpoint === 'capabilities') return { ok: true, value: CAPS }
      if (endpoint === 'preview') return { ok: false, code: 'PROTECTED_PLUGIN' }
      return { ok: false, code: 'INTERNAL' }
    })
    render(<PluginManagerTab rpc={rpc} t={t} />)
    await screen.findByText('视觉路由')
    fireEvent.click(screen.getByText('视觉路由'))
    fireEvent.click(await waitFor(() => document.querySelector('[data-lifecycle-action="uninstall"]') as HTMLButtonElement))
    expect(await screen.findByText(en.lifecycleErrorProtectedPlugin)).toBeTruthy()
  })

  it('requires two-stage confirmation before uninstall executes', async () => {
    const calls: string[] = []
    const rpc = fakeRpc(async (endpoint, payload) => {
      calls.push(endpoint)
      if (endpoint === 'capabilities') return { ok: true, value: CAPS }
      if (endpoint === 'preview') {
        return { ok: true, value: { protocolVersion: 1, token: 'u'.repeat(32), expiresAt: 2, action: 'uninstall', entryId: 'include:vision-router', packageName: 'dsh-vision-router', affectedEntryIds: ['include:vision-router'], restartRequired: true } }
      }
      if (endpoint === 'execute') return { ok: true, value: { protocolVersion: 1, operationId: 'op-2', state: 'running' } }
      return { ok: true, value: { protocolVersion: 1, operationId: 'op-2', state: 'succeeded', action: 'uninstall', errorCode: null, restartRequired: true } }
    })
    render(<PluginManagerTab rpc={rpc} t={t} />)
    await screen.findByText('视觉路由')
    fireEvent.click(screen.getByText('视觉路由'))
    fireEvent.click(await waitFor(() => document.querySelector('[data-lifecycle-action="uninstall"]') as HTMLButtonElement))
    // The confirm screen appears; execute must NOT have run yet.
    expect(await screen.findByText(en.lifecycleConfirmTitle)).toBeTruthy()
    expect(calls).not.toContain('execute')
    // Cancel returns to idle without executing.
    fireEvent.click(document.querySelector('[data-lifecycle-action="cancel-uninstall"]') as HTMLButtonElement)
    expect(document.querySelector('[data-lifecycle-state="idle"]')).toBeTruthy()
    expect(calls).not.toContain('execute')
  })

  it('localizes every channel error code an operation can report', async () => {
    const codes = ['READ_ONLY_REMOTE', 'ENTRY_NOT_FOUND', 'PROTECTED_PLUGIN', 'TIMEOUT', 'ROLLBACK_INCOMPLETE', 'INCOMPATIBLE', 'PROTOCOL_INVALID', 'WEIRD_FUTURE'] as const
    for (const code of codes) {
      const copy = lifecycleErrorText(code, t)
      expect(copy.length, code).toBeGreaterThan(3)
    }
    // Unknown codes append the raw code instead of going blank.
    expect(lifecycleErrorText('WEIRD_FUTURE', t)).toContain('WEIRD_FUTURE')
  })
})
