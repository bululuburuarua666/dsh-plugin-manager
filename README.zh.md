# DSH 插件管理器

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）
的社区插件：插件来源分类（官方 / 个人 / 开源）与生命周期管理（热停用/
启用、事务化卸载），以「插件管理」页签呈现在 设置 → 插件。

> 社区项目，与 DeepSeek 无隶属关系，亦未获其背书。
> 仅兼容 DSH `0.1.1-rc.2` —— 见[兼容性矩阵](docs/COMPATIBILITY.zh.md)。

状态：**开发预览**（`0.1.0-alpha.1`）。完整门槛（226 项测试、九个核心
模块 100% 覆盖、字节可复现构建、字节校验的发布资产）已**配置三平台
CI**；首次真实跨平台运行随初次 GitHub 推送落地。

## 功能

- **来源分类** —— 每个插件行带徽标：官方 / 个人 / 开源（定制分支附
  `customized` 标记）。判定顺序：用户覆盖（`plugin-origins.json`）→
  插件声明（`dsh.origin`）→ 位置启发式；不受信位置的官方声明会被拒绝。
- **热停用 / 启用** —— 跨进程文件锁下改写 profile `cordis.patch.yml`
  的受管块，等待 loader 反映状态；失败按字节安全回滚。
- **事务化卸载** —— 备份 → 补丁 splice → fiber 释放 → 无 shell pnpm →
  后置校验 → hash-guard 回滚；无法干净移除的写入 pending-removal
  记录，下次启动清账。

完整特权分析见[安全模型](docs/SECURITY-MODEL.zh.md)，失败处置路由见
[恢复指南](docs/RECOVERY.zh.md)。

## 安装

见 [docs/INSTALL.zh.md](docs/INSTALL.zh.md)（ZIP / 固定 Git / 卸载）。

## 开发

```powershell
pnpm install
pnpm run typecheck      # tsc 严格模式
pnpm run lint           # oxlint（0 错误门槛）
pnpm run test           # 226 项测试
pnpm run test:coverage  # 九个核心模块 100% 阈值
pnpm run build          # host + 浏览器 client 双端构建
pnpm run verify:pack    # tarball 表面检查
pnpm run release:assets ; pnpm run verify:assets
pnpm run test:install -- tgz        # 真实 安装/启动/RPC/移除 周期
pnpm run test:install -- git-local  # 固定 SHA 安装、零构建脚本
```

许可证：MIT —— 见 [LICENSE](LICENSE) 与
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
