import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * The Plugin manager tab: roster with origin badges, source filter, search,
 * detail rows, and lifecycle controls (disable/enable/uninstall with a
 * two-stage confirmation). All RPC flows through the strict client protocol;
 * every failure state renders explicit copy (never silent blanks).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { capabilities, execute, operation, preview } from './protocol.ts';
const ERROR_KEY_BY_CODE, Record;
() => ;
{
    READ_ONLY_REMOTE: 'lifecycleErrorReadOnlyRemote',
        ENTRY_NOT_FOUND;
    'lifecycleErrorEntryNotFound',
        ENTRY_CHANGED;
    'lifecycleErrorEntryChanged',
        BLOCKED_BY_ANCESTOR;
    'lifecycleErrorBlockedByAncestor',
        PROTECTED_PLUGIN;
    'lifecycleErrorProtectedPlugin',
        NOT_DIRECT_DEPENDENCY;
    'lifecycleErrorNotDirectDependency',
        AMBIGUOUS_PACKAGE;
    'lifecycleErrorAmbiguousPackage',
        PROFILE_CHANGED;
    'lifecycleErrorProfileChanged',
        BUSY;
    'lifecycleErrorBusy',
        INVALID_PATCH;
    'lifecycleErrorInvalidPatch',
        MANAGED_BLOCK_INVALID;
    'lifecycleErrorManagedBlockInvalid',
        UNSUPPORTED_PATCH_SHAPE;
    'lifecycleErrorUnsupportedPatchShape',
        PNPM_UNAVAILABLE;
    'lifecycleErrorPnpmUnavailable',
        PACKAGE_MANAGER_FAILED;
    'lifecycleErrorPackageManagerFailed',
        POSTCONDITION_FAILED;
    'lifecycleErrorPostconditionFailed',
        TIMEOUT;
    'lifecycleErrorTimeout',
        ROLLBACK_INCOMPLETE;
    'lifecycleErrorRollbackIncomplete',
        INTERNAL;
    'lifecycleErrorInternal',
        INCOMPATIBLE;
    'channelIncompatible',
        PROTOCOL_INVALID;
    'channelProtocolInvalid',
        UNAVAILABLE;
    'channelUnavailable',
        CANCELLED;
    'channelCancelled',
    ;
}
/** Localize a channel error code; unknown codes stay explicit, not blank. */
export function lifecycleErrorText(code, t) {
    const key = ERROR_KEY_BY_CODE[code];
    return key === undefined ? `${t('lifecycleErrorInternal')} (${code})` : t(key);
}
export function PluginManagerTab({ rpc, t }) {
    const [caps, setCaps] = useState(null);
    const [capsError, setCapsError] = useState(null);
    const [search, setSearch] = useState('');
    const [sourceFilter, setSourceFilter] = useState('all');
    const [expanded, setExpanded] = useState(new Set());
    const [rowState, setRowState] = useState(new Map());
    const [reloadNonce, setReloadNonce] = useState(0);
    const pollTimers = useRef(new Set());
    useEffect(() => {
        const controller = new AbortController();
        setCaps(null);
        setCapsError(null);
        void capabilities(rpc, controller.signal).then((result) => {
            if (controller.signal.aborted)
                return;
            if (result.ok)
                setCaps(result.value);
            else
                setCapsError(lifecycleErrorText(result.code, t));
        });
        return () => { controller.abort(); };
    }, [rpc, reloadNonce, t]);
    useEffect(() => () => { for (const timer of pollTimers.current)
        clearTimeout(timer); }, []);
    const setRow = useCallback((entryId, state) => {
        setRowState(current => new Map(current).set(entryId, state));
    }, []);
    /** Poll one operation until terminal, then reload the roster. */
    const pollOperation = useCallback((entryId, operationId) => {
        const step = () => {
            void operation(rpc, operationId).then(result => {
                if (result.ok) {
                    const view = result.value;
                    if (view.state === 'queued' || view.state === 'running') {
                        const timer = setTimeout(step, 500);
                        pollTimers.current.add(timer);
                        return;
                    }
                }
                if (!result.ok)
                    setRow(entryId, { phase: 'error', code: result.code });
                else if (result.value.state === 'succeeded')
                    setRow(entryId, { phase: 'idle' });
                else
                    setRow(entryId, { phase: 'error', code: result.value.errorCode ?? 'INTERNAL' });
                setReloadNonce(nonce => nonce + 1);
            });
        };
        step();
    }, [rpc]);
    /** Run disable/enable through preview → execute → poll. */
    const runToggle = useCallback((entry, action) => {
        if (caps === null)
            return;
        setRow(entry.entryId, { phase: 'working' });
        void preview(rpc, { entryId: entry.entryId, action, expectedRevision: caps.revision }).then(result => {
            if (!result.ok) {
                setRow(entry.entryId, { phase: 'error', code: result.code });
                return;
            }
            void execute(rpc, result.value.token).then(executed => {
                if (!executed.ok) {
                    setRow(entry.entryId, { phase: 'error', code: executed.code });
                    return;
                }
                pollOperation(entry.entryId, executed.value.operationId);
            });
        });
    }, [rpc, caps, pollOperation]);
    /** Two-stage uninstall: preview → confirm screen → execute → poll. */
    const requestUninstall = useCallback((entry) => {
        if (caps === null)
            return;
        setRow(entry.entryId, { phase: 'working' });
        void preview(rpc, { entryId: entry.entryId, action: 'uninstall', expectedRevision: caps.revision }).then(result => {
            if (!result.ok)
                setRow(entry.entryId, { phase: 'error', code: result.code });
            else
                setRow(entry.entryId, { phase: 'confirm-uninstall' });
        });
    }, [rpc, caps]);
    const confirmUninstall = useCallback((entry) => {
        if (caps === null)
            return;
        setRow(entry.entryId, { phase: 'working' });
        // Re-preview: the confirmation invalidates the earlier token deliberately.
        void preview(rpc, { entryId: entry.entryId, action: 'uninstall', expectedRevision: caps.revision }).then(previewed => {
            if (!previewed.ok) {
                setRow(entry.entryId, { phase: 'error', code: previewed.code });
                return;
            }
            void execute(rpc, previewed.value.token).then(executed => {
                if (!executed.ok) {
                    setRow(entry.entryId, { phase: 'error', code: executed.code });
                    return;
                }
                pollOperation(entry.entryId, executed.value.operationId);
            });
        });
    }, [rpc, caps, pollOperation]);
    const rows = useMemo(() => {
        if (caps === null)
            return [];
        const needle = search.trim().toLowerCase();
        return caps.entries.filter(entry => {
            if (sourceFilter !== 'all') {
                if (entry.origin.kind !== sourceFilter)
                    return false;
            }
            if (needle === '')
                return true;
            return entry.moduleName.toLowerCase().includes(needle)
                || (entry.title?.zh ?? '').toLowerCase().includes(needle)
                || (entry.title?.en ?? '').toLowerCase().includes(needle);
        });
    }, [caps, search, sourceFilter]);
    if (capsError !== null) {
        return (_jsxs("section", { "data-plugin-manager-tab": true, "data-plugin-manager-state": "error", children: [_jsx("p", { role: "alert", children: capsError }), _jsx("button", { type: "button", "data-plugin-manager-action": "retry", onClick: () => { setReloadNonce(nonce => nonce + 1); }, children: t('retry') })] }));
    }
    if (caps === null) {
        return _jsx("section", { "data-plugin-manager-tab": true, "data-plugin-manager-state": "loading", children: _jsx("p", { children: t('loading') }) });
    }
    const readOnly = caps.persistence === 'read-only';
    const sources = new Map();
    for (const entry of caps.entries)
        sources.set(entry.origin.kind, (sources.get(entry.origin.kind) ?? 0) + 1);
    return (_jsxs("section", { "data-plugin-manager-tab": true, "data-plugin-manager-state": "ready", "data-plugin-count": caps.entries.length, children: [_jsxs("header", { children: [_jsx("input", { type: "search", "aria-label": t('search'), placeholder: t('search'), value: search, onChange: event => { setSearch(event.target.value); } }), _jsxs("select", { "aria-label": t('filterBySource'), value: sourceFilter, onChange: event => { setSourceFilter(event.target.value); }, children: [_jsx("option", { value: "all", children: t('sourceAll') }), _jsx("option", { value: "official", children: t('sourceOfficial') }), _jsx("option", { value: "personal", children: t('sourcePersonal') }), _jsx("option", { value: "opensource", children: t('sourceOpensource') })] })] }), readOnly ? _jsx("p", { role: "note", children: t('lifecycleReadOnly') }) : null, rows.length === 0
                ? _jsx("p", { "data-plugin-manager-empty": true, children: search === '' ? t('empty') : t('emptySearch') })
                : (_jsx("ul", { children: rows.map(entry => (_jsxs("li", { "data-plugin-entry": entry.entryId, "data-origin": entry.origin.kind, children: [_jsxs("button", { type: "button", "aria-expanded": expanded.has(entry.entryId), onClick: () => {
                                    setExpanded(current => {
                                        const next = new Set(current);
                                        if (next.has(entry.entryId))
                                            next.delete(entry.entryId);
                                        else
                                            next.add(entry.entryId);
                                        return next;
                                    });
                                }, children: [_jsx("span", { "data-origin-badge": `source-${entry.origin.kind}`, children: entry.origin.kind === 'opensource' && entry.origin.customized ? t('sourceOpensourceCustomized') : t(`source${entry.origin.kind.charAt(0).toUpperCase()}${entry.origin.kind.slice(1)}`) }), _jsx("span", { children: entry.title?.zh ?? entry.moduleName }), _jsx("span", { "data-enabled-tag": true, children: entry.enabled ? t('enabledTag') : t('disabledTag') })] }), expanded.has(entry.entryId)
                                ? (_jsxs("div", { "data-plugin-detail": true, children: [_jsxs("dl", { children: [_jsx("dt", { children: t('module') }), _jsx("dd", { children: entry.moduleName }), _jsx("dt", { children: t('entryId') }), _jsx("dd", { children: entry.entryId }), _jsx("dt", { children: t('originBasis') }), _jsx("dd", { children: originBasisText(entry, t) }), entry.origin.upstream === null ? null : _jsxs(_Fragment, { children: [_jsx("dt", { children: t('upstream') }), _jsx("dd", { children: entry.origin.upstream })] }), entry.origin.fork === null ? null : _jsxs(_Fragment, { children: [_jsx("dt", { children: t('fork') }), _jsx("dd", { children: entry.origin.fork })] }), entry.origin.branch === null ? null : _jsxs(_Fragment, { children: [_jsx("dt", { children: t('branch') }), _jsx("dd", { children: entry.origin.branch })] }), entry.description === null ? null : _jsxs(_Fragment, { children: [_jsx("dt", { children: t('capability') }), _jsx("dd", { children: entry.description.zh })] })] }), _jsx(LifecycleControls, { entry: entry, state: rowState.get(entry.entryId) ?? { phase: 'idle' }, disabled: readOnly, t: t, onToggle: action => { runToggle(entry, action); }, onUninstall: () => { requestUninstall(entry); }, onConfirmUninstall: () => { confirmUninstall(entry); }, onCancelConfirm: () => { setRow(entry.entryId, { phase: 'idle' }); } })] }))
                                : null] }, entry.entryId))) }))] }));
}
/** Origin-basis copy for the detail row. */
function originBasisText(entry, t) {
    if (entry.origin.declaredBy === 'user-override')
        return t('basisUserOverride');
    if (entry.origin.declaredBy === 'manifest')
        return t('basisManifest');
    return t('basisHeuristic');
}
/** Disable/enable/uninstall controls with the two-stage uninstall confirm. */
export function LifecycleControls(props) {
    const { entry, state, disabled, t } = props;
    if (state.phase === 'working') {
        return _jsx("p", { "data-lifecycle-state": "working", role: "status", children: t('lifecycleWorking') });
    }
    if (state.phase === 'confirm-uninstall') {
        return (_jsxs("div", { "data-lifecycle-state": "confirm", role: "group", "aria-label": t('lifecycleConfirmTitle'), children: [_jsx("p", { children: t('lifecycleConfirmTitle') }), _jsxs("p", { children: [t('lifecyclePackage'), ": ", entry.packageName ?? entry.moduleName] }), _jsx("p", { children: t('lifecycleRestartNote') }), _jsx("button", { type: "button", "data-lifecycle-action": "cancel-uninstall", onClick: props.onCancelConfirm, children: t('lifecycleCancel') }), _jsx("button", { type: "button", "data-lifecycle-action": "confirm-uninstall", onClick: props.onConfirmUninstall, children: t('lifecycleConfirmUninstall') })] }));
    }
    return (_jsxs("div", { "data-lifecycle-state": state.phase === 'error' ? 'error' : 'idle', children: [state.phase === 'error' ? _jsx("p", { role: "alert", children: lifecycleErrorText(state.code, t) }) : null, entry.canToggle && !entry.enabled
                ? _jsx("button", { type: "button", "data-lifecycle-action": "enable", disabled: disabled, onClick: () => { props.onToggle('enable'); }, children: t('lifecycleEnable') })
                : null, entry.canToggle && entry.enabled
                ? _jsx("button", { type: "button", "data-lifecycle-action": "disable", disabled: disabled, onClick: () => { props.onToggle('disable'); }, children: t('lifecycleDisable') })
                : null, entry.canUninstall
                ? _jsx("button", { type: "button", "data-lifecycle-action": "uninstall", disabled: disabled, onClick: props.onUninstall, children: t('lifecycleUninstall') })
                : null, !entry.canToggle && !entry.canUninstall
                ? _jsx("p", { children: t('lifecycleUnavailable') })
                : null] }));
}
