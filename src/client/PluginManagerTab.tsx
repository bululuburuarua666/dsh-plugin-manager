/**
 * The Plugin manager tab: roster with origin badges, source filter, search,
 * detail rows, and lifecycle controls (disable/enable/uninstall with a
 * two-stage confirmation). All RPC flows through the strict client protocol;
 * every failure state renders explicit copy (never silent blanks).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChannelCaller, ClientCapabilities, ClientEntry, ClientOperationView, ClientResult } from './protocol.ts'
import { capabilities, execute, operation, preview } from './protocol.ts'
import type { ManagerLocaleKey } from './locales.ts'

/** Props injected by the slot registration. */
export interface PluginManagerTabProps {
  readonly rpc: ChannelCaller
  readonly t: (key: ManagerLocaleKey) => string
}

/** One row's transient lifecycle UI state. */
type RowLifecycle =
  | { readonly phase: 'idle' }
  | { readonly phase: 'working' }
  | { readonly phase: 'confirm-uninstall' }
  | { readonly phase: 'error'; readonly code: string }

const ERROR_KEY_BY_CODE: Readonly<Record<string, ManagerLocaleKey>> = {
  READ_ONLY_REMOTE: 'lifecycleErrorReadOnlyRemote',
  ENTRY_NOT_FOUND: 'lifecycleErrorEntryNotFound',
  ENTRY_CHANGED: 'lifecycleErrorEntryChanged',
  BLOCKED_BY_ANCESTOR: 'lifecycleErrorBlockedByAncestor',
  PROTECTED_PLUGIN: 'lifecycleErrorProtectedPlugin',
  NOT_DIRECT_DEPENDENCY: 'lifecycleErrorNotDirectDependency',
  AMBIGUOUS_PACKAGE: 'lifecycleErrorAmbiguousPackage',
  PROFILE_CHANGED: 'lifecycleErrorProfileChanged',
  BUSY: 'lifecycleErrorBusy',
  INVALID_PATCH: 'lifecycleErrorInvalidPatch',
  MANAGED_BLOCK_INVALID: 'lifecycleErrorManagedBlockInvalid',
  UNSUPPORTED_PATCH_SHAPE: 'lifecycleErrorUnsupportedPatchShape',
  PNPM_UNAVAILABLE: 'lifecycleErrorPnpmUnavailable',
  PACKAGE_MANAGER_FAILED: 'lifecycleErrorPackageManagerFailed',
  POSTCONDITION_FAILED: 'lifecycleErrorPostconditionFailed',
  TIMEOUT: 'lifecycleErrorTimeout',
  ROLLBACK_INCOMPLETE: 'lifecycleErrorRollbackIncomplete',
  INTERNAL: 'lifecycleErrorInternal',
  INCOMPATIBLE: 'channelIncompatible',
  PROTOCOL_INVALID: 'channelProtocolInvalid',
  UNAVAILABLE: 'channelUnavailable',
  CANCELLED: 'channelCancelled',
}

/** Localize a channel error code; unknown codes stay explicit, not blank. */
export function lifecycleErrorText(code: string, t: (key: ManagerLocaleKey) => string): string {
  const key = ERROR_KEY_BY_CODE[code]
  return key === undefined ? `${t('lifecycleErrorInternal')} (${code})` : t(key)
}

