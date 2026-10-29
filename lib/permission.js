/**
 * permission.js —— 运行期能力探测
 *
 * 设计原则（见 METHODOLOGY M-018）：
 *   1. 探测「能力」，不读「配置」。配置可能为空/被覆盖/改名，只能当提示。
 *   2. 探针必须真写一次：唯一文件名 + wx（不覆盖）+ finally 清理。
 *   3. 至少要两个探针：目标目录 + 越界目录，否则「只能写工作区」会被误判成「全盘可写」。
 *   4. 越界探针不能用 %TEMP% —— 沙箱普遍放行 temp，会造成假全权。
 *
 * 不依赖任何 dsh.* 内部 API，只用 node:fs / os / path（DSH 0.2.x 全有）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 档位：0 只读 / 1 只能写工作区 / 2 全盘 */
export const LEVEL = Object.freeze({ READONLY: 0, WORKSPACE: 1, FULL: 2 });

export const LEVEL_NAME = Object.freeze({ 0: 'L0', 1: 'L1', 2: 'L2' });

export const LEVEL_DESC = Object.freeze({
  0: '只读：不能写任何目录，只能输出建议',
  1: '受限：只能写工作区，越界写入会降级为建议',
  2: '全权：全盘可写（仍需自我设限，禁访系统目录）',
});

const DENIED_CODES = new Set(['EACCES', 'EPERM']);
const VOLUME_CODES = new Set(['EROFS', 'ENOSPC', 'EDQUOT']);

/** 把 errno 翻成稳定的分类，别让调用方去读 err.code */
export function classify(err) {
  const code = err?.code ?? '';
  if (DENIED_CODES.has(code)) return 'denied';
  if (code === 'ENOENT') return 'missing';
  if (VOLUME_CODES.has(code)) return 'readonly';
  return code ? `unknown:${code}` : 'unknown';
}

let seq = 0;
function probePath(dir) {
  seq += 1;
  return path.join(dir, `.brain-probe-${process.pid}-${Date.now().toString(36)}-${seq}.tmp`);
}

/** 同步探针：返回 'ok' | 'denied' | 'missing' | 'readonly' | 'unknown:XXX' */
export function probeDirSync(dir) {
  if (!dir) return 'missing';
  const target = probePath(path.resolve(dir));
  try {
    fs.writeFileSync(target, 'x', { flag: 'wx' });
    return 'ok';
  } catch (err) {
    return classify(err);
  } finally {
    try { fs.unlinkSync(target); } catch { /* 没写成功就没有文件，忽略 */ }
  }
}

/** 异步探针（语义同 probeDirSync） */
export async function probeDir(dir) {
  if (!dir) return 'missing';
  const target = probePath(path.resolve(dir));
  try {
    await fs.promises.writeFile(target, 'x', { flag: 'wx' });
    return 'ok';
  } catch (err) {
    return classify(err);
  } finally {
    try { await fs.promises.unlink(target); } catch { /* 同上 */ }
  }
}

const POLICY_ALIASES = new Map([
  ['auto', null],
  ['', null],
  ['l0', LEVEL.READONLY],
  ['readonly', LEVEL.READONLY],
  ['force-l0', LEVEL.READONLY],
  ['l1', LEVEL.WORKSPACE],
  ['workspace', LEVEL.WORKSPACE],
  ['force-l1', LEVEL.WORKSPACE],
  ['l2', LEVEL.FULL],
  ['full', LEVEL.FULL],
  ['force-l2', LEVEL.FULL],
]);

/** 配置里的 permissionPolicy → 强制的档位；auto/未知 → null（走探测） */
export function parsePolicy(policy) {
  if (policy === null || policy === undefined) return null;
  const key = String(policy).trim().toLowerCase();
  return POLICY_ALIASES.has(key) ? POLICY_ALIASES.get(key) : null;
}

/** 由两个探针结果推断档位 */
export function levelFrom(workspaceProbe, outsideProbe) {
  if (workspaceProbe !== 'ok') return LEVEL.READONLY;
  return outsideProbe === 'ok' ? LEVEL.FULL : LEVEL.WORKSPACE;
}

