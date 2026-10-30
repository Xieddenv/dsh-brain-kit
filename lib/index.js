/**
 * index.js —— dsh-brain-kit 入口
 *
 * 职责：
 *   1. init 时探测权限（L0/L1/L2）并打一行日志
 *   2. L2 首次启动打印安全警告（按版本去重，写 .dsh-brain-state.json）
 *   3. 把 safeWrite 包装成工具暴露给模型
 *
 * 设计红线：
 *   - 返回体里**绝不能出现值为 undefined 的属性**（BUG-004 的教训：
 *     JSON 往返会丢 key → 宿主判「not lossless JSON」→ 整个结果作废）。
 *   - 降级不静默：L1 的 fallback 必须原样回到模型手里。
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { detectSync, LEVEL, LEVEL_NAME, summary as permSummary } from './permission.js';
import { safeWrite, ReadonlyError, WriteError, WRITE_STATUS } from './writer.js';
import { check, isInside } from './guard.js';

export { isInside };

// cordis 插件契约（与 dsh-memory-kit / dsh-gui-url / dshmarket 一致）：
//   export const name   —— loader 靠它登记插件
//   export const inject —— 声明要注入的服务；不声明就直接碰 ctx.tools 会抛
//   export function apply(ctx, config)
export const name = 'dsh-brain-kit';
export const PLUGIN_NAME = name;
export const inject = ['tools'];
function readOwnVersion() {
  try {
    const url = new URL('../package.json', import.meta.url);
    return String(JSON.parse(fs.readFileSync(url, 'utf8')).version);
  } catch { return '0.0.0'; }
}
export const VERSION = readOwnVersion();
export const TOOL_NAME = 'brain_write';

const TARGET_HINT = 'README 或 METHODOLOGY';

/** 工具说明：模型看的就是这段，必须把「别重试」写进去 */
export const TOOL_DESCRIPTION = [
  `安全写入工作区里的文本文件（典型目标：${TARGET_HINT}.md，但不限于此）。`,
  '',
  '何时用：需要修改 README.md 或 METHODOLOGY.md 时调用本工具，不要在对话里直接吐整篇文档。',
  '',
  '两种改法（优先用第一种）：',
  '  · 锚点替换：anchor=<原文里一小段唯一文本> + replacement=<新文本>，只改那一处；',
  '  · 整篇覆盖：content=<完整文件内容>。只在确实要重写全文时用。',
  '  同一文件可能被别人（另一个会话/编辑器）改过，动手前请带上 expectedSha256 —— 不匹配会返回 conflict 而不是覆盖。',
  '',
  '⚠ 拿到 fallback 状态时的正确动作：',
  '把返回结果里的 block 字段**原样打印**给用户，让用户手动复制落盘。',
  '**不要自己重试、不要换个路径再试、不要试图绕过**——重试只会浪费轮次，权限不会因为重试而变好。',
  '',
  '拿不到 fallback 但报 error（disk-full / busy）时：如实告诉用户具体原因，这属于环境故障，不是权限问题。',
].join('\n');

/** 工具参数 Schema —— 尽量窄，减少模型乱填 */
export const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: '目标文件：工作区内的相对路径（如 "README.md"）或绝对路径。默认只允许工作区内。',
    },
    anchor: {
      type: 'string',
      description: '要在文件里定位的那一小段**唯一**文本（原文照抄）。与 replacement 配对使用，只替换这一处；出现 0 次或多次都会拒绝写入。',
    },
    replacement: {
      type: 'string',
      description: '用 anchor 定位后，替换成的新文本。',
    },
    content: {
      type: 'string',
      description: '整篇覆盖时用：**完整**文件内容。与 anchor 二选一；能锚点替换就不要整篇覆盖。',
    },
    expectedSha256: {
      type: 'string',
      description: '可选但强烈建议：你读到文件时的 sha256（小写十六进制）。与磁盘现状不符则返回 status=conflict，不覆盖。用于防多会话互相踩踏。',
    },
    reason: {
      type: 'string',
      description: '可选：一句话说明为什么改（会写进返回体的 note，便于事后审计）。',
    },
  },
  required: ['path'],
  additionalProperties: false,
};

