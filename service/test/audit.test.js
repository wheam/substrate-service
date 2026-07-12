import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAudit } from '../src/audit.js';

test('审计兜底：任意层级里的凭据原文都不进日志文件', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'substrate-audit-redact-'));
  const file = path.join(dir, 'audit.jsonl');
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  createAudit({ file })({ tool: 'test', args: { query: `找 ${secret}`, nested: { value: secret } } });
  const raw = readFileSync(file, 'utf8');
  assert.ok(!raw.includes(secret));
  assert.match(raw, /REDACTED/);
});
