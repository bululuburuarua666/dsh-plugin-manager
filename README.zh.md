# DSH 插件管理器

[English](README.md) | 中文

> 看清已加载的插件，只修改真正安全的对象，失败时能够恢复。

[![许可证：MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DSH 兼容版本](https://img.shields.io/badge/DSH-0.1.1--rc.2-4c8bf5.svg)](docs/COMPATIBILITY.zh.md)
[![状态](https://img.shields.io/badge/status-开发预览-orange.svg)](docs/COMPATIBILITY.zh.md)

`dsh-plugin-manager` 是 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的社区插件组合包，在 **设置 → 插件** 中提供一套聚焦的插件管理界面，用于查看来源、停用、启用和卸载 profile 插件。

DSH 的核心是插件。当一个 profile 逐渐装入越来越多插件时，用户需要清楚回答三个问题：

- 这个插件从哪里来？
- DSH 运行期间能否安全修改它？
- 如果操作失败，profile 能否恢复？

本项目围绕这三个问题设计。

## 核心能力

- **来源感知清单** —— 区分官方、个人、开源、开源·定制插件。
- **自动识别 + 人工纠正** —— 保留自动判断结果，同时支持按包名手动覆盖。
- **安全停用 / 启用** —— 通过 profile 补丁层修改受支持插件，执行能力检查、加锁和状态确认。
- **事务化卸载** —— 先备份，只处理目标包及其授权补丁条目，校验结果，必要时安全回滚。
- **失败恢复** —— 遇到 Windows 文件占用或其他进程阻塞时保留 pending-removal 记录，下次启动继续清理。
- **保守的权限边界** —— 分类徽标只影响展示，不会授予信任、停用、启用、卸载或解除保护的权限。
- **双语界面** —— 内置简体中文与英文文案。

## 使用位置

安装后打开：

```text
设置 → 插件 → 插件管理
```

每个条目可以展示当前状态、来源、自动判断结果、元数据，以及针对该 DSH Loader 条目实际允许的操作。对于不支持或受保护的条目，界面会说明原因，而不是显示一个注定失败的按钮。

## 快速开始

### 前置条件

当前版本面向 **DSH `0.1.1-rc.2`** 与标准 `web` profile。安装前先检查 DSH 版本：

```powershell
dsh --version
```

如果 DSH 是从源码仓库运行，请将下面命令中的 `dsh` 替换为 `pnpm dsh`。

### 从 Git 标签安装

将预构建版本安装到目标 profile：

```powershell
dsh plugin --profile web add `
  "git+https://github.com/bululuburuarua666/dsh-plugin-manager.git#v0.1.0-alpha.1"
```

如需固定到已审查的版本，可将标签替换成完整的 40 位 commit SHA。

### 从 Release 压缩包安装

使用项目 Release ZIP 中的 `.tgz` 文件。不要把 GitHub 自动生成的 source-code ZIP 当作正式安装包。

```powershell
Get-FileHash .\dsh-plugin-manager-0.1.0-alpha.1.tgz -Algorithm SHA256

dsh plugin --profile web add `
  .\dsh-plugin-manager-0.1.0-alpha.1.tgz
```

安装前请将哈希与 `SHA256SUMS.txt` 对比。安装完成后可以删除压缩包和解压目录。

### 完成安装

重启 DSH profile，使组合包层和浏览器端模块加载，然后刷新浏览器页面：

```powershell
dsh --profile web
```

如果使用 DSH 源码运行，对应命令是：

```powershell
pnpm dsh web
```

## 来源分类

管理器将自动判断结果与用户选择的展示分类分开保存。

<img width="592" height="550" alt="Pasted image 20260830070553" src="https://github.com/user-attachments/assets/5272069d-3df9-4a69-b133-88878c4d89b6" />




| 标签 | 含义 |
| --- | --- |
| **官方** | DSH 引擎自带或识别为引擎所有的插件。 |
| **个人** | 个人构建或维护的插件。 |
| **开源** | 来自其他开源项目或公共包的插件。 |
| **开源 · 定制** | 基于开源项目，并加入了本地或个人修改。 |

识别器综合使用包信息和 profile 安装来源。插件也可以在 manifest 中声明 `dsh.origin`。当自动识别不足以做出可靠判断时，详情页可以按包名写入人工覆盖，并可随时选择**恢复自动识别**。

人工分类只影响展示：

> 把第三方包标为“官方”，不会让它获得官方信任，也不会改变它是否可停用、可卸载或受保护。

## 生命周期控制

### 停用与启用

<img width="598" height="559" alt="image" src="https://github.com/user-attachments/assets/8a137170-7674-4ec4-917a-29bcde1d17c9" />




对于 profile 根补丁空间内受支持的普通 Host 行，管理器会改写受管补丁块，等待 DSH 反映目标状态；如果无法验证结果，则恢复原始字节。

以下对象明确不会被当作普通热切换目标：

- 位于嵌套子树中的条目，例如 agent preset 领域；
- 分组、include 等组合载体；
- `timer`、`hmr` 等基础设施条目；
- 管理器自身，以及被上游 DSH 保护的包。

不可用的操作是安全判断，不是一次强行修改失败。

### 事务化卸载

卸载遵循受保护的顺序：

```text
备份 → 补丁 splice → Fiber 释放 → 包管理器移除 → 后置校验 → 受保护回滚
```

操作范围限定为所选包及其授权补丁条目，并使用 profile 串行队列、跨进程锁、revision/hash 检查和后置校验。如果无法干净完成，管理器会写入 pending removal，留待下次启动处理，而不是把未完成的卸载报告成成功。

## 安全模型

管理器对修改正在运行的 DSH profile 保持保守边界：

- 浏览器提交的是操作意图，不是任意文件路径或 shell 命令；
- Host 根据当前 Loader/profile 证据解析目标；
- 受保护、歧义、嵌套和过期目标默认拒绝；
- 同一 profile 的并发操作会串行执行；
- 配置和补丁写入使用锁，以及原子 / revision 保护更新；
- 来源徽标不会成为授权机制；
- 来源数据损坏时保留原文件并报告，不会静默覆盖为空配置。

重要提示：DSH 插件本身是可执行代码。本项目管理的是插件生命周期状态，**不会对第三方插件进行沙箱隔离、代码审计或安全背书**。请只安装信任的插件，并在安装前核对 Git 标签、commit SHA、Release 校验和及依赖变化。

详见[安全模型](docs/SECURITY-MODEL.zh.md)与[恢复指南](docs/RECOVERY.zh.md)。

## 兼容性

| DSH 版本 | 状态 | 说明 |
| --- | --- | --- |
| `0.1.1-rc.2` | 支持目标 | 当前发布线。 |
| `0.1.2-alpha.1` | 不支持 | Connection 与 client-runtime 契约发生变化。 |
| DSH `master` | 不支持 | 不要假定兼容持续变化的开发预览分支。 |

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| Windows | 支持 | CI 门禁在 Windows 上运行；生命周期写操作已在那里端到端验证。 |
| Linux / macOS | 暂未适配 | 测试套件的跨平台路径/锁行为移植尚未完成；请自担风险安装。 |

当前版本会在下一版主程序适配完成前先行发布。如果你运行的是 `0.1.2-alpha.1` 或更新的源码检出，请等待兼容版本；不要在该版本上依赖当前版本的生命周期写操作。

在非默认 profile 上安装前，请先阅读[兼容性矩阵](docs/COMPATIBILITY.zh.md)。DSH 自身处于开发预览阶段，可能引入破坏性变更。

## 常见问题

### 看不到插件管理页签

安装后需要重启 DSH。如果仍然没有出现，可以先不启动 profile，检查组合配置：

```powershell
dsh --profile web --dump-config
```

确认管理器包已经出现在 profile 的 bundle 列表中，并且所安装版本符合兼容性矩阵。

### 停用或启用按钮不可用

目标可能位于嵌套子树、是组合载体、属于基础设施、受到 DSH 保护，或当前 profile 不支持实时补丁重载。请按界面显示的原因处理；如果 profile 需要重启生效，请重启 DSH。

### 卸载显示 pending

重启同一个 DSH profile 一次，再查看操作状态和日志。恢复期间不要手动删除包目录或补丁条目，否则可能破坏安全重试所需的证据。

### 操作期间 profile 发生变化

关闭其他会修改同一 profile 的编辑器或 DSH 实例，重新打开管理器，从新的 preview 开始操作。过期 revision 或 hash 会被拒绝，以避免覆盖他人的修改。

## 开发

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
pnpm run test:stock        # stock DSH 安装/启动/通道冒烟象限
pnpm run test:lifecycle    # 隔离 DSH_HOME 上的真实停用/启用变更 E2E
```

当前发布门槛包含 274 项测试、核心模块 100% 覆盖阈值、可复现构建和发布资产校验。跨平台 CI 结果与具体资产哈希应以对应 Release 为准。

反馈问题时请提供 DSH 版本、插件版本、安装来源（Git 或 `.tgz`）、profile 名称、操作类型、界面错误码和脱敏后的日志片段。不要提交 token、cookie、私钥或未脱敏的用户路径。

## 卸载管理器

```powershell
dsh plugin --profile web remove @bululuburuarua666/dsh-plugin-manager
```

卸载后重启 DSH。

## 项目状态

这是独立的社区项目，与 DeepSeek 无隶属关系，亦未获其背书。项目会跟随 DSH 的开发预览 API 演进；兼容性以版本和文档为准，不作默认假设。

欢迎提交贡献、问题报告和兼容性反馈。发起 Pull Request 前请先阅读仓库贡献指南。如果这个项目对你有用，欢迎在 [GitHub](https://github.com/bululuburuarua666/dsh-plugin-manager) 上点一个 Star 支持一下。

## 致谢

本项目的生命周期管理交互与插件更新感知流程，参考了 **Airmetro** 的开源项目 [`dsh-update-checker`](https://github.com/Airmetro/dsh-update-checker)——它会自动检查 DeepSeek Harness 与第三方插件更新、在 Web GUI 中通知，并提供带备份/回滚与重启看护的一键更新。我们的部署环境将该更新流程与本管理器整合使用，其设计从一开始就为项目提供了参照。在此向作者致谢。

## 许可证

MIT —— 见 [LICENSE](LICENSE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