const DEFAULT_TTL_MS = 60_000;
let cached = null;
let cachedAt = 0;

export function invalidate() {
  cached = null;
  cachedAt = 0;
}

/** 取上次探测结果（没有就返回 null），供热路径避免重复探测 */
export function current() {
  if (!cached) return null;
  if (Date.now() - cachedAt > DEFAULT_TTL_MS) return null;
  return cached;
}

/**
 * 探测当前环境。
 * @param {object} opts
 * @param {string} [opts.workspace]     工作区绝对路径，默认 process.cwd()
 * @param {string} [opts.outsideProbe]  越界探针目录，默认用户主目录
 * @param {string} [opts.policy]        auto / force-l0 / force-l1 / force-l2
 * @param {number} [opts.ttlMs]         缓存时间，默认 60s；传 0 强制重探
 * @returns {{level:number,name:string,desc:string,workspace:string,probes:object,source:string,policy:any,hint:string|null,took:number,at:number}}
 */
export function detectSync(opts = {}) {
  const t0 = Date.now();
  const policyLevel = parsePolicy(opts.policy);
  const hint = process.env.DSH_PERMISSION_MODE ?? null;
  const workspace = path.resolve(opts.workspace ?? process.cwd());
  const outsideProbe = path.resolve(opts.outsideProbe ?? os.homedir());
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;

  if (policyLevel !== null) {
    const result = {
      level: policyLevel,
      name: LEVEL_NAME[policyLevel],
      desc: LEVEL_DESC[policyLevel],
      workspace,
      probes: { workspace: 'skipped', outside: 'skipped' },
      source: 'policy',
      policy: opts.policy,
      hint,
      took: Date.now() - t0,
      at: Date.now(),
    };
    if (ttl > 0) { cached = result; cachedAt = Date.now(); }
    return result;
  }

  if (ttl > 0 && cached && Date.now() - cachedAt <= ttl) return cached;

  const wsProbe = probeDirSync(workspace);
  const outProbe = probeDirSync(outsideProbe);
  const level = levelFrom(wsProbe, outProbe);

  const result = {
    level,
    name: LEVEL_NAME[level],
    desc: LEVEL_DESC[level],
    workspace,
    probes: { workspace: wsProbe, outside: outProbe },
    source: 'probe',
    policy: opts.policy ?? 'auto',
    hint,
    took: Date.now() - t0,
    at: Date.now(),
  };
  if (ttl > 0) { cached = result; cachedAt = Date.now(); }
  return result;
}

/** 异步版（语义同 detectSync；两探针并行） */
export async function detect(opts = {}) {
  const t0 = Date.now();
  const policyLevel = parsePolicy(opts.policy);
  const hint = process.env.DSH_PERMISSION_MODE ?? null;
  const workspace = path.resolve(opts.workspace ?? process.cwd());
  const outsideProbe = path.resolve(opts.outsideProbe ?? os.homedir());
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;

  if (policyLevel !== null) return detectSync({ ...opts, policy: opts.policy });

  if (ttl > 0 && cached && Date.now() - cachedAt <= ttl) return cached;

  const [wsProbe, outProbe] = await Promise.all([probeDir(workspace), probeDir(outsideProbe)]);
  const level = levelFrom(wsProbe, outProbe);

  const result = {
    level,
    name: LEVEL_NAME[level],
    desc: LEVEL_DESC[level],
    workspace,
    probes: { workspace: wsProbe, outside: outProbe },
    source: 'probe',
    policy: opts.policy ?? 'auto',
    hint,
    took: Date.now() - t0,
    at: Date.now(),
  };
  if (ttl > 0) { cached = result; cachedAt = Date.now(); }
  return result;
}

/** 一行日志用：permission=L1 (workspace-only) workspace=E:\x probes={...} */
export function summary(result) {
  if (!result) return 'permission=unknown';
  return `permission=${result.name} (${result.desc.split('：')[0]}) workspace=${result.workspace} probes=${JSON.stringify(result.probes)} source=${result.source}`;
}
