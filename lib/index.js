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
export const VERSION = '0.0.2';
export const TOOL_NAME = 'brain_write';

const TARGET_HINT = 'README 或 METHODOLOGY';

/** 工具说明：模型看的就是这段，必须把「别重试」写进去 */
export const TOOL_DESCRIPTION = [
  `写入工作区里的知识库文件（典型目标：${TARGET_HINT}.md）。`,
  '',
  '何时用：需要修改 README.md 或 METHODOLOGY.md 时调用本工具，不要在对话里直接吐整篇文档。',
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
    content: {
      type: 'string',
      description: '要写入的**完整**文件内容（整篇覆盖，不是补丁）。请自己保证内容完整、可直接落盘。',
    },
    reason: {
      type: 'string',
      description: '可选：一句话说明为什么改（会写进返回体的 note，便于事后审计）。',
    },
  },
  required: ['path', 'content'],
  additionalProperties: false,
};

/** 工具返回 Schema（additionalProperties 放开，但实现保证没有 undefined 值） */
export const TOOL_OUTPUT = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['written', 'fallback', 'error'] },
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
          ? `brain_write: 已写入 ${v.path}（${v.bytes} 字节${v.backup ? '，已备份' : ''}）`
          : v?.status === 'fallback'
            ? v.block
            : `brain_write error[${v?.code}]: ${v?.message}`,
      }],
    },

    execute(args = {}) {
      const rawPath = String(args.path ?? '').trim();
      if (!rawPath) {
        return { status: 'error', code: 'BAD_ARGS', message: 'path 不能为空' };
      }
      if (typeof args.content !== 'string') {
        return { status: 'error', code: 'BAD_ARGS', message: 'content 必须是字符串' };
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

      try {
        const r = safeWrite(target, args.content, { workspace: ws, policy });
        const out = {
          status: r.status,
          path: r.path,
          level: r.level,
          levelName: r.levelName,
        };
        if (r.status === WRITE_STATUS.WRITTEN) {
          out.bytes = r.bytes;
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

  // ── 3. 注册工具（多形态兼容）──
  const tool = createTool({
    workspace,
    policy,
    logger,
    restrictToWorkspace: config.restrictToWorkspace !== false,
  });

  const how = registerTool(ctx, tool);
  logSafe(logger, 'info', `[${PLUGIN_NAME}] 工具注册方式：${how}`);

  return { level: perm.level, levelName: perm.name, tool: TOOL_NAME, workspace, statePath, registeredVia: how };
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

