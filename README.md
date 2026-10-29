# dsh-brain-kit

> **你的 AI 准备改这份文档时，先问过它有没有权限吗？**

[DSH](https://github.com/deepseek-ai) 插件。给模型一个 `brain_write` 工具，用来改写 `README.md` / `METHODOLOGY.md` 这类知识库文件。

**权限够就写进去，不够就给你一份能直接粘贴的替换稿 —— 绝不假装写过。**

它解决一个很具体的问题：**同一份代码，在开发机（全盘权限）和用户机（受限沙箱）上的行为必须一致地体面**。权限不够时不能崩、不能静默失败、更不能让模型无限重试。

---

## ⚠️ 适用范围与边界（发版前必读）

- 本插件的文件写入发生在 **DSH 宿主进程**内，**不受会话级沙箱（`workspace-write`）约束**。
- 它自带的分级（L0 / L1 / L2）判断的是**操作系统给宿主进程的权限**，**不是 DSH 的会话权限模式**。因此在默认 `workspace-write` 的机器上，它通常被判成 **L2 并直接写盘**。
- 如果你需要严格沙箱隔离，**不要在需要隔离的环境里启用本插件**。
- 想让分级真正对齐宿主策略，见 Roadmap 里的 0.1.1 项（改为读取 DSH 的 `permission` 服务）。

---
## ✋ 首次安装防呆指南（务必先读这一段）

> **装好之后，请先把 `policy` 设为 `force-l1` 跑一轮，确认行为符合预期，再改回 `auto`。**
>
> 一上来就全权放行，等于让一个刚认识的程序直接改你的文档。它现在没出过问题，不代表它不会。
>
> 具体做法见下面的 [安装](#安装) 与 [第一次测试](#第一次测试建议-force-l1)。

---

## 一眼看懂

| 你担心的事 | 这个插件怎么处理 |
|---|---|
| 用户机器没有写权限，插件直接崩 | **运行期探测**能力，切成 L0/L1/L2 三档；L1 完全不写盘 |
| 权限不够时模型反复重试、刷屏 | L1 返回 `fallback` + 一段**可直接复制**的完整文本，模型只需原样打印给你 |
| `../../Windows/System32` 这类穿越 | **两道闸**：先在原始字符串上拦 `..`，再在 `realpath` 之后拦真实目标 |
| 工作区里放个指向系统盘的快捷方式 | 用 `fs.realpath` 解析符号链接后再比对，**junction 也挡** |
| 写一半崩了，文件变成半截 | 先备份 → 写 → **读回逐字节校验** → 不一致就回滚 |
| 磁盘满了却被告知「权限不足」 | `ENOSPC/EBUSY` 抛出明确错误，**不降级、不掩盖** |
| 全权模式下插件自己乱来 | 硬编码禁访清单：系统目录 / `.env*` / `.ssh` / `.aws` / `.git/config` / 注册表串 |

---

## 安装

需要：DSH `>= 0.2.0-rc.2 < 0.3.0`、Node `>= 20`。

```bat
:: 1. 装（默认装进 desktop profile）
install.cmd

:: 2. 重启 DSH
::    启动日志里应出现：[brain-kit] permission=L2 (全权) workspace=...
::    工具列表里应出现：brain_write
```

安装脚本做四件事（全部可逆）：

1. 备份 `profiles/<profile>/package.json`
2. 复制插件到 `<DSH_HOME>\plugins\dsh-brain-kit`
3. 在 profile 的 `node_modules\@xie\dsh-brain-kit` 建 junction
4. 往 `package.json` 的 `dependencies` 加 `link:`、往 `dsh.profile.bundles` 注册

不联网、不跑 `npm install`、不写注册表。

### 第一次测试（建议 force-l1）

编辑 `cordis.patch.yml` 里插件条目的 `config.policy`：

```yaml
- insert:
    - id: brain-kit
      name: "dsh-brain-kit"
      config:
        policy: force-l1        # ← 先用这个：只出建议，绝不写盘
```

重启后让模型改一次文档，你应该看到它把**完整内容**打印给你，而不是默默改了文件。确认无误，再改回 `auto`：

```yaml
        policy: auto            # 按真实权限自动分级
```

---

## 卸载（一键回滚）

```bat
uninstall.cmd
```

做三件事：删 junction → 从 `dependencies` 移除 → 从 `bundles` 移除。**插件目录默认保留**（方便你查日志）。

彻底删干净：

```bat
uninstall.cmd -Purge
```

**兜底**：每次安装/卸载都会留一份 `package.json.bak-brainkit-<时间戳>`，出问题直接覆盖回去。

---

## 分级权限

| 档位 | 判定条件 | 行为 |
|---|---|---|
| **L2** 全权 | 工作区可写 **且** 工作区外也可写 | 真写：备份 → 写 → 读回校验 → 失败回滚 |
| **L1** 受限 | 只有工作区可写 | **一个字都不写**，返回 `fallback` + 可复制文本 |
| **L0** 只读 | 工作区都写不进去 | 抛 `ReadonlyError`，由调用方给出只读提示 |

探测方式**不是读配置**，而是真的往目标目录写一个探针文件再删掉 —— 因为环境变量可能为空、可能被别的层覆盖（我们踩过：GUI 启动的进程里 `DSH_PERMISSION_MODE` 是空的）。

探测有两个探针：

- 工作区目录
- 用户主目录（**不用 `%TEMP%`** —— 多数沙箱对 temp 放行，会造成「全盘可写」的误判）

结果缓存 60 秒；**任何一次真实写入失败都会立刻失效缓存重新探测**（权限会在运行中变化）。

---

## 双闸安检

任何写入在动盘之前要过五关：

| # | 规则 | 拦什么 |
|---|---|---|
| 1 | `registry` | `HKLM\…`、`HKCU:…`、`HKEY_LOCAL_MACHINE\…` |
| 2 | `traversal` | 含 `..` 段的路径（相对/绝对都拦） |
| 3 | `system-dir` | `%SystemRoot%`、`Program Files`、`ProgramData`… |
| 4 | `sensitive` | `.env` `.env.local`、`.ssh`、`.aws`、`.gnupg`、`.git/config`、`.git/hooks/**` |
| 5 | `outside-workspace` | 工作区之外的路径（`allowOutside` 可放行） |

其中 1~4 在 **L2 下也照拒**，与权限无关：`allowOutside: true` 只放开第 5 条。

被拦时返回：

```json
{
  "status": "error",
  "code": "FORBIDDEN_PATH",
  "rule": "sensitive",
  "message": "禁止写入：命中敏感路径（文件 .env）"
}
```

---

## 工具 API

### `brain_write`

```json
{
  "name": "brain_write",
  "parameters": {
    "type": "object",
    "properties": {
      "path":    { "type": "string", "description": "工作区内相对路径或绝对路径" },
      "content": { "type": "string", "description": "完整文件内容（整篇覆盖，不是补丁）" },
      "reason":  { "type": "string", "description": "可选：为什么改" }
    },
    "required": ["path", "content"],
    "additionalProperties": false
  }
}
```

**返回（L2 成功）**

```json
{ "status": "written", "path": "...\\README.md", "level": 2, "levelName": "L2",
  "bytes": 4213, "backup": "...\\README.md.bak" }
```

**返回（L1 受限 / 权限掉了）**

```json
{ "status": "fallback", "level": 1, "reason": "权限不足（L1 受限模式）",
  "suggestion": "请输出内容让用户手动复制",
  "block": "目标文件：...\n\n```markdown\n（完整内容）\n```\n\n请把上面的完整内容复制到该文件里。" }
```

`block` 是**排好版、可直接粘贴**的整段文本 —— 模型拿到它，只需要原样打印给你，不需要自己拼格式。

**返回（环境故障）**

```json
{ "status": "error", "code": "disk-full", "message": "写入失败[disk-full]：…" }
```

这类**不会降级**：磁盘满、文件被锁都不是「换个模式」能解决的问题，掩盖它只会让你永远查不到原因。

---

## 配置

`cordis.patch.yml`：

| 键 | 默认 | 说明 |
|---|---|---|
| `policy` | `auto` | `auto` / `force-l0` / `force-l1` / `force-l2` |
| **`workspace`（必填）** | **无默认** | 工作区绝对路径。**不填会回落到 DSH 进程的 cwd——通常是 `…\.dsh\profiles\desktop`，相对路径就落到那儿，不是你的项目目录。** |
| `statePath` | `<workspace>/.dsh-brain-state.json` | 记住「警告过哪个版本」 |
| `warn` | `true` | L2 首次启动打印安全警告 |
| `restrictToWorkspace` | `true` | 只允许写工作区内 |

---

## 兼容性

- **ctx 注册多形态**：`inject(deps, cb)` / `inject(cb)` / `ctx.tools.register` 都支持，全都失败才抛错（附试过哪些）。
- **只用 `node:fs` / `path` / `os`**，不碰任何 `dsh.*` 内部 API —— 那玩意不同 rc 之间改过名。
- 已测：Windows 10/11 + PowerShell 5.1 + DSH `0.2.0-rc.2`。Linux / macOS **未测**（`realpath` 与路径分隔符逻辑是跨平台的，但没有实机验证，请自行评估）。

---

## Roadmap（**尚未实现**，别当已有功能）

- [ ] **0.1.1：默认获取 DSH 的 workspace 服务**（`ctx.get('workspace')`），避免相对路径回落到 profile 目录。0.1.0 期间 `workspace` 必须手工填。
- [ ] **0.1.1：分级改为读取 DSH 的 `permission` 服务**，让 L0/L1/L2 与宿主策略一致，而不是靠写探针猜 OS 权限。
- [ ] **多会话写互斥**：两个 DSH 会话同时改同一份文档时，目前没有锁，后写的会覆盖先写的。计划用 `.lock` 文件 + 乐观锁。
- [ ] **知识库自检**：检查引用是否悬空、条目是否过期。目前靠人工/外部流程。
- [ ] **异步写入队列**：`safeWriteAsync` 现在只是同步版的别名。

想要哪条，开 issue 喊一声。

---

## 开发

```bat
node test/smoke.mjs
```

冒烟测试覆盖 64 个用例：权限三态、探针三态、写入回滚、errno 分流、符号链接穿越、ctx 形态兼容。**改代码前先跑一遍，改完再跑一遍。**

---

## License

[MIT](LICENSE)
