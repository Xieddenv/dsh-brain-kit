/**
 * test/smoke.mjs —— dsh-brain-kit 冒烟测试（permission / writer / index / guard）
 *
 * 跑法：node test/smoke.mjs
 * 判据：全部用例通过 → exit 0；任何一条失败 → exit 1（方便串进 CI / 后续步骤）。
 */

import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import { readdirSync, readFileSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  LEVEL, LEVEL_NAME, classify, probeDirSync, probeDir,
  parsePolicy, levelFrom, detectSync, detect, current, invalidate, summary,
} from '../lib/permission.js';
import { safeWrite, classifyWriteError, WRITE_STATUS, WriteError, ReadonlyError } from '../lib/writer.js';
import {
  check, FORBIDDEN_CODE, containsTraversal, realpathLoose, systemRoots,
} from '../lib/guard.js';
import {
  apply, createTool, isInside, TOOL_NAME, TOOL_PARAMETERS, TOOL_OUTPUT, TOOL_DESCRIPTION, VERSION,
} from '../lib/index.js';
import * as pluginModule from '../lib/index.js';

let pass = 0;
let fail = 0;
const results = [];

async function t(name, fn) {
  try {
    await fn();
    pass += 1;
    results.push(`  ✔ ${name}`);
  } catch (err) {
    fail += 1;
    results.push(`  ✘ ${name}\n      ${String(err.message).split('\n')[0]}`);
  }
}

// ── 1. errno 分类 ───────────────────────────────────────────────
await t('classify: EACCES / EPERM → denied', () => {
  assert.equal(classify({ code: 'EACCES' }), 'denied');
  assert.equal(classify({ code: 'EPERM' }), 'denied');
});
await t('classify: ENOENT → missing', () => assert.equal(classify({ code: 'ENOENT' }), 'missing'));
await t('classify: EROFS → readonly', () => assert.equal(classify({ code: 'EROFS' }), 'readonly'));
await t('classify: 未知码带前缀', () => assert.equal(classify({ code: 'EWHATEVER' }), 'unknown:EWHATEVER'));

// ── 2. 探针三态 ────────────────────────────────────────────────
await t('probeDirSync: 当前目录 → ok', () => {
  assert.equal(probeDirSync(process.cwd()), 'ok');
});
await t('probeDirSync: 不存在的目录 → missing', () => {
  const ghost = path.join(os.tmpdir(), `no-such-dir-${Date.now()}`);
  assert.equal(probeDirSync(ghost), 'missing');
});
await t('probeDirSync: C:\\Windows\\System32 → 不可写', () => {
  const r = probeDirSync('C:\\Windows\\System32');
  assert.notEqual(r, 'ok', 'System32 竟然可写：你可能以管理员运行，或沙箱已放开');
});
await t('probeDir (async) 与同步版一致', async () => {
  assert.equal(await probeDir(process.cwd()), 'ok');
});

// ── 3. 探针不留垃圾 ────────────────────────────────────────────
await t('探针文件用后即删', () => {
  probeDirSync(process.cwd());
  const stray = readdirSync(process.cwd()).filter((n) => n.startsWith('.brain-probe-'));
  assert.deepEqual(stray, [], `残留探针文件：${stray.join(', ')}`);
});

// ── 4. 档位推断 ────────────────────────────────────────────────
await t('levelFrom: 工作区可写 + 越界可写 → L2', () => assert.equal(levelFrom('ok', 'ok'), LEVEL.FULL));
await t('levelFrom: 只有工作区可写 → L1', () => assert.equal(levelFrom('ok', 'denied'), LEVEL.WORKSPACE));
await t('levelFrom: 工作区不可写 → L0', () => assert.equal(levelFrom('denied', 'ok'), LEVEL.READONLY));
await t('LEVEL_NAME 自洽', () => {
  assert.equal(LEVEL_NAME[0], 'L0');
  assert.equal(LEVEL_NAME[1], 'L1');
  assert.equal(LEVEL_NAME[2], 'L2');
});

