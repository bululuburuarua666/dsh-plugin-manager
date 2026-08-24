// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  PluginLifecycleCapabilities,
  PluginLifecycleExecuteResponse,
  PluginLifecycleOperationState,
  PluginLifecycleOperationView,
  PluginLifecyclePreview,
} from '@deepseek-ai/dsh-api-remotes/client'
import {
  PluginInventorySettingsTab,
  type PluginInventorySettingsTabInjected,
  type PluginInventorySettingsTabProps,
  type PluginLifecycleInjected,
  type PluginLifecycleResult,
} from '../src/client/PluginInventorySettingsTab.tsx'
import { en, type PluginInventoryLocaleKey } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

type Snapshot = Awaited<ReturnType<PluginInventorySettingsTabInjected['list']>>
const t = ((key: PluginInventoryLocaleKey): string => en[key]) as PluginInventorySettingsTabProps['t']

/** The face an older or read-only Host exposes: every call fails closed. */
const unavailableLifecycle: PluginLifecycleInjected = {
  capabilities: async () => ({ ok: false, code: 'UNAVAILABLE' }),
  preview: async () => ({ ok: false, code: 'UNAVAILABLE' }),
  execute: async () => ({ ok: false, code: 'UNAVAILABLE' }),
  operation: async () => ({ ok: false, code: 'UNAVAILABLE' }),
}

function props(
  list: PluginInventorySettingsTabInjected['list'],
  lifecycle: PluginLifecycleInjected = unavailableLifecycle,
): PluginInventorySettingsTabProps {
  return {
    t,
    list,
    lifecycle,
  } as PluginInventorySettingsTabProps
}

const emptyCard = { title: null, description: null } as const

const SNAPSHOT = {
  entries: [
    {
      entryId: '8a1b2c3d',
      moduleName: '@deepseek-ai/cordis-plugin-hmr',
      enabled: true,
      fiberPhase: 'active',
      updatedAt: 100,
      card: {
        title: { zh: '热更新插件', en: 'Hot Module Reload' },
        description: {
          zh: '在不刷新页面的情况下替换插件模块。',
          en: 'Replaces plugin modules without a page refresh.',
        },
      },
    },
    { entryId: 'pending', moduleName: 'cordis:pending-name', enabled: true, fiberPhase: 'pending', updatedAt: 300, card: emptyCard },
    { entryId: 'loading', moduleName: '@fixture/loading-name', enabled: true, fiberPhase: 'loading', updatedAt: 200, card: emptyCard },
    { entryId: 'failed', moduleName: '@fixture/failed-name', enabled: true, fiberPhase: 'failed', updatedAt: 400, card: emptyCard },
    { entryId: 'unloading', moduleName: '@fixture/unloading-name', enabled: true, fiberPhase: 'unloading', updatedAt: 700, card: emptyCard },
    { entryId: 'unobserved', moduleName: '@fixture/unobserved-name', enabled: true, fiberPhase: null, updatedAt: 600, card: emptyCard },
    { entryId: 'disabled-entry', moduleName: '@deepseek-ai/dsh-host-directory-picker-native', enabled: false, fiberPhase: null, updatedAt: 500, card: emptyCard },
  ],
} as unknown as Snapshot

