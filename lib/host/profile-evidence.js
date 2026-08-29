/**
 * Profile evidence assembly and capability decisions. Everything here is
 * computed fresh per call from the Loader and the profile's files — this
 * service deliberately owns no long-lived lifecycle state.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { entryListSchema } from "./entry-schema.js";
/** Packages that may never be uninstalled through this surface. */
export const PROTECTED_PACKAGES = [
    // The manager itself: removing it mid-operation would strand transactions.
    '@bululuburuarua666/dsh-plugin-manager',
    // Upstream engine-critical packages shared with the official surface.
    '@deepseek-ai/dsh-host-plugin-lifecycle',
    '@deepseek-ai/dsh-host-plugin-inventory',
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-app-boot',
    '@deepseek-ai/dsh-web-app',
    '@deepseek-ai/dsh-base',
];
/**
 * Root-space row ids whose toggling would break the machinery this surface
 * depends on: the HMR fallback the upstream launcher mounts after boot, its
 * timer dependency, and the manager's own row.
 */
export const PROTECTED_TOGGLE_ENTRY_IDS = [
    'timer',
    'hmr',
    'dsh-plugin-manager',
];
/** Read the profile package.json's dependency keys and bundle list. */
export function readProfileManifestView(manifestPath) {
    try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        const dependencies = typeof manifest.dependencies === 'object' && manifest.dependencies !== null
            ? new Set(Object.keys(manifest.dependencies))
            : new Set();
        const dsh = typeof manifest.dsh === 'object' && manifest.dsh !== null
            ? manifest.dsh
            : {};
        const profile = typeof dsh.profile === 'object' && dsh.profile !== null
            ? dsh.profile
            : {};
        const bundles = Array.isArray(profile.bundles)
            ? profile.bundles.filter((bundle) => typeof bundle === 'string')
            : [];
        return { dependencies, bundles };
    }
    catch {
        return { dependencies: new Set(), bundles: [] };
    }
}
/** Package-name portion of a Loader module specifier. */
export function packageKeyOf(moduleName) {
    const segments = moduleName.split('/');
    if (moduleName.startsWith('@'))
        return segments.slice(0, 2).join('/');
    /* v8 ignore next -- split('/') always yields a first segment, so the fallback is unreachable. */
    return segments[0] ?? moduleName;
}
/** Resolve a package's directory from the profile anchor; null when absent. */
export function resolvePackageDir(profileDir, packageName) {
    const requireFromProfile = createRequire(join(profileDir, 'noop.js'));
    try {
        return dirname(requireFromProfile.resolve(`${packageName}/package.json`));
    }
    catch {
        // Fall through to entry-point resolution below.
    }
    try {
        let current = dirname(requireFromProfile.resolve(packageName));
        while (true) {
            if (existsSync(join(current, 'package.json')))
                return current;
            const parent = dirname(current);
            if (parent === current)
                return null;
            current = parent;
        }
    }
    catch {
        return null;
    }
}
/** Best-effort realpath; null when the path cannot resolve. */
export function realpathOrNull(path) {
    try {
        return realpathSync(path);
    }
    catch {
        return null;
    }
}
/** Separator-insensitive containment check (case-insensitive on Windows). */
export function isPathInside(candidate, root) {
    const normalize = (value) => {
        let result = value.replaceAll('\\', '/');
        while (result.endsWith('/'))
            result = result.slice(0, -1);
        /* v8 ignore next -- the case-insensitive compare executes only on Windows coverage hosts. */
        return process.platform === 'win32' ? result.toLowerCase() : result;
    };
    const child = normalize(candidate);
    const parent = normalize(root);
    return child === parent || child.startsWith(`${parent}/`);
}
/** Module names owned by manual insert rows inside the user patch text. */
export function manualInsertNames(patchText) {
    const names = new Set();
    let parsed;
    try {
        parsed = parseYaml(patchText, { schema: entryListSchema });
    }
    catch {
        return names;
    }
    if (!Array.isArray(parsed))
        return names;
    for (const patch of parsed) {
        if (typeof patch !== 'object' || patch === null)
            continue;
        const insert = patch.insert;
        if (!Array.isArray(insert))
            continue;
        for (const entry of insert) {
            if (typeof entry !== 'object' || entry === null)
                continue;
            const name = entry.name;
            if (typeof name === 'string')
                names.add(name);
        }
    }
    return names;
}
/** Whether a node_modules entry counts as a package directory or link. */
function isPackageDirEntry(entry) {
    return entry.isDirectory() || entry.isSymbolicLink();
}
/**
 * Shallow-scan one node_modules root into the index: top-level packages plus
 * one scope layer. Dot-entries (`.pnpm` and friends) are never entered, so
 * the pnpm virtual store is never traversed. The first root to claim a name
 * wins; later roots never overwrite.
 */
