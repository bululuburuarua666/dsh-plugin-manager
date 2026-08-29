# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Manual origin classification: the plugin detail view shows both the
  current and the automatically detected classification, and an
  **Edit classification** dialog writes a per-package override
  (official / user / open-source / open-source·customized, wire kind `personal` — the last
  requires a customization note). Two channel endpoints (`originState`,
  `originUpdate`) persist overrides into the profile's
  `plugin-origins.json` under a cross-process file lock with a revision
  conflict check and atomic writes; a manual "Official" mark changes the
  display only and never affects canToggle/canUninstall/protected
  decisions. "Restore automatic" removes the override; a corrupt override
  file is preserved untouched and reported, never overwritten. Read-only
  deployments refuse the writes.

## [0.1.0-alpha.1] - 2026-08-29

### Added

- Plugin origin classification (official / personal / open-source, with a
  `customized` marker for forks) with user overrides.
- Hot disable/enable and transactional uninstall for profile plugins through
  the Settings "plugin management" tab, backed by a managed block in the
  profile's `cordis.patch.yml`.
- Loopback-pinned RPC channel with strict request validation, size limits,
  and cancellation parity.
- Release pipeline: byte-verified tarball + ZIP assets, isolated DSH_HOME
  stock-quadrant E2E, and a real lifecycle mutation E2E
  (`scripts/test-lifecycle.mjs`).

### Fixed

- **Patch-layer ID space**: managed rows are keyed by the patch-space data id
  (`options.id`), never the loader tree id (`include:<id>`); a tree id written
  verbatim matched nothing and every toggle timed out and rolled back.
- **Strict root-space mapping**: entries outside the root include's patch
  space (nested subtrees, loader-root rows) are not addressable by patches and
  are refused at capability time instead of failing or colliding mid-flight.
- **Carrier rows skipped**: group/include composition containers are excluded
  from evidence and the roster (`subtree`/`subgroup` are Entry-level fields).
- **Protected infrastructure**: `timer`, `hmr`, this manager, and packages the
  upstream surface protects are never hot-toggleable; the same-package group
  check refuses uninstall at capabilities time when any sibling entry lives
  outside the root patch space.
- **Real serialization**: queued mutations start only when dequeued and
  re-validate every bound evidence field (persistence, revision, entry
  presence, capability, package mapping, affected sets) with zero writes on
  drift; `execute` acknowledges `queued`.
- **Empty-template patching**: the official comments-plus-`[]` patch template
  is supported for the first write and restored when the last managed row is
  removed, so the layer never degrades into an unparseable null document.
- **One-way id mapping**: data-id to tree-id conversion prefixes
  unconditionally (`include:<id>`), never guesses from string shape.

### Notes

- Only ordinary Host rows in the profile's root patch space can be toggled;
  nested-subtree rows, composition carriers, and infrastructure rows are
  intentionally excluded (see README).
