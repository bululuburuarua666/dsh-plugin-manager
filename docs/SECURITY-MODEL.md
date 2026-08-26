# SECURITY-MODEL — DSH Plugin Manager

How the privilege boundary works, in one page. Bilingual: this file is the
English reference; see [SECURITY-MODEL.zh.md](./SECURITY-MODEL.zh.md) for the
Chinese mirror.

## Threat model

The plugin can: rewrite the profile's `cordis.patch.yml`, remove npm
dependencies, and invoke pnpm — all inside the Host process. The questions
this model answers:

1. Who may reach those powers?
2. What can a malicious request smuggle in?
3. What happens when a mutation fails midway?

## 1. Network boundary — loopback only

Every request to `/dsh-plugin-manager` passes the **official DSH Host trust
fence** (`isTrustedApiRequest` with an empty trust list for loopback
authority) *before* any plugin code runs. Consequences, verified by test:

| Request shape | Result |
|---|---|
| loopback client, POST, JSON | 200 → handler |
| spoofed `Host` header | 403, handler never invoked |
| cross-site `Origin` + `Sec-Fetch-Site` | 403, handler never invoked |
| wrong content type | 415 |
| malformed JSON body | 400 |

The plugin never re-implements trust decisions; it cannot weaken them.

## 2. Payload gates — everything fails closed

- Unknown endpoints → `ENDPOINT_UNKNOWN`.
- Unknown fields → `REQUEST_INVALID` (strict zod schemas, no passthrough).
- Wrong `protocolVersion` → `REQUEST_INVALID`; version-mismatched success
  responses → `INCOMPATIBLE` on the client.
- Payloads over 64 KiB (UTF-8 bytes, any JSON type) → `REQUEST_TOO_LARGE`.
- Pre-cancelled requests → `CANCELLED`; an `execute` acknowledged before
  cancellation always runs to completion (no half-transactions).

The browser only ever submits an `entryId` plus an `action`; every path,
package spec, and command is re-derived Host-side.

## 3. Uninstall authorization — six gates, all mandatory

An entry is uninstallable only when **all** hold:

1. `writable` persistence (an all-interfaces bind ⇒ read-only).
2. The package is a **direct dependency** of the profile manifest.
3. It resolved from the **profile's own node_modules** (the trusted indexed
   root); an engine-root resolution is `engine-owned`, an unindexed
   fallback is `ambiguous-package` — both denied.
4. Its `package.json` `name` matches the declared name exactly.
5. It is not in the protected list (engine-critical + the manager itself).
6. It is not a template bundle member.

Anything uncertain fails closed.

## 4. Transaction semantics

`preview → execute → operation` with:

- One-use CSPRNG tokens (60 s TTL) binding action + entry + evidence revision.
- Per-profile serial queue: operations start only after the previous
  settles, with evidence re-validated at dequeue (`PROFILE_CHANGED` on drift).
- Toggle: managed-block rewrite under a cross-process file lock; on failure
  the before-image is restored **only while the file still hashes to this
  operation's after-image** — external edits are never overwritten.
- Uninstall: SHA-256 backup manifest → patch disable+splice → fiber
  disposal → no-shell pnpm → target-only link removal → postconditions →
  hash-guarded rollback; anything undeletable becomes a pending-removal
  record settled idempotently on the next startup.

## 5. Diagnostics hygiene

Errors crossing the wire carry codes and sanitized messages only — no
paths, no stack traces, no environment. Server-side diagnostics log the
error class and endpoint, never payloads.

## Recovery

- Every uninstall backs up the touched files first; see
  [RECOVERY.md](./RECOVERY.md).
- `ROLLBACK_INCOMPLETE` means the restore write itself failed: the backup
  directory holds the pre-mutation images for manual restoration.
