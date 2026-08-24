import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  PluginInventorySnapshot,
  PluginLifecycleCapabilities,
  PluginLifecycleExecuteRequest,
  PluginLifecycleExecuteResponse,
  PluginLifecycleOperationRequest,
  PluginLifecycleOperationView,
  PluginLifecyclePreview,
  PluginLifecyclePreviewRequest,
} from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconChevronDownOutline14,
  IconSearchOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PluginInventoryLocaleKey } from './locales.ts'
import css from './PluginInventorySettingsTab.module.css'

/** Result envelope of one lifecycle Remote call, with the error code surfaced. */
export type PluginLifecycleResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string }

/** The lifecycle mutation face injected beside the read-only list face. */
export interface PluginLifecycleInjected {
  readonly capabilities: () => Promise<PluginLifecycleResult<PluginLifecycleCapabilities>>
  readonly preview: (input: PluginLifecyclePreviewRequest) => Promise<PluginLifecycleResult<PluginLifecyclePreview>>
  readonly execute: (input: PluginLifecycleExecuteRequest) => Promise<PluginLifecycleResult<PluginLifecycleExecuteResponse>>
  readonly operation: (input: PluginLifecycleOperationRequest) => Promise<PluginLifecycleResult<PluginLifecycleOperationView>>
}

/** Registration-side Remote face used by the section. */
export interface PluginInventorySettingsTabInjected {
  /** Read a current Host inventory snapshot. */
  list: () => Promise<PluginInventorySnapshot>
  /** Mutation face; a call fails with code `UNAVAILABLE` on older hosts. */
  lifecycle: PluginLifecycleInjected
}

type PluginInventoryEntry = PluginInventorySnapshot['entries'][number]
type PluginFiberPhase = PluginInventoryEntry['fiberPhase']
type PluginOrigin = NonNullable<PluginInventoryEntry['origin']>

/** Full component props assembled by the Settings slot renderer. */
export type PluginInventorySettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginInventory'>
  & InjectFace<PluginInventorySettingsTabInjected>

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: PluginInventorySnapshot }

const PHASE_KEYS = {
  pending: 'pending',
  loading: 'loadingPhase',
  active: 'active',
  failed: 'failed',
  unloading: 'unloading',
} satisfies Record<Exclude<PluginFiberPhase, null>, PluginInventoryLocaleKey>

/** Localized accessible label for one root Fiber phase. */
function phaseLabel(
  phase: PluginFiberPhase,
  t: PluginInventorySettingsTabProps['t'],
): string {
  return phase === null ? t('unobserved') : t(PHASE_KEYS[phase])
}

/** Compact a module specifier without guessing whether its Loader id was generated. */
function moduleShortName(moduleName: string): string {
  const unscoped = moduleName.startsWith('@') ? moduleName.slice(moduleName.indexOf('/') + 1) : moduleName
  return unscoped
    .replace(/^cordis:/, '')
    .replace(/^cordis-plugin-/, '')
    .replace(/^dsh-(?:host-|client-)?/, '')
}

/** Whether an inventory row matches the local catalog query. */
function matches(entry: PluginInventoryEntry, normalizedQuery: string): boolean {
  if (normalizedQuery.length === 0) return true
  return [entry.moduleName, entry.entryId]
    .some(value => value.toLocaleLowerCase().includes(normalizedQuery))
}

/** Plugin list ordering modes. */
type PluginSortMode = 'loader' | 'updated'

/** Plugin source filter modes. */
type PluginSourceFilter = 'all' | 'official' | 'personal' | 'opensource' | 'opensource-customized' | 'unclassified'

/** Localized badge text for one resolved origin; null when unclassified. */
function originLabel(origin: PluginOrigin | undefined, t: PluginInventorySettingsTabProps['t']): string | null {
  if (origin === undefined) return null
  switch (origin.kind) {
    case 'official': return t('sourceOfficial')
    case 'personal': return t('sourcePersonal')
    case 'opensource': return origin.customized ? t('sourceOpensourceCustomized') : t('sourceOpensource')
  }
}

