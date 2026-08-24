# @deepseek-ai/dsh-host-plugin-inventory

English | [中文](README.zh.md)

Read-only Host projection of the current Cordis Loader tree. `PluginInventoryGateway` registers the `pluginInventory` service and publishes one generated direct Remote, `pluginInventory/list`. Every call reads `ctx.loader.entries()` directly, skips structural group rows, and returns the remaining entries in Loader order with their Loader entry id, module specifier, effective enablement, current root Fiber phase, and `updatedAt` epoch milliseconds.

The phase is `pending`, `loading`, `active`, `failed`, or `unloading`; it is `null` when the entry has no live root Fiber. `updatedAt` records the latest observed `internal/plugin`, `internal/status`, or `loader/partial-dispose` change for that entry; entries that changed before this service started fall back to its first observation time, so every entry carries a sortable timestamp for the current process run. The snapshot is intentionally point-in-time: Loader remains the sole lifecycle authority, while this package owns no lifecycle cache, history, provenance model, event stream, or mutation path. Its public payload types live under `./types`, and Typert generates the Host and Client Remote artifacts exposed by `./typert` and `./remote`.

The service is Remote-only and deliberately declares no same-process Cordis `Context` merge. Client packages consume it through the explicit [`api-remotes`](../../api/remotes/README.md) assembly rather than importing the Host implementation.

## Plugin information card standard

Every plugin package should declare a bilingual hover card in its package.json `dsh.inventory` section. `title` is the plugin's Chinese meaning, `description` is a one-sentence capability summary; each field accepts one string or `{ "zh", "en" }`:

```json
{
  "dsh": {
    "inventory": {
      "title": { "zh": "插件清单", "en": "Plugin inventory" },
      "description": {
        "zh": "在设置中展示当前插件列表与悬停详情卡。",
        "en": "Shows the current plugin list and hover detail cards in Settings."
      }
    }
  }
}
```

When `dsh.inventory` is absent, the gateway falls back to the first prose paragraph of `README.zh.md` / `README.md` (and the package description for English) so existing packages still get a capability summary; the title remains null and the client shows the module name.

## Plugin origin classification

Every entry also carries an optional `origin` projection classifying the package as `official`, `personal`, or `opensource`. Open-source packages with personal modifications keep `kind: "opensource"` and add `customized: true` plus `fork` / `branch` / `note` details; `personal` plugins are self-built works (even when inspired by other projects) and always normalize to `customized: false`. Resolution follows a fixed priority chain:

1. **User override** — `plugin-origins.json` in the profile root: `{ "schemaVersion": 1, "packages": { "<package name>": { "kind": "personal", ... } } }`. Keys are real package.json names, not Loader entry ids. An explicit `null` on an optional field clears the inherited value.
2. **Plugin manifest** — the package's own package.json `dsh.origin` declaration, e.g. `{ "dsh": { "origin": { "kind": "opensource", "customized": true, "upstream": "https://github.com/owner/project", "fork": "https://github.com/me/project", "branch": "my-tweaks", "note": { "zh": "…", "en": "…" } } } }`. A third-party package cannot claim `official` this way: the claim is ignored (with an `official-claim-rejected` diagnostic) unless the package resolves inside the running engine's install tree or declares an official repository.
3. **Heuristic** — packages installed from `$DSH_HOME/plugins/local` (by real path or by a `file:`/`link:` profile resolution targeting it) default to `personal`; trusted `@deepseek-ai/*` packages default to `official`; registry/git/tarball profile dependencies and anything unresolved default conservatively to `opensource`, with the package `repository` URL surfaced as `upstream`. `cordis:` builtin modules are engine framework parts and report `official`.

`origin.declaredBy` records which layer produced the result (`user-override` / `manifest` / `heuristic`). Resolution failures never fail the list: invalid manifests and override entries degrade to the next layer and surface as sanitized `diagnostics` on the snapshot (codes plus package names only — never paths or specs). The badge is a product label, not a supply-chain trust decision.

## Model Experience

None, as this Host-only inventory projection registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **Point-in-time state only** — the result contains no durable failure history or subscription; a missing root Fiber is reported as `null`, regardless of why no live root exists.
- **Process-local observation time** — `updatedAt` is an observation timestamp for sorting, not durable install or update history; values reset when the process restarts.
- **Read-only provenance** — the service projects an origin classification per entry (see above) but cannot enable, disable, add, or remove plugins, and the classification never gates loading, updates, or permissions.
