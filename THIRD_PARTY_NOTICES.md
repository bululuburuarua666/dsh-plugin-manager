# Third-Party Notices

This project is MIT-licensed (see [LICENSE](./LICENSE)). This file tracks
attribution for code derived from upstream projects and for direct runtime
and development dependencies. It is checked by `scripts/verify-docs.mjs`.

## Derived from DeepSeek Harness (MIT)

Files categorized `modified-upstream` in `provenance.json` are derived from
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
Copyright (c) 2026 DeepSeek, licensed under the MIT License (see the
[upstream LICENSE](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE)).

- Upstream base commit: `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
  (`0.1.1-rc.2`).
- Derived areas: the plugin-inventory host surface (card reader, origin
  resolution, install-source reading, and their tests) and the settings
  plugin-inventory client patterns (tab registration, lifecycle controls,
  error-code localization). Per-file original paths are recorded in
  `provenance.json`.
- Modifications: extraction into this standalone package, the resolution-
  root authorization model, and the Connection-RPC channel integration.

Files categorized `original` were written for this project.

## Direct runtime dependencies

| Package | License | Used for |
|---|---|---|
| `js-yaml` | MIT | entry-list YAML parsing (patch text, lockfile) |
| `yaml` | ISC | YAML CST editing for manual-insert row removal |
| `zod` | MIT | request/response schema validation |
| `@deepseek-ai/dsh-atomic-write` | MIT | atomic writes + cross-process file locks |

## Development dependencies

| Package | License | Used for |
|---|---|---|
| `typescript` | Apache-2.0 | type checking + host build |
| `esbuild` | MIT | browser client bundle |
| `vitest`, `@vitest/coverage-v8` | MIT | tests + coverage gates |
| `@testing-library/react`, `@testing-library/dom` | MIT | component tests |
| `react`, `react-dom`, `@types/react` | MIT | UI runtime + types |
| `@types/node`, `@types/js-yaml` | MIT | ambient types |
| `oxlint` | MIT | lint gate |
| `jsdom` | MIT | DOM test environment |

Peer dependencies on DeepSeek Harness packages (`@deepseek-ai/cordis`,
`@deepseek-ai/cordis-plugin-include`, `@deepseek-ai/cordis-plugin-loader`,
`@deepseek-ai/dsh-invariants`, `@deepseek-ai/dsh-typert-protocol`) remain
under their own MIT licensing; this project does not relicense them.