/** 工具返回 Schema（additionalProperties 放开，但实现保证没有 undefined 值） */
export const TOOL_OUTPUT = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['written', 'fallback', 'error', 'conflict'] },
    mode: { type: 'string', enum: ['anchor', 'full'] },
    sha256: { type: 'string' },
    expected: { type: 'string' },
    actual: { type: 'string' },
    path: { type: 'string' },
    level: { type: 'integer' },
    levelName: { type: 'string' },
    bytes: { type: 'integer' },
    backup: { type: 'string' },
    reason: { type: 'string' },
    suggestion: { type: 'string' },
    block: { type: 'string' },
    code: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['status'],
  additionalProperties: true,
};

const SCAFFOLD_FILES = [
  ['README.md', [
    '# 项目说明',
    '',
    '> 由 dsh-brain-kit 生成的空骨架，随便改。',
    '',
    '## 这是什么',
    '',
    '（一句话说清项目干什么）',
    '',
    '## 怎么跑',
    '',
    '```bash',
    '# 命令写这里',
    '```',
    '',
    '## 变更记录',
    '',
    '| 日期 | 改动 |',
    '|---|---|',
    '|     |     |',
    '',
  ].join('\n')],
  ['METHODOLOGY.md', [
    '# 方法论',
    '',
    '> 由 dsh-brain-kit 生成的空骨架，随便改。',
    '',
    '## 条目格式',
    '',
    '- **方法名称**：',
    '- **适用场景**：',
    '- **具体操作步骤**：',
    '- **作用与目的**：',
    '',
  ].join('\n')],
];

const WARNING_LINES = [
  '',
  '  ============================================================',
  '  ⚠  dsh-brain-kit 已启用「完全访问」模式（L2 / danger-full-access）',
  '  ------------------------------------------------------------',
  '  · 插件可以直接改写工作区内的文件，没有沙箱兜底。',
  '  · 请勿在会话中执行来历不明的代码、粘贴不明来源的命令。',
  '  · 插件内部已禁止触碰 Windows / Program Files / .ssh 等目录，',
  '    但这条红线只约束本插件，约束不了别的程序。',
  '  · 本提示每个版本只显示一次（当前 v' + VERSION + '）。',
  '  ============================================================',
  '',
];

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * 把 CRLF 折成 LF，同时记录「归一化下标 → 原文下标」，用于把命中位置换回原文坐标。
 * 不能直接对全文做 replace：那会把文件里所有行尾都改掉。
 */
export function normalizeWithMap(text) {
  const src = String(text ?? '');
  let norm = '';
  const map = [];
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] === '\r' && src[i + 1] === '\n') { norm += '\n'; map.push(i); i += 1; }
    else { norm += src[i]; map.push(i); }
  }
  map.push(src.length);
  return { norm, map };
}

/**
 * 在原文里定位 anchor，容忍 CRLF / LF 差异。
 * 返回 { count, start, end }，start/end 是**原文**坐标。
 */
export function locateAnchor(original, anchor) {
  const { norm, map } = normalizeWithMap(original);
  const { norm: needle } = normalizeWithMap(anchor);
  if (!needle) return { count: 0, start: -1, end: -1 };
  let count = 0;
  let first = -1;
  let idx = norm.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    if (first < 0) first = idx;
    idx = norm.indexOf(needle, idx + needle.length);
  }
  if (count === 0) return { count: 0, start: -1, end: -1 };
  return { count, start: map[first], end: map[first + needle.length] };
}

function logSafe(logger, level, msg) {
  try {
    if (typeof logger?.[level] === 'function') logger[level](msg);
    else if (level === 'warn') console.warn(msg);
    else console.log(msg);
  } catch { /* 日志失败不能影响主流程 */ }
}

function readState(statePath) {
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function writeState(statePath, obj) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(obj, null, 2), 'utf8');
  } catch { /* 状态文件写不进去不影响功能 */ }
}

/**
 * 构造工具定义。独立导出，便于测试直接调用 execute。
 */
