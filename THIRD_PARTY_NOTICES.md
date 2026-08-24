# Third-Party Notices

This project is MIT-licensed (see [LICENSE](./LICENSE)). This file tracks
attribution for code derived from upstream projects and for direct runtime
dependencies. It is regenerated and expanded during the release process
(`scripts/generate-notices.mjs`); the list below is the initial T00 snapshot.

## Derived from DeepSeek Harness (MIT)

Files categorized `modified-upstream` in [`provenance.json`](./provenance.json)
are derived from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
Copyright (c) 2026 DeepSeek, licensed under the MIT License (see
[upstream LICENSE](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE)).

- Upstream base commit: `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` (`0.1.1-rc.2`)
- Derived areas: plugin-inventory host surface (card/index/types and tests,
  package manifest, READMEs) and the settings plugin-inventory client
  (tab component, module CSS, locales, entry, tests). Per-file original paths
  are recorded in `provenance.json`.
- Modifications: plugin origin classification and lifecycle-management UI
  contributed by this project's authors.

Files categorized `original` were written from scratch for this project and
are not derived from upstream code.

## Direct runtime dependencies

| Package | License | Note |
|---|---|---|
| js-yaml | MIT | patch-text parsing |
| yaml | ISC | YAML CST editing for manual-insert row removal |
| zod | MIT | protocol payload validation |

Peer dependencies on DeepSeek Harness packages (`@deepseek-ai/*`) remain
under their own MIT licensing; this project does not relicense them.
