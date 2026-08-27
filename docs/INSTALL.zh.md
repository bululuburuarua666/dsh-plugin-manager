# 安装 DSH 插件管理器

> 社区项目，与 DeepSeek 无隶属关系，亦未获其背书。
> 仅兼容 DeepSeek Harness `0.1.1-rc.2`（见 `compatibility.json`）。

## 从 GitHub Release（ZIP）安装

1. 下载 Release ZIP 并解压。
2. 用 `SHA256SUMS.txt` 校验 tarball——计算哈希并**与记录的摘要比对**
   （不一致即停止并重新下载）：

   ```powershell
   # 输出哈希；与 SHA256SUMS.txt 中 <digest>  ...tgz 行比对
   Get-FileHash .\dsh-plugin-manager-<version>.tgz -Algorithm SHA256
   Select-String -Path .\SHA256SUMS.txt -Pattern '.tgz'
   ```

3. 安装到 profile（源码部署用户在命令前加 `pnpm`）：

   ```powershell
   dsh plugin --profile web add .\dsh-plugin-manager-<version>.tgz
   dsh --profile web --dump-config   # 应出现 dsh-plugin-manager 行
   dsh web                            # 重启后：设置 → 插件 → 插件管理
   ```

4. 安装完成后可删除下载目录——profile 不会回链它。

## 从 Git（固定 tag）安装

```powershell
dsh plugin --profile web add "git+https://github.com/bululuburuarua666/dsh-plugin-manager.git#v<version>"
```

高保证场景请固定 release 的 40 位完整 commit，而非可移动的 tag 名：

```powershell
dsh plugin --profile web add "git+https://github.com/bululuburuarua666/dsh-plugin-manager.git#<40位commit-SHA>"
# 形态示例：
dsh plugin --profile web add "git+https://github.com/bululuburuarua666/dsh-plugin-manager.git#0123456789abcdef0123456789abcdef01234567"
```

包内自带已构建的 `lib/` 且声明零安装脚本，Git 安装无需放行构建。

## 卸载

```powershell
dsh plugin --profile web remove @bululuburuarua666/dsh-plugin-manager
```

之后重启 DSH；tab 与 bundle 行一并消失。恢复数据（备份、待清理记录）
保留在 `$DSH_HOME` 下，卸载程序不会删除它们。