export function createTool({ workspace, policy, logger, restrictToWorkspace = true } = {}) {
  const ws = path.resolve(workspace ?? process.cwd());

  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    output: {
      schema: TOOL_OUTPUT,
      render: (_args, v) => [{
        type: 'text',
        text: v?.status === 'written'
          ? `brain_write: 已写入 ${v.path}（${v.mode === 'anchor' ? '锚点替换' : '整篇覆盖'}，${v.bytes} 字节${v.backup ? '，已备份' : ''}）`
          : v?.status === 'fallback'
            ? v.block
            : v?.status === 'conflict'
              ? `brain_write 冲突：文件已被改动（expected ${v?.expected} / actual ${v?.actual}），未写入`
              : `brain_write error[${v?.code}]: ${v?.message}`,
      }],
    },

    execute(args = {}) {
      const rawPath = String(args.path ?? '').trim();
      if (!rawPath) {
        return { status: 'error', code: 'BAD_ARGS', message: 'path 不能为空' };
      }

      // 唯一安检门：所有路径判定都在 guard.js 里，index 不再自带一套
      const gate = check(rawPath, { workspace: ws, allowOutside: restrictToWorkspace === false });
      if (!gate.ok) {
        logSafe(logger, 'warn', `[${PLUGIN_NAME}] 拦截写入：${gate.rule} ← ${rawPath}`);
        return {
          status: 'error',
          code: gate.code,
          rule: gate.rule,
          path: gate.path,
          message: `禁止写入：${gate.reason}`,
        };
      }
      const target = gate.resolved;

      // 读现状：锚点替换与乐观锁都要用
      let before = null;
      try { before = fs.readFileSync(target, 'utf8'); } catch { before = null; }
      const beforeSha = before === null ? null : sha256(before);

      // 乐观锁：期望哈希不符 → conflict，绝不覆盖
      if (args.expectedSha256) {
        const want = String(args.expectedSha256).trim().toLowerCase();
        if (beforeSha !== want) {
          return {
            status: 'conflict',
            path: target,
            expected: want,
            actual: beforeSha ?? 'missing',
            message: '文件在你读取后被改过（或根本不存在），已放弃写入。请重新读取后再试。',
          };
        }
      }

      // 二选一：锚点替换（优先）或整篇覆盖
      let payload;
      let mode;
      if (typeof args.anchor === 'string' && args.anchor.length > 0) {
        if (typeof args.replacement !== 'string') {
          return { status: 'error', code: 'BAD_ARGS', message: '用 anchor 时必须同时给 replacement' };
        }
        if (before === null) {
          return { status: 'error', code: 'NOT_FOUND', path: target, message: '锚点替换要求文件已存在；新建文件请用 content' };
        }
        // 容忍 CRLF/LF 差异：归一化后再匹配，命中位置换回原文坐标，只替换那一段
        const hit = locateAnchor(before, args.anchor);
        if (hit.count === 0) {
          return { status: 'error', code: 'ANCHOR_NOT_FOUND', path: target, message: '文件里找不到 anchor，内容未改动' };
        }
        if (hit.count > 1) {
          return { status: 'error', code: 'ANCHOR_AMBIGUOUS', path: target, message: `anchor 出现 ${hit.count} 次，不唯一，内容未改动` };
        }
        payload = before.slice(0, hit.start) + args.replacement + before.slice(hit.end);
        mode = 'anchor';
      } else if (typeof args.content === 'string') {
        payload = args.content;
        mode = 'full';
      } else {
        return { status: 'error', code: 'BAD_ARGS', message: '二选一：anchor+replacement（锚点替换）或 content（整篇覆盖）' };
      }

      try {
        const r = safeWrite(target, payload, { workspace: ws, policy });
        const out = {
          status: r.status,
          mode,
          path: r.path,
          level: r.level,
          levelName: r.levelName,
        };
        if (r.status === WRITE_STATUS.WRITTEN) {
          out.bytes = r.bytes;
          out.sha256 = sha256(payload);
          if (r.backup) out.backup = String(r.backup);
        } else {
          out.reason = r.reason;
          out.suggestion = r.suggestion;
          out.block = r.block;
        }
        if (args.reason) out.note = String(args.reason);
        return out;
      } catch (err) {
        if (err instanceof ReadonlyError) {
          return { status: 'error', code: 'EREADONLY', path: target, message: err.message };
        }
        if (err instanceof WriteError) {
          const out = { status: 'error', code: err.kind ?? 'WRITE', path: target, message: err.message };
          if (err.code) out.sysCode = err.code;
          return out;
        }
        return { status: 'error', code: 'UNKNOWN', path: target, message: String(err?.message ?? err) };
      }
    },
  };
}

