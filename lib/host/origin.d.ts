/**
 * Pure plugin-origin resolution: declaration schemas, normalization, merge,
 * and the heuristic fallback chain. No file or module IO happens here — the
 * gateway assembles {@link PackageResolutionEvidence} and this module decides.
 */
import { z } from 'zod';
import type { PluginInventoryCardText, PluginInventoryOrigin, PluginOriginDiagnostic, PluginOriginKind } from './protocol.ts';
/** Zod schema of a plugin package.json `dsh.origin` declaration. */
export declare const manifestOriginSchema: z.ZodObject<{
    kind: z.ZodEnum<{
        official: "official";
        personal: "personal";
        opensource: "opensource";
    }>;
    customized: z.ZodOptional<z.ZodBoolean>;
    upstream: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    fork: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    branch: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    note: z.ZodOptional<z.ZodNullable<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        zh: z.ZodString;
        en: z.ZodString;
    }, z.core.$strip>]>>>;
}, z.core.$strip>;
/**
 * Zod schema of one `plugin-origins.json` package override. Optional fields
 * accept explicit `null`, which clears the inherited value during the merge.
 */
export declare const originOverrideEntrySchema: z.ZodObject<{
    kind: z.ZodEnum<{
        official: "official";
        personal: "personal";
        opensource: "opensource";
    }>;
    customized: z.ZodOptional<z.ZodBoolean>;
    upstream: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    fork: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    branch: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    note: z.ZodOptional<z.ZodNullable<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        zh: z.ZodString;
        en: z.ZodString;
    }, z.core.$strip>]>>>;
}, z.core.$strip>;
/** Zod schema of the profile-level `plugin-origins.json` user override file. */
export declare const originOverrideFileSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    packages: z.ZodRecord<z.ZodString, z.ZodObject<{
        kind: z.ZodEnum<{
            official: "official";
            personal: "personal";
            opensource: "opensource";
        }>;
        customized: z.ZodOptional<z.ZodBoolean>;
        upstream: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        fork: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        branch: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        note: z.ZodOptional<z.ZodNullable<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
            zh: z.ZodString;
            en: z.ZodString;
        }, z.core.$strip>]>>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
/** Parsed plugin manifest `dsh.origin` declaration. */
export type PluginOriginDeclaration = z.infer<typeof manifestOriginSchema>;
/** Parsed per-package user override entry. */
export type PluginOriginOverrideEntry = z.infer<typeof originOverrideEntrySchema>;
/** Parsed user override file with a name-keyed package map. */
export interface PluginOriginOverrides {
    readonly packages: ReadonlyMap<string, PluginOriginOverrideEntry>;
}
/** Outcome of parsing the override file; diagnostics stay path-free. */
export interface PluginOriginOverridesResult {
    readonly overrides: PluginOriginOverrides | null;
    readonly diagnostics: readonly PluginOriginDiagnostic[];
}
/** Official source repositories accepted for `official` claims and heuristics. */
export declare const OFFICIAL_REPOSITORY_URLS: readonly string[];
/** Evidence assembled by the gateway about one resolved plugin package. */
export interface PackageResolutionEvidence {
    /** Real package.json `name` of the resolved package. */
    readonly packageName: string;
    /** Lexical package directory, or null when the module did not resolve. */
    readonly packageDir: string | null;
    /** `fs.realpath` of the package directory, or null when unavailable. */
    readonly realPackageDir: string | null;
    /** Which scanned node_modules root produced the package. */
    readonly resolutionRoot: 'profile' | 'engine' | 'unknown';
    /** The package's real path lives inside the running engine's install tree. */
    readonly insideEngineCheckout: boolean;
    /** The package's real path lives inside `$DSH_HOME/plugins/local`. */
    readonly insideLocalPlugins: boolean;
    /** The dependency spec declared by the profile package.json, when any. */
    readonly profileSpecifier: string | null;
    /** The pnpm-lock.yaml resolution recorded for the profile importer. */
    readonly lockfileResolution: string | null;
    /** A `file:`/`link:` install whose target sits inside the local plugins dir. */
    readonly fileTargetInsideLocal: boolean;
    /** Normalized `repository` URL declared by the package, when any. */
    readonly repositoryUrl: string | null;
}
/** One resolved origin plus the diagnostics produced while resolving it. */
export interface PluginOriginResolution {
    readonly origin: PluginInventoryOrigin;
    readonly diagnostics: readonly PluginOriginDiagnostic[];
}
/**
 * Normalize a repository URL for allow-list comparison: strips the npm `git+`
 * prefix, a trailing `.git`, trailing slashes, and lowercases the result.
 * @param url - raw repository URL from a manifest or evidence.
 * @returns normalized URL, or null for empty input.
 */
