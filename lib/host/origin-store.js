/**
 * Origin override store: safe writes to the profile's `plugin-origins.json`.
 * Every update runs the full cycle — cross-process file lock, in-lock
 * re-read, revision conflict check, strict schema validation, atomic write,
 * post-write verification — so two open pages or a manual editor can never
 * silently overwrite each other. A corrupt existing file is preserved
 * untouched and reported, never replaced by an empty configuration.
 *
 * Overrides are keyed by the stable package.json `name`, never by Loader
 * entry ids (those shift with include nesting).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write';
import { originOverrideEntrySchema, originOverrideFileSchema, parseOriginOverrides, } from "./origin.js";
import { managerFailure } from "./failure.js";
import { normalizeInventoryCardText } from "./protocol.js";
/** Revision reported for a missing override file (the fileDigest convention). */
export const ORIGIN_MISSING_REVISION = '-';
/** SHA-256 of one text: the origin override file's revision currency. */
export function originTextDigest(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}
/** Read-modify-write access to one profile's `plugin-origins.json`. */
export class OriginStore {
    profileDir;
    constructor(profileDir) {
        this.profileDir = profileDir;
    }
    /** The override file path; no profile directory means no override writes. */
    originsPath() {
        if (this.profileDir === null) {
            throw managerFailure('ORIGIN_UNAVAILABLE', 'this deployment has no profile directory for origin overrides');
        }
        return join(this.profileDir, 'plugin-origins.json');
    }
    /** Current on-disk revision: the file digest, or '-' when absent. */
    revision() {
        if (this.profileDir === null)
            return ORIGIN_MISSING_REVISION;
        try {
            return originTextDigest(readFileSync(join(this.profileDir, 'plugin-origins.json'), 'utf8'));
        }
        catch {
            return ORIGIN_MISSING_REVISION;
        }
    }
    /**
     * Set (`override`) or clear (`null`, restoring automatic detection) one
     * package's classification. `expectedRevision` must match the in-lock
     * re-read of the file — a stale value answers ORIGIN_CONFLICT and nothing
     * is written.
     */
    async update(packageName, override, expectedRevision) {
        const path = this.originsPath();
        let validated = null;
        if (override !== null) {
            // Re-validate at the business boundary: the wire schema already ran
            // before dispatch, so a mismatch here means the layers drifted apart.
            const entry = originOverrideEntrySchema.safeParse(override);
            /* v8 ignore next 3 -- unreachable from the channel (the strict wire schema rejects first); guards direct store callers. */
            if (!entry.success) {
                throw managerFailure('INTERNAL', 'the override entry failed validation');
            }
            validated = entry.data;
            // A customized open-source classification must carry an explanatory
            // note; every other kind may carry one optionally.
            if (validated.kind === 'opensource' && validated.customized === true
                && normalizeInventoryCardText(validated.note) === null) {
                throw managerFailure('ORIGIN_NOTE_REQUIRED', 'a customized open-source classification requires a note');
            }
        }
        return withFileLock(path, async () => {
            let text;
            try {
                text = readFileSync(path, 'utf8');
            }
            catch {
                text = null;
            }
            // Validity BEFORE the conflict check: a corrupt file must report its
            // real problem, not a revision mismatch, and is never overwritten.
            const packages = new Map();
            if (text !== null) {
                const existing = parseOriginOverrides(text);
                // Fail closed on ANY corruption — a partial parse would silently
                // drop the user's broken entries on the next write.
                if (existing.overrides === null || existing.diagnostics.length > 0) {
                    throw managerFailure('ORIGIN_FILE_INVALID', 'the existing origin override file is invalid; fix or remove it manually');
                }
                for (const [name, value] of existing.overrides.packages)
                    packages.set(name, value);
            }
            const currentRevision = text === null ? ORIGIN_MISSING_REVISION : originTextDigest(text);
            if (currentRevision !== expectedRevision) {
                throw managerFailure('ORIGIN_CONFLICT', 'the origin overrides changed; reload and retry');
            }
            if (validated === null)
                packages.delete(packageName);
            else
                packages.set(packageName, validated);
            const candidate = { schemaVersion: 1, packages: Object.fromEntries(packages) };
            const checked = originOverrideFileSchema.safeParse(candidate);
            /* v8 ignore next 3 -- the candidate is assembled from schema-validated entries only, so this arm is internal-drift defense. */
            if (!checked.success) {
                throw managerFailure('INTERNAL', 'the rendered origin override file failed validation');
            }
            const content = `${JSON.stringify(checked.data, null, 2)}\n`;
            await writeFileAtomic(path, content, { mode: 0o600 });
            // Post-write verification: the on-disk bytes must hash to exactly the
            // content this update committed.
            const committed = readFileSync(path, 'utf8');
            /* v8 ignore next 3 -- requires the file to change between the atomic rename and the immediate re-read; not stageable without fault injection. */
            if (originTextDigest(committed) !== originTextDigest(content)) {
                throw managerFailure('POSTCONDITION_FAILED', 'the origin override file did not verify after writing');
            }
            return { revision: originTextDigest(content) };
        });
    }
}
//# sourceMappingURL=origin-store.js.map