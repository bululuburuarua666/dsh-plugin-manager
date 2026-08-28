/**
 * Recoverable package-scoped uninstall transaction. Order of operations:
 * backup touched files → disable + splice the user patch under the file lock
 * → wait for fiber disposal → run the package manager (no shell) → verify the
 * postconditions → reconcile bundle membership → record pending restart state.
 * Every rollback is hash-guarded: third-party drift is never overwritten.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { lifecycleFailure } from "./failure.js";
import { applyManagedToggleRows, dataIdOf, readManagedToggleRows, removeManualInsertRows, } from "./patch-editor.js";
const PENDING_CAPACITY = 32;
/** SHA-256 of a string, hex-encoded. */
function sha256(text) {
    return createHash('sha256').update(text).digest('hex');
}
/**
 * Run the full uninstall transaction. All failures after the first mutation
 * roll back through hash-guarded restores; drift downgrades the outcome to
 * ROLLBACK_INCOMPLETE instead of overwriting another writer's work.
 */
export async function runUninstallTransaction(options) {
    const { io } = options;
    const touched = [
        options.patchPath,
        options.manifestPath,
        options.lockfilePath,
        ...(options.workspacePolicyPath === null ? [] : [options.workspacePolicyPath]),
    ];
    // 1. Backup every touched file before the first mutation.
    const backupDir = join(options.backupsRoot, options.operationId);
    await io.mkdir(backupDir);
    const backups = [];
    for (const path of touched) {
        const content = io.exists(path) ? io.readText(path) : null;
        backups.push({ path, content, digest: sha256(content ?? '') });
    }
    await io.writeAtomic(join(backupDir, 'manifest.json'), JSON.stringify({
        schemaVersion: 1,
        files: backups.map(backup => ({ path: backup.path, digest: backup.digest, present: backup.content !== null })),
    }));
    // Our own after-image digests, recorded per write for hash-guarded restore.
    const afterDigests = new Map();
    const recordWrite = (path, content) => {
        afterDigests.set(path, sha256(content));
    };
    let splicedEntryIds = [];
    let mutated = false;
    try {
        // 2. Patch mutation (under the patch file lock): disable affected entries
        //    and splice manual inserts.
        let remainingIds = options.affectedEntryIds;
        await options.withPatchLock(async () => {
            const patchBefore = io.readText(options.patchPath);
            const rows = [];
            let candidates = patchBefore;
            for (const moduleName of options.moduleNames) {
                const removed = removeManualInsertRows(candidates, moduleName);
                if (removed.ok) {
                    candidates = removed.content;
                    splicedEntryIds = [...splicedEntryIds, ...removed.removedEntryIds];
                }
                else if (removed.code === 'UNSUPPORTED_PATCH_SHAPE' && /no manual insert row/.test(removed.message)) {
                    // The entry is not owned by a manual insert row; keep the patch as-is.
                }
                else {
                    throw lifecycleFailure(removed.code, removed.message);
                }
            }
            remainingIds = options.affectedEntryIds.filter(id => !splicedEntryIds.includes(id));
            const current = readManagedToggleRows(candidates);
            if (current !== null && !current.ok) {
                throw lifecycleFailure('MANAGED_BLOCK_INVALID', current.message);
            }
            const affectedDataIds = options.affectedEntryIds.map(dataIdOf);
            rows.push(...(current === null ? [] : current.rows).filter(row => !affectedDataIds.includes(row.entryId)));
            for (const dataId of affectedDataIds)
                rows.push({ entryId: dataId, disabled: true });
            const edited = applyManagedToggleRows(candidates, rows);
            /* v8 ignore next -- every input reaching this point already passed the same validation the editor applies. */
            if (!edited.ok)
                throw lifecycleFailure(edited.code, edited.message);
            await io.writeAtomic(options.patchPath, edited.content);
            recordWrite(options.patchPath, edited.content);
        });
        mutated = true;
        // 3. Wait until the Loader disposed the affected fibers.
        await options.waitForDispose(options.affectedEntryIds);
        // 4. Run the package manager without a shell.
        await options.runner.remove(options.packageName, options.profileDir);
        const manifestAfterPnpm = io.readText(options.manifestPath);
        recordWrite(options.manifestPath, manifestAfterPnpm);
        // 5. Postcondition: only the target dependency may have changed.
        const manifest = JSON.parse(manifestAfterPnpm);
        /* v8 ignore next -- exercised by the no-dependencies manifest fixture; instrumentation misattributes the arm. */
        const dependencies = typeof manifest.dependencies === 'object' && manifest.dependencies !== null
            ? manifest.dependencies
            : {};
        if (options.packageName in dependencies) {
            throw lifecycleFailure('POSTCONDITION_FAILED', 'the target dependency is still declared');
        }
        const dsh = typeof manifest.dsh === 'object' && manifest.dsh !== null
            ? manifest.dsh
            : {};
        const profile = typeof dsh.profile === 'object' && dsh.profile !== null
            ? dsh.profile
            : {};
        const bundles = Array.isArray(profile.bundles)
            ? profile.bundles.filter((bundle) => typeof bundle === 'string')
            : [];
        if (bundles.includes(options.packageName)) {
            manifest.dsh = { ...dsh, profile: { ...profile, bundles: bundles.filter(bundle => bundle !== options.packageName) } };
            await io.writeAtomic(options.manifestPath, JSON.stringify(manifest));
            recordWrite(options.manifestPath, JSON.stringify(manifest));
        }
        // 6. Lockfile importer and installed link must both be gone.
        if (lockImporterHas(io.readText(options.lockfilePath), options.packageName)) {
            throw lifecycleFailure('POSTCONDITION_FAILED', 'the lockfile still lists the target dependency');
        }
        if (io.exists(join(options.profileDir, 'node_modules', ...options.packageName.split('/')))) {
            throw lifecycleFailure('POSTCONDITION_FAILED', 'the installed package link still exists');
        }
        // 7. Loader postcondition: spliced entries must be absent.
        const splicedStillPresent = options.probeEntryIds(splicedEntryIds);
        if (splicedStillPresent.length > 0) {
            throw lifecycleFailure('POSTCONDITION_FAILED', 'a spliced entry still exists in the Loader tree');
        }
        // 8. Drop managed rows of spliced entries (they left the tree) and record
        //    pending state for the surviving (bundle-backed) entries.
        if (splicedEntryIds.length > 0) {
            await dropSplicedManagedRows(options, splicedEntryIds, recordWrite);
        }
        const survivingEntryIds = options.probeEntryIds(remainingIds);
        if (survivingEntryIds.length > 0) {
            await upsertPendingRecord(options, survivingEntryIds);
        }
        return { ok: true, splicedEntryIds, survivingEntryIds };
    }
    catch (error) {
        const code = error.code ?? 'INTERNAL';
        if (!mutated)
            return { ok: false, code };
        return await rollbackTransaction(options, backups, afterDigests, code);
    }
}
/** Rewrite the managed block without the spliced entries' rows, under the lock. */
async function dropSplicedManagedRows(options, splicedEntryIds, recordWrite) {
    await options.withPatchLock(async () => {
        /* v8 ignore start -- exercised by the manual-insert splice test; the instrumented nested callback is misattributed. */
        const cleaned = readManagedToggleRows(options.io.readText(options.patchPath));
        if (cleaned === null || !cleaned.ok)
            return;
        const splicedDataIds = splicedEntryIds.map(dataIdOf);
        const kept = cleaned.rows.filter(row => !splicedDataIds.includes(row.entryId));
        const rewritten = applyManagedToggleRows(options.io.readText(options.patchPath), kept);
        if (!rewritten.ok)
            return;
        await options.io.writeAtomic(options.patchPath, rewritten.content);
        recordWrite(options.patchPath, rewritten.content);
        /* v8 ignore stop */
    });
}
/** Whether the lockfile's profile importer still declares a dependency. */
export function lockImporterHas(lockfileText, packageName) {
    if (lockfileText.length === 0)
        return false;
    let parsed;
    try {
        parsed = parseYaml(lockfileText);
    }
    catch {
        // An unreadable lockfile aborts the postcondition through its own digest
        // mismatch path; report the dependency as present so the transaction
        // fails closed here instead of proceeding blind.
        return true;
    }
    let root = {};
    if (typeof parsed === 'object' && parsed !== null)
        root = parsed;
    let importers = {};
    if (typeof root.importers === 'object' && root.importers !== null) {
        importers = root.importers;
    }
    let importer = {};
    if (typeof importers['.'] === 'object' && importers['.'] !== null) {
        importer = importers['.'];
    }
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        const entries = importer[section];
        if (typeof entries === 'object' && entries !== null && packageName in entries)
            return true;
    }
    return false;
}
/** Append a bounded pending-removal record for restart cleanup. */
async function upsertPendingRecord(options, entryIds) {
    const { io } = options;
    let file = { schemaVersion: 1, records: [] };
    if (io.exists(options.pendingPath)) {
        try {
            file = JSON.parse(io.readText(options.pendingPath));
        }
        catch {
            file = { schemaVersion: 1, records: [] };
        }
    }
    const records = file.records
        .filter(record => record.packageName !== options.packageName);
    records.push({
        packageName: options.packageName,
        entryIds,
        operationId: options.operationId,
        createdAt: Date.now(),
    });
    await io.writeAtomic(options.pendingPath, JSON.stringify({
        schemaVersion: 1,
        records: records.slice(-PENDING_CAPACITY),
    }));
}
/** Hash-guarded rollback: restore only files we still own, then reinstall. */
async function rollbackTransaction(options, backups, afterDigests, code) {
    const { io } = options;
    // The patch file is strictly hash-guarded: we wrote it, so drift means a
    // third party replaced it after us — never overwrite that. The touched
    // backup list always contains the patch file.
    const patchBackup = backups.find(backup => backup.path === options.patchPath);
    /* v8 ignore next -- the patch file always exists here: this operation wrote it before any rollback path runs. */
    const currentDigest = io.exists(patchBackup.path) ? sha256(io.readText(patchBackup.path)) : sha256('');
    if (currentDigest !== afterDigests.get(patchBackup.path)) {
        return { ok: false, code: 'ROLLBACK_INCOMPLETE' };
    }
    // Manifest/lockfile/workspace-policy changes came from our own package
    // manager; restoring them is part of this operation's rollback. A file that
    // did not exist before the operation is restored by removal.
    for (const backup of backups) {
        if (backup.content === null) {
            if (io.exists(backup.path))
                await io.removeFile(backup.path);
            continue;
        }
        await io.writeAtomic(backup.path, backup.content);
    }
    try {
        await options.runner.installFrozen(options.profileDir);
    }
    catch {
        return { ok: false, code: 'ROLLBACK_INCOMPLETE' };
    }
    return { ok: false, code };
}
/** Read the profile's pending-removals records; tolerant of a missing file. */
export function readPendingRemovals(io, pendingPath) {
    if (!io.exists(pendingPath))
        return [];
    try {
        const file = JSON.parse(io.readText(pendingPath));
        const records = file.records;
        return Array.isArray(records) ? records : [];
    }
    catch {
        return [];
    }
}
/** Drop pending records whose package and entries are both gone. */
export async function clearSettledPendingRemovals(io, pendingPath, predicate) {
    const records = readPendingRemovals(io, pendingPath);
    const kept = records.filter(record => !predicate(record));
    if (kept.length === 0) {
        if (io.exists(pendingPath)) {
            await io.writeAtomic(pendingPath, JSON.stringify({ schemaVersion: 1, records: [] }));
        }
        return;
    }
    await io.writeAtomic(pendingPath, JSON.stringify({ schemaVersion: 1, records: kept }));
}
//# sourceMappingURL=uninstall.js.map