/**
 * 注册工具，兼容几种 ctx 形态（不同 DSH 版本 / 不同加载路径的签名不完全一样）：
 *   A. ctx.inject(['tools'], cb)    ← dsh-dot-life 用这种
 *   B. ctx.inject(cb)               ← 单参版本
 *   C. ctx.tools.register(def)      ← 已经拿在手里
 *   D. cb 里给的 scope 可能带 effect()，也可能不带
 * 全都不成 → 抛错并列出试过什么，不静默失败。
 */
export function registerTool(ctx, tool) {
  const attempts = [];

  const attach = (host) => {
    if (!host || !host.tools || typeof host.tools.register !== 'function') return false;
    const run = () => { host.tools.register(tool); };
    if (typeof host.effect === 'function') {
      // cordis 的 effect 要求回调返回 disposer 或 undefined；
      // 返回 boolean 会抛 "TypeError: Invalid effect"（已踩）。
      host.effect(run);
      return true;
    }
    run();
    return true;
  };

  const inject = ctx?.inject;
  if (typeof inject === 'function') {
    // A. inject(deps, cb)
    try {
      let ok = false;
      inject.call(ctx, ['tools'], (scope) => { ok = attach(scope ?? ctx) || ok; });
      if (ok) return 'inject(deps, cb)';
      attempts.push('inject(deps, cb): 回调里没有 tools.register');
    } catch (err) {
      attempts.push(`inject(deps, cb): ${err?.message ?? err}`);
    }
    // B. inject(cb)
    try {
      let ok = false;
      const ret = inject.call(ctx, (scope) => { ok = attach(scope ?? ctx) || ok; });
      if (ok) return 'inject(cb)';
      if (ret && typeof ret.tools?.register === 'function') { attach(ret); return 'inject → scope'; }
      attempts.push('inject(cb): 回调里没有 tools.register');
    } catch (err) {
      attempts.push(`inject(cb): ${err?.message ?? err}`);
    }
  }

  // C. 直接挂在 ctx 上
  if (ctx?.tools && typeof ctx.tools.register === 'function') {
    attach(ctx);
    return 'ctx.tools.register';
  }

  throw new Error(`[brain-kit] 无法注册工具：${attempts.length ? attempts.join('; ') : 'ctx 上没有任何可用的注册入口'}`);
}

/**
 * 自诊断：把「模块被加载 / apply 进入 / apply 抛错」写进一个临时文件。
 * 宿主把插件错误吞掉时，这是唯一能拿到现场的地方。
 * 路径用系统临时目录，不写死任何私人路径。
 */
const DIAG_PATH = path.join(process.env.TEMP || os.tmpdir(), 'dsh-brain-kit-load.log');
export function diag(line) {
  try { fs.appendFileSync(DIAG_PATH, `[${new Date().toISOString()}] ${line}\n`); } catch { /* 诊断失败不能影响主流程 */ }
}
diag(`module loaded: name=${name} version=${VERSION} node=${process.version} cwd=${process.cwd()}`);

/**
 * DSH 插件入口（真正干活的那个；外面包了一层 apply 只负责记录异常）。
 * @param {object} ctx   dsh 上下文（测试里用假对象）
 * @param {object} [config]
 * @param {string} [config.policy]      auto | force-l0 | force-l1 | force-l2
 * @param {string} [config.workspace]   工作区，默认 process.cwd()
 * @param {string} [config.statePath]   状态文件，默认 <workspace>/.dsh-brain-state.json
 * @param {boolean} [config.warn=true]  L2 首次是否打印警告
 */
