/**
 * writer.js —— 分级写入（L2 真写 / L1 给建议 / L0 拒绝）
 *
 * 契约（见 METHODOLOGY M-018 第 5 条）：
 *   降级绝不能静默，L1 必须把「建议」作为**返回值**交回调用方，
 *   由模型决定怎么呈现；只打日志等于没降级。
 *
 *   safeWrite(file, content, opts)
 *     → { status: 'written',  ... }              L2 成功
 *     → { status: 'fallback', ... }              L1，或 L2 写入时权限掉了
 *     → throw ReadonlyError                       L0
 *     → throw WriteError(kind: disk-full|busy|verify-failed|other)
 *
 *   EACCES / EPERM → 立即 permission.invalidate() 并降级（权限可能在运行中变化）
 *   ENOSPC / EBUSY → 抛明确错误，**不降级**（降级会掩盖真实故障）
 */

import fs from 'node:fs';
import path from 'node:path';
import * as defaultPermission from './permission.js';
import { LEVEL, LEVEL_NAME } from './permission.js';

export const WRITE_STATUS = Object.freeze({ WRITTEN: 'written', FALLBACK: 'fallback' });

const DENIED = new Set(['EACCES', 'EPERM']);

/** 备份文件名用的时间戳：YYYYMMDD-HHMMSS */
export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 同一秒内多次备份时避免覆盖：f.bak-20261030-010203（第 2 次起加 -2、-3…） */
function pickBackupPath(io, target) {
  const base = `${target}.bak-${stamp()}`;
  if (!io.existsSync(base)) return base;
  for (let n = 2; n <= 50; n += 1) {
    const cand = `${base}-${n}`;
    if (!io.existsSync(cand)) return cand;
  }
  return `${base}-${Date.now()}`;
}
const FATAL = new Set(['ENOSPC', 'EDQUOT', 'EBUSY']);

export class ReadonlyError extends Error {
  constructor(file, detail = '') {
    super(`只读模式（L0），拒绝写入：${file}${detail ? `（${detail}）` : ''}`);
    this.name = 'ReadonlyError';
    this.code = 'EREADONLY';
    this.path = file;
  }
}

export class WriteError extends Error {
  constructor(kind, file, cause) {
    const code = cause?.code ?? '';
    super(`写入失败[${kind}]：${file}${code ? ` → ${code}` : ''}${cause?.message ? ` ${cause.message}` : ''}`);
    this.name = 'WriteError';
    this.kind = kind;
    this.code = code;
    this.path = file;
    this.cause = cause;
  }
}

/** errno → 处理策略 */
export function classifyWriteError(err) {
  const code = err?.code ?? '';
  if (DENIED.has(code)) return 'degrade';
  if (code === 'ENOSPC' || code === 'EDQUOT') return 'disk-full';
  if (code === 'EBUSY') return 'busy';
  return 'other';
}

/** 把内容包成一段可直接贴在对话框里的建议（L1 / 降级时用） */
export function suggestionBlock(file, content, note = '') {
  const fence = content.includes('```') ? '~~~~' : '```';
  return [
    `目标文件：${file}`,
    note,
    '',
    `${fence}markdown`,
    content.replace(/\s+$/, ''),
    fence,
    '',
    '请把上面的完整内容复制到该文件里（覆盖原内容）。',
  ].filter(Boolean).join('\n');
}

function fallback(file, level, reason, content, extra = {}) {
  return {
    status: WRITE_STATUS.FALLBACK,
    level,
    levelName: LEVEL_NAME[level],
    path: file,
    reason,
    suggestion: '请输出内容让用户手动复制',
    block: suggestionBlock(file, content, extra.note),
    content,
    ...extra,
  };
}

/**
 * @param {string} file   目标文件绝对路径
 * @param {string} content 要写入的完整内容
 * @param {object} [opts]
 * @param {number} [opts.level]            指定档位（测试用）；缺省则探测
 * @param {object} [opts.permission]       权限模块（测试注入）
 * @param {object} [opts.fs]               fs 实现（测试注入，缺省 node:fs）
 * @param {string} [opts.workspace]        探测用工作区
 * @param {boolean} [opts.backup=true]     是否留 .bak
 * @returns {{status:string,[k:string]:any}}
 */
export function safeWrite(file, content, opts = {}) {
  const io = { ...fs, ...(opts.fs ?? {}) };
  const perm = opts.permission ?? defaultPermission;
  const target = path.resolve(file);

  const level = opts.level ?? perm.detectSync({ workspace: opts.workspace, policy: opts.policy }).level;

  if (level === LEVEL.READONLY) {
    throw new ReadonlyError(target);
  }
  if (level === LEVEL.WORKSPACE) {
    return fallback(target, level, '权限不足（L1 受限模式）', String(content));
  }

  // ── L2：真写 ──
  const useBackup = opts.backup !== false;
  let backup = null;

  try {
    io.mkdirSync(path.dirname(target), { recursive: true });

    const hadOriginal = io.existsSync(target);
    if (hadOriginal && useBackup) {
      backup = pickBackupPath(io, target);
      io.copyFileSync(target, backup);
    }

    io.writeFileSync(target, content, 'utf8');

    // 读回逐字节校验：防「写成功但其实没落盘」
    const written = io.readFileSync(target);
    const expected = Buffer.from(String(content), 'utf8');
    if (!Buffer.from(written).equals(expected)) {
      // 回滚
      try {
        if (hadOriginal && useBackup) io.copyFileSync(backup, target);
        else io.unlinkSync(target);
      } catch { /* 回滚失败也没别的办法，错误信息里带上 */ }
      throw new WriteError('verify-failed', target, new Error('读回内容与写入内容不一致，已回滚'));
    }

    return {
      status: WRITE_STATUS.WRITTEN,
      level,
      levelName: LEVEL_NAME[level],
      path: target,
      bytes: expected.length,
      backup: backup ?? null,
    };
  } catch (err) {
    if (err instanceof WriteError) throw err;

    const kind = classifyWriteError(err);
    if (kind === 'degrade') {
      // 权限在运行中变了：清缓存，下一次探测会拿到新档位
      try { perm.invalidate(); } catch { /* 注入的假模块可能没有这个方法 */ }
      return fallback(target, LEVEL.WORKSPACE, `写入时被拒（${err.code ?? 'EACCES'}），已降级`, String(content), {
        note: '权限可能在运行中变化，已重新探测。',
        originalCode: err.code ?? null,
      });
    }
    if (kind === 'disk-full') throw new WriteError('disk-full', target, err);
    if (kind === 'busy') throw new WriteError('busy', target, err);
    throw new WriteError('other', target, err);
  }
}

/** 异步版（语义同 safeWrite） */
export async function safeWriteAsync(file, content, opts = {}) { return safeWrite(file, content, opts); }
