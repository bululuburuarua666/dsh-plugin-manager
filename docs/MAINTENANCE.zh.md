# 维护策略

本项目的版本、支持与退役方式。本文为中文对照版；英文参考见
[MAINTENANCE.md](./MAINTENANCE.md)。

## 版本化

跟随 DSH 开发者预览窗口采用 SemVer 预发布标签
（`0.1.0-alpha.1` → `0.1.0-beta.1` → `0.1.0-rc.1` → `0.1.0`）。每次
发布在**同一提交**内更新：

- `package.json` 的 `version`
- `compatibility.json`（`pluginVersion` + 实测 DSH 矩阵）
- `docs/COMPATIBILITY.md` + `.zh.md`（人类可读矩阵）

任何一处漂移都会被 `scripts/verify-docs.mjs` 拦下。

## 支持窗口

| 通道 | 窗口 |
|---|---|
| 预发布（`alpha`/`beta`/`rc`） | 至同 minor 的下一个预发布 |
| `0.x` 稳定版 | 尽力维护；安全修复优先 |
| 矩阵中列出的 DSH 版本 | 支持至该矩阵条目随某次发布移除 |

## 弃用策略

某个 DSH 版本只有通过满足以下两点的发布才能离开兼容矩阵：

1. 发布说明中写明移除与替代路径；
2. 至少仍列出一个受支持的 DSH 版本。

本插件绝不静默放宽或收窄声明范围；协议不匹配会在页签以
`INCOMPATIBLE` 显示具体版本。

## SBOM 生成（自 `0.1.0-beta.1` 起）

每次发布附带 CycloneDX 文档 `dsh-plugin-manager-<v>.cdx.json`：

- 由 `scripts/generate-sbom.mjs` 在发布构建时从 `pnpm list --json`
  生成（运行时 + 开发依赖闭包、锁定版本、来自包清单的许可证）。
- 与 tarball 一同存放于发布资产；其 SHA-256 记入 `SHA256SUMS.txt`。
- 由 `scripts/verify-release-assets.mjs` 校验（存在 + 摘要）；生成器
  落地前 verifier 报 "sbom pending"。

## 发布检查单（每次发布）

1. 版本四元组更新且 `verify:docs` 绿。
2. 发布提交上全门槛绿（typecheck/lint/测试/覆盖率/构建/lib 复现/
   pack/资产/文档）。
3. 资产组装 + 校验；SBOM 生成并计入哈希。
4. 在已评审提交上打 annotated tag；immutable GitHub release；附
   artifact attestation（CI）。
5. 从已发布资产做一次干净环境冒烟安装（`test:install` 两种模式），
   记录进发布说明。
