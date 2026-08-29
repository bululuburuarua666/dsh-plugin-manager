// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PluginManagerTab } from '../../src/client/PluginManagerTab.tsx'
import type { ChannelCaller, ClientCapabilities, ClientResult } from '../../src/client/protocol.ts'
import { en, type ManagerLocaleKey } from '../../src/client/locales.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const t = (key: ManagerLocaleKey): string => en[key]

const baseEntry = (overrides: Partial<ClientCapabilities['entries'][number]> = {}): ClientCapabilities['entries'][number] => ({
  entryId: 'include:plugin-x',
  moduleName: 'dsh-plugin-x',
  enabled: false,
  origin: { kind: 'opensource', customized: false, upstream: null, fork: null, branch: null, note: null, declaredBy: 'heuristic' },
  detectedOrigin: { kind: 'opensource', customized: false, upstream: null, fork: null, branch: null, note: null, declaredBy: 'heuristic' },
  title: { zh: '插件X', en: 'Plugin X' },
  description: null,
  packageName: 'dsh-plugin-x',
  canToggle: true,
  canUninstall: true,
  toggleBlockReason: null,
  uninstallBlockReason: null,
  ...overrides,
})

const CAPS = (entries: ClientCapabilities['entries'][number][]): ClientCapabilities => ({
  protocolVersion: 1,
  revision: 'rev-1',
  persistence: 'writable',
  entries,
})

type Handler = (endpoint: string, payload: unknown) => Promise<ClientResult<unknown>>

function fakeRpc(handler: Handler): ChannelCaller {
  return {
    call: async (_channel, endpoint, payload) => {
      const result = await handler(endpoint, payload)
      if (result.ok) return { ok: true, value: result.value }
      return { ok: false, error: { code: result.code, message: result.message } }
    },
  }
}

const previewValue = (action: string) => ({
  protocolVersion: 1,
  token: 'k'.repeat(32),
  expiresAt: 2,
  action,
  entryId: 'include:plugin-x',
  packageName: 'dsh-plugin-x',
  affectedEntryIds: ['include:plugin-x'],
  restartRequired: action === 'uninstall',
})