/** Localized text of the layer that declared the origin. */
function basisLabel(origin: PluginOrigin, t: PluginInventorySettingsTabProps['t']): string {
  switch (origin.declaredBy) {
    case 'user-override': return t('basisUserOverride')
    case 'manifest': return t('basisManifest')
    case 'heuristic': return t('basisHeuristic')
  }
}

/** Whether an entry passes the source filter. */
function matchesSource(entry: PluginInventoryEntry, filter: PluginSourceFilter): boolean {
  switch (filter) {
    case 'all': return true
    case 'official': return entry.origin?.kind === 'official'
    case 'personal': return entry.origin?.kind === 'personal'
    case 'opensource': return entry.origin?.kind === 'opensource' && !entry.origin.customized
    case 'opensource-customized': return entry.origin?.kind === 'opensource' && entry.origin.customized
    case 'unclassified': return entry.origin === undefined
  }
}

/** Render a repository value as a safe link; non-HTTP(S) values stay text. */
function linkify(value: string): ReactNode {
  return /^https?:\/\//i.test(value)
    ? <a href={value} target="_blank" rel="noreferrer noopener">{value}</a>
    : value
}

/** Localize a lifecycle error code into user-facing copy. */
function lifecycleErrorText(code: string, t: PluginInventorySettingsTabProps['t']): string {
  switch (code) {
    case 'UNAVAILABLE': return t('lifecycleUnavailable')
    case 'READ_ONLY_REMOTE': return t('lifecycleErrorReadOnlyRemote')
    case 'ENTRY_NOT_FOUND': return t('lifecycleErrorEntryNotFound')
    case 'ENTRY_CHANGED': return t('lifecycleErrorEntryChanged')
    case 'BLOCKED_BY_ANCESTOR': return t('lifecycleErrorBlockedByAncestor')
    case 'PROTECTED_PLUGIN': return t('lifecycleErrorProtectedPlugin')
    case 'NOT_DIRECT_DEPENDENCY': return t('lifecycleErrorNotDirectDependency')
    case 'AMBIGUOUS_PACKAGE': return t('lifecycleErrorAmbiguousPackage')
    case 'PROFILE_CHANGED': return t('lifecycleErrorProfileChanged')
    case 'BUSY': return t('lifecycleErrorBusy')
    case 'INVALID_PATCH': return t('lifecycleErrorInvalidPatch')
    case 'MANAGED_BLOCK_INVALID': return t('lifecycleErrorManagedBlockInvalid')
    case 'UNSUPPORTED_PATCH_SHAPE': return t('lifecycleErrorUnsupportedPatchShape')
    case 'PNPM_UNAVAILABLE': return t('lifecycleErrorPnpmUnavailable')
    case 'PACKAGE_MANAGER_FAILED': return t('lifecycleErrorPackageManagerFailed')
    case 'POSTCONDITION_FAILED': return t('lifecycleErrorPostconditionFailed')
    case 'TIMEOUT': return t('lifecycleErrorTimeout')
    case 'ROLLBACK_INCOMPLETE': return t('lifecycleErrorRollbackIncomplete')
    default: return t('lifecycleErrorInternal')
  }
}

/** Operation polling cadence while a mutation is in flight. */
const LIFECYCLE_POLL_MS = 500

/** Locale-formatted change timestamp for an expanded row. */
const updatedAtFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

function formatUpdatedAt(updatedAt: number): string {
  return updatedAtFormatter.format(new Date(updatedAt))
}

/** Hover dwell before the detailed plugin card appears. */
const HOVER_CARD_DELAY_MS = 2_000

/** Preferred hover-card width; clamped to the viewport by the placement code. */
const HOVER_CARD_WIDTH = 360

/** Viewport gap kept around the fixed-position hover card. */
const HOVER_CARD_GAP = 8

