/**
 * Pure plugin-origin resolution: declaration schemas, normalization, merge,
 * and the heuristic fallback chain. No file or module IO happens here — the
 * gateway assembles {@link PackageResolutionEvidence} and this module decides.
 */

import { z } from 'zod'
import { normalizeInventoryCardText } from './card.ts'
import type {
  PluginInventoryCardText,
  PluginInventoryOrigin,
  PluginOriginDiagnostic,
  PluginOriginKind,
} from './protocol.ts'

/** Maximum code units of a repository URL field. */
const URL_FIELD_MAX = 2_048
/** Maximum code units of a branch name. */
const BRANCH_MAX = 200
/** Maximum code units of one note language. */
const NOTE_MAX = 1_000

/** Bilingual note accepted by origin declarations: one string or zh/en pair. */
const noteSchema = z.union([
  z.string().max(NOTE_MAX),
  z.object({ zh: z.string().max(NOTE_MAX), en: z.string().max(NOTE_MAX) }),
])

/** Shared field shape of origin-bearing declarations. */
const originFieldsSchema = {
  kind: z.enum(['official', 'personal', 'opensource']),
  customized: z.boolean().optional(),
  upstream: z.string().max(URL_FIELD_MAX).nullish(),
  fork: z.string().max(URL_FIELD_MAX).nullish(),
  branch: z.string().max(BRANCH_MAX).nullish(),
  note: noteSchema.nullish(),
}

/** Zod schema of a plugin package.json `dsh.origin` declaration. */
export const manifestOriginSchema = z.object(originFieldsSchema)

/**
 * Zod schema of one `plugin-origins.json` package override. Optional fields
 * accept explicit `null`, which clears the inherited value during the merge.
 */
export const originOverrideEntrySchema = z.object(originFieldsSchema)

/** Zod schema of the profile-level `plugin-origins.json` user override file. */
export const originOverrideFileSchema = z.object({
  schemaVersion: z.literal(1),
  packages: z.record(z.string(), originOverrideEntrySchema),
})

/** Parsed plugin manifest `dsh.origin` declaration. */
export type PluginOriginDeclaration = z.infer<typeof manifestOriginSchema>

/** Parsed per-package user override entry. */
export type PluginOriginOverrideEntry = z.infer<typeof originOverrideEntrySchema>

/** Parsed user override file with a name-keyed package map. */
export interface PluginOriginOverrides {
  readonly packages: ReadonlyMap<string, PluginOriginOverrideEntry>
}

/** Outcome of parsing the override file; diagnostics stay path-free. */
export interface PluginOriginOverridesResult {
  readonly overrides: PluginOriginOverrides | null
  readonly diagnostics: readonly PluginOriginDiagnostic[]
}

/** Official source repositories accepted for `official` claims and heuristics. */
export const OFFICIAL_REPOSITORY_URLS: readonly string[] = [
  'https://github.com/deepseek-ai/deepseek-harness',
]

/** Evidence assembled by the gateway about one resolved plugin package. */
export interface PackageResolutionEvidence {
  /** Real package.json `name` of the resolved package. */
  readonly packageName: string
  /** Lexical package directory, or null when the module did not resolve. */
  readonly packageDir: string | null
  /** `fs.realpath` of the package directory, or null when unavailable. */
  readonly realPackageDir: string | null
  /** Which scanned node_modules root produced the package. */
  readonly resolutionRoot: 'profile' | 'engine' | 'unknown'
  /** The package's real path lives inside the running engine's install tree. */
  readonly insideEngineCheckout: boolean
  /** The package's real path lives inside `$DSH_HOME/plugins/local`. */
  readonly insideLocalPlugins: boolean
  /** The dependency spec declared by the profile package.json, when any. */
  readonly profileSpecifier: string | null
  /** The pnpm-lock.yaml resolution recorded for the profile importer. */
  readonly lockfileResolution: string | null
  /** A `file:`/`link:` install whose target sits inside the local plugins dir. */
  readonly fileTargetInsideLocal: boolean
  /** Normalized `repository` URL declared by the package, when any. */
  readonly repositoryUrl: string | null
}

/** One resolved origin plus the diagnostics produced while resolving it. */
export interface PluginOriginResolution {
  readonly origin: PluginInventoryOrigin
  readonly diagnostics: readonly PluginOriginDiagnostic[]
}

/**
 * Normalize a repository URL for allow-list comparison: strips the npm `git+`
 * prefix, a trailing `.git`, trailing slashes, and lowercases the result.
 * @param url - raw repository URL from a manifest or evidence.
 * @returns normalized URL, or null for empty input.
 */
export function normalizeRepositoryUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null
  let value = url.trim()
  if (value.length === 0) return null
  if (value.startsWith('git+')) value = value.slice(4)
  if (value.endsWith('.git')) value = value.slice(0, -4)
  while (value.endsWith('/')) value = value.slice(0, -1)
  return value.toLowerCase()
}

/**
 * Whether the evidence identifies a package eligible for the `official` kind:
 * an `@deepseek-ai/*` package whose real location is the trusted engine tree
 * or whose repository metadata matches an official source repository.
 * @param evidence - assembled package evidence.
 * @returns true when an official classification is trustworthy.
 */