function applyUnsafe(ctx, config = {}) {
  diag(`apply start (ctx keys: ${Object.keys(ctx ?? {}).slice(0, 12).join(',')})`);
  const logger = typeof ctx?.logger === 'function' ? ctx.logger(PLUGIN_NAME) : null;
  // 空字符串一律当「没配」——YAML 里留空就是 ''，不能把它当路径
  const pick = (v) => (v === undefined || v === null || v === '' ? undefined : v);
  const workspaceConfigured = pick(config.workspace) !== undefined;
  const workspace = path.resolve(pick(config.workspace) ?? process.cwd());
  const policy = pick(config.policy) ?? 'auto';
  const statePath = path.resolve(
    pick(config.statePath) ?? path.join(workspace, '.dsh-brain-state.json'),
  );

  // ── 1. 探测 + 日志 ──
  let perm;
  try {
    perm = detectSync({ workspace, policy, ttlMs: 0 });
  } catch (err) {
    perm = { level: LEVEL.READONLY, name: LEVEL_NAME[LEVEL.READONLY], workspace, probes: {}, source: 'error' };
    logSafe(logger, 'warn', `权限探测失败，按只读处理：${err?.message ?? err}`);
  }
  logSafe(logger, 'info', `[${PLUGIN_NAME}] ${permSummary(perm)}`);
  if (!workspaceConfigured) {
    logSafe(logger, 'warn',
      `[${PLUGIN_NAME}] ⚠ config.workspace 未配置，回落到进程当前目录：${workspace}` +
      '（通常是 …\\.dsh\\profiles\\desktop）。相对路径会写到那里，不是你的项目目录。请在 cordis.patch.yml 里显式指定 workspace。');
  }

  // ── 2. L2 首次安全警告 ──
  if (perm.level === LEVEL.FULL && config.warn !== false) {
    const state = readState(statePath);
    if (state.lastWarnedVersion !== VERSION) {
      const text = WARNING_LINES.join('\n');
      logSafe(logger, 'warn', text);
      try { if (typeof console?.warn === 'function') console.warn(text); } catch { /* noop */ }
      state.lastWarnedVersion = VERSION;
      state.lastWarnedAt = new Date().toISOString();
      state.lastLevel = perm.level;
      writeState(statePath, state);
    }
  } else if (perm.level !== LEVEL.FULL) {
    const state = readState(statePath);
    if (state.lastLevel !== perm.level) {
      state.lastLevel = perm.level;
      state.lastLevelAt = new Date().toISOString();
      writeState(statePath, state);
    }
  }

  // ── 2.5 可选骨架（config.scaffold = true 才做；只补缺，绝不覆盖）──
  const scaffolded = [];
  if (config.scaffold === true && perm.level === LEVEL.FULL) {
    for (const [file, body] of SCAFFOLD_FILES) {
      const full = path.join(workspace, file);
      if (fs.existsSync(full)) continue;
      try {
        const r = safeWrite(full, body, { workspace, policy });
        if (r.status === WRITE_STATUS.WRITTEN) scaffolded.push(file);
      } catch (err) {
        logSafe(logger, 'warn', `[${PLUGIN_NAME}] 建骨架失败 ${file}：${err?.message ?? err}`);
      }
    }
    if (scaffolded.length) logSafe(logger, 'info', `[${PLUGIN_NAME}] 已补空骨架：${scaffolded.join(', ')}`);
  }

  // ── 3. 注册工具（多形态兼容）──
  const tool = createTool({
    workspace,
    policy,
    logger,
    restrictToWorkspace: config.restrictToWorkspace !== false,
  });

  const how = registerTool(ctx, tool);
  logSafe(logger, 'info', `[${PLUGIN_NAME}] 工具注册方式：${how}`);

  return { level: perm.level, levelName: perm.name, tool: TOOL_NAME, workspace, workspaceConfigured, statePath, registeredVia: how, scaffolded };
}

/** 对外入口：只负责记录异常，然后原样抛给宿主 */
export function apply(ctx, config = {}) {
  try {
    const r = applyUnsafe(ctx, config);
    diag(`apply ok: level=${r?.level} via=${r?.registeredVia}`);
    return r;
  } catch (err) {
    diag(`apply FAILED: ${err?.stack ?? err}`);
    throw err;
  }
}

