# Security Policy

DSH Plugin Manager handles privileged profile mutations (disable/enable,
package uninstall). Security reports are welcome and handled privately.

## Reporting a Vulnerability

Report privately via [GitHub security advisories](
https://github.com/bululuburuarua666/dsh-plugin-manager/security/advisories/new).

Please include:

- The commit hash or release tag you tested.
- A minimal reproduction (isolated `DSH_HOME`, if possible).
- The impact you see, especially around the loopback boundary, patch
  rewrites, or the uninstall transaction.

Do **not** open a public issue for anything that may be exploitable.

## Scope

In scope:

- The `/dsh-plugin-manager` RPC channel (authority handling, payload gates,
  error sanitization).
- The uninstall transaction (backup, rollback, pending-removal records).
- The patch editor (managed-block rewriting, manual-insert splicing).
- The client response validation (protocol envelope strictness).

Out of scope:

- The upstream DeepSeek Harness trust fence itself (report upstream).
- Issues requiring prior compromise of the loopback host.

## Support Window

| Version | Status |
|---|---|
| `0.1.0-alpha.1` | development preview — best effort |

Target response time for accepted reports: **90 days** to a patched release
or a documented mitigation.

## Hardening Notes

- Mutations are pinned to loopback by the official Host fence; this plugin
  never re-implements trust decisions.
- The channel rejects unknown endpoints, unknown fields, oversize payloads,
  and wrong protocol versions before any engine call.
- Uninstall authorization requires: direct dependency + trusted indexed
  resolution root + exact manifest-name match + not protected + not a
  template bundle. Anything ambiguous fails closed.
- Rollbacks are hash-guarded: drifted user files are never overwritten.
