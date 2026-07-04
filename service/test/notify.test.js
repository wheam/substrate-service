import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { feishuSign, createNotifier } from '../src/notify.js';

test('feishuSign：timestamp+\\n+secret 作 HMAC key、空消息、base64', () => {
  const sign = feishuSign('mysecret', '1599360473');
  const expect = crypto.createHmac('sha256', '1599360473\nmysecret').update('').digest('base64');
  assert.equal(sign, expect);
});

test('notify：POST 正确的 payload 到 webhook', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ code: 0, msg: 'success' }) };
  };
  const n = createNotifier({ webhookUrl: 'https://example.invalid/hook/x', secret: 's3cret', fetchImpl });
  const r = await n.notify('已存 → collections/restaurants');
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  const { body } = calls[0];
  assert.equal(body.msg_type, 'text');
  assert.equal(body.content.text, '已存 → collections/restaurants');
  assert.ok(/^\d+$/.test(body.timestamp), 'timestamp 秒级字符串');
  assert.equal(body.sign, feishuSign('s3cret', body.timestamp));
});

test('notify：webhook 未配置或请求失败时不抛、返回 ok=false', async () => {
  const none = createNotifier({ webhookUrl: '', secret: '' });
  assert.equal((await none.notify('x')).ok, false);
  const bad = createNotifier({
    webhookUrl: 'https://example.invalid/hook/x', secret: 's',
    fetchImpl: async () => { throw new Error('network down'); },
  });
  assert.equal((await bad.notify('x')).ok, false);
});
