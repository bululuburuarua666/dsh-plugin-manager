/**
 * The Plugin manager tab: roster with origin badges, source filter, search,
 * detail rows, lifecycle controls (disable/enable/uninstall with a
 * two-stage confirmation), and the origin classification editor (manual
 * override + restore-automatic). All RPC flows through the strict client
 * protocol; every failure state renders explicit copy (never silent blanks).
 *
 * Origin overrides are display classifications only: they never change
 * canToggle/canUninstall or any protected-package decision.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChannelCaller,
  ClientCapabilities,
  ClientEntry,
  ClientOperationView,
  ClientOrigin,
  ClientOriginOverrideInput,
  ClientOriginState,
  ClientResult,
} from './protocol.ts'
import { capabilities, execute, operation, originState, originUpdate, preview } from './protocol.ts'
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

/** The editor's classification choices (customized splits opensource). */
type OriginSelection = 'official' | 'personal' | 'opensource' | 'opensource-customized'

/** One row's origin editor UI state. */
type OriginEditor =
  | { readonly phase: 'loading' }
  | { readonly phase: 'error'; readonly code: string }
  | {
    readonly phase: 'open'
    /** The originState snapshot the editor opened with (revision source). */
    readonly base: ClientOriginState
    readonly selection: OriginSelection
    readonly note: string
    /** Resolved error copy from the last save attempt, when any. */
    readonly error: string | null
    readonly saving: boolean
  }

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
  ORIGIN_CONFLICT: 'lifecycleErrorOriginConflict',
  ORIGIN_FILE_INVALID: 'lifecycleErrorOriginFileInvalid',
  ORIGIN_UNAVAILABLE: 'lifecycleErrorOriginUnavailable',
  ORIGIN_NOTE_REQUIRED: 'originNoteRequired',
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

/** Display label of one origin: the kind, with the customized marker. */
function originLabel(origin: ClientOrigin, t: (key: ManagerLocaleKey) => string): string {
  if (origin.kind === 'opensource' && origin.customized) return t('sourceOpensourceCustomized')
  return t(`source${origin.kind.charAt(0).toUpperCase()}${origin.kind.slice(1)}` as ManagerLocaleKey)
}

/** Initial editor selection from the effective origin. */
function selectionOf(origin: ClientOrigin): OriginSelection {
  if (origin.kind === 'opensource') return origin.customized ? 'opensource-customized' : 'opensource'
  return origin.kind
}

/** Flatten a stored override note (string or bilingual pair) to one string. */
export function noteTextOf(note: string | { zh: string; en: string } | null | undefined): string {
  if (typeof note === 'string') return note
  if (note === null || note === undefined) return ''
  return note.zh !== '' ? note.zh : note.en
}

/**
 * Build the originUpdate override payload for one editor state. A customized
 * open-source classification without a note is rejected locally — the Host
 * enforces the same rule, the local check just saves the round trip.
 */
export function overridePayload(
  selection: OriginSelection,
  note: string,
): { readonly ok: true; readonly override: ClientOriginOverrideInput } | { readonly ok: false } {
  const trimmed = note.trim()
  if (selection === 'opensource-customized' && trimmed === '') return { ok: false }
  const noteField = trimmed === '' ? null : trimmed
  switch (selection) {
    case 'official': return { ok: true, override: { kind: 'official', note: noteField } }
    case 'personal': return { ok: true, override: { kind: 'personal', note: noteField } }
    case 'opensource': return { ok: true, override: { kind: 'opensource', customized: false, note: noteField } }
    case 'opensource-customized': return { ok: true, override: { kind: 'opensource', customized: true, note: trimmed } }
  }
}

/** Radio label of one editor selection. */
function selectionLabel(selection: OriginSelection, t: (key: ManagerLocaleKey) => string): string {
  switch (selection) {
    case 'official': return t('sourceOfficial')
    case 'personal': return t('sourcePersonal')
    case 'opensource': return t('sourceOpensource')
    case 'opensource-customized': return t('sourceOpensourceCustomized')
  }
}

