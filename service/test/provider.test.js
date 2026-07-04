import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeepSeekProvider } from '../src/provider.js';

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, opts) => {
    const req = { url, body: JSON.parse(opts.body), headers: opts.headers };
    calls.push(req);
    return handler(req);
  };
  impl.calls = calls;
  return impl;
}

const okResponse = (json) => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: JSON.stringify(json) } }], usage: { total_tokens: 42 } }),
});

test('judge：默认模型、JSON 模式、温度 0，返回解析后的决定', async () => {
  const fetchImpl = fakeFetch(() => okResponse({ zone: 'todo', action: 'todo_add', confidence: 0.9 }));
  const p = createDeepSeekProvider({ apiKey: 'k', fetchImpl });
  const r = await p.judge({ system: 'sys', user: 'usr' });
  assert.equal(r.json.zone, 'todo');
  assert.equal(r.model, 'deepseek-v4-flash');
  const req = fetchImpl.calls[0];
  assert.match(req.url, /api\.deepseek\.com\/chat\/completions/);
  assert.equal(req.headers.authorization, 'Bearer k');
  assert.equal(req.body.model, 'deepseek-v4-flash');
  assert.equal(req.body.temperature, 0);
  assert.deepEqual(req.body.response_format, { type: 'json_object' });
  assert.equal(req.body.messages[0].role, 'system');
});

test('judge：escalate=true 用升级模型', async () => {
  const fetchImpl = fakeFetch(() => okResponse({ confidence: 0.95 }));
  const p = createDeepSeekProvider({ apiKey: 'k', fetchImpl });
  const r = await p.judge({ system: 's', user: 'u', escalate: true });
  assert.equal(r.model, 'deepseek-v4-pro');
  assert.equal(fetchImpl.calls[0].body.model, 'deepseek-v4-pro');
});

test('judge：HTTP 错误与坏 JSON 都抛可读错误', async () => {
  const p1 = createDeepSeekProvider({ apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 402, text: async () => 'Insufficient Balance' }) });
  await assert.rejects(() => p1.judge({ system: 's', user: 'u' }), /402|Insufficient/);
  const p2 = createDeepSeekProvider({ apiKey: 'k', fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'not json' } }] }) }) });
  await assert.rejects(() => p2.judge({ system: 's', user: 'u' }), /JSON/i);
});
