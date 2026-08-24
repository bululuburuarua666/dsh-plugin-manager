# @deepseek-ai/dsh-host-plugin-inventory

[English](README.md) | 中文

当前 Cordis Loader 树的只读 Host 投影。`PluginInventoryGateway` 注册 `pluginInventory` 服务，并发布一个由 Typert 生成的直接 Remote：`pluginInventory/list`。每次调用都直接读取 `ctx.loader.entries()`，跳过结构性的 group 行，再按 Loader 顺序返回其余条目，包含 Loader 条目 id、模块标识、有效启用状态、当前根 Fiber 阶段与 `updatedAt` 毫秒时间戳。

阶段为 `pending`、`loading`、`active`、`failed` 或 `unloading`；条目没有存活的根 Fiber 时则为 `null`。`updatedAt` 记录最近一次观察到的 `internal/plugin`、`internal/status` 或 `loader/partial-dispose` 变化；在本服务启动前已经变化的条目回退为服务的首次观察时间，因此每个条目都有可用于排序的本次进程时间戳。该快照刻意只表示调用当下：Loader 仍是唯一的生命周期权威，本包不拥有生命周期缓存、历史、来源模型、事件流或修改路径。公开 payload 类型位于 `./types`，Typert 生成由 `./typert` 与 `./remote` 导出的 Host 和 Client Remote 产物。

该服务仅供 Remote 使用，刻意不声明同进程 Cordis `Context` merge。Client 包通过显式的 [`api-remotes`](../../api/remotes/README.zh.md) 组合消费它，而不导入 Host 实现。

## 插件信息卡标准

每个插件包都应在 package.json 的 `dsh.inventory` 中声明双语悬停信息卡。`title` 是插件的中文意思，`description` 是一句话能力简介；两个字段都接受单一字符串或 `{ "zh", "en" }` 对象：

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

未声明 `dsh.inventory` 时，网关会回退读取 `README.zh.md` / `README.md` 的首个正文段落（英文还可回退到 package description），让现有包也能获得能力简介；此时标题为 null，客户端显示模块名。

## 插件来源分类

每个条目还带有一个可选的 `origin` 投影，把插件包分类为 `official`（官方）、`personal`（个人）或 `opensource`（开源）。带有个人修改的开源包保持 `kind: "opensource"`，并附加 `customized: true` 及 `fork` / `branch` / `note` 明细；`personal` 插件是自主构建的作品（即使借鉴了其他项目的思路），始终规范化为 `customized: false`。解析遵循固定的优先级链：

1. **用户覆盖** —— profile 根目录的 `plugin-origins.json`：`{ "schemaVersion": 1, "packages": { "<包名>": { "kind": "personal", ... } } }`。键是真实的 package.json 包名，不是 Loader 条目 id。可选字段上的显式 `null` 会清除继承值。
2. **插件声明** —— 包自身 package.json 的 `dsh.origin` 字段，例如 `{ "dsh": { "origin": { "kind": "opensource", "customized": true, "upstream": "https://github.com/owner/project", "fork": "https://github.com/me/project", "branch": "my-tweaks", "note": { "zh": "…", "en": "…" } } } }`。第三方包无法借此自称 `official`：除非包实际位于运行中引擎的安装树内，或声明了官方仓库，否则该声明会被忽略（并产生 `official-claim-rejected` 诊断）。
3. **启发式** —— 从 `$DSH_HOME/plugins/local` 安装的包（按真实路径，或 profile 的 `file:`/`link:` 解析指向该目录）默认为 `personal`；可信的 `@deepseek-ai/*` 包默认为 `official`；registry/git/tarball 形式的 profile 直接依赖以及无法定位的包保守地归为 `opensource`，并把包的 `repository` URL 透出为 `upstream`。`cordis:` 内建模块属于引擎框架组件，报告为 `official`。

`origin.declaredBy` 记录结果来自哪一层（`user-override` / `manifest` / `heuristic`）。解析失败不会导致列表失败：无效的 manifest 与覆盖条目会降级到下一层，并以去敏的 `diagnostics` 形式随快照返回（只有错误码与包名，绝不包含路径或依赖 spec）。该徽标是产品层标签，不构成供应链信任结论。

## 模型体验

无，因为这个仅限 Host 的清单投影不注册提示词、工具、消息或提供方请求。

#### KV Cache 影响

无；本包从不组装模型输入。

## 已知限制与暂缓事项

- **仅表示调用当下** —— 结果不包含持久的失败历史或订阅；只要不存在存活的根 Fiber，就会报告 `null`，而不区分其原因。
- **进程内观察时间** —— `updatedAt` 是用于排序的观察时间戳，不是持久的安装或更新时间；进程重启后会重置。
- **来源只读** —— 服务会投影每个条目的来源分类（见上文），但不能启用、停用、添加或移除插件，分类也不会用于加载、更新或权限判定。