const ORIGIN_SELECTIONS: readonly OriginSelection[] = ['official', 'personal', 'opensource', 'opensource-customized']

export function PluginManagerTab({ rpc, t }: PluginManagerTabProps) {
  const [caps, setCaps] = useState<ClientCapabilities | null>(null)
  const [capsError, setCapsError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [sourceFilter, setSourceFilter] = useState<'all' | 'official' | 'personal' | 'opensource'>('all')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [rowState, setRowState] = useState<ReadonlyMap<string, RowLifecycle>>(new Map())
  const [originEditors, setOriginEditors] = useState<ReadonlyMap<string, OriginEditor>>(new Map())
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

  /** Set or clear (null) one row's origin editor state. */
  const setEditor = useCallback((entryId: string, state: OriginEditor | null) => {
    setOriginEditors(current => {
      const next = new Map(current)
      if (state === null) next.delete(entryId)
      else next.set(entryId, state)
      return next
    })
  }, [])

  /** Patch the open editor of one row; a stale event leaves the map alone. */
  const patchEditor = useCallback((entryId: string, patch: { selection?: OriginSelection; note?: string }) => {
    setOriginEditors(current => {
      const editor = current.get(entryId)
      /* v8 ignore next -- the radios/textarea render only while the editor is open; this guards a stale event after close. */
      if (editor?.phase !== 'open') return current
      const next = new Map(current)
      next.set(entryId, { ...editor, ...patch, error: null })
      return next
    })
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

  /** Open the origin editor: fetch the live layers and revision first. */
  const openOriginEditor = useCallback((entry: ClientEntry) => {
    setEditor(entry.entryId, { phase: 'loading' })
    void originState(rpc, entry.entryId).then(result => {
      if (!result.ok) {
        setEditor(entry.entryId, { phase: 'error', code: result.code })
        return
      }
      setEditor(entry.entryId, {
        phase: 'open',
        base: result.value,
        selection: selectionOf(result.value.effective),
        note: noteTextOf(result.value.override?.note),
        error: null,
        saving: false,
      })
    })
  }, [rpc, setEditor])

  /** Submit an originUpdate: a classification override, or null to restore. */
  const submitOrigin = useCallback((entry: ClientEntry, override: ClientOriginOverrideInput | null) => {
    const editor = originEditors.get(entry.entryId)
    /* v8 ignore next -- save/restore render only while the editor is open; this guards a stale click after close. */
    if (editor?.phase !== 'open') return
    setEditor(entry.entryId, { ...editor, saving: true, error: null })
    void originUpdate(rpc, { entryId: entry.entryId, expectedOriginRevision: editor.base.originRevision, override }).then(result => {
      if (!result.ok) {
        setEditor(entry.entryId, { ...editor, saving: false, error: lifecycleErrorText(result.code, t) })
        return
      }
      // Success: close the editor and reload so badges and filters refresh.
      setEditor(entry.entryId, null)
      setReloadNonce(nonce => nonce + 1)
    })
  }, [rpc, originEditors, setEditor, t])

  /** Save the editor's current selection as the package's override. */
  const saveOrigin = useCallback((entry: ClientEntry) => {
    const editor = originEditors.get(entry.entryId)
    /* v8 ignore next -- stale-click guard; see submitOrigin. */
    if (editor?.phase !== 'open') return
    const payload = overridePayload(editor.selection, editor.note)
    if (!payload.ok) {
      setEditor(entry.entryId, { ...editor, error: t('originNoteRequired') })
      return
    }
    submitOrigin(entry, payload.override)
  }, [originEditors, setEditor, submitOrigin, t])

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
                      {originLabel(entry.origin, t)}{entry.origin.declaredBy === 'user-override' ? ` · ${t('originManual')}` : ''}
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
                            <dt>{t('originCurrent')}</dt><dd>{originLabel(entry.origin, t)}{entry.origin.declaredBy === 'user-override' ? ` · ${t('originManual')}` : ''}</dd>
                            <dt>{t('originDetected')}</dt><dd>{originLabel(entry.detectedOrigin, t)}</dd>
                            <dt>{t('originBasis')}</dt><dd>{originBasisText(entry, t)}</dd>
                            {entry.origin.upstream === null ? null : <><dt>{t('upstream')}</dt><dd>{entry.origin.upstream}</dd></>}
                            {entry.origin.fork === null ? null : <><dt>{t('fork')}</dt><dd>{entry.origin.fork}</dd></>}
                            {entry.origin.branch === null ? null : <><dt>{t('branch')}</dt><dd>{entry.origin.branch}</dd></>}
                            {entry.origin.note === null ? null : <><dt>{t('originNote')}</dt><dd>{entry.origin.note.zh}</dd></>}
                            {entry.description === null ? null : <><dt>{t('capability')}</dt><dd>{entry.description.zh}</dd></>}
                          </dl>
                          {entry.packageName === null || originEditors.has(entry.entryId)
                            ? null
                            : (
                                <button
                                  type="button"
                                  data-origin-action="edit"
                                  disabled={readOnly}
                                  onClick={() => { openOriginEditor(entry) }}
                                >
                                  {t('originEdit')}
                                </button>
                              )}
                          <OriginEditorPanel
                            entry={entry}
                            editor={originEditors.get(entry.entryId)}
                            readOnly={readOnly}
                            t={t}
                            onSelect={selection => { patchEditor(entry.entryId, { selection }) }}
                            onNote={note => { patchEditor(entry.entryId, { note }) }}
                            onSave={() => { saveOrigin(entry) }}
                            onRestoreAuto={() => { submitOrigin(entry, null) }}
                            onCancel={() => { setEditor(entry.entryId, null) }}
                          />
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

/** The origin classification editor: loading, error, and open phases. */
export function OriginEditorPanel(props: {
  readonly entry: ClientEntry
  readonly editor: OriginEditor | undefined
  readonly readOnly: boolean
  readonly t: (key: ManagerLocaleKey) => string
  onSelect: (selection: OriginSelection) => void
  onNote: (note: string) => void
  onSave: () => void
  onRestoreAuto: () => void
  onCancel: () => void
}) {
  const { editor, readOnly, t } = props
  if (editor === undefined) return null
  if (editor.phase === 'loading') {
    return <p data-origin-editor="loading" role="status">{t('lifecycleWorking')}</p>
  }
  if (editor.phase === 'error') {
    return (
      <div data-origin-editor="error">
        <p role="alert">{lifecycleErrorText(editor.code, t)}</p>
        <button type="button" data-origin-action="cancel" onClick={props.onCancel}>{t('lifecycleCancel')}</button>
      </div>
    )
  }
  return (
    <fieldset data-origin-editor="open">
      <legend>{t('originEditorTitle')}</legend>
      <p>{t('originDetected')}: {originLabel(editor.base.detected, t)}</p>
      {ORIGIN_SELECTIONS.map(option => (
        <label key={option} data-origin-option={option}>
          <input
            type="radio"
            name={`origin-edit-${props.entry.entryId}`}
            checked={editor.selection === option}
            disabled={editor.saving}
            onChange={() => { props.onSelect(option) }}
          />
          {selectionLabel(option, t)}
        </label>
      ))}
      {editor.selection === 'official' ? <p role="note">{t('originOfficialHint')}</p> : null}
      <label>
        {t('originNoteLabel')}
        <textarea
          rows={2}
          value={editor.note}
          placeholder={t('originNotePlaceholder')}
          disabled={editor.saving}
          onChange={event => { props.onNote(event.target.value) }}
        />
      </label>
      {editor.error === null ? null : <p role="alert">{editor.error}</p>}
      <button type="button" data-origin-action="save" disabled={editor.saving || readOnly} onClick={props.onSave}>{t('originSave')}</button>
      {editor.base.override === null
        ? null
        : <button type="button" data-origin-action="restore-auto" disabled={editor.saving || readOnly} onClick={props.onRestoreAuto}>{t('originRestoreAuto')}</button>}
      <button type="button" data-origin-action="cancel" disabled={editor.saving} onClick={props.onCancel}>{t('lifecycleCancel')}</button>
    </fieldset>
  )
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