describe('PluginInventorySettingsTab', () => {
  it('renders runtime status only for enabled plugins', async () => {
    const deferred = Promise.withResolvers<Snapshot>()
    const list = vi.fn(() => deferred.promise)
    const view = render(<PluginInventorySettingsTab {...props(list)} />)
    expect(screen.getByText(en.loading)).toBeTruthy()

    await act(async () => { deferred.resolve(SNAPSHOT) })
    expect(list).toHaveBeenCalledOnce()
    expect(screen.getByRole('searchbox', { name: en.search })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: en.sortBy })).toBeTruthy()
    expect(screen.getByRole('heading', { name: en.catalog })).toBeTruthy()
    expect(view.container.querySelector('[data-plugin-count]')?.textContent).toBe('7')
    expect(screen.getAllByRole('listitem')).toHaveLength(7)
    expect(screen.getAllByText(en.enabledTag)).toHaveLength(6)
    expect(screen.getByText(en.disabledTag)).toBeTruthy()
    for (const value of [
      'Mounted',
      'Waiting for dependencies',
      'Loading',
      'Mount failed',
      'Unloading',
      'Not mounted',
    ]) {
      expect(screen.getByRole('img', { name: value })).toBeTruthy()
    }
    const active = screen.getByRole('button', { name: 'hmr, Mounted, Enabled' })
    expect(active.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(active)
    expect(active.getAttribute('aria-expanded')).toBe('true')
    expect(view.container.querySelector('[data-loader-entry]')?.textContent).toBe('8a1b2c3d')
    expect(screen.getByText(en.configuration)).toBeTruthy()
    expect(screen.getByText(en.cordis)).toBeTruthy()
    expect(screen.getByText(en.updated)).toBeTruthy()
    expect(view.container.querySelector('time')?.getAttribute('dateTime')).toBe(new Date(100).toISOString())
    fireEvent.click(active)
    expect(view.container.querySelector('[data-loader-entry]')).toBeNull()

    fireEvent.click(active)
    fireEvent.change(screen.getByRole('searchbox', { name: en.search }), {
      target: { value: 'disabled-entry' },
    })
    expect(view.container.querySelector('[data-loader-entry]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'directory-picker-native, Disabled' }))
    expect(screen.getAllByText(en.disabledTag)).toHaveLength(2)
    expect(screen.queryByText(en.cordis)).toBeNull()
    expect(screen.queryByText(en.unobserved)).toBeNull()
  })

  it('filters by module name or Loader entry id', async () => {
    render(<PluginInventorySettingsTab {...props(async () => SNAPSHOT)} />)
    const search = await screen.findByRole('searchbox', { name: en.search })

    fireEvent.change(search, { target: { value: 'disabled-entry' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByText('directory-picker-native')).toBeTruthy()

    fireEvent.change(search, { target: { value: 'cordis-plugin-hmr' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByText('hmr')).toBeTruthy()

    fireEvent.change(search, { target: { value: 'not-a-plugin' } })
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    expect(screen.getByText(en.emptySearch)).toBeTruthy()
  })

  it('keeps Loader order by default and sorts newest-first by time', async () => {
    const view = render(<PluginInventorySettingsTab {...props(async () => SNAPSHOT)} />)
    const sort = await screen.findByRole('combobox', { name: en.sortBy })
    const entryIds = () => [...view.container.querySelectorAll<HTMLElement>('[data-plugin-entry]')]
      .map(element => element.dataset.pluginEntry)

    expect((sort as HTMLSelectElement).value).toBe('loader')
    expect(entryIds()).toEqual(['8a1b2c3d', 'pending', 'loading', 'failed', 'unloading', 'unobserved', 'disabled-entry'])

    fireEvent.change(sort, { target: { value: 'updated' } })
    expect((sort as HTMLSelectElement).value).toBe('updated')
    expect(entryIds()).toEqual(['unloading', 'unobserved', 'disabled-entry', 'failed', 'pending', 'loading', '8a1b2c3d'])
  })

  it('shows the bilingual detail card after a two-second hover dwell', async () => {
    render(<PluginInventorySettingsTab {...props(async () => SNAPSHOT)} />)
    const first = await screen.findByRole('button', { name: 'hmr, Mounted, Enabled' })

    vi.useFakeTimers()
    fireEvent.pointerEnter(first)
    act(() => { vi.advanceTimersByTime(1_999) })
    expect(screen.queryByRole('tooltip')).toBeNull()

    act(() => { vi.advanceTimersByTime(1) })
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip.textContent).toContain('热更新插件')
    expect(tooltip.textContent).toContain('在不刷新页面的情况下替换插件模块。')
    expect(tooltip.textContent).toContain('Hot Module Reload')
    expect(tooltip.textContent).toContain('Replaces plugin modules without a page refresh.')
    expect(tooltip.textContent).toContain('@deepseek-ai/cordis-plugin-hmr')

    fireEvent.pointerLeave(first)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('shows a generic failure and retries into the empty state', async () => {
    const list = vi.fn<PluginInventorySettingsTabInjected['list']>()
      .mockRejectedValueOnce(new Error('private transport detail'))
      .mockResolvedValueOnce({ entries: [] })
    render(<PluginInventorySettingsTab {...props(list)} />)

    expect((await screen.findByRole('alert')).textContent).toBe(en.error)
    expect(screen.queryByText('private transport detail')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(2) })
    expect(await screen.findByText(en.empty)).toBeTruthy()
  })

  it('contains a synchronous Remote failure and ignores a result after unmount', async () => {
    const syncFailure = vi.fn(() => { throw new Error('namespace unavailable') }) as PluginInventorySettingsTabInjected['list']
    const failed = render(<PluginInventorySettingsTab {...props(syncFailure)} />)
    expect((await screen.findByRole('alert')).textContent).toBe(en.error)
    failed.unmount()

    const deferred = Promise.withResolvers<Snapshot>()
    const pending = render(<PluginInventorySettingsTab {...props(() => deferred.promise)} />)
    pending.unmount()
    await act(async () => { deferred.resolve(SNAPSHOT) })

    const deferredFailure = Promise.withResolvers<Snapshot>()
    const pendingFailure = render(<PluginInventorySettingsTab {...props(() => deferredFailure.promise)} />)
    pendingFailure.unmount()
    await act(async () => { deferredFailure.reject(new Error('late failure')) })
  })
})

describe('PluginInventorySettingsTab origins', () => {
  const originOf = (kind: 'official' | 'personal' | 'opensource', extra: Record<string, unknown> = {}) => ({
    kind,
    customized: false,
    upstream: null,
    fork: null,
    branch: null,
    note: null,
    declaredBy: 'heuristic',
    ...extra,
  })

  const ORIGIN_SNAPSHOT = {
    entries: [
      {
        entryId: 'official-entry', moduleName: '@deepseek-ai/dsh-llm', enabled: true, fiberPhase: 'active', updatedAt: 100, card: emptyCard,
        origin: originOf('official'),
      },
      {
        entryId: 'personal-entry', moduleName: 'dsh-update-checker', enabled: true, fiberPhase: 'active', updatedAt: 200, card: emptyCard,
        origin: originOf('personal', { note: { zh: '自主构建', en: 'self-built' }, declaredBy: 'user-override' }),
      },
      {
        entryId: 'oss-entry', moduleName: 'dsh-vision-router', enabled: false, fiberPhase: null, updatedAt: 300, card: emptyCard,
        origin: originOf('opensource', { upstream: 'https://github.com/ysr666/dsh-vision-router' }),
      },
      {
        entryId: 'oss-custom-entry', moduleName: 'dsh-forked', enabled: true, fiberPhase: 'active', updatedAt: 400, card: emptyCard,
        origin: originOf('opensource', { customized: true, upstream: 'https://github.com/a/b', fork: 'https://github.com/me/b', branch: 'my-tweaks', declaredBy: 'manifest' }),
      },
      {
        entryId: 'weird-entry', moduleName: 'dsh-weird', enabled: true, fiberPhase: 'active', updatedAt: 500, card: emptyCard,
        origin: originOf('opensource', { upstream: 'ftp://example.com/x' }),
      },
      { entryId: 'legacy-entry', moduleName: 'legacy-plugin', enabled: true, fiberPhase: 'active', updatedAt: 600, card: emptyCard },
    ],
  } as unknown as Snapshot

  it('renders text badges for the four origin states and none for unclassified entries', async () => {
    const view = render(<PluginInventorySettingsTab {...props(async () => ORIGIN_SNAPSHOT)} />)
    await screen.findByRole('searchbox', { name: en.search })
    const badges = [...view.container.querySelectorAll<HTMLElement>('[data-origin]')]
    expect(badges.map(badge => badge.dataset.origin)).toEqual(['official', 'personal', 'opensource', 'opensource', 'opensource'])
    expect(badges.map(badge => badge.textContent)).toEqual([
      en.sourceOfficial,
      en.sourcePersonal,
      en.sourceOpensource,
      en.sourceOpensourceCustomized,
      en.sourceOpensource,
    ])
    expect(view.container.querySelector('[data-origin="official"]')).toBeTruthy()
    expect(view.container.querySelector('[data-origin="opensource"][data-customized="true"]')?.textContent)
      .toBe(en.sourceOpensourceCustomized)
  })

  it('filters by source, intersects with search, and shows filtered counts', async () => {
    const view = render(<PluginInventorySettingsTab {...props(async () => ORIGIN_SNAPSHOT)} />)
    const filter = await screen.findByRole('combobox', { name: en.filterBySource })
    const items = () => screen.getAllByRole('listitem')
    const count = () => view.container.querySelector('[data-plugin-count]')

    expect(items()).toHaveLength(6)
    expect(count()?.textContent).toBe('6')
    // The unclassified option exists only because one entry lacks an origin.
    expect([...filter.querySelectorAll('option')].map(option => option.textContent)).toContain(en.sourceUnclassified)

    fireEvent.change(filter, { target: { value: 'personal' } })
    expect(items()).toHaveLength(1)
    expect(count()?.textContent).toBe('1 / 6')

    fireEvent.change(filter, { target: { value: 'opensource' } })
    expect(items()).toHaveLength(2)

    fireEvent.change(filter, { target: { value: 'opensource-customized' } })
    expect(items()).toHaveLength(1)
    expect(screen.getByText('forked')).toBeTruthy()

    fireEvent.change(filter, { target: { value: 'unclassified' } })
    expect(items()).toHaveLength(1)
    expect(screen.getByText('legacy-plugin')).toBeTruthy()

    fireEvent.change(filter, { target: { value: 'all' } })
    fireEvent.change(screen.getByRole('searchbox', { name: en.search }), { target: { value: 'dsh-' } })
    expect(items()).toHaveLength(5)
    fireEvent.change(filter, { target: { value: 'official' } })
    expect(screen.queryAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByText('llm')).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox', { name: en.search }), { target: { value: 'vision' } })
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    expect(screen.getByText(en.emptySearch)).toBeTruthy()
  })

  it('shows origin details with basis, links, fork, branch, and note', async () => {
    render(<PluginInventorySettingsTab {...props(async () => ORIGIN_SNAPSHOT)} />)
    const personal = await screen.findByRole('button', { name: 'update-checker, Mounted, Enabled' })
    fireEvent.click(personal)
    expect(screen.getByText(en.origin)).toBeTruthy()
    expect(screen.getByText(en.originBasis)).toBeTruthy()
    expect(screen.getByText(en.basisUserOverride)).toBeTruthy()
    expect(screen.getByText(en.originNote)).toBeTruthy()
    expect(screen.getByText('自主构建')).toBeTruthy()

    const custom = screen.getByRole('button', { name: 'forked, Mounted, Enabled' })
    fireEvent.click(personal)
    fireEvent.click(custom)
    expect(screen.getByText(en.basisManifest)).toBeTruthy()
    expect(screen.getByText('my-tweaks')).toBeTruthy()
    const forkLink = screen.getByRole('link', { name: 'https://github.com/me/b' })
    expect(forkLink.getAttribute('target')).toBe('_blank')
    expect(forkLink.getAttribute('rel')).toBe('noreferrer noopener')

    fireEvent.click(custom)
    fireEvent.click(screen.getByRole('button', { name: 'weird, Mounted, Enabled' }))
    expect(screen.queryByRole('link', { name: 'ftp://example.com/x' })).toBeNull()
    expect(screen.getByText('ftp://example.com/x')).toBeTruthy()
  })

  it('labels unclassified entries in details without faking a badge', async () => {
    render(<PluginInventorySettingsTab {...props(async () => ORIGIN_SNAPSHOT)} />)
    const legacy = await screen.findByRole('button', { name: 'legacy-plugin, Mounted, Enabled' })
    fireEvent.click(legacy)
    const details = document.querySelector('[data-plugin-entry="legacy-entry"] [class*="cardDetails"]')
    expect(details?.textContent).toContain(en.sourceUnclassified)
    expect(document.querySelector('[data-plugin-entry="legacy-entry"] [data-origin]')).toBeNull()
  })

  it('schedules the hover card on focus and cancels it on blur', async () => {
    render(<PluginInventorySettingsTab {...props(async () => ORIGIN_SNAPSHOT)} />)
    const first = await screen.findByRole('button', { name: 'llm, Mounted, Enabled' })
    vi.useFakeTimers()
    fireEvent.focus(first)
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(screen.getByRole('tooltip')).toBeTruthy()
    fireEvent.blur(first)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('clears the hover card when the hovered entry is filtered out', async () => {
    render(<PluginInventorySettingsTab {...props(async () => ORIGIN_SNAPSHOT)} />)
    const first = await screen.findByRole('button', { name: 'llm, Mounted, Enabled' })
    vi.useFakeTimers()
    fireEvent.pointerEnter(first)
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(screen.getByRole('tooltip')).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox', { name: en.search }), { target: { value: 'nothing-matches' } })
    act(() => {})
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('resets the unclassified filter when a refreshed snapshot classifies everything', async () => {
    const classified = {
      entries: ORIGIN_SNAPSHOT.entries.map(entry => ({
        ...entry,
        origin: entry.origin ?? originOf('official'),
      })),
    } as unknown as Snapshot
    const view = render(<PluginInventorySettingsTab {...props(async () => ORIGIN_SNAPSHOT)} />)
    const filter = await screen.findByRole('combobox', { name: en.filterBySource })
    fireEvent.change(filter, { target: { value: 'unclassified' } })
    expect((filter as HTMLSelectElement).value).toBe('unclassified')

    view.rerender(<PluginInventorySettingsTab {...props(async () => classified)} />)
    await waitFor(() => { expect((filter as HTMLSelectElement).value).toBe('all') })
    expect([...filter.querySelectorAll('option')].map(option => option.textContent)).not.toContain(en.sourceUnclassified)
    expect(screen.getAllByRole('listitem')).toHaveLength(6)
  })

  it('shows origin details in the hover card, including top placement and unclassified', async () => {
    render(<PluginInventorySettingsTab {...props(async () => ORIGIN_SNAPSHOT)} />)
    const custom = await screen.findByRole('button', { name: 'forked, Mounted, Enabled' })
    // Force the top placement: the row sits at the bottom of the viewport.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 700, bottom: 750, left: 12, right: 300, width: 288, height: 50, x: 12, y: 700,
      toJSON: () => ({}),
    })
    vi.useFakeTimers()

    fireEvent.pointerEnter(custom)
    act(() => { vi.advanceTimersByTime(2_000) })
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip.getAttribute('data-info-placement')).toBe('top')
    expect(tooltip.textContent).toContain(en.originBasis)
    expect(tooltip.textContent).toContain(en.basisManifest)
    expect(tooltip.textContent).toContain('my-tweaks')
    expect(screen.getByRole('link', { name: 'https://github.com/me/b' })).toBeTruthy()
    fireEvent.pointerLeave(custom)
    expect(screen.queryByRole('tooltip')).toBeNull()

    // An official origin carries no repository rows; a disabled entry hides status.
    const oss = screen.getByRole('button', { name: 'vision-router, Disabled' })
    fireEvent.pointerEnter(oss)
    act(() => { vi.advanceTimersByTime(2_000) })
    const ossTooltip = screen.getByRole('tooltip')
    expect(ossTooltip.textContent).toContain(en.sourceOpensource)
    expect(ossTooltip.textContent).toContain(en.basisHeuristic)
    expect(ossTooltip.textContent).not.toContain(en.fork)
    expect(ossTooltip.textContent).not.toContain(en.cordis)
    fireEvent.pointerLeave(oss)

    const legacy = screen.getByRole('button', { name: 'legacy-plugin, Mounted, Enabled' })
    fireEvent.pointerEnter(legacy)
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(screen.getByRole('tooltip').textContent).toContain(en.sourceUnclassified)
    fireEvent.pointerLeave(legacy)

    // A personal entry carries its bilingual note into the hover card.
    const personal = screen.getByRole('button', { name: 'update-checker, Mounted, Enabled' })
    fireEvent.pointerEnter(personal)
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(screen.getByRole('tooltip').textContent).toContain('自主构建')
    fireEvent.pointerLeave(personal)
  })
})

describe('PluginInventorySettingsTab lifecycle controls', () => {
  const writableCapabilities = (
    entryId: string,
    extra: Partial<PluginLifecycleCapabilities['entries'][number]> = {},
  ): PluginLifecycleCapabilities => {
    const entry: PluginLifecycleCapabilities['entries'][number] = {
      entryId,
      packageName: null,
      canToggle: true,
      canUninstall: false,
      toggleBlockReason: null,
      uninstallBlockReason: 'not-direct-dependency',
      ...extra,
    }
    return {
      revision: 'rev-1',
      persistence: 'writable',
      entries: [entry],
    }
  }

  const openRow = async (name: string): Promise<void> => {
    fireEvent.click(await screen.findByRole('button', { name }))
  }

  /** A well-formed disable preview for the snapshot's first entry. */
  const okPreview = (token: string): PluginLifecycleResult<PluginLifecyclePreview> => ({
    ok: true,
    value: {
      token, expiresAt: 1, action: 'disable', entryId: '8a1b2c3d',
      packageName: null, affectedEntryIds: ['8a1b2c3d'], restartRequired: false,
    },
  })

  /** A well-formed uninstall preview for the given package. */
  const okUninstallPreview = (
    token: string,
    packageName: string,
    entryIds: readonly string[],
  ): PluginLifecycleResult<PluginLifecyclePreview> => ({
    ok: true,
    value: {
      token, expiresAt: 1, action: 'uninstall', entryId: entryIds[0] ?? '',
      packageName, affectedEntryIds: entryIds, restartRequired: true,
    },
  })

  /** A started-operation execute result. */
  const okExecute = (operationId: string): PluginLifecycleResult<PluginLifecycleExecuteResponse> => ({
    ok: true,
    value: { operationId, state: 'running' },
  })

  /** One operation poll result. */
  const okOperation = (
    operationId: string,
    state: PluginLifecycleOperationState,
    errorCode: PluginLifecycleOperationView['errorCode'] = null,
    restartRequired = false,
    action: PluginLifecycleOperationView['action'] = 'disable',
  ): PluginLifecycleResult<PluginLifecycleOperationView> => ({
    ok: true,
    value: { operationId, state, action, errorCode, restartRequired },
  })

  it('explains the unavailable lifecycle on older hosts', async () => {
    render(<PluginInventorySettingsTab {...props(async () => SNAPSHOT)} />)
    await openRow('hmr, Mounted, Enabled')
    expect(await screen.findByText(en.lifecycleUnavailable)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.lifecycleDisable })).toBeNull()
    expect(screen.queryByRole('button', { name: en.lifecycleUninstall })).toBeNull()
  })

  it('never stays silently blank when the capabilities call rejects', async () => {
    const lifecycle: PluginLifecycleInjected = {
      capabilities: async () => {
        throw new Error('transport failed')
      },
      preview: async () => ({ ok: false, code: 'INTERNAL' }),
      execute: async () => ({ ok: false, code: 'INTERNAL' }),
      operation: async () => ({ ok: false, code: 'INTERNAL' }),
    }
    render(<PluginInventorySettingsTab {...props(async () => SNAPSHOT, lifecycle)} />)
    await openRow('hmr, Mounted, Enabled')
    // The rejection branch must surface the unavailable copy, not leave the
    // section in the permanent loading state.
    expect(await screen.findByText(en.lifecycleUnavailable)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.lifecycleDisable })).toBeNull()
  })

  it('explains the read-only persistence mode without controls', async () => {
    const readOnlyCapabilities: PluginLifecycleCapabilities = { revision: 'r', persistence: 'read-only', entries: [] }
    const lifecycle: PluginLifecycleInjected = {
      capabilities: async () => ({ ok: true, value: readOnlyCapabilities }),
      preview: async () => ({ ok: false, code: 'READ_ONLY_REMOTE' }),
      execute: async () => ({ ok: false, code: 'READ_ONLY_REMOTE' }),
      operation: async () => ({ ok: false, code: 'READ_ONLY_REMOTE' }),
    }
    render(<PluginInventorySettingsTab {...props(async () => SNAPSHOT, lifecycle)} />)
    await openRow('hmr, Mounted, Enabled')
    expect(await screen.findByText(en.lifecycleReadOnly)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.lifecycleDisable })).toBeNull()
  })

  it('runs a disable toggle through preview, execute, and operation polling', async () => {
    const list = vi.fn(async () => SNAPSHOT)
    const preview = vi.fn(async (): Promise<PluginLifecycleResult<PluginLifecyclePreview>> => okPreview('tok-1'))
    const execute = vi.fn(async (): Promise<PluginLifecycleResult<PluginLifecycleExecuteResponse>> => okExecute('op-1'))
    const operation = vi.fn(async (): Promise<PluginLifecycleResult<PluginLifecycleOperationView>> => okOperation('op-1', 'succeeded'))
    const lifecycle: PluginLifecycleInjected = {
      capabilities: async () => ({ ok: true, value: writableCapabilities('8a1b2c3d') }),
      preview,
      execute,
      operation,
    }
    render(<PluginInventorySettingsTab {...props(list, lifecycle)} />)
    await openRow('hmr, Mounted, Enabled')
    const disable = await screen.findByRole('button', { name: en.lifecycleDisable })
    fireEvent.click(disable)
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(2) })
    expect(preview).toHaveBeenCalledWith({ entryId: '8a1b2c3d', action: 'disable', expectedRevision: 'rev-1' })
    expect(execute).toHaveBeenCalledWith({ token: 'tok-1' })
    expect(operation).toHaveBeenCalledWith({ operationId: 'op-1' })
  })

  it('surfaces a structured toggle failure per entry', async () => {
    const lifecycle: PluginLifecycleInjected = {
      capabilities: async () => ({ ok: true, value: writableCapabilities('8a1b2c3d') }),
      preview: async () => ({ ok: false, code: 'PROFILE_CHANGED' }),
      execute: async () => ({ ok: false, code: 'PROFILE_CHANGED' }),
      operation: async () => ({ ok: false, code: 'PROFILE_CHANGED' }),
    }
    render(<PluginInventorySettingsTab {...props(async () => SNAPSHOT, lifecycle)} />)
    await openRow('hmr, Mounted, Enabled')
    fireEvent.click(await screen.findByRole('button', { name: en.lifecycleDisable }))
    expect(await screen.findByText(en.lifecycleErrorProfileChanged)).toBeTruthy()
  })

  it('localizes every lifecycle error code an operation can report', async () => {
    const codes = [
      ['UNAVAILABLE', en.lifecycleUnavailable],
      ['READ_ONLY_REMOTE', en.lifecycleErrorReadOnlyRemote],
      ['ENTRY_NOT_FOUND', en.lifecycleErrorEntryNotFound],
      ['ENTRY_CHANGED', en.lifecycleErrorEntryChanged],
      ['BLOCKED_BY_ANCESTOR', en.lifecycleErrorBlockedByAncestor],
      ['PROTECTED_PLUGIN', en.lifecycleErrorProtectedPlugin],
      ['NOT_DIRECT_DEPENDENCY', en.lifecycleErrorNotDirectDependency],
      ['AMBIGUOUS_PACKAGE', en.lifecycleErrorAmbiguousPackage],
      ['BUSY', en.lifecycleErrorBusy],
      ['INVALID_PATCH', en.lifecycleErrorInvalidPatch],
      ['MANAGED_BLOCK_INVALID', en.lifecycleErrorManagedBlockInvalid],
      ['UNSUPPORTED_PATCH_SHAPE', en.lifecycleErrorUnsupportedPatchShape],
      ['PNPM_UNAVAILABLE', en.lifecycleErrorPnpmUnavailable],
      ['PACKAGE_MANAGER_FAILED', en.lifecycleErrorPackageManagerFailed],
      ['POSTCONDITION_FAILED', en.lifecycleErrorPostconditionFailed],
      ['TIMEOUT', en.lifecycleErrorTimeout],
      ['ROLLBACK_INCOMPLETE', en.lifecycleErrorRollbackIncomplete],
      ['WEIRD_FUTURE_CODE', en.lifecycleErrorInternal],
    ] as const
    let reported: string = 'TIMEOUT'
    const lifecycle: PluginLifecycleInjected = {
      capabilities: async () => ({ ok: true, value: writableCapabilities('8a1b2c3d') }),
      preview: async () => okPreview('tok-err'),
      execute: async () => okExecute('op-err'),
      operation: async () => okOperation('op-err', 'failed', reported as never),
    }
    render(<PluginInventorySettingsTab {...props(async () => SNAPSHOT, lifecycle)} />)
    await openRow('hmr, Mounted, Enabled')
    for (const [code, copy] of codes) {
      reported = code
      const disable = screen.getByRole('button', { name: en.lifecycleDisable })
      fireEvent.click(disable)
      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toContain(copy)
      // The row settles back to idle so the next iteration can click again.
      await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: en.lifecycleDisable }).disabled).toBe(false) })
    }
  }, 30_000)

  it('requires confirmation before uninstalling and cancels cleanly', async () => {
    const entryId = '8a1b2c3d'
    const execute = vi.fn(async (): Promise<PluginLifecycleResult<PluginLifecycleExecuteResponse>> => ({ ok: false, code: 'INTERNAL' }))
    const lifecycle: PluginLifecycleInjected = {
      capabilities: async () => ({
        ok: true,
        value: writableCapabilities(entryId, { packageName: 'dsh-vision-router', canUninstall: true, uninstallBlockReason: null }),
      }),
      preview: async () => okUninstallPreview('tok-2', 'dsh-vision-router', [entryId]),
      execute,
      operation: async () => ({ ok: false, code: 'INTERNAL' }),
    }
    render(<PluginInventorySettingsTab {...props(async () => SNAPSHOT, lifecycle)} />)
    await openRow('hmr, Mounted, Enabled')
    fireEvent.click(await screen.findByRole('button', { name: en.lifecycleUninstall }))
    const confirmTitle = await screen.findByText(en.lifecycleConfirmTitle)
    expect(confirmTitle).toBeTruthy()
    const confirmGroup = screen.getByRole('group', { name: en.lifecycleConfirmTitle })
    expect(confirmGroup.textContent).toContain('dsh-vision-router')
    expect(confirmGroup.textContent).toContain(`${en.lifecycleAffectedEntries}: 1`)
    // Cancel: execute must never run.
    fireEvent.click(screen.getByRole('button', { name: en.lifecycleCancel }))
    expect(screen.queryByText(en.lifecycleConfirmTitle)).toBeNull()
    expect(execute).not.toHaveBeenCalled()

    // Confirm: the pending preview token is executed exactly once.
    fireEvent.click(screen.getByRole('button', { name: en.lifecycleUninstall }))
    fireEvent.click(await screen.findByRole('button', { name: en.lifecycleConfirmUninstall }))
    await waitFor(() => { expect(execute).toHaveBeenCalledWith({ token: 'tok-2' }) })
  })

  it('maps a failing operation poll onto the row error', async () => {
    const lifecycle: PluginLifecycleInjected = {
      capabilities: async () => ({ ok: true, value: writableCapabilities('8a1b2c3d') }),
      preview: async () => okPreview('tok-poll'),
      execute: async () => okExecute('op-poll'),
      operation: async () => ({ ok: false, code: 'ENTRY_CHANGED' }),
    }
    render(<PluginInventorySettingsTab {...props(async () => SNAPSHOT, lifecycle)} />)
    await openRow('hmr, Mounted, Enabled')
    fireEvent.click(await screen.findByRole('button', { name: en.lifecycleDisable }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain(en.lifecycleErrorEntryChanged)
  })

  it('maps a failing uninstall preview onto the row error', async () => {
    const lifecycle: PluginLifecycleInjected = {
      capabilities: async () => ({
        ok: true,
        value: writableCapabilities('8a1b2c3d', { packageName: 'dsh-x', canUninstall: true, uninstallBlockReason: null }),
      }),
      preview: async () => ({ ok: false, code: 'PROTECTED_PLUGIN' }),
      execute: async () => ({ ok: false, code: 'PROTECTED_PLUGIN' }),
      operation: async () => ({ ok: false, code: 'PROTECTED_PLUGIN' }),
    }
    render(<PluginInventorySettingsTab {...props(async () => SNAPSHOT, lifecycle)} />)
    await openRow('hmr, Mounted, Enabled')
    fireEvent.click(await screen.findByRole('button', { name: en.lifecycleUninstall }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain(en.lifecycleErrorProtectedPlugin)
    expect(screen.queryByText(en.lifecycleConfirmTitle)).toBeNull()
  })

  it('runs a confirmed uninstall to success', async () => {
    const list = vi.fn(async () => SNAPSHOT)
    const lifecycle: PluginLifecycleInjected = {
      capabilities: async () => ({
        ok: true,
        value: writableCapabilities('8a1b2c3d', { packageName: 'dsh-y', canUninstall: true, uninstallBlockReason: null }),
      }),
      preview: async () => okUninstallPreview('tok-uni', 'dsh-y', ['8a1b2c3d']),
      execute: async () => okExecute('op-uni'),
      operation: async () => okOperation('op-uni', 'succeeded', null, true, 'uninstall'),
    }
    render(<PluginInventorySettingsTab {...props(list, lifecycle)} />)
    await openRow('hmr, Mounted, Enabled')
    fireEvent.click(await screen.findByRole('button', { name: en.lifecycleUninstall }))
    fireEvent.click(await screen.findByRole('button', { name: en.lifecycleConfirmUninstall }))
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(2) }, { timeout: 3_000 })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('maps an execute failure onto the row error after a good preview', async () => {
    const lifecycle: PluginLifecycleInjected = {
      capabilities: async () => ({ ok: true, value: writableCapabilities('8a1b2c3d') }),
      preview: async () => okPreview('tok-exec'),
      execute: async () => ({ ok: false, code: 'BUSY' }),
      operation: async () => ({ ok: false, code: 'BUSY' }),
    }
    render(<PluginInventorySettingsTab {...props(async () => SNAPSHOT, lifecycle)} />)
    await openRow('hmr, Mounted, Enabled')
    fireEvent.click(await screen.findByRole('button', { name: en.lifecycleDisable }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain(en.lifecycleErrorBusy)
  })

  it('polls a running operation through to success', async () => {
    const list = vi.fn(async () => SNAPSHOT)
    let pollCount = 0
    const lifecycle: PluginLifecycleInjected = {
      capabilities: async () => ({ ok: true, value: writableCapabilities('8a1b2c3d') }),
      preview: async () => okPreview('tok-run'),
      execute: async () => okExecute('op-run'),
      operation: async () => {
        pollCount += 1
        return okOperation('op-run', pollCount === 1 ? 'running' : 'succeeded')
      },
    }
    render(<PluginInventorySettingsTab {...props(list, lifecycle)} />)
    await openRow('hmr, Mounted, Enabled')
    fireEvent.click(await screen.findByRole('button', { name: en.lifecycleDisable }))
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(2) }, { timeout: 3_000 })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('unmounts cleanly while a poll interval is pending', async () => {
    const lifecycle: PluginLifecycleInjected = {
      capabilities: async () => ({ ok: true, value: writableCapabilities('8a1b2c3d') }),
      preview: async () => okPreview('tok-3'),
      execute: async () => okExecute('op-3'),
      operation: async () => okOperation('op-3', 'running'),
    }
    const view = render(<PluginInventorySettingsTab {...props(async () => SNAPSHOT, lifecycle)} />)
    await openRow('hmr, Mounted, Enabled')
    fireEvent.click(await screen.findByRole('button', { name: en.lifecycleDisable }))
    await waitFor(() => { expect(screen.getByText(en.lifecycleWorking)).toBeTruthy() })
    view.unmount()
  })
})
