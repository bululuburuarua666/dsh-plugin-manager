# 兼容性

DSH 插件管理器各版本与 DeepSeek Harness（DSH）版本的对应关系。本插件跟随
DSH 的开发者预览节奏：每个版本只声明实测过的 DSH 版本，不做更宽的承诺。

| 插件版本 | DSH 版本 | DSH commit | 状态 |
|---|---|---|---|
| 0.1.0-alpha.1 | 0.1.1-rc.2 | `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` | 开发预览 |

机器可读副本：仓库根目录的 [`compatibility.json`](../compatibility.json)。

## 已验证环境

| 维度 | 实测值 |
|---|---|
| 操作系统 | Windows 10+（linux/macos 原生 CI 待跑） |
| Node | 22.19、24.x |
| pnpm | 11.7 |
| Profile | 隔离 `DSH_HOME` 夹具 + 一个真实 web profile |

## 升级策略

- DSH 新版本发布**不会**自动放宽本插件的声明范围。先跑 canary；
  只有全部门槛变绿并人工复核 API diff 后才更新矩阵。
- 在未列出的 DSH 版本上安装不会被安装期拦截（pnpm 无运行时护栏），
  但通道会在协议漂移时返回 `INCOMPATIBLE`——页签会显示具体不匹配项。

## 破坏性变更观察清单

本插件依赖的面（每个 DSH 版本发布时核对）：

1. `connection.rpc.handle/call` 与 loopback authority 语义。
2. profile 组合顺序（bundle → 用户 patch → overlay）。
3. 受管块补丁方言与 `cordis.patch.yml` 形状。
4. `dsh plugin add/remove` 对 `dsh.profile.bundles` 的维护行为。
5. `settings.plugins.tab` 插槽契约。
