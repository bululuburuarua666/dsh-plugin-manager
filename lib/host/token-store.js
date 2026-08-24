/** Bounded one-use preview token store with injectable clock and randomness. */
import { randomBytes } from 'node:crypto';
const DEFAULT_CAPACITY = 32;
const DEFAULT_TTL_MS = 60_000;
/**
 * CSPRNG one-use token store. Tokens expire after `ttlMs`; `consume` deletes
 * on first read regardless of validity, so a token can never be replayed.
 * Eviction is FIFO by issue order once the bound is exceeded.
 */
export class PluginLifecycleTokenStore {
    now;
    randomHex;
    capacity;
    ttlMs;
    tokens = new Map();
    constructor(deps = {}) {
        this.now = deps.now ?? Date.now;
        this.randomHex = deps.randomHex ?? (bytes => randomBytes(bytes).toString('hex'));
        this.capacity = deps.capacity ?? DEFAULT_CAPACITY;
        this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    }
    /**
     * Issue a token binding the given evidence.
     * @param binding - action and evidence the token commits to.
     * @returns the token id and its expiry.
     */
    issue(binding) {
        this.sweepExpired();
        const token = this.randomHex(16);
        const expiresAt = this.now() + this.ttlMs;
        this.tokens.set(token, { ...binding, token, expiresAt });
        while (this.tokens.size > this.capacity) {
            const oldest = this.tokens.keys().next();
            /* v8 ignore next -- the size bound guarantees an oldest key exists. */
            if (oldest.done)
                break;
            this.tokens.delete(oldest.value);
        }
        return { token, expiresAt };
    }
    /**
     * Consume a token: the record is deleted on first read and returned only
     * when still unexpired.
     * @param token - the opaque token id.
     * @returns the bound evidence, or null when unknown or expired.
     */
    consume(token) {
        const record = this.tokens.get(token);
        if (record === undefined)
            return null;
        this.tokens.delete(token);
        return record.expiresAt >= this.now() ? record : null;
    }
    /** Drop expired tokens. */
    sweepExpired() {
        const now = this.now();
        for (const [token, record] of this.tokens) {
            if (record.expiresAt < now)
                this.tokens.delete(token);
        }
    }
}
//# sourceMappingURL=token-store.js.map