function scanRootInto(root, rootTag, index) {
    let entries;
    try {
        entries = readdirSync(root, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const first of entries) {
        if (first.name.startsWith('.'))
            continue;
        if (!isPackageDirEntry(first))
            continue;
        if (first.name.startsWith('@')) {
            let scoped;
            try {
                scoped = readdirSync(join(root, first.name), { withFileTypes: true });
            }
            catch {
                continue;
            }
            for (const second of scoped) {
                if (second.name.startsWith('.'))
                    continue;
                if (!isPackageDirEntry(second))
                    continue;
                const name = `${first.name}/${second.name}`;
                if (!index.has(name))
                    index.set(name, { dir: join(root, first.name, second.name), root: rootTag });
            }
        }
        else if (!index.has(first.name)) {
            index.set(first.name, { dir: join(root, first.name), root: rootTag });
        }
    }
}
/**
 * Build the per-call shallow package index. Root order mirrors the inventory
 * card reader: the profile's own node_modules first, then the engine-level
 * parent directory's node_modules.
 */
function buildPackageIndex(profileDir) {
    const index = new Map();
    scanRootInto(join(profileDir, 'node_modules'), 'profile', index);
    scanRootInto(join(dirname(profileDir), 'node_modules'), 'engine', index);
    return index;
}
/** Create the per-call session: patch parse, shallow index, and caches are shared. */
export function createEvidenceSession(profileDir, manifest, patchText) {
    return {
        profileDir,
        manifest,
        patchText,
        manualInsertNames: manualInsertNames(patchText),
        packageIndex: buildPackageIndex(profileDir),
        packageDirCache: new Map(),
        realpathCache: new Map(),
        manifestNameCache: new Map(),
    };
}
/**
 * Bounded fallback resolver: only invoked for direct dependencies missing
 * from the shallow index, so a profile with a handful of direct dependencies
 * pays at most a handful of Node resolutions per call.
 */
function cachedResolvePackageDir(session, packageName) {
    const cached = session.packageDirCache.get(packageName);
    if (cached !== undefined)
        return cached;
    const resolved = resolvePackageDir(session.profileDir, packageName);
    session.packageDirCache.set(packageName, resolved);
    return resolved;
}
/**
 * Read a located package's manifest name. Uninstall authorization depends on
 * an exact name match: a directory that happens to sit at a package's path but
 * declares a different name must fail closed.
 */
function manifestNameOf(session, packageDir) {
    const cached = session.manifestNameCache.get(packageDir);
    if (cached !== undefined)
        return cached;
    let name = null;
    try {
        const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
        name = typeof manifest.name === 'string' ? manifest.name : null;
    }
    catch {
        name = null;
    }
    session.manifestNameCache.set(packageDir, name);
    return name;
}
/** Assemble one entry's evidence from profile files and resolution facts. */
export function buildEntryEvidence(facts, context) {
    const packageName = facts.moduleName.startsWith('cordis:') ? null : packageKeyOf(facts.moduleName);
    const isDirectDependency = packageName !== null && context.manifest.dependencies.has(packageName);
    const isBundleMember = packageName !== null && context.manifest.bundles.includes(packageName);
    // The shallow index answers every ordinary entry. Only a direct dependency
    // missing from the index may pay the bounded Node-resolution fallback;
    // non-direct entries never resolve through Node here.
    const indexed = packageName === null ? undefined : context.packageIndex.get(packageName);
    // Resolution root: 'profile' (the profile's own node_modules — an ordinary
    // installed plugin), 'engine' (the shared parent-level node_modules), or
    // 'unknown' (unindexed, resolved only through the Node fallback). The
    // fallback exists so evidence stays complete; it NEVER authorizes an
    // uninstall — an unknown root fails closed in capabilityOf.
    const resolutionRoot = indexed === undefined ? 'unknown' : indexed.root;
    let packageDir = indexed?.dir ?? null;
    let rootIsTrusted = indexed !== undefined;
    if (packageDir === null && packageName !== null && isDirectDependency) {
        packageDir = cachedResolvePackageDir(context, packageName);
        rootIsTrusted = false;
    }
    // A located directory that declares a different package name fails closed:
    // uninstall authorization requires an exact manifest-name match.
    if (packageDir !== null && packageName !== null && manifestNameOf(context, packageDir) !== packageName) {
        packageDir = null;
        rootIsTrusted = false;
    }
    const isTemplateBundle = isBundleMember && !isDirectDependency;
    // Engine ownership comes from WHERE the package resolved: only an indexed
    // hit in the shared engine-level node_modules counts.
    const insideEngineTree = rootIsTrusted && resolutionRoot === 'engine' && packageDir !== null;
    // Unknown-root resolutions are ambiguous for authorization: the capability
    // layer treats them as never uninstallable.
    const isResolvable = packageDir !== null && rootIsTrusted;
    const isProtected = packageName !== null && PROTECTED_PACKAGES.includes(packageName);
    const isManualInsert = context.manualInsertNames.has(facts.moduleName);
    return {
        entryId: facts.entryId,
        moduleName: facts.moduleName,
        disabled: facts.disabled,
        ownDisabled: facts.ownDisabled,
        patchTargetId: facts.patchTargetId,
        packageName: packageDir === null ? null : packageName,
        isDirectDependency,
        isBundleMember,
        isTemplateBundle,
        insideEngineTree,
        isResolvable,
        isProtected,
        isManualInsert,
    };
}
/**
 * Compute one entry's capability row. Toggle requires the entry to be
 * addressable by an id-targeted patch in the profile's user patch layer (a
 * root-space data id) and not be lifecycle-critical infrastructure; uninstall
 * additionally requires an exact direct-dependency mapping outside every
 * protected class. A row outside the root patch space cannot be reached by
 * any patch, so neither action is offered for it.
 */
export function capabilityOf(evidence, persistence) {
    let toggleBlockReason = null;
    if (persistence !== 'writable')
        toggleBlockReason = 'read-only-remote';
    // A row outside the root patch space cannot be addressed by an
    // id-targeted patch at all; report it like a non-dependency of the profile.
    else if (evidence.patchTargetId === null)
        toggleBlockReason = 'not-direct-dependency';
    // Explicit infrastructure ids AND protected infrastructure packages
    // (webserver, app-boot, base, the manager itself) are not hot-toggleable.
    else if (PROTECTED_TOGGLE_ENTRY_IDS.includes(evidence.patchTargetId) || evidence.isProtected) {
        toggleBlockReason = 'protected-plugin';
    }
    let uninstallBlockReason = null;
    if (persistence !== 'writable')
        uninstallBlockReason = 'read-only-remote';
    else if (evidence.patchTargetId === null)
        uninstallBlockReason = 'not-direct-dependency';
    else if (evidence.packageName === null)
        uninstallBlockReason = 'not-direct-dependency';
    else if (evidence.isProtected)
        uninstallBlockReason = 'protected-plugin';
    else if (evidence.insideEngineTree)
        uninstallBlockReason = 'engine-owned';
    else if (evidence.isTemplateBundle)
        uninstallBlockReason = 'template-bundle';
    // Unknown-resolution-root or name-mismatched packages are ambiguous for
    // authorization: never uninstallable even when a fallback resolve found
    // their directory (fail closed).
    else if (!evidence.isResolvable)
        uninstallBlockReason = 'ambiguous-package';
    else if (!evidence.isDirectDependency)
        uninstallBlockReason = 'not-direct-dependency';
    return {
        entryId: evidence.entryId,
        packageName: evidence.packageName,
        canToggle: toggleBlockReason === null,
        canUninstall: uninstallBlockReason === null,
        toggleBlockReason,
        uninstallBlockReason,
    };
}
/** Hash a file's content for revision purposes; missing files hash as '-'. */
export function fileDigest(path) {
    try {
        return createHash('sha256').update(readFileSync(path)).digest('hex');
    }
    catch {
        return '-';
    }
}
/**
 * Compute the evidence revision: a digest over the profile identity, the
 * manifest/lockfile/patch digests, and the entry facts, canonicalized so any
 * drift flips the revision.
 */
export function computeRevision(profileName, digests, entries) {
    const hash = createHash('sha256');
    hash.update(profileName);
    hash.update('\0');
    hash.update(digests.manifest);
    hash.update(digests.lockfile);
    hash.update(digests.patch);
    for (const entry of [...entries].sort((left, right) => left.entryId.localeCompare(right.entryId))) {
        hash.update(`\0${entry.entryId}=${entry.moduleName}:${entry.disabled ? '1' : '0'}:${entry.patchTargetId ?? '-'}`);
    }
    return hash.digest('hex');
}
//# sourceMappingURL=profile-evidence.js.map