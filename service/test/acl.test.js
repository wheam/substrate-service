import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseZones, canRead } from '../src/acl.js';

const instanceDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));

test('parseZones 解析 zones.md 顶部 YAML 块', () => {
  const zones = parseZones(instanceDir);
  assert.equal(zones.length, 4);
  const memory = zones.find((z) => z.id === 'memory');
  assert.equal(memory.path, 'memory/about-owner/');
  assert.equal(memory.privacy, 'sensitive');
  const todo = zones.find((z) => z.id === 'todo');
  assert.equal(todo.privacy, 'private');
});

test('canRead：sensitive 区只对高信任放行', () => {
  const zones = parseZones(instanceDir);
  assert.equal(canRead(zones, 'memory/about-owner/core-summary.md', 'high'), true);
  assert.equal(canRead(zones, 'memory/about-owner/core-summary.md', 'low'), false);
  assert.equal(canRead(zones, 'knowledge/coffee-brewing.md', 'low'), true);
});

test('canRead：zone 外的普通文件默认放行', () => {
  const zones = parseZones(instanceDir);
  assert.equal(canRead(zones, 'README.md', 'low'), true);
});
