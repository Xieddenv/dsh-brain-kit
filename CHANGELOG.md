# Changelog

本文件记录所有值得注意的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.3] - 2026-10-30

### 修复

- **锚点匹配不再被 CRLF 打穿**：匹配前把 `\r\n` 归一化为 `\n`，命中后用下标映射换回**原文坐标**，只替换那一段；文件其余部分的行尾保持原样。此前 Windows 上的文件（CRLF）遇到模型给的 LF 锚点会直接 `ANCHOR_NOT_FOUND`。
- **备份不再互相覆盖**：`<file>.bak` 改为 `<file>.bak-YYYYMMDD-HHMMSS`；同一秒内的第二次写入自动追加 `-2`、`-3`。此前连续两次写入会把上一份 `.bak` 冲掉，等于没有历史。

### 变更

- README 定位从「知识库文档」放宽为「工作区内的**任意文本文件**」。
- 全文「权限自适应」改称「**OS 权限探测**」，并新增「⚠️ 这是什么，不是什么」免责声明：明确写入发生在宿主进程内、不受会话沙箱约束。
- `brain_write` 的工具描述同步放宽，不再自我限定为知识库。

### 新增

- `CHANGELOG.md`（本文件）。
- GitHub Actions CI：`windows-latest` × Node 20/22，跑 `node test/smoke.mjs`。

## [0.1.2] - 2026-10-30

### 新增

- `brain_write` 支持 **`anchor` + `replacement` 锚点替换**（与 `content` 整篇覆盖二选一）。anchor 出现 0 次或多次都会拒绝写入，不猜。
- **`expectedSha256` 乐观锁**：读到文件之后若被改过，返回 `status: conflict`（含 `expected` / `actual`），一个字节都不写。
- **`scaffold` 配置项**（默认 `false`）：工作区缺 `README.md` / `METHODOLOGY.md` 时补一份空骨架，**只补缺，绝不覆盖**已有文件。

### 修复

- **`VERSION` 双源漂移**：不再手写，改为启动时从 `package.json` 读取。此前 `index.js` 里的版本号停在 `0.0.2`，导致 L2 安全警告的「按版本去重」永远命中，升级后用户看不到警告。
- **`workspace` 未配置时静默写错地方**：现在启动即打印醒目警告，并在返回值里带 `workspaceConfigured: false`。此前会静默回落到 DSH 进程的 cwd（通常是 `…\.dsh\profiles\desktop`）。

## [0.1.1] - 2026-10-30

### 变更

- README 与 npm 描述改为宣传语版本（「别让你的 AI 助手变成『拆迁大队』」）。
- README 增加适用范围与边界声明（后续在 0.1.3 重构为「这是什么，不是什么」）。

## [0.1.0] - 2026-10-29

### 新增

- 首次发布。
- `brain_write` 工具：L0 / L1 / L2 三档，L1 完全不落盘、改回一段可直接粘贴的替换稿。
- 双闸路径检查：原始串查 `..` 穿越与注册表特征，再用 `realpath` 比对（指向系统目录的 junction 也拦得住）。
- 写入前备份 → 写入 → 逐字节读回校验 → 不一致自动回滚。
- errno 分流：`EACCES`/`EPERM` 降级并重新探测；`ENOSPC`/`EBUSY` 直接报错，不伪装成权限问题。
- L2 首次启动的安全警告（按版本去重）。