export function isOfficialCandidate(evidence: PackageResolutionEvidence): boolean {
  if (!evidence.packageName.startsWith('@deepseek-ai/')) return false
  if (evidence.resolutionRoot === 'engine' || evidence.insideEngineCheckout) return true
  const repository = normalizeRepositoryUrl(evidence.repositoryUrl)
  return repository !== null && OFFICIAL_REPOSITORY_URLS.includes(repository)
}

/**
 * Compare two paths containment-style, case-insensitively on Windows. Both
 * sides are expected to be absolute; separators are normalized first.
 * @param candidate - path being tested.
 * @param root - containing directory.
 * @returns true when candidate equals root or lives beneath it.
 */
export function isPathInside(candidate: string, root: string): boolean {
  const normalize = (value: string): string => {
    let result = value.replaceAll('\\', '/')
    while (result.endsWith('/')) result = result.slice(0, -1)
    /* v8 ignore next -- the case-insensitive compare executes only on Windows coverage hosts. */
    return process.platform === 'win32' ? result.toLowerCase() : result
  }
  const child = normalize(candidate)
  const parent = normalize(root)
  return child === parent || child.startsWith(`${parent}/`)
}

/**
 * Extract the target path of a `file:` or `link:` dependency specifier.
 * @param specifier - dependency spec or lockfile resolution string.
 * @returns the raw target path, or null for other protocols.
 */
export function parseFileSpecifierTarget(specifier: string | null | undefined): string | null {
  if (typeof specifier !== 'string') return null
  const value = specifier.trim()
  if (value.startsWith('file:')) return value.slice(5)
  if (value.startsWith('link:')) return value.slice(5)
  return null
}

/**
 * Strip pnpm's peer-suffix from a lockfile resolution (`(react@18.3.1)`).
 * @param resolution - lockfile `version` string.
 * @returns the bare resolution.
 */
export function stripPeerSuffix(resolution: string): string {
  const peerIndex = resolution.indexOf('(')
  return peerIndex === -1 ? resolution : resolution.slice(0, peerIndex)
}

/**
 * Parse and validate the raw text of a `plugin-origins.json` override file.
 * An unreadable JSON or an invalid top-level shape discards the whole file;
 * invalid per-package entries are skipped individually.
 * @param text - raw file content.
 * @returns parsed overrides plus sanitized diagnostics.
 */
export function parseOriginOverrides(text: string): PluginOriginOverridesResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return {
      overrides: null,
      diagnostics: [{ code: 'override-file-invalid', packageName: null }],
    }
  }
  const parsed = originOverrideFileSchema.safeParse(raw)
  if (parsed.success) {
    return { overrides: { packages: new Map(Object.entries(parsed.data.packages)) }, diagnostics: [] }
  }
  // Whole-file shape failures (bad schemaVersion, non-object packages) discard
  // the file; otherwise keep valid entries and report the broken ones.
  if (typeof raw !== 'object' || raw === null) {
    return {
      overrides: null,
      diagnostics: [{ code: 'override-file-invalid', packageName: null }],
    }
  }
  const record = raw as Record<string, unknown>
  if (record.schemaVersion !== 1 || typeof record.packages !== 'object' || record.packages === null) {
    return {
      overrides: null,
      diagnostics: [{ code: 'override-file-invalid', packageName: null }],
    }
  }
  const packages = new Map<string, PluginOriginOverrideEntry>()
  const diagnostics: PluginOriginDiagnostic[] = []
  for (const [name, value] of Object.entries(record.packages as Record<string, unknown>)) {
    const entry = originOverrideEntrySchema.safeParse(value)
    if (entry.success) {
      packages.set(name, entry.data)
    } else {
      diagnostics.push({ code: 'override-entry-invalid', packageName: name })
    }
  }
  return { overrides: { packages }, diagnostics }
}

/**
 * Parse a plugin package.json `dsh.origin` value. Returns null for absent or
 * invalid declarations; the caller decides whether a diagnostic is warranted
 * (absent is normal, present-but-invalid is reported).
 * @param value - raw `dsh.origin` value.
 * @returns the parsed declaration, or null.
 */