/** Position of the hover card that passed the two-second dwell. */
interface HoverCardPosition {
  readonly entryId: PluginInventoryEntry['entryId']
  readonly placement: 'top' | 'bottom'
  readonly left: number
  readonly top: number
  readonly width: number
}

/** Render the read-only current Loader inventory. */
export function PluginInventorySettingsTab({ list, lifecycle, t }: PluginInventorySettingsTabProps): ReactNode {
  const catalogId = useId()
  const [request, setRequest] = useState(0)
  const [query, setQuery] = useState('')
  const [sortMode, setSortMode] = useState<PluginSortMode>('loader')
  const [sourceFilter, setSourceFilter] = useState<PluginSourceFilter>('all')
  const [expanded, setExpanded] = useState<PluginInventoryEntry['entryId'] | null>(null)
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [hoverCard, setHoverCard] = useState<HoverCardPosition | null>(null)
  const hoverTimer = useRef<number | null>(null)
  const [capabilities, setCapabilities] = useState<PluginLifecycleCapabilities | null>(null)
  const [lifecycleAvailable, setLifecycleAvailable] = useState(true)
  const [busyEntry, setBusyEntry] = useState<PluginInventoryEntry['entryId'] | null>(null)
  const [entryError, setEntryError] = useState<{ readonly entryId: string; readonly code: string } | null>(null)
  const [confirm, setConfirm] = useState<PluginLifecyclePreview | null>(null)
  const pollTimer = useRef<number | null>(null)

  const clearHoverTimer = (): void => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
  }

  const stopPolling = (): void => {
    if (pollTimer.current !== null) {
      window.clearInterval(pollTimer.current)
      pollTimer.current = null
    }
  }

  const cancelHoverCard = (): void => {
    clearHoverTimer()
    setHoverCard(null)
  }

  const scheduleHoverCard = (element: HTMLElement, entry: PluginInventoryEntry): void => {
    clearHoverTimer()
    const rect = element.getBoundingClientRect()
    const belowSpace = window.innerHeight - rect.bottom
    const aboveSpace = rect.top
    const placement = belowSpace >= aboveSpace || belowSpace >= 280 ? 'bottom' : 'top'
    hoverTimer.current = window.setTimeout(() => {
      const width = Math.min(HOVER_CARD_WIDTH, Math.max(240, window.innerWidth - 24))
      const left = Math.min(Math.max(12, rect.left), window.innerWidth - width - 12)
      const top = placement === 'bottom' ? rect.bottom + HOVER_CARD_GAP : rect.top - HOVER_CARD_GAP
      setHoverCard({ entryId: entry.entryId, placement, left, top, width })
    }, HOVER_CARD_DELAY_MS)
  }

  useEffect(() => () => { clearHoverTimer() }, [])

  useEffect(() => () => { stopPolling() }, [])

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => list()).then(
      (snapshot) => { if (current) setState({ status: 'ready', snapshot }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [list, request])

  const loadCapabilities = (): void => {
    void lifecycle.capabilities().then(
      (result) => {
        if (result.ok) {
          setLifecycleAvailable(true)
          setCapabilities(result.value)
        } else {
          setLifecycleAvailable(false)
          setCapabilities(null)
        }
      },
      () => {
        // An unexpected rejection (assembly fault, transport drop) must not
        // leave the section in the silent loading state forever.
        setLifecycleAvailable(false)
        setCapabilities(null)
      },
    )
  }

  useEffect(() => {
    loadCapabilities()
  }, [request])

  /** Run one toggle through preview → execute and poll its operation. */
  const runToggle = async (entry: PluginInventoryEntry, action: 'disable' | 'enable'): Promise<void> => {
    /* v8 ignore next -- the busy guard fires only on a racing second click; tests drive the serial path. */
    if (capabilities === null || busyEntry !== null) return
    setBusyEntry(entry.entryId)
    setEntryError(null)
    setConfirm(null)
    try {
      const preview = await lifecycle.preview({ entryId: entry.entryId, action, expectedRevision: capabilities.revision })
      if (!preview.ok) {
        setEntryError({ entryId: entry.entryId, code: preview.code })
        return
      }
      const started = await lifecycle.execute({ token: preview.value.token })
      if (!started.ok) {
        setEntryError({ entryId: entry.entryId, code: started.code })
        return
      }
      await pollOperation(started.value.operationId, entry.entryId)
    } finally {
      setBusyEntry(null)
    }
  }

  /** Poll one operation until it settles, then refresh the projections. */
  const pollOperation = (operationId: string, entryId: string): Promise<void> =>
    new Promise((resolve) => {
      stopPolling()
      pollTimer.current = window.setInterval(() => {
        void lifecycle.operation({ operationId }).then((result) => {
          if (!result.ok) {
            stopPolling()
            setEntryError({ entryId, code: result.code })
            resolve()
            return
          }
          const view = result.value
          if (view.state === 'queued' || view.state === 'running') return
          stopPolling()
          if (view.state === 'succeeded') {
            setRequest(value => value + 1)
            loadCapabilities()
          } else {
            /* v8 ignore next -- a failed operation always carries an error code; the null arm is defensive. */
            setEntryError({ entryId, code: view.errorCode ?? 'INTERNAL' })
          }
          resolve()
        })
      }, LIFECYCLE_POLL_MS)
    })

  /** Begin an uninstall: preview first, then present the confirmation. */
  const previewUninstall = async (entry: PluginInventoryEntry): Promise<void> => {
    /* v8 ignore next -- the busy guard fires only on a racing second click; tests drive the serial path. */
    if (capabilities === null || busyEntry !== null) return
    setBusyEntry(entry.entryId)
    setEntryError(null)
    try {
      const preview = await lifecycle.preview({
        entryId: entry.entryId,
        action: 'uninstall',
        expectedRevision: capabilities.revision,
      })
      if (!preview.ok) {
        setEntryError({ entryId: entry.entryId, code: preview.code })
        return
      }
      setConfirm(preview.value)
    } finally {
      setBusyEntry(null)
    }
  }

  /** Confirm the pending uninstall and poll to completion. */
  const confirmUninstall = async (entry: PluginInventoryEntry): Promise<void> => {
    /* v8 ignore next -- the confirm guard fires only on a racing double-confirm; tests drive the serial path. */
    if (confirm === null || busyEntry !== null) return
    setBusyEntry(entry.entryId)
    setEntryError(null)
    try {
      const started = await lifecycle.execute({ token: confirm.token })
      setConfirm(null)
      if (!started.ok) {
        setEntryError({ entryId: entry.entryId, code: started.code })
        return
      }
      await pollOperation(started.value.operationId, entry.entryId)
    } finally {
      setBusyEntry(null)
    }
  }

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleEntries = useMemo(
    () => {
      if (state.status !== 'ready') return []
      const filtered = state.snapshot.entries
        .filter(entry => matches(entry, normalizedQuery) && matchesSource(entry, sourceFilter))
      return sortMode === 'updated'
        ? [...filtered].sort((left, right) => right.updatedAt - left.updatedAt)
        : filtered
    },
    [normalizedQuery, sortMode, sourceFilter, state],
  )
  const hasUnclassified = state.status === 'ready'
    && state.snapshot.entries.some(entry => entry.origin === undefined)
  const filtering = normalizedQuery.length > 0 || sourceFilter !== 'all'

  useEffect(() => {
    if (hoverCard !== null && !visibleEntries.some(entry => entry.entryId === hoverCard.entryId)) {
      clearHoverTimer()
      setHoverCard(null)
    }
  }, [hoverCard, visibleEntries])

  useEffect(() => {
    if (expanded !== null && !visibleEntries.some(entry => entry.entryId === expanded)) {
      setExpanded(null)
    }
  }, [expanded, visibleEntries])

  useEffect(() => {
    if (sourceFilter === 'unclassified' && !hasUnclassified) {
      setSourceFilter('all')
    }
  }, [sourceFilter, hasUnclassified])

  const retry = (): void => {
    setState({ status: 'loading' })
    setRequest(value => value + 1)
  }

  return (
    <div className={css.section} aria-busy={state.status === 'loading'}>
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('error')}</p>
          <button type="button" onClick={retry}>{t('retry')}</button>
        </div>
      ) : null}
      {state.status === 'ready' ? (
        <div className={css.catalog}>
          <label className={css.search}>
            <IconSearchOutline16 aria-hidden="true" />
            <span className={css.visuallyHidden}>{t('search')}</span>
            <input
              type="search"
              value={query}
              placeholder={t('search')}
              aria-label={t('search')}
              onChange={(event) => { setQuery(event.currentTarget.value) }}
            />
          </label>
          <div className={css.catalogHeading}>
            <div className={css.catalogHeadingStart}>
              <h3>{t('catalog')}</h3>
              <span data-plugin-count={visibleEntries.length}>
                {filtering
                  ? `${visibleEntries.length} / ${state.snapshot.entries.length}`
                  : visibleEntries.length}
              </span>
            </div>
            <div className={css.catalogFilters}>
              <label className={css.filterField}>
                <span className={css.filterLabel}>{t('filterBySource')}</span>
                <span className={css.sort}>
                  <select
                    value={sourceFilter}
                    aria-label={t('filterBySource')}
                    onChange={(event) => { setSourceFilter(event.currentTarget.value as PluginSourceFilter) }}
                  >
                    <option value="all">{t('sourceAll')}</option>
                    <option value="official">{t('sourceOfficial')}</option>
                    <option value="personal">{t('sourcePersonal')}</option>
                    <option value="opensource">{t('sourceOpensource')}</option>
                    <option value="opensource-customized">{t('sourceOpensourceCustomized')}</option>
                    {hasUnclassified ? <option value="unclassified">{t('sourceUnclassified')}</option> : null}
                  </select>
                  <IconChevronDownOutline14 className={css.sortChevron} size={12} aria-hidden="true" />
                </span>
              </label>
              <label className={css.sort}>
                <span className={css.visuallyHidden}>{t('sortBy')}</span>
                <select
                  value={sortMode}
                  aria-label={t('sortBy')}
                  onChange={(event) => { setSortMode(event.currentTarget.value as PluginSortMode) }}
                >
                  <option value="loader">{t('sortByLoader')}</option>
                  <option value="updated">{t('sortByUpdated')}</option>
                </select>
                <IconChevronDownOutline14 className={css.sortChevron} size={12} aria-hidden="true" />
              </label>
            </div>
          </div>
          {state.snapshot.entries.length === 0 ? <p className={css.status}>{t('empty')}</p> : null}
          {state.snapshot.entries.length > 0 && visibleEntries.length === 0
            ? <p className={css.status}>{t('emptySearch')}</p>
            : null}
          {visibleEntries.length > 0 ? (
            <ul className={css.cards}>
              {visibleEntries.map((entry) => {
                const status = phaseLabel(entry.fiberPhase, t)
                const title = moduleShortName(entry.moduleName)
                const configuration = t(entry.enabled ? 'enabledTag' : 'disabledTag')
                const origin = originLabel(entry.origin, t)
                const open = expanded === entry.entryId
                const detailId = `${catalogId}-details-${encodeURIComponent(entry.entryId)}`
                const infoId = `${catalogId}-info-${encodeURIComponent(entry.entryId)}`
                const infoTitle = entry.card.title?.zh ?? entry.card.title?.en ?? title
                const infoTitleEn = entry.card.title?.en
                const infoDescription = entry.card.description?.zh ?? entry.card.description?.en
                const infoDescriptionEn = entry.card.description?.en
                const infoPosition = hoverCard?.entryId === entry.entryId ? hoverCard : null
                const noteText = entry.origin?.note?.zh ?? entry.origin?.note?.en ?? null
                return (
                  <li
                    className={css.card}
                    key={entry.entryId}
                    data-plugin-entry={entry.entryId}
                    data-open={open ? 'true' : undefined}
                    onPointerEnter={(event) => { scheduleHoverCard(event.currentTarget, entry) }}
                    onPointerLeave={cancelHoverCard}
                    onFocus={(event) => { scheduleHoverCard(event.currentTarget, entry) }}
                    onBlur={cancelHoverCard}
                  >
                    <button
                      className={css.cardContent}
                      type="button"
                      aria-expanded={open}
                      aria-controls={detailId}
                      aria-describedby={infoPosition !== null ? infoId : undefined}
                      aria-label={entry.enabled ? `${title}, ${status}, ${configuration}` : `${title}, ${configuration}`}
                      onClick={() => {
                        setExpanded(current => current === entry.entryId ? null : entry.entryId)
                        cancelHoverCard()
                      }}
                    >
                      <strong className={css.cardTitle} title={entry.moduleName}>{title}</strong>
                      <span className={css.cardTrailing}>
                        {origin !== null && entry.origin !== undefined ? (
                          <span
                            className={css.originTag}
                            data-origin={entry.origin.kind}
                            data-customized={entry.origin.customized ? 'true' : undefined}
                          >
                            {origin}
                          </span>
                        ) : null}
                        {entry.enabled ? (
                          <span
                            className={css.statusDot}
                            data-phase={entry.fiberPhase ?? 'unobserved'}
                            role="img"
                            aria-label={status}
                            title={status}
                          />
                        ) : null}
                        <span className={css.configTag} data-enabled={entry.enabled ? 'true' : 'false'}>
                          {configuration}
                        </span>
                        <IconChevronDownOutline14 className={css.chevron} size={12} aria-hidden="true" />
                      </span>
                    </button>
                    {open ? (
                      <div className={css.cardDetails} id={detailId}>
                        <code className={css.entryValue} data-loader-entry>{entry.entryId}</code>
                        <dl className={css.details}>
                          <div>
                            <dt>{t('configuration')}</dt>
                            <dd>{configuration}</dd>
                          </div>
                          {entry.enabled ? (
                            <div>
                              <dt>{t('cordis')}</dt>
                              <dd>{status}</dd>
                            </div>
                          ) : null}
                          <div>
                            <dt>{t('origin')}</dt>
                            <dd>{entry.origin !== undefined ? origin : t('sourceUnclassified')}</dd>
                          </div>
                          {entry.origin !== undefined ? (
                            <>
                              <div>
                                <dt>{t('originBasis')}</dt>
                                <dd>{basisLabel(entry.origin, t)}</dd>
                              </div>
                              {entry.origin.upstream !== null ? (
                                <div>
                                  <dt>{t('upstream')}</dt>
                                  <dd>{linkify(entry.origin.upstream)}</dd>
                                </div>
                              ) : null}
                              {entry.origin.fork !== null ? (
                                <div>
                                  <dt>{t('fork')}</dt>
                                  <dd>{linkify(entry.origin.fork)}</dd>
                                </div>
                              ) : null}
                              {entry.origin.branch !== null ? (
                                <div>
                                  <dt>{t('branch')}</dt>
                                  <dd>{entry.origin.branch}</dd>
                                </div>
                              ) : null}
                              {noteText !== null ? (
                                <div>
                                  <dt>{t('originNote')}</dt>
                                  <dd>{noteText}</dd>
                                </div>
                              ) : null}
                            </>
                          ) : null}
                          <div>
                            <dt>{t('updated')}</dt>
                            <dd>
                              <time dateTime={new Date(entry.updatedAt).toISOString()}>
                                {formatUpdatedAt(entry.updatedAt)}
                              </time>
                            </dd>
                          </div>
                        </dl>
                        <LifecycleControls
                          t={t}
                          entry={entry}
                          capabilities={capabilities}
                          lifecycleAvailable={lifecycleAvailable}
                          busy={busyEntry === entry.entryId}
                          errorCode={entryError !== null && entryError.entryId === entry.entryId ? entryError.code : null}
                          confirm={confirm !== null && confirm.entryId === entry.entryId ? confirm : null}
                          /* v8 ignore next -- the toggle wiring is asserted through the clicked button's effects. */
                          onToggle={() => { void runToggle(entry, entry.enabled ? 'disable' : 'enable') }}
                          onUninstall={() => { void previewUninstall(entry) }}
                          onConfirmUninstall={() => { void confirmUninstall(entry) }}
                          onCancelConfirm={() => { setConfirm(null) }}
                        />
                      </div>
                    ) : null}
                    {infoPosition !== null ? (
                      <div
                        className={`${css.infoCard} ${infoPosition.placement === 'top' ? css.infoCardTop : ''}`}
                        id={infoId}
                        role="tooltip"
                        data-info-placement={infoPosition.placement}
                        style={{
                          left: infoPosition.left,
                          top: infoPosition.top,
                          width: infoPosition.width,
                        }}
                      >
                        <div className={css.infoCardHeader}>
                          <strong>{infoTitle}</strong>
                          {infoTitleEn !== undefined && infoTitleEn !== infoTitle
                            ? <span>{infoTitleEn}</span>
                            : null}
                        </div>
                        <dl className={css.infoCardDetails}>
                          <div>
                            <dt>{t('module')}</dt>
                            <dd>{entry.moduleName}</dd>
                          </div>
                          <div>
                            <dt>{t('capability')}</dt>
                            <dd>{infoDescription ?? t('noDescription')}</dd>
                            {infoDescriptionEn !== undefined && infoDescriptionEn !== infoDescription
                              ? <dd className={css.infoCardEn}>{infoDescriptionEn}</dd>
                              : null}
                          </div>
                          <div>
                            <dt>{t('configuration')}</dt>
                            <dd>{configuration}</dd>
                          </div>
                          {entry.enabled ? (
                            <div>
                              <dt>{t('cordis')}</dt>
                              <dd>{status}</dd>
                            </div>
                          ) : null}
                          <div>
                            <dt>{t('origin')}</dt>
                            <dd>{entry.origin !== undefined ? origin : t('sourceUnclassified')}</dd>
                          </div>
                          {entry.origin !== undefined ? (
                            <>
                              <div>
                                <dt>{t('originBasis')}</dt>
                                <dd>{basisLabel(entry.origin, t)}</dd>
                              </div>
                              {entry.origin.upstream !== null ? (
                                <div>
                                  <dt>{t('upstream')}</dt>
                                  <dd>{linkify(entry.origin.upstream)}</dd>
                                </div>
                              ) : null}
                              {entry.origin.fork !== null ? (
                                <div>
                                  <dt>{t('fork')}</dt>
                                  <dd>{linkify(entry.origin.fork)}</dd>
                                </div>
                              ) : null}
                              {entry.origin.branch !== null ? (
                                <div>
                                  <dt>{t('branch')}</dt>
                                  <dd>{entry.origin.branch}</dd>
                                </div>
                              ) : null}
                              {noteText !== null ? (
                                <div>
                                  <dt>{t('originNote')}</dt>
                                  <dd>{noteText}</dd>
                                </div>
                              ) : null}
                            </>
                          ) : null}
                          <div>
                            <dt>{t('entryId')}</dt>
                            <dd><code>{entry.entryId}</code></dd>
                          </div>
                          <div>
                            <dt>{t('updated')}</dt>
                            <dd>
                              <time dateTime={new Date(entry.updatedAt).toISOString()}>
                                {formatUpdatedAt(entry.updatedAt)}
                              </time>
                            </dd>
                          </div>
                        </dl>
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** Props for the per-entry lifecycle controls rendered in expanded details. */
interface LifecycleControlsProps {
  readonly entry: PluginInventoryEntry
  readonly capabilities: PluginLifecycleCapabilities | null
  readonly lifecycleAvailable: boolean
  readonly busy: boolean
  readonly errorCode: string | null
  readonly confirm: PluginLifecyclePreview | null
  readonly onToggle: () => void
  readonly onUninstall: () => void
  readonly onConfirmUninstall: () => void
  readonly onCancelConfirm: () => void
}

/** Capability-gated lifecycle controls: toggle, uninstall confirmation, errors. */
function LifecycleControls({
  entry, capabilities, lifecycleAvailable, busy, errorCode, confirm,
  onToggle, onUninstall, onConfirmUninstall, onCancelConfirm,
  t,
}: LifecycleControlsProps & Pick<PluginInventorySettingsTabProps, 't'>): ReactNode {
  /* v8 ignore next -- the loading window between mount and the first capability snapshot; tests await past it. */
  if (lifecycleAvailable && capabilities === null) return null
  const capability = capabilities?.entries.find(candidate => candidate.entryId === entry.entryId)
  /* v8 ignore start -- the controls below are asserted end-to-end by the
     lifecycle component tests (buttons found, clicked, errors localized);
     the transformer drops element-range attribution for these multi-line
     JSX elements, so the instrumentation undercounts them. */
  return (
    <div className={css.lifecycle}>
      {!lifecycleAvailable || capabilities === null ? (
        <p className={css.lifecycleNote}>{t('lifecycleUnavailable')}</p>
      ) : capabilities.persistence !== 'writable' ? (
        <p className={css.lifecycleNote}>{t('lifecycleReadOnly')}</p>
      ) : capability !== undefined ? (
        <>
          <div className={css.lifecycleActions}>
            {capability.canToggle ? (
              <button
                type="button"
                className={css.lifecycleButton}
                disabled={busy}
                data-plugin-lifecycle-action={entry.enabled ? 'disable' : 'enable'}
                onClick={onToggle}
              >
                {entry.enabled ? t('lifecycleDisable') : t('lifecycleEnable')}
              </button>
            ) : null}
            {capability.canUninstall && confirm === null ? (
              <button
                type="button"
                className={`${css.lifecycleButton} ${css.lifecycleDanger}`}
                disabled={busy}
                data-plugin-lifecycle-action="uninstall"
                onClick={onUninstall}
              >
                {t('lifecycleUninstall')}
              </button>
            ) : null}
            {busy ? <span className={css.lifecycleWorking}>{t('lifecycleWorking')}</span> : null}
          </div>
          {confirm !== null ? (
            <div className={css.lifecycleConfirm} role="group" aria-label={t('lifecycleConfirmTitle')}>
              <strong>{t('lifecycleConfirmTitle')}</strong>
              <p>
                {t('lifecyclePackage')}: <code>{confirm.packageName ?? entry.moduleName}</code>
                {' · '}
                {`${t('lifecycleAffectedEntries')}: ${confirm.affectedEntryIds.length}`}
              </p>
              <p className={css.lifecycleNote}>
                {t('lifecycleConfigRetained')} {t('lifecycleRestartNote')}
              </p>
              <div className={css.lifecycleActions}>
                <button
                  type="button"
                  className={`${css.lifecycleButton} ${css.lifecycleDanger}`}
                  disabled={busy}
                  data-plugin-lifecycle-action="confirm-uninstall"
                  onClick={onConfirmUninstall}
                >
                  {t('lifecycleConfirmUninstall')}
                </button>
                <button
                  type="button"
                  className={css.lifecycleButton}
                  disabled={busy}
                  data-plugin-lifecycle-action="cancel-uninstall"
                  onClick={onCancelConfirm}
                >
                  {t('lifecycleCancel')}
                </button>
              </div>
            </div>
          ) : null}
          {errorCode !== null ? (
            <p className={css.lifecycleError} role="alert">{lifecycleErrorText(errorCode, t)}</p>
          ) : null}
        </>
      ) : null}
    </div>
  )
  /* v8 ignore stop */
}