export declare function normalizeRepositoryUrl(url: string | null | undefined): string | null;
/**
 * Whether the evidence identifies a package eligible for the `official` kind:
 * an `@deepseek-ai/*` package whose real location is the trusted engine tree
 * or whose repository metadata matches an official source repository.
 * @param evidence - assembled package evidence.
 * @returns true when an official classification is trustworthy.
 */
export declare function isOfficialCandidate(evidence: PackageResolutionEvidence): boolean;
/**
 * Compare two paths containment-style, case-insensitively on Windows. Both
 * sides are expected to be absolute; separators are normalized first.
 * @param candidate - path being tested.
 * @param root - containing directory.
 * @returns true when candidate equals root or lives beneath it.
 */
export declare function isPathInside(candidate: string, root: string): boolean;
/**
 * Extract the target path of a `file:` or `link:` dependency specifier.
 * @param specifier - dependency spec or lockfile resolution string.
 * @returns the raw target path, or null for other protocols.
 */
export declare function parseFileSpecifierTarget(specifier: string | null | undefined): string | null;
/**
 * Strip pnpm's peer-suffix from a lockfile resolution (`(react@18.3.1)`).
 * @param resolution - lockfile `version` string.
 * @returns the bare resolution.
 */
export declare function stripPeerSuffix(resolution: string): string;
/**
 * Parse and validate the raw text of a `plugin-origins.json` override file.
 * An unreadable JSON or an invalid top-level shape discards the whole file;
 * invalid per-package entries are skipped individually.
 * @param text - raw file content.
 * @returns parsed overrides plus sanitized diagnostics.
 */
export declare function parseOriginOverrides(text: string): PluginOriginOverridesResult;
/**
 * Parse a plugin package.json `dsh.origin` value. Returns null for absent or
 * invalid declarations; the caller decides whether a diagnostic is warranted
 * (absent is normal, present-but-invalid is reported).
 * @param value - raw `dsh.origin` value.
 * @returns the parsed declaration, or null.
 */
export declare function parseManifestOrigin(value: unknown): PluginOriginDeclaration | null;
/**
 * Normalize any origin-bearing input into the public shape. `personal` and
 * `official` are self-contained classes: they normalize to `customized: false`
 * and drop repository fields, which only carry meaning for open-source forks.
 * For `opensource`, an explicit `customized` wins; otherwise a fork or branch
 * implies customization, while a note alone does not.
 * @param input - parsed declaration, override merge result, or heuristic draft.
 * @param declaredBy - the layer that produced this input.
 * @returns the normalized origin.
 */
export declare function normalizeOrigin(input: {
    readonly kind: PluginOriginKind;
    readonly customized?: boolean | undefined;
    readonly upstream?: string | null | undefined;
    readonly fork?: string | null | undefined;
    readonly branch?: string | null | undefined;
    readonly note?: string | PluginInventoryCardText | null | undefined;
}, declaredBy: PluginInventoryOrigin['declaredBy']): PluginInventoryOrigin;
/**
 * Merge a user override over the next-lower-priority candidate. The override's
 * `kind` always wins. For `opensource` results, repository fields not mentioned
 * by the override are inherited; an explicit `null` clears one. Switching to
 * `personal` or `official` drops repository fields through normalization.
 * @param base - manifest or heuristic candidate.
 * @param override - the user's override entry.
 * @returns the merged, re-normalized origin declared by the user override.
 */
export declare function mergeOriginOverride(base: PluginInventoryOrigin, override: PluginOriginOverrideEntry): PluginInventoryOrigin;
/**
 * Heuristic origin decision from location and install evidence only. Rules
 * apply top to bottom; the first match fixes `kind` while repository metadata
 * still fills the open-source upstream field.
 * @param evidence - assembled package evidence.
 * @returns the heuristic origin and an optional diagnostic.
 */
export declare function heuristicOrigin(evidence: PackageResolutionEvidence): PluginOriginResolution;
/**
 * Resolve one package's origin through the fixed priority chain: user
 * override, plugin manifest, heuristic. A manifest `official` claim from an
 * untrusted package is rejected before falling through to the heuristic.
 * @param evidence - assembled package evidence.
 * @param layers - parsed override entry and manifest declaration, when present.
 * @returns the final origin plus sanitized diagnostics.
 */
export declare function resolveOrigin(evidence: PackageResolutionEvidence, layers: {
    readonly override?: PluginOriginOverrideEntry | undefined;
    readonly manifest?: unknown;
}): PluginOriginResolution;
//# sourceMappingURL=origin.d.ts.map