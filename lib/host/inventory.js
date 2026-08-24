/**
 * Inventory assembly: read the Loader roster once per request and decorate
 * each entry with card metadata and origin classification. This module is a
 * pure engine over injected inputs (roster rows + profile directory) — the
 * Cordis wiring lives in the host entry and the RPC channel in T04.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { PluginInventoryCardReader, packageKeyOf, } from './card.ts';
import { isPathInside, parseFileSpecifierTarget, parseOriginOverrides, resolveOrigin, normalizeOrigin, } from './origin.ts';
import { ProfileInstallSourceReader } from './install-source.ts';
/** Profile directory, or null when the Loader has no base URL. */
export function profileDirOf(baseUrl) {
    if (baseUrl === undefined || baseUrl.length === 0)
        return null;
    try {
        return fileURLToPath(new URL('.', baseUrl));
    }
    catch {
        return null;
    }
}
/**
 * Locate this package's own install tree root: walk up from this module to
 * the package.json of @bululuburuarua666/dsh-plugin-manager, then two levels
 * above its real directory. Packages under this root ship with the engine.
 */
function engineTreeRootOf() {
    let dir = dirname(fileURLToPath(import.meta.url));
    while (true) {
        try {
            const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
            if (typeof manifest === 'object' && manifest !== null
                && manifest.name === '@bululuburuarua666/dsh-plugin-manager') {
                return dirname(dirname(realpathSync(dir)));
            }
        }
        catch {
            // Keep walking towards the filesystem root.
        }
        const parent = dirname(dir);
        if (parent === dir)
            return null;
        dir = parent;
    }
}
/** The fallback origin for entries whose resolution itself fails. */
const FALLBACK_ORIGIN = {
    kind: 'opensource',
    customized: false,
    upstream: null,
    fork: null,
    branch: null,
    note: null,
    declaredBy: 'heuristic',
};
/** Assemble the manager roster for one request. */
export class InventoryAssembler {
    cards;
    installSources;
    profileDir;
    localPluginsDir;
    engineTreeRoot = engineTreeRootOf();
    constructor(baseUrl) {
        this.cards = new PluginInventoryCardReader(baseUrl);
        this.profileDir = profileDirOf(baseUrl);
        this.installSources = new ProfileInstallSourceReader(this.profileDir);
        this.localPluginsDir = this.profileDir === null
            ? null
            : join(dirname(dirname(this.profileDir)), 'plugins', 'local');
    }
    /** Read the profile's origin override file; invalid files yield none. */
    readOverrides(diagnostics) {
        if (this.profileDir === null)
            return null;
        let text;
        try {
            text = readFileSync(join(this.profileDir, 'plugin-origins.json'), 'utf8');
        }
        catch {
            return null;
        }
        const result = parseOriginOverrides(text);
        diagnostics.push(...result.diagnostics);
        return result.overrides;
    }
    /** Whether a `file:`/`link:` target lives inside the local plugins dir. */
    fileTargetInsideLocal(target) {
        if (this.profileDir === null || this.localPluginsDir === null)
            return false;
        return isPathInside(isAbsolute(target) ? target : resolve(this.profileDir, target), this.localPluginsDir);
    }
    /** Resolve one entry's origin through the override/manifest/heuristic chain. */
    originOf(moduleName, overrides, sources, diagnostics) {
        try {
            if (moduleName.startsWith('cordis:')) {
                return normalizeOrigin({ kind: 'official' }, 'heuristic');
            }
            const meta = this.cards.readMeta(moduleName);
            const key = packageKeyOf(moduleName);
            const packageName = meta.packageName ?? key;
            const specifier = sources.specifiers.get(key) ?? null;
            const resolution = sources.resolutions.get(key) ?? null;
            const fileTarget = parseFileSpecifierTarget(resolution) ?? parseFileSpecifierTarget(specifier);
            const fileTargetInsideLocal = fileTarget !== null && this.fileTargetInsideLocal(fileTarget);
            const realDir = meta.realPackageDir;
            const evidence = {
                packageName,
                packageDir: meta.located?.packageDir ?? null,
                realPackageDir: realDir,
                resolutionRoot: meta.located?.resolutionRoot ?? 'unknown',
                insideEngineCheckout: realDir !== null && this.engineTreeRoot !== null
                    && isPathInside(realDir, this.engineTreeRoot),
                insideLocalPlugins: realDir !== null && this.localPluginsDir !== null
                    && isPathInside(realDir, this.localPluginsDir),
                profileSpecifier: specifier,
                lockfileResolution: resolution,
                fileTargetInsideLocal,
                repositoryUrl: meta.repositoryUrl,
            };
            const override = overrides?.packages.get(packageName)
                ?? (packageName === key ? undefined : overrides?.packages.get(key));
            const result = resolveOrigin(evidence, { override, manifest: meta.manifestOrigin });
            diagnostics.push(...result.diagnostics);
            return result.origin;
            /* v8 ignore start -- defensive: the resolver chain above is total over its inputs; this catch only guards unforeseen IO races. */
        }
        catch {
            return FALLBACK_ORIGIN;
        }
        /* v8 ignore stop */
    }
    /** Assemble the current roster with origins and cards. */
    list(roster) {
        const entries = [];
        const diagnostics = [];
        const sources = this.installSources.read();
        diagnostics.push(...sources.diagnostics);
        const overrides = this.readOverrides(diagnostics);
        for (const row of roster) {
            const meta = this.cards.readMeta(row.moduleName);
            entries.push({
                entryId: row.entryId,
                moduleName: row.moduleName,
                enabled: !row.disabled,
                origin: this.originOf(row.moduleName, overrides, sources, diagnostics),
                title: meta.card.title,
                description: meta.card.description,
                // T03 fills the real capability gates; the T02 surface exposes the
                // roster with origins so the UI can already render rows.
                canToggle: !row.disabled,
                canUninstall: false,
                toggleBlockReason: null,
                uninstallBlockReason: 'not-direct-dependency',
            });
        }
        return { entries, diagnostics };
    }
}
//# sourceMappingURL=inventory.js.map