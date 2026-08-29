/**
 * Lifecycle engine: capabilities / preview / execute / operation over the
 * pure modules (token store, operation store, patch editor, evidence,
 * uninstall transaction). Ported from the upstream plugin-lifecycle service
 * with the Cordis shell removed — the host entry supplies the roster and the
 * file IO; the RPC channel (T04) and the UI (T05) consume this engine.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write';
import { applyManagedToggleRows, patchTargetIdOf, readManagedToggleRows, ROOT_INCLUDE_ID, treeIdOfPatchTarget, } from "./patch-editor.js";
import { buildEntryEvidence, capabilityOf, computeRevision, createEvidenceSession, fileDigest, readProfileManifestView, } from "./profile-evidence.js";
import { PluginLifecycleTokenStore } from "./token-store.js";
import { PluginLifecycleOperationStore } from "./operation-store.js";
import { clearSettledPendingRemovals, readPendingRemovals, runUninstallTransaction, } from "./uninstall.js";
import { runPnpm } from "./package-runner.js";
import { lifecycleFailure } from "./failure.js";
/** How long a toggle waits for the Loader to reflect the new state. */
const LOADER_APPLY_TIMEOUT_MS = 5_000;
/** Loader poll cadence while awaiting a toggle's effective state. */
const LOADER_APPLY_POLL_MS = 25;
/** Derive the profile directory from the Loader base URL, when there is one. */
function profileDirOf(baseUrl) {
    if (baseUrl === undefined || baseUrl.length === 0)
        return null;
    try {
        return fileURLToPath(new URL('.', baseUrl));
    }
    catch {
        return null;
    }
}
/** Map a capability block reason to its wire error code. */
export function blockReasonToCode(reason) {
    switch (reason) {
        case 'read-only-remote': return 'READ_ONLY_REMOTE';
        case 'protected-plugin':
        case 'engine-owned':
        case 'template-bundle':
            return 'PROTECTED_PLUGIN';
        case 'ambiguous-package': return 'AMBIGUOUS_PACKAGE';
        case 'manual-insert-unsupported': return 'UNSUPPORTED_PATCH_SHAPE';
        default: return 'NOT_DIRECT_DEPENDENCY';
    }
}
/** The lifecycle engine. All mutation intent flows preview → execute → poll. */
export class LifecycleEngine {
    loaderBaseUrl;
    host;
    /** One-use preview tokens binding action and evidence (bounded). */
    tokens = new PluginLifecycleTokenStore();
    /** Bounded operation ledger polled by the client. */
    operations = new PluginLifecycleOperationStore();
    /** In-process mutation serialization per profile directory. */
    mutexes = new Map();
    constructor(loaderBaseUrl, host) {
        this.loaderBaseUrl = loaderBaseUrl;
        this.host = host;
    }
    /** The no-shell package runner uninstalls delegate to. */
    createPackageRunner() {
        return this.host.createPackageRunner?.() ?? {
            remove: async (packageName, cwd) => {
                await runPnpm(['remove', '--save-prod', packageName], cwd);
            },
            installFrozen: async (cwd) => {
                await runPnpm(['install', '--frozen-lockfile'], cwd);
            },
        };
    }
    /**
     * Startup cleanup: for each settled pending-removal record, remove its
     * managed rows and then the record. Ordering is fail-closed throughout:
     * the patch is re-read and re-parsed INSIDE the lock (an outside read
     * could overwrite concurrent user edits), the pending records are only
     * cleared after the patch write committed, and any parse or write failure
     * keeps the records so the next startup can retry idempotently.
     */
    async startupCleanup() {
        const profileDir = profileDirOf(this.loaderBaseUrl);
        if (profileDir === null)
            return;
        const io = this.fileIo();
        const pendingPath = join(profileDir, 'dsh-plugin-manager-pending-removals.json');
        const patchPath = join(profileDir, 'cordis.patch.yml');
        const manifestPath = join(profileDir, 'package.json');
        const records = readPendingRemovals(io, pendingPath);
        if (records.length === 0)
            return;
        const settled = records.filter((record) => {
            const manifest = readProfileManifestView(manifestPath);
            if (manifest.dependencies.has(record.packageName))
                return false;
            const present = [...this.host.entries()]
                .filter(entry => record.entryIds.includes(entry.id));
            return present.length === 0;
        });
        if (settled.length === 0)
            return;
        const settledKeys = new Set(settled.map(record => record.operationId));
        // Patch rewrite happens under the lock with a fresh in-lock read; on any
        // failure the pending records survive for an idempotent next-start retry.
        let patchCommitted = false;
        await withFileLock(patchPath, async () => {
            const patchBefore = io.readText(patchPath);
            const current = readManagedToggleRows(patchBefore);
            // A malformed managed block fails closed: throwing keeps the records
            // for manual recovery instead of clearing them over a broken file.
            if (current !== null && !current.ok) {
                throw lifecycleFailure('MANAGED_BLOCK_INVALID', current.message);
            }
            if (current !== null) {
                // Managed rows are keyed by patch-space data ids while pending
                // records carry loader tree ids; compare against both spellings of
                // each id (strict root-space strip only — nested subtree ids never
                // had addressable rows).
                const settledIds = new Set();
                const prefix = `${ROOT_INCLUDE_ID}:`;
                for (const record of settled) {
                    for (const id of record.entryIds) {
                        settledIds.add(id);
                        if (id.startsWith(prefix) && !id.slice(prefix.length).includes(':')) {
                            settledIds.add(id.slice(prefix.length));
                        }
                    }
                }
                const kept = current.rows.filter(row => !settledIds.has(row.entryId));
                const rewritten = applyManagedToggleRows(patchBefore, kept);
                if (!rewritten.ok)
                    throw lifecycleFailure(rewritten.code, rewritten.message);
                await writeFileAtomic(patchPath, rewritten.content, { mode: 0o600 });
            }
            // No managed block at all (null): nothing to rewrite, the rows are
            // already gone; committing clears the now-settled records.
            patchCommitted = true;
        }).catch(() => {
            // Lock failure, malformed block, or write failure: the pending records
            // stay untouched so the next startup retries idempotently.
            patchCommitted = false;
        });
        if (!patchCommitted)
            return;
        await clearSettledPendingRemovals(io, pendingPath, record => settledKeys.has(record.operationId));
    }
    /** Capability snapshot of the active profile, rebuilt per call. */
    capabilities() {
        const bundle = this.evidence();
        return {
            revision: bundle.revision,
            persistence: bundle.persistence,
            entries: bundle.capabilities,
        };
    }
    /** Begin a mutation intent: validate capability and issue a one-use token. */
    preview(request) {
        const bundle = this.evidence();
        if (bundle.persistence !== 'writable') {
            throw lifecycleFailure('READ_ONLY_REMOTE', 'this deployment serves read-only clients');
        }
        if (request.expectedRevision !== bundle.revision) {
            throw lifecycleFailure('PROFILE_CHANGED', 'the capability snapshot changed; re-read it');
        }
        const capability = bundle.capabilities.find(entry => entry.entryId === request.entryId);
        if (capability === undefined) {
            throw lifecycleFailure('ENTRY_NOT_FOUND', 'the entry is not in the current Loader tree');
        }
        if (request.action === 'uninstall' && !capability.canUninstall) {
            throw lifecycleFailure(
            /* v8 ignore next -- the capability layer always pairs canUninstall=false with a block reason; the ?? arm guards internal drift only. */
            blockReasonToCode(capability.uninstallBlockReason ?? 'not-direct-dependency'), 'the package may not be uninstalled through this surface');
        }
        if (request.action !== 'uninstall' && !capability.canToggle) {
            // Toggles are denied for read-only surfaces, rows outside the profile's
            // root patch space (no addressable data id), and protected
            // infrastructure rows.
            throw lifecycleFailure(
            /* v8 ignore next -- the capability layer always pairs canToggle=false with a block reason. */
            blockReasonToCode(capability.toggleBlockReason ?? 'not-direct-dependency'), 'the entry may not be toggled through this surface');
        }
        const evidenceEntry = bundle.entries.find(entry => entry.entryId === request.entryId);
        const affected = request.action === 'uninstall'
            ? bundle.entries
                .filter(entry => entry.packageName !== null && entry.packageName === capability.packageName)
            : [];
        // canUninstall already gates out packages with any non-root-space entry
        // (the capabilities package-group pass), so every affected data id is
        // present by construction.
        const affectedDataIds = affected.map(entry => entry.patchTargetId);
        const affectedEntryIds = affected.length > 0
            ? affected.map(entry => entry.entryId)
            : [request.entryId];
        if (affected.length === 0 && evidenceEntry !== undefined && evidenceEntry.patchTargetId !== null) {
            affectedDataIds.push(evidenceEntry.patchTargetId);
        }
        const restartRequired = request.action === 'uninstall';
        const issued = this.tokens.issue({
            action: request.action,
            entryId: request.entryId,
            /* v8 ignore next -- the capability lookup above guarantees the entry exists; the ?? arm is defensive. */
            patchTargetId: evidenceEntry?.patchTargetId ?? null,
            packageName: capability.packageName,
            affectedEntryIds,
            affectedDataIds,
            restartRequired,
            revision: bundle.revision,
        });
        return {
            token: issued.token,
            expiresAt: issued.expiresAt,
            action: request.action,
            entryId: request.entryId,
            packageName: capability.packageName,
            affectedEntryIds,
            restartRequired,
        };
    }
    /** Execute a previewed intent: single-use token, evidence re-validated. */
    execute(request) {
        const binding = this.tokens.consume(request.token);
        if (binding === null) {
            throw lifecycleFailure('PROFILE_CHANGED', 'the preview token is unknown, consumed, or expired');
        }
        const bundle = this.evidence();
        if (bundle.persistence !== 'writable') {
            throw lifecycleFailure('READ_ONLY_REMOTE', 'this deployment serves read-only clients');
        }
        if (bundle.revision !== binding.revision) {
            throw lifecycleFailure('PROFILE_CHANGED', 'the profile changed since the preview; re-preview');
        }
        const capability = bundle.capabilities.find(entry => entry.entryId === binding.entryId);
        if (capability === undefined) {
            throw lifecycleFailure('ENTRY_NOT_FOUND', 'the entry left the Loader tree since the preview');
        }
        const operationId = this.operations.create(binding.action);
        // The task starts only when it reaches the front of the per-profile
        // queue; a Promise here would already be running (JS promises are
        // eager), so pass a thunk and re-derive evidence inside it.
        void this.enqueue(bundle.profileDir, () => {
            // Re-validate at execution time: a queued operation must not act on
            // the snapshot taken when execute() was called. Every bound evidence
            // field is recomputed and compared; any drift fails with zero writes.
            this.operations.update(operationId, { state: 'running' });
            const queued = this.evidence();
            const fail = (errorCode) => {
                this.operations.update(operationId, { state: 'failed', errorCode });
                return Promise.resolve();
            };
            if (queued.persistence !== 'writable')
                return fail('READ_ONLY_REMOTE');
            if (queued.revision !== binding.revision)
                return fail('PROFILE_CHANGED');
            const queuedCapability = queued.capabilities.find(entry => entry.entryId === binding.entryId);
            /* v8 ignore next -- capabilities and entries derive from one evidence pass; a missing row also flips the revision, which the check above already refused. */
            if (queuedCapability === undefined)
                return fail('ENTRY_NOT_FOUND');
            if (binding.action === 'uninstall' && !queuedCapability.canUninstall) {
                /* v8 ignore next -- the capability layer always pairs denials with a reason. */
                return fail(blockReasonToCode(queuedCapability.uninstallBlockReason ?? 'not-direct-dependency'));
            }
            /* v8 ignore next -- a toggle denial here requires a capability flip WITHOUT a revision flip; every capability input feeds the revision digest, so the PROFILE_CHANGED check above fires first. */
            if (binding.action !== 'uninstall' && !queuedCapability.canToggle) {
                /* v8 ignore next -- the capability layer always pairs denials with a reason. */
                return fail(blockReasonToCode(queuedCapability.toggleBlockReason ?? 'not-direct-dependency'));
            }
            // Full binding re-derivation: packageName, patch data id, and the
            // same-package affected sets must be byte-identical, because the
            // revision digest does not cover node_modules resolution drift.
            const queuedEntry = queued.entries.find(entry => entry.entryId === binding.entryId);
            /* v8 ignore next -- same evidence pass as the capability lookup above; a vanished entry also flips the revision, which the check above already refused. */
            if (queuedEntry === undefined)
                return fail('ENTRY_NOT_FOUND');
            // packageName comes from node_modules resolution, which the revision
            // digest does NOT cover — a removed link must fail here without any write.
            if ((queuedEntry.packageName ?? null) !== binding.packageName)
                return fail('PROFILE_CHANGED');
            /* v8 ignore next -- patchTargetId is digested per-entry by computeRevision; drift flips the revision first. */
            if (queuedEntry.patchTargetId !== binding.patchTargetId)
                return fail('PROFILE_CHANGED');
            const queuedAffected = binding.action === 'uninstall'
                ? queued.entries
                    .filter(entry => entry.packageName !== null && entry.packageName === binding.packageName)
                : [queuedEntry];
            const queuedEntryIds = queuedAffected.map(entry => entry.entryId).sort();
            const queuedDataIds = queuedAffected
                .map(entry => entry.patchTargetId)
                .sort();
            const boundEntryIds = [...binding.affectedEntryIds].sort();
            const boundDataIds = [...binding.affectedDataIds].sort();
            /* v8 ignore next -- membership derives from entryId (digested) and packageName; any drift fails the packageName check or the revision check above first. */
            if (queuedEntryIds.join('\0') !== boundEntryIds.join('\0'))
                return fail('PROFILE_CHANGED');
            /* v8 ignore next -- same reasoning: the data-id set derives from the digested patchTargetId plus packageName membership. */
            if (queuedDataIds.join('\0') !== boundDataIds.join('\0'))
                return fail('PROFILE_CHANGED');
            const task = binding.action === 'uninstall'
                ? this.runUninstall(operationId, binding, queued)
                : this.runToggle(operationId, binding, queued);
            return task;
        });
        return { operationId, state: 'queued' };
    }
    /** Poll one operation's state. */
    operation(request) {
        const view = this.operations.get(request.operationId);
        if (view === null)
            throw lifecycleFailure('INTERNAL', 'unknown operation id');
        return view;
    }
    /**
     * Serialize mutations per profile directory, regardless of outcome. The
     * thunk only starts when the previous queued operation settled, so no two
     * mutations on one profile can overlap; the queue entry is removed when it
     * is again the tail.
     */
    async enqueue(key, task) {
        const previous = this.mutexes.get(key) ?? Promise.resolve();
        const current = previous.then(task);
        /* v8 ignore next -- the outcome-swallowing thunk runs with every settled enqueue; v8 instrumentation misattributes the inline arrow. */
        const settled = current.then(() => undefined, () => undefined);
        this.mutexes.set(key, settled);
        try {
            await current;
        }
        finally {
            if (this.mutexes.get(key) === settled) {
                this.mutexes.delete(key);
            }
        }
    }
    /** Effective Loader facts for every non-group entry. */
    entryFacts() {
        const facts = [];
        for (const entry of this.host.entries()) {
            const options = entry.options;
            // Group rows and include/tree-carrier rows are composition containers,
            // not toggleable plugins. `subtree`/`subgroup` are Entry-level fields.
            const isCarrier = (options.group !== undefined && options.group !== null && options.group !== false)
                || entry.subtree !== undefined
                || entry.subgroup !== undefined;
            if (isCarrier)
                continue;
            facts.push({
                entryId: entry.id,
                moduleName: options.name,
                disabled: entry.disabled,
                ownDisabled: Boolean(options.disabled),
                patchTargetId: patchTargetIdOf(entry.id, options.id),
            });
        }
        return facts;
    }
    /** Assemble the current evidence bundle; the revision over all of it. */
    evidence() {
        const profileDir = profileDirOf(this.loaderBaseUrl);
        const persistence = this.host.persistence();
        if (profileDir === null) {
            const revision = computeRevision('(none)', { manifest: '-', lockfile: '-', patch: '-' }, this.entryFacts());
            return {
                profileDir: '',
                profileName: '',
                patchPath: '',
                manifestPath: '',
                lockfilePath: '',
                revision,
                persistence,
                entries: [],
                capabilities: [],
            };
        }
        const profileName = basename(profileDir);
        const patchPath = join(profileDir, 'cordis.patch.yml');
        const manifestPath = join(profileDir, 'package.json');
        const lockfilePath = join(profileDir, 'pnpm-lock.yaml');
        const patchText = readPatchText(patchPath);
        const manifest = readProfileManifestView(manifestPath);
        const facts = this.entryFacts();
        const session = createEvidenceSession(profileDir, manifest, patchText);
        const entries = facts.map(fact => buildEntryEvidence(fact, session));
        const revision = computeRevision(profileName, {
            manifest: fileDigest(manifestPath),
            lockfile: fileDigest(lockfilePath),
            patch: fileDigest(patchPath),
        }, facts);
        // Package-group fail-closed for uninstall: if any entry of a package
        // lives outside the root patch space, NO entry of that package offers
        // uninstall — the patch-disable step cannot be expressed for the group.
        const packageHasNonRootEntry = new Set();
        for (const entry of entries) {
            if (entry.packageName !== null && entry.patchTargetId === null) {
                packageHasNonRootEntry.add(entry.packageName);
            }
        }
        const capabilities = entries
            .map(entry => capabilityOf(entry, persistence))
            .map((row, index) => {
            const entry = entries[index];
            if (row.canUninstall && entry.packageName !== null && packageHasNonRootEntry.has(entry.packageName)) {
                return {
                    ...row,
                    canUninstall: false,
                    uninstallBlockReason: 'not-direct-dependency',
                };
            }
            return row;
        });
        return {
            profileDir,
            profileName,
            patchPath,
            manifestPath,
            lockfilePath,
            revision,
            persistence,
            entries,
            capabilities,
        };
    }
    /**
     * Run a disable/enable toggle: rewrite the managed block atomically under
     * the cross-process file lock, await the Loader's effective state, and on
     * failure restore the before image only while the file still matches this
     * operation's after-image.
     */
    async runToggle(operationId, binding, bundle) {
        const disable = binding.action === 'disable';
        // Managed rows are keyed by the PATCH-space data id — the id an
        // id-targeted patch matches inside the composed entry list. The token
        // binds it at preview; the capability layer already refused entries with
        // no addressable data id, so a null here is defensive only.
        const bindingDataId = binding.patchTargetId;
        /* v8 ignore next -- capabilityOf/preview refuse patchTargetId===null before a token can be issued. */
        if (bindingDataId === null) {
            this.operations.update(operationId, { state: 'failed', errorCode: 'UNSUPPORTED_PATCH_SHAPE' });
            return;
        }
        const state = { wrote: false, keepRow: false, beforeText: '', afterHash: '' };
        try {
            await withFileLock(bundle.patchPath, async () => {
                state.beforeText = readPatchText(bundle.patchPath);
                const current = readManagedToggleRows(state.beforeText);
                if (current !== null && !current.ok) {
                    throw lifecycleFailure('MANAGED_BLOCK_INVALID', current.message);
                }
                const rows = (current === null ? [] : current.rows)
                    .filter(row => row.entryId !== bindingDataId);
                rows.push({ entryId: bindingDataId, disabled: disable });
                const candidate = applyManagedToggleRows(state.beforeText, rows);
                if (!candidate.ok)
                    throw lifecycleFailure(candidate.code, candidate.message);
                await writeFileAtomic(bundle.patchPath, candidate.content, { mode: 0o600 });
                state.wrote = true;
                state.afterHash = fileDigest(bundle.patchPath);
            });
            await this.awaitEffectiveState(binding.entryId, disable)
                .catch((error) => {
                if (error.code === 'BLOCKED_BY_ANCESTOR') {
                    state.keepRow = true;
                }
                throw error;
            });
            this.operations.update(operationId, { state: 'succeeded', restartRequired: false });
        }
        catch (error) {
            const code = error.code ?? 'INTERNAL';
            const finalCode = state.wrote && !state.keepRow
                ? await this.restoreToggleImage(bundle.patchPath, state.beforeText, state.afterHash, code)
                : code;
            this.operations.update(operationId, { state: 'failed', errorCode: finalCode });
        }
    }
    /** Hash-guarded restore of a toggle's before image. */
    async restoreToggleImage(patchPath, beforeText, afterHash, code) {
        if (fileDigest(patchPath) !== afterHash)
            return code;
        try {
            await withFileLock(patchPath, async () => {
                await writeFileAtomic(patchPath, beforeText, { mode: 0o600 });
            });
            return code;
        }
        catch {
            return 'ROLLBACK_INCOMPLETE';
        }
    }
    /** Drive one uninstall transaction through the uninstall module. */
    async runUninstall(operationId, binding, bundle) {
        const packageName = binding.packageName;
        /* v8 ignore next -- canUninstall (checked at preview and dequeue) implies a non-null packageName. */
        if (packageName === null) {
            this.operations.update(operationId, { state: 'failed', errorCode: 'NOT_DIRECT_DEPENDENCY' });
            return;
        }
        const affected = bundle.entries.filter(entry => entry.packageName === packageName);
        // The patch step addresses rows by their data ids; every affected entry
        // must live in the root patch space or the disable cannot be expressed.
        const affectedDataIds = [];
        for (const entry of affected) {
            /* v8 ignore next -- canUninstall gates patchTargetId===null for every entry of the package. */
            if (entry.patchTargetId === null) {
                this.operations.update(operationId, { state: 'failed', errorCode: 'UNSUPPORTED_PATCH_SHAPE' });
                return;
            }
            affectedDataIds.push(entry.patchTargetId);
        }
        const backupsRoot = join(dirname(dirname(bundle.profileDir)), 'dsh-plugin-manager-backups', bundle.profileName);
        const outcome = await runUninstallTransaction({
            operationId,
            packageName,
            profileDir: bundle.profileDir,
            profileName: bundle.profileName,
            patchPath: bundle.patchPath,
            manifestPath: bundle.manifestPath,
            lockfilePath: bundle.lockfilePath,
            workspacePolicyPath: existsSync(join(bundle.profileDir, 'pnpm-workspace.yaml'))
                ? join(bundle.profileDir, 'pnpm-workspace.yaml')
                : null,
            backupsRoot,
            pendingPath: join(bundle.profileDir, 'dsh-plugin-manager-pending-removals.json'),
            affectedEntryIds: affected.map(entry => entry.entryId),
            affectedDataIds,
            moduleNames: affected.map(entry => entry.moduleName),
            io: this.fileIo(),
            runner: this.createPackageRunner(),
            waitForDispose: async (ids) => { await this.awaitDisposal(ids); },
            // Spliced and remaining ids arrive in patch-space; probe the Loader in
            // tree-id space and report surviving tree ids for the pending record.
            probeEntryIds: ids => this.presentEntryIds(ids.map(treeIdOfPatchTarget)),
            withPatchLock: operation => withFileLock(bundle.patchPath, operation, { waitMs: 30_000 }),
        });
        if (outcome.ok) {
            this.operations.update(operationId, { state: 'succeeded', restartRequired: true });
        }
        else {
            this.operations.update(operationId, { state: 'failed', errorCode: outcome.code });
        }
    }
    /** The real filesystem boundary for uninstall transactions. */
    fileIo() {
        return {
            readText: readPatchText,
            exists: existsSync,
            writeAtomic: async (path, content) => {
                await writeFileAtomic(path, content, { mode: 0o600, dirMode: 0o700 });
            },
            removeFile: async (path) => {
                const { rm } = await import('node:fs/promises');
                await rm(path, { force: true });
            },
            mkdir: async (path) => {
                const { mkdir } = await import('node:fs/promises');
                await mkdir(path, { recursive: true, mode: 0o700 });
            },
            digest: fileDigest,
        };
    }
    /** Wait until each id is disposed or gone; spliced ids may vanish entirely. */
    async awaitDisposal(entryIds) {
        const deadline = Date.now() + LOADER_APPLY_TIMEOUT_MS;
        const remaining = new Set(entryIds);
        while (remaining.size > 0) {
            for (const id of Array.from(remaining)) {
                const entry = [...this.host.entries()].find(candidate => candidate.id === id);
                if (entry === undefined || entry.disabled)
                    remaining.delete(id);
            }
            if (remaining.size === 0)
                return;
            if (Date.now() >= deadline) {
                throw lifecycleFailure('TIMEOUT', 'the Loader did not dispose the entries in time');
            }
            await new Promise(resolve => setTimeout(resolve, LOADER_APPLY_POLL_MS));
        }
    }
    /** Which of the given ids are still present in the Loader tree. */
    presentEntryIds(entryIds) {
        const ids = new Set([...this.host.entries()].map(entry => entry.id));
        return entryIds.filter(id => ids.has(id));
    }
    /** Wait until the Loader's effective disabled state matches the target. */
    async awaitEffectiveState(entryId, disabled) {
        const deadline = Date.now() + LOADER_APPLY_TIMEOUT_MS;
        for (;;) {
            const entry = [...this.host.entries()].find(candidate => candidate.id === entryId);
            if (entry === undefined) {
                throw lifecycleFailure('ENTRY_CHANGED', 'the entry left the Loader tree mid-operation');
            }
            if (entry.disabled === disabled)
                return;
            if (Date.now() >= deadline) {
                const options = entry.options;
                if (!disabled && !options.disabled && entry.disabled) {
                    throw lifecycleFailure('BLOCKED_BY_ANCESTOR', 'an ancestor group still disables this entry');
                }
                throw lifecycleFailure('TIMEOUT', 'the Loader did not reflect the toggle in time');
            }
            await new Promise(resolve => setTimeout(resolve, LOADER_APPLY_POLL_MS));
        }
    }
}
/** Read the patch file; a missing file reads as empty text. */
function readPatchText(patchPath) {
    try {
        return readFileSync(patchPath, 'utf8');
    }
    catch {
        return '';
    }
}
//# sourceMappingURL=engine.js.map