# DSH Plugin Manager

English | [中文](README.zh.md)

> Know what is loaded. Change only what is safe. Recover when something goes wrong.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DSH compatibility](https://img.shields.io/badge/DSH-0.1.1--rc.2-4c8bf5.svg)](docs/COMPATIBILITY.md)
[![Status](https://img.shields.io/badge/status-development%20preview-orange.svg)](docs/COMPATIBILITY.md)

`dsh-plugin-manager` is a community plugin bundle for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). It adds a focused management surface under **Settings → Plugins** for understanding, disabling, enabling, and uninstalling profile plugins safely.

DSH is built around plugins. As a profile grows, it becomes important to answer three simple questions:

- Where did this plugin come from?
- Can it be changed safely while DSH is running?
- If an operation fails, can the profile be recovered?

This project is designed around those questions.

## Highlights

- **Origin-aware inventory** — distinguish official, personal, open-source, and open-source customized plugins.
- **Automatic classification with human correction** — keep the detected origin visible, while allowing a per-package manual override.
- **Safe disable / enable** — change supported plugins through the profile patch layer, with capability checks, locks, and state verification.
- **Transactional uninstall** — back up first, remove only the intended package and patch entry, validate the result, and roll back when safe.
- **Failure recovery** — preserve pending-removal records and retry cleanup on the next startup when Windows file locks or another process prevent a clean removal.
- **Conservative permissions** — a display label never grants trust, toggle permission, uninstall permission, or protection bypass.
- **Bilingual UI** — English and Simplified Chinese labels are included.

## What it looks like

After installation, open:

```text
Settings → Plugins → Plugin Manager
```

Each entry can expose its current state, origin, detected origin, metadata, and the actions allowed for that exact DSH loader entry. Unsupported or protected entries are reported instead of being given a misleading action button.

## Quick start

### Prerequisites

This release targets **DSH `0.1.1-rc.2`** and the standard `web` profile. Check the DSH version before installing:

```powershell
dsh --version
```

If DSH is running from a source checkout, use `pnpm dsh` in place of `dsh` in the commands below.

### Install from a Git tag

Install the prebuilt release from your profile directory:

```powershell
dsh plugin --profile web add `
  "git+https://github.com/bululuburuarua666/dsh-plugin-manager.git#v0.1.0-alpha.1"
```

To pin an exact reviewed commit, replace the tag with its full 40-character commit SHA.

### Install from a Release archive

Use the `.tgz` included in the project Release ZIP. Do not use GitHub's automatically generated source-code ZIP as the installation artifact.

```powershell
Get-FileHash .\dsh-plugin-manager-0.1.0-alpha.1.tgz -Algorithm SHA256

dsh plugin --profile web add `
  .\dsh-plugin-manager-0.1.0-alpha.1.tgz
```

Compare the hash with `SHA256SUMS.txt` before installing. The archive can be deleted after installation.

### Finish installation

Restart the DSH profile so its bundle layer and client module are loaded, then refresh the browser page:

```powershell
dsh --profile web
```

For a source checkout, the equivalent command is:

```powershell
pnpm dsh web
```

## Origin classification

The manager separates automatic detection from the user's chosen display classification.


<img width="590" height="550" alt="image" src="https://github.com/user-attachments/assets/839f1b6e-239e-42d8-94ff-4f16f21bf4b0" />






| Label | Meaning |
| --- | --- |
| **Official** | Shipped by the DSH engine or identified as engine-owned. |
| **Personal** | Built or maintained as a personal plugin. |
| **Open source** | Installed from another open-source project or public package. |
| **Open source · customized** | Based on an open-source project with local or personal changes. |

The detector uses available package and profile signals. A plugin may also declare `dsh.origin` in its manifest. When automatic detection is not enough, the detail view lets the user set a package-level override and later **Restore automatic detection**.

Manual classification is intentionally presentation-only:

> Marking a third-party package as “Official” does not make it trusted and does not change whether it can be toggled, uninstalled, or protected.

## Lifecycle controls


<img width="590" height="548" alt="image" src="https://github.com/user-attachments/assets/15ee582a-4c1d-4059-b156-53f867dc97e7" />






### Disable and enable

For a supported ordinary Host row in the profile's root patch space, the manager updates the managed patch block, waits for DSH to reflect the requested state, and restores the previous bytes if the operation cannot be verified.

The following are deliberately not treated as ordinary hot-toggle targets:

- entries inside nested subtrees, such as agent-preset realms;
- groups, includes, and other composition carriers;
- infrastructure entries such as `timer` and `hmr`;
- the manager itself and packages protected by the upstream DSH surface.

An unavailable action is a safety result, not a failed attempt to force a change.

### Transactional uninstall

Uninstall follows a guarded sequence:

```text
backup → patch splice → fiber disposal → package-manager removal → postconditions → guarded rollback
```

The operation is scoped to the selected package and its authorized patch entry. It uses profile serialization, cross-process locks, revision/hash checks, and post-operation validation. If a clean removal is impossible, the manager records a pending removal for the next startup instead of pretending that the uninstall finished.

## Security model

The manager is intentionally conservative around operations that modify a running DSH profile:

- the browser submits an operation intent, not an arbitrary filesystem path or shell command;
- the host resolves the target against the current loader/profile evidence;
- protected, ambiguous, nested, and stale targets fail closed;
- concurrent operations on the same profile are serialized;
- configuration and patch writes use locks and atomic/revision-guarded updates;
- an origin label never becomes an authorization mechanism;
- malformed origin data is preserved and reported rather than silently replaced.

Important: DSH plugins are executable code. This project manages plugin lifecycle state; it does **not** sandbox, audit, or declare third-party plugin code safe. Only install plugins and packages you trust, and review Git tags, commit SHAs, release checksums, and dependency changes before installation.

See [SECURITY-MODEL.md](docs/SECURITY-MODEL.md) for the detailed privilege analysis and [RECOVERY.md](docs/RECOVERY.md) for failure handling.

## Compatibility

| DSH version | Status | Notes |
| --- | --- | --- |
| `0.1.1-rc.2` | Supported target | Current release line. |
| `0.1.2-alpha.1` | Not supported | Connection and client-runtime contracts changed. |
| DSH `master` | Not supported | Do not assume compatibility with a moving developer-preview branch. |

The current release is deliberately published before the next main-program adaptation is complete. If you are running `0.1.2-alpha.1` or a newer checkout, wait for a compatible release; do not rely on lifecycle write operations from this version.

Read the [compatibility matrix](docs/COMPATIBILITY.md) before installing into a non-default profile. DSH itself is in developer preview and may introduce breaking changes.

## Troubleshooting

### The tab does not appear

Restart DSH after installation. If it is still missing, inspect the composed profile without booting it:

```powershell
dsh --profile web --dump-config
```

Confirm that the manager package is present in the profile's bundle list and that the installed release matches the DSH compatibility matrix.

### Disable or enable is unavailable

The target may be nested, a composition carrier, infrastructure, protected by DSH, or running in a profile that does not support live patch reload. Use the displayed reason and restart DSH when the profile requires restart-based changes.

### Uninstall is pending

Restart the same DSH profile once, then check the operation status and logs. Do not manually delete the package or patch block while recovery is pending; doing so can remove the evidence needed for a safe retry.

### The profile changed during an operation

Close other profile editors or DSH instances that modify the same profile, reopen the manager, and retry from a fresh preview. A stale revision or hash is rejected to avoid overwriting someone else's change.

## Development

```powershell
pnpm install
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run test:coverage
pnpm run build
pnpm run verify:pack
pnpm run release:assets
pnpm run verify:assets
pnpm run test:install -- tgz
pnpm run test:install -- git-local
pnpm run test:stock        # stock-DSH install/boot/channel smoke quadrant
pnpm run test:lifecycle    # real disable/enable mutation E2E on isolated DSH_HOME
```

The current release gate covers 274 tests, 100% thresholds for the core modules, reproducible builds, and verified release assets. Cross-platform CI results and the exact artifact hashes belong to the individual release.

When reporting a problem, include the DSH version, plugin version, install source (Git or `.tgz`), profile name, operation, displayed error code, and a redacted log excerpt. Never include tokens, cookies, private keys, or unredacted user paths.

## Uninstall the manager

```powershell
dsh plugin --profile web remove @bululuburuarua666/dsh-plugin-manager
```

Restart DSH after removal.

## Project status

This is an independent community project and is not affiliated with or endorsed by DeepSeek. The project is evolving alongside DSH's developer-preview APIs; compatibility is versioned and documented rather than assumed.

Contributions, issue reports, and compatibility feedback are welcome. See the repository contribution guidelines before opening a pull request.

## Acknowledgments

The lifecycle-management UX and the plugin-update awareness flow were designed with reference to [`dsh-update-checker`](https://github.com/Airmetro/dsh-update-checker) by **Airmetro** — an open-source DSH plugin that auto-checks DeepSeek Harness and third-party plugin updates, notifies in the Web GUI, and ships one-click update with backup/rollback and a restart watchdog. Our deployments integrate that update flow alongside this manager, and its design informed this project from day one. Many thanks to its author.

## License

MIT — see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
