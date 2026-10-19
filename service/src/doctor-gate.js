// doctor 写入门禁：只拦【本次写入新增】的错误，而不是看全库错误总数。
//
// 旧门禁是 `errors > 0 → 回滚`：库里任何一处既有断链/孤儿页都会挡住所有无关写入，keeper 再把这种
// 确定性失败当成可重试、每件重判六次后逐件告警（2026-10-18 事故的放大机制）。新门禁：
//   1. 事务开始、工作树干净时取一份 doctor 基线（按 HEAD 缓存）；
//   2. 写完再跑 doctor，按错误行做多重集差：基线里没有的错误行 = 本次新增，一律拦；
//      删页让别处反链断掉也会作为新增行出现，所以不需要、也不应该只看本次改动的文件；
//   3. 内容质量类（断链/孤儿/frontmatter/索引漂移/计数漂移）的既有错误不再挡无关写入；
//      其余类别（凭据、zones/registry/fleet 契约等安全与结构不变式）只要存在就继续全局拦截。
// doctor 不可用、输出无法逐行解析（错误行数与汇总数对不上）时退回旧口径：有 error 就拦，fail closed。
import { execFile } from 'node:child_process';
import path from 'node:path';

const TOLERATED_PREFIXES = ['断链', '孤儿', 'frontmatter 缺失', 'frontmatter 缺字段', '索引漂移', '计数漂移'];

function git(instanceDir, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: instanceDir, timeout: 30_000, encoding: 'utf8' },
      (err, stdout, stderr) => (err ? reject(new Error(`git ${args[0]} 失败：${stderr || err.message}`)) : resolve(stdout)));
  });
}

export function parseDoctorOutput(stdout) {
  const text = String(stdout ?? '');
  const totals = [...text.matchAll(/^\s*→ (\d+) error(?:\(s\)|s)?(?:\s*,.*)?\s*$/gm)];
  const errors = totals.length ? Number(totals.at(-1)[1]) : null;
  const lines = [...text.matchAll(/^\s*\[ERROR\]\s+(.+?)\s*$/gm)].map((m) => m[1]);
  return { errors, lines, complete: errors !== null && lines.length === errors };
}

// 与 executor.runDoctor 同一调用约定；null = doctor 不可用或输出不可信。
export function runDoctorReport(instanceDir) {
  return new Promise((resolve) => {
    execFile('python3', [path.join(instanceDir, 'skills', 'substrate-doctor', 'doctor.py'), '.'],
      { cwd: instanceDir, timeout: 120_000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        const report = parseDoctorOutput(stdout);
        // doctor 发现错误时以非零码退出，汇总里的正数仍可信；基础设施失败却声称 0 或没有汇总一律不采信。
        resolve(err && (!report.errors || report.errors === 0) ? null : report);
      });
  });
}

export function isToleratedDoctorError(line) {
  return TOLERATED_PREFIXES.some((prefix) => line.startsWith(prefix));
}

// 计数漂移行带着会随写入变化的数字；按去数字后的形状比对，避免既有漂移在每次 upsert 后被当成新增。
function fingerprint(line) {
  return line.startsWith('计数漂移') ? line.replace(/\d+/g, '#') : line;
}

export function compareDoctorReports(base, after) {
  if (!after) return { ok: false, unavailable: true, newErrors: [], blockingExisting: [] };
  if (after.errors === 0) return { ok: true, newErrors: [], blockingExisting: [] };
  if (!after.complete || !base?.complete) {
    // 没法逐行比对：保持旧的 fail-closed 口径。
    const lines = after.lines.length ? after.lines : [`doctor 报 ${after.errors} error（输出无法逐行解析）`];
    return { ok: false, legacy: true, newErrors: lines, blockingExisting: [] };
  }
  const remaining = new Map();
  for (const line of base.lines) remaining.set(fingerprint(line), (remaining.get(fingerprint(line)) ?? 0) + 1);
  const newErrors = [];
  const blockingExisting = [];
  for (const line of after.lines) {
    const fp = fingerprint(line);
    const left = remaining.get(fp) ?? 0;
    if (left > 0) {
      remaining.set(fp, left - 1);
      if (!isToleratedDoctorError(line)) blockingExisting.push(line);
    } else {
      newErrors.push(line);
    }
  }
  return { ok: newErrors.length === 0 && blockingExisting.length === 0, newErrors, blockingExisting };
}

// 人和日志都要能看懂的单行说明；具体错误行另由调用方按需展示。
export function describeDoctorFailure(result) {
  if (result.unavailable) return 'doctor 未返回可解析结果';
  const parts = [];
  if (result.newErrors?.length) {
    parts.push(`本次写入会新增 ${result.newErrors.length} 处 doctor 错误：${result.newErrors.slice(0, 3).join('；')}`);
  }
  if (result.blockingExisting?.length) {
    parts.push(`知识库已有 ${result.blockingExisting.length} 处须人工处理的 doctor 错误：${result.blockingExisting.slice(0, 3).join('；')}`);
  }
  return parts.join('；') || 'doctor 校验未通过';
}

// 断链行 → { source, target }；不是断链行返回 null。
export function parseBrokenLink(line) {
  const m = String(line).match(/^断链\s+(.+?) -> \[\[(.+)\]\]$/);
  return m ? { source: m[1], target: m[2] } : null;
}

export function createDoctorGate({ instanceDir, enabled = true, run = runDoctorReport } = {}) {
  let cached = null; // { head, report }

  // 必须在工作树（除 inbox/ 外）干净时调用。inbox 不在知识图里，只可能贡献凭据类错误，
  // 而凭据类本就不按基线放行，所以 HEAD 足以作为缓存键。
  async function baseline() {
    if (!enabled) return null;
    const head = (await git(instanceDir, ['rev-parse', 'HEAD'])).trim();
    if (cached?.head === head) return cached.report;
    const report = await run(instanceDir);
    cached = report ? { head, report } : null;
    return report;
  }

  async function check(base) {
    if (!enabled) return { ok: true, skipped: true, newErrors: [], blockingExisting: [] };
    return compareDoctorReports(base, await run(instanceDir));
  }

  return { enabled, baseline, check };
}
