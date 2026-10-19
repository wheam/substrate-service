// 入口凭据规则 ⊇ 实例 doctor 的 ERROR 档：入口放过、doctor 却判 ERROR 的形态会先 commit 进 inbox，
// 再让之后每一次写入都被 doctor 挡住（2026-10-18 审查复现）。本测试用 vendored 真实 doctor 逐项核对。
// 样例全是无效的合成串，运行时拼接，避免仓库里出现真实凭据形态的字面量。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { containsCredential } from '../src/secrets.js';

const REAL_DOCTOR = fileURLToPath(new URL('./fixture/real-doctor/doctor.py', import.meta.url));
const A = (n) => 'A'.repeat(n);

// doctor 标签 → 合成样例（每个标签至少一个）
const SAMPLES = {
  'PEM 私钥': ['-----' + 'BEGIN RSA PRIVATE KEY' + '-----'],
  'AWS access key id': ['AKI' + 'A' + 'ABCDEFGHIJKLMNOP'],
  'Slack token': ['xox' + 'b-1234567890-abcdef'],
  'GitHub token': ['gh' + 's_' + A(24), 'gh' + 'u_' + A(24), 'gh' + 'r_' + A(24), 'gh' + 'o_' + A(24), 'gh' + 'p_' + A(24)],
  'GitHub fine-grained PAT': ['github' + '_pat_' + A(24)],
  'Google API key': ['AI' + 'za' + A(35)],
  'Stripe live key': ['sk' + '_live_' + A(24)],
  'OpenAI/Anthropic token': ['sk' + '-proj-' + A(36), 'sk' + '-svcacct-' + A(36), 'sk' + '-ant-' + A(30)],
  JWT: ['ey' + 'JhbGciOiJIUzI1NiJ9.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.' + 'abcdefghijklmnop'],
};

function doctorLabels() {
  const src = readFileSync(REAL_DOCTOR, 'utf8');
  const block = src.match(/SECRET_PATTERNS_ERROR = \[([\s\S]*?)\n\]/)[1];
  return [...block.matchAll(/,\s*"([^"]+)"\),/g)].map((m) => m[1]);
}

function realDoctorFlags(text) {
  const dir = mkdtempSync(path.join(tmpdir(), 'secrets-contract-'));
  try {
    mkdirSync(path.join(dir, 'knowledge'));
    writeFileSync(path.join(dir, 'knowledge', 'page.md'), `---\ntitle: t\ncreated: 2026-10-18\nupdated: 2026-10-18\ntype: knowledge\n---\n\n${text}\n`);
    let out;
    try { out = execFileSync('python3', [REAL_DOCTOR, dir], { encoding: 'utf8' }); }
    catch (e) { out = String(e.stdout); }
    return /\[ERROR\] 疑似密钥\/凭据/.test(out);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('合成样例覆盖真实 doctor 的全部 ERROR 档凭据标签（doctor 新增形态时这里先红）', () => {
  assert.deepEqual([...doctorLabels()].sort(), Object.keys(SAMPLES).sort());
});

for (const [label, samples] of Object.entries(SAMPLES)) {
  test(`入口拒收 doctor 会判 ERROR 的形态：${label}`, () => {
    for (const sample of samples) {
      const text = `调试日志：${sample} 结束`;
      assert.equal(realDoctorFlags(text), true, `真实 doctor 应识别 ${label}`);
      assert.equal(containsCredential(text), true, `入口必须先于 doctor 拒收 ${label}`);
    }
  });
}

test('普通散文不被扩充后的规则误伤', () => {
  for (const text of [
    'task-runner 和 risk-assessment 都要跑 sk-learn 的流程',
    '我在研究 JWT（JSON Web Token）的格式，eyJ 开头是 base64 的 {"',
    'GitHub 的 token 前缀有 ghp_ 和 ghs_ 两种',
    'Stripe 的 live key 以 sk_live_ 开头，测试 key 以 sk_test_ 开头',
  ]) {
    assert.equal(containsCredential(text), false, text);
  }
});
