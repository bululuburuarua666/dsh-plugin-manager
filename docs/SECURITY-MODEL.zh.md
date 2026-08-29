# 安全模型 — DSH 插件管理器

特权边界如何在单页内说清。本文为中文对照版；英文参考见
[SECURITY-MODEL.md](./SECURITY-MODEL.md)。

## 威胁模型

本插件可以：改写 profile 的 `cordis.patch.yml`、移除 npm 依赖、在
Host 进程内调用 pnpm。本模型回答三个问题：

1. 谁能触达这些能力？
2. 恶意请求能夹带什么？
3. 变更中途失败会怎样？

## 1. 网络边界 —— 仅 loopback

发往 `/dsh-plugin-manager` 的每个请求都先过**官方 DSH Host 信任栅栏**
（loopback authority 即空信任表 + `isTrustedApiRequest`），*然后*才进入
插件代码。实测结论：

| 请求形态 | 结果 |
|---|---|
| loopback 客户端、POST、JSON | 200 → 进入处理器 |
| 伪造 `Host` 头 | 403，处理器零调用 |
| 跨站 `Origin` + `Sec-Fetch-Site` | 403，处理器零调用 |
| 错误 Content-Type | 415 |
| 坏 JSON | 400 |

本插件从不复刻信任判定，因此也无法削弱它。

## 2. 载荷闸门 —— 全部 fail-closed

- 未知端点 → `ENDPOINT_UNKNOWN`。
- 未知字段 → `REQUEST_INVALID`（strict zod，无透传）。
- `protocolVersion` 不符 → `REQUEST_INVALID`；版本不匹配的成功响应在
  客户端判 `INCOMPATIBLE`。
- 任意 JSON 值超过 64 KiB（UTF-8 字节）→ `REQUEST_TOO_LARGE`。
- 入口前已取消 → `CANCELLED`；确认后的 `execute` 不受调用方取消影响
  （不存在半途事务）。

浏览器只提交 `entryId` + `action`（来源覆盖端点额外提交分类字段与
revision）；所有路径、包名、命令都在 Host 侧重新推导。

## 3. 卸载授权 —— 六道闸全过才放行

一个条目可卸载，当且仅当：

1. 部署为 `writable`（全接口绑定 ⇒ 只读）。
2. 包是 profile manifest 的**直接依赖**。
3. 解析自 **profile 自身 node_modules**（受信索引根）；引擎根解析判
   `engine-owned`，未索引回退判 `ambiguous-package`——两者都拒绝。
4. 其 `package.json` 的 `name` 与声明精确一致。
5. 不在保护清单内（引擎关键包 + 管理器自身）。
6. 不是模板 bundle 成员。

任何不确定都按拒绝处理。

## 4. 来源覆盖写入 —— 只碰展示分类

`originState` / `originUpdate` 两个端点维护 `plugin-origins.json`：

- 覆盖以**稳定包名**为键；包名由 Host 从 `entryId` 重新推导，浏览器
  永远不提交裸包名。`cordis:` 内建与不可解析条目拒绝编辑
  （`ORIGIN_UNAVAILABLE`）。
- 写入管线：跨进程文件锁 → 锁内重读 → revision 冲突检查
  （`ORIGIN_CONFLICT`）→ strict schema 校验 → 原子写 → 写后校验。
- 已存在的损坏文件**保留原样并报错**（`ORIGIN_FILE_INVALID`），
  绝不替换为空配置。
- 「开源·定制」必须携带定制说明（`ORIGIN_NOTE_REQUIRED`），Host 侧
  强制执行。
- 覆盖**只影响展示与筛选**：`canToggle`、`canUninstall`、engine-owned、
  protected-package 判定均不读取覆盖文件；手动「官方」不获得任何
  官方信任或额外权限。
- 只读部署（全接口绑定）拒绝 `originUpdate`（`READ_ONLY_REMOTE`）。

## 5. 事务语义

`preview → execute → operation`：

- 一次性 CSPRNG token（60 秒 TTL），绑定动作 + 条目 + 证据 revision。
- 每 profile 串行队列：前一操作落定后一操作才启动，且出队时重验
  证据（漂移判 `PROFILE_CHANGED`）。
- 停用/启用：跨进程文件锁下改写受管块；失败时**仅当文件哈希仍是
  本操作的 after-image** 才还原 before-image——外部修改永不覆盖。
- 卸载：SHA-256 备份清单 → 补丁停用+splice → fiber 释放 → 无 shell
  pnpm → 仅目标链接移除 → 后置校验 → hash-guard 回滚；删不掉的写入
  pending-removal 记录，下次启动幂等清账。

## 6. 诊断卫生

跨线错误只带码与净化消息——无路径、无堆栈、无环境信息。服务端诊断
只记错误类名与端点，不记载荷。

## 恢复

- 每次卸载先备份全部被触文件；见 [RECOVERY.zh.md](./RECOVERY.zh.md)。
- `ROLLBACK_INCOMPLETE` 表示还原写本身失败：备份目录存有变更前镜像，
  可手工恢复。