export function parseManifestOrigin(value: unknown): PluginOriginDeclaration | null {
  if (value === undefined || value === null) return null
  const parsed = manifestOriginSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** Length-capped bilingual note normalization shared by all declarations. */
function normalizeNote(value: string | PluginInventoryCardText | null | undefined): PluginInventoryCardText | null {
  const text = normalizeInventoryCardText(value)
  if (text === null) return null
  const cap = (input: string): string => input.length <= NOTE_MAX ? input : input.slice(0, NOTE_MAX - 1).trimEnd()
  return { zh: cap(text.zh), en: cap(text.en) }
}

/** Null-safe string field normalization with an empty-string-to-null rule. */
function normalizeField(value: string | null | undefined, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max)
}

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
export function normalizeOrigin(
  input: {
    readonly kind: PluginOriginKind
    readonly customized?: boolean | undefined
    readonly upstream?: string | null | undefined
    readonly fork?: string | null | undefined
    readonly branch?: string | null | undefined
    readonly note?: string | PluginInventoryCardText | null | undefined
  },
  declaredBy: PluginInventoryOrigin['declaredBy'],
): PluginInventoryOrigin {
  const note = normalizeNote(input.note)
  if (input.kind !== 'opensource') {
    return {
      kind: input.kind,
      customized: false,
      upstream: null,
      fork: null,
      branch: null,
      note,
      declaredBy,
    }
  }
  const upstream = normalizeField(input.upstream, URL_FIELD_MAX)
  const fork = normalizeField(input.fork, URL_FIELD_MAX)
  const branch = normalizeField(input.branch, BRANCH_MAX)
  return {
    kind: 'opensource',
    customized: input.customized ?? (fork !== null || branch !== null),
    upstream,
    fork,
    branch,
    note,
    declaredBy,
  }
}

/**
 * Merge a user override over the next-lower-priority candidate. The override's
 * `kind` always wins. For `opensource` results, repository fields not mentioned
 * by the override are inherited; an explicit `null` clears one. Switching to
 * `personal` or `official` drops repository fields through normalization.
 * @param base - manifest or heuristic candidate.
 * @param override - the user's override entry.
 * @returns the merged, re-normalized origin declared by the user override.
 */
export function mergeOriginOverride(
  base: PluginInventoryOrigin,
  override: PluginOriginOverrideEntry,
): PluginInventoryOrigin {
  const keepRepository = override.kind === 'opensource'
  const upstream = override.upstream !== undefined ? override.upstream : (keepRepository ? base.upstream : null)
  const fork = override.fork !== undefined ? override.fork : (keepRepository ? base.fork : null)
  const branch = override.branch !== undefined ? override.branch : (keepRepository ? base.branch : null)
  return normalizeOrigin({
    kind: override.kind,
    // Inherit the base customization flag only when the fields it was derived
    // from survive the merge unchanged; otherwise re-derive from the merged
    // fork/branch (clearing both must clear an implied customized too).
    customized: override.customized
      ?? (override.kind === base.kind && fork === base.fork && branch === base.branch ? base.customized : undefined),
    upstream,
    fork,
    branch,
    note: override.note !== undefined ? override.note : base.note,
  }, 'user-override')
}

/**
 * Heuristic origin decision from location and install evidence only. Rules
 * apply top to bottom; the first match fixes `kind` while repository metadata
 * still fills the open-source upstream field.
 * @param evidence - assembled package evidence.
 * @returns the heuristic origin and an optional diagnostic.
 */
export function heuristicOrigin(evidence: PackageResolutionEvidence): PluginOriginResolution {
  const diagnostics: PluginOriginDiagnostic[] = []
  let kind: PluginOriginKind
  if (evidence.insideLocalPlugins || evidence.fileTargetInsideLocal) {
    kind = 'personal'
  } else if (isOfficialCandidate(evidence)) {
    kind = 'official'
  } else if (evidence.packageName.startsWith('@deepseek-ai/')) {
    // An official-looking name without trusted-location evidence must not
    // wear the official badge; classify conservatively and report.
    kind = 'opensource'
    diagnostics.push({ code: 'official-claim-rejected', packageName: evidence.packageName })
  } else {
    kind = 'opensource'
  }
  return {
    origin: normalizeOrigin({
      kind,
      upstream: kind === 'opensource' ? evidence.repositoryUrl : null,
    }, 'heuristic'),
    diagnostics,
  }
}

/**
 * Resolve one package's origin through the fixed priority chain: user
 * override, plugin manifest, heuristic. A manifest `official` claim from an
 * untrusted package is rejected before falling through to the heuristic.
 * @param evidence - assembled package evidence.
 * @param layers - parsed override entry and manifest declaration, when present.
 * @returns the final origin plus sanitized diagnostics.
 */
export function resolveOrigin(
  evidence: PackageResolutionEvidence,
  layers: {
    readonly override?: PluginOriginOverrideEntry | undefined
    readonly manifest?: unknown
  },
): PluginOriginResolution {
  const diagnostics: PluginOriginDiagnostic[] = []
  let base: PluginInventoryOrigin | null = null

  const manifestProvided = layers.manifest !== undefined && layers.manifest !== null
  const manifest = parseManifestOrigin(layers.manifest)
  if (manifestProvided && manifest === null) {
    diagnostics.push({ code: 'manifest-invalid', packageName: evidence.packageName })
  }
  if (manifest !== null) {
    if (manifest.kind === 'official' && !isOfficialCandidate(evidence)) {
      diagnostics.push({ code: 'official-claim-rejected', packageName: evidence.packageName })
    } else {
      base = normalizeOrigin(manifest, 'manifest')
    }
  }
  if (base === null) {
    const heuristic = heuristicOrigin(evidence)
    diagnostics.push(...heuristic.diagnostics)
    base = heuristic.origin
  }
  if (layers.override !== undefined) {
    return { origin: mergeOriginOverride(base, layers.override), diagnostics }
  }
  return { origin: base, diagnostics }
}