describe('PluginManagerTab remaining coverage arms', () => {
  it('recovers from an error state through the retry button', async () => {
    let failing = true
    const rpc = fakeRpc(async endpoint => {
      if (endpoint === 'capabilities') {
        if (failing) return { ok: false, code: 'UNAVAILABLE' }
        return { ok: true, value: CAPS([baseEntry()]) }
      }
      return { ok: false, code: 'INTERNAL' }
    })
    render(<PluginManagerTab rpc={rpc} t={t} />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    failing = false
    await waitFor(() => { fireEvent.click(screen.getByRole('button', { name: en.retry })) })
    await screen.findByText('插件X', undefined, { timeout: 3_000 })
  })

  it('drives enable through the full cycle for a disabled row', async () => {
    const calls: string[] = []
    const rpc = fakeRpc(async (endpoint, payload) => {
      calls.push(endpoint)
      if (endpoint === 'capabilities') {
        return { ok: true, value: calls.filter(c => c === 'capabilities').length <= 1 ? CAPS([baseEntry()]) : CAPS([]) }
      }
      if (endpoint === 'preview') return { ok: true, value: previewValue((payload as { action: string }).action) }
      if (endpoint === 'execute') return { ok: true, value: { protocolVersion: 1, operationId: 'op-e', state: 'running' } }
      return { ok: true, value: { protocolVersion: 1, operationId: 'op-e', state: 'succeeded', action: 'enable', errorCode: null, restartRequired: false } }
    })
    render(<PluginManagerTab rpc={rpc} t={t} />)
    await screen.findByText('插件X')
    fireEvent.click(screen.getByText('插件X'))
    const enable = await waitFor(() => document.querySelector('[data-lifecycle-action="enable"]') as HTMLButtonElement)
    expect(enable).toBeTruthy()
    fireEvent.click(enable)
    await waitFor(() => { expect(calls).toContain('execute') })
    // Roster reloads to the post-enable world (empty here).
    await waitFor(() => { expect(screen.queryByText('插件X')).toBeNull() }, { timeout: 4_000 })
  }, 8_000)

  it('drives a confirmed uninstall through preview → confirm → execute → poll', async () => {
    const calls: string[] = []
    const rpc = fakeRpc(async (endpoint, payload) => {
      calls.push(endpoint)
      if (endpoint === 'capabilities') {
        return { ok: true, value: calls.filter(c => c === 'capabilities').length <= 1 ? CAPS([baseEntry({ enabled: true })]) : CAPS([]) }
      }
      if (endpoint === 'preview') return { ok: true, value: previewValue((payload as { action: string }).action) }
      if (endpoint === 'execute') return { ok: true, value: { protocolVersion: 1, operationId: 'op-u', state: 'running' } }
      return { ok: true, value: { protocolVersion: 1, operationId: 'op-u', state: 'succeeded', action: 'uninstall', errorCode: null, restartRequired: true } }
    })
    render(<PluginManagerTab rpc={rpc} t={t} />)
    await screen.findByText('插件X')
    fireEvent.click(screen.getByText('插件X'))
    fireEvent.click(await waitFor(() => document.querySelector('[data-lifecycle-action="uninstall"]') as HTMLButtonElement))
    expect(await screen.findByText(en.lifecycleConfirmTitle)).toBeTruthy()
    fireEvent.click(document.querySelector('[data-lifecycle-action="confirm-uninstall"]') as HTMLButtonElement)
    await waitFor(() => { expect(calls).toContain('execute') })
    await waitFor(() => { expect(screen.queryByText('插件X')).toBeNull() }, { timeout: 4_000 })
    expect(calls.filter(c => c === 'preview').length).toBeGreaterThanOrEqual(2)
  }, 8_000)

  it('surfaces an execute failure after a good preview', async () => {
    const rpc = fakeRpc(async endpoint => {
      if (endpoint === 'capabilities') return { ok: true, value: CAPS([baseEntry()]) }
      if (endpoint === 'preview') return { ok: true, value: previewValue('enable') }
      if (endpoint === 'execute') return { ok: false, code: 'BUSY' }
      return { ok: false, code: 'INTERNAL' }
    })
    render(<PluginManagerTab rpc={rpc} t={t} />)
    await screen.findByText('插件X')
    fireEvent.click(screen.getByText('插件X'))
    fireEvent.click(await waitFor(() => document.querySelector('[data-lifecycle-action="enable"]') as HTMLButtonElement))
    expect(await screen.findByText(en.lifecycleErrorBusy)).toBeTruthy()
  })

  it('surfaces a failed terminal operation with its errorCode', async () => {
    const rpc = fakeRpc(async endpoint => {
      if (endpoint === 'capabilities') return { ok: true, value: CAPS([baseEntry()]) }
      if (endpoint === 'preview') return { ok: true, value: previewValue('enable') }
      if (endpoint === 'execute') return { ok: true, value: { protocolVersion: 1, operationId: 'op-f', state: 'running' } }
      return { ok: true, value: { protocolVersion: 1, operationId: 'op-f', state: 'failed', action: 'enable', errorCode: 'TIMEOUT', restartRequired: false } }
    })
    render(<PluginManagerTab rpc={rpc} t={t} />)
    await screen.findByText('插件X')
    fireEvent.click(screen.getByText('插件X'))
    fireEvent.click(await waitFor(() => document.querySelector('[data-lifecycle-action="enable"]') as HTMLButtonElement))
    expect(await screen.findByText(en.lifecycleErrorTimeout)).toBeTruthy()
  })

  it('surfaces a poll transport failure', async () => {
    const rpc = fakeRpc(async endpoint => {
      if (endpoint === 'capabilities') return { ok: true, value: CAPS([baseEntry()]) }
      if (endpoint === 'preview') return { ok: true, value: previewValue('enable') }
      if (endpoint === 'execute') return { ok: true, value: { protocolVersion: 1, operationId: 'op-t', state: 'running' } }
      return { ok: false, code: 'UNAVAILABLE' }
    })
    render(<PluginManagerTab rpc={rpc} t={t} />)
    await screen.findByText('插件X')
    fireEvent.click(screen.getByText('插件X'))
    fireEvent.click(await waitFor(() => document.querySelector('[data-lifecycle-action="enable"]') as HTMLButtonElement))
    expect(await screen.findByText(en.channelUnavailable)).toBeTruthy()
  })

  it('renders the empty roster copy', async () => {
    const rpc = fakeRpc(async endpoint => (endpoint === 'capabilities' ? { ok: true, value: CAPS([]) } : { ok: false, code: 'INTERNAL' }))
    render(<PluginManagerTab rpc={rpc} t={t} />)
    expect(await screen.findByText(en.empty)).toBeTruthy()
  })

  it('keeps polling through queued states before the terminal one', async () => {
    let polls = 0
    const rpc = fakeRpc(async endpoint => {
      if (endpoint === 'capabilities') return { ok: true, value: CAPS([baseEntry()]) }
      if (endpoint === 'preview') return { ok: true, value: previewValue('enable') }
      if (endpoint === 'execute') return { ok: true, value: { protocolVersion: 1, operationId: 'op-q', state: 'running' } }
      polls += 1
      if (polls === 1) return { ok: true, value: { protocolVersion: 1, operationId: 'op-q', state: 'running', action: 'enable', errorCode: null, restartRequired: false } }
      return { ok: true, value: { protocolVersion: 1, operationId: 'op-q', state: 'succeeded', action: 'enable', errorCode: null, restartRequired: false } }
    })
    render(<PluginManagerTab rpc={rpc} t={t} />)
    await screen.findByText('插件X')
    fireEvent.click(screen.getByText('插件X'))
    fireEvent.click(await waitFor(() => document.querySelector('[data-lifecycle-action="enable"]') as HTMLButtonElement))
    await waitFor(() => { expect(polls).toBeGreaterThanOrEqual(2) }, { timeout: 4_000 })
  }, 8_000)

  it('cleans up poll timers on unmount', async () => {
    const rpc = fakeRpc(async endpoint => {
      if (endpoint === 'capabilities') return { ok: true, value: CAPS([baseEntry()]) }
      if (endpoint === 'preview') return { ok: true, value: previewValue('enable') }
      if (endpoint === 'execute') return { ok: true, value: { protocolVersion: 1, operationId: 'op-c', state: 'running' } }
      return { ok: true, value: { protocolVersion: 1, operationId: 'op-c', state: 'running', action: 'enable', errorCode: null, restartRequired: false } }
    })
    const view = render(<PluginManagerTab rpc={rpc} t={t} />)
    await screen.findByText('插件X')
    fireEvent.click(screen.getByText('插件X'))
    fireEvent.click(await waitFor(() => document.querySelector('[data-lifecycle-action="enable"]') as HTMLButtonElement))
    await waitFor(() => { expect(document.querySelector('[data-lifecycle-state="working"]')).toBeTruthy() })
    view.unmount()
    // No crash and no further updates after unmount.
    await new Promise(resolve => { setTimeout(resolve, 700) })
  })

  it('renders the unavailable copy for rows with no capabilities', async () => {
    const rpc = fakeRpc(async endpoint => (endpoint === 'capabilities'
      ? { ok: true, value: CAPS([baseEntry({ canToggle: false, canUninstall: false, toggleBlockReason: 'read-only-remote', uninstallBlockReason: 'not-direct-dependency' })]) }
      : { ok: false, code: 'INTERNAL' }))
    render(<PluginManagerTab rpc={rpc} t={t} />)
    await screen.findByText('插件X')
    fireEvent.click(screen.getByText('插件X'))
    expect(await screen.findByText(en.lifecycleUnavailable)).toBeTruthy()
  })

  it('covers customized badges, fork/branch/detail fields, and null-package confirm copy', async () => {
    const rpc = fakeRpc(async endpoint => (endpoint === 'capabilities'
      ? { ok: true, value: CAPS([baseEntry({
          enabled: true,
          packageName: null,
          origin: { kind: 'opensource', customized: true, upstream: 'https://example.com/up', fork: 'https://example.com/fork', branch: 'dev', note: null, declaredBy: 'heuristic' },
          description: { zh: '带描述', en: 'Has description' },
        })]) }
      : { ok: true, value: { protocolVersion: 1, token: 'n'.repeat(32), expiresAt: 2, action: 'uninstall', entryId: 'include:plugin-x', packageName: null, affectedEntryIds: ['include:plugin-x'], restartRequired: true } }))
    render(<PluginManagerTab rpc={rpc} t={t} />)
    await screen.findByText(en.sourceOpensourceCustomized)
    fireEvent.click(screen.getByText(en.sourceOpensourceCustomized))
    expect(await screen.findByText('https://example.com/fork')).toBeTruthy()
    expect(screen.getByText('dev')).toBeTruthy()
    expect(screen.getByText('带描述')).toBeTruthy()
    fireEvent.click(document.querySelector('[data-lifecycle-action="uninstall"]') as HTMLButtonElement)
    expect(await screen.findByText(en.lifecycleConfirmTitle)).toBeTruthy()
    // The confirm copy falls back to the module name when packageName is null.
    expect(screen.getByText(`${en.lifecyclePackage}: dsh-plugin-x`)).toBeTruthy()
  })

  it('normalizes a terminal operation with a null errorCode to INTERNAL copy', async () => {
    const rpc = fakeRpc(async endpoint => {
      if (endpoint === 'capabilities') return { ok: true, value: CAPS([baseEntry()]) }
      if (endpoint === 'preview') return { ok: true, value: previewValue('enable') }
      if (endpoint === 'execute') return { ok: true, value: { protocolVersion: 1, operationId: 'op-n', state: 'running' } }
      return { ok: true, value: { protocolVersion: 1, operationId: 'op-n', state: 'failed', action: 'enable', errorCode: null, restartRequired: false } }
    })
    render(<PluginManagerTab rpc={rpc} t={t} />)
    await screen.findByText('插件X')
    fireEvent.click(screen.getByText('插件X'))
    fireEvent.click(await waitFor(() => document.querySelector('[data-lifecycle-action="enable"]') as HTMLButtonElement))
    expect(await screen.findByText(en.lifecycleErrorInternal)).toBeTruthy()
  })

  it('covers user-override and manifest origin bases plus row collapse', async () => {
    const rpc = fakeRpc(async endpoint => (endpoint === 'capabilities'
      ? { ok: true, value: CAPS([
          baseEntry({ entryId: 'include:ov', origin: { ...baseEntry().origin, declaredBy: 'user-override' } }),
          baseEntry({ entryId: 'include:mf', title: { zh: '插件M', en: 'Plugin M' }, origin: { ...baseEntry().origin, declaredBy: 'manifest' } }),
        ]) }
      : { ok: false, code: 'INTERNAL' }))
    render(<PluginManagerTab rpc={rpc} t={t} />)
    await screen.findByText('插件X')
    fireEvent.click(screen.getAllByText('插件X')[0]!)
    expect(await screen.findByText(en.basisUserOverride)).toBeTruthy()
    fireEvent.click(screen.getAllByText('插件X')[0]!) // collapse again
    expect(screen.queryByText(en.basisUserOverride)).toBeNull()
    fireEvent.click(screen.getByText('插件M'))
    expect(await screen.findByText(en.basisManifest)).toBeTruthy()
  })

  it('surfaces a toggle preview failure with its code', async () => {
    const rpc = fakeRpc(async endpoint => {
      if (endpoint === 'capabilities') return { ok: true, value: CAPS([baseEntry()]) }
      if (endpoint === 'preview') return { ok: false, code: 'PROFILE_CHANGED' }
      return { ok: false, code: 'INTERNAL' }
    })
    render(<PluginManagerTab rpc={rpc} t={t} />)
    await screen.findByText('插件X')
    fireEvent.click(screen.getByText('插件X'))
    fireEvent.click(await waitFor(() => document.querySelector('[data-lifecycle-action="enable"]') as HTMLButtonElement))
    expect(await screen.findByText(en.lifecycleErrorProfileChanged)).toBeTruthy()
  })

  it('surfaces a confirm-stage preview failure after the confirm screen', async () => {
    let previewCount = 0
    const rpc = fakeRpc(async endpoint => {
      if (endpoint === 'capabilities') return { ok: true, value: CAPS([baseEntry({ enabled: true })]) }
      if (endpoint === 'preview') {
        previewCount += 1
        if (previewCount === 1) return { ok: true, value: previewValue('uninstall') }
        return { ok: false, code: 'ENTRY_CHANGED' }
      }
      return { ok: false, code: 'INTERNAL' }
    })
    render(<PluginManagerTab rpc={rpc} t={t} />)
    await screen.findByText('插件X')
    fireEvent.click(screen.getByText('插件X'))
    fireEvent.click(await waitFor(() => document.querySelector('[data-lifecycle-action="uninstall"]') as HTMLButtonElement))
    expect(await screen.findByText(en.lifecycleConfirmTitle)).toBeTruthy()
    fireEvent.click(document.querySelector('[data-lifecycle-action="confirm-uninstall"]') as HTMLButtonElement)
    expect(await screen.findByText(en.lifecycleErrorEntryChanged)).toBeTruthy()
  })

  it('surfaces a confirm-stage execute failure', async () => {
    const rpc = fakeRpc(async endpoint => {
      if (endpoint === 'capabilities') return { ok: true, value: CAPS([baseEntry({ enabled: true })]) }
      if (endpoint === 'preview') return { ok: true, value: previewValue('uninstall') }
      if (endpoint === 'execute') return { ok: false, code: 'ROLLBACK_INCOMPLETE' }
      return { ok: false, code: 'INTERNAL' }
    })
    render(<PluginManagerTab rpc={rpc} t={t} />)
    await screen.findByText('插件X')
    fireEvent.click(screen.getByText('插件X'))
    fireEvent.click(await waitFor(() => document.querySelector('[data-lifecycle-action="uninstall"]') as HTMLButtonElement))
    expect(await screen.findByText(en.lifecycleConfirmTitle)).toBeTruthy()
    fireEvent.click(document.querySelector('[data-lifecycle-action="confirm-uninstall"]') as HTMLButtonElement)
    expect(await screen.findByText(en.lifecycleErrorRollbackIncomplete)).toBeTruthy()
  })
})
