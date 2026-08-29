/**
 * Inventory assembly: read the Loader roster once per request and decorate
 * each entry with card metadata and origin classification. This module is a
 * pure engine over injected inputs (roster rows + profile directory) — the
 * Cordis wiring lives in the host entry and the RPC channel in T04.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginInventoryCardReader, packageKeyOf, } from "./card.js";
import { isPathInside, parseFileSpecifierTarget, parseOriginOverrides, resolveOrigin, normalizeOrigin, } from "./origin.js";
import { ProfileInstallSourceReader } from "./install-source.js";
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
    /** Evidence and manifest declaration for one module. */
    evidenceOf(moduleName, sources) {
        const meta = this.cards.readMeta(moduleName);
        const key = packageKeyOf(moduleName);
        const packageName = meta.packageName ?? key;
        const specifier = sources.specifiers.get(key) ?? null;
        const resolution = sources.resolutions.get(key) ?? null;
        const fileTarget = parseFileSpecifierTarget(resolution) ?? parseFileSpecifierTarget(specifier);
        const fileTargetInsideLocal = fileTarget !== null && this.fileTargetInsideLocal(fileTarget);
        const realDir = meta.realPackageDir;
        return {
            key,
            packageName,
            manifestOrigin: meta.manifestOrigin,
            evidence: {
                packageName,
                packageDir: meta.located?.packageDir ?? null,
                realPackageDir: realDir,
                resolutionRoot: meta.located?.resolutionRoot ?? 'unknown',
                insideEngineCheckout: meta.located?.resolutionRoot === 'engine',
                insideLocalPlugins: realDir !== null && this.localPluginsDir !== null
                    && isPathInside(realDir, this.localPluginsDir),
                profileSpecifier: specifier,
                lockfileResolution: resolution,
                fileTargetInsideLocal,
                repositoryUrl: meta.repositoryUrl,
            },
        };
    }
    /** The override entry applying to one package, keyed by real package name. */
    overrideFor(overrides, packageName, key) {
        return overrides?.packages.get(packageName)
            ?? (packageName === key ? undefined : overrides?.packages.get(key));
    }
    /**
     * Resolve one entry's origin pair through the override/manifest/heuristic
     * chain: the effective origin (override applied) and the detected origin
     * (override removed). Both derive from one evidence assembly.
     */
    originsOf(moduleName, overrides, sources, diagnostics) {
        try {
            if (moduleName.startsWith('cordis:')) {
                const origin = normalizeOrigin({ kind: 'official' }, 'heuristic');
                return { effective: origin, detected: origin };
            }
            const { key, packageName, evidence, manifestOrigin } = this.evidenceOf(moduleName, sources);
            const override = this.overrideFor(overrides, packageName, key);
            const effective = resolveOrigin(evidence, { override, manifest: manifestOrigin });
            diagnostics.push(...effective.diagnostics);
            // Without an override the effective origin IS the detected one; only
            // an override justifies a second pass through the chain.
            if (override === undefined)
                return { effective: effective.origin, detected: effective.origin };
            const detected = resolveOrigin(evidence, { manifest: manifestOrigin });
            return { effective: effective.origin, detected: detected.origin };
            /* v8 ignore start -- defensive: the resolver chain above is total over its inputs; this catch only guards unforeseen IO races. */
        }
        catch {
            return { effective: FALLBACK_ORIGIN, detected: FALLBACK_ORIGIN };
        }
        /* v8 ignore stop */
    }
    /**
     * Describe one module's origin layers for the origin editor. Returns null
     * for `cordis:` builtins and unresolvable modules — they have no stable
     * package name an override could key on.
     */
    describeOrigin(moduleName) {
        if (moduleName.startsWith('cordis:'))
            return null;
        const diagnostics = [];
        const sources = this.installSources.read();
        diagnostics.push(...sources.diagnostics);
        const overrides = this.readOverrides(diagnostics);
        try {
            const { key, packageName, evidence, manifestOrigin } = this.evidenceOf(moduleName, sources);
            const override = this.overrideFor(overrides, packageName, key) ?? null;
            const detected = resolveOrigin(evidence, { manifest: manifestOrigin });
            const effective = override === null
                ? detected
                : resolveOrigin(evidence, { override, manifest: manifestOrigin });
            diagnostics.push(...effective.diagnostics);
            return {
                packageName,
                detected: detected.origin,
                effective: effective.origin,
                override,
                diagnostics,
            };
            /* v8 ignore start -- same defensive stance as originsOf above. */
        }
        catch {
            return null;
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
            const origins = this.originsOf(row.moduleName, overrides, sources, diagnostics);
            entries.push({
                entryId: row.entryId,
                moduleName: row.moduleName,
                enabled: !row.disabled,
                origin: origins.effective,
                detectedOrigin: origins.detected,
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