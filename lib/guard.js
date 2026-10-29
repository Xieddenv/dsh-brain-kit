/**
 * guard.js —— 路径安检门（唯一的出入口）
 *
 * 原则：**先在原始字符串上拦，再在解析后的真实路径上拦**。
 *   只做后者会漏掉符号链接；只做前者会漏掉 `a/../..` 这类绕法。
 *
 * 拒绝的东西（L2 也照拒，不看权限档位）：
 *   1. 注册表特征串            HKLM\ HKLM: HKEY_LOCAL_MACHINE ...
 *   2. 含 `..` 段的路径        任何向上穿越的尝试
 *   3. 系统目录                %SystemRoot% / Program Files / ProgramData ...
 *   4. 敏感文件                .env* / .ssh / .aws / .gnupg
 *   5. 版本控制内胆            .git/config、.git/hooks/**
 *   6. 工作区之外              （allowOutside 可放行，默认关）
 *
 * 符号链接：最终比对用 realpath（不存在则向上找最近的存在祖先再拼回剩余段），
 * 所以「工作区里放一个指向 C:\Windows 的 junction」也会被拦。
 */

import fs from 'node:fs';
import path from 'node:path';

export const FORBIDDEN_CODE = 'FORBIDDEN_PATH';

const REGISTRY_RE = /(hklm|hkcu|hkcr|hku|hkcc|hkey_local_machine|hkey_current_user|hkey_classes_root)\s*[\\/:]/i;

const SENSITIVE_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.azure']);
const SENSITIVE_FILE_PREFIXES = ['.env']; // .env / .env.local / .env.production …
const VCS_INNER = [
  ['.git', 'config'],
  ['.git', 'hooks'],
];

/** 系统目录清单：环境变量优先，字面量兜底 */
export function systemRoots() {
  const env = process.env;
  const raw = [
    env.SystemRoot || 'C:\\Windows',
    env.windir,
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.ProgramData,
    'C:\\Windows',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'C:\\ProgramData',
  ].filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    const n = norm(r);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function norm(p) {
  if (!p) return '';
  let s = path.resolve(String(p)).replace(/[\\/]+$/, '');
  if (s.length === 2 && s[1] === ':') s += '\\';
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

export function segments(p) {
  return String(p).split(/[\\/]+/).filter(Boolean);
}

/** 原始字符串里有没有 `..` 段（不做解析，解析会把 `..` 吃掉） */
export function containsTraversal(raw) {
  return segments(raw).some((s) => s === '..');
}

/**
 * 解析真实路径；目标不存在时向上找最近的存在祖先再拼回剩余段。
 * 这样「工作区/链接目录/还不存在的文件.md」也能得到正确的真实路径。
 */
export function realpathLoose(target) {
  const abs = path.resolve(String(target));
  const tail = [];
  let cur = abs;
  for (let i = 0; i < 64; i += 1) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
  return abs;
}

/** 工作区包含判断（大小写按平台归一） */
export function isInside(workspace, target) {
  const ws = norm(workspace);
  const t = norm(target);
  if (!ws || !t) return false;
  return t === ws || t.startsWith(ws.endsWith(path.sep) ? ws : ws + path.sep);
}

function hitSensitive(realTarget) {
  const segs = segments(realTarget).map((s) => (process.platform === 'win32' ? s.toLowerCase() : s));
  for (const s of segs) {
    if (SENSITIVE_DIRS.has(s)) return `目录 ${s}`;
    for (const p of SENSITIVE_FILE_PREFIXES) {
      if (s === p || s.startsWith(p + '.')) return `文件 ${s}`;
    }
  }
  for (const pair of VCS_INNER) {
    for (let i = 0; i + pair.length <= segs.length; i += 1) {
      let ok = true;
      for (let k = 0; k < pair.length; k += 1) {
        if (segs[i + k] !== pair[k]) { ok = false; break; }
      }
      if (ok) return `版本控制内胆 ${pair.join('/')}`;
    }
  }
  return null;
}

function hitSystemDir(realTarget) {
  const t = norm(realTarget);
  for (const root of systemRoots()) {
    if (t === root || t.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) {
      return `系统目录 ${root}`;
    }
  }
  return null;
}

/**
 * 安检。
 * @param {string} target  原始输入（相对或绝对）
 * @param {object} [opts]
 * @param {string} [opts.workspace]    工作区，默认 process.cwd()
 * @param {boolean} [opts.allowOutside] 允许写工作区外（默认 false）
 * @returns {{ok:true,resolved:string}|{ok:false,code:string,rule:string,reason:string,path:string}}
 */
export function check(target, opts = {}) {
  const raw = String(target ?? '').trim();
  const workspace = path.resolve(opts.workspace ?? process.cwd());

  if (!raw) {
    return deny(raw, 'empty', 'target 为空', workspace);
  }
  if (REGISTRY_RE.test(raw)) {
    return deny(raw, 'registry', '路径里带注册表特征串（HKLM/HKCU/…）', workspace);
  }
  if (containsTraversal(raw)) {
    return deny(raw, 'traversal', '路径含 `..` 段：禁止向上穿越', workspace);
  }

  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workspace, raw);
  const real = realpathLoose(abs);

  for (const candidate of [abs, real]) {
    const sys = hitSystemDir(candidate);
    if (sys) return deny(raw, 'system-dir', `落在${sys}`, workspace, candidate);
    const sen = hitSensitive(candidate);
    if (sen) return deny(raw, 'sensitive', `命中敏感路径（${sen}）`, workspace, candidate);
  }

  if (opts.allowOutside !== true && !isInside(workspace, real)) {
    return deny(raw, 'outside-workspace', `不在工作区内（工作区 ${workspace}）`, workspace, real);
  }

  return { ok: true, resolved: real };
}

function deny(raw, rule, reason, workspace, resolved) {
  return {
    ok: false,
    code: FORBIDDEN_CODE,
    rule,
    reason,
    path: resolved ?? raw,
    input: raw,
    workspace,
  };
}

/** 一行摘要，日志用 */
export function ruleSummary() {
  return [
    'registry', 'traversal', 'system-dir', 'sensitive', 'outside-workspace',
  ].join(' / ');
}