// ── 5. policy 覆盖 ────────────────────────────────────────────
await t('parsePolicy: 别名归一', () => {
  assert.equal(parsePolicy('force-l1'), LEVEL.WORKSPACE);
  assert.equal(parsePolicy('FULL'), LEVEL.FULL);
  assert.equal(parsePolicy('auto'), null);
  assert.equal(parsePolicy('胡说八道'), null);
});
await t('policy 优先于探测', () => {
  const r = detectSync({ policy: 'force-l1', ttlMs: 0 });
  assert.equal(r.level, LEVEL.WORKSPACE);
  assert.equal(r.source, 'policy');
  assert.equal(r.probes.workspace, 'skipped');
});

// ── 6. 端到端 ─────────────────────────────────────────────────
await t('detectSync 返回完整结构', () => {
  invalidate();
  const r = detectSync({ ttlMs: 0 });
  assert.ok([0, 1, 2].includes(r.level));
  assert.match(r.name, /^L[012]$/);
  assert.equal(typeof r.workspace, 'string');
  assert.ok(r.probes.workspace);
  assert.equal(typeof r.took, 'number');
  assert.equal(typeof r.at, 'number');
});
await t('detectSync 缓存命中', () => {
  const a = detectSync({ ttlMs: 60_000 });
  const b = current();
  assert.ok(b, 'current() 应返回缓存');
  assert.equal(a.at, b.at);
});
await t('invalidate 清缓存', () => {
  invalidate();
  assert.equal(current(), null);
});
await t('detect (async) 端到端', async () => {
  invalidate();
  const r = await detect({ ttlMs: 0 });
  assert.ok([0, 1, 2].includes(r.level));
});
await t('summary 可读', () => {
  const s = summary(detectSync({ policy: 'force-l2', ttlMs: 0 }));
  assert.match(s, /permission=L2/);
});

// ── 7. writer.js：分级写入 ────────────────────────────────────
const tmp = mkdtempSync(path.join(os.tmpdir(), 'brain-smoke-'));
const fA = path.join(tmp, 'doc.md');

await t('L2: 首次写入成功，不产生 .bak', () => {
  const r = safeWrite(fA, '# v1\n', { level: LEVEL.FULL });
  assert.equal(r.status, WRITE_STATUS.WRITTEN);
  assert.equal(r.backup, null);
  assert.equal(readFileSync(fA, 'utf8'), '# v1\n');
});
await t('L2: 二次写入生成 .bak，且 .bak 是旧版', () => {
  const r = safeWrite(fA, '# v2\n', { level: LEVEL.FULL });
  assert.equal(r.status, WRITE_STATUS.WRITTEN);
  assert.equal(r.backup, fA + '.bak');
  assert.equal(readFileSync(fA + '.bak', 'utf8'), '# v1\n');
  assert.equal(readFileSync(fA, 'utf8'), '# v2\n');
});
await t('L1: 一个字都不写，返回 fallback 结构与建议', () => {
  const f = path.join(tmp, 'l1.md');
  const r = safeWrite(f, '# draft\n', { level: LEVEL.WORKSPACE });
  assert.equal(r.status, WRITE_STATUS.FALLBACK);
  assert.equal(r.level, LEVEL.WORKSPACE);
  assert.match(r.reason, /权限/);
  assert.match(r.suggestion, /手动复制/);
  assert.match(r.block, /# draft/);
  assert.equal(existsSync(f), false, 'L1 绝不允许落盘');
});
await t('L0: 直接抛只读错误', () => {
  assert.throws(
    () => safeWrite(path.join(tmp, 'l0.md'), 'x', { level: LEVEL.READONLY }),
    (e) => e instanceof ReadonlyError && e.code === 'EREADONLY',
  );
});
await t('EACCES: 降级为 fallback 并触发 invalidate()', () => {
  let invalidated = 0;
  const perm = { detectSync: () => ({ level: LEVEL.FULL }), invalidate: () => { invalidated += 1; } };
  const io = { writeFileSync: () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; } };
  const r = safeWrite(path.join(tmp, 'denied.md'), 'x', { level: LEVEL.FULL, permission: perm, fs: io });
  assert.equal(r.status, WRITE_STATUS.FALLBACK);
  assert.equal(r.originalCode, 'EACCES');
  assert.equal(invalidated, 1, '权限变化必须触发一次重探');
});
await t('EPERM: 同样降级（归到 denied 一族）', () => {
  const perm = { detectSync: () => ({ level: LEVEL.FULL }), invalidate: () => {} };
  const io = { writeFileSync: () => { const e = new Error('nope'); e.code = 'EPERM'; throw e; } };
  const r = safeWrite(path.join(tmp, 'eperm.md'), 'x', { level: LEVEL.FULL, permission: perm, fs: io });
  assert.equal(r.status, WRITE_STATUS.FALLBACK);
});
await t('ENOSPC: 抛 disk-full，绝不降级', () => {
  const io = { writeFileSync: () => { const e = new Error('no space'); e.code = 'ENOSPC'; throw e; } };
  assert.throws(
    () => safeWrite(path.join(tmp, 'full.md'), 'x', { level: LEVEL.FULL, fs: io }),
    (e) => e instanceof WriteError && e.kind === 'disk-full',
  );
});
await t('EBUSY: 抛 busy，绝不降级', () => {
  const io = { writeFileSync: () => { const e = new Error('locked'); e.code = 'EBUSY'; throw e; } };
  assert.throws(
    () => safeWrite(path.join(tmp, 'busy.md'), 'x', { level: LEVEL.FULL, fs: io }),
    (e) => e instanceof WriteError && e.kind === 'busy',
  );
});
await t('读回不一致 → 回滚（删掉半成品）并抛 verify-failed', () => {
  const f = path.join(tmp, 'verify.md');
  const io = { readFileSync: () => Buffer.from('tampered') };
  assert.throws(
    () => safeWrite(f, 'x', { level: LEVEL.FULL, fs: io }),
    (e) => e instanceof WriteError && e.kind === 'verify-failed',
  );
  assert.equal(existsSync(f), false, '应该回滚成「文件不存在」');
});
await t('classifyWriteError: 策略映射', () => {
  assert.equal(classifyWriteError({ code: 'EACCES' }), 'degrade');
  assert.equal(classifyWriteError({ code: 'EPERM' }), 'degrade');
  assert.equal(classifyWriteError({ code: 'ENOSPC' }), 'disk-full');
  assert.equal(classifyWriteError({ code: 'EDQUOT' }), 'disk-full');
  assert.equal(classifyWriteError({ code: 'EBUSY' }), 'busy');
  assert.equal(classifyWriteError({ code: 'EIO' }), 'other');
});

try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }

// ── 8. index.js：插件接线 ────────────────────────────────────
const ws2 = mkdtempSync(path.join(os.tmpdir(), 'brain-ws-'));

function fakeCtx() {
  const registered = [];
  const logs = [];
  return {
    registered,
    logs,
    logger: () => ({
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    }),
    inject: (_deps, fn) => fn({
      tools: { register: (def) => registered.push(def) },
      effect: (f) => f(),
    }),
  };
}

await t('apply(fakeCtx) 不抛，且注册了工具', () => {
  const ctx = fakeCtx();
  const r = apply(ctx, { workspace: ws2, policy: 'force-l2', statePath: path.join(ws2, '.state.json'), warn: false });
  assert.equal(r.tool, TOOL_NAME);
  assert.equal(ctx.registered.length, 1);
  assert.equal(ctx.registered[0].name, TOOL_NAME);
});
await t('工具 Schema 必需字段正确', () => {
  const ctx = fakeCtx();
  apply(ctx, { workspace: ws2, policy: 'force-l2', statePath: path.join(ws2, '.state.json'), warn: false });
  const schema = ctx.registered[0].parameters;
  assert.deepEqual(schema.required, ['path', 'content']);
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.properties.path);
  assert.ok(schema.properties.content);
});
await t('工具描述里写了「fallback 不要重试」', () => {
  assert.match(TOOL_DESCRIPTION, /README/);
  assert.match(TOOL_DESCRIPTION, /METHODOLOGY/);
  assert.match(TOOL_DESCRIPTION, /block/);
  assert.match(TOOL_DESCRIPTION, /不要自己重试/);
});
await t('L2 下 execute 真写盘', () => {
  const ctx = fakeCtx();
  apply(ctx, { workspace: ws2, policy: 'force-l2', statePath: path.join(ws2, '.state.json'), warn: false });
  const out = ctx.registered[0].execute({ path: 'a.md', content: '# A\n' });
  assert.equal(out.status, 'written');
  assert.equal(readFileSync(path.join(ws2, 'a.md'), 'utf8'), '# A\n');
  assert.ok(out.backup === undefined || typeof out.backup === 'string');
});
await t('L1 下 execute 返回 fallback，且不落盘', () => {
  const ctx = fakeCtx();
  apply(ctx, { workspace: ws2, policy: 'force-l1', statePath: path.join(ws2, '.state.json'), warn: false });
  const out = ctx.registered[0].execute({ path: 'b.md', content: '# B\n' });
  assert.equal(out.status, 'fallback');
  assert.match(out.suggestion, /手动复制/);
  assert.match(out.block, /# B/);
  assert.equal(existsSync(path.join(ws2, 'b.md')), false);
});
await t('越界路径被拒（FORBIDDEN_PATH）', () => {
  const ctx = fakeCtx();
  apply(ctx, { workspace: ws2, policy: 'force-l2', statePath: path.join(ws2, '.state.json'), warn: false });
  const out = ctx.registered[0].execute({ path: 'C:\\Windows\\evil.md', content: 'x' });
  assert.equal(out.status, 'error');
  assert.equal(out.code, FORBIDDEN_CODE);
  assert.equal(out.rule, 'system-dir');
});
await t('参数缺失时返回 BAD_ARGS，不抛', () => {
  const ctx = fakeCtx();
  apply(ctx, { workspace: ws2, policy: 'force-l2', statePath: path.join(ws2, '.state.json'), warn: false });
  assert.equal(ctx.registered[0].execute({ path: '' }).code, 'BAD_ARGS');
  assert.equal(ctx.registered[0].execute({ path: 'x.md' }).code, 'BAD_ARGS');
});
await t('返回体没有任何 undefined 属性（BUG-004 教训）', () => {
  const ctx = fakeCtx();
  apply(ctx, { workspace: ws2, policy: 'force-l2', statePath: path.join(ws2, '.state.json'), warn: false });
  const out = ctx.registered[0].execute({ path: 'c.md', content: '# C\n' });
  for (const [k, v] of Object.entries(out)) assert.notStrictEqual(v, undefined, `字段 ${k} 是 undefined`);
  const rt = JSON.parse(JSON.stringify(out));
  assert.equal(Object.keys(rt).length, Object.keys(out).length);
});
await t('L2 首次写 state 并打印警告，第二次不再打印', () => {
  const ws3 = mkdtempSync(path.join(os.tmpdir(), 'brain-ws3-'));
  const statePath = path.join(ws3, '.dsh-brain-state.json');
  const c1 = fakeCtx();
  apply(c1, { workspace: ws3, policy: 'force-l2', statePath });
  assert.ok(existsSync(statePath), '应写下 state 文件');
  const st = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(st.lastWarnedVersion, VERSION);
  assert.ok(c1.logs.some(([lv, m]) => lv === 'warn' && m.includes('完全访问')));
  const c2 = fakeCtx();
  apply(c2, { workspace: ws3, policy: 'force-l2', statePath });
  assert.ok(!c2.logs.some(([lv, m]) => lv === 'warn' && m.includes('完全访问')), '第二次不该再警告');
  rmSync(ws3, { recursive: true, force: true });
});
await t('ctx 不合法时抛清晰错误', () => {
  assert.throws(() => apply({}, { workspace: ws2 }), /无法注册工具/);
});
await t('isInside: 工作区内 / 外部', () => {
  assert.equal(isInside(ws2, path.join(ws2, 'x', 'y.md')), true);
  assert.equal(isInside(ws2, 'C:\\Windows\\x.md'), false);
  assert.equal(isInside(ws2, path.join(ws2, '..', 'escape.md')), false);
});
await t('createTool 可独立构造（不经 apply）', () => {
  const t1 = createTool({ workspace: ws2 });
  assert.equal(t1.name, TOOL_NAME);
  assert.equal(typeof t1.execute, 'function');
});

try { rmSync(ws2, { recursive: true, force: true }); } catch { /* noop */ }

// ── 9. guard.js：唯一安检门 ──────────────────────────────────
const ws4 = mkdtempSync(path.join(os.tmpdir(), 'brain-guard-'));
mkdirSync(path.join(ws4, 'sub'), { recursive: true });
writeFileSync(path.join(ws4, 'README.md'), '# ok\n', 'utf8');

function denyOf(target, opts = {}) {
  const r = check(target, { workspace: ws4, ...opts });
  return r.ok ? null : r.rule;
}

await t('guard: 正常文件放行', () => {
  const r = check('README.md', { workspace: ws4 });
  assert.equal(r.ok, true);
  assert.equal(r.resolved.toLowerCase(), path.join(ws4, 'README.md').toLowerCase());
});
await t('guard: 子目录放行', () => {
  assert.equal(check('sub/a.md', { workspace: ws4 }).ok, true);
});
await t('guard: `..` 穿越被拒（相对）', () => {
  assert.equal(denyOf('../escape.md'), 'traversal');
  assert.equal(denyOf('sub/../../escape.md'), 'traversal');
});
await t('guard: `..` 穿越被拒（绝对）', () => {
  assert.equal(denyOf('C:\\a\\..\\b\\c.md'), 'traversal');
});
await t('guard: containsTraversal 只认整段', () => {
  assert.equal(containsTraversal('../x'), true);
  assert.equal(containsTraversal('a/b..c/d'), false);
  assert.equal(containsTraversal('..hidden/x'), false);
});
await t('guard: 注册表特征串被拒', () => {
  assert.equal(denyOf('HKLM\\Software\\Run\\evil'), 'registry');
  assert.equal(denyOf('HKCU:Software\\x'), 'registry');
  assert.equal(denyOf('hkey_local_machine\\x'), 'registry');
});
await t('guard: 系统目录被拒（L2 也拒）', () => {
  assert.equal(denyOf('C:\\Windows\\System32\\x.md'), 'system-dir');
  assert.equal(denyOf('C:\\Program Files\\x.md'), 'system-dir');
});
await t('guard: .env 家族被拒', () => {
  assert.equal(denyOf('.env'), 'sensitive');
  assert.equal(denyOf('sub/.env.local'), 'sensitive');
  assert.equal(denyOf(path.join(ws4, '.env.production')), 'sensitive');
});
await t('guard: .git 内胆被拒，但 .gitignore 放行', () => {
  assert.equal(denyOf('.git/config'), 'sensitive');
  assert.equal(denyOf('.git/hooks/pre-commit'), 'sensitive');
  assert.equal(denyOf('.gitignore'), null);
});
await t('guard: 密钥目录被拒', () => {
  assert.equal(denyOf('x/.ssh/id_rsa'), 'sensitive');
  assert.equal(denyOf('x/.aws/credentials'), 'sensitive');
});
await t('guard: 工作区外被拒（outside-workspace）', () => {
  const outside = path.join(os.homedir(), 'somewhere-else', 'x.md');
  assert.equal(denyOf(outside), 'outside-workspace');
});
await t('guard: allowOutside 可放行非敏感外部路径', () => {
  const outside = path.join(os.homedir(), 'brain-outside-test.md');
  assert.equal(check(outside, { workspace: ws4, allowOutside: true }).ok, true);
});
await t('guard: 符号链接指向系统目录 → 被拒', () => {
  const link = path.join(ws4, 'winlink');
  try {
    symlinkSync('C:\\Windows', link, 'junction');
  } catch (e) {
    throw new Error(`无法创建 junction（环境限制）：${e.code ?? e.message}`);
  }
  assert.equal(denyOf('winlink/evil.md'), 'system-dir');
  rmSync(link, { recursive: false, force: true });
});
await t('guard: 符号链接指回工作区内 → 放行', () => {
  const link = path.join(ws4, 'innerlink');
  symlinkSync(path.join(ws4, 'sub'), link, 'junction');
  assert.equal(check('innerlink/ok.md', { workspace: ws4 }).ok, true);
  rmSync(link, { recursive: false, force: true });
});
await t('guard: realpathLoose 对不存在的文件也能解析到真实父目录', () => {
  const target = path.join(ws4, 'sub', 'nope', 'deep.md');
  const real = realpathLoose(target);
  assert.ok(real.toLowerCase().startsWith(path.resolve(ws4).toLowerCase()));
});
await t('guard: systemRoots 至少含 Windows 与 Program Files', () => {
  const all = systemRoots().join('|');
  assert.match(all, /windows/);
  assert.match(all, /program files/);
});
await t('guard: 空路径被拒', () => assert.equal(denyOf('   '), 'empty'));

try { rmSync(ws4, { recursive: true, force: true }); } catch { /* noop */ }

// ── 10. ctx 形态兼容 ─────────────────────────────────────────
await t('兼容 A: inject(deps, cb)', () => {
  const regs = [];
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    inject: (_deps, fn) => fn({ tools: { register: (d) => regs.push(d) } }),
  };
  const r = apply(ctx, { workspace: ws2, policy: 'force-l2', warn: false });
  assert.equal(regs.length, 1);
  assert.match(r.registeredVia, /inject\(deps, cb\)/);
});
await t('兼容 B: inject(cb) 单参形态', () => {
  const regs = [];
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    // 只接受一个回调，且不认识 deps 参数
    inject: (fn) => { if (typeof fn !== 'function') throw new TypeError('expects a function'); fn({ tools: { register: (d) => regs.push(d) } }); },
  };
  const r = apply(ctx, { workspace: ws2, policy: 'force-l2', warn: false });
  assert.equal(regs.length, 1);
  assert.match(r.registeredVia, /inject\(cb\)/);
});
await t('兼容 C: 只有 ctx.tools.register', () => {
  const regs = [];
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    tools: { register: (d) => regs.push(d) },
  };
  const r = apply(ctx, { workspace: ws2, policy: 'force-l2', warn: false });
  assert.equal(regs.length, 1);
  assert.equal(r.registeredVia, 'ctx.tools.register');
});
await t('兼容 D: 全都不支持 → 抛错并说明试过什么', () => {
  assert.throws(
    () => apply({ logger: () => ({ info() {}, warn() {}, error() {} }) }, { workspace: ws2 }),
    /无法注册工具/,
  );
});
await t('空字符串配置项按「未配置」处理', () => {
  const regs = [];
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    inject: (_d, fn) => fn({ tools: { register: (d) => regs.push(d) } }),
  };
  const r = apply(ctx, { workspace: '', statePath: '', policy: 'force-l2', warn: false });
  assert.equal(r.workspace, path.resolve(process.cwd()));
  assert.match(r.statePath, /\.dsh-brain-state\.json$/);
});

