# Compatibility

Which DSH Plugin Manager releases work with which DeepSeek Harness (DSH)
releases. The plugin follows DSH's developer-preview cadence: each release
declares exactly the DSH versions it was tested against, and nothing wider.

| Plugin version | DSH release | DSH commit | Status |
|---|---|---|---|
| 0.1.0-alpha.1 | 0.1.1-rc.2 | `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` | development preview |

Machine-readable copy: [`compatibility.json`](../compatibility.json) at the
repository root.

## Verified environments

| Dimension | Tested value |
|---|---|
| OS | Windows 10+ (native CI pending linux/macos) |
| Node | 22.19, 24.x |
| pnpm | 11.7 |
| Profiles | isolated `DSH_HOME` fixtures + a real web profile |

## Upgrade policy

- A new DSH release does **not** widen this plugin's declared range
  automatically. The canary runs first; only a full green gate plus a
  manual API-diff review updates the matrix.
- Installing against an unlisted DSH version is refused by nothing at
  install time (pnpm has no runtime guard), but the channel answers
  `INCOMPATIBLE` on any protocol drift — the tab shows the exact mismatch.

## Breaking-change watchlist

Surfaces this plugin depends on (checked on every DSH release):

1. `connection.rpc.handle/call` and the loopback authority semantics.
2. The profile composition order (bundles → user patch → overlays).
3. The managed-block patch dialect and `cordis.patch.yml` shape.
4. `dsh plugin add/remove` behavior around `dsh.profile.bundles`.
5. The `settings.plugins.tab` slot contract.