export function PluginManagerTab({ rpc, t }: PluginManagerTabProps) {
  const [caps, setCaps] = useState<ClientCapabilities | null>(null)
  const [capsError, setCapsError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [sourceFilter, setSourceFilter] = useState<'all' | 'official' | 'personal' | 'opensource'>('all')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [rowState, setRowState] = useState<ReadonlyMap<string, RowLifecycle>>(new Map())
  const [reloadNonce, setReloadNonce] = useState(0)
  const pollTimers = useRef(new Set<ReturnType<typeof setTimeout>>())

  useEffect(() => {
    const controller = new AbortController()
    setCaps(null)
    setCapsError(null)
    void capabilities(rpc, controller.signal).then((result: ClientResult<ClientCapabilities>) => {
      /* v8 ignore next -- the aborted arm needs the effect torn down mid-flight (nonce reload or unmount racing the response); the jsdom suites always settle responses before re-rendering. */
      if (controller.signal.aborted) return
      if (result.ok) setCaps(result.value)
      else setCapsError(lifecycleErrorText(result.code, t))
    })
    return () => { controller.abort() }
  }, [rpc, reloadNonce, t])

  useEffect(() => () => { for (const timer of pollTimers.current) clearTimeout(timer) }, [])

  const setRow = useCallback((entryId: string, state: RowLifecycle) => {
    setRowState(current => new Map(current).set(entryId, state))
  }, [])

  /** Poll one operation until terminal, then reload the roster. */
  const pollOperation = useCallback((entryId: string, operationId: string) => {
    const step = (): void => {
      void operation(rpc, operationId).then(result => {
        if (result.ok) {
          const view: ClientOperationView = result.value
          if (view.state === 'queued' || view.state === 'running') {
            const timer = setTimeout(step, 500)
            pollTimers.current.add(timer)
            return
          }
        }
        if (!result.ok) setRow(entryId, { phase: 'error', code: result.code })
        else if (result.value.state === 'succeeded') setRow(entryId, { phase: 'idle' })
        else setRow(entryId, { phase: 'error', code: terminalErrorCode(result.value.errorCode) })
        setReloadNonce(nonce => nonce + 1)
      })
    }
    step()
  }, [rpc])

  /** Run disable/enable through preview → execute → poll. */
  const runToggle = useCallback((entry: ClientEntry, action: 'disable' | 'enable') => {
    /* v8 ignore next -- the controls that call this render only while caps is set; the guard fires only on a stale-closure re-render race. */
    if (caps === null) return
    setRow(entry.entryId, { phase: 'working' })
    void preview(rpc, { entryId: entry.entryId, action, expectedRevision: caps.revision }).then(result => {
      if (!result.ok) {
        setRow(entry.entryId, { phase: 'error', code: result.code })
        return
      }
      void execute(rpc, result.value.token).then(executed => {
        if (!executed.ok) {
          setRow(entry.entryId, { phase: 'error', code: executed.code })
          return
        }
        pollOperation(entry.entryId, executed.value.operationId)
      })
    })
  }, [rpc, caps, pollOperation])

  /** Two-stage uninstall: preview → confirm screen → execute → poll. */
  const requestUninstall = useCallback((entry: ClientEntry) => {
    /* v8 ignore next -- stale-closure guard; see runToggle. */
    if (caps === null) return
    setRow(entry.entryId, { phase: 'working' })
    void preview(rpc, { entryId: entry.entryId, action: 'uninstall', expectedRevision: caps.revision }).then(result => {
      if (!result.ok) setRow(entry.entryId, { phase: 'error', code: result.code })
      else setRow(entry.entryId, { phase: 'confirm-uninstall' })
    })
  }, [rpc, caps])

  const confirmUninstall = useCallback((entry: ClientEntry) => {
    /* v8 ignore next -- stale-closure guard; see runToggle. */
    if (caps === null) return
    setRow(entry.entryId, { phase: 'working' })
    // Re-preview: the confirmation invalidates the earlier token deliberately.
    void preview(rpc, { entryId: entry.entryId, action: 'uninstall', expectedRevision: caps.revision }).then(previewed => {
      if (!previewed.ok) {
        setRow(entry.entryId, { phase: 'error', code: previewed.code })
        return
      }
      void execute(rpc, previewed.value.token).then(executed => {
        if (!executed.ok) {
          setRow(entry.entryId, { phase: 'error', code: executed.code })
          return
        }
        pollOperation(entry.entryId, executed.value.operationId)
      })
    })
  }, [rpc, caps, pollOperation])

  const rows = useMemo(() => {
    if (caps === null) return []
    const needle = search.trim().toLowerCase()
    return caps.entries.filter(entry => {
      if (sourceFilter !== 'all') {
        if (entry.origin.kind !== sourceFilter) return false
      }
      if (needle === '') return true
      return entry.moduleName.toLowerCase().includes(needle)
        || (entry.title?.zh ?? '').toLowerCase().includes(needle)
        || (entry.title?.en ?? '').toLowerCase().includes(needle)
    })
  }, [caps, search, sourceFilter])

  if (capsError !== null) {
    return (
      <section data-plugin-manager-tab data-plugin-manager-state="error">
        <p role="alert">{capsError}</p>
        <button type="button" data-plugin-manager-action="retry" onClick={() => { setReloadNonce(nonce => nonce + 1) }}>{t('retry')}</button>
      </section>
    )
  }
  if (caps === null) {
    return <section data-plugin-manager-tab data-plugin-manager-state="loading"><p>{t('loading')}</p></section>
  }

  const readOnly = caps.persistence === 'read-only'
  const sources = new Map<string, number>()
  for (const entry of caps.entries) sources.set(entry.origin.kind, (sources.get(entry.origin.kind) ?? 0) + 1)

  return (
    <section data-plugin-manager-tab data-plugin-manager-state="ready" data-plugin-count={caps.entries.length}>
      <header>
        <input
          type="search"
          aria-label={t('search')}
          placeholder={t('search')}
          value={search}
          onChange={event => { setSearch(event.target.value) }}
        />
        <select
          aria-label={t('filterBySource')}
          value={sourceFilter}
          onChange={event => { setSourceFilter(event.target.value as typeof sourceFilter) }}
        >
          <option value="all">{t('sourceAll')}</option>
          <option value="official">{t('sourceOfficial')}</option>
          <option value="personal">{t('sourcePersonal')}</option>
          <option value="opensource">{t('sourceOpensource')}</option>
        </select>
      </header>
      {readOnly ? <p role="note">{t('lifecycleReadOnly')}</p> : null}
      {rows.length === 0
        ? <p data-plugin-manager-empty>{search === '' ? t('empty') : t('emptySearch')}</p>
        : (
            <ul>
              {rows.map(entry => (
                <li key={entry.entryId} data-plugin-entry={entry.entryId} data-origin={entry.origin.kind}>
                  <button
                    type="button"
                    aria-expanded={expanded.has(entry.entryId)}
                    onClick={() => {
                      setExpanded(current => {
                        const next = new Set(current)
                        if (next.has(entry.entryId)) next.delete(entry.entryId)
                        else next.add(entry.entryId)
                        return next
                      })
                    }}
                  >
                    <span data-origin-badge={`source-${entry.origin.kind}`}>
                      {entry.origin.kind === 'opensource' && entry.origin.customized ? t('sourceOpensourceCustomized') : t(`source${entry.origin.kind.charAt(0).toUpperCase()}${entry.origin.kind.slice(1)}` as ManagerLocaleKey)}
                    </span>
                    <span>{entry.title?.zh ?? entry.moduleName}</span>
                    <span data-enabled-tag>{entry.enabled ? t('enabledTag') : t('disabledTag')}</span>
                  </button>
                  {expanded.has(entry.entryId)
                    ? (
                        <div data-plugin-detail>
                          <dl>
                            <dt>{t('module')}</dt><dd>{entry.moduleName}</dd>
                            <dt>{t('entryId')}</dt><dd>{entry.entryId}</dd>
                            <dt>{t('originBasis')}</dt><dd>{originBasisText(entry, t)}</dd>
                            {entry.origin.upstream === null ? null : <><dt>{t('upstream')}</dt><dd>{entry.origin.upstream}</dd></>}
                            {entry.origin.fork === null ? null : <><dt>{t('fork')}</dt><dd>{entry.origin.fork}</dd></>}
                            {entry.origin.branch === null ? null : <><dt>{t('branch')}</dt><dd>{entry.origin.branch}</dd></>}
                            {entry.description === null ? null : <><dt>{t('capability')}</dt><dd>{entry.description.zh}</dd></>}
                          </dl>
                          <LifecycleControls
                            entry={entry}
                            state={rowState.get(entry.entryId) ?? { phase: 'idle' }}
                            disabled={readOnly}
                            t={t}
                            onToggle={action => { runToggle(entry, action) }}
                            onUninstall={() => { requestUninstall(entry) }}
                            onConfirmUninstall={() => { confirmUninstall(entry) }}
                            onCancelConfirm={() => { setRow(entry.entryId, { phase: 'idle' }) }}
                          />
                        </div>
                      )
                    : null}
                </li>
              ))}
            </ul>
          )}
    </section>
  )
}

/** A terminal non-succeeded view always reports a code; the null arm only guards against an engine invariant break and is exercised by the null-code terminal test below. */
function terminalErrorCode(code: string | null): string {
  if (code === null) return 'INTERNAL'
  return code
}

/** Origin-basis copy for the detail row. */
function originBasisText(entry: ClientEntry, t: (key: ManagerLocaleKey) => string): string {
  if (entry.origin.declaredBy === 'user-override') return t('basisUserOverride')
  if (entry.origin.declaredBy === 'manifest') return t('basisManifest')
  return t('basisHeuristic')
}

/** Disable/enable/uninstall controls with the two-stage uninstall confirm. */
export function LifecycleControls(props: {
  readonly entry: ClientEntry
  readonly state: RowLifecycle
  readonly disabled: boolean
  readonly t: (key: ManagerLocaleKey) => string
  onToggle: (action: 'disable' | 'enable') => void
  onUninstall: () => void
  onConfirmUninstall: () => void
  onCancelConfirm: () => void
}) {
  const { entry, state, disabled, t } = props
  if (state.phase === 'working') {
    return <p data-lifecycle-state="working" role="status">{t('lifecycleWorking')}</p>
  }
  if (state.phase === 'confirm-uninstall') {
    return (
      <div data-lifecycle-state="confirm" role="group" aria-label={t('lifecycleConfirmTitle')}>
        <p>{t('lifecycleConfirmTitle')}</p>
        <p>{t('lifecyclePackage')}: {entry.packageName ?? entry.moduleName}</p>
        <p>{t('lifecycleRestartNote')}</p>
        <button type="button" data-lifecycle-action="cancel-uninstall" onClick={props.onCancelConfirm}>{t('lifecycleCancel')}</button>
        <button type="button" data-lifecycle-action="confirm-uninstall" onClick={props.onConfirmUninstall}>{t('lifecycleConfirmUninstall')}</button>
      </div>
    )
  }
  return (
    <div data-lifecycle-state={state.phase === 'error' ? 'error' : 'idle'}>
      {state.phase === 'error' ? <p role="alert">{lifecycleErrorText(state.code, t)}</p> : null}
      {entry.canToggle && !entry.enabled
        ? <button type="button" data-lifecycle-action="enable" disabled={disabled} onClick={() => { props.onToggle('enable') }}>{t('lifecycleEnable')}</button>
        : null}
      {entry.canToggle && entry.enabled
        ? <button type="button" data-lifecycle-action="disable" disabled={disabled} onClick={() => { props.onToggle('disable') }}>{t('lifecycleDisable')}</button>
        : null}
      {entry.canUninstall
        ? <button type="button" data-lifecycle-action="uninstall" disabled={disabled} onClick={props.onUninstall}>{t('lifecycleUninstall')}</button>
        : null}
      {!entry.canToggle && !entry.canUninstall
        ? <p>{t('lifecycleUnavailable')}</p>
        : null}
    </div>
  )
}
