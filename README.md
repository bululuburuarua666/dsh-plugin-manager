# DSH Plugin Manager

Community plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(DSH): plugin origin classification (official / personal / open-source) and
lifecycle management (hot disable/enable, transactional uninstall), surfaced
as a **Plugin manager** tab under Settings → Plugins.

> Community project; not affiliated with or endorsed by DeepSeek.
> Compatible with DSH `0.1.1-rc.2` only — see the [compatibility matrix](
> docs/COMPATIBILITY.md).

Status: **development preview** (`0.1.0-alpha.1`). The full gate set
(226 tests, 100% coverage on the nine core modules, byte-reproducible
builds, byte-verified release assets) is **CI-configured for three
platforms**; first real cross-platform runs land with the initial GitHub
push.

## What it does

- **Origin classification** — every plugin row carries a badge:
  official / personal / open-source (with a `customized` marker for forks).
  Classification order: user override (`plugin-origins.json`) → plugin
  manifest (`dsh.origin`) → location heuristics; official claims from
  untrusted locations are rejected.
- **Hot disable / enable** — rewrites a managed block in the profile's
  `cordis.patch.yml` under a cross-process lock and waits for the loader
  to reflect the state; failures roll back byte-safely.
- **Transactional uninstall** — backup → patch splice → fiber disposal →
  no-shell pnpm → postconditions → hash-guarded rollback; anything not
  cleanly removable becomes a pending-removal record settled on the next
  startup.

See the [security model](docs/SECURITY-MODEL.md) for the full privilege
analysis and [recovery guide](docs/RECOVERY.md) for failure routing.

## Install

See [docs/INSTALL.md](docs/INSTALL.md) (ZIP / pinned-Git / uninstall).

## Develop

```powershell
pnpm install
pnpm run typecheck   # tsc, strict
pnpm run lint        # oxlint (0-error gate)
pnpm run test        # 226 tests
pnpm run test:coverage  # 100% thresholds on the nine core modules
pnpm run build       # host + browser client bundle
pnpm run verify:pack    # tarball surface inspection
pnpm run release:assets && pnpm run verify:assets
pnpm run test:install -- tgz        # real install/Boot/RPC/remove cycle
pnpm run test:install -- git-local  # pinned-SHA install, no build scripts
```

License: MIT — see [LICENSE](LICENSE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
