# 恢复指南

生命周期操作报错时怎么办。本文为中文对照版；英文参考见
[RECOVERY.md](./RECOVERY.md)。

## 状态都放在哪

| 路径（`$DSH_HOME` 下） | 含义 |
|---|---|
| `profiles/<name>/cordis.patch.yml` | 受管启停行位于文件末尾的标记块 |
| `profiles/<name>/plugin-lifecycle-backups/<name>/` 或 `dsh-plugin-manager-backups/<name>/` | 变更前镜像 + SHA-256 清单 |
| `profiles/<name>/dsh-plugin-manager-pending-removals.json` | 等待重启清账的卸载记录 |

## 错误码路由

| 码 | 含义 | 处置 |
|---|---|---|
| `TIMEOUT` | loader 未反映启停 | 补丁已回滚；重试，或检查 Host 的 patch watcher |
| `INVALID_PATCH` / `MANAGED_BLOCK_INVALID` | 受管块周边 YAML 损坏 | 文件未被修改；手工修 YAML 或还原备份 |
| `PACKAGE_MANAGER_FAILED` | pnpm 非零退出 | 已全部回滚；可在 profile 目录跑 `pnpm install` 复核 |
| `POSTCONDITION_FAILED` | 卸载后置校验发现残留 | 已回滚；备份目录存有变更前镜像 |
| `ROLLBACK_INCOMPLETE` | 还原写本身失败 | **需要手工恢复** —— 见下 |

## `ROLLBACK_INCOMPLETE` 的手工恢复

1. 停掉该 profile 的 DSH 进程。
2. 打开 `<backup-root>/<operationId>/`——里面有操作触过的每个文件，
   以及记录变更前 SHA-256 的 `manifest.json`。
3. 只有当文件当前哈希匹配清单的 **after** 值（即操作的写入仍在）才
   还原其 before 镜像；两者都不匹配说明有他人改过——凭判断恢复，
   不要盲目覆盖。
4. 还原后，若 `pending-removals.json` 有该操作记录则删除，再启动
   profile。

## pending-removal 记录

记录存续到「包不在 manifest 且条目不在 loader 树」为止。每次启动，
插件幂等地清理已落定记录及其受管行。若记录卡住：检查依赖是否被
重新加入，或同 id 条目是否仍存在。

## 保证

- 插件卸载自身时不会删除恢复数据（只删自己的包）。
- 操作写入与回滚之间的外部修改永不被覆盖（hash-guard 还原）。
