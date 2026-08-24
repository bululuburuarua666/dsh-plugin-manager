// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject, NS } from '../src/client/index.ts'
import { PluginInventorySettingsTab } from '../src/client/PluginInventorySettingsTab.tsx'
import type { PluginInventorySettingsTabInjected } from '../src/client/PluginInventorySettingsTab.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

const EMPTY = { entries: [] }
type ListResult =
  | { readonly ok: true; readonly value: typeof EMPTY }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** Shared remote-method result shape for the lifecycle namespace mocks. */
type LifecycleMethodResult = Promise<{
  readonly ok: boolean
  readonly value?: { readonly marker: string }
  readonly error?: { readonly code: string; readonly message?: string }
}>

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)
  const list = vi.fn<() => Promise<ListResult>>()
    .mockResolvedValue({ ok: true, value: EMPTY })
  ctx.provide('remote.pluginInventory', { list })
  const lifecycleMethod = vi.fn(async (): LifecycleMethodResult => ({ ok: true, value: { marker: 'lifecycle-value' } }))
  const capabilities = vi.fn(async (...args: unknown[]): LifecycleMethodResult => {
    // Zero-argument pin: the adapter must call capabilities with NO args.
    expect(args).toHaveLength(0)
    return { ok: true, value: { marker: 'lifecycle-value' } }
  })
  const preview = vi.fn(async (...args: unknown[]): LifecycleMethodResult => {
    expect(args).toHaveLength(1)
    return { ok: true, value: { marker: 'lifecycle-value' } }
  })
  ctx.provide('remote.pluginLifecycle', {
    capabilities,
    preview,
    execute: lifecycleMethod,
    operation: lifecycleMethod,
  })
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, list, lifecycleMethod, capabilities, preview }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-plugin-inventory browser plugin', () => {
  it('declares only the services used by the Settings Remote contribution', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.pluginInventory'])
  })

  it('registers a localized tab without reading the Remote eagerly', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entry = b.slots.entries('settings.plugins.tab')[0]!
    expect(entry.component).toBe(PluginInventorySettingsTab)
    expect(entry.options).toMatchObject({ id: 'all', order: 10 })
    expect(entry.locale).toBe(NS)
    expect(resolveSlotLabel(entry.options.label)).toBe('插件列表')
    expect(b.list).not.toHaveBeenCalled()

    const injected = (entry.inject as unknown as () => PluginInventorySettingsTabInjected)()
    await expect(injected.list()).resolves.toEqual(EMPTY)
    expect(b.list).toHaveBeenCalledOnce()
    b.list.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_ERROR', message: 'unavailable' } })
    await expect(injected.list()).rejects.toThrow('pluginInventory.list failed: REMOTE_ERROR: unavailable')

    // The lifecycle face passes Remote results through with codes surfaced,
    // calling zero-arg methods with no arguments and one-arg methods with
    // exactly one (the gateway validates arity before dispatch).
    await expect(injected.lifecycle.capabilities()).resolves.toEqual({
      ok: true,
      value: { marker: 'lifecycle-value' },
    })
    expect(b.capabilities).toHaveBeenCalledTimes(1)
    expect(b.capabilities.mock.calls[0]).toHaveLength(0)
    await expect(injected.lifecycle.preview({ entryId: 'a', action: 'disable', expectedRevision: 'r' }))
      .resolves.toEqual({ ok: true, value: { marker: 'lifecycle-value' } })
    expect(b.preview).toHaveBeenCalledTimes(1)
    expect(b.preview.mock.calls[0]).toHaveLength(1)
    expect(b.preview).toHaveBeenCalledWith({ entryId: 'a', action: 'disable', expectedRevision: 'r' })
    b.lifecycleMethod.mockResolvedValueOnce({ ok: false, error: { code: 'PROFILE_CHANGED', message: 'drifted' } })
    await expect(injected.lifecycle.execute({ token: 'tok' }))
      .resolves.toEqual({ ok: false, code: 'PROFILE_CHANGED' })
    b.lifecycleMethod.mockRejectedValueOnce(new Error('transport vanished'))
    await expect(injected.lifecycle.execute({ token: 't' })).resolves.toEqual({ ok: false, code: 'INTERNAL' })
    b.lifecycleMethod.mockResolvedValueOnce({ ok: false })
    await expect(injected.lifecycle.execute({ token: 't2' })).resolves.toEqual({ ok: false, code: 'INTERNAL' })
    await expect(injected.lifecycle.operation({ operationId: 'op' }))
      .resolves.toEqual({ ok: true, value: { marker: 'lifecycle-value' } })
    await b.ctx.fiber.dispose()
  })

  it('degrades the lifecycle face to UNAVAILABLE without the namespace', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const locale = new LocaleRuntime(ctx)
    ctx.provide('locale', locale)
    class BareRemoteService extends Service {
      constructor(serviceCtx: Context) {
        super(serviceCtx, 'remote')
      }
    }
    new BareRemoteService(ctx)
    ctx.provide('remote.pluginInventory', {
      list: async () => ({ ok: true as const, value: EMPTY }),
    })
    // No remote.pluginLifecycle registration: the older-Host shape. The lazy
    // face reads the store via ctx.get (no inject requirement), so the tab
    // still mounts and every lifecycle call fails closed with UNAVAILABLE.
    await ctx.plugin({ inject: [...inject], apply }).await()
    const slots = ctx.get('slots') as SlotRegistry
    const stop = declare(slots)
    const entry = slots.entries('settings.plugins.tab')[0]!
    const injected = (entry.inject as unknown as () => PluginInventorySettingsTabInjected)()
    await expect(injected.lifecycle.capabilities()).resolves.toEqual({ ok: false, code: 'UNAVAILABLE' })
    await expect(injected.lifecycle.preview({ entryId: 'a', action: 'disable', expectedRevision: 'r' }))
      .resolves.toEqual({ ok: false, code: 'UNAVAILABLE' })
    stop()
    await ctx.fiber.dispose()
  })

  it('recovers once the namespace mounts after a first UNAVAILABLE call', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const locale = new LocaleRuntime(ctx)
    ctx.provide('locale', locale)
    class LateRemoteService extends Service {
      constructor(serviceCtx: Context) {
        super(serviceCtx, 'remote')
      }
    }
    new LateRemoteService(ctx)
    ctx.provide('remote.pluginInventory', {
      list: async () => ({ ok: true as const, value: EMPTY }),
    })
    await ctx.plugin({ inject: [...inject], apply }).await()
    const slots = ctx.get('slots') as SlotRegistry
    const stop = declare(slots)
    const entry = slots.entries('settings.plugins.tab')[0]!
    const injected = (entry.inject as unknown as () => PluginInventorySettingsTabInjected)()
    // First call: the namespace is not mounted yet.
    await expect(injected.lifecycle.capabilities()).resolves.toEqual({ ok: false, code: 'UNAVAILABLE' })
    // The adapter re-reads the store per call, so a late mount is picked up
    // without recreating the face.
    ctx.provide('remote.pluginLifecycle', {
      capabilities: async () => ({ ok: true, value: { marker: 'late-mount' } }),
    })
    await expect(injected.lifecycle.capabilities()).resolves.toEqual({
      ok: true,
      value: { marker: 'late-mount' },
    })
    stop()
    await ctx.fiber.dispose()
  })

  it('follows locale and recovers across late declaration and declarer reload', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)

    const stop = declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.plugins.tab')).toHaveLength(1) })
    b.locale.setLocale('en')
    expect(resolveSlotLabel(b.slots.entries('settings.plugins.tab')[0]!.options.label)).toBe('Plugin list')

    stop()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)
    declare(b.slots)
    await vi.waitFor(() => {
      expect(b.slots.entries('settings.plugins.tab')[0]?.component).toBe(PluginInventorySettingsTab)
    })

    await fiber.dispose()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)
    expect(() => b.locale.register(NS, 'zh', {})).not.toThrow()
    await b.ctx.fiber.dispose()
  })
})