await t('模块契约: 导出 name / inject / apply（cordis 装载要求）', () => {
  assert.equal(typeof pluginModule.name, 'string');
  assert.ok(pluginModule.name.length > 0);
  assert.ok(Array.isArray(pluginModule.inject), 'inject 必须是数组');
  assert.ok(pluginModule.inject.includes('tools'), '必须声明 tools 注入');
  assert.equal(typeof pluginModule.apply, 'function');
  assert.equal(pluginModule.name, 'dsh-brain-kit');
});

await t('effect 回调必须返回 undefined（cordis 否则抛 Invalid effect）', () => {
  const regs = [];
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    inject: (_d, fn) => fn({
      tools: { register: (d) => regs.push(d) },
      effect: (fn) => { const r = fn(); if (r !== undefined) throw new TypeError('Invalid effect'); return r; },
    }),
  };
  const r = apply(ctx, { workspace: ws2, policy: 'force-l2', warn: false });
  assert.equal(regs.length, 1);
  assert.match(r.registeredVia, /inject\(deps, cb\)/);
});
await t('Schema 合规: 不允许 type 数组（DSH 只收单类型字符串）', () => {
  const bad = [];
  const walk = (node, p) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.type)) bad.push(p + '.type = [' + node.type.join(',') + ']');
    for (const [k, v] of Object.entries(node)) walk(v, p + '.' + k);
  };
  walk(TOOL_PARAMETERS, 'parameters');
  walk(TOOL_OUTPUT, 'output');
  assert.deepEqual(bad, [], bad.join('; '));
});
// ── 输出 ──────────────────────────────────────────────────────
console.log('');
for (const line of results) console.log(line);
console.log(`\n[brain-kit.smoke] ${pass} passed, ${fail} failed\n`);

if (fail > 0) {
  process.exit(1);
}
console.log('SMOKE OK